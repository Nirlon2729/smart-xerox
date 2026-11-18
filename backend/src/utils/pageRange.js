/**
 * Parses and validates custom page selection strings (e.g., "1-5, 8, 11-13") or arrays of page numbers.
 * Ensures all selected pages are integers within [1, totalPages] and returns a sorted, deduplicated array.
 */
function parseAndValidatePages({ pageSelectionMode, customPageRange, selectedPages, totalPages }) {
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw Object.assign(new Error("Invalid document page count"), { statusCode: 400 });
  }

  if (pageSelectionMode === "all") {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  // If customPageRange string is provided (e.g. "1-5, 8, 10-12"), parse it strictly
  if (typeof customPageRange === "string" && customPageRange.trim().length > 0) {
    const raw = customPageRange.trim();
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);

    if (parts.length === 0) {
      throw Object.assign(new Error("Please enter at least one page or page range (e.g., 1-5, 8)."), { statusCode: 400 });
    }

    const pageSet = new Set();
    for (const part of parts) {
      if (/^\d+$/.test(part)) {
        const pageNum = Number(part);
        if (pageNum < 1 || pageNum > totalPages) {
          throw Object.assign(
            new Error(`Page ${pageNum} is out of bounds. Document has ${totalPages} page${totalPages === 1 ? "" : "s"}.`),
            { statusCode: 400 }
          );
        }
        pageSet.add(pageNum);
      } else if (/^(\d+)\s*-\s*(\d+)$/.test(part)) {
        const [, startStr, endStr] = part.match(/^(\d+)\s*-\s*(\d+)$/);
        const start = Number(startStr);
        const end = Number(endStr);
        if (start < 1 || end < 1) {
          throw Object.assign(new Error(`Invalid page range "${part}". Page numbers must start from 1.`), { statusCode: 400 });
        }
        if (start > end) {
          throw Object.assign(new Error(`Invalid page range "${part}". Start page cannot be greater than end page.`), { statusCode: 400 });
        }
        if (end > totalPages) {
          throw Object.assign(
            new Error(`Page range "${part}" exceeds document length (${totalPages} page${totalPages === 1 ? "" : "s"}).`),
            { statusCode: 400 }
          );
        }
        for (let p = start; p <= end; p++) {
          pageSet.add(p);
        }
      } else {
        throw Object.assign(
          new Error(`Invalid page format "${part}". Use numbers and ranges like 1-5, 8, 11-13.`),
          { statusCode: 400 }
        );
      }
    }

    const result = [...pageSet].sort((a, b) => a - b);
    if (result.length === 0) {
      throw Object.assign(new Error("No valid pages selected."), { statusCode: 400 });
    }
    return result;
  }

  // Otherwise validate selectedPages array
  if (Array.isArray(selectedPages) && selectedPages.length > 0) {
    const pageSet = new Set();
    for (const item of selectedPages) {
      const p = Number(item);
      if (!Number.isInteger(p) || p < 1 || p > totalPages) {
        throw Object.assign(
          new Error(`Selected page ${item} is outside the document range (1-${totalPages}).`),
          { statusCode: 400 }
        );
      }
      pageSet.add(p);
    }
    return [...pageSet].sort((a, b) => a - b);
  }

  throw Object.assign(new Error("Please select at least one page to print."), { statusCode: 400 });
}

module.exports = { parseAndValidatePages };
