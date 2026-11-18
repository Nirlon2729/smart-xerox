const mongoose = require("mongoose");

const agentSchema = new mongoose.Schema({
  name: { type: String, default: "Windows 11 USB Print Host" },
  deviceId: { type: String, required: true, unique: true },
  agentVersion: { type: String, default: "2.0.0" },
  printerName: { type: String, required: true },
  portName: { type: String, default: null },
  driverName: { type: String, default: null },
  printerAvailable: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  lastSeenAt: { type: Date, default: null },
  lastStatus: {
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
}, { timestamps: true });

module.exports = mongoose.model("Agent", agentSchema);
