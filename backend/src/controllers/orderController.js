const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { z } = require("zod");
const Order = require("../models/Order");
const Agent = require("../models/Agent");
const { createPrintToken } = require("../utils/token");
const { inspectUploadedBuffer } = require("../utils/fileValidator");
const { parseAndValidatePages } = require("../utils/pageRange");
const {
  uploadBufferToGridFS,
  findGridFSFileById,
  openGridFSDownloadStream,
  markGridFSFileBoundToJob,
  deleteGridFSFile
} = require("../services/gridfsService");

const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 20;
const maxCopiesAllowed = Number(process.env.MAX_COPIES) || 100;

const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/x-pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/octet-stream"
]);

// Use memoryStorage so buffers are validated and streamed directly to MongoDB Atlas GridFS
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const originalName = String(file.originalname || "").trim().toLowerCase();
    const ext = path.extname(originalName);
    const mime = String(file.mimetype || "").toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_MIMES.has(mime)) {
      const err = new Error("Unsupported file type. Please upload a PDF, JPG, JPEG, or PNG file.");
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

/**
 * Helper to resolve live printer status & capabilities from the most recently active Agent.
 * Distinguishes:
 * - AGENT_OFFLINE (no heartbeat within AGENT_HEARTBEAT_TIMEOUT_SECONDS)
 * - PRINTER_OFFLINE (agent is online, but USB printer is disconnected/offline/error)
 * - PRINTER_READY (both agent and USB printer are online and ready)
 */
async function getActivePrinterState() {
  const heartbeatTimeoutSeconds = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_SECONDS) || 30;
  const configuredPrinterName = process.env.PRINTER_NAME || "HP LaserJet MFP M129-M134";

  // Prefer the agent matching configured PRINTER_NAME if present, otherwise most recently seen active agent
  let agent = await Agent.findOne({ active: true, printerName: configuredPrinterName })
    .sort({ lastSeenAt: -1 })
    .lean();
  if (!agent) {
    agent = await Agent.findOne({ active: true }).sort({ lastSeenAt: -1 }).lean();
  }

  const now = Date.now();
  const lastSeenMs = agent?.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : 0;
  const agentOnline = Boolean(
    agent && lastSeenMs > 0 && now - lastSeenMs <= heartbeatTimeoutSeconds * 1000
  );

  const printerAvailable = Boolean(
    agentOnline &&
      (agent.printerAvailable === true ||
        ["READY", "ONLINE", "PRINTING"].includes(agent.lastStatus)) &&
      agent.lastStatus !== "OFFLINE"
  );

  let connectionState = "AGENT_OFFLINE";
  let statusLabel = "Agent Offline";
  let statusMessage = "Windows print agent is not running on the laptop.";

  if (agentOnline && printerAvailable) {
    connectionState = "PRINTER_READY";
    statusLabel = agent.lastStatus === "PRINTING" ? "Printing..." : "Printer Ready";
    statusMessage =
      agent.statusMessage ||
      `Connected to ${agent.printerName}${agent.portName ? ` on ${agent.portName}` : ""}`;
  } else if (agentOnline && !printerAvailable) {
    connectionState = "PRINTER_OFFLINE";
    statusLabel = "Printer Offline";
    statusMessage =
      agent.statusMessage ||
      `${agent.printerName} is offline or disconnected from USB.`;
  }

  const defaultCapabilities = {
    supportedPaperSizes: ["A4", "Letter", "Legal", "A5"],
    supportsColor: false,
    supportsDuplex: false
  };

  return {
    online: connectionState === "PRINTER_READY",
    connectionState,
    statusLabel,
    agentOnline,
    printerAvailable,
    agentId: agent?.deviceId || null,
    agentVersion: agent?.agentVersion || null,
    printerName: agent?.printerName || configuredPrinterName,
    portName: agent?.portName || null,
    driverName: agent?.driverName || null,
    deviceId: agent?.deviceId || null,
    lastSeenAt: agent?.lastSeenAt || null,
    heartbeatTimeoutSeconds,
    status: connectionState === "PRINTER_READY" ? agent.lastStatus || "READY" : "OFFLINE",
    statusMessage,
    spoolerJobCount: agent?.spoolerJobCount || 0,
    capabilities: agent?.capabilities?.supportedPaperSizes?.length
      ? agent.capabilities
      : defaultCapabilities,
    config: {
      maxUploadMb,
      maxCopies: maxCopiesAllowed
    }
  };
}

