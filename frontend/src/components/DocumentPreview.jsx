import React, { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  FileText,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  Grid,
  BookOpen,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Layers
} from "lucide-react";
import { formatFileSize } from "../utils/formatters";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Paper aspect ratios (width / height in Portrait)
const PAPER_ASPECT_RATIOS = {
  A4: { widthMm: 210, heightMm: 297, ratio: 210 / 297, label: "A4 (210 × 297 mm)" },
  A3: { widthMm: 297, heightMm: 420, ratio: 297 / 420, label: "A3 (297 × 420 mm)" },
  A5: { widthMm: 148, heightMm: 210, ratio: 148 / 210, label: "A5 (148 × 210 mm)" },
  Letter: { widthMm: 216, heightMm: 279, ratio: 216 / 279, label: "Letter (8.5 × 11 in)" },
  Legal: { widthMm: 216, heightMm: 356, ratio: 216 / 356, label: "Legal (8.5 × 14 in)" },
  B5: { widthMm: 176, heightMm: 250, ratio: 176 / 250, label: "B5 (176 × 250 mm)" },
  Executive: { widthMm: 184, heightMm: 267, ratio: 184 / 267, label: "Executive (7.25 × 10.5 in)" }
};

/**
 * Renders a single PDF page from a loaded PDFDocumentProxy onto a <canvas>.
 */
