const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Tenant = require("../models/Tenant");
const Agent = require("../models/Agent");
const Order = require("../models/Order");
const AuditLog = require("../models/AuditLog");
const {
  getActivePrinterState,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
} = require("./orderController");
const { openGridFSDownloadStream } = require("../services/gridfsService");
const {
  generateAgentCredentials,
  slugifyShopName,
  buildShopPublicUrl
} = require("../utils/agentCredentials");
const { recordAuditLog } = require("../utils/auditLogger");

function formatTenantSummary(tenant) {
  if (!tenant) return null;
  return {
    id: tenant._id,
    tenantId: tenant._id,
    shopName: tenant.shopName,
    shopSlug: tenant.shopSlug,
    logoUrl: tenant.logoUrl || null,
    phone: tenant.phone || null,
    address: tenant.address || null,
    status: tenant.status,
    publicUrl: buildShopPublicUrl(tenant.shopSlug),
    selectedPrinterName: tenant.selectedPrinterName || null,
    autoSelectSinglePrinter: tenant.autoSelectSinglePrinter !== false,
    capabilityOverrides: tenant.capabilityOverrides || {
      useManualOverride: false,
      supportedPaperSizes: ["A4", "Letter", "Legal", "A5"],
      supportsColor: false,
      supportsDuplex: false
    },
    config: {
      maxUploadMb: tenant.config?.maxUploadMb || 20,
      maxCopies: tenant.config?.maxCopies || 100,
      acceptingOrders: tenant.config?.acceptingOrders !== false
    },
    createdAt: tenant.createdAt
  };
}

async function computeTenantStats(tenantId) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [
    todaysJobs,
    completedJobs,
    failedJobs,
    pendingJobs,
    totalJobs
  ] = await Promise.all([
    Order.countDocuments({ tenantId, createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ tenantId, status: "COMPLETED" }),
    Order.countDocuments({ tenantId, status: "FAILED" }),
    Order.countDocuments({
      tenantId,
      status: { $in: ["QUEUED", "DOWNLOADING", "PROCESSING", "PRINTING"] }
    }),
    Order.countDocuments({ tenantId })
  ]);

  return {
    todaysJobs,
    completedJobs,
    failedJobs,
    pendingJobs,
    totalJobs
  };
}

/**
 * POST /api/vendor/login & POST /api/admin/login
 * Authenticates a vendor shopkeeper and returns tenant & session details.
 */
