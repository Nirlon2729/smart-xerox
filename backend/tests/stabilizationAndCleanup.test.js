/**
 * SMART XEROX — STABILIZATION, SECURITY & 48-HOUR AUTOMATIC CLEANUP TEST SUITE
 * Runs exclusively against an isolated test MongoDB (mongodb-memory-server or local TEST_MONGODB_URI).
 * Never touches production MongoDB Atlas.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");
const http = require("http");
const mongoose = require("mongoose");
const {
  assertSafeTestUri,
  startIsolatedTestDatabase,
  stopIsolatedTestDatabase
} = require("./testDbGuard");
const connectDB = require("../src/config/db");
const app = require("../src/app");
const Tenant = require("../src/models/Tenant");
const Admin = require("../src/models/Admin");
const Order = require("../src/models/Order");
const AuditLog = require("../src/models/AuditLog");
const { bootstrapOwner } = require("../src/controllers/adminController");
const { inspectPdfBuffer } = require("../src/utils/fileValidator");
const { uploadBufferToGridFS, findGridFSFileById } = require("../src/services/gridfsService");
const {
  RETENTION_MS,
  EXPIRED_DOCUMENT_MESSAGE,
  runDocumentCleanupSweep
} = require("../src/services/fileCleanupService");

const SAMPLE_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n" +
    "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n" +
    "%%EOF\n",
  "utf-8"
);

async function apiRequest(baseUrl, method, route, { headers = {}, body = null } = {}) {
  const reqHeaders = { ...headers };
  let payload = body;
  if (body && !Buffer.isBuffer(body) && typeof body === "object" && !(body instanceof FormData)) {
    reqHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: reqHeaders,
    body: payload
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

function buildPdfForm(filename, buf, fields = {}) {
  const form = new FormData();
  form.append("document", new Blob([buf], { type: "application/pdf" }), filename);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  return form;
}

async function ageDocumentInDb(orderId, gridFsFileId, uploadedAtDate) {
  await Order.updateOne(
    { _id: orderId },
    { $set: { documentUploadedAt: uploadedAtDate, createdAt: uploadedAtDate } }
  );
  if (gridFsFileId) {
    await mongoose.connection.db.collection("printDocuments.files").updateOne(
      { _id: new mongoose.Types.ObjectId(gridFsFileId) },
      {
        $set: {
          uploadDate: uploadedAtDate,
          "metadata.uploadedAt": uploadedAtDate
        }
      }
    );
  }
}

async function countGridFsChunks(fileId) {
  return mongoose.connection.db
    .collection("printDocuments.chunks")
    .countDocuments({ files_id: new mongoose.Types.ObjectId(fileId) });
}

async function runTests() {
  console.log("====================================================================");
  console.log("SMART XEROX — STABILIZATION, SECURITY & 48H CLEANUP TEST SUITE");
  console.log("====================================================================");

  // 0. Verify Test DB Safety Guard refuses production URIs
  console.log("\n[1/8] Verifying test database safety guard refuses production URIs...");
  assert.throws(
    () => assertSafeTestUri("mongodb+srv://user:pass@cluster0.abcd.mongodb.net/smartxerox"),
    /TEST SAFETY BLOCK/
  );
  assert.throws(
    () => assertSafeTestUri("mongodb://prod-db.internal:27017/smartxerox"),
    /TEST SAFETY BLOCK/
  );
  assert.throws(
    () => assertSafeTestUri("mongodb://127.0.0.1:27017/production"),
    /TEST SAFETY BLOCK/
  );
  console.log("  PASS: Production & non-test MongoDB URIs are strictly refused.");

  const dbHandle = await startIsolatedTestDatabase();
  await connectDB();
  await bootstrapOwner();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Login Super Admin
    const superLogin = await apiRequest(baseUrl, "POST", "/super-admin/login", {
      body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    });
    assert.strictEqual(superLogin.status, 200);
    const superToken = superLogin.data.token;
    const defaultTenantId = superLogin.data.tenant?.id;

    // Create two isolated vendors A and B
    const vARes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: "Cleanup Alpha Xerox",
        shopSlug: "cleanup-alpha",
        ownerName: "Alpha Owner",
        email: "alpha@cleanup.test",
        password: "AlphaPassword123!"
      }
    });
    assert.strictEqual(vARes.status, 201);
    const vendorA = vARes.data.vendor;

    const vBRes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: "Cleanup Beta Xerox",
        shopSlug: "cleanup-beta",
        ownerName: "Beta Owner",
        email: "beta@cleanup.test",
        password: "BetaPassword123!"
      }
    });
    assert.strictEqual(vBRes.status, 201);
    const vendorB = vBRes.data.vendor;

    const loginA = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: "alpha@cleanup.test", password: "AlphaPassword123!" }
    });
    assert.strictEqual(loginA.status, 200);
    let tokenA = loginA.data.token;

    const loginB = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: "beta@cleanup.test", password: "BetaPassword123!" }
    });
    assert.strictEqual(loginB.status, 200);
    const tokenB = loginB.data.token;

    // Pair two agents for Vendor A (Agent A1 and Agent A2) and one for Vendor B
    const pairA1 = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { deviceId: "win-alpha-pc-1", hostname: "ALPHA-SECRET-HOST" }
    });
    assert.strictEqual(pairA1.status, 201);
    const credsA1 = pairA1.data.credentials;

    const pairA2 = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { deviceId: "win-alpha-pc-2", hostname: "ALPHA-PC-2" }
    });
    assert.strictEqual(pairA2.status, 201);
    const credsA2 = pairA2.data.credentials;

    const pairB = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { deviceId: "win-beta-pc-1", hostname: "BETA-HOST" }
    });
    assert.strictEqual(pairB.status, 201);
    const credsB = pairB.data.credentials;

    // Send heartbeats so both shops are AVAILABLE
    const hbA = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: { "x-agent-id": credsA1.agentId, "x-agent-secret": credsA1.agentSecret },
      body: {
        deviceId: credsA1.deviceId,
        hostname: "ALPHA-SECRET-HOST",
        printerName: "HP LaserJet Alpha",
        portName: "USB009",
        driverName: "HP Universal PCL6",
        printerAvailable: true,
        status: "READY",
        capabilities: { supportedPaperSizes: ["A4"], supportsColor: false, supportsDuplex: true },
        availablePrinters: [
          {
            name: "HP LaserJet Alpha",
            portName: "USB009",
            driverName: "HP Universal PCL6",
            printerAvailable: true,
            status: "READY",
            capabilities: { supportedPaperSizes: ["A4"], supportsColor: false, supportsDuplex: true }
          }
        ]
      }
    });
    assert.strictEqual(hbA.status, 200);
    assert.ok(hbA.headers.get("ratelimit-limit"), "/api/agent/* must include rate-limit headers");

    const hbB = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: { "x-agent-id": credsB.agentId, "x-agent-secret": credsB.agentSecret },
      body: {
        deviceId: credsB.deviceId,
        printerName: "Canon Beta",
        printerAvailable: true,
        status: "READY",
        capabilities: { supportedPaperSizes: ["A4"], supportsColor: true, supportsDuplex: true }
      }
    });
    assert.strictEqual(hbB.status, 200);

    // 2. Public Order Tracking Sanitization
    console.log("\n[2/8] Testing public order tracking response sanitization...");
    const orderCreateRes = await apiRequest(baseUrl, "POST", `/shops/${vendorA.shopSlug}/orders`, {
      body: buildPdfForm("public-check.pdf", SAMPLE_PDF, { copies: 1, colorMode: "bw", sides: "single", paperSize: "A4" })
    });
    assert.strictEqual(orderCreateRes.status, 201);
    const trackedOrder = orderCreateRes.data.order;

    const publicTrack = await apiRequest(
      baseUrl,
      "GET",
      `/shops/${vendorA.shopSlug}/orders/${trackedOrder.token}`
    );
    assert.strictEqual(publicTrack.status, 200);
    const serializedTrack = JSON.stringify(publicTrack.data);
    assert.strictEqual(publicTrack.data.printer.agentId, undefined, "agentId must not leak on order tracking");
    assert.strictEqual(publicTrack.data.printer.deviceId, undefined, "deviceId must not leak on order tracking");
    assert.strictEqual(publicTrack.data.printer.hostname, undefined, "hostname must not leak on order tracking");
    assert.strictEqual(publicTrack.data.printer.portName, undefined, "portName must not leak on order tracking");
    assert.strictEqual(publicTrack.data.printer.driverName, undefined, "driverName must not leak on order tracking");
    assert.strictEqual(publicTrack.data.printer.availablePrinters, undefined, "availablePrinters must not leak");
    assert.ok(!serializedTrack.includes("ALPHA-SECRET-HOST"), "Internal hostname must not appear anywhere");
    assert.ok(!serializedTrack.includes("USB009"), "Internal portName must not appear anywhere");
    console.log("  PASS: Public order tracking response is fully sanitized.");

    // 3. Agent Job Ownership, Cancellation Status, and ObjectId Validation
    console.log("\n[3/8] Testing agent job ownership, CANCELLED status, and ObjectId validation...");
    const nextJobRes = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: { "x-agent-id": credsA1.agentId, "x-agent-secret": credsA1.agentSecret }
    });
    assert.strictEqual(nextJobRes.status, 200);
    const claimedJob = nextJobRes.data.job;
    assert.ok(claimedJob && claimedJob.orderId === trackedOrder.id);

    // Agent A2 (same tenant, did NOT claim job) must be rejected with 403
    const hijackStatus = await apiRequest(baseUrl, "PATCH", `/agent/jobs/${claimedJob.orderId}/status`, {
      headers: { "x-agent-id": credsA2.agentId, "x-agent-secret": credsA2.agentSecret },
      body: { status: "COMPLETED", agentJobId: claimedJob.agentJobId }
    });
    assert.strictEqual(hijackStatus.status, 403, "Non-claiming agent in same tenant must get 403");

    // Claiming agent with mismatched agentJobId must get 409
    const badLease = await apiRequest(baseUrl, "PATCH", `/agent/jobs/${claimedJob.orderId}/status`, {
      headers: { "x-agent-id": credsA1.agentId, "x-agent-secret": credsA1.agentSecret },
      body: { status: "PRINTING", agentJobId: "wrong-lease-id" }
    });
    assert.strictEqual(badLease.status, 409, "Mismatched agentJobId must get 409");

    // Invalid ObjectIds must return 400 (not 500)
    const badObjIdAgent = await apiRequest(baseUrl, "PATCH", "/agent/jobs/not-an-object-id/status", {
      headers: { "x-agent-id": credsA1.agentId, "x-agent-secret": credsA1.agentSecret },
      body: { status: "COMPLETED" }
    });
    assert.strictEqual(badObjIdAgent.status, 400);

    const badObjIdVendor = await apiRequest(baseUrl, "GET", "/vendor/orders/not-an-object-id/file", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(badObjIdVendor.status, 400);

    // Claiming agent can report spooler CANCELLED status
    const cancelBySpooler = await apiRequest(baseUrl, "PATCH", `/agent/jobs/${claimedJob.orderId}/status`, {
      headers: { "x-agent-id": credsA1.agentId, "x-agent-secret": credsA1.agentSecret },
      body: {
        status: "CANCELLED",
        agentJobId: claimedJob.agentJobId,
        failureReason: "Cancelled in Windows Print Spooler."
      }
    });
    assert.strictEqual(cancelBySpooler.status, 200);
    assert.strictEqual(cancelBySpooler.data.status, "CANCELLED");
    console.log("  PASS: Agent job ownership, CANCELLED status, rate limits, and ObjectId validation verified.");

    // 4. Super Admin Password Reset: Never touches SUPER_ADMIN, invalidates old vendor JWT
    console.log("\n[4/8] Testing Super Admin password reset & SUPER_ADMIN protection...");
    if (defaultTenantId) {
      const resetDefault = await apiRequest(
        baseUrl,
        "POST",
        `/super-admin/vendors/${defaultTenantId}/reset-password`,
        {
          headers: { Authorization: `Bearer ${superToken}` },
          body: { newPassword: "AttemptOverwriteSuperAdmin123!" }
        }
      );
      // Default tenant has only the bootstrapped SUPER_ADMIN, so it must return 404 and leave SUPER_ADMIN untouched
      assert.strictEqual(resetDefault.status, 404);
      const superStillWorks = await apiRequest(baseUrl, "POST", "/super-admin/login", {
        body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
      });
      assert.strictEqual(superStillWorks.status, 200, "SUPER_ADMIN password must never be overwritten");
    }

    // Wait 1.1s so passwordChangedAt > old JWT iat
    await new Promise((r) => setTimeout(r, 1100));
    const resetVendorA = await apiRequest(
      baseUrl,
      "POST",
      `/super-admin/vendors/${vendorA.id}/reset-password`,
      {
        headers: { Authorization: `Bearer ${superToken}` },
        body: { newPassword: "NewAlphaPassword456!" }
      }
    );
    assert.strictEqual(resetVendorA.status, 200);

    // Old vendor JWT must now be rejected (401)
    const oldTokenCheck = await apiRequest(baseUrl, "GET", "/vendor/me", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(oldTokenCheck.status, 401, "Old vendor JWT must be invalidated after password reset");

    // New password logs in cleanly
    const reLoginA = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: "alpha@cleanup.test", password: "NewAlphaPassword456!" }
    });
    assert.strictEqual(reLoginA.status, 200);
    tokenA = reLoginA.data.token;
    console.log("  PASS: SUPER_ADMIN protected and vendor sessions invalidated on password reset.");

    // 5. Per-Vendor Upload Limit & Compressed PDF Page-Count Validation
    console.log("\n[5/8] Testing per-vendor maxUploadMb enforcement and compressed PDF validation...");
    await apiRequest(baseUrl, "PUT", "/vendor/settings", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { maxUploadMb: 1 }
    });
    const oversizedPdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n"),
      Buffer.alloc(1.2 * 1024 * 1024, 0x20),
      Buffer.from("\n%%EOF\n")
    ]);
    const directOversized = await apiRequest(baseUrl, "POST", `/shops/${vendorA.shopSlug}/orders`, {
      body: buildPdfForm("oversized.pdf", oversizedPdf, { copies: 1, colorMode: "bw", sides: "single", paperSize: "A4" })
    });
    assert.strictEqual(directOversized.status, 413, "Direct upload exceeding vendor maxUploadMb must return 413");

    // Compressed FlateDecode /ObjStm PDF page count
    const compressedObj = zlib.deflateSync(
      Buffer.from("<< /Type /Pages /Count 3 >> << /Type /Page >> << /Type /Page >> << /Type /Page >>")
    );
    const compressedPdf = Buffer.concat([
      Buffer.from("%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n"),
      compressedObj,
      Buffer.from("\nendstream\nendobj\n%%EOF\n")
    ]);
    assert.strictEqual(inspectPdfBuffer(compressedPdf).pageCount, 3, "Compressed PDF object stream must yield 3 pages");
    console.log("  PASS: Per-vendor upload limit (413) and compressed PDF page-count fallback verified.");

    // 6. Electron Security Hardening Static Checks
    console.log("\n[6/8] Verifying Electron secret-pipe, CSP, and QR HTML escaping...");
    const mainCjs = fs.readFileSync(
      path.resolve(__dirname, "../../desktop-app/electron/main.cjs"),
      "utf-8"
    );
    const indexHtml = fs.readFileSync(
      path.resolve(__dirname, "../../desktop-app/index.html"),
      "utf-8"
    );
    const desktopAppJsx = fs.readFileSync(
      path.resolve(__dirname, "../../desktop-app/src/App.jsx"),
      "utf-8"
    );
    assert.ok(mainCjs.includes("--secret-stdin"), "Electron must deliver agentSecret via --secret-stdin");
    assert.ok(
      !mainCjs.includes("agentSecret: currentSession.agentSecret || \"\"") &&
        !mainCjs.includes("agentSecret: session.agentSecret || \"\""),
      "Electron must never write plaintext agentSecret into agent-runtime-config.json"
    );
    assert.ok(mainCjs.includes("Content-Security-Policy"), "Electron main process must set CSP");
    assert.ok(indexHtml.includes("Content-Security-Policy"), "Electron index.html must include CSP meta");
    assert.ok(desktopAppJsx.includes("escapeHtml"), "Desktop QR standee popup must escape HTML");
    console.log("  PASS: Electron secret protection, CSP, and QR escaping verified.");

    // 7. Automatic 48-Hour Customer Document Cleanup Tests
    console.log("\n[7/8] Testing 48-hour automatic GridFS cleanup, print safety, tenant isolation & order preservation...");
    const now = new Date();
    const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000);

    async function createOrderForShop(slug, name, targetStatus, ageHours) {
      const uniquePdf = Buffer.concat([SAMPLE_PDF, Buffer.from(`% ${name}-${Math.random()}\n`)]);
      const res = await apiRequest(baseUrl, "POST", `/shops/${slug}/orders`, {
        body: buildPdfForm(name, uniquePdf, {
          copies: 1,
          colorMode: "bw",
          sides: "single",
          paperSize: "A4",
          idempotencyKey: `idem-${name}-${Date.now()}-${Math.random()}`
        })
      });
      assert.strictEqual(res.status, 201, `Failed to create test order ${name}: ${JSON.stringify(res.data)}`);
      const dbOrder = await Order.findById(res.data.order.id);
      if (targetStatus !== "QUEUED") {
        dbOrder.status = targetStatus;
        if (targetStatus === "COMPLETED") dbOrder.completedAt = now;
        await dbOrder.save();
      }
      await ageDocumentInDb(dbOrder._id, dbOrder.gridFsFileId, hoursAgo(ageHours));
      return Order.findById(dbOrder._id);
    }

    const youngCompleted = await createOrderForShop(vendorA.shopSlug, "young-47h.pdf", "COMPLETED", 47.9);
    const exactBoundary = await createOrderForShop(vendorA.shopSlug, "exact-48h.pdf", "COMPLETED", 48.0);
    const oldCompleted = await createOrderForShop(vendorA.shopSlug, "old-49h.pdf", "COMPLETED", 49.0);
    const activeDownloading = await createOrderForShop(vendorA.shopSlug, "active-dl-50h.pdf", "DOWNLOADING", 50.0);
    const activePrinting = await createOrderForShop(vendorA.shopSlug, "active-print-50h.pdf", "PRINTING", 50.0);
    const pendingQueued = await createOrderForShop(vendorA.shopSlug, "pending-queued-50h.pdf", "QUEUED", 50.0);
    const tenantBOld = await createOrderForShop(vendorB.shopSlug, "tenant-b-49h.pdf", "COMPLETED", 49.0);

    // Upload a vendor-category file > 48h old to prove unrelated/vendor files are never deleted
    const vendorAsset = await uploadBufferToGridFS({
      buffer: Buffer.from("vendor-banner-data"),
      filename: "vendor-logo.png",
      contentType: "image/png",
      tenantId: vendorA.id,
      metadata: { category: "vendor", staged: false }
    });
    await mongoose.connection.db.collection("printDocuments.files").updateOne(
      { _id: vendorAsset.gridFsFileId },
      { $set: { uploadDate: hoursAgo(72) } }
    );

    // 7a. Failed deletion retry test (simulate transient GridFS failure on oldCompleted)
    let failOnce = true;
    const retrySummary = await runDocumentCleanupSweep({
      now,
      tenantId: vendorA.id,
      deleteFn: async (fileId, tId, opts) => {
        if (failOnce && String(fileId) === String(oldCompleted.gridFsFileId)) {
          failOnce = false;
          throw new Error("Simulated transient MongoDB storage error");
        }
        const { deleteGridFSFile } = require("../src/services/gridfsService");
        return deleteGridFSFile(fileId, tId, opts);
      }
    });
    assert.strictEqual(retrySummary.errors, 1, "Simulated error must be counted");
    const stillExistsAfterError = await findGridFSFileById(oldCompleted.gridFsFileId, vendorA.id);
    assert.ok(stillExistsAfterError, "Failed deletion must preserve file and release claim for retry");

    // 7b. Run normal sweep for Tenant A ONLY -> proves Tenant B is untouched, retry succeeds, active/pending protected!
    const sweepA = await runDocumentCleanupSweep({ now, tenantId: vendorA.id });
    assert.strictEqual(sweepA.errors, 0);

    // Younger than 48h retained
    assert.ok(await findGridFSFileById(youngCompleted.gridFsFileId, vendorA.id), "<48h file must be retained");
    assert.ok((await countGridFsChunks(youngCompleted.gridFsFileId)) > 0);

    // Exact 48h boundary & 49h completed deleted (both file doc and chunks!)
    assert.strictEqual(await findGridFSFileById(exactBoundary.gridFsFileId, vendorA.id), null, "Exact 48h file must be deleted");
    assert.strictEqual(await countGridFsChunks(exactBoundary.gridFsFileId), 0, "Exact 48h chunks must be deleted");
    assert.strictEqual(await findGridFSFileById(oldCompleted.gridFsFileId, vendorA.id), null, "49h file must be deleted on retry");
    assert.strictEqual(await countGridFsChunks(oldCompleted.gridFsFileId), 0, "49h chunks must be deleted");

    // Active DOWNLOADING, PRINTING, and pending QUEUED jobs protected + marked cleanupEligible
    for (const protectedOrder of [activeDownloading, activePrinting, pendingQueued]) {
      assert.ok(
        await findGridFSFileById(protectedOrder.gridFsFileId, vendorA.id),
        `${protectedOrder.status} job file must NEVER be deleted prematurely`
      );
      const refreshed = await Order.findById(protectedOrder._id);
      assert.strictEqual(refreshed.cleanupEligible, true, `${protectedOrder.status} job must be marked cleanupEligible`);
      assert.strictEqual(refreshed.fileDeleted, false);
    }

    // Tenant B's 49h file must NOT have been deleted by Tenant A's sweep
    assert.ok(
      await findGridFSFileById(tenantBOld.gridFsFileId, vendorB.id),
      "Tenant A cleanup must NEVER delete Tenant B documents"
    );

    // Vendor-category file > 48h must NEVER be deleted
    assert.ok(
      await findGridFSFileById(vendorAsset.gridFsFileId, vendorA.id),
      "Vendor/unrelated files must NEVER be deleted by customer document cleanup"
    );

    // Order history & pickup code preservation check
    const preservedOrder = await Order.findById(oldCompleted._id);
    assert.ok(preservedOrder, "Order record must remain intact after document deletion");
    assert.strictEqual(preservedOrder.pickupCode, oldCompleted.pickupCode, "Pickup code must remain intact");
    assert.strictEqual(preservedOrder.token, oldCompleted.token, "Order token must remain intact");
    assert.strictEqual(preservedOrder.totalPrice, oldCompleted.totalPrice, "Pricing snapshot must remain intact");
    assert.strictEqual(preservedOrder.fileDeleted, true);
    assert.strictEqual(preservedOrder.documentStatus, "EXPIRED");
    assert.strictEqual(preservedOrder.gridFsFileId, null, "GridFS file reference must be removed");

    // Expired document cannot be downloaded or reprinted (exact 410 message)
    const expiredDownload = await apiRequest(baseUrl, "GET", `/vendor/orders/${oldCompleted._id}/file`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(expiredDownload.status, 410);
    assert.strictEqual(expiredDownload.data.message, EXPIRED_DOCUMENT_MESSAGE);

    const expiredReprint = await apiRequest(baseUrl, "POST", `/vendor/orders/${oldCompleted.token}/reprint`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(expiredReprint.status, 410);
    assert.strictEqual(expiredReprint.data.message, EXPIRED_DOCUMENT_MESSAGE);

    // Once activePrinting finishes, deferred cleanup deletes its file safely
    await Order.updateOne({ _id: activePrinting._id }, { $set: { status: "COMPLETED", completedAt: now } });
    const deferredSweep = await runDocumentCleanupSweep({ now, tenantId: vendorA.id });
    assert.strictEqual(deferredSweep.deletedOrderFiles, 1);
    assert.strictEqual(await findGridFSFileById(activePrinting.gridFsFileId, vendorA.id), null);
    assert.strictEqual(await countGridFsChunks(activePrinting.gridFsFileId), 0);

    // Idempotency: repeated sweeps produce 0 deletions and 0 errors
    const idempotentSweep = await runDocumentCleanupSweep({ now, tenantId: vendorA.id });
    assert.strictEqual(idempotentSweep.deletedOrderFiles, 0);
    assert.strictEqual(idempotentSweep.errors, 0);

    // 8. Concurrent Multi-Worker Safety Test
    console.log("\n[8/8] Testing concurrent multi-worker atomic cleanup safety...");
    const parallelResults = await Promise.all([
      runDocumentCleanupSweep({ now, tenantId: vendorB.id, workerId: "w1" }),
      runDocumentCleanupSweep({ now, tenantId: vendorB.id, workerId: "w2" }),
      runDocumentCleanupSweep({ now, tenantId: vendorB.id, workerId: "w3" }),
      runDocumentCleanupSweep({ now, tenantId: vendorB.id, workerId: "w4" }),
      runDocumentCleanupSweep({ now, tenantId: vendorB.id, workerId: "w5" })
    ]);
    const totalDeleted = parallelResults.reduce((acc, r) => acc + r.deletedOrderFiles, 0);
    const totalErrors = parallelResults.reduce((acc, r) => acc + r.errors, 0);
    assert.strictEqual(totalDeleted, 1, "Exactly 1 concurrent worker must claim & delete the file");
    assert.strictEqual(totalErrors, 0, "Zero errors allowed across concurrent workers");
    assert.strictEqual(await findGridFSFileById(tenantBOld.gridFsFileId, vendorB.id), null);

    // Verify cleanup audit logs recorded
    const cleanupLogs = await AuditLog.countDocuments({ action: "CUSTOMER_DOCUMENT_EXPIRED_CLEANUP" });
    assert.ok(cleanupLogs >= 3, "Cleanup actions must be recorded in AuditLog");

    // 9. Health Endpoint Verification (200 healthy, zero secret exposure, 503 when DB disconnected)
    console.log("\n[9/9] Verifying /api/health healthy (200) and unhealthy (503) responses...");
    const healthyRes = await apiRequest(baseUrl, "GET", "/health");
    assert.strictEqual(healthyRes.status, 200, "/api/health must return 200 when DB is connected");
    assert.strictEqual(healthyRes.headers.get("cache-control"), "no-store");
    assert.strictEqual(healthyRes.data.success, true);
    assert.strictEqual(healthyRes.data.status, "ok");
    assert.strictEqual(healthyRes.data.database, "connected");
    const serializedHealth = JSON.stringify(healthyRes.data);
    assert.ok(!serializedHealth.includes("mongodb://") && !serializedHealth.includes("mongodb+srv://"), "Health must never expose DB URI");
    assert.ok(!serializedHealth.includes(process.env.JWT_SECRET), "Health must never expose JWT_SECRET");

    // Disconnect DB temporarily and confirm /api/health returns 503
    await mongoose.disconnect();
    const unhealthyRes = await apiRequest(baseUrl, "GET", "/health");
    assert.strictEqual(unhealthyRes.status, 503, "/api/health must return 503 when DB is disconnected");
    assert.strictEqual(unhealthyRes.data.success, false);
    assert.strictEqual(unhealthyRes.data.status, "unhealthy");
    assert.strictEqual(unhealthyRes.data.database, "disconnected");
    console.log("  PASS: /api/health returns 200 (healthy) and 503 (disconnected) with zero secret exposure.");

    console.log("\n====================================================================");
    console.log("STABILIZATION, CLEANUP & HEALTH SUITE: ALL 9 CHECKS PASSED!");
    console.log("====================================================================");
  } finally {
    server.close();
    await stopIsolatedTestDatabase(dbHandle);
  }
}

runTests().catch((err) => {
  console.error("STABILIZATION TEST FAILURE:", err);
  process.exit(1);
});
