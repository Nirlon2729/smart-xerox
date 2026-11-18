const crypto = require("crypto");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Inspects a JPEG buffer to verify SOI/EOI markers and extract pixel dimensions from SOF segments.
 */
function inspectJpegBuffer(buffer) {
  if (buffer.length < 24 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw Object.assign(new Error("Invalid or corrupted JPEG image."), { statusCode: 400 });
  }

  let offset = 2;
  let width = null;
  let height = null;

  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset++;
      marker = buffer[offset + 1];
    }

    // Standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 markers contain image height & width
    const isSofMarker =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSofMarker && offset + 9 <= buffer.length) {
      height = buffer.readUInt16BE(offset + 5);
      width = buffer.readUInt16BE(offset + 7);
      break;
    }

    offset += 2 + segmentLength;
  }

  if (!width || !height || width < 1 || height < 1) {
    throw Object.assign(new Error("Could not read JPEG image dimensions. File may be corrupted."), {
      statusCode: 400
    });
  }

  return { width, height };
}

/**
 * Inspects a PNG buffer to verify the 8-byte PNG signature and IHDR dimensions.
 */
function inspectPngBuffer(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw Object.assign(new Error("Invalid or corrupted PNG image."), { statusCode: 400 });
  }

  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    throw Object.assign(new Error("Invalid PNG structure (missing IHDR header)."), { statusCode: 400 });
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  if (!width || !height || width < 1 || height < 1 || width > 25000 || height > 25000) {
    throw Object.assign(new Error("Invalid PNG image dimensions."), { statusCode: 400 });
  }

  return { width, height };
}

/**
 * Inspects a PDF buffer to verify %PDF- header, %%EOF marker, unencrypted status, and true page count.
 */
function inspectPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    throw Object.assign(new Error("Uploaded PDF file is empty or corrupted."), { statusCode: 400 });
  }

  const headerSlice = buffer.subarray(0, Math.min(1024, buffer.length)).toString("latin1");
  if (!headerSlice.includes("%PDF-")) {
    throw Object.assign(new Error("Invalid PDF signature. File is not a genuine PDF."), {
      statusCode: 400
    });
  }

  const rawContent = buffer.toString("latin1");

  if (!rawContent.includes("%%EOF")) {
    throw Object.assign(new Error("The PDF file appears to be incomplete or truncated."), {
      statusCode: 400
    });
  }

  if (/\/Encrypt\b/.test(rawContent)) {
    throw Object.assign(
      new Error("Password-protected or encrypted PDFs cannot be printed. Please upload an unlocked PDF."),
      { statusCode: 400 }
    );
  }

  const leafPageMatches = rawContent.match(/\/Type\s*\/Page\b(?!s)/g);
  const leafCount = leafPageMatches ? leafPageMatches.length : 0;

  let maxTreeCount = 0;
  const pagesDictRegex = /<<[\s\S]*?\/Type\s*\/Pages\b[\s\S]*?>>/g;
  let match;
  while ((match = pagesDictRegex.exec(rawContent)) !== null) {
    const countMatch = match[0].match(/\/Count\s+(\d+)/);
    if (countMatch) {
      const countVal = parseInt(countMatch[1], 10);
      if (Number.isInteger(countVal) && countVal > maxTreeCount) {
        maxTreeCount = countVal;
      }
    }
  }

  if (maxTreeCount === 0) {
    const allCounts = [...rawContent.matchAll(/\/Count\s+(\d+)/g)].map((m) => parseInt(m[1], 10));
    if (allCounts.length > 0) {
      maxTreeCount = Math.max(...allCounts.filter((n) => Number.isFinite(n) && n > 0 && n <= 5000));
    }
  }

  const pageCount = leafCount > 0 ? Math.max(leafCount, maxTreeCount) : maxTreeCount;
  if (!pageCount || pageCount < 1) {
    throw Object.assign(
      new Error("Could not determine page count from this PDF. Verify the PDF contains at least 1 page."),
      { statusCode: 400 }
    );
  }

  const maxAllowedPages = Number(process.env.MAX_PDF_PAGES) || 500;
  if (pageCount > maxAllowedPages) {
    throw Object.assign(
      new Error(`Document has ${pageCount} pages, exceeding the limit of ${maxAllowedPages} pages.`),
      { statusCode: 400 }
    );
  }

  return { pageCount };
}

/**
 * Validates actual binary file contents (not just extension/MIME) for PDF, JPG, JPEG, and PNG.
 * Returns normalized metadata and SHA-256 content hash.
 */
function inspectUploadedBuffer(buffer, originalName = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("Uploaded file is empty."), { statusCode: 400 });
  }

  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 20;
  if (buffer.length > maxUploadMb * 1024 * 1024) {
    throw Object.assign(
      new Error(`File exceeds maximum allowed size of ${maxUploadMb} MB.`),
      { statusCode: 413 }
    );
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // 1. Check PNG signature
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    const { width, height } = inspectPngBuffer(buffer);
    return {
      valid: true,
      documentType: "image",
      mimeType: "image/png",
      extension: "png",
      pageCount: 1,
      width,
      height,
      detectedOrientation: width > height ? "landscape" : "portrait",
      fileSize: buffer.length,
      sha256,
      originalName: originalName || "image.png"
    };
  }

  // 2. Check JPEG signature (FF D8 FF)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const { width, height } = inspectJpegBuffer(buffer);
    return {
      valid: true,
      documentType: "image",
      mimeType: "image/jpeg",
      extension: "jpg",
      pageCount: 1,
      width,
      height,
      detectedOrientation: width > height ? "landscape" : "portrait",
      fileSize: buffer.length,
      sha256,
      originalName: originalName || "image.jpg"
    };
  }

  // 3. Check PDF signature (%PDF-)
  const headerSlice = buffer.subarray(0, Math.min(1024, buffer.length)).toString("latin1");
  if (headerSlice.includes("%PDF-")) {
    const { pageCount } = inspectPdfBuffer(buffer);
    return {
      valid: true,
      documentType: "pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      pageCount,
      width: null,
      height: null,
      detectedOrientation: "portrait",
      fileSize: buffer.length,
      sha256,
      originalName: originalName || "document.pdf"
    };
  }

  throw Object.assign(
    new Error("Unsupported or invalid file content. Only genuine PDF, JPG, JPEG, and PNG files are allowed."),
    { statusCode: 400 }
  );
}

module.exports = {
  inspectUploadedBuffer,
  inspectPdfBuffer,
  inspectJpegBuffer,
  inspectPngBuffer
};