async function login(req, res) {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");

  const admin = await Admin.findOne({ email });
  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    await recordAuditLog({
      tenantId: admin?.tenantId || null,
      actorType: "VENDOR_ADMIN",
      actorId: email,
      action: "LOGIN_FAILED",
      req
    });
    return res.status(401).json({
      success: false,
      message: "Invalid vendor email or password"
    });
  }

  const allowedVendorRoles = ["VENDOR", "VENDOR_ADMIN", "OWNER", "SUPER_ADMIN"];
  if (!allowedVendorRoles.includes(admin.role)) {
    return res.status(403).json({
      success: false,
      message: "This account does not have Vendor access privileges."
    });
  }

  let tenant = null;
  if (admin.tenantId) {
    tenant = await Tenant.findById(admin.tenantId);
  }

  if (!tenant) {
    return res.status(403).json({
      success: false,
      message: "Vendor shop account is not linked to a valid shop tenant."
    });
  }

  if ((tenant.status !== "ACTIVE" || !admin.active) && admin.role !== "SUPER_ADMIN") {
    await recordAuditLog({
      tenantId: tenant._id,
      actorType: "VENDOR_ADMIN",
      actorId: admin._id,
      action: "SUSPENDED_VENDOR_LOGIN_BLOCKED",
      req
    });
    return res.status(403).json({
      success: false,
      message: "Your vendor shop account has been suspended by the platform administrator."
    });
  }

  admin.lastLoginAt = new Date();
  await admin.save();

  const token = jwt.sign(
    {
      sub: admin._id.toString(),
      role: admin.role,
      tenantId: tenant._id.toString()
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  await recordAuditLog({
    tenantId: tenant._id,
    actorType: admin.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "VENDOR_ADMIN",
    actorId: admin._id,
    action: "LOGIN_SUCCESS",
    req
  });

  const userSummary = {
    id: admin._id,
    name: admin.name || "Shop Owner",
    email: admin.email,
    role: admin.role,
    isVendor: true,
    tenantId: tenant._id
  };

  res.json({
    success: true,
    token,
    vendor: userSummary,
    admin: userSummary,
    tenant: formatTenantSummary(tenant)
  });
}

/**
 * POST /api/super-admin/login
 * Authenticates the Platform Super Admin strictly verifying role === "SUPER_ADMIN".
 */
async function superAdminLogin(req, res) {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");

  const admin = await Admin.findOne({ email });
  if (!admin || !admin.active || !(await bcrypt.compare(password, admin.passwordHash))) {
    await recordAuditLog({
      tenantId: admin?.tenantId || null,
      actorType: "SUPER_ADMIN",
      actorId: email,
      action: "SUPER_ADMIN_LOGIN_FAILED",
      req
    });
    return res.status(401).json({
      success: false,
      message: "Invalid Super Admin email or password"
    });
  }

  if (admin.role !== "SUPER_ADMIN") {
    await recordAuditLog({
      tenantId: admin.tenantId || null,
      actorType: "VENDOR_ADMIN",
      actorId: admin._id,
      action: "UNAUTHORIZED_SUPER_ADMIN_LOGIN_BLOCKED",
      req
    });
    return res.status(403).json({
      success: false,
      message: "Super Admin privileges required. Vendor accounts must sign in using the Smart Xerox Windows Desktop App."
    });
  }

  admin.lastLoginAt = new Date();
  await admin.save();

  const tenant = admin.tenantId ? await Tenant.findById(admin.tenantId) : null;

  const token = jwt.sign(
    {
      sub: admin._id.toString(),
      role: admin.role,
      tenantId: tenant ? tenant._id.toString() : null
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  await recordAuditLog({
    tenantId: tenant?._id || null,
    actorType: "SUPER_ADMIN",
    actorId: admin._id,
    action: "SUPER_ADMIN_LOGIN_SUCCESS",
    req
  });

  res.json({
    success: true,
    token,
    admin: {
      id: admin._id,
      name: admin.name || "Platform Super Admin",
      email: admin.email,
      role: admin.role,
      tenantId: tenant ? tenant._id : null
    },
    tenant: formatTenantSummary(tenant)
  });
}

/**
 * PUT /api/vendor/password
 * Allows an authenticated vendor to change their own password (e.g. after logging in with a temporary password).
 */
async function changeVendorPassword(req, res) {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  const confirmPassword =
    req.body.confirmPassword !== undefined ? String(req.body.confirmPassword || "") : newPassword;

  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Current password and a new password of at least 6 characters are required."
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      success: false,
      message: "New password and confirm password do not match."
    });
  }

  const adminDoc = await Admin.findById(req.admin._id);
  if (!adminDoc || !(await bcrypt.compare(currentPassword, adminDoc.passwordHash))) {
    return res.status(401).json({
      success: false,
      message: "Current password is incorrect."
    });
  }

  const isSameAsCurrent = await bcrypt.compare(newPassword, adminDoc.passwordHash);
  if (isSameAsCurrent) {
    return res.status(400).json({
      success: false,
      message: "New password must be different from your current password."
    });
  }

  adminDoc.passwordHash = await bcrypt.hash(newPassword, 12);
  adminDoc.passwordChangedAt = new Date();
  await adminDoc.save();

  const freshToken = jwt.sign(
    {
      sub: adminDoc._id.toString(),
      role: adminDoc.role,
      tenantId: req.tenantId ? req.tenantId.toString() : null
    },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "VENDOR_PASSWORD_CHANGED",
    targetType: "Admin",
    targetId: req.admin._id,
    req
  });

  res.json({
    success: true,
    message: "Your vendor password has been updated.",
    token: freshToken
  });
}

/**
 * GET /api/vendor/me & GET /api/admin/me & GET /api/vendor/dashboard
 * Returns authenticated vendor's profile, tenant info, live printer/agent status, and today's job counts.
 */