function PdfPageCanvas({
  pdfDoc,
  pageNumber,
  scale = 1.0,
  colorMode = "bw",
  paperSize = "A4",
  isLandscape = false,
  isSelected = true,
  onToggleSelect = null,
  compact = false
}) {
  const canvasRef = useRef(null);
  const [rendering, setRendering] = useState(true);
  const [pageError, setPageError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask = null;

    async function renderPage() {
      if (!pdfDoc || !canvasRef.current) return;
      setRendering(true);
      setPageError(null);
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const baseTargetWidth = compact ? 180 : Math.round(460 * scale);
        const unscaledViewport = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const computedScale = (baseTargetWidth / unscaledViewport.width) * dpr;
        const viewport = page.getViewport({ scale: computedScale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

        renderTask = page.render({
          canvasContext: ctx,
          viewport
        });
        await renderTask.promise;
      } catch (err) {
        if (!cancelled && err?.name !== "RenderingCancelledException") {
          setPageError("Could not render page");
        }
      } finally {
        if (!cancelled) {
          setRendering(false);
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask && typeof renderTask.cancel === "function") {
        try {
          renderTask.cancel();
        } catch (_e) {
          // Ignore cancel errors
        }
      }
    };
  }, [pdfDoc, pageNumber, scale, compact]);

  const paperMeta = PAPER_ASPECT_RATIOS[paperSize] || PAPER_ASPECT_RATIOS.A4;
  const sheetRatio = isLandscape ? 1 / paperMeta.ratio : paperMeta.ratio;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect && onToggleSelect(pageNumber)}
        title={
          isSelected
            ? `Page ${pageNumber} (Selected for printing — click to exclude)`
            : `Page ${pageNumber} (Excluded — click to include)`
        }
        className={`group relative rounded-xl border p-2 flex flex-col items-center justify-between transition text-left ${
          isSelected
            ? "border-[#8D0100] ring-2 ring-[#8D0100]/20 bg-white shadow-2xs"
            : "border-zinc-200 bg-zinc-100/70 opacity-55 hover:opacity-90"
        }`}
      >
        <div
          style={{ aspectRatio: `${sheetRatio}` }}
          className="w-full rounded-lg bg-white border border-zinc-200 overflow-hidden flex items-center justify-center relative"
        >
          {rendering && (
            <Loader2 className="w-4 h-4 text-[#8D0100] animate-spin absolute" />
          )}
          <canvas
            ref={canvasRef}
            className={`max-w-full max-h-full object-contain transition ${
              colorMode === "bw" ? "grayscale contrast-125" : ""
            }`}
          />
        </div>

        <div className="w-full flex items-center justify-between pt-1.5 mt-1">
          <span className="text-[11px] font-mono-code font-bold text-zinc-700">
            Pg {pageNumber}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
              isSelected
                ? "bg-[#8D0100] text-white"
                : "bg-zinc-200 text-zinc-600"
            }`}
          >
            {isSelected ? "Print" : "Skip"}
          </span>
        </div>
      </button>
    );
  }

  return (
    <div
      className={`rounded-2xl border p-3 sm:p-4 transition ${
        isSelected
          ? "border-[#8D0100]/40 bg-white shadow-xs"
          : "border-zinc-300 bg-zinc-100/80 opacity-65"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-md bg-zinc-100 border border-zinc-200 text-xs font-mono-code font-bold text-zinc-800">
            Page {pageNumber}
          </span>
          <span
            className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
              isSelected
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : "bg-zinc-200 text-zinc-600 border-zinc-300"
            }`}
          >
            {isSelected ? "Included in Print Range" : "Excluded from Print"}
          </span>
        </div>

        {onToggleSelect && (
          <button
            type="button"
            onClick={() => onToggleSelect(pageNumber)}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
              isSelected
                ? "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
                : "border-[#8D0100] bg-[#8D0100] text-white"
            }`}
          >
            {isSelected ? "Exclude Page" : "Include Page"}
          </button>
        )}
      </div>

      <div className="overflow-auto rounded-xl bg-zinc-100 border border-zinc-200 p-3 sm:p-5 flex items-center justify-center min-h-[260px]">
        <div
          style={{ aspectRatio: `${sheetRatio}` }}
          className="bg-white border border-zinc-300 shadow-sm p-2 flex items-center justify-center relative transition-all"
        >
          {rendering && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10 gap-1.5">
              <Loader2 className="w-5 h-5 text-[#8D0100] animate-spin" />
              <span className="text-[11px] font-medium text-zinc-500">
                Rendering page {pageNumber}...
              </span>
            </div>
          )}
          {pageError ? (
            <span className="text-xs text-red-600 p-4">{pageError}</span>
          ) : (
            <canvas
              ref={canvasRef}
              className={`max-w-full max-h-full object-contain ${
                colorMode === "bw" ? "grayscale contrast-125" : ""
              }`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function DocumentPreview({
  file = null,
  originalName,
  fileSize = 0,
  documentType = "pdf",
  pageCount = 1,
  width = null,
  height = null,
  selectedPages = [1],
  onTogglePage = null,
  colorMode = "bw",
  sides = "single",
  paperSize = "A4",
  orientation = "auto",
  detectedOrientation = "portrait",
  previewObjectUrl = null
}) {
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [loadedPageCount, setLoadedPageCount] = useState(pageCount || 1);

  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1.0);
  const [fitMode, setFitMode] = useState("page"); // "page" | "width"
  const [viewMode, setViewMode] = useState("reader"); // "reader" | "scroll" | "grid"

  const isImage = documentType === "image";
  const effectiveOrientation =
    orientation === "auto" ? detectedOrientation || "portrait" : orientation;
  const isLandscape = effectiveOrientation === "landscape";
  const paperMeta = PAPER_ASPECT_RATIOS[paperSize] || PAPER_ASPECT_RATIOS.A4;
  const sheetRatio = isLandscape ? 1 / paperMeta.ratio : paperMeta.ratio;

  const totalPages = isImage ? 1 : Math.max(1, loadedPageCount || pageCount || 1);
  const selectedSet = new Set(selectedPages);

  // Load actual PDF using PDF.js whenever `file` or `previewObjectUrl` changes
  useEffect(() => {
    if (isImage) {
      setPdfDoc(null);
      setPdfError(null);
      setPdfLoading(false);
      return undefined;
    }

    let cancelled = false;
    let loadingTask = null;

    async function loadPdfDocument() {
      if (!file && !previewObjectUrl) return;
      setPdfLoading(true);
      setPdfError(null);
      setCurrentPage(1);

      try {
        let source;
        if (file && typeof file.arrayBuffer === "function") {
          const buf = await file.arrayBuffer();
          source = { data: new Uint8Array(buf) };
        } else if (previewObjectUrl) {
          source = { url: previewObjectUrl };
        }

        loadingTask = pdfjsLib.getDocument(source);
        const doc = await loadingTask.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setLoadedPageCount(doc.numPages || pageCount || 1);
      } catch (err) {
        if (!cancelled) {
          const errName = String(err?.name || "");
          const errMsg = String(err?.message || "");
          if (
            errName === "PasswordException" ||
            errMsg.toLowerCase().includes("password")
          ) {
            setPdfError(
              "This PDF is password-protected. Please unlock or remove the password before uploading for printing."
            );
          } else if (
            errName === "InvalidPDFException" ||
            errMsg.toLowerCase().includes("invalid pdf")
          ) {
            setPdfError(
              "This PDF file appears to be corrupted or invalid. Please verify the file and upload a valid PDF."
            );
          } else {
            setPdfError(
              "Could not render live PDF preview on this device. Your document is still staged for printing."
            );
          }
        }
      } finally {
        if (!cancelled) {
          setPdfLoading(false);
        }
      }
    }

    loadPdfDocument();

    return () => {
      cancelled = true;
      if (loadingTask && typeof loadingTask.destroy === "function") {
        try {
          loadingTask.destroy();
        } catch (_e) {
          // Ignore cleanup errors
        }
      }
    };
  }, [file, previewObjectUrl, isImage, pageCount]);

  const handleZoomIn = useCallback(() => {
    setFitMode("custom");
    setZoom((z) => Math.min(2.25, Number((z + 0.25).toFixed(2))));
  }, []);

  const handleZoomOut = useCallback(() => {
    setFitMode("custom");
    setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
  }, []);

  const handleFitToPage = useCallback(() => {
    setFitMode("page");
    setZoom(1.0);
  }, []);

  const handleFitToWidth = useCallback(() => {
    setFitMode("width");
    setZoom(1.35);
  }, []);

  /* ==========================================================================
     IMAGE PREVIEW (JPG / JPEG / PNG)
     ========================================================================== */
  if (isImage) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-100">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-[#8D0100] shrink-0" />
              <span>Live Image Print Preview ({paperSize})</span>
            </h3>
            <p className="text-xs text-zinc-600 mt-0.5 font-mono-code">
              {width && height ? `${width} × ${height} px • ` : ""}
              {fileSize ? `${formatFileSize(fileSize)} • ` : ""}
              {paperMeta.label} • {effectiveOrientation}
            </p>
          </div>

          {/* Image Zoom Controls */}
          <div className="flex items-center gap-1 bg-zinc-100 p-1 rounded-xl border border-zinc-200">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= 0.5}
              title="Zoom Out"
              className="p-1.5 rounded-lg hover:bg-white text-zinc-700 disabled:opacity-40 transition"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-[11px] font-mono-code font-bold text-zinc-800">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= 2.25}
              title="Zoom In"
              className="p-1.5 rounded-lg hover:bg-white text-zinc-700 disabled:opacity-40 transition"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={fitMode === "width" ? handleFitToPage : handleFitToWidth}
              title={fitMode === "width" ? "Fit to Page" : "Fit to Width"}
              className="px-2 py-1 rounded-lg bg-white text-zinc-800 text-[11px] font-semibold shadow-2xs inline-flex items-center gap-1"
            >
              {fitMode === "width" ? (
                <>
                  <Minimize2 className="w-3 h-3" />
                  <span>Fit Page</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3 h-3" />
                  <span>Fit Width</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Proportional Paper Sheet Simulation */}
        <div className="bg-zinc-100 rounded-xl p-4 sm:p-6 flex items-center justify-center border border-zinc-200 overflow-auto min-h-[260px]">
          <div
            style={{
              aspectRatio: `${sheetRatio}`,
              width: `${Math.round((isLandscape ? 300 : 220) * zoom)}px`
            }}
            className="bg-white border border-zinc-300 shadow-sm p-3 flex items-center justify-center transition-all shrink-0"
          >
            {previewObjectUrl ? (
              <img
                src={previewObjectUrl}
                alt={originalName || "Uploaded image"}
                className={`max-w-full max-h-full object-contain transition ${
                  colorMode === "bw" ? "grayscale contrast-125" : ""
                }`}
              />
            ) : (
              <span className="text-xs text-zinc-400">Image Preview</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 pt-1">
          <span>
            Mode:{" "}
            <strong className="text-zinc-800">
              {colorMode === "bw" ? "Black & White (Monochrome)" : "Full Colour"}
            </strong>
          </span>
          <span className="font-mono-code font-medium text-zinc-700 capitalize">
            Sheet: {paperSize} • {effectiveOrientation} (Aspect Preserved)
          </span>
        </div>
      </div>
    );
  }

  /* ==========================================================================
     PDF PREVIEW (REAL PDF.JS MULTI-PAGE RENDERER)
     ========================================================================== */
  const allPageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3.5 shadow-2xs">
      {/* Header & View Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-zinc-100">
        <div className="min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-[#8D0100] shrink-0" />
            <span>Live PDF Print Preview ({paperSize})</span>
          </h3>
          <p className="text-xs text-zinc-600 mt-0.5">
            <strong className="text-zinc-900 font-mono-code">
              {selectedPages.length}
            </strong>{" "}
            of{" "}
            <strong className="text-zinc-900 font-mono-code">{totalPages}</strong>{" "}
            {totalPages === 1 ? "page" : "pages"} selected
            {fileSize ? ` • ${formatFileSize(fileSize)}` : ""}
          </p>
        </div>

        {/* View Mode Switcher: Single Page | Scroll All | Thumbnail Grid */}
        <div className="flex items-center bg-zinc-100 p-1 rounded-xl border border-zinc-200 shrink-0">
          <button
            type="button"
            onClick={() => setViewMode("reader")}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1 transition ${
              viewMode === "reader"
                ? "bg-white text-zinc-900 shadow-2xs"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Page</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("scroll")}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1 transition ${
              viewMode === "scroll"
                ? "bg-white text-zinc-900 shadow-2xs"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Scroll ({totalPages})</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1 transition ${
              viewMode === "grid"
                ? "bg-white text-zinc-900 shadow-2xs"
                : "text-zinc-600 hover:text-zinc-900"
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            <span>Grid</span>
          </button>
        </div>
      </div>

      {/* Toolbar: Page Navigation & Zoom / Fit Controls */}
      {viewMode !== "grid" && !pdfError && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-zinc-50 p-2 rounded-xl border border-zinc-200/80">
          {/* Page Navigation */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1 || viewMode === "scroll"}
              aria-label="Previous page"
              className="px-2 py-1 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 text-xs font-semibold inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>

            <span className="px-2.5 py-1 rounded-lg bg-white border border-zinc-200 text-xs font-mono-code font-semibold text-zinc-800">
              {viewMode === "scroll"
                ? `All ${totalPages} Pages`
                : `Page ${currentPage} of ${totalPages}`}
            </span>

            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages || viewMode === "scroll"}
              aria-label="Next page"
              className="px-2 py-1 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 text-xs font-semibold inline-flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Zoom & Fit Controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleZoomOut}
              disabled={zoom <= 0.5}
              title="Zoom Out"
              className="p-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-xs font-mono-code font-bold text-zinc-800">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={handleZoomIn}
              disabled={zoom >= 2.25}
              title="Zoom In"
              className="p-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleFitToPage}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold border ${
                fitMode === "page"
                  ? "border-[#8D0100] bg-[#8D0100] text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              Fit Page
            </button>
            <button
              type="button"
              onClick={handleFitToWidth}
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold border ${
                fitMode === "width"
                  ? "border-[#8D0100] bg-[#8D0100] text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              Fit Width
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {pdfLoading && (
        <div className="py-14 flex flex-col items-center justify-center gap-2.5 bg-zinc-50 rounded-xl border border-zinc-200">
          <Loader2 className="w-7 h-7 text-[#8D0100] animate-spin" />
          <p className="text-xs font-semibold text-zinc-700">
            Processing PDF pages for live preview...
          </p>
        </div>
      )}

      {/* Corrupted / Password-Protected / Unsupported Error State */}
      {!pdfLoading && pdfError && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="text-xs font-bold text-amber-950">
              PDF Preview Notice
            </h4>
            <p className="text-xs text-amber-800 leading-relaxed">{pdfError}</p>
          </div>
        </div>
      )}

      {/* Rendered PDF Content */}
      {!pdfLoading && !pdfError && pdfDoc && (
        <>
          {viewMode === "reader" && (
            <PdfPageCanvas
              pdfDoc={pdfDoc}
              pageNumber={currentPage}
              scale={zoom}
              colorMode={colorMode}
              paperSize={paperSize}
              isLandscape={isLandscape}
              isSelected={selectedSet.has(currentPage)}
              onToggleSelect={onTogglePage}
              compact={false}
            />
          )}

          {viewMode === "scroll" && (
            <div className="max-h-[480px] overflow-y-auto space-y-3 pr-1">
              {allPageNumbers.map((pageNum) => (
                <PdfPageCanvas
                  key={pageNum}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={zoom}
                  colorMode={colorMode}
                  paperSize={paperSize}
                  isLandscape={isLandscape}
                  isSelected={selectedSet.has(pageNum)}
                  onToggleSelect={onTogglePage}
                  compact={false}
                />
              ))}
            </div>
          )}

          {viewMode === "grid" && (
            <div className="space-y-2.5">
              {onTogglePage && (
                <p className="text-[11px] text-zinc-500">
                  Tap any page thumbnail below to include or exclude it from printing:
                </p>
              )}
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 max-h-[420px] overflow-y-auto p-1">
                {allPageNumbers.map((pageNum) => (
                  <PdfPageCanvas
                    key={pageNum}
                    pdfDoc={pdfDoc}
                    pageNumber={pageNum}
                    scale={0.5}
                    colorMode={colorMode}
                    paperSize={paperSize}
                    isLandscape={isLandscape}
                    isSelected={selectedSet.has(pageNum)}
                    onToggleSelect={onTogglePage}
                    compact={true}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Footer Summary */}
      <div className="pt-2 border-t border-zinc-100 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>
            {colorMode === "bw" ? "Black & White" : "Colour"} •{" "}
            {sides === "duplex" ? "Double-sided (Duplex)" : "Single-sided"}
          </span>
        </span>
        <span className="font-mono-code font-medium text-zinc-700 capitalize">
          {paperMeta.label} • {effectiveOrientation}
        </span>
      </div>
    </div>
  );
}
