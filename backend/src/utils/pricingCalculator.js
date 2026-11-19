const VALID_PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"];

const DEFAULT_VENDOR_PRICING = {
  currency: "INR",
  currencySymbol: "₹",
  bwSingleRate: 2,
  colorSingleRate: 5,
  bwDuplexRate: 3,
  colorDuplexRate: 8,
  paperSizeAdjustments: {
    A4: 0,
    A3: 0,
    A5: 0,
    Letter: 0,
    Legal: 0,
    B5: 0,
    Executive: 0
  },
  enabledOptions: {
    bwSingle: true,
    colorSingle: true,
    bwDuplex: true,
    colorDuplex: true,
    enabledPaperSizes: ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"]
  }
};

function sanitizeNonNegativeRate(val, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0 || num > 10000) {
    return fallback;
  }
  return Number(num.toFixed(2));
}

function normalizeVendorPricing(rawPricing = {}) {
  const src = rawPricing && typeof rawPricing === "object" ? rawPricing : {};
  const bwSingleRate = sanitizeNonNegativeRate(
    src.bwSingleRate,
    DEFAULT_VENDOR_PRICING.bwSingleRate
  );
  const colorSingleRate = sanitizeNonNegativeRate(
    src.colorSingleRate,
    DEFAULT_VENDOR_PRICING.colorSingleRate
  );
  const bwDuplexRate = sanitizeNonNegativeRate(
    src.bwDuplexRate,
    DEFAULT_VENDOR_PRICING.bwDuplexRate
  );
  const colorDuplexRate = sanitizeNonNegativeRate(
    src.colorDuplexRate,
    DEFAULT_VENDOR_PRICING.colorDuplexRate
  );

  const rawAdjustments =
    src.paperSizeAdjustments && typeof src.paperSizeAdjustments === "object"
      ? src.paperSizeAdjustments
      : {};
  const paperSizeAdjustments = {};
  for (const sz of VALID_PAPER_SIZES) {
    paperSizeAdjustments[sz] = sanitizeNonNegativeRate(rawAdjustments[sz], 0);
  }

  const rawEnabled =
    src.enabledOptions && typeof src.enabledOptions === "object"
      ? src.enabledOptions
      : {};
  const enabledPaperSizes = Array.isArray(rawEnabled.enabledPaperSizes)
    ? rawEnabled.enabledPaperSizes.filter((s) => VALID_PAPER_SIZES.includes(s))
    : [...VALID_PAPER_SIZES];

  return {
    currency: "INR",
    currencySymbol: "₹",
    bwSingleRate,
    colorSingleRate,
    bwDuplexRate,
    colorDuplexRate,
    paperSizeAdjustments,
    enabledOptions: {
      bwSingle: rawEnabled.bwSingle !== false,
      colorSingle: rawEnabled.colorSingle !== false,
      bwDuplex: rawEnabled.bwDuplex !== false,
      colorDuplex: rawEnabled.colorDuplex !== false,
      enabledPaperSizes: enabledPaperSizes.length > 0 ? enabledPaperSizes : ["A4"]
    },
    updatedAt: src.updatedAt || null
  };
}

/**
 * Validates whether a requested print combination (colorMode, sides, paperSize)
 * is enabled in the vendor's pricing configuration.
 */
function validatePricingOptionEnabled(pricingConfig, { colorMode = "bw", sides = "single", paperSize = "A4" }) {
  const normalized = normalizeVendorPricing(pricingConfig);
  const eo = normalized.enabledOptions;

  if (!eo.enabledPaperSizes.includes(paperSize)) {
    return {
      allowed: false,
      reason: `Paper size ${paperSize} is currently disabled by this shop.`
    };
  }

  const isColor = colorMode === "color";
  const isDuplex = sides === "duplex";

  if (!isColor && !isDuplex && !eo.bwSingle) {
    return {
      allowed: false,
      reason: "Black & White Single-sided printing is currently disabled by this shop."
    };
  }
  if (isColor && !isDuplex && !eo.colorSingle) {
    return {
      allowed: false,
      reason: "Colour Single-sided printing is currently disabled by this shop."
    };
  }
  if (!isColor && isDuplex && !eo.bwDuplex) {
    return {
      allowed: false,
      reason: "Black & White Duplex (double-sided) printing is currently disabled by this shop."
    };
  }
  if (isColor && isDuplex && !eo.colorDuplex) {
    return {
      allowed: false,
      reason: "Colour Duplex (double-sided) printing is currently disabled by this shop."
    };
  }

  return { allowed: true, reason: null };
}