async function getAdminProfile(req, res) {
  const [printer, stats, agents] = await Promise.all([
    getActivePrinterState(req.tenantId),
    computeTenantStats(req.tenantId),
    Agent.find({ tenantId: req.tenantId, revokedAt: null })
      .sort({ lastSeenAt: -1 })
      .select("-secretHash")
      .lean()
  ]);

  res.json({
    success: true,
    admin: {
      id: req.admin._id,
      name: req.admin.name,
      email: req.admin.email,
      role: req.admin.role,
      tenantId: req.tenantId
    },
    tenant: formatTenantSummary(req.tenant),
    printer,
    stats,
    agents
  });
}

/**
 * POST /api/vendor/agents/pair
 * Pairs a Windows desktop installation with the signed-in vendor's tenant and issues a unique revocable agent credential.
 */
async function pairDesktopAgent(req, res) {
  const deviceId = String(req.body.deviceId || `win-desktop-${Date.now()}`).trim();
  const name = String(req.body.name || `${req.tenant.shopName} Desktop Host`).trim();
  const hostname = req.body.hostname ? String(req.body.hostname).trim() : null;
  const osVersion = req.body.osVersion ? String(req.body.osVersion).trim() : null;
  const agentVersion = String(req.body.agentVersion || "3.0.0").trim();

  const { agentId, agentSecret, secretHash } = generateAgentCredentials();

  // If this specific desktop installation was already paired to this tenant, rotate its credential cleanly
  let agent = await Agent.findOne({
    tenantId: req.tenantId,
    deviceId
  });

  if (agent) {
    agent.agentId = agentId;
    agent.secretHash = secretHash;
    agent.name = name;
    agent.hostname = hostname || agent.hostname;
    agent.osVersion = osVersion || agent.osVersion;
    agent.agentVersion = agentVersion;
    agent.pairedByAdminId = req.admin._id;
    agent.pairedAt = new Date();
    agent.revokedAt = null;
    agent.active = true;
    await agent.save();
  } else {
    agent = await Agent.create({
      tenantId: req.tenantId,
      agentId,
      secretHash,
      deviceId,
      name,
      hostname,
      osVersion,
      agentVersion,
      printerName: req.tenant.selectedPrinterName || "Detecting Windows Printers...",
      pairedByAdminId: req.admin._id,
      pairedAt: new Date(),
      revokedAt: null,
      active: true
    });
  }

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "AGENT_PAIRED",
    targetType: "Agent",
    targetId: agent.agentId,
    details: { deviceId, hostname, agentVersion },
    req
  });

  res.status(201).json({
    success: true,
    message: "Desktop print agent paired with your shop account.",
    credentials: {
      agentId,
      agentSecret,
      deviceId
    },
    agent: {
      id: agent._id,
      agentId: agent.agentId,
      deviceId: agent.deviceId,
      name: agent.name,
      hostname: agent.hostname,
      pairedAt: agent.pairedAt
    },
    tenant: formatTenantSummary(req.tenant)
  });
}

/**
 * GET /api/vendor/agents
 * Lists all paired desktop agents for the authenticated vendor.
 */
async function listVendorAgents(req, res) {
  const agents = await Agent.find({
    tenantId: req.tenantId,
    revokedAt: null
  })
    .sort({ lastSeenAt: -1, createdAt: -1 })
    .select("-secretHash")
    .lean();

  res.json({
    success: true,
    agents
  });
}

/**
 * POST /api/vendor/agents/:agentId/revoke
 * Revokes a paired desktop agent's credentials immediately.
 */
async function revokeVendorAgent(req, res) {
  const targetAgentId = String(req.params.agentId || "").trim();
  const query = { tenantId: req.tenantId };

  if (mongoose.Types.ObjectId.isValid(targetAgentId)) {
    query.$or = [{ _id: targetAgentId }, { agentId: targetAgentId }];
  } else {
    query.agentId = targetAgentId;
  }

  const agent = await Agent.findOneAndUpdate(
    query,
    {
      $set: {
        active: false,
        revokedAt: new Date(),
        secretHash: null,
        lastStatus: "OFFLINE"
      }
    },
    { new: true }
  );

  if (!agent) {
    return res.status(404).json({
      success: false,
      message: "Agent not found for your shop."
    });
  }

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "AGENT_REVOKED",
    targetType: "Agent",
    targetId: agent.agentId || agent._id,
    req
  });

  res.json({
    success: true,
    message: "Desktop print agent credential revoked."
  });
}

