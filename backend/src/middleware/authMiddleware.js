const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Tenant = require("../models/Tenant");
const Agent = require("../models/Agent");
const { verifyAgentSecret } = require("../utils/agentCredentials");
const { recordAuditLog } = require("../utils/auditLogger");

/**
 * Verifies JWT Bearer token and attaches req.admin (plus req.tenant & req.tenantId for vendor accounts).
 * Never trusts tenantId supplied in request body, query, or headers.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(payload.sub).select("_id name email role tenantId active");
    if (!admin || !admin.active) {
      return res.status(401).json({ success: false, message: "Invalid or inactive account session" });
    }

    req.admin = admin;

    if (admin.tenantId) {
      const tenant = await Tenant.findById(admin.tenantId);
      if (!tenant) {
        return res.status(403).json({
          success: false,
          message: "Associated vendor shop tenant was not found"
        });
      }
      if (tenant.status !== "ACTIVE" && admin.role !== "SUPER_ADMIN") {
        return res.status(403).json({
          success: false,
          message: "Your vendor shop account is currently suspended. Please contact platform support."
        });
      }
      req.tenant = tenant;
      req.tenantId = tenant._id;
    }

    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired authentication token" });
  }
}

/**
 * Requires a platform-level SUPER_ADMIN session.
 */
async function requireSuperAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.admin || req.admin.role !== "SUPER_ADMIN") {
      await recordAuditLog({
        tenantId: req.tenantId || null,
        actorType: req.admin ? "VENDOR_ADMIN" : "SYSTEM",
        actorId: req.admin?._id,
        action: "UNAUTHORIZED_SUPER_ADMIN_ACCESS",
        req
      });
      return res.status(403).json({
        success: false,
        message: "Super Admin privileges required"
      });
    }
    next();
  });
}

/**
 * Requires an authenticated vendor session bound to an active Tenant.
 * Enforces strict tenant isolation from the authenticated Admin record.
 */
async function requireVendorAdmin(req, res, next) {
  await requireAuth(req, res, async () => {
    if (!req.tenant || !req.tenantId) {
      return res.status(403).json({
        success: false,
        message: "This account is not bound to a vendor shop tenant."
      });
    }
    next();
  });
}

/**
 * Backward-compatible alias for vendor/admin routes that must be tenant-scoped.
 */
const requireAdmin = requireVendorAdmin;

/**
 * Authenticates a paired desktop print agent using unique per-agent credentials:
 * - Headers: `x-agent-id` + `x-agent-secret`
 * - Or Header: `x-agent-token: <agentId>:<agentSecret>`
 * Shared global tokens are rejected.
 */
async function requireAgent(req, res, next) {
  try {
    let agentId = String(req.headers["x-agent-id"] || "").trim();
    let agentSecret = String(req.headers["x-agent-secret"] || "").trim();

    if ((!agentId || !agentSecret) && req.headers["x-agent-token"]) {
      const rawToken = String(req.headers["x-agent-token"]).trim();
      const sepIdx = rawToken.indexOf(":");
      if (sepIdx > 0) {
        agentId = rawToken.slice(0, sepIdx).trim();
        agentSecret = rawToken.slice(sepIdx + 1).trim();
      }
    }

    if (!agentId || !agentSecret) {
      return res.status(401).json({
        success: false,
        message: "Per-agent authentication credentials (x-agent-id and x-agent-secret) are required"
      });
    }

    const agent = await Agent.findOne({
      agentId,
      active: true,
      revokedAt: null
    }).select("+secretHash");

    if (!agent || !agent.secretHash || !verifyAgentSecret(agentSecret, agent.secretHash)) {
      await recordAuditLog({
        actorType: "AGENT",
        actorId: agentId,
        action: "AGENT_AUTH_FAILED",
        req
      });
      return res.status(401).json({
        success: false,
        message: "Invalid or revoked print agent credentials"
      });
    }

    if (!agent.tenantId) {
      return res.status(403).json({
        success: false,
        message: "Print agent is not paired with a valid vendor tenant"
      });
    }

    const tenant = await Tenant.findById(agent.tenantId);
    if (!tenant || tenant.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Vendor shop tenant is inactive or suspended"
      });
    }

    req.agent = agent;
    req.tenant = tenant;
    req.tenantId = tenant._id;
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Print agent authentication failed"
    });
  }
}

/**
 * Resolves the shop tenant strictly from the validated `:shopSlug` route parameter.
 * Never trusts tenantId from query/body/headers.
 */
async function resolveShopTenant(req, res, next) {
  try {
    const rawSlug = String(req.params.shopSlug || "").toLowerCase().trim();
    if (!rawSlug || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(rawSlug)) {
      return res.status(400).json({
        success: false,
        message: "Invalid shop link."
      });
    }

    const tenant = await Tenant.findOne({ shopSlug: rawSlug });
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: "Print shop not found. Please scan a valid Smart Xerox shop QR code."
      });
    }

    if (tenant.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "This print shop is currently closed or unavailable."
      });
    }

    req.tenant = tenant;
    req.tenantId = tenant._id;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  requireVendorAdmin,
  requireAdmin,
  requireAgent,
  resolveShopTenant
};
