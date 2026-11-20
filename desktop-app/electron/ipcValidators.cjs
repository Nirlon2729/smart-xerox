const MAX_PRINTER_NAME_LENGTH = 200;

/**
 * Strictly validates the payload for Electron IPC `printers:set-selected`.
 * - Rejects non-object/array payloads
 * - Rejects non-string, empty, control-character, or oversized (>200 chars) printerName values
 * - Requires printerName to match a non-virtual printer discovered by the trusted main process
 * Returns { valid: true, printerName: canonicalName } or { valid: false, error: string }.
 */
function validateSelectedPrinterPayload(payload, discoveredPrinters = []) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, error: "Invalid printer selection payload." };
  }

  const rawName = payload.printerName;
  if (typeof rawName !== "string") {
    return { valid: false, error: "Printer name must be a string." };
  }

  const trimmed = rawName.trim();
  if (!trimmed) {
    return { valid: false, error: "Printer name cannot be empty." };
  }

  if (trimmed.length > MAX_PRINTER_NAME_LENGTH) {
    return {
      valid: false,
      error: `Printer name exceeds maximum allowed length of ${MAX_PRINTER_NAME_LENGTH} characters.`
    };
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { valid: false, error: "Printer name contains invalid control characters." };
  }

  const list = Array.isArray(discoveredPrinters) ? discoveredPrinters : [];
  const matched = list.find((p) => {
    if (!p || typeof p.name !== "string") return false;
    if (p.isVirtual || p.printerCategory === "VIRTUAL") return false;
    return p.name.trim().toLowerCase() === trimmed.toLowerCase();
  });

  if (!matched) {
    return {
      valid: false,
      error: "Selected printer is not a recognized physical printer discovered on this computer."
    };
  }

  return { valid: true, printerName: matched.name.trim() };
}

module.exports = {
  MAX_PRINTER_NAME_LENGTH,
  validateSelectedPrinterPayload
};