/**
 * GET /api/vendor/printers
 * Returns detected Windows printers, selected printer, and capability settings for the vendor.
 */
async function getVendorPrinters(req, res) {
  const printer = await getActivePrinterState(req.tenantId);
  res.json({
    success: true,
    selectedPrinterName: req.tenant.selectedPrinterName || printer.selectedPrinterName,
    autoSelectSinglePrinter: req.tenant.autoSelectSinglePrinter !== false,
    capabilityOverrides: req.tenant.capabilityOverrides,
    availablePrinters: printer.availablePrinters || [],
    printer
  });
}

/**
 * PUT /api/vendor/printers/select
 * Selects and remembers the vendor's preferred Windows printer.
 */
async function selectVendorPrinter(req, res) {
  const printerName = String(req.body.printerName || "").trim();
  const autoSelectSinglePrinter = req.body.autoSelectSinglePrinter;

  if (!printerName) {
    return res.status(400).json({
      success: false,
      message: "Please provide a printerName to select."
    });
  }

  req.tenant.selectedPrinterName = printerName;
  if (autoSelectSinglePrinter !== undefined) {
    req.tenant.autoSelectSinglePrinter = Boolean(autoSelectSinglePrinter);
  }
  await req.tenant.save();

  // Sync selected printer onto the active agent record if already reported in availablePrinters
  const agent = await Agent.findOne({
    tenantId: req.tenantId,
    active: true,
    revokedAt: null
  }).sort({ lastSeenAt: -1 });

  if (agent) {
    const matched = Array.isArray(agent.availablePrinters)
      ? agent.availablePrinters.find(
          (p) => p.name.toLowerCase() === printerName.toLowerCase()
        )
      : null;

    agent.printerName = matched ? matched.name : printerName;
    if (matched) {
      agent.portName = matched.portName;
      agent.driverName = matched.driverName;
      agent.driverMissing = Boolean(matched.driverMissing);
      agent.printerAvailable = Boolean(matched.printerAvailable);
      agent.lastStatus = matched.status || agent.lastStatus;
      agent.statusMessage = matched.statusMessage;
      agent.capabilities = matched.capabilities || agent.capabilities;
    }
    await agent.save();
  }

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "PRINTER_SELECTED",
    details: { selectedPrinterName: printerName },
    req
  });

  const printer = await getActivePrinterState(req.tenantId);
  res.json({
    success: true,
    message: `Selected printer updated to "${printerName}".`,
    tenant: formatTenantSummary(req.tenant),
    printer
  });
}

/**
 * PUT /api/vendor/printers/capabilities
 * Configures manual printer capability overrides when a Windows driver does not report capabilities reliably.
 */
async function updateVendorPrinterCapabilities(req, res) {
  const { useManualOverride, supportedPaperSizes, supportsColor, supportsDuplex } = req.body;
  const validSizes = ["A4", "A3", "Legal", "Letter", "A5", "B5", "Executive"];
  const filteredSizes = Array.isArray(supportedPaperSizes)
    ? supportedPaperSizes.filter((s) => validSizes.includes(s))
    : ["A4"];

  req.tenant.capabilityOverrides = {
    useManualOverride: Boolean(useManualOverride),
    supportedPaperSizes: filteredSizes.length > 0 ? filteredSizes : ["A4"],
    supportsColor: Boolean(supportsColor),
    supportsDuplex: Boolean(supportsDuplex)
  };
  await req.tenant.save();

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "PRINTER_CAPABILITIES_UPDATED",
    details: req.tenant.capabilityOverrides,
    req
  });

  const printer = await getActivePrinterState(req.tenantId);
  res.json({
    success: true,
    message: "Printer capabilities updated.",
    tenant: formatTenantSummary(req.tenant),
    printer
  });
}

