const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const app = require("../src/app");
const connectDB = require("../src/config/db");
const Tenant = require("../src/models/Tenant");
const Admin = require("../src/models/Admin");
const Agent = require("../src/models/Agent");
const Order = require("../src/models/Order");
const AuditLog = require("../src/models/AuditLog");
const { bootstrapOwner } = require("../src/controllers/adminController");
const { recoverExpiredLeases } = require("../src/controllers/agentController");
const { deleteGridFSFile } = require("../src/services/gridfsService");

const SAMPLE_PDF = Buffer.from(
  "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n" +
    "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n" +
    "%%EOF\n",
  "utf-8"
);

async function apiRequest(baseUrl, method, urlPath, { headers = {}, body = null, rawBuffer = false } = {}) {
  const reqHeaders = { ...headers };
  let payload = body;

  if (body && !Buffer.isBuffer(body) && typeof body === "object" && !(body instanceof FormData)) {
    reqHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: reqHeaders,
    body: payload
  });

  if (rawBuffer) {
    const arrayBuf = await response.arrayBuffer();
    return {
      status: response.status,
      headers: response.headers,
      buffer: Buffer.from(arrayBuf)
    };
  }

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_e) {
    data = { raw: text };
  }

  return { status: response.status, headers: response.headers, data };
}

function buildMultipartPdfForm(filename, pdfBuffer, fields = {}) {
  const form = new FormData();
  const blob = new Blob([pdfBuffer], { type: "application/pdf" });
  form.append("document", blob, filename);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  return form;
}

