const mongoose = require("mongoose");

const capabilityOverrideSchema = new mongoose.Schema(
  {
    useManualOverride: { type: Boolean, default: false },
    supportedPaperSizes: {
      type: [String],
      default: ["A4", "Letter", "Legal", "A5"]
    },
    supportsColor: { type: Boolean, default: false },
    supportsDuplex: { type: Boolean, default: false }
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      unique: true,
      index: true
    },
    shopName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    name: {
      type: String,
      trim: true
    },
    shopSlug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    slug: {
      type: String,
      lowercase: true,
      trim: true,
      index: true
    },
    logoUrl: {
      type: String,
      default: null
    },
    phone: {
      type: String,
      default: null,
      trim: true
    },
    address: {
      type: String,
      default: null,
      trim: true
    },
    status: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED"],
      default: "ACTIVE",
      index: true
    },
    selectedPrinterName: {
      type: String,
      default: null
    },
    autoSelectSinglePrinter: {
      type: Boolean,
      default: true
    },
    capabilityOverrides: {
      type: capabilityOverrideSchema,
      default: () => ({
        useManualOverride: false,
        supportedPaperSizes: ["A4", "Letter", "Legal", "A5"],
        supportsColor: false,
        supportsDuplex: false
      })
    },
    config: {
      maxUploadMb: { type: Number, default: 20, min: 1, max: 100 },
      maxCopies: { type: Number, default: 100, min: 1, max: 1000 },
      acceptingOrders: { type: Boolean, default: true }
    },
    pricing: {
      currency: { type: String, default: "INR" },
      currencySymbol: { type: String, default: "₹" },
      bwSingleRate: { type: Number, default: 2, min: 0 },
      colorSingleRate: { type: Number, default: 5, min: 0 },
      bwDuplexRate: { type: Number, default: 3, min: 0 },
      colorDuplexRate: { type: Number, default: 8, min: 0 },
      paperSizeAdjustments: {
        A4: { type: Number, default: 0, min: 0 },
        A3: { type: Number, default: 0, min: 0 },
        A5: { type: Number, default: 0, min: 0 },
        Letter: { type: Number, default: 0, min: 0 },
        Legal: { type: Number, default: 0, min: 0 },
        B5: { type: Number, default: 0, min: 0 },
        Executive: { type: Number, default: 0, min: 0 }
      },
      enabledOptions: {
        bwSingle: { type: Boolean, default: true },
        colorSingle: { type: Boolean, default: true },
        bwDuplex: { type: Boolean, default: true },
        colorDuplex: { type: Boolean, default: true },
        enabledPaperSizes: {
          type: [String],
          default: ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"]
        }
      },
      updatedAt: { type: Date, default: Date.now }
    },
    availability: {
      calculatedStatus: {
        type: String,
        enum: ["AVAILABLE", "UNAVAILABLE"],
        default: "UNAVAILABLE"
      },
      unavailableReason: { type: String, default: null },
      lastStatusUpdateAt: { type: Date, default: Date.now }
    }
  },
  { timestamps: true }
);

tenantSchema.pre("validate", function (next) {
  if (!this.tenantId && this._id) {
    this.tenantId = this._id.toString();
  }
  if (!this.shopSlug && this.slug) {
    this.shopSlug = this.slug;
  }
  if (this.shopSlug && !this.slug) {
    this.slug = this.shopSlug;
  }
  if (!this.shopName && this.name) {
    this.shopName = this.name;
  }
  if (this.shopName && !this.name) {
    this.name = this.shopName;
  }
  next();
});

module.exports = mongoose.model("Tenant", tenantSchema);
