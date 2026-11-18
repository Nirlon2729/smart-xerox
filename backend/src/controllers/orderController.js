const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { z } = require("zod");
const Order = require("../models/Order");
const Agent = require("../models/Agent");
const Tenant = require("../models/Tenant");
const { createPrintToken } = require("../utils/token");
const { inspectUploadedBuffer } = require("../utils/fileValidator");
const { parseAndValidatePages } = require("../utils/pageRange");
const { buildShopPublicUrl } = require("../utils/agentCredentials");
const { recordAuditLog } = require("../utils/auditLogger");
const {
  uploadBufferToGridFS,
  findGridFSFileById,
  markGridFSFileBoundToJob,
  deleteGridFSFile
} = require("../services/gridfsService");

const defaultMaxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 20;
const defaultMaxCopiesAllowed = Number(process.env.MAX_COPIES) || 100;

const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/x-pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "application/octet-stream"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: defaultMaxUploadMb * 1024 * 1024 },
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
 * Resolves live printer & agent state strictly for a specific vendor tenantId.
 * Supports multi-printer detection, automatic single-printer selection, and manual capability overrides.
 */
async function getActivePrinterState(tenantId) {
  const heartbeatTimeoutSeconds = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_SECONDS) || 30;
  if (!tenantId) {
    throw Object.assign(new Error("tenantId is required to resolve printer state"), {
      statusCode: 400
    });
  }

  const tenant = await Tenant.findById(tenantId).lean();
  const preferredPrinterName = tenant?.selectedPrinterName || null;

  const agents = await Agent.find({
    tenantId,
    active: true,
    revokedAt: null
  })
    .sort({ lastSeenAt: -1 })
    .lean();

  let agent = null;
  if (preferredPrinterName && agents.length > 0) {
    agent =
      agents.find(
        (a) =>
          a.printerName === preferredPrinterName ||
          (Array.isArray(a.availablePrinters) &&
            a.availablePrinters.some((p) => p.name === preferredPrinterName))
      ) || agents[0];
  } else {
    agent = agents[0] || null;
  }

  const now = Date.now();
  const lastSeenMs = agent?.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : 0;
  const agentOnline = Boolean(
    agent && lastSeenMs > 0 && now - lastSeenMs <= heartbeatTimeoutSeconds * 1000
  );

  const availablePrinters = Array.isArray(agent?.availablePrinters) ? agent.availablePrinters : [];

  // Resolve target printer on the agent
  let activePrinterObj = null;
  if (preferredPrinterName && availablePrinters.length > 0) {
    activePrinterObj =
      availablePrinters.find(
        (p) => p.name.toLowerCase() === preferredPrinterName.toLowerCase()
      ) || null;
  }

  if (!activePrinterObj && availablePrinters.length === 1 && tenant?.autoSelectSinglePrinter !== false) {
    activePrinterObj = availablePrinters[0];
  }

  if (!activePrinterObj && agent?.printerName && availablePrinters.length > 0) {
    activePrinterObj =
      availablePrinters.find(
        (p) => p.name.toLowerCase() === String(agent.printerName).toLowerCase()
      ) || availablePrinters.find((p) => p.isDefault) || availablePrinters[0];
  }

  const resolvedPrinterName =
    activePrinterObj?.name ||
    preferredPrinterName ||
    agent?.printerName ||
    "No Printer Selected";

  const resolvedPortName = activePrinterObj?.portName ?? agent?.portName ?? null;
  const resolvedDriverName = activePrinterObj?.driverName ?? agent?.driverName ?? null;
  const resolvedDriverMissing = Boolean(
    activePrinterObj?.driverMissing ?? agent?.driverMissing ?? false
  );
  const resolvedStatus = activePrinterObj?.status || agent?.lastStatus || "OFFLINE";
  const resolvedSpoolerJobs =
    activePrinterObj?.spoolerJobCount ?? agent?.spoolerJobCount ?? 0;

  const rawAvailableFlag =
    activePrinterObj !== null
      ? activePrinterObj.printerAvailable
      : agent?.printerAvailable;

  const printerAvailable = Boolean(
    agentOnline &&
      (rawAvailableFlag === true || ["READY", "ONLINE", "PRINTING"].includes(resolvedStatus)) &&
      resolvedStatus !== "OFFLINE" &&
      resolvedStatus !== "ERROR"
  );

  let connectionState = "AGENT_OFFLINE";
  let statusLabel = "Agent Offline";
  let statusMessage = "Shop desktop print agent is currently offline.";

  if (agentOnline && printerAvailable) {
    connectionState = "PRINTER_READY";
    statusLabel = resolvedStatus === "PRINTING" ? "Printing..." : "Printer Ready";
    statusMessage =
      activePrinterObj?.statusMessage ||
      agent?.statusMessage ||
      `Connected to ${resolvedPrinterName}${resolvedPortName ? ` on ${resolvedPortName}` : ""}`;
  } else if (agentOnline && !printerAvailable) {
    connectionState = "PRINTER_OFFLINE";
    statusLabel = resolvedDriverMissing ? "Driver Missing" : "Printer Offline";
    statusMessage = resolvedDriverMissing
      ? `Windows printer driver is missing for ${resolvedPrinterName}. Please install the manufacturer's Windows driver.`
      : activePrinterObj?.statusMessage ||
        agent?.statusMessage ||
        `${resolvedPrinterName} is offline or disconnected.`;
  }

  const detectedCaps = activePrinterObj?.capabilities || agent?.capabilities || {
    supportedPaperSizes: ["A4", "Letter", "Legal", "A5"],
    supportsColor: false,
    supportsDuplex: false
  };

  const useManualOverride = Boolean(tenant?.capabilityOverrides?.useManualOverride);
  const effectiveCapabilities = useManualOverride
    ? {
        supportedPaperSizes:
          tenant.capabilityOverrides.supportedPaperSizes?.length > 0
            ? tenant.capabilityOverrides.supportedPaperSizes
            : ["A4"],
        supportsColor: Boolean(tenant.capabilityOverrides.supportsColor),
        supportsDuplex: Boolean(tenant.capabilityOverrides.supportsDuplex),
        useManualOverride: true,
        capabilitiesDetected: Boolean(activePrinterObj?.capabilitiesDetected ?? true)
      }
    : {
        supportedPaperSizes:
          detectedCaps.supportedPaperSizes?.length > 0
            ? detectedCaps.supportedPaperSizes
            : ["A4", "Letter", "Legal", "A5"],
        supportsColor: Boolean(detectedCaps.supportsColor),
        supportsDuplex: Boolean(detectedCaps.supportsDuplex),
        useManualOverride: false,
        capabilitiesDetected: Boolean(activePrinterObj?.capabilitiesDetected ?? true)
      };

  return {
    online: connectionState === "PRINTER_READY",
    connectionState,
    statusLabel,
    agentOnline,
    printerAvailable,
    agentId: agent?.agentId || agent?.deviceId || null,
    agentVersion: agent?.agentVersion || null,
    deviceId: agent?.deviceId || null,
    hostname: agent?.hostname || null,
    printerName: resolvedPrinterName,
    selectedPrinterName: preferredPrinterName || (availablePrinters.length === 1 ? availablePrinters[0].name : null),
    portName: resolvedPortName,
    driverName: resolvedDriverName,
    driverMissing: resolvedDriverMissing,
    availablePrinters,
    lastSeenAt: agent?.lastSeenAt || null,
    heartbeatTimeoutSeconds,
    status: connectionState === "PRINTER_READY" ? resolvedStatus || "READY" : "OFFLINE",
    statusMessage,
    spoolerJobCount: resolvedSpoolerJobs,
    capabilities: effectiveCapabilities,
    detectedCapabilities: detectedCaps,
    config: {
      maxUploadMb: tenant?.config?.maxUploadMb || defaultMaxUploadMb,
      maxCopies: tenant?.config?.maxCopies || defaultMaxCopiesAllowed,
      acceptingOrders: tenant?.config?.acceptingOrders !== false
    }
  };
}