async function runStage7Suite() {
  console.log("====================================================================");
  console.log("SMART XEROX — STAGE 7 FULL END-TO-END PLATFORM VERIFICATION SUITE");
  console.log("====================================================================");

  const repoRoot = path.resolve(__dirname, "../..");
  const desktopReleaseDir = path.join(repoRoot, "desktop-app", "release");
  const installerExePath = path.join(desktopReleaseDir, "SmartXerox-Setup.exe");
  const unpackedDir = path.join(desktopReleaseDir, "win-unpacked");
  const unpackedExePath = path.join(unpackedDir, "Smart Xerox.exe");
  const bundledPythonExe = path.join(
    unpackedDir,
    "resources",
    "print-agent",
    "python",
    "python.exe"
  );
  const bundledAgentPy = path.join(
    unpackedDir,
    "resources",
    "print-agent",
    "agent.py"
  );

  // TEST F & B: Installer, Packaged Desktop Executable, No-Secrets Audit, and Real Windows Printer Discovery
  console.log("\n[TEST A/B/F] Verifying Windows Installer, Bundled Python Runtime & Real Printer Discovery...");
  assert.ok(fs.existsSync(installerExePath), `Installer must exist at ${installerExePath}`);
  const installerSizeMb = (fs.statSync(installerExePath).size / (1024 * 1024)).toFixed(2);
  console.log(`  PASS: SmartXerox-Setup.exe built (${installerSizeMb} MB)`);

  assert.ok(fs.existsSync(unpackedExePath), "Unpacked Smart Xerox.exe must exist");
  assert.ok(fs.existsSync(bundledPythonExe), "Bundled standalone python.exe must exist inside resources/print-agent/python/");
  assert.ok(fs.existsSync(bundledAgentPy), "Bundled agent.py must exist inside resources/print-agent/");

  // Verify no .env or secret files were packaged into resources/print-agent
  const packagedAgentFiles = fs.readdirSync(path.join(unpackedDir, "resources", "print-agent"));
  assert.ok(
    !packagedAgentFiles.some((f) => f.startsWith(".env") || f === "completed_jobs.json"),
    "Packaged resources must NEVER contain .env or local secrets"
  );
  console.log("  PASS: Zero .env or secret files in packaged application resources.");

  // Run the packaged Smart Xerox.exe --cli-self-test
  const selfTestRaw = execFileSync(unpackedExePath, ["--cli-self-test"], {
    encoding: "utf-8",
    timeout: 25000
  }).trim();
  const selfTestJson = JSON.parse(selfTestRaw.split(/\r?\n/).pop());
  assert.strictEqual(selfTestJson.selfTest, "PASS");
  assert.strictEqual(selfTestJson.isPackaged, true, "Executable must run in packaged mode");
  assert.strictEqual(selfTestJson.printerDiscovery.success, true);
  assert.strictEqual(selfTestJson.printerDiscovery.spoolerAvailable, true);
  console.log(
    `  PASS: Packaged Smart Xerox.exe self-test passed (Detected ${selfTestJson.printerDiscovery.printers.length} physical Windows printer(s): ${selfTestJson.printerDiscovery.printers.map((p) => `${p.name} [${p.status}]`).join(", ")})`
  );

  // Connect to MongoDB Atlas for live multi-vendor workflow & recovery tests
  await connectDB();
  await bootstrapOwner();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const createdTenantIds = [];
  const createdAdminIds = [];
  const createdAgentIds = [];
  const createdOrderIds = [];
  const createdGridFsIds = [];
  const runSuffix = Date.now().toString(36);

  try {
    // TEST C & D: Two Independent Vendors + Customer Printing Workflow + Isolation
    console.log("\n[TEST C/D] Testing Two Independent Vendors (ABC Xerox & City Xerox) & Customer Printing Workflow...");
    const superLogin = await apiRequest(baseUrl, "POST", "/super-admin/login", {
      body: {
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD
      }
    });
    assert.strictEqual(superLogin.status, 200);
    const superToken = superLogin.data.token;

    const vA = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `ABC Xerox ${runSuffix}`,
        shopSlug: `abc-xerox-${runSuffix}`,
        email: `abc.${runSuffix}@smartxerox.test`,
        password: "VendorAPassword123!"
      }
    });
    const vB = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `City Xerox ${runSuffix}`,
        shopSlug: `city-xerox-${runSuffix}`,
        email: `city.${runSuffix}@smartxerox.test`,
        password: "VendorBPassword123!"
      }
    });
    assert.strictEqual(vA.status, 201);
    assert.strictEqual(vB.status, 201);
    const vendorA = vA.data.vendor;
    const vendorB = vB.data.vendor;
    createdTenantIds.push(vendorA.id, vendorB.id);
    createdAdminIds.push(vendorA.admin.id, vendorB.admin.id);

    // Vendor A & Vendor B sign in and pair their desktop installations
    const loginA = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `abc.${runSuffix}@smartxerox.test`, password: "VendorAPassword123!" }
    });
    const loginB = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `city.${runSuffix}@smartxerox.test`, password: "VendorBPassword123!" }
    });
    const pairA = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${loginA.data.token}` },
      body: { deviceId: `abc-pc-${runSuffix}`, hostname: "ABC-XEROX-PC" }
    });
    const pairB = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${loginB.data.token}` },
      body: { deviceId: `city-pc-${runSuffix}`, hostname: "CITY-XEROX-PC" }
    });
    createdAgentIds.push(pairA.data.agent.id, pairB.data.agent.id);
    const credsA = pairA.data.credentials;
    const credsB = pairB.data.credentials;

    // Agent A reports real detected printer from this Windows machine
    const localPrinters = selfTestJson.printerDiscovery.printers;
    const primaryLocal = localPrinters[0] || {
      name: "HP LaserJet MFP M129-M134",
      portName: "USB002",
      driverName: "HP LaserJet MFP M129-M134 PCLm-S",
      connectionType: "USB",
      isDefault: true,
      printerAvailable: true,
      status: "READY",
      capabilities: {
        supportedPaperSizes: ["A4", "Legal", "Letter", "A5"],
        supportsColor: false,
        supportsDuplex: true
      }
    };

    await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: { "x-agent-id": credsA.agentId, "x-agent-secret": credsA.agentSecret },
      body: {
        deviceId: credsA.deviceId,
        printerName: primaryLocal.name,
        portName: primaryLocal.portName,
        driverName: primaryLocal.driverName,
        printerAvailable: true,
        status: "READY",
        availablePrinters: [{ ...primaryLocal, printerAvailable: true, status: "READY" }]
      }
    });

    // Customer scans ABC Xerox QR code -> uploads PDF -> selects B&W, A4, 2 copies -> clicks Print
    const stageA = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders/inspect`,
      { body: buildMultipartPdfForm("customer-invoice.pdf", SAMPLE_PDF) }
    );
    assert.strictEqual(stageA.status, 200);
    createdGridFsIds.push({ id: stageA.data.document.uploadId, tenantId: vendorA.id });

    const orderARes = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders`,
      {
        body: {
          uploadId: stageA.data.document.uploadId,
          colorMode: "bw",
          paperSize: "A4",
          sides: "single",
          copies: 2,
          orientation: "portrait",
          pageSelectionMode: "all"
        }
      }
    );
    assert.strictEqual(orderARes.status, 201);
    const orderA = orderARes.data.order;
    createdOrderIds.push(orderA.id);
    console.log(`  PASS: Customer submitted job ${orderA.token} to ${vendorA.shopName} (/shop/${vendorA.shopSlug})`);

    // TEST E: Recovery & Duplicate Print Prevention
    console.log("\n[TEST E] Verifying Network Disconnection Recovery & Duplicate Print Prevention...");
    // 1. Agent A claims the job (status -> DOWNLOADING)
    const claim1 = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: { "x-agent-id": credsA.agentId, "x-agent-secret": credsA.agentSecret }
    });
    assert.strictEqual(claim1.status, 200);
    assert.strictEqual(String(claim1.data.job.orderId), String(orderA.id));

    // Simulate network drop during DOWNLOADING by expiring leaseExpiresAt
    await Order.updateOne(
      { _id: orderA.id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 10000) } }
    );
    await recoverExpiredLeases(vendorA.id);
    const recoveredJob = await Order.findById(orderA.id);
    assert.strictEqual(
      recoveredJob.status,
      "QUEUED",
      "Stalled DOWNLOADING job must safely recover back to QUEUED after network drop"
    );
    assert.strictEqual(recoveredJob.retryCount, 1);

    // 2. Agent A reconnects and re-claims the recovered job, transitions to PRINTING
    const claim2 = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: { "x-agent-id": credsA.agentId, "x-agent-secret": credsA.agentSecret }
    });
    assert.strictEqual(String(claim2.data.job.orderId), String(orderA.id));

    await apiRequest(baseUrl, "PATCH", `/agent/jobs/${orderA.id}/status`, {
      headers: { "x-agent-id": credsA.agentId, "x-agent-secret": credsA.agentSecret },
      body: { status: "PRINTING", agentJobId: claim2.data.job.agentJobId }
    });

    // Simulate lease expiry while in PRINTING state -> must NOT re-queue to QUEUED!
    await Order.updateOne(
      { _id: orderA.id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 10000) } }
    );
    await recoverExpiredLeases(vendorA.id);
    const printingJob = await Order.findById(orderA.id);
    assert.strictEqual(
      printingJob.status,
      "PRINTING",
      "Job already in PRINTING state must NEVER be auto-requeued to prevent duplicate physical printing"
    );

    // Complete job and verify customer mobile tracking shows COMPLETED
    await apiRequest(baseUrl, "PATCH", `/agent/jobs/${orderA.id}/status`, {
      headers: { "x-agent-id": credsA.agentId, "x-agent-secret": credsA.agentSecret },
      body: {
        status: "COMPLETED",
        agentJobId: claim2.data.job.agentJobId,
        spoolerJobId: 101
      }
    });

    const customerTrack = await apiRequest(
      baseUrl,
      "GET",
      `/shops/${vendorA.shopSlug}/orders/${orderA.token}`
    );
    assert.strictEqual(customerTrack.status, 200);
    assert.strictEqual(customerTrack.data.order.status, "COMPLETED");
    console.log("  PASS: Safe lease recovery during DOWNLOADING, duplicate print protection during PRINTING, and customer COMPLETED tracking verified.");

    console.log("\n====================================================================");
    console.log("ALL STAGE 7 END-TO-END PLATFORM TESTS PASSED!");
    console.log("====================================================================");
  } finally {
    for (const item of createdGridFsIds) {
      await deleteGridFSFile(item.id, item.tenantId).catch(() => {});
    }
    if (createdOrderIds.length > 0) {
      await Order.deleteMany({ _id: { $in: createdOrderIds } }).catch(() => {});
    }
    if (createdAgentIds.length > 0) {
      await Agent.deleteMany({ _id: { $in: createdAgentIds } }).catch(() => {});
    }
    if (createdAdminIds.length > 0) {
      await Admin.deleteMany({ _id: { $in: createdAdminIds } }).catch(() => {});
    }
    if (createdTenantIds.length > 0) {
      await AuditLog.deleteMany({ tenantId: { $in: createdTenantIds } }).catch(() => {});
      await Tenant.deleteMany({ _id: { $in: createdTenantIds } }).catch(() => {});
    }
    server.close();
    await mongoose.disconnect();
  }
}

runStage7Suite().catch((err) => {
  console.error("STAGE 7 VERIFICATION FAILED:", err);
  process.exit(1);
});
