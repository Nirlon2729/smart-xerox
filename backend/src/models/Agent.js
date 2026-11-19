const mongoose = require("mongoose");

const detectedPrinterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    manufacturer: { type: String, default: null },
    model: { type: String, default: null },
    portName: { type: String, default: null },
    driverName: { type: String, default: null },
    connectionType: {
      type: String,
      enum: ["USB", "WIFI", "NETWORK", "SHARED", "LOCAL", "VIRTUAL", "UNKNOWN"],
      default: "USB"
    },
    printerCategory: {
      type: String,
      enum: ["PHYSICAL", "VIRTUAL", "UNKNOWN"],
      default: "PHYSICAL"
    },
    isVirtual: { type: Boolean, default: false },
    isShared: { type: Boolean, default: false },
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
        default: ["A4"]
      },
      paperSizesKnown: { type: Boolean, default: true },
      supportsBW: { type: Boolean, default: true },
      supportsColor: { type: Boolean, default: false },
      colorSupportKnown: { type: Boolean, default: true },
      supportsSingleSided: { type: Boolean, default: true },
      supportsDuplex: { type: Boolean, default: false },
      duplexSupportKnown: { type: Boolean, default: true },
      supportsCopies: { type: Boolean, default: true },
      maxCopies: { type: Number, default: 99 },
      copiesSupportKnown: { type: Boolean, default: true },
      supportedOrientations: {
        type: [String],
        default: ["portrait", "landscape"]
      },
      orientationSupportKnown: { type: Boolean, default: true },
      resolutionsDpi: {
        type: [Number],
        default: []
      }
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
    lastHeartbeatAt: {
      type: Date,
      default: null,
      index: true
    },
    connectionStatus: {
      type: String,
      enum: ["ONLINE", "OFFLINE"],
      default: "OFFLINE"
    },
    applicationStatus: {
      type: String,
      enum: ["RUNNING", "CLOSED"],
      default: "RUNNING"
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
        default: ["A4"]
      },
      paperSizesKnown: { type: Boolean, default: true },
      supportsBW: { type: Boolean, default: true },
      supportsColor: { type: Boolean, default: false },
      colorSupportKnown: { type: Boolean, default: true },
      supportsSingleSided: { type: Boolean, default: true },
      supportsDuplex: { type: Boolean, default: false },
      duplexSupportKnown: { type: Boolean, default: true },
      supportsCopies: { type: Boolean, default: true },
      maxCopies: { type: Number, default: 99 },
      copiesSupportKnown: { type: Boolean, default: true },
      supportedOrientations: {
        type: [String],
        default: ["portrait", "landscape"]
      },
      orientationSupportKnown: { type: Boolean, default: true },
      resolutionsDpi: {
        type: [Number],
        default: []
      }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Agent", agentSchema);
