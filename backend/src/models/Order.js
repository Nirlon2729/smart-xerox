const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  token: { type: String, unique: true, index: true },
  idempotencyKey: { type: String, unique: true, sparse: true },
  originalName: { type: String, required: true },
  gridFsFileId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  fileSha256: { type: String, required: true, index: true },
  storedFileName: { type: String, default: null },
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
  fileSize: { type: Number, required: true },
  imageDimensions: {
    width: { type: Number, default: null },
    height: { type: Number, default: null }
  },
  selectedPages: [{ type: Number, min: 1 }],
  copies: { type: Number, min: 1, max: 100, default: 1 },
  colorMode: { type: String, enum: ["bw", "color"], default: "bw" },
  sides: { type: String, enum: ["single", "duplex"], default: "single" },
  paperSize: {
    type: String,
    enum: ["A4", "A3", "Legal", "Letter", "A5"],
    default: "A4"
  },
  orientation: {
    type: String,
    enum: ["portrait", "landscape", "auto"],
    default: "auto"
  },
  pageCount: { type: Number, required: true },
  printablePageCount: { type: Number, required: true },
  amountPaise: { type: Number, default: 0 },
  currency: { type: String, default: "INR" },
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
  agentJobId: { type: String, default: null },
  spoolerJobId: { type: Number, default: null },
  leaseExpiresAt: { type: Date, default: null },
  retryCount: { type: Number, default: 0 },
  fileDeleted: { type: Boolean, default: false },
  failureReason: { type: String, default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Order", orderSchema);