/**
 * PUT /api/vendor/settings
 * Updates vendor shop profile and operational settings (never mutates shopSlug so QR codes never break).
 */
async function updateVendorSettings(req, res) {
  const { shopName, phone, address, logoUrl, maxCopies, maxUploadMb, acceptingOrders } = req.body;

  if (shopName && String(shopName).trim()) {
    req.tenant.shopName = String(shopName).trim().slice(0, 120);
  }
  if (phone !== undefined) {
    req.tenant.phone = phone ? String(phone).trim().slice(0, 40) : null;
  }
  if (address !== undefined) {
    req.tenant.address = address ? String(address).trim().slice(0, 240) : null;
  }
  if (logoUrl !== undefined) {
    req.tenant.logoUrl = logoUrl ? String(logoUrl).trim() : null;
  }

  if (!req.tenant.config) {
    req.tenant.config = { maxUploadMb: 20, maxCopies: 100, acceptingOrders: true };
  }
  if (maxCopies !== undefined) {
    const parsedCopies = Number(maxCopies);
    if (Number.isInteger(parsedCopies) && parsedCopies >= 1 && parsedCopies <= 1000) {
      req.tenant.config.maxCopies = parsedCopies;
    }
  }
  if (maxUploadMb !== undefined) {
    const parsedMb = Number(maxUploadMb);
    if (Number.isInteger(parsedMb) && parsedMb >= 1 && parsedMb <= 100) {
      req.tenant.config.maxUploadMb = parsedMb;
    }
  }
  if (acceptingOrders !== undefined) {
    req.tenant.config.acceptingOrders = Boolean(acceptingOrders);
  }

  await req.tenant.save();

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin._id,
    action: "VENDOR_SETTINGS_UPDATED",
    details: {
      shopName: req.tenant.shopName,
      config: req.tenant.config
    },
    req
  });

  res.json({
    success: true,
    message: "Shop settings saved.",
    tenant: formatTenantSummary(req.tenant)
  });
}

/**
 * GET /api/vendor/orders & GET /api/admin/orders
 * Lists print jobs strictly belonging to req.tenantId.
 */
async function listOrders(req, res) {
  const { status, search } = req.query;
  const filter = { tenantId: req.tenantId };

  if (status && status !== "ALL") {
    filter.status = status;
  }

  if (search && String(search).trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    filter.$or = [{ token: regex }, { originalName: regex }];
  }

  const [orders, printer, stats] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .select("-storedFileName"),
    getActivePrinterState(req.tenantId),
    computeTenantStats(req.tenantId)
  ]);

  res.json({
    success: true,
    orders,
    printer,
    stats,
    tenant: formatTenantSummary(req.tenant)
  });
}

/**
 * GET /api/vendor/orders/:id/file & GET /api/admin/orders/:id/file
 * Streams the uploaded document from MongoDB GridFS strictly verifying req.tenantId ownership.
 */
async function downloadAdminOrderFile(req, res) {
  const order = await Order.findOne({
    _id: req.params.id,
    tenantId: req.tenantId
  });

  if (!order) {
    await recordAuditLog({
      tenantId: req.tenantId,
      actorType: "VENDOR_ADMIN",
      actorId: req.admin._id,
      action: "CROSS_TENANT_OR_MISSING_FILE_DOWNLOAD_BLOCKED",
      targetType: "Order",
      targetId: req.params.id,
      req
    });
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  if (!order.gridFsFileId || order.fileDeleted) {
    return res.status(410).json({
      success: false,
      message: "Document file was already cleaned up from GridFS after printing."
    });
  }

  const { fileDoc, stream } = await openGridFSDownloadStream(order.gridFsFileId, req.tenantId);
  res.setHeader("Content-Type", order.mimeType || fileDoc.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileDoc.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(order.originalName || fileDoc.filename)}"`
  );
  stream.pipe(res);
}

/* ============================================================================
   SUPER ADMIN PLATFORM MANAGEMENT
   ============================================================================ */

