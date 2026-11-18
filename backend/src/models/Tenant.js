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