/**
 * Shared deterministic pricing calculator for a single print order.
 * Distinguishes:
 * - logicalPagesPerCopy (number of selected document pages per copy)
 * - printedSidesTotal (logicalPagesPerCopy * copies)
 * - physicalSheetsPerCopy (Math.ceil(logicalPagesPerCopy / 2) for duplex, logicalPagesPerCopy for single-sided)
 * - totalPhysicalSheets (physicalSheetsPerCopy * copies)
 * - duplexSheetsPerCopy (Math.floor(logicalPagesPerCopy / 2) full front-and-back sheets charged at duplexRate)
 * - singlePagesPerCopy (remaining odd page charged at singleRate, or all pages when single-sided)
 */
function calculateOrderPriceQuote(
  pricingConfig,
  {
    selectedPageCount = 1,
    copies = 1,
    colorMode = "bw",
    sides = "single",
    paperSize = "A4",
    documentType = "pdf"
  } = {}
) {
  const pricing = normalizeVendorPricing(pricingConfig);
  const logicalPagesPerCopy = Math.max(1, Math.floor(Number(selectedPageCount) || 1));
  const cleanCopies = Math.max(1, Math.floor(Number(copies) || 1));
  const isColor = colorMode === "color";
  const effectiveSides =
    documentType === "image" || logicalPagesPerCopy === 1
      ? "single"
      : sides === "duplex"
        ? "duplex"
        : "single";

  const singleRate = isColor ? pricing.colorSingleRate : pricing.bwSingleRate;
  const duplexRate = isColor ? pricing.colorDuplexRate : pricing.bwDuplexRate;
  const paperSizeSurcharge = Number(pricing.paperSizeAdjustments?.[paperSize]) || 0;

  let duplexSheetsPerCopy = 0;
  let singlePagesPerCopy = logicalPagesPerCopy;
  let physicalSheetsPerCopy = logicalPagesPerCopy;

  if (effectiveSides === "duplex") {
    duplexSheetsPerCopy = Math.floor(logicalPagesPerCopy / 2);
    singlePagesPerCopy = logicalPagesPerCopy % 2;
    physicalSheetsPerCopy = duplexSheetsPerCopy + singlePagesPerCopy;
  }

  const basePrintCostPerCopy =
    duplexSheetsPerCopy * duplexRate + singlePagesPerCopy * singleRate;
  const paperSurchargePerCopy = physicalSheetsPerCopy * paperSizeSurcharge;
  const costPerCopy = Number((basePrintCostPerCopy + paperSurchargePerCopy).toFixed(2));
  const totalPrice = Number((costPerCopy * cleanCopies).toFixed(2));
  const amountPaise = Math.round(totalPrice * 100);
  const printedSidesTotal = logicalPagesPerCopy * cleanCopies;
  const totalPhysicalSheets = physicalSheetsPerCopy * cleanCopies;

  const modeTitle = isColor ? "Colour" : "Black & White";
  const unitRateLabel =
    effectiveSides === "duplex"
      ? `₹${duplexRate} per duplex sheet (2 sides)${
          singlePagesPerCopy > 0 ? ` + ₹${singleRate} odd page` : ""
        }`
      : `₹${singleRate} per printed page`;

  const breakdownText =
    effectiveSides === "duplex"
      ? `${duplexSheetsPerCopy} duplex ${
          duplexSheetsPerCopy === 1 ? "sheet" : "sheets"
        } × ₹${duplexRate}${
          singlePagesPerCopy > 0 ? ` + 1 single page × ₹${singleRate}` : ""
        }${paperSizeSurcharge > 0 ? ` (+₹${paperSizeSurcharge}/sheet ${paperSize})` : ""} × ${cleanCopies} ${
          cleanCopies === 1 ? "copy" : "copies"
        }`
      : `${logicalPagesPerCopy} ${
          logicalPagesPerCopy === 1 ? "page" : "pages"
        } × ₹${singleRate}${
          paperSizeSurcharge > 0 ? ` (+₹${paperSizeSurcharge}/sheet ${paperSize})` : ""
        } × ${cleanCopies} ${cleanCopies === 1 ? "copy" : "copies"}`;

  return {
    currency: "INR",
    currencySymbol: "₹",
    colorMode: isColor ? "color" : "bw",
    modeTitle,
    sides: effectiveSides,
    paperSize,
    logicalPagesPerCopy,
    printedSidesTotal,
    physicalSheetsPerCopy,
    totalPhysicalSheets,
    duplexSheetsPerCopy,
    singlePagesPerCopy,
    copies: cleanCopies,
    appliedSingleRate: singleRate,
    appliedDuplexRate: duplexRate,
    paperSizeSurcharge,
    unitRateLabel,
    breakdownText,
    costPerCopy,
    totalPrice,
    amountPaise,
    calculatedAt: new Date().toISOString()
  };
}

module.exports = {
  VALID_PAPER_SIZES,
  DEFAULT_VENDOR_PRICING,
  normalizeVendorPricing,
  validatePricingOptionEnabled,
  calculateOrderPriceQuote
};