async function generateUniqueShopSlug(desiredInput) {
  const base = slugifyShopName(desiredInput);
  const exists = await Tenant.exists({ shopSlug: base });
  if (!exists) return base;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await Tenant.exists({ shopSlug: candidate }))) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * GET /api/super-admin/overview
 * Returns platform-wide statistics, all vendors, connected agents, and printers.
 */
async function getSuperAdminOverview(_req, res) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [tenants, admins, agents, totalJobs, todaysJobs, completedJobs, failedJobs] =
    await Promise.all([
      Tenant.find().sort({ createdAt: -1 }).lean(),
      Admin.find().select("_id name email role tenantId active lastLoginAt createdAt").lean(),
      Agent.find({ revokedAt: null }).sort({ lastSeenAt: -1 }).select("-secretHash").lean(),
      Order.countDocuments(),
      Order.countDocuments({ createdAt: { $gte: startOfToday } }),
      Order.countDocuments({ status: "COMPLETED" }),
      Order.countDocuments({ status: "FAILED" })
    ]);

  const jobCountsByTenant = await Order.aggregate([
    {
      $group: {
        _id: "$tenantId",
        totalJobs: { $sum: 1 },
        completedJobs: {
          $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] }
        },
        pendingJobs: {
          $sum: {
            $cond: [
              { $in: ["$status", ["QUEUED", "DOWNLOADING", "PROCESSING", "PRINTING"]] },
              1,
              0
            ]
          }
        }
      }
    }
  ]);

  const countMap = new Map(
    jobCountsByTenant.map((item) => [String(item._id), item])
  );

  const heartbeatTimeoutMs = (Number(process.env.AGENT_HEARTBEAT_TIMEOUT_SECONDS) || 30) * 1000;
  const now = Date.now();

  const vendors = tenants.map((t) => {
    const tid = String(t._id);
    const vendorAdmins = admins.filter((a) => String(a.tenantId) === tid);
    const vendorAgents = agents.filter((ag) => String(ag.tenantId) === tid);
    const primaryAgent = vendorAgents[0] || null;
    const isAgentOnline = Boolean(
      primaryAgent?.lastSeenAt && now - new Date(primaryAgent.lastSeenAt).getTime() <= heartbeatTimeoutMs
    );
    const counts = countMap.get(tid) || { totalJobs: 0, completedJobs: 0, pendingJobs: 0 };

    return {
      ...formatTenantSummary(t),
      admins: vendorAdmins,
      agents: vendorAgents.map((ag) => ({
        ...ag,
        online: Boolean(
          ag.lastSeenAt && now - new Date(ag.lastSeenAt).getTime() <= heartbeatTimeoutMs
        )
      })),
      agentOnline: isAgentOnline,
      printerAvailable: Boolean(isAgentOnline && primaryAgent?.printerAvailable),
      activePrinterName: t.selectedPrinterName || primaryAgent?.printerName || null,
      stats: counts
    };
  });

  const onlineAgentsCount = agents.filter(
    (ag) => ag.lastSeenAt && now - new Date(ag.lastSeenAt).getTime() <= heartbeatTimeoutMs
  ).length;

  res.json({
    success: true,
    platformStats: {
      totalVendors: tenants.length,
      activeVendors: tenants.filter((t) => t.status === "ACTIVE").length,
      suspendedVendors: tenants.filter((t) => t.status === "SUSPENDED").length,
      totalPairedAgents: agents.length,
      onlineAgents: onlineAgentsCount,
      totalJobs,
      todaysJobs,
      completedJobs,
      failedJobs
    },
    vendors
  });
}

/**
 * POST /api/super-admin/vendors
 * Creates a new independent vendor shop tenant and its vendor admin login account.
 */
