/**
 * Formats byte size into human-readable KB / MB string.
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/**
 * Formats integer paise (e.g. 1200) or rupees into standard Indian Rupee currency format (₹12.00).
 */
export function formatPaiseToINR(paise) {
  if (typeof paise !== "number" || Number.isNaN(paise)) return "₹0.00";
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: rupees % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(rupees);
}

/**
 * Formats an array of sorted page numbers into a compact human-readable range string (e.g., [1,2,3,5,8,9] -> "1-3, 5, 8-9").
 */
export function summarizeSelectedPages(selectedPages, totalPages) {
  if (!Array.isArray(selectedPages) || selectedPages.length === 0) return "None";
  if (totalPages && selectedPages.length === totalPages) {
    return totalPages === 1 ? "Page 1 (All)" : `All Pages (1–${totalPages})`;
  }

  const sorted = [...new Set(selectedPages)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    if (current === prev + 1) {
      prev = current;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = current;
      prev = current;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);

  const joined = ranges.join(", ");
  return joined.length > 36 ? `${joined.slice(0, 34)}…` : joined;
}

/**
 * Client-side validation helper for custom page range inputs before sending to backend.
 */
export function validateCustomPageRangeInput(input, totalPages) {
  const raw = String(input || "").trim();
  if (!raw) {
    return { valid: false, error: "Enter page numbers or ranges (e.g., 1-5, 8)" };
  }

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { valid: false, error: "Enter at least one page number" };
  }

  const pages = new Set();
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const num = Number(part);
      if (num < 1) return { valid: false, error: "Page numbers must start from 1" };
      if (totalPages && num > totalPages) {
        return { valid: false, error: `Page ${num} exceeds total pages (${totalPages})` };
      }
      pages.add(num);
    } else if (/^(\d+)\s*-\s*(\d+)$/.test(part)) {
      const [, s, e] = part.match(/^(\d+)\s*-\s*(\d+)$/);
      const start = Number(s);
      const end = Number(e);
      if (start < 1 || end < 1) {
        return { valid: false, error: `Invalid range "${part}". Pages start from 1.` };
      }
      if (start > end) {
        return { valid: false, error: `Invalid range "${part}": start page is greater than end page.` };
      }
      if (totalPages && end > totalPages) {
        return { valid: false, error: `Range "${part}" exceeds document pages (${totalPages}).` };
      }
      for (let p = start; p <= end; p++) pages.add(p);
    } else {
      return { valid: false, error: `Invalid format "${part}". Example: 1-5, 8, 10-12` };
    }
  }

  const sorted = [...pages].sort((a, b) => a - b);
  return { valid: true, pages: sorted, error: null };
}