/**
 * GET /api/shops/:shopSlug
 * Returns public shop details, printer availability, and verified capabilities for the customer website.
 */
async function getShopPublicInfo(req, res) {
  const tenant = req.tenant;
  const printer = await getActivePrinterState(req.tenantId);

  res.json({
    success: true,
    shop: {
      id: tenant._id,
      shopName: tenant.shopName,
      shopSlug: tenant.shopSlug,
      logoUrl: tenant.logoUrl || null,
      phone: tenant.phone || null,
      address: tenant.address || null,
      status: tenant.status,
      publicUrl: buildShopPublicUrl(tenant.shopSlug),
      config: printer.config
    },
    printer
  });
}

/**
 * GET /api/shops/:shopSlug/printer-status
 * Returns live printer connection state and supported hardware capabilities for the resolved shop.
 */
async function getPrinterStatus(req, res) {
  const printer = await getActivePrinterState(req.tenantId);
  res.json({
    success: true,
    shop: {
      id: req.tenant._id,
      shopName: req.tenant.shopName,
      shopSlug: req.tenant.shopSlug,
      logoUrl: req.tenant.logoUrl || null
    },
    printer
  });
}

/**
 * POST /api/shops/:shopSlug/orders/inspect
 * Validates binary content (PDF, JPG, JPEG, PNG) and streams it into MongoDB Atlas GridFS bound to tenantId.
 */
