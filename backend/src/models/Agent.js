const mongoose = require("mongoose");

const detectedPrinterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    portName: { type: String, default: null },
    driverName: { type: String, default: null },
    connectionType: {
      type: String,
      enum: ["USB", "NETWORK", "LOCAL", "UNKNOWN"],
      default: "USB"
    },
    isDefault: { type: Boolean, default: false },
    printerAvailable: { type: Boolean, default: false },
    workOffline: { type: Boolean, default: false },
    driverMissing: { type: Boolean, default: false },
    capabilitiesDetected: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["READY", "ONLINE", "PRINTING", "OFFLINE", "ERROR"],
      default: "OFFLINE"
    },
    statusMessage: { type: String, default: null },
    spoolerJobCount: { type: Number, default: 0 },
    capabilities: {
      supportedPaperSizes: {
        type: [String],
        default: ["A4", "Letter", "Legal", "A5"]
      },
      supportsColor: { type: Boolean, default: false },
      supportsDuplex: { type: Boolean, default: false }
    }
  },
  { _id: false }
);

const agentSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
      index: true
    },
    agentId: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    secretHash: {
      type: String,
      default: null,
      select: false
    },
    pairedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null
    },
    pairedAt: {
      type: Date,
      default: null
    },
    revokedAt: {
      type: Date,
      default: null
    },
    name: {
      type: String,
      default: "Smart Xerox Windows Desktop Host"
    },
    hostname: {
      type: String,
      default: null
    },
    osVersion: {
      type: String,
      default: null
    },
    deviceId: {
      type: String,
      required: true,
      index: true
    },
    agentVersion: {
      type: String,
      default: "3.0.0"
    },
    printerName: {
      type: String,
      default: "No Printer Selected"
    },
    portName: {
      type: String,
      default: null
    },
    driverName: {
      type: String,
      default: null
    },
    driverMissing: {
      type: Boolean,
      default: false
    },
    printerAvailable: {
      type: Boolean,
      default: false
    },
    availablePrinters: {
      type: [detectedPrinterSchema],
      default: []
    },
    active: {
      type: Boolean,
      default: true
    },
    lastSeenAt: {
      type: Date,
      default: null
    },
    lastStatus: {
      type: String,
      enum: ["READY", "ONLINE", "PRINTING", "OFFLINE", "ERROR"],
      default: "OFFLINE"
    },
    statusMessage: {
      type: String,
      default: null
    },
    spoolerJobCount: {
      type: Number,
      default: 0
    },
    capabilities: {
      supportedPaperSizes: {
        type: [String],
        default: ["A4", "Letter", "Legal", "A5"]
      },
      supportsColor: { type: Boolean, default: false },
      supportsDuplex: { type: Boolean, default: false }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Agent", agentSchema);
