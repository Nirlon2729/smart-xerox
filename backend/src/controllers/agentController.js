const crypto = require("crypto");
const Order = require("../models/Order");
const Agent = require("../models/Agent");
const Tenant = require("../models/Tenant");
const { recordAuditLog } = require("../utils/auditLogger");
const { buildShopPublicUrl } = require("../utils/agentCredentials");
const {
  openGridFSDownloadStream,
  deleteGridFSFile,
  cleanupExpiredGridFSFiles
} = require("../services/gridfsService");

const LEASE_DURATION_MS = 3 * 60 * 1000; // 3 minutes per active download/processing lease
const VALID_PAPER_SIZES = ["A4", "A3", "Legal", "Letter", "A5", "B5", "Executive"];
const ALLOWED_STATUSES = ["READY", "ONLINE", "PRINTING", "OFFLINE", "ERROR"];
const ALLOWED_CONNECTION_TYPES = ["USB", "WIFI", "NETWORK", "SHARED", "LOCAL", "VIRTUAL", "UNKNOWN"];
const ALLOWED_PRINTER_CATEGORIES = ["PHYSICAL", "VIRTUAL", "UNKNOWN"];

/**
 * Recovers jobs that stalled during DOWNLOADING or PROCESSING (before reaching the physical printer spooler).
 * Never auto-requeues a job already in PRINTING state to avoid accidental duplicate physical prints.
 */
async function recoverExpiredLeases(tenantId = null) {
  const now = new Date();
  const baseFilter = {
    status: { $in: ["DOWNLOADING", "PROCESSING"] },
    leaseExpiresAt: { $ne: null, $lt: now }
  };
  if (tenantId) {
    baseFilter.tenantId = tenantId;
  }

  await Order.updateMany(
    {
      ...baseFilter,
      retryCount: { $lt: 2 }
    },
    {
      $set: {
        status: "QUEUED",
        agentJobId: null,
        leaseExpiresAt: null
      },
      $inc: { retryCount: 1 }
    }
  );

  await Order.updateMany(
    {
      ...baseFilter,
      retryCount: { $gte: 2 }
    },
    {
      $set: {
        status: "FAILED",
        failureReason: "Print agent connection timed out while preparing document."
      }
    }
  );
}

function sanitizeCapabilities(caps) {
  if (!caps || typeof caps !== "object") {
    return {
      supportedPaperSizes: ["A4"],
      paperSizesKnown: false,
      supportsBW: true,
      supportsColor: false,
      colorSupportKnown: false,
      supportsSingleSided: true,
      supportsDuplex: false,
      duplexSupportKnown: false,
      supportsCopies: true,
      maxCopies: 99,
      copiesSupportKnown: false,
      supportedOrientations: ["portrait", "landscape"],
      orientationSupportKnown: false,
      resolutionsDpi: []
    };
  }
  const reportedSizes = Array.isArray(caps.supportedPaperSizes)
    ? caps.supportedPaperSizes.filter((s) => VALID_PAPER_SIZES.includes(s))
    : ["A4"];

  const reportedOrientations = Array.isArray(caps.supportedOrientations)
    ? caps.supportedOrientations.filter((o) => ["portrait", "landscape"].includes(o))
    : ["portrait", "landscape"];

  return {
    supportedPaperSizes: reportedSizes.length > 0 ? reportedSizes : ["A4"],
    paperSizesKnown: caps.paperSizesKnown !== false,
    supportsBW: caps.supportsBW !== false,
    supportsColor: Boolean(caps.supportsColor),
    colorSupportKnown: caps.colorSupportKnown !== false,
    supportsSingleSided: caps.supportsSingleSided !== false,
    supportsDuplex: Boolean(caps.supportsDuplex),
    duplexSupportKnown: caps.duplexSupportKnown !== false,
    supportsCopies: caps.supportsCopies !== false,
    maxCopies: Number(caps.maxCopies) > 0 ? Number(caps.maxCopies) : 99,
    copiesSupportKnown: caps.copiesSupportKnown !== false,
    supportedOrientations:
      reportedOrientations.length > 0 ? reportedOrientations : ["portrait", "landscape"],
    orientationSupportKnown: caps.orientationSupportKnown !== false,
    resolutionsDpi: Array.isArray(caps.resolutionsDpi)
      ? caps.resolutionsDpi.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10)
      : []
  };
}

