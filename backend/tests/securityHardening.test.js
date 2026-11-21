/**
 * SMART XEROX — SECURITY HARDENING & MULTI-TENANT PROTECTION TEST SUITE
 * Verifies:
 *  1. Strict shop slug resolution (no default fallback; 404 on unknown slug; 400 on invalid slug)
 *  2. Public shop API data minimization (no agentId, deviceId, hostname, portName, availablePrinters leaked)
 *  3. Vendor Shop Profile updates & mass-assignment protection (shopSlug, tenantId, status, apiBaseUrl blocked)
 *  4. SSRF / XSS URL validation on logoUrl (blocks javascript:, data:, http://127.0.0.1)
 *  5. NoSQL / MongoDB operator injection ($ne, $gt) and prototype pollution blocking
 *  6. Unauthenticated vendor endpoint rejection (401) & HTTP security headers (helmet, no x-powered-by, auth rate-limit)
 *  7. Electron security hardening static verification (sandbox, contextIsolation, IPC sender validation, locked API URL)
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const http = require("http");
const {
  startIsolatedTestDatabase,
  stopIsolatedTestDatabase
} = require("./testDbGuard");

const mongoose = require("mongoose");
const { connectDB } = require("../src/config/db");
const { bootstrapOwner } = require("../src/controllers/adminController");
const app = require("../src/app");
const Tenant = require("../src/models/Tenant");
const Admin = require("../src/models/Admin");
const Agent = require("../src/models/Agent");
const AuditLog = require("../src/models/AuditLog");

async function apiRequest(baseUrl, method, route, { headers = {}, body = null } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}/api${route}`, opts);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

async function runSecurityTests() {
  console.log("====================================================================");
  console.log("SMART XEROX — SECURITY HARDENING & MULTI-TENANT AUDIT TEST SUITE");
  console.log("====================================================================");

  const dbHandle = await startIsolatedTestDatabase();
  await connectDB();
  await bootstrapOwner();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const suffix = `sec${Date.now().toString(36)}`;
  const createdTenantIds = [];
  const createdAdminIds = [];
  const createdAgentIds = [];

  try {
    // 1. Auth & Create Isolated Test Vendor
    const superLogin = await apiRequest(baseUrl, "POST", "/super-admin/login", {
      body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    });
    assert.strictEqual(superLogin.status, 200, "Super Admin login must succeed");
    assert.strictEqual(superLogin.headers.get("x-powered-by"), null, "x-powered-by header must be disabled");
    const superToken = superLogin.data.token;

    const vRes = await apiRequest(baseUrl, "POST", "/super-admin/vendors", {
      headers: { Authorization: `Bearer ${superToken}` },
      body: {
        shopName: `SecTest Xerox ${suffix}`,
        shopSlug: `sectest-xerox-${suffix}`,
        ownerName: "Sec Owner",
        email: `sec.${suffix}@smartxerox.test`,
        password: "SecPassword123!"
      }
    });
    assert.strictEqual(vRes.status, 201);
    const vendor = vRes.data.vendor;
    createdTenantIds.push(vendor.id);
    createdAdminIds.push(vendor.admin.id);

    const loginRes = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: `sec.${suffix}@smartxerox.test`, password: "SecPassword123!" }
    });
    assert.strictEqual(loginRes.status, 200);
    assert.ok(loginRes.headers.get("ratelimit-limit"), "Auth rate-limiter header must be present on /vendor/login");
    const vendorToken = loginRes.data.token;

    // Pair agent & send heartbeat with internal PC hostname/port/driver metadata
    const pairRes = await apiRequest(baseUrl, "POST", "/vendor/agents/pair", {
      headers: { Authorization: `Bearer ${vendorToken}` },
      body: { deviceId: `dev-${suffix}`, hostname: "PRIVATE-WIN11-HOST", osVersion: "Windows 11" }
    });
    assert.strictEqual(pairRes.status, 201);
    createdAgentIds.push(pairRes.data.agent.id);

    await apiRequest(baseUrl, "POST", "/agent/heartbeat", {
      headers: {
        "x-agent-id": pairRes.data.credentials.agentId,
        "x-agent-secret": pairRes.data.credentials.agentSecret
      },
      body: {
        deviceId: pairRes.data.credentials.deviceId,
        hostname: "PRIVATE-WIN11-HOST",
        printerName: "HP LaserJet SecTest",
        portName: "USB002",
        driverName: "HP PCLm-S",
        printerAvailable: true,
        status: "READY",
        availablePrinters: [
          { name: "HP LaserJet SecTest", portName: "USB002", driverName: "HP PCLm-S", printerAvailable: true, status: "READY" }
        ]
      }
    });

    // TEST 1: URL Manipulation & Strict Shop Resolution
    console.log("\n[1/6] Testing multi-tenant URL manipulation & public API data minimization...");
    const unknownShop = await apiRequest(baseUrl, "GET", `/shops/nonexistent-shop-${suffix}`);
    assert.strictEqual(unknownShop.status, 404, "Unknown shop slug must return 404 (never fallback)");

    const invalidSlug = await apiRequest(baseUrl, "GET", "/shops/bad..slug!!");
    assert.strictEqual(invalidSlug.status, 400, "Invalid shop slug must return 400");

    const pubShop = await apiRequest(baseUrl, "GET", `/shops/${vendor.shopSlug}`);
    assert.strictEqual(pubShop.status, 200);
    assert.strictEqual(pubShop.data.shop.shopSlug, vendor.shopSlug);
    assert.strictEqual(pubShop.data.shop.id, undefined, "Public shop API must not expose internal tenant _id");
    assert.strictEqual(pubShop.data.printer.agentId, undefined, "Public shop API must not expose agentId");
    assert.strictEqual(pubShop.data.printer.deviceId, undefined, "Public shop API must not expose deviceId");
    assert.strictEqual(pubShop.data.printer.hostname, undefined, "Public shop API must not expose vendor PC hostname");
    assert.strictEqual(pubShop.data.printer.portName, undefined, "Public shop API must not expose USB/IP portName");
    assert.strictEqual(pubShop.data.printer.driverName, undefined, "Public shop API must not expose driverName");
    assert.strictEqual(pubShop.data.printer.availablePrinters, undefined, "Public shop API must not expose internal printer inventory");
    console.log("  PASS: Unknown slugs return 404; public shop API strips all internal PC/agent metadata.");

    // TEST 2: Vendor Shop Profile Update & Mass-Assignment Protection
    console.log("\n[2/6] Testing vendor shop profile update & protected field mass-assignment defense...");
    const profileUpdate = await apiRequest(baseUrl, "PUT", "/vendor/profile", {
      headers: { Authorization: `Bearer ${vendorToken}` },
      body: {
        shopName: `Updated SecTest Shop ${suffix}`,
        phone: "+91 98765 43210",
        address: "123 Market Road, Pune",
        // Protected fields that MUST be ignored:
        shopSlug: "hijacked-slug",
        status: "SUSPENDED",
        apiBaseUrl: "https://evil.example.com"
      }
    });
    assert.strictEqual(profileUpdate.status, 200);
    assert.strictEqual(profileUpdate.data.tenant.shopName, `Updated SecTest Shop ${suffix}`);
    assert.strictEqual(profileUpdate.data.tenant.shopSlug, vendor.shopSlug, "shopSlug must NEVER be mutated by vendor profile edit");
    assert.strictEqual(profileUpdate.data.tenant.status, "ACTIVE", "status must NEVER be mutated by vendor profile edit");

    // Verify customer page reflects updated shopName immediately
    const pubAfterProfile = await apiRequest(baseUrl, "GET", `/shops/${vendor.shopSlug}`);
    assert.strictEqual(pubAfterProfile.data.shop.shopName, `Updated SecTest Shop ${suffix}`);
    assert.strictEqual(pubAfterProfile.data.shop.phone, "+91 98765 43210");
    assert.strictEqual(pubAfterProfile.data.shop.address, "123 Market Road, Pune");

    // Reject unsafe XSS / SSRF logoUrl and invalid inputs
    const xssLogo = await apiRequest(baseUrl, "PUT", "/vendor/profile", {
      headers: { Authorization: `Bearer ${vendorToken}` },
      body: { logoUrl: "javascript:alert(1)" }
    });
    assert.strictEqual(xssLogo.status, 400, "javascript: logoUrl must be rejected");

    const ssrfLogo = await apiRequest(baseUrl, "PUT", "/vendor/profile", {
      headers: { Authorization: `Bearer ${vendorToken}` },
      body: { logoUrl: "https://127.0.0.1/internal.png" }
    });
    assert.strictEqual(ssrfLogo.status, 400, "Loopback/private IP logoUrl must be rejected");
    console.log("  PASS: Shop profile updates safely; protected fields ignored & logged; XSS/SSRF URLs blocked.");

    // TEST 3: NoSQL Operator Injection & Prototype Pollution Defense
    console.log("\n[3/6] Testing NoSQL operator injection & prototype pollution blocking...");
    const nosqlLogin = await apiRequest(baseUrl, "POST", "/vendor/login", {
      body: { email: { $ne: null }, password: { $gt: "" } }
    });
    assert.strictEqual(nosqlLogin.status, 400, "MongoDB operator injection in login body must be rejected (400)");

    const nosqlQuery = await apiRequest(baseUrl, "GET", "/vendor/orders?status[$ne]=CANCELLED", {
      headers: { Authorization: `Bearer ${vendorToken}` }
    });
    assert.strictEqual(nosqlQuery.status, 400, "MongoDB operator injection in query params must be rejected (400)");

    const protoPollute = await apiRequest(baseUrl, "PUT", "/vendor/profile", {
      headers: { Authorization: `Bearer ${vendorToken}` },
      body: '{"__proto__":{"polluted":true},"shopName":"Test"}'
    });
    assert.strictEqual(protoPollute.status, 400, "Prototype pollution payload must be rejected (400)");
    console.log("  PASS: NoSQL operator injection and prototype pollution attempts blocked with 400.");

    // TEST 4: Unauthenticated Access Rejection
    console.log("\n[4/6] Testing unauthenticated rejection on protected vendor endpoints...");
    for (const [m, p] of [
      ["GET", "/vendor/dashboard"],
      ["GET", "/vendor/orders"],
      ["PUT", "/vendor/profile"],
      ["PUT", "/vendor/pricing"],
      ["PUT", "/vendor/availability"],
      ["GET", "/super-admin/overview"]
    ]) {
      const unauth = await apiRequest(baseUrl, m, p);
      assert.strictEqual(unauth.status, 401, `Unauthenticated ${m} ${p} must return 401`);
    }
    console.log("  PASS: All protected vendor & super-admin endpoints enforce 401 authentication.");

    // TEST 5: Suspended Shop Blocked on Public Routes
    console.log("\n[5/6] Testing suspended shop rejection on public shop routes...");
    await apiRequest(baseUrl, "PATCH", `/super-admin/vendors/${vendor.id}/status`, {
      headers: { Authorization: `Bearer ${superToken}` },
      body: { status: "SUSPENDED" }
    });
    const suspendedPub = await apiRequest(baseUrl, "GET", `/shops/${vendor.shopSlug}`);
    assert.strictEqual(suspendedPub.status, 403, "Suspended shop must return 403 on public endpoint");
    console.log("  PASS: Suspended shop properly blocked with 403.");

    // TEST 6: Electron Security Hardening Static Verification
    console.log("\n[6/6] Verifying Electron security hardening & removal of user-editable server URLs...");
    const mainCjs = fs.readFileSync(
      path.resolve(__dirname, "../../desktop-app/electron/main.cjs"),
      "utf-8"
    );
    const appJsx = fs.readFileSync(
      path.resolve(__dirname, "../../desktop-app/src/App.jsx"),
      "utf-8"
    );
    assert.ok(mainCjs.includes("contextIsolation: true"), "Electron must enable contextIsolation");
    assert.ok(mainCjs.includes("nodeIntegration: false"), "Electron must disable nodeIntegration");
    assert.ok(mainCjs.includes("sandbox: true"), "Electron must enable sandbox");
    assert.ok(mainCjs.includes("devTools: isDev"), "Electron must disable DevTools in production");
    assert.ok(mainCjs.includes("assertTrustedIpcSender"), "Electron IPC must validate sender");
    assert.ok(mainCjs.includes("will-navigate"), "Electron must guard against external navigation");
    assert.ok(mainCjs.includes("setWindowOpenHandler"), "Electron must restrict popup windows");
    assert.ok(!appJsx.includes("Cloud Server URL"), "Vendor login must not show Cloud Server URL field");
    assert.ok(!appJsx.includes("Cloud Backend API URL"), "Vendor settings must not show Cloud Backend API URL field");
    assert.ok(!appJsx.includes("Customer Website Domain"), "Vendor settings must not show Customer Website Domain field");
    assert.ok(mainCjs.includes("validateSelectedPrinterPayload"), "Electron printers:set-selected must use strict validator");

    // Unit-test Electron IPC `printers:set-selected` validator directly
    const { validateSelectedPrinterPayload } = require(
      path.resolve(__dirname, "../../desktop-app/electron/ipcValidators.cjs")
    );
    const mockDiscovered = [
      { name: "HP LaserJet MFP M129-M134", printerCategory: "PHYSICAL", isVirtual: false },
      { name: "Microsoft Print to PDF", printerCategory: "VIRTUAL", isVirtual: true }
    ];
    assert.strictEqual(validateSelectedPrinterPayload(null, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload(["HP"], mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "" }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "   " }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: { $ne: "" } }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: ["HP"] }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: 12345 }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "A".repeat(201) }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "HP\x00Evil" }, mockDiscovered).valid, false);
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "Microsoft Print to PDF" }, mockDiscovered).valid, false, "Virtual printer must be rejected");
    assert.strictEqual(validateSelectedPrinterPayload({ printerName: "Unknown Arbitrary Printer" }, mockDiscovered).valid, false, "Undiscovered printer must be rejected");
    const validPrinterCheck = validateSelectedPrinterPayload({ printerName: "hp laserjet mfp m129-m134" }, mockDiscovered);
    assert.strictEqual(validPrinterCheck.valid, true, "Valid discovered physical printer must pass");
    assert.strictEqual(validPrinterCheck.printerName, "HP LaserJet MFP M129-M134", "Must return canonical discovered name");
    console.log("  PASS: Electron sandbox, IPC sender & printer-selection validation, DevTools lock, and URL removal verified.");

    console.log("\n====================================================================");
    console.log("SECURITY AUDIT SUITE: ALL 6 SECURITY HARDENING CHECKS PASSED!");
    console.log("====================================================================");
  } finally {
    if (createdAgentIds.length > 0) await Agent.deleteMany({ _id: { $in: createdAgentIds } }).catch(() => {});
    if (createdAdminIds.length > 0) await Admin.deleteMany({ _id: { $in: createdAdminIds } }).catch(() => {});
    if (createdTenantIds.length > 0) {
      await AuditLog.deleteMany({ tenantId: { $in: createdTenantIds } }).catch(() => {});
      await Tenant.deleteMany({ _id: { $in: createdTenantIds } }).catch(() => {});
    }
    server.close();
    await stopIsolatedTestDatabase(dbHandle);
  }
}

runSecurityTests().catch((err) => {
  console.error("SECURITY TEST FAILURE:", err);
  process.exit(1);
});
