export const ALL_PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"];

export const DEFAULT_VENDOR_PRICING = {
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
    enabledPaperSizes: [...ALL_PAPER_SIZES]
  }
};

function roundCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100) / 100;
}

export function normalizeVendorPricing(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const adjSrc =
    src.paperSizeAdjustments && typeof src.paperSizeAdjustments === "object"
      ? src.paperSizeAdjustments
      : {};
  const optSrc =
    src.enabledOptions && typeof src.enabledOptions === "object"
      ? src.enabledOptions
      : {};

  const paperSizeAdjustments = {};
  for (const size of ALL_PAPER_SIZES) {
    const val = Number(adjSrc[size]);
    paperSizeAdjustments[size] =
      Number.isFinite(val) && val >= 0 ? roundCurrency(val) : 0;
  }

  let enabledPaperSizes = Array.isArray(optSrc.enabledPaperSizes)
    ? optSrc.enabledPaperSizes.filter((s) => ALL_PAPER_SIZES.includes(s))
    : [...ALL_PAPER_SIZES];
  if (enabledPaperSizes.length === 0) {
    enabledPaperSizes = ["A4"];
  }

  const bwSingleRate = Number(src.bwSingleRate);
  const colorSingleRate = Number(src.colorSingleRate);
  const bwDuplexRate = Number(src.bwDuplexRate);
  const colorDuplexRate = Number(src.colorDuplexRate);

  return {
    currency: "INR",
    currencySymbol: "₹",
    bwSingleRate:
      Number.isFinite(bwSingleRate) && bwSingleRate >= 0
        ? roundCurrency(bwSingleRate)
        : DEFAULT_VENDOR_PRICING.bwSingleRate,
    colorSingleRate:
      Number.isFinite(colorSingleRate) && colorSingleRate >= 0
        ? roundCurrency(colorSingleRate)
        : DEFAULT_VENDOR_PRICING.colorSingleRate,
    bwDuplexRate:
      Number.isFinite(bwDuplexRate) && bwDuplexRate >= 0
        ? roundCurrency(bwDuplexRate)
        : DEFAULT_VENDOR_PRICING.bwDuplexRate,
    colorDuplexRate:
      Number.isFinite(colorDuplexRate) && colorDuplexRate >= 0
        ? roundCurrency(colorDuplexRate)
        : DEFAULT_VENDOR_PRICING.colorDuplexRate,
    paperSizeAdjustments,
    enabledOptions: {
      bwSingle: optSrc.bwSingle !== false,
      colorSingle: optSrc.colorSingle !== false,
      bwDuplex: optSrc.bwDuplex !== false,
      colorDuplex: optSrc.colorDuplex !== false,
      enabledPaperSizes
    },
    updatedAt: src.updatedAt || null
  };
}

export function calculateOrderPriceQuote({
  pricing,
  logicalPagesPerCopy = 1,
  copies = 1,
  colorMode = "bw",
  sides = "single",
  paperSize = "A4"
}) {
  const norm = normalizeVendorPricing(pricing);
  const safeLogicalPages = Math.max(1, Math.floor(Number(logicalPagesPerCopy) || 1));
  const safeCopies = Math.max(1, Math.floor(Number(copies) || 1));
  const isColor = colorMode === "color";
  const isDuplex = sides === "duplex";

  const singleRate = isColor ? norm.colorSingleRate : norm.bwSingleRate;
  const duplexRate = isColor ? norm.colorDuplexRate : norm.bwDuplexRate;
  const paperSizeSurcharge = Number(norm.paperSizeAdjustments[paperSize]) || 0;

  let duplexSheetsPerCopy = 0;
  let singlePagesPerCopy = 0;
  let physicalSheetsPerCopy = 0;

  if (isDuplex) {
    duplexSheetsPerCopy = Math.floor(safeLogicalPages / 2);
    singlePagesPerCopy = safeLogicalPages % 2;
    physicalSheetsPerCopy = duplexSheetsPerCopy + singlePagesPerCopy;
  } else {
    duplexSheetsPerCopy = 0;
    singlePagesPerCopy = safeLogicalPages;
    physicalSheetsPerCopy = safeLogicalPages;
  }

  const printedSidesTotal = safeLogicalPages * safeCopies;
  const totalPhysicalSheets = physicalSheetsPerCopy * safeCopies;
  const totalDuplexSheets = duplexSheetsPerCopy * safeCopies;
  const totalSingleSheets = singlePagesPerCopy * safeCopies;

  const baseCostPerCopy = isDuplex
    ? duplexSheetsPerCopy * duplexRate + singlePagesPerCopy * singleRate
    : singlePagesPerCopy * singleRate;

  const paperSurchargePerCopy = physicalSheetsPerCopy * paperSizeSurcharge;
  const costPerCopy = roundCurrency(baseCostPerCopy + paperSurchargePerCopy);
  const totalPrice = roundCurrency(costPerCopy * safeCopies);

  const modeLabel = `${isColor ? "Colour" : "Black & White"} • ${
    isDuplex ? "Duplex (Double-sided)" : "Single-sided"
  }`;

  return {
    currency: norm.currency,
    currencySymbol: norm.currencySymbol,
    modeLabel,
    colorMode: isColor ? "color" : "bw",
    sides: isDuplex ? "duplex" : "single",
    paperSize: paperSize || "A4",
    logicalPagesPerCopy: safeLogicalPages,
    printedSidesTotal,
    physicalSheetsPerCopy,
    totalPhysicalSheets,
    duplexSheetsPerCopy,
    singlePagesPerCopy,
    totalDuplexSheets,
    totalSingleSheets,
    copies: safeCopies,
    appliedSingleRate: singleRate,
    appliedDuplexRate: duplexRate,
    paperSizeSurcharge,
    costPerCopy,
    totalPrice
  };
}
