const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true
    },
    shopSlug: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
      index: true
    },
    token: {
      type: String,
      unique: true,
      index: true
    },
    pickupCode: {
      type: String,
      trim: true,
      default: null,
      index: true
    },
    pickupCodeActive: {
      type: Boolean,
      default: false
    },
    pickupCodeReservedUntil: {
      type: Date,
      default: null
    },
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true
    },
    originalName: {
      type: String,
      required: true
    },
    gridFsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    fileSha256: {
      type: String,
      required: true,
      index: true
    },
    storedFileName: {
      type: String,
      default: null
    },
    documentType: {
      type: String,
      enum: ["pdf", "image"],
      default: "pdf"
    },
    mimeType: {
      type: String,
      enum: ["application/pdf", "image/jpeg", "image/png"],
      default: "application/pdf"
    },
    fileSize: {
      type: Number,
      required: true
    },
    imageDimensions: {
      width: { type: Number, default: null },
      height: { type: Number, default: null }
    },
    selectedPages: [{ type: Number, min: 1 }],
    copies: {
      type: Number,
      min: 1,
      max: 1000,
      default: 1
    },
    colorMode: {
      type: String,
      enum: ["bw", "color"],
      default: "bw"
    },
    sides: {
      type: String,
      enum: ["single", "duplex"],
      default: "single"
    },
    paperSize: {
      type: String,
      enum: ["A4", "A3", "Legal", "Letter", "A5", "B5", "Executive"],
      default: "A4"
    },
    orientation: {
      type: String,
      enum: ["portrait", "landscape", "auto"],
      default: "auto"
    },
    pageCount: {
      type: Number,
      required: true
    },
    printablePageCount: {
      type: Number,
      required: true
    },
    targetPrinterName: {
      type: String,
      default: null
    },
    claimedByAgentId: {
      type: String,
      default: null
    },
    amountPaise: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: "INR"
    },
    totalPrice: {
      type: Number,
      default: 0
    },
    pricingSnapshot: {
      currency: { type: String, default: "INR" },
      currencySymbol: { type: String, default: "₹" },
      colorMode: { type: String, default: "bw" },
      modeTitle: { type: String, default: "Black & White" },
      sides: { type: String, default: "single" },
      paperSize: { type: String, default: "A4" },
      logicalPagesPerCopy: { type: Number, default: 1 },
      printedSidesTotal: { type: Number, default: 1 },
      physicalSheetsPerCopy: { type: Number, default: 1 },
      totalPhysicalSheets: { type: Number, default: 1 },
      duplexSheetsPerCopy: { type: Number, default: 0 },
      singlePagesPerCopy: { type: Number, default: 1 },
      copies: { type: Number, default: 1 },
      appliedSingleRate: { type: Number, default: 2 },
      appliedDuplexRate: { type: Number, default: 3 },
      paperSizeSurcharge: { type: Number, default: 0 },
      unitRateLabel: { type: String, default: null },
      breakdownText: { type: String, default: null },
      costPerCopy: { type: Number, default: 0 },
      totalPrice: { type: Number, default: 0 },
      amountPaise: { type: Number, default: 0 },
      calculatedAt: { type: Date, default: Date.now }
    },
    printConfigSnapshot: {
      tenantId: { type: String, default: null },
      shopId: { type: String, default: null },
      shopSlug: { type: String, default: null },
      documentId: { type: String, default: null },
      printerId: { type: String, default: null },
      printerName: { type: String, default: null },
      colorMode: { type: String, default: "bw" },
      paperSize: { type: String, default: "A4" },
      orientation: { type: String, default: "portrait" },
      sides: { type: String, default: "single" },
      copies: { type: Number, default: 1 },
      selectedPages: [{ type: Number }],
      pageSelectionMode: { type: String, default: "all" },
      customPageRange: { type: String, default: null }
    },
    status: {
      type: String,
      enum: [
        "UPLOADING",
        "QUEUED",
        "DOWNLOADING",
        "PROCESSING",
        "PRINTING",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "ORDER_RECEIVED",
        "AWAITING_COUNTER_PAYMENT",
        "PAYMENT_CONFIRMED"
      ],
      default: "QUEUED",
      index: true
    },
    agentJobId: {
      type: String,
      default: null
    },
    spoolerJobId: {
      type: Number,
      default: null
    },
    leaseExpiresAt: {
      type: Date,
      default: null
    },
    retryCount: {
      type: Number,
      default: 0
    },
    fileDeleted: {
      type: Boolean,
      default: false
    },
    failureReason: {
      type: String,
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

orderSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index(
  { tenantId: 1, pickupCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      pickupCode: { $type: "string" },
      pickupCodeActive: true
    }
  }
);
orderSchema.index({ tenantId: 1, pickupCodeActive: 1, pickupCodeReservedUntil: 1 });

module.exports = mongoose.model("Order", orderSchema);
