const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const mongoose = require("mongoose");
const app = require("../src/app");
const connectDB = require("../src/config/db");
const Tenant = require("../src/models/Tenant");
const Admin = require("../src/models/Admin");
const Agent = require("../src/models/Agent");
const Order = require("../src/models/Order");
const AuditLog = require("../src/models/AuditLog");
const { bootstrapOwner } = require("../src/controllers/adminController");
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

async function apiRequest(baseUrl, method, path, { headers = {}, body = null, rawBuffer = false } = {}) {
  const reqHeaders = { ...headers };
  let payload = body;

  if (body && !Buffer.isBuffer(body) && typeof body === "object" && !(body instanceof FormData)) {
    reqHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
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

async function runTests() {
  console.log("====================================================================");
  console.log("SMART XEROX — STAGE 2 MULTI-VENDOR SECURITY & ISOLATION TEST SUITE");
  console.log("====================================================================");

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
    // 1. Authenticate Super Admin
    console.log("\n[1/8] Authenticating Super Admin & verifying unscoped endpoint guard...");
    const superLogin = await apiRequest(baseUrl, "POST", "/super-admin/login", {
      body: {
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD
      }
    });
    assert.strictEqual(superLogin.status, 200, "Super Admin login must return 200");
    assert.ok(superLogin.data.token, "Super Admin JWT must be returned");
    const superToken = superLogin.data.token;

    // Verify legacy unscoped /api/orders is blocked
    const legacyGuard = await apiRequest(baseUrl, "GET", "/orders");
    assert.strictEqual(legacyGuard.status, 400, "Unscoped /api/orders must be rejected (400)");
    console.log("  PASS: Super Admin authenticated; unscoped /api/orders blocked.");

    // 2. Create two independent vendors: Vendor A and Vendor B
    console.log("\n[2/8] Creating Vendor A and Vendor B via Super Admin...");
    const vendorARes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `Alpha Xerox ${runSuffix}`,
        shopSlug: `alpha-xerox-${runSuffix}`,
        ownerName: "Alpha Owner",
        email: `alpha.${runSuffix}@smartxerox.test`,
        password: "AlphaPassword123!",
        maxCopies: 50
      }
    });
    assert.strictEqual(vendorARes.status, 201, "Vendor A creation must succeed");
    const vendorA = vendorARes.data.vendor;
    createdTenantIds.push(vendorA.id);
    createdAdminIds.push(vendorA.admin.id);

    const vendorBRes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `Beta Xerox ${runSuffix}`,
        shopSlug: `beta-xerox-${runSuffix}`,
        ownerName: "Beta Owner",
        email: `beta.${runSuffix}@smartxerox.test`,
        password: "BetaPassword123!",
        maxCopies: 100
      }
    });
    assert.strictEqual(vendorBRes.status, 201, "Vendor B creation must succeed");
    const vendorB = vendorBRes.data.vendor;
    createdTenantIds.push(vendorB.id);
    createdAdminIds.push(vendorB.admin.id);

    assert.notStrictEqual(vendorA.id, vendorB.id, "Tenants must have distinct IDs");
    assert.notStrictEqual(vendorA.shopSlug, vendorB.shopSlug, "Tenants must have distinct slugs");
    assert.ok(
      !vendorA.publicUrl.includes("localhost") && !vendorA.publicUrl.includes("192.168."),
      `QR publicUrl must not contain localhost or LAN IP: ${vendorA.publicUrl}`
    );

    // Prevent duplicate email address (409)
    const dupEmailRes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `Duplicate Email Shop`,
        email: `alpha.${runSuffix}@smartxerox.test`,
        password: "AlphaPassword123!"
      }
    });
    assert.strictEqual(dupEmailRes.status, 409, "Duplicate vendor email must be rejected with 409");

    // Prevent duplicate explicit shopSlug (409)
    const dupSlugRes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `Duplicate Slug Shop`,
        shopSlug: `alpha-xerox-${runSuffix}`,
        email: `unique.${runSuffix}@smartxerox.test`,
        password: "AlphaPassword123!"
      }
    });
    assert.strictEqual(dupSlugRes.status, 409, "Duplicate explicit shopSlug must be rejected with 409");
    console.log(`  PASS: Created Vendor A (${vendorA.shopSlug}) & Vendor B (${vendorB.shopSlug}); duplicate email & slug blocked.`);

    // 3. Vendor Logins, Role Verification, Suspension & Desktop Pairing
    console.log("\n[3/8] Signing in Vendor A & Vendor B, testing invalid/suspended login, and pairing Desktop Agents...");
    const invalidLogin = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `alpha.${runSuffix}@smartxerox.test`, password: "WrongPassword!" }
    });
    assert.strictEqual(invalidLogin.status, 401, "Invalid vendor credentials must return 401");

    // Vendor A must be blocked from logging into /api/super-admin/login (403)
    const vendorTrySuperLogin = await apiRequest(baseUrl, "POST", "/super-admin/login", {
      body: { email: `alpha.${runSuffix}@smartxerox.test`, password: "AlphaPassword123!" }
    });
    assert.strictEqual(vendorTrySuperLogin.status, 403, "Vendor account must be denied Super Admin login (403)");

    // Suspend Vendor A -> login must fail with 403
    const suspendARes = await apiRequest(
      baseUrl,
      "PATCH",
      `/super-admin/vendors/${vendorA.id}/status`,
      {
        headers: { Authorization: `Bearer ${superToken}` },
        body: { status: "SUSPENDED" }
      }
    );
    assert.strictEqual(suspendARes.status, 200);
    const suspendedLogin = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `alpha.${runSuffix}@smartxerox.test`, password: "AlphaPassword123!" }
    });
    assert.strictEqual(suspendedLogin.status, 403, "Suspended vendor login must be rejected with 403");

    // Reactivate Vendor A -> login succeeds
    const activateARes = await apiRequest(
      baseUrl,
      "PATCH",
      `/super-admin/vendors/${vendorA.id}/status`,
      {
        headers: { Authorization: `Bearer ${superToken}` },
        body: { status: "ACTIVE" }
      }
    );
    assert.strictEqual(activateARes.status, 200);

    const loginA1 = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `alpha.${runSuffix}@smartxerox.test`, password: "AlphaPassword123!" }
    });
    assert.strictEqual(loginA1.status, 200);
    assert.strictEqual(loginA1.data.vendor.role, "VENDOR_ADMIN");

    // Test password change validations: wrong current password (401), mismatched confirm (400), reusing current password (400)
    const wrongCurrentPw = await apiRequest(baseUrl, "PUT", "/vendor/password", {
      headers: { Authorization: `Bearer ${loginA1.data.token}` },
      body: {
        currentPassword: "WrongCurrentPassword!",
        newPassword: "AlphaNewPassword456!",
        confirmPassword: "AlphaNewPassword456!"
      }
    });
    assert.strictEqual(wrongCurrentPw.status, 401, "Wrong current password must return 401");

    const mismatchConfirmPw = await apiRequest(baseUrl, "PUT", "/vendor/password", {
      headers: { Authorization: `Bearer ${loginA1.data.token}` },
      body: {
        currentPassword: "AlphaPassword123!",
        newPassword: "AlphaNewPassword456!",
        confirmPassword: "DifferentConfirmPassword!"
      }
    });
    assert.strictEqual(mismatchConfirmPw.status, 400, "Mismatched confirm password must return 400");

    const reuseCurrentPw = await apiRequest(baseUrl, "PUT", "/vendor/password", {
      headers: { Authorization: `Bearer ${loginA1.data.token}` },
      body: {
        currentPassword: "AlphaPassword123!",
        newPassword: "AlphaPassword123!",
        confirmPassword: "AlphaPassword123!"
      }
    });
    assert.strictEqual(reuseCurrentPw.status, 400, "Reusing current password must return 400");

    // Vendor A changes their own password via PUT /api/vendor/password
    const changePwRes = await apiRequest(baseUrl, "PUT", "/vendor/password", {
      headers: { Authorization: `Bearer ${loginA1.data.token}` },
      body: {
        currentPassword: "AlphaPassword123!",
        newPassword: "AlphaNewPassword456!",
        confirmPassword: "AlphaNewPassword456!"
      }
    });
    assert.strictEqual(changePwRes.status, 200, "Vendor password change must succeed");
    assert.ok(changePwRes.data.token, "Fresh JWT must be returned after password change");

    const loginA2 = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `alpha.${runSuffix}@smartxerox.test`, password: "AlphaNewPassword456!" }
    });
    assert.strictEqual(loginA2.status, 200);
    assert.strictEqual(
      loginA1.data.tenant.publicUrl,
      loginA2.data.tenant.publicUrl,
      "Shop QR URL must remain permanent across multiple logins"
    );
    const tokenA = loginA2.data.token;

    const loginB = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `beta.${runSuffix}@smartxerox.test`, password: "BetaPassword123!" }
    });
    assert.strictEqual(loginB.status, 200);
    const tokenB = loginB.data.token;

    // Pair Agent A and Agent B (even with same local hostname/deviceId to prove multi-tenant isolation on same test PC)
    const pairA = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        deviceId: `win11-pc-${runSuffix}`,
        hostname: "SHOP-PC-ALPHA",
        osVersion: "Windows 11 Pro",
        agentVersion: "3.0.0"
      }
    });
    assert.strictEqual(pairA.status, 201);
    const credsA = pairA.data.credentials;
    createdAgentIds.push(pairA.data.agent.id);

    const pairB = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        deviceId: `win11-pc-${runSuffix}`,
        hostname: "SHOP-PC-BETA",
        osVersion: "Windows 11 Pro",
        agentVersion: "3.0.0"
      }
    });
    assert.strictEqual(pairB.status, 201);
    const credsB = pairB.data.credentials;
    createdAgentIds.push(pairB.data.agent.id);

    assert.notStrictEqual(credsA.agentId, credsB.agentId, "Each paired installation must get a unique agentId");
    assert.notStrictEqual(credsA.agentSecret, credsB.agentSecret, "Each paired installation must get a unique agentSecret");

    // Verify legacy shared token is rejected
    const sharedTokenAttempt = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: { "x-agent-token": process.env.PRINT_AGENT_TOKEN || "shared-secret" },
      body: { deviceId: "legacy", printerName: "HP" }
    });
    assert.strictEqual(sharedTokenAttempt.status, 401, "Shared global token must be rejected");
    console.log("  PASS: Unique per-agent credentials issued; shared global token rejected.");

    // 4. Agent Heartbeats & Printer Capabilities Isolation
    console.log("\n[4/8] Sending isolated printer discovery heartbeats for Agent A & Agent B...");
    const hbA = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: {
        deviceId: credsA.deviceId,
        agentVersion: "3.0.0",
        printerName: "HP LaserJet Alpha Mono",
        portName: "USB001",
        driverName: "HP LaserJet Driver",
        printerAvailable: true,
        status: "READY",
        availablePrinters: [
          {
            name: "HP LaserJet Alpha Mono",
            portName: "USB001",
            driverName: "HP LaserJet Driver",
            connectionType: "USB",
            isDefault: true,
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "Legal"],
              supportsColor: false,
              supportsDuplex: false
            }
          }
        ]
      }
    });
    assert.strictEqual(hbA.status, 200);
    assert.strictEqual(
      hbA.data.tenant.selectedPrinterName,
      "HP LaserJet Alpha Mono",
      "Single detected printer must be selected automatically"
    );

    const hbB = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsB.agentId,
        "x-agent-secret": credsB.agentSecret
      },
      body: {
        deviceId: credsB.deviceId,
        agentVersion: "3.0.0",
        printerName: "Canon Color Duplex Beta",
        portName: "USB002",
        driverName: "Canon Generic Plus PCL6",
        printerAvailable: true,
        status: "READY",
        availablePrinters: [
          {
            name: "Canon Color Duplex Beta",
            portName: "USB002",
            driverName: "Canon Generic Plus PCL6",
            connectionType: "USB",
            isDefault: true,
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "A3", "Legal"],
              supportsColor: true,
              supportsDuplex: true
            }
          }
        ]
      }
    });
    assert.strictEqual(hbB.status, 200);

    const shopInfoA = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}`);
    const shopInfoB = await apiRequest(baseUrl, "GET", `/shops/${vendorB.shopSlug}`);
    assert.strictEqual(shopInfoA.data.printer.printerName, "HP LaserJet Alpha Mono");
    assert.strictEqual(shopInfoA.data.printer.capabilities.supportsColor, false);
    assert.strictEqual(shopInfoB.data.printer.printerName, "Canon Color Duplex Beta");
    assert.strictEqual(shopInfoB.data.printer.capabilities.supportsColor, true);

    // Connect a second physical printer (Epson EcoTank Wi-Fi) to Vendor A -> must NOT overwrite selectedPrinterName
    const hbAMulti = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: {
        deviceId: credsA.deviceId,
        agentVersion: "3.1.0",
        printerName: "HP LaserJet Alpha Mono",
        availablePrinters: [
          {
            name: "HP LaserJet Alpha Mono",
            manufacturer: "HP",
            model: "LaserJet Alpha Mono",
            portName: "USB001",
            driverName: "HP LaserJet Driver",
            connectionType: "USB",
            printerCategory: "PHYSICAL",
            isDefault: true,
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "Legal"],
              supportsColor: false,
              supportsDuplex: false
            }
          },
          {
            name: "Epson EcoTank L3250",
            manufacturer: "Epson",
            model: "EcoTank L3250",
            portName: "WSD-88412",
            driverName: "EPSON L3250 Series",
            connectionType: "WIFI",
            printerCategory: "PHYSICAL",
            isDefault: false,
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "A5", "B5"],
              supportsColor: true,
              supportsDuplex: false
            }
          }
        ]
      }
    });
    assert.strictEqual(hbAMulti.status, 200);
    assert.strictEqual(
      hbAMulti.data.tenant.selectedPrinterName,
      "HP LaserJet Alpha Mono",
      "Connecting a second printer must NOT overwrite the vendor's selected printer"
    );

    // Disconnect Vendor A's selected HP printer while Epson stays connected -> selected printer must show OFFLINE
    const hbADisconnected = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: {
        deviceId: credsA.deviceId,
        agentVersion: "3.1.0",
        printerName: "HP LaserJet Alpha Mono",
        availablePrinters: [
          {
            name: "Epson EcoTank L3250",
            manufacturer: "Epson",
            model: "EcoTank L3250",
            portName: "WSD-88412",
            driverName: "EPSON L3250 Series",
            connectionType: "WIFI",
            printerCategory: "PHYSICAL",
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "A5", "B5"],
              supportsColor: true,
              supportsDuplex: false
            }
          }
        ]
      }
    });
    assert.strictEqual(hbADisconnected.status, 200);
    const shopInfoADisc = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}`);
    assert.strictEqual(
      shopInfoADisc.data.printer.printerAvailable,
      false,
      "Disconnected selected printer must report printerAvailable=false"
    );
    assert.strictEqual(
      shopInfoADisc.data.printer.selectedPrinterDisconnected,
      true,
      "Disconnected selected printer must flag selectedPrinterDisconnected=true"
    );

    // Reconnect Vendor A's HP printer -> automatically READY again
    await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: {
        deviceId: credsA.deviceId,
        agentVersion: "3.1.0",
        printerName: "HP LaserJet Alpha Mono",
        availablePrinters: [
          {
            name: "HP LaserJet Alpha Mono",
            manufacturer: "HP",
            model: "LaserJet Alpha Mono",
            portName: "USB001",
            driverName: "HP LaserJet Driver",
            connectionType: "USB",
            printerCategory: "PHYSICAL",
            isDefault: true,
            printerAvailable: true,
            status: "READY",
            capabilities: {
              supportedPaperSizes: ["A4", "Legal"],
              supportsColor: false,
              supportsDuplex: false
            }
          }
        ]
      }
    });
    const shopInfoAReconn = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}`);
    assert.strictEqual(shopInfoAReconn.data.printer.printerAvailable, true);
    console.log("  PASS: Each shop exposes only its own printer, preserves selection across multi-printer & disconnect/reconnect events.");

    // 5. Customer Uploads & Cross-Tenant GridFS Protection
    console.log("\n[5/8] Testing customer uploads and cross-tenant GridFS binding checks...");
    const inspectA = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders/inspect`,
      {
        body: buildMultipartPdfForm("alpha-notes.pdf", SAMPLE_PDF)
      }
    );
    assert.strictEqual(inspectA.status, 200);
    const uploadIdA = inspectA.data.document.uploadId;
    createdGridFsIds.push({ id: uploadIdA, tenantId: vendorA.id });

    // Customer on Shop A tries to request Colour on B&W-only printer -> must fail (400)
    const unsupportedColorRes = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders`,
      {
        body: {
          uploadId: uploadIdA,
          colorMode: "color",
          sides: "single",
          paperSize: "A4",
          copies: 1
        }
      }
    );
    assert.strictEqual(
      unsupportedColorRes.status,
      400,
      "Submitting colour job to B&W-only shop must be rejected"
    );

    // Attempt to use Shop A's staged uploadId to create an order in Shop B -> must fail (400)
    const crossShopUploadUse = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorB.shopSlug}/orders`,
      {
        body: {
          uploadId: uploadIdA,
          colorMode: "bw",
          sides: "single",
          paperSize: "A4",
          copies: 1
        }
      }
    );
    assert.strictEqual(
      crossShopUploadUse.status,
      400,
      "Shop B must not be able to bind a GridFS file staged for Shop A"
    );

    // Create valid order in Shop A
    const createOrderA = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders`,
      {
        body: {
          uploadId: uploadIdA,
          colorMode: "bw",
          sides: "single",
          paperSize: "A4",
          copies: 2
        }
      }
    );
    assert.strictEqual(createOrderA.status, 201);
    const orderA = createOrderA.data.order;
    createdOrderIds.push(orderA.id);

    // Upload & create valid colour duplex order in Shop B
    const inspectB = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorB.shopSlug}/orders/inspect`,
      {
        body: buildMultipartPdfForm("beta-brochure.pdf", SAMPLE_PDF)
      }
    );
    assert.strictEqual(inspectB.status, 200);
    const uploadIdB = inspectB.data.document.uploadId;
    createdGridFsIds.push({ id: uploadIdB, tenantId: vendorB.id });

    const createOrderB = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorB.shopSlug}/orders`,
      {
        body: {
          uploadId: uploadIdB,
          colorMode: "color",
          sides: "duplex",
          paperSize: "A4",
          copies: 1
        }
      }
    );
    assert.strictEqual(createOrderB.status, 201);
    const orderB = createOrderB.data.order;
    createdOrderIds.push(orderB.id);
    console.log(`  PASS: Created Order A (${orderA.token}) & Order B (${orderB.token}) with strict GridFS isolation.`);

    // 6. Prove Vendor A Cannot Access Vendor B's Orders, Files, Cancel, Reprint, or Super Admin
    console.log("\n[6/8] Proving Vendor A cannot access Vendor B's data or Super Admin routes...");
    const vendorAOrders = await apiRequest(baseUrl, "GET", "/vendor/orders", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(vendorAOrders.status, 200);
    const aOrderIds = vendorAOrders.data.orders.map((o) => String(o._id));
    assert.ok(aOrderIds.includes(String(orderA.id)), "Vendor A must see Order A");
    assert.ok(!aOrderIds.includes(String(orderB.id)), "Vendor A must NEVER see Order B");

    // Vendor A attempts to download Vendor B's GridFS file
    const crossFileDownload = await apiRequest(
      baseUrl,
      "GET",
      `/vendor/orders/${orderB.id}/file`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(crossFileDownload.status, 404, "Vendor A must get 404 for Vendor B's file");

    // Vendor A attempts to cancel Vendor B's order
    const crossCancel = await apiRequest(
      baseUrl,
      "POST",
      `/vendor/orders/${orderB.token}/cancel`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(crossCancel.status, 404, "Vendor A must get 404 when cancelling Vendor B's order");

    // Vendor A attempts to reprint Vendor B's order
    const crossReprint = await apiRequest(
      baseUrl,
      "POST",
      `/vendor/orders/${orderB.token}/reprint`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(crossReprint.status, 404, "Vendor A must get 404 when reprinting Vendor B's order");

    // Customer on Shop A attempts to track Order B's token
    const crossCustomerTrack = await apiRequest(
      baseUrl,
      "GET",
      `/shops/${vendorA.shopSlug}/orders/${orderB.token}`
    );
    assert.strictEqual(crossCustomerTrack.status, 404, "Shop A customer endpoint must not leak Shop B order");

    // Vendor A attempts to access Super Admin overview
    const crossSuperAdmin = await apiRequest(baseUrl, "GET", "/super-admin/overview", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(crossSuperAdmin.status, 403, "Vendor A must be denied Super Admin access (403)");
    console.log("  PASS: All cross-vendor admin and customer access attempts blocked.");

    // 7. Prove Agent Isolation: Agent B Only Receives Shop B Jobs, Never Shop A Jobs
    console.log("\n[7/8] Proving Agent B only claims Shop B jobs and cannot access Shop A jobs...");
    const claimB1 = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: {
        "x-agent-id": credsB.agentId,
        "x-agent-secret": credsB.agentSecret
      }
    });
    assert.strictEqual(claimB1.status, 200);
    assert.ok(claimB1.data.job, "Agent B should claim Order B");
    assert.strictEqual(
      String(claimB1.data.job.orderId),
      String(orderB.id),
      "Agent B must claim ONLY Order B"
    );

    // Agent B polls again while Order A is still QUEUED -> must get null!
    const claimB2 = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: {
        "x-agent-id": credsB.agentId,
        "x-agent-secret": credsB.agentSecret
      }
    });
    assert.strictEqual(claimB2.status, 200);
    assert.strictEqual(
      claimB2.data.job,
      null,
      "Agent B must NOT claim Vendor A's queued job"
    );

    // Agent B attempts to download Order A's file directly
    const crossAgentDownload = await apiRequest(
      baseUrl,
      "GET",
      `/agent/jobs/${orderA.id}/file`,
      {
        headers: {
          "x-agent-id": credsB.agentId,
          "x-agent-secret": credsB.agentSecret
        }
      }
    );
    assert.strictEqual(crossAgentDownload.status, 404, "Agent B must be blocked from downloading Order A's file");

    // Agent A claims Order A, downloads file, verifies SHA-256, and completes job
    const claimA1 = await apiRequest(baseUrl, "GET", "/agent/jobs/next", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      }
    });
    assert.strictEqual(claimA1.status, 200);
    assert.strictEqual(String(claimA1.data.job.orderId), String(orderA.id));

    const downloadA = await apiRequest(
      baseUrl,
      "GET",
      `/agent/jobs/${orderA.id}/file`,
      {
        headers: {
          "x-agent-id": credsA.agentId,
          "x-agent-secret": credsA.agentSecret,
          "x-agent-job-id": claimA1.data.job.agentJobId
        },
        rawBuffer: true
      }
    );
    assert.strictEqual(downloadA.status, 200);
    const downloadedSha = crypto.createHash("sha256").update(downloadA.buffer).digest("hex");
    assert.strictEqual(downloadedSha, claimA1.data.job.fileSha256, "Downloaded GridFS SHA-256 must match");

    for (const st of ["PROCESSING", "PRINTING", "COMPLETED"]) {
      const stRes = await apiRequest(baseUrl, "PATCH", `/agent/jobs/${orderA.id}/status`, {
        headers: {
          "x-agent-id": credsA.agentId,
          "x-agent-secret": credsA.agentSecret
        },
        body: {
          status: st,
          agentJobId: claimA1.data.job.agentJobId,
          spoolerJobId: st === "COMPLETED" ? 42 : undefined
        }
      });
      assert.strictEqual(stRes.status, 200);
    }
    console.log("  PASS: Agent job claiming, GridFS stream verification, and status lifecycle verified.");

    // 8. Multi-Vendor Dynamic Pricing Isolation & Immutable Order Price Snapshot
    console.log("\n[8/10] Testing Multi-Vendor Dynamic Pricing Isolation & Order Snapshot Immutability...");
    const setPriceA = await apiRequest(baseUrl, "PUT", "/vendor/pricing", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        bwSingleRate: 3,
        colorSingleRate: 5,
        bwDuplexRate: 4,
        colorDuplexRate: 8
      }
    });
    assert.strictEqual(setPriceA.status, 200);
    assert.strictEqual(setPriceA.data.pricing.bwSingleRate, 3);
    assert.strictEqual(setPriceA.data.pricing.colorSingleRate, 5);

    const setPriceB = await apiRequest(baseUrl, "PUT", "/vendor/pricing", {
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        bwSingleRate: 2,
        colorSingleRate: 7,
        bwDuplexRate: 3,
        colorDuplexRate: 10
      }
    });
    assert.strictEqual(setPriceB.status, 200);
    assert.strictEqual(setPriceB.data.pricing.colorSingleRate, 7);

    // Negative price must be rejected with 400
    const negPrice = await apiRequest(baseUrl, "PUT", "/vendor/pricing", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { bwSingleRate: -5 }
    });
    assert.strictEqual(negPrice.status, 400, "Negative price must be rejected");

    // Verify customer shop endpoints return each vendor's independent pricing
    const pubPriceA = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}`);
    const pubPriceB = await apiRequest(baseUrl, "GET", `/shops/${vendorB.shopSlug}`);
    assert.strictEqual(pubPriceA.data.shop.pricing.colorSingleRate, 5);
    assert.strictEqual(pubPriceB.data.shop.pricing.colorSingleRate, 7);

    // Existing Order A price snapshot must remain unchanged even after Vendor A changed bwSingleRate to ₹3
    const orderACheck = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}/orders/${orderA.token}`);
    assert.strictEqual(orderACheck.status, 200);
    assert.strictEqual(
      orderACheck.data.order.pricingSnapshot.appliedSingleRate,
      2,
      "Historical order pricingSnapshot must remain immutable after vendor edits prices"
    );
    console.log("  PASS: Multi-vendor pricing isolation and historical order snapshot immutability verified.");

    // 9. Automatic Shop Availability & Server-Side Order Protection
    console.log("\n[9/10] Testing Shop Availability (Manual Pause, App Close /agent/offline, Multi-Vendor Isolation)...");
    const inspectA2 = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders/inspect`,
      { body: buildMultipartPdfForm("alpha-availability.pdf", SAMPLE_PDF) }
    );
    assert.strictEqual(inspectA2.status, 200);
    const uploadIdA2 = inspectA2.data.document.uploadId;
    createdGridFsIds.push({ id: uploadIdA2, tenantId: vendorA.id });

    // 9a. Vendor A manually pauses shop -> Shop A rejects orders (403), Shop B remains AVAILABLE
    const pauseA = await apiRequest(baseUrl, "PUT", "/vendor/availability", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { acceptingOrders: false }
    });
    assert.strictEqual(pauseA.status, 200);
    assert.strictEqual(pauseA.data.printer.shopAvailable, false);

    const rejectedPausedOrder = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders`,
      {
        body: { uploadId: uploadIdA2, colorMode: "bw", sides: "single", paperSize: "A4", copies: 1 }
      }
    );
    assert.strictEqual(rejectedPausedOrder.status, 403, "Paused shop must reject new orders with 403");

    const shopBStillOpen = await apiRequest(baseUrl, "GET", `/shops/${vendorB.shopSlug}`);
    assert.strictEqual(shopBStillOpen.data.printer.shopAvailable, true, "Shop B must stay available when Shop A pauses");

    // Re-open Shop A
    const reopenA = await apiRequest(baseUrl, "PUT", "/vendor/availability", {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { acceptingOrders: true }
    });
    assert.strictEqual(reopenA.status, 200);
    assert.strictEqual(reopenA.data.printer.shopAvailable, true);

    // 9b. Vendor A closes desktop app -> /agent/offline immediately marks Shop A UNAVAILABLE (503 on order)
    const offlineA = await apiRequest(baseUrl, "POST", "/agent/offline", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: { reason: "Vendor closed Smart Xerox desktop application." }
    });
    assert.strictEqual(offlineA.status, 200);

    const shopAOfflineInfo = await apiRequest(baseUrl, "GET", `/shops/${vendorA.shopSlug}`);
    assert.strictEqual(shopAOfflineInfo.data.printer.shopAvailable, false);

    const rejectedOfflineOrder = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorA.shopSlug}/orders`,
      {
        body: { uploadId: uploadIdA2, colorMode: "bw", sides: "single", paperSize: "A4", copies: 1 }
      }
    );
    assert.strictEqual(rejectedOfflineOrder.status, 503, "Offline shop must reject new orders with 503");
    console.log("  PASS: Server-side order protection blocks paused/offline shops while keeping other vendors unaffected.");

    // 10. 4-Digit Print Collection Code, Search, Reprint Preservation & Concurrent Idempotency Protection
    console.log("\n[10/11] Testing 4-Digit Print Collection Code, Search, Reprint & Concurrent Idempotency...");
    assert.ok(
      /^\d{4}$/.test(String(orderA.pickupCode || "")),
      `Order A must have a 4-digit numeric pickupCode, got ${orderA.pickupCode}`
    );
    assert.ok(
      /^\d{4}$/.test(String(orderB.pickupCode || "")),
      `Order B must have a 4-digit numeric pickupCode, got ${orderB.pickupCode}`
    );

    // Search by pickupCode for Vendor A returns Order A; Vendor B searching Vendor A's code NEVER sees Order A
    const searchA = await apiRequest(
      baseUrl,
      "GET",
      `/vendor/orders?search=${encodeURIComponent(orderA.pickupCode)}`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(searchA.status, 200);
    assert.ok(
      searchA.data.orders.some((o) => String(o._id) === String(orderA.id)),
      "Vendor A search by pickupCode must find Order A"
    );

    const crossSearchB = await apiRequest(
      baseUrl,
      "GET",
      `/vendor/orders?search=${encodeURIComponent(orderA.pickupCode)}`,
      { headers: { Authorization: `Bearer ${tokenB}` } }
    );
    assert.strictEqual(crossSearchB.status, 200);
    assert.ok(
      !crossSearchB.data.orders.some((o) => String(o._id) === String(orderA.id)),
      "Vendor B must NEVER retrieve Vendor A's order via pickupCode search"
    );

    // Reprinting Order A (which is COMPLETED) must retain Order A's original pickupCode
    const reprintARes = await apiRequest(
      baseUrl,
      "POST",
      `/vendor/orders/${orderA.token}/reprint`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(reprintARes.status, 201, "Reprinting completed Order A must succeed");
    assert.strictEqual(
      reprintARes.data.order.pickupCode,
      orderA.pickupCode,
      "Reprinted order must preserve the original order's 4-digit pickupCode"
    );
    createdOrderIds.push(reprintARes.data.order.id);

    // Concurrent idempotency test on Vendor B: fire 4 simultaneous requests with the EXACT same idempotencyKey
    const inspBIdem = await apiRequest(
      baseUrl,
      "POST",
      `/shops/${vendorB.shopSlug}/orders/inspect`,
      { body: buildMultipartPdfForm("idem-test.pdf", SAMPLE_PDF) }
    );
    assert.strictEqual(inspBIdem.status, 200);
    createdGridFsIds.push({ id: inspBIdem.data.document.uploadId, tenantId: vendorB.id });

    const sharedIdemKey = `concurrent-idem-${runSuffix}`;
    const concurrentIdemResults = await Promise.all(
      [1, 2, 3, 4].map(() =>
        apiRequest(baseUrl, "POST", `/shops/${vendorB.shopSlug}/orders`, {
          body: {
            uploadId: inspBIdem.data.document.uploadId,
            idempotencyKey: sharedIdemKey,
            pickupCode: "1111", // Customer-supplied code must be ignored
            colorMode: "bw",
            sides: "single",
            paperSize: "A4",
            copies: 3
          }
        })
      )
    );
    const createdOrDedupIds = new Set(
      concurrentIdemResults.map((r) => {
        assert.ok([200, 201].includes(r.status), `Expected 200 or 201, got ${r.status}`);
        return String(r.data.order.id);
      })
    );
    assert.strictEqual(
      createdOrDedupIds.size,
      1,
      "4 simultaneous requests with identical idempotencyKey must create ONLY 1 order"
    );
    const idemOrderId = [...createdOrDedupIds][0];
    createdOrderIds.push(idemOrderId);

    // Concurrent distinct orders in Vendor B must all receive distinct 4-digit pickupCodes
    const distinctUploadIds = [];
    for (let i = 0; i < 4; i++) {
      const insp = await apiRequest(
        baseUrl,
        "POST",
        `/shops/${vendorB.shopSlug}/orders/inspect`,
        { body: buildMultipartPdfForm(`conc-${i}.pdf`, SAMPLE_PDF) }
      );
      assert.strictEqual(insp.status, 200);
      distinctUploadIds.push(insp.data.document.uploadId);
      createdGridFsIds.push({ id: insp.data.document.uploadId, tenantId: vendorB.id });
    }
    const concurrentDistinctRes = await Promise.all(
      distinctUploadIds.map((uid, idx) =>
        apiRequest(baseUrl, "POST", `/shops/${vendorB.shopSlug}/orders`, {
          body: {
            uploadId: uid,
            idempotencyKey: `distinct-${runSuffix}-${idx}`,
            colorMode: "bw",
            sides: "single",
            paperSize: "A4",
            copies: idx + 4
          }
        })
      )
    );
    const distinctCodes = new Set();
    for (const r of concurrentDistinctRes) {
      assert.strictEqual(r.status, 201);
      assert.ok(/^\d{4}$/.test(String(r.data.order.pickupCode)));
      distinctCodes.add(r.data.order.pickupCode);
      createdOrderIds.push(r.data.order.id);
    }
    assert.strictEqual(
      distinctCodes.size,
      4,
      "4 simultaneous distinct orders in the same shop must receive 4 unique pickup codes"
    );
    console.log("  PASS: 4-digit pickup codes, search, cross-tenant isolation, reprint preservation & concurrent idempotency verified.");

    // 11. Agent Revocation & Audit Log Verification
    console.log("\n[11/11] Testing Agent Revocation & Audit Logging...");
    const revokeRes = await apiRequest(
      baseUrl,
      "POST",
      `/vendor/agents/${credsA.agentId}/revoke`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );
    assert.strictEqual(revokeRes.status, 200);

    const revokedHb = await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": credsA.agentId,
        "x-agent-secret": credsA.agentSecret
      },
      body: { deviceId: credsA.deviceId, printerName: "HP LaserJet Alpha Mono" }
    });
    assert.strictEqual(revokedHb.status, 401, "Revoked agent credentials must be immediately rejected (401)");

    const auditRes = await apiRequest(baseUrl, "GET", "/super-admin/audit-logs?limit=20", {
      headers: { Authorization: `Bearer ${superToken}` }
    });
    assert.strictEqual(auditRes.status, 200);
    assert.ok(auditRes.data.logs.length > 0, "Audit logs must be recorded");
    console.log("  PASS: Agent revocation enforced immediately and security events recorded in AuditLog.");

    console.log("\n====================================================================");
    console.log("STAGE 2 RESULT: ALL 10 MULTI-VENDOR PRICING, AVAILABILITY & ISOLATION TESTS PASSED!");
    console.log("====================================================================");
  } finally {
    // Clean up ONLY the temporary test documents created during this test run
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

runTests().catch((err) => {
  console.error("STAGE 2 TEST FAILURE:", err);
  process.exit(1);
});