/**
 * GET /api/orders/printer-status
 * Returns live USB HP printer connection state and supported hardware capabilities.
 */
async function getPrinterStatus(_req, res) {
  const printer = await getActivePrinterState();
  res.json({
    success: true,
    printer
  });
}

/**
 * POST /api/orders/inspect
 * Validates actual binary content (PDF, JPG, JPEG, PNG) and streams it into MongoDB Atlas GridFS.
 */
async function inspectDocument(req, res) {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({
      success: false,
      message: "Please select a PDF, JPG, JPEG, or PNG file to upload."
    });
  }

  const inspection = inspectUploadedBuffer(req.file.buffer, req.file.originalname);

  const gridFsResult = await uploadBufferToGridFS({
    buffer: req.file.buffer,
    filename: req.file.originalname || `upload.${inspection.extension}`,
    contentType: inspection.mimeType,
    metadata: {
      staged: true,
      originalName: req.file.originalname,
      documentType: inspection.documentType,
      mimeType: inspection.mimeType,
      pageCount: inspection.pageCount,
      width: inspection.width,
      height: inspection.height,
      detectedOrientation: inspection.detectedOrientation,
      sha256: inspection.sha256
    }
  });

  return res.status(200).json({
    success: true,
    document: {
      uploadId: gridFsResult.gridFsFileId.toString(),
      gridFsFileId: gridFsResult.gridFsFileId.toString(),
      originalName: req.file.originalname,
      mimeType: inspection.mimeType,
      documentType: inspection.documentType,
      fileSize: inspection.fileSize,
      pageCount: inspection.pageCount,
      width: inspection.width,
      height: inspection.height,
      detectedOrientation: inspection.detectedOrientation,
      sha256: inspection.sha256
    }
  });
}

const createJobSchema = z.object({
  uploadId: z.string().optional(),
  idempotencyKey: z.string().max(128).optional(),
  pageSelectionMode: z.enum(["all", "custom"]).default("all"),
  customPageRange: z.string().optional(),
  selectedPages: z.array(z.number().int().positive()).max(5000).optional(),
  copies: z.number().int().min(1).max(maxCopiesAllowed).default(1),
  colorMode: z.enum(["bw", "color"]).default("bw"),
  sides: z.enum(["single", "duplex"]).default("single"),
  paperSize: z.enum(["A4", "A3", "Legal", "Letter", "A5"]).default("A4"),
  orientation: z.enum(["portrait", "landscape", "auto"]).default("auto")
});

