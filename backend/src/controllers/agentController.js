const crypto = require("crypto");
const Order = require("../models/Order");
const Agent = require("../models/Agent");
const {
  openGridFSDownloadStream,
  deleteGridFSFile,
  cleanupExpiredGridFSFiles
} = require("../services/gridfsService");

const LEASE_DURATION_MS = 3 * 60 * 1000; // 3 minutes per active download/processing lease

/**
 * Recovers jobs that stalled during DOWNLOADING or PROCESSING (before reaching the physical printer spooler).
 * Never auto-requeues a job already in PRINTING state to avoid accidental duplicate physical prints.
 */
async function recoverExpiredLeases() {
  const now = new Date();
  await Order.updateMany(
    {
      status: { $in: ["DOWNLOADING", "PROCESSING"] },
      leaseExpiresAt: { $ne: null, $lt: now },
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
      status: { $in: ["DOWNLOADING", "PROCESSING"] },
      leaseExpiresAt: { $ne: null, $lt: now },
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

/**
 * POST /api/agent/heartbeat
 * Receives live printer status, availability, version, and capabilities from the Windows 11 print agent.
 */
async function heartbeat(req, res) {
  const {
    deviceId,
    agentId,
    agentVersion,
    printerName,
    portName,
    driverName,
    printerAvailable,
    status,
    statusMessage,
    spoolerJobCount,
    capabilities
  } = req.body;

  const resolvedDeviceId = String(deviceId || agentId || "").trim();
  const resolvedPrinterName = String(printerName || "").trim();

  if (!resolvedDeviceId || !resolvedPrinterName) {
    return res
      .status(400)
      .json({ success: false, message: "deviceId (or agentId) and printerName are required" });
  }

  const allowedStatuses = ["READY", "ONLINE", "PRINTING", "OFFLINE", "ERROR"];
  const normalizedStatus = allowedStatuses.includes(status) ? status : "READY";
  const isPrinterReady =
    printerAvailable !== undefined
      ? Boolean(printerAvailable)
      : ["READY", "ONLINE", "PRINTING"].includes(normalizedStatus);

  const now = new Date();
  const updateFields = {
    printerName: resolvedPrinterName,
    agentVersion: String(agentVersion || "2.0.0").trim(),
    portName: portName ? String(portName).trim() : null,
    driverName: driverName ? String(driverName).trim() : null,
    printerAvailable: isPrinterReady,
    lastSeenAt: now,
    lastStatus: normalizedStatus,
    statusMessage: statusMessage ? String(statusMessage).slice(0, 300) : null,
    spoolerJobCount: Number(spoolerJobCount) || 0,
    active: true
  };

  if (capabilities && typeof capabilities === "object") {
    const validSizes = ["A4", "A3", "Legal", "Letter", "A5"];
    const reportedSizes = Array.isArray(capabilities.supportedPaperSizes)
      ? capabilities.supportedPaperSizes.filter((s) => validSizes.includes(s))
      : ["A4", "Letter", "Legal", "A5"];

    updateFields.capabilities = {
      supportedPaperSizes: reportedSizes.length > 0 ? reportedSizes : ["A4"],
      supportsColor:
        capabilities.supportsColor !== undefined
          ? Boolean(capabilities.supportsColor)
          : false,
      supportsDuplex:
        capabilities.supportsDuplex !== undefined
          ? Boolean(capabilities.supportsDuplex)
          : false
    };
  }

  const updatedAgent = await Agent.findOneAndUpdate(
    { deviceId: resolvedDeviceId },
    { $set: updateFields },
    { upsert: true, new: true }
  );

  recoverExpiredLeases().catch(() => {});
  cleanupExpiredGridFSFiles(Order).catch(() => {});

  res.json({
    success: true,
    heartbeatAt: now.toISOString(),
    agent: {
      deviceId: updatedAgent.deviceId,
      agentVersion: updatedAgent.agentVersion,
      printerName: updatedAgent.printerName,
      portName: updatedAgent.portName,
      printerAvailable: updatedAgent.printerAvailable,
      lastStatus: updatedAgent.lastStatus
    }
  });
}

/**
 * GET /api/agent/jobs/next
 * Atomically claims the next QUEUED job for the Windows 11 print agent.
 */
async function nextJob(_req, res) {
  await recoverExpiredLeases();

  const agentJobId = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);

  const job = await Order.findOneAndUpdate(
    { status: "QUEUED", fileDeleted: { $ne: true } },
    {
      $set: {
        status: "DOWNLOADING",
        agentJobId,
        leaseExpiresAt,
        failureReason: null
      }
    },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!job) {
    return res.json({ success: true, job: null });
  }

  res.json({
    success: true,
    job: {
      orderId: job._id,
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
      printerName: process.env.PRINTER_NAME || "HP LaserJet MFP M129-M134",
      agentJobId: job.agentJobId
    }
  });
}

/**
 * GET /api/agent/jobs/:id/file
 * Streams the private document directly from MongoDB Atlas GridFS to the authorized print agent.
 */
async function downloadJobFile(req, res) {
  const job = await Order.findById(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  const providedAgentJobId = req.headers["x-agent-job-id"] || req.query.agentJobId;
  if (job.agentJobId && providedAgentJobId && job.agentJobId !== providedAgentJobId) {
    return res.status(409).json({
      success: false,
      message: "Agent job lease mismatch"
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

  const { fileDoc, stream } = await openGridFSDownloadStream(job.gridFsFileId);

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
 * Updates job status through DOWNLOADING -> PROCESSING -> PRINTING -> COMPLETED / FAILED.
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

  const query = { _id: req.params.id };
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
      .json({ success: false, message: "Job not found or agent job ID mismatch" });
  }

  if (status === "COMPLETED" && job.gridFsFileId) {
    const retentionMinutes =
      process.env.FILE_RETENTION_MINUTES !== undefined
        ? Number(process.env.FILE_RETENTION_MINUTES)
        : 60;
    if (retentionMinutes <= 0) {
      await deleteGridFSFile(job.gridFsFileId);
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