function sanitizeDetectedPrinter(p) {
  const normalizedStatus = ALLOWED_STATUSES.includes(p.status) ? p.status : "OFFLINE";
  const isReady =
    p.printerAvailable !== undefined
      ? Boolean(p.printerAvailable)
      : ["READY", "ONLINE", "PRINTING"].includes(normalizedStatus);

  return {
    name: String(p.name || p.printerName || "").trim(),
    manufacturer: p.manufacturer ? String(p.manufacturer).trim() : null,
    model: p.model ? String(p.model).trim() : null,
    portName: p.portName ? String(p.portName).trim() : null,
    driverName: p.driverName ? String(p.driverName).trim() : null,
    connectionType: ALLOWED_CONNECTION_TYPES.includes(p.connectionType)
      ? p.connectionType
      : "USB",
    printerCategory: ALLOWED_PRINTER_CATEGORIES.includes(p.printerCategory)
      ? p.printerCategory
      : p.isVirtual
        ? "VIRTUAL"
        : "PHYSICAL",
    isVirtual: Boolean(p.isVirtual || p.printerCategory === "VIRTUAL"),
    isShared: Boolean(p.isShared || p.connectionType === "SHARED"),
    isDefault: Boolean(p.isDefault),
    printerAvailable: isReady,
    workOffline: Boolean(p.workOffline),
    driverMissing: Boolean(p.driverMissing),
    capabilitiesDetected: p.capabilitiesDetected !== false,
    status: normalizedStatus,
    statusMessage: p.statusMessage ? String(p.statusMessage).slice(0, 300) : null,
    spoolerJobCount: Number(p.spoolerJobCount) || 0,
    capabilities: sanitizeCapabilities(p.capabilities)
  };
}

/**
 * POST /api/agent/heartbeat
 * Receives live printer discovery, status, availability, and capabilities from the vendor's paired Windows agent.
 */