async function createVendor(req, res) {
  const shopName = String(req.body.shopName || "").trim();
  const explicitRawSlug = String(req.body.shopSlug || "").trim();
  const ownerName = String(req.body.ownerName || req.body.name || shopName).trim();
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const address = req.body.address ? String(req.body.address).trim() : null;
  const maxCopies = Number(req.body.maxCopies) || 100;

  if (!shopName || !email || !password || password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "shopName, email, and a password of at least 6 characters are required."
    });
  }

  const existingAdmin = await Admin.findOne({ email });
  if (existingAdmin) {
    return res.status(409).json({
      success: false,
      message: `An account with email ${email} already exists.`
    });
  }

  let shopSlug;
  if (explicitRawSlug) {
    shopSlug = slugifyShopName(explicitRawSlug);
    const existingSlugTenant = await Tenant.findOne({ shopSlug });
    if (existingSlugTenant) {
      return res.status(409).json({
        success: false,
        message: `A vendor shop with slug "${shopSlug}" already exists. Please enter a unique shop slug.`
      });
    }
  } else {
    shopSlug = await generateUniqueShopSlug(shopName);
  }
  const tenant = await Tenant.create({
    shopName,
    shopSlug,
    phone,
    address,
    status: "ACTIVE",
    config: {
      maxUploadMb: 20,
      maxCopies: Math.min(1000, Math.max(1, maxCopies)),
      acceptingOrders: true
    }
  });

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await Admin.create({
    name: ownerName,
    email,
    passwordHash,
    role: "VENDOR_ADMIN",
    tenantId: tenant._id,
    active: true
  });

  await recordAuditLog({
    tenantId: tenant._id,
    actorType: "SUPER_ADMIN",
    actorId: req.admin._id,
    action: "VENDOR_CREATED",
    targetType: "Tenant",
    targetId: tenant._id,
    details: { shopName, shopSlug, email },
    req
  });

  res.status(201).json({
    success: true,
    message: `Vendor "${shopName}" created with shop URL /shop/${shopSlug}`,
    vendor: {
      ...formatTenantSummary(tenant),
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role
      }
    }
  });
}

/**
 * PATCH /api/super-admin/vendors/:tenantId/status
 * Activates or suspends a vendor tenant.
 */
async function updateVendorStatus(req, res) {
  const { status } = req.body;
  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "status must be ACTIVE or SUSPENDED"
    });
  }

  const tenant = await Tenant.findByIdAndUpdate(
    req.params.tenantId,
    { $set: { status } },
    { new: true }
  );

  if (!tenant) {
    return res.status(404).json({ success: false, message: "Vendor tenant not found" });
  }

  await Admin.updateMany(
    { tenantId: tenant._id, role: { $ne: "SUPER_ADMIN" } },
    { $set: { active: status === "ACTIVE" } }
  );

  await recordAuditLog({
    tenantId: tenant._id,
    actorType: "SUPER_ADMIN",
    actorId: req.admin._id,
    action: "VENDOR_STATUS_CHANGED",
    targetType: "Tenant",
    targetId: tenant._id,
    details: { status },
    req
  });

  res.json({
    success: true,
    message: `Vendor "${tenant.shopName}" status set to ${status}.`,
    vendor: formatTenantSummary(tenant)
  });
}

/**
 * POST /api/super-admin/vendors/:tenantId/reset-password
 * Resets a vendor's password.
 */