async function generateUniqueJobToken() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = createPrintToken();
    const exists = await Order.exists({ token: candidate });
    if (!exists) return candidate;
  }
  return `XR-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
}

function formatJobResponse(order) {
  return {
    id: order._id,
    token: order.token,
    originalName: order.originalName,
    documentType: order.documentType || "pdf",
    mimeType: order.mimeType || "application/pdf",
    fileSize: order.fileSize,
    imageDimensions: order.imageDimensions || null,
    pageCount: order.pageCount,
    selectedPages: order.selectedPages,
    selectedPageCount: order.selectedPages ? order.selectedPages.length : order.pageCount,
    copies: order.copies,
    colorMode: order.colorMode,
    sides: order.sides,
    paperSize: order.paperSize || "A4",
    orientation: order.orientation || "auto",
    printablePageCount: order.printablePageCount,
    status: order.status,
    spoolerJobId: order.spoolerJobId || null,
    fileDeleted: Boolean(order.fileDeleted),
    failureReason: order.failureReason || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    completedAt: order.completedAt
  };
}

/**
 * POST /api/orders
 * Direct "PRINT NOW" workflow:
 * 1. Validates file & print settings.
 * 2. Stores document in MongoDB Atlas GridFS (or binds staged GridFS upload).
 * 3. Prevents duplicate print jobs via idempotencyKey and recent SHA-256 deduplication.
 * 4. Sets job status directly to QUEUED so the Windows 11 print agent starts printing automatically.
 */
async function createOrder(req, res) {
  let newlyUploadedGridFsId = null;

  try {
    let parsedSelectedPages;
    if (req.body.selectedPages !== undefined) {
      parsedSelectedPages =
        typeof req.body.selectedPages === "string"
          ? JSON.parse(req.body.selectedPages || "[]")
          : req.body.selectedPages;
    }

    const parsed = createJobSchema.safeParse({
      uploadId: req.body.uploadId || undefined,
      idempotencyKey: req.body.idempotencyKey || undefined,
      pageSelectionMode: req.body.pageSelectionMode || "all",
      customPageRange: req.body.customPageRange || undefined,
      selectedPages: Array.isArray(parsedSelectedPages)
        ? parsedSelectedPages.map(Number)
        : undefined,
      copies: Number(req.body.copies || 1),
      colorMode: req.body.colorMode || "bw",
      sides: req.body.sides || "single",
      paperSize: req.body.paperSize || "A4",
      orientation: req.body.orientation || "auto"
    });

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: parsed.error.issues[0]?.message || "Invalid print settings"
      });
    }

    const data = parsed.data;

    // 1. Check idempotencyKey first to prevent duplicate jobs on double-click or network retry
    if (data.idempotencyKey) {
      const existingByKey = await Order.findOne({ idempotencyKey: data.idempotencyKey });
      if (existingByKey) {
        return res.status(200).json({
          success: true,
          deduplicated: true,
          order: formatJobResponse(existingByKey),
          message: "Print job is already queued."
        });
      }
    }

    // 2. Resolve document from either staged GridFS uploadId or direct multipart upload
    let fileMeta = null;

    if (req.file && req.file.buffer) {
      const inspection = inspectUploadedBuffer(req.file.buffer, req.file.originalname);
      const gridFsResult = await uploadBufferToGridFS({
        buffer: req.file.buffer,
        filename: req.file.originalname || `upload.${inspection.extension}`,
        contentType: inspection.mimeType,
        metadata: {
          staged: false,
          originalName: req.file.originalname,
          documentType: inspection.documentType,
          mimeType: inspection.mimeType,
          pageCount: inspection.pageCount,
          width: inspection.width,
          height: inspection.height,
          sha256: inspection.sha256
        }
      });

      newlyUploadedGridFsId = gridFsResult.gridFsFileId;
      fileMeta = {
        gridFsFileId: gridFsResult.gridFsFileId,
        originalName: req.file.originalname,
        documentType: inspection.documentType,
        mimeType: inspection.mimeType,
        fileSize: inspection.fileSize,
        pageCount: inspection.pageCount,
        width: inspection.width,
        height: inspection.height,
        sha256: inspection.sha256
      };

      // Clean up previous staged upload if replaced
      if (data.uploadId && mongoose.Types.ObjectId.isValid(data.uploadId)) {
        await deleteGridFSFile(data.uploadId);
      }
    } else if (data.uploadId && mongoose.Types.ObjectId.isValid(data.uploadId)) {
      const gridFsDoc = await findGridFSFileById(data.uploadId);
      if (!gridFsDoc) {
        return res.status(400).json({
          success: false,
          message: "Uploaded document expired or was not found. Please select the file again."
        });
      }

      const meta = gridFsDoc.metadata || {};
      fileMeta = {
        gridFsFileId: gridFsDoc._id,
        originalName: meta.originalName || gridFsDoc.filename,
        documentType: meta.documentType || "pdf",
        mimeType: meta.mimeType || gridFsDoc.contentType || "application/pdf",
        fileSize: gridFsDoc.length,
        pageCount: Number(meta.pageCount) || 1,
        width: meta.width || null,
        height: meta.height || null,
        sha256: meta.sha256 || gridFsDoc._id.toString()
      };
    } else {
      return res.status(400).json({
        success: false,
        message: "Please select a PDF, JPG, JPEG, or PNG document to print."
      });
    }

    // 3. Validate page selection against actual pageCount
    const uniquePages =
      fileMeta.documentType === "image"
        ? [1]
        : parseAndValidatePages({
            pageSelectionMode: data.pageSelectionMode,
            customPageRange: data.customPageRange,
            selectedPages: data.selectedPages,
            totalPages: fileMeta.pageCount
          });

    // 4. Prevent accidental duplicate submission within 15 seconds for identical file + settings
    const recentWindow = new Date(Date.now() - 15 * 1000);
    const duplicateActiveJob = await Order.findOne({
      fileSha256: fileMeta.sha256,
      copies: data.copies,
      colorMode: data.colorMode,
      sides: data.sides,
      paperSize: data.paperSize,
      orientation: data.orientation,
      status: { $in: ["QUEUED", "DOWNLOADING", "PROCESSING", "PRINTING"] },
      createdAt: { $gte: recentWindow }
    });

    if (duplicateActiveJob) {
      if (newlyUploadedGridFsId) {
        await deleteGridFSFile(newlyUploadedGridFsId);
      }
      return res.status(200).json({
        success: true,
        deduplicated: true,
        order: formatJobResponse(duplicateActiveJob),
        message: "This document is already being sent to the printer."
      });
    }

    const token = await generateUniqueJobToken();

    const order = await Order.create({
      token,
      idempotencyKey: data.idempotencyKey || undefined,
      originalName: fileMeta.originalName,
      gridFsFileId: fileMeta.gridFsFileId,
      fileSha256: fileMeta.sha256,
      storedFileName: fileMeta.gridFsFileId.toString(),
      documentType: fileMeta.documentType,
      mimeType: fileMeta.mimeType,
      fileSize: fileMeta.fileSize,
      imageDimensions: {
        width: fileMeta.width,
        height: fileMeta.height
      },
      selectedPages: uniquePages,
      copies: data.copies,
      colorMode: data.colorMode,
      sides: fileMeta.documentType === "image" ? "single" : data.sides,
      paperSize: data.paperSize,
      orientation: data.orientation,
      pageCount: fileMeta.pageCount,
      printablePageCount: uniquePages.length * data.copies,
      status: "QUEUED"
    });

    await markGridFSFileBoundToJob(fileMeta.gridFsFileId, order._id);

    return res.status(201).json({
      success: true,
      order: formatJobResponse(order),
      message: "Sending to printer..."
    });
  } catch (error) {
    if (newlyUploadedGridFsId) {
      await deleteGridFSFile(newlyUploadedGridFsId);
    }
    throw error;
  }
}

/**
 * GET /api/orders
 * Lists recent print jobs for the personal main screen & owner dashboard.
 */
async function listRecentOrders(req, res) {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const filter = {};
  if (req.query.status && req.query.status !== "ALL") {
    filter.status = req.query.status;
  }

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);
  const printer = await getActivePrinterState();

  res.json({
    success: true,
    orders: orders.map(formatJobResponse),
    printer
  });
}

/**
 * Helper to look up a job by either MongoDB _id or XR-... token.
 */
async function findJobByIdOrToken(idOrToken) {
  const raw = String(idOrToken || "").trim();
  if (!raw) return null;
  if (mongoose.Types.ObjectId.isValid(raw)) {
    const byId = await Order.findById(raw);
    if (byId) return byId;
  }
  return Order.findOne({ token: raw.toUpperCase() });
}

/**
 * GET /api/orders/:token
 * Returns live status of a specific print job along with current printer connection status.
 */
async function getOrderByToken(req, res) {
  const order = await findJobByIdOrToken(req.params.token);
  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Print job not found."
    });
  }

  const printer = await getActivePrinterState();

  res.json({
    success: true,
    order: formatJobResponse(order),
    printer
  });
}

/**
 * POST /api/orders/:token/cancel
 * Cancels a queued or failed print job and cleans up its GridFS document.
 */
async function cancelOrder(req, res) {
  const order = await findJobByIdOrToken(req.params.token);
  if (!order) {
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  if (order.status === "COMPLETED") {
    return res.status(409).json({
      success: false,
      message: "This print job has already completed."
    });
  }

  if (order.status === "PRINTING") {
    return res.status(409).json({
      success: false,
      message: "Document is already actively printing on the USB printer."
    });
  }

  order.status = "CANCELLED";
  order.leaseExpiresAt = null;
  if (order.gridFsFileId && !order.fileDeleted) {
    await deleteGridFSFile(order.gridFsFileId);
    order.fileDeleted = true;
  }
  await order.save();

  res.json({
    success: true,
    order: formatJobResponse(order),
    message: "Print job cancelled and document removed from GridFS."
  });
}

/**
 * POST /api/orders/:token/reprint
 * Re-queues a print job after explicit confirmation by the owner, provided the GridFS file still exists.
 */
async function reprintOrder(req, res) {
  const sourceOrder = await findJobByIdOrToken(req.params.token);
  if (!sourceOrder) {
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  if (["QUEUED", "DOWNLOADING", "PROCESSING", "PRINTING"].includes(sourceOrder.status)) {
    return res.status(409).json({
      success: false,
      message: "This job is already active in the print queue."
    });
  }

  const gridFsDoc = await findGridFSFileById(sourceOrder.gridFsFileId);
  if (!gridFsDoc || sourceOrder.fileDeleted) {
    return res.status(410).json({
      success: false,
      message:
        "Document file was already cleaned up after printing. Please upload the file again to print."
    });
  }

  // If the job had FAILED, reset it directly to QUEUED so it doesn't clutter the list
  if (sourceOrder.status === "FAILED") {
    sourceOrder.status = "QUEUED";
    sourceOrder.failureReason = null;
    sourceOrder.agentJobId = null;
    sourceOrder.spoolerJobId = null;
    sourceOrder.leaseExpiresAt = null;
    sourceOrder.retryCount = 0;
    await sourceOrder.save();

    return res.json({
      success: true,
      order: formatJobResponse(sourceOrder),
      message: "Job re-queued for printing."
    });
  }

  // Otherwise create a new QUEUED job referencing the retained GridFS file
  const token = await generateUniqueJobToken();
  const reprinted = await Order.create({
    token,
    originalName: sourceOrder.originalName,
    gridFsFileId: sourceOrder.gridFsFileId,
    fileSha256: sourceOrder.fileSha256,
    storedFileName: sourceOrder.gridFsFileId.toString(),
    documentType: sourceOrder.documentType,
    mimeType: sourceOrder.mimeType,
    fileSize: sourceOrder.fileSize,
    imageDimensions: sourceOrder.imageDimensions,
    selectedPages: sourceOrder.selectedPages,
    copies: sourceOrder.copies,
    colorMode: sourceOrder.colorMode,
    sides: sourceOrder.sides,
    paperSize: sourceOrder.paperSize,
    orientation: sourceOrder.orientation,
    pageCount: sourceOrder.pageCount,
    printablePageCount: sourceOrder.printablePageCount,
    status: "QUEUED"
  });

  return res.status(201).json({
    success: true,
    order: formatJobResponse(reprinted),
    message: "Reprint job sent to printer queue."
  });
}

/**
 * DELETE /api/orders/failed
 * Clears failed and cancelled print jobs and deletes any remaining GridFS files for them.
 */
async function clearFailedOrders(_req, res) {
  const toClear = await Order.find({
    status: { $in: ["FAILED", "CANCELLED"] }
  }).select("_id gridFsFileId fileDeleted");

  for (const job of toClear) {
    if (job.gridFsFileId && !job.fileDeleted) {
      await deleteGridFSFile(job.gridFsFileId);
    }
  }

  const deletedResult = await Order.deleteMany({
    status: { $in: ["FAILED", "CANCELLED"] }
  });

  res.json({
    success: true,
    deletedCount: deletedResult.deletedCount || 0,
    message: `Cleared ${deletedResult.deletedCount || 0} failed/cancelled job(s).`
  });
}

module.exports = {
  uploadDocument: upload.single("document"),
  getActivePrinterState,
  getPrinterStatus,
  inspectDocument,
  createOrder,
  listRecentOrders,
  getOrderByToken,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
};