async function heartbeat(req, res) {
  const {
    deviceId,
    agentVersion,
    hostname,
    osVersion,
    printerName,
    portName,
    driverName,
    driverMissing,
    printerAvailable,
    status,
    statusMessage,
    spoolerJobCount,
    capabilities,
    availablePrinters
  } = req.body;

  const sanitizedPrinters = Array.isArray(availablePrinters)
    ? availablePrinters
        .map(sanitizeDetectedPrinter)
        .filter((p) => Boolean(p.name) && !p.isVirtual)
    : [];

  let selectedPrinterName = req.tenant.selectedPrinterName;
  const onlinePhysicalPrinters = sanitizedPrinters.filter((p) => p.printerAvailable);

  // Auto-select ONLY if no printer is selected yet and exactly one connected/online usable physical printer is detected
  if (
    !selectedPrinterName &&
    req.tenant.autoSelectSinglePrinter !== false &&
    onlinePhysicalPrinters.length === 1
  ) {
    selectedPrinterName = onlinePhysicalPrinters[0].name;
    await Tenant.updateOne(
      { _id: req.tenantId },
      { $set: { selectedPrinterName } }
    );
  }

  // Resolve primary reported printer (matching vendor's selectedPrinterName if present in availablePrinters)
  const matchedSelected =
    selectedPrinterName && sanitizedPrinters.length > 0
      ? sanitizedPrinters.find(
          (p) => p.name.toLowerCase() === selectedPrinterName.toLowerCase()
        )
      : null;

  // If vendor had a selectedPrinterName, but it is NOT in availablePrinters (e.g. USB disconnected)
  // and availablePrinters was explicitly reported, mark the selected printer as OFFLINE (disconnected).
  const isSelectedDisconnected = Boolean(
    selectedPrinterName &&
      Array.isArray(availablePrinters) &&
      !matchedSelected
  );

  const resolvedPrinterName =
    matchedSelected?.name ||
    selectedPrinterName ||
    String(printerName || req.agent.printerName || "No Printer Selected").trim();

  const normalizedStatus = matchedSelected
    ? matchedSelected.status
    : isSelectedDisconnected
      ? "OFFLINE"
      : ALLOWED_STATUSES.includes(status)
        ? status
        : "READY";

  const isPrinterReady = matchedSelected
    ? matchedSelected.printerAvailable
    : isSelectedDisconnected
      ? false
      : printerAvailable !== undefined
        ? Boolean(printerAvailable)
        : ["READY", "ONLINE", "PRINTING"].includes(normalizedStatus);

  const now = new Date();
  const updateFields = {
    printerName: resolvedPrinterName,
    agentVersion: String(agentVersion || "3.1.0").trim(),
    hostname: hostname ? String(hostname).trim() : req.agent.hostname,
    osVersion: osVersion ? String(osVersion).trim() : req.agent.osVersion,
    portName: matchedSelected ? matchedSelected.portName : portName ? String(portName).trim() : null,
    driverName: matchedSelected ? matchedSelected.driverName : driverName ? String(driverName).trim() : null,
    driverMissing: matchedSelected ? matchedSelected.driverMissing : Boolean(driverMissing),
    printerAvailable: isPrinterReady,
    lastSeenAt: now,
    lastStatus: normalizedStatus,
    statusMessage: matchedSelected
      ? matchedSelected.statusMessage
      : isSelectedDisconnected
        ? `${selectedPrinterName} is offline or disconnected from Windows.`
        : statusMessage
          ? String(statusMessage).slice(0, 300)
          : null,
    spoolerJobCount: matchedSelected
      ? matchedSelected.spoolerJobCount
      : Number(spoolerJobCount) || 0,
    capabilities: matchedSelected
      ? matchedSelected.capabilities
      : sanitizeCapabilities(capabilities),
    active: true
  };

  if (deviceId) {
    updateFields.deviceId = String(deviceId).trim();
  }
  if (sanitizedPrinters.length > 0 || Array.isArray(availablePrinters)) {
    updateFields.availablePrinters = sanitizedPrinters;
  }

  const updatedAgent = await Agent.findOneAndUpdate(
    { _id: req.agent._id, tenantId: req.tenantId },
    { $set: updateFields },
    { new: true }
  );

  recoverExpiredLeases(req.tenantId).catch(() => {});
  cleanupExpiredGridFSFiles(Order).catch(() => {});

  res.json({
    success: true,
    heartbeatAt: now.toISOString(),
    tenant: {
      tenantId: req.tenantId,
      shopName: req.tenant.shopName,
      shopSlug: req.tenant.shopSlug,
      publicUrl: buildShopPublicUrl(req.tenant.shopSlug),
      selectedPrinterName: selectedPrinterName || resolvedPrinterName
    },
    agent: {
      agentId: updatedAgent.agentId,
      deviceId: updatedAgent.deviceId,
      agentVersion: updatedAgent.agentVersion,
      printerName: updatedAgent.printerName,
      portName: updatedAgent.portName,
      printerAvailable: updatedAgent.printerAvailable,
      lastStatus: updatedAgent.lastStatus,
      availablePrintersCount: updatedAgent.availablePrinters?.length || 0
    }
  });
}

/**
 * GET /api/agent/jobs/next
 * Atomically claims the next QUEUED job strictly belonging to this agent's paired vendor tenantId.
 */
async function nextJob(req, res) {
  await recoverExpiredLeases(req.tenantId);

  const agentJobId = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);

  const job = await Order.findOneAndUpdate(
    {
      tenantId: req.tenantId,
      status: "QUEUED",
      fileDeleted: { $ne: true }
    },
    {
      $set: {
        status: "DOWNLOADING",
        agentJobId,
        claimedByAgentId: req.agent.agentId,
        leaseExpiresAt,
        failureReason: null
      }
    },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!job) {
    return res.json({ success: true, job: null });
  }

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "AGENT",
    actorId: req.agent.agentId,
    action: "JOB_CLAIMED",
    targetType: "Order",
    targetId: job._id,
    details: { token: job.token, agentJobId },
    req
  });

  const resolvedPrinter =
    req.tenant.selectedPrinterName ||
    job.targetPrinterName ||
    req.agent.printerName;

  res.json({
    success: true,
    job: {
      orderId: job._id,
      tenantId: job.tenantId,
      shopSlug: job.shopSlug,
      token: job.token,
      originalName: job.originalName,
      gridFsFileId: job.gridFsFileId,
      fileSha256: job.fileSha256,
      documentType: job.documentType || "pdf",
      mimeType: job.mimeType || "application/pdf",
      fileSize: job.fileSize,
      imageDimensions: job.imageDimensions || null,
      pageCount: job.pageCount,
      selectedPages: job.selectedPages,
      copies: job.copies,
      colorMode: job.colorMode,
      sides: job.sides,
      paperSize: job.paperSize || "A4",
      orientation: job.orientation || "auto",
      printerName: resolvedPrinter,
      agentJobId: job.agentJobId
    }
  });
}