async function resetVendorPassword(req, res) {
  const newPassword = String(req.body.newPassword || req.body.password || "");
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: "New password must be at least 6 characters."
    });
  }

  const tenant = await Tenant.findById(req.params.tenantId);
  if (!tenant) {
    return res.status(404).json({ success: false, message: "Vendor tenant not found" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const updated = await Admin.updateMany(
    { tenantId: tenant._id },
    { $set: { passwordHash, active: tenant.status === "ACTIVE" } }
  );

  await recordAuditLog({
    tenantId: tenant._id,
    actorType: "SUPER_ADMIN",
    actorId: req.admin._id,
    action: "VENDOR_PASSWORD_RESET",
    targetType: "Tenant",
    targetId: tenant._id,
    details: { updatedAccounts: updated.modifiedCount },
    req
  });

  res.json({
    success: true,
    message: `Password reset for vendor "${tenant.shopName}".`
  });
}

/**
 * GET /api/super-admin/audit-logs
 * Lists recent security and operational audit logs.
 */
async function listAuditLogs(req, res) {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const filter = {};
  if (req.query.tenantId && mongoose.Types.ObjectId.isValid(req.query.tenantId)) {
    filter.tenantId = req.query.tenantId;
  }

  const logs = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json({
    success: true,
    logs
  });
}

/**
 * Non-destructively bootstraps the initial Super Admin & default Shop Tenant,
 * and safely links any pre-existing single-shop records to the default Tenant.
 */
async function bootstrapOwner() {
  // Backfill shopSlug/slug & shopName/name on any pre-existing tenant records
  const existingTenants = await Tenant.find();
  for (const t of existingTenants) {
    let modified = false;
    const rawDoc = t.toObject();
    if (!t.tenantId) {
      t.tenantId = t._id.toString();
      modified = true;
    }
    if (!t.shopSlug) {
      t.shopSlug = rawDoc.slug || `shop-${t._id.toString().slice(-6)}`;
      modified = true;
    }
    if (!t.slug) {
      t.slug = t.shopSlug;
      modified = true;
    }
    if (!t.shopName) {
      t.shopName = rawDoc.name || "Smart Xerox Shop";
      modified = true;
    }
    if (!t.name) {
      t.name = t.shopName;
      modified = true;
    }
    if (modified) {
      await t.save();
    }
  }

  let defaultTenant = await Tenant.findOne().sort({ createdAt: 1 });
  if (!defaultTenant) {
    const defaultPrinter =
      process.env.PRINTER_NAME && process.env.PRINTER_NAME !== "Exact Windows printer name"
        ? process.env.PRINTER_NAME
        : null;

    defaultTenant = await Tenant.create({
      shopName: process.env.DEFAULT_SHOP_NAME || "Smart Xerox Main Shop",
      shopSlug: process.env.DEFAULT_SHOP_SLUG || "smart-xerox-main",
      status: "ACTIVE",
      selectedPrinterName: defaultPrinter,
      autoSelectSinglePrinter: true
    });
    console.log(`Initial shop tenant created: ${defaultTenant.shopName} (/shop/${defaultTenant.shopSlug})`);
  }

  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.toLowerCase().trim();
    let admin = await Admin.findOne({ email });
    if (!admin) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      admin = await Admin.create({
        name: "Platform Super Admin",
        email,
        passwordHash,
        role: "SUPER_ADMIN",
        tenantId: defaultTenant._id,
        active: true
      });
      console.log("Initial SUPER_ADMIN & Owner account created from environment variables");
    } else {
      let changed = false;
      if (!admin.tenantId) {
        admin.tenantId = defaultTenant._id;
        changed = true;
      }
      if (admin.role === "OWNER") {
        admin.role = "SUPER_ADMIN";
        changed = true;
      }
      if (changed) {
        await admin.save();
      }
    }
  }

  // Safely link any pre-existing single-shop Admin, Order, Agent, and GridFS records lacking tenantId
  await Admin.updateMany(
    { tenantId: null },
    { $set: { tenantId: defaultTenant._id } }
  );

  await Order.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId: defaultTenant._id, shopSlug: defaultTenant.shopSlug } }
  );
  await Order.updateMany(
    { tenantId: null },
    { $set: { tenantId: defaultTenant._id, shopSlug: defaultTenant.shopSlug } }
  );

  await Agent.updateMany(
    { tenantId: null },
    { $set: { tenantId: defaultTenant._id } }
  );

  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    await mongoose.connection.db
      .collection("printDocuments.files")
      .updateMany(
        { "metadata.tenantId": { $exists: false } },
        {
          $set: {
            "metadata.tenantId": String(defaultTenant._id),
            "metadata.shopSlug": defaultTenant.shopSlug
          }
        }
      );
  }
}

module.exports = {
  login,
  superAdminLogin,
  changeVendorPassword,
  getAdminProfile,
  pairDesktopAgent,
  listVendorAgents,
  revokeVendorAgent,
  getVendorPrinters,
  selectVendorPrinter,
  updateVendorPrinterCapabilities,
  updateVendorSettings,
  listOrders,
  downloadAdminOrderFile,
  cancelOrder,
  reprintOrder,
  clearFailedOrders,
  getSuperAdminOverview,
  createVendor,
  updateVendorStatus,
  resetVendorPassword,
  listAuditLogs,
  bootstrapOwner
};