async function inspectDocument(req, res) {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({
      success: false,
      message: "Please select a PDF, JPG, JPEG, or PNG file to upload."
    });
  }

  const maxMb = req.tenant?.config?.maxUploadMb || defaultMaxUploadMb;
  if (req.file.buffer.length > maxMb * 1024 * 1024) {
    return res.status(413).json({
      success: false,
      message: `File exceeds this shop's maximum allowed upload size of ${maxMb} MB.`
    });
  }

  const inspection = inspectUploadedBuffer(req.file.buffer, req.file.originalname);

  const gridFsResult = await uploadBufferToGridFS({
    buffer: req.file.buffer,
    filename: req.file.originalname || `upload.${inspection.extension}`,
    contentType: inspection.mimeType,
    tenantId: req.tenantId,
    metadata: {
      staged: true,
      tenantId: String(req.tenantId),
      shopSlug: req.tenant.shopSlug,
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
  copies: z.number().int().min(1).max(1000).default(1),
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
    tenantId: order.tenantId,
    shopSlug: order.shopSlug,
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
    targetPrinterName: order.targetPrinterName || null,
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
 * POST /api/shops/:shopSlug/orders
 * Tenant-scoped customer job submission:
 * 1. Validates file & print settings against the shop's verified printer capabilities.
 * 2. Verifies exact GridFS tenant ownership.
 * 3. Enforces idempotency and 15-second SHA-256 deduplication per tenant.
 * 4. Queues the print job exclusively for this shop's paired desktop agent.
 */
async function createOrder(req, res) {
  let newlyUploadedGridFsId = null;

  try {
    if (req.tenant?.config?.acceptingOrders === false) {
      return res.status(403).json({
        success: false,
        message: "This shop is temporarily not accepting new print jobs."
      });
    }

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
    const printerState = await getActivePrinterState(req.tenantId);
    const maxCopies = printerState.config.maxCopies || defaultMaxCopiesAllowed;

    if (data.copies > maxCopies) {
      return res.status(400).json({
        success: false,
        message: `Maximum allowed copies per job at this shop is ${maxCopies}.`
      });
    }

    // Validate requested options against shop's verified printer capabilities
    const caps = printerState.capabilities;
    if (data.colorMode === "color" && !caps.supportsColor) {
      return res.status(400).json({
        success: false,
        message: "This shop's printer supports Black & White printing only."
      });
    }
    if (data.sides === "duplex" && !caps.supportsDuplex) {
      return res.status(400).json({
        success: false,
        message: "This shop's printer supports Single-sided printing only."
      });
    }
    if (
      Array.isArray(caps.supportedPaperSizes) &&
      caps.supportedPaperSizes.length > 0 &&
      !caps.supportedPaperSizes.includes(data.paperSize)
    ) {
      return res.status(400).json({
        success: false,
        message: `Paper size ${data.paperSize} is not supported by this shop's printer.`
      });
    }

    const scopedIdempotencyKey = data.idempotencyKey
      ? `${req.tenantId}:${data.idempotencyKey}`
      : undefined;

    // 1. Check idempotencyKey scoped to tenantId
    if (scopedIdempotencyKey) {
      const existingByKey = await Order.findOne({
        tenantId: req.tenantId,
        idempotencyKey: scopedIdempotencyKey
      });
      if (existingByKey) {
        return res.status(200).json({
          success: true,
          deduplicated: true,
          order: formatJobResponse(existingByKey),
          message: "Print job is already queued."
        });
      }
    }

    // 2. Resolve document from either staged GridFS uploadId (verified for tenantId!) or direct multipart upload
    let fileMeta = null;

    if (req.file && req.file.buffer) {
      const inspection = inspectUploadedBuffer(req.file.buffer, req.file.originalname);
      const gridFsResult = await uploadBufferToGridFS({
        buffer: req.file.buffer,
        filename: req.file.originalname || `upload.${inspection.extension}`,
        contentType: inspection.mimeType,
        tenantId: req.tenantId,
        metadata: {
          staged: false,
          tenantId: String(req.tenantId),
          shopSlug: req.tenant.shopSlug,
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

      if (data.uploadId && mongoose.Types.ObjectId.isValid(data.uploadId)) {
        await deleteGridFSFile(data.uploadId, req.tenantId);
      }
    } else if (data.uploadId && mongoose.Types.ObjectId.isValid(data.uploadId)) {
      const gridFsDoc = await findGridFSFileById(data.uploadId, req.tenantId);
      if (!gridFsDoc) {
        return res.status(400).json({
          success: false,
          message: "Uploaded document expired or does not belong to this shop. Please upload the file again."
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

    // 4. Prevent accidental duplicate submission within 15 seconds for identical file + settings in this shop
    const recentWindow = new Date(Date.now() - 15 * 1000);
    const duplicateActiveJob = await Order.findOne({
      tenantId: req.tenantId,
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
        await deleteGridFSFile(newlyUploadedGridFsId, req.tenantId);
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
      tenantId: req.tenantId,
      shopSlug: req.tenant.shopSlug,
      token,
      idempotencyKey: scopedIdempotencyKey,
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
      targetPrinterName:
        printerState.selectedPrinterName ||
        (printerState.printerName !== "No Printer Selected" ? printerState.printerName : null),
      status: "QUEUED"
    });

    await markGridFSFileBoundToJob(fileMeta.gridFsFileId, order._id, req.tenantId);

    return res.status(201).json({
      success: true,
      order: formatJobResponse(order),
      message: "Sending to printer..."
    });
  } catch (error) {
    if (newlyUploadedGridFsId) {
      await deleteGridFSFile(newlyUploadedGridFsId, req.tenantId);
    }
    throw error;
  }
}

/**
 * Helper to look up a job by either MongoDB _id or XR-... token, strictly scoped to tenantId.
 */
async function findJobByIdOrTokenForTenant(idOrToken, tenantId) {
  const raw = String(idOrToken || "").trim();
  if (!raw || !tenantId) return null;

  if (mongoose.Types.ObjectId.isValid(raw)) {
    const byId = await Order.findOne({ _id: raw, tenantId });
    if (byId) return byId;
  }
  return Order.findOne({ token: raw.toUpperCase(), tenantId });
}

/**
 * GET /api/shops/:shopSlug/orders/:token
 * Returns live status of a specific print job belonging to this shop tenant.
 */
async function getOrderByToken(req, res) {
  const order = await findJobByIdOrTokenForTenant(req.params.token, req.tenantId);
  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Print job not found for this shop."
    });
  }

  const printer = await getActivePrinterState(req.tenantId);

  res.json({
    success: true,
    order: formatJobResponse(order),
    printer
  });
}

/**
 * POST /api/shops/:shopSlug/orders/:token/cancel (or vendor cancel)
 * Cancels a queued or failed print job belonging to req.tenantId and deletes its GridFS file.
 */
async function cancelOrder(req, res) {
  const order = await findJobByIdOrTokenForTenant(req.params.token, req.tenantId);
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
      message: "Document is already actively printing on the printer."
    });
  }

  order.status = "CANCELLED";
  order.leaseExpiresAt = null;
  if (order.gridFsFileId && !order.fileDeleted) {
    await deleteGridFSFile(order.gridFsFileId, req.tenantId);
    order.fileDeleted = true;
  }
  await order.save();

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: req.admin ? "VENDOR_ADMIN" : "CUSTOMER",
    actorId: req.admin?._id || order.token,
    action: "JOB_CANCELLED",
    targetType: "Order",
    targetId: order._id,
    details: { token: order.token, originalName: order.originalName },
    req
  });

  res.json({
    success: true,
    order: formatJobResponse(order),
    message: "Print job cancelled and document removed from GridFS."
  });
}

/**
 * POST /api/vendor/orders/:token/reprint
 * Authenticated vendor reprints a job belonging to their own tenant.
 */
async function reprintOrder(req, res) {
  const sourceOrder = await findJobByIdOrTokenForTenant(req.params.token, req.tenantId);
  if (!sourceOrder) {
    return res.status(404).json({ success: false, message: "Print job not found" });
  }

  if (["QUEUED", "DOWNLOADING", "PROCESSING", "PRINTING"].includes(sourceOrder.status)) {
    return res.status(409).json({
      success: false,
      message: "This job is already active in the print queue."
    });
  }

  const gridFsDoc = await findGridFSFileById(sourceOrder.gridFsFileId, req.tenantId);
  if (!gridFsDoc || sourceOrder.fileDeleted) {
    return res.status(410).json({
      success: false,
      message:
        "Document file was already cleaned up after printing. Please upload the file again to print."
    });
  }

  if (sourceOrder.status === "FAILED") {
    sourceOrder.status = "QUEUED";
    sourceOrder.failureReason = null;
    sourceOrder.agentJobId = null;
    sourceOrder.spoolerJobId = null;
    sourceOrder.leaseExpiresAt = null;
    sourceOrder.retryCount = 0;
    await sourceOrder.save();

    await recordAuditLog({
      tenantId: req.tenantId,
      actorType: "VENDOR_ADMIN",
      actorId: req.admin?._id,
      action: "JOB_REPRINTED",
      targetType: "Order",
      targetId: sourceOrder._id,
      details: { token: sourceOrder.token, mode: "reset_failed" },
      req
    });

    return res.json({
      success: true,
      order: formatJobResponse(sourceOrder),
      message: "Job re-queued for printing."
    });
  }

  const token = await generateUniqueJobToken();
  const reprinted = await Order.create({
    tenantId: req.tenantId,
    shopSlug: sourceOrder.shopSlug || req.tenant?.shopSlug,
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
    targetPrinterName: req.tenant?.selectedPrinterName || sourceOrder.targetPrinterName,
    status: "QUEUED"
  });

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin?._id,
    action: "JOB_REPRINTED",
    targetType: "Order",
    targetId: reprinted._id,
    details: { sourceOrderId: sourceOrder._id, token: reprinted.token },
    req
  });

  return res.status(201).json({
    success: true,
    order: formatJobResponse(reprinted),
    message: "Reprint job sent to printer queue."
  });
}

/**
 * DELETE /api/vendor/orders/failed
 * Authenticated vendor clears failed/cancelled jobs exclusively for their own tenant.
 */
async function clearFailedOrders(req, res) {
  const toClear = await Order.find({
    tenantId: req.tenantId,
    status: { $in: ["FAILED", "CANCELLED"] }
  }).select("_id gridFsFileId fileDeleted");

  for (const job of toClear) {
    if (job.gridFsFileId && !job.fileDeleted) {
      await deleteGridFSFile(job.gridFsFileId, req.tenantId);
    }
  }

  const deletedResult = await Order.deleteMany({
    tenantId: req.tenantId,
    status: { $in: ["FAILED", "CANCELLED"] }
  });

  await recordAuditLog({
    tenantId: req.tenantId,
    actorType: "VENDOR_ADMIN",
    actorId: req.admin?._id,
    action: "FAILED_JOBS_CLEARED",
    details: { deletedCount: deletedResult.deletedCount || 0 },
    req
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
  getShopPublicInfo,
  getPrinterStatus,
  inspectDocument,
  createOrder,
  findJobByIdOrTokenForTenant,
  formatJobResponse,
  getOrderByToken,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
};