/**
 * GET /api/agent/jobs/:id/file
 * Streams the private document from MongoDB Atlas GridFS to the authorized print agent,
 * enforcing exact tenantId ownership on both the Order and GridFS file document.
 */
async function downloadJobFile(req, res) {
  const job = await Order.findOne({
    _id: req.params.id,
    tenantId: req.tenantId
  });

  if (!job) {
    await recordAuditLog({
      tenantId: req.tenantId,
      actorType: "AGENT",
      actorId: req.agent.agentId,
      action: "CROSS_TENANT_OR_MISSING_FILE_DOWNLOAD_BLOCKED",
      targetType: "Order",
      targetId: req.params.id,
      req
    });
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  const providedAgentJobId = req.headers["x-agent-job-id"] || req.query.agentJobId;
  if (job.agentJobId && providedAgentJobId && job.agentJobId !== providedAgentJobId) {
    return res.status(409).json({
      success: false,
      message: "Agent job lease mismatch"
    });
  }

  if (job.claimedByAgentId && job.claimedByAgentId !== req.agent.agentId) {
    return res.status(403).json({
      success: false,
      message: "This print job is leased to another agent"
    });
  }

  if (!job.gridFsFileId || job.fileDeleted) {
    return res.status(410).json({
      success: false,
      message: "Document file is no longer available in GridFS"
    });
  }

  job.leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);
  await job.save();

  const { fileDoc, stream } = await openGridFSDownloadStream(job.gridFsFileId, req.tenantId);

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "AGENT",
    actorId: req.agent.agentId,
    action: "FILE_DOWNLOADED",
    targetType: "GridFSFile",
    targetId: job.gridFsFileId,
    details: { orderId: job._id, token: job.token },
    req
  });

  res.setHeader("Content-Type", job.mimeType || fileDoc.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileDoc.length));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(job.originalName || fileDoc.filename)}"`
  );
  if (job.fileSha256) {
    res.setHeader("X-File-Sha256", job.fileSha256);
  }

  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "GridFS stream error: " + err.message });
    } else {
      res.destroy(err);
    }
  });

  stream.pipe(res);
}

/**
 * PATCH /api/agent/jobs/:id/status
 * Updates job status through DOWNLOADING -> PROCESSING -> PRINTING -> COMPLETED / FAILED,
 * strictly enforcing tenantId and agentJobId ownership.
 */
async function updateJobStatus(req, res) {
  const { status, failureReason, agentJobId, spoolerJobId } = req.body;
  const allowed = ["DOWNLOADING", "PROCESSING", "PRINTING", "COMPLETED", "FAILED"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
  }

  const update = {
    status,
    failureReason: failureReason || null,
    leaseExpiresAt: ["DOWNLOADING", "PROCESSING", "PRINTING"].includes(status)
      ? new Date(Date.now() + LEASE_DURATION_MS)
      : null
  };

  if (spoolerJobId !== undefined && spoolerJobId !== null) {
    update.spoolerJobId = Number(spoolerJobId) || null;
  }

  if (status === "COMPLETED") {
    update.completedAt = new Date();
  }

  const query = {
    _id: req.params.id,
    tenantId: req.tenantId
  };
  if (agentJobId) {
    query.agentJobId = agentJobId;
  }

  const job = await Order.findOneAndUpdate(
    query,
    { $set: update },
    { new: true }
  );

  if (!job) {
    return res
      .status(404)
      .json({ success: false, message: "Job not found or agent job lease mismatch" });
  }

  if (status === "COMPLETED" && job.gridFsFileId) {
    const retentionMinutes =
      process.env.FILE_RETENTION_MINUTES !== undefined
        ? Number(process.env.FILE_RETENTION_MINUTES)
        : 60;
    if (retentionMinutes <= 0) {
      await deleteGridFSFile(job.gridFsFileId, req.tenantId);
      job.fileDeleted = true;
      await job.save();
    }
  }

  res.json({
    success: true,
    status: job.status,
    token: job.token,
    fileDeleted: job.fileDeleted
  });
}

module.exports = {
  heartbeat,
  nextJob,
  downloadJobFile,
  updateJobStatus,
  recoverExpiredLeases
};
