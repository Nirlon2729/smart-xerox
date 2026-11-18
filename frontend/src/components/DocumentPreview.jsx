import React, { useState } from "react";
import { Eye, Grid, FileText, Image as ImageIcon, ExternalLink } from "lucide-react";

/**
 * Displays page thumbnails and PDF preview for PDFs, or a live oriented sheet preview for images (JPG/PNG).
 */
export default function DocumentPreview({
  originalName,
  documentType = "pdf",
  pageCount = 1,
  selectedPages = [1],
  colorMode = "bw",
  sides = "single",
  paperSize = "A4",
  orientation = "auto",
  detectedOrientation = "portrait",
  previewObjectUrl = null
}) {
  const [viewMode, setViewMode] = useState("thumbnails");
  const [showAllThumbnails, setShowAllThumbnails] = useState(false);

  const isImage = documentType === "image";
  const effectiveOrientation =
    orientation === "auto" ? detectedOrientation || "portrait" : orientation;
  const isLandscape = effectiveOrientation === "landscape";

  const selectedSet = new Set(selectedPages);
  const maxVisible = showAllThumbnails ? Math.min(pageCount, 120) : Math.min(pageCount, 8);
  const visiblePages = Array.from({ length: maxVisible }, (_, i) => i + 1);

  if (isImage) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-[#8D0100] shrink-0" />
            <span>Image Print Layout ({paperSize})</span>
          </h3>
          <span className="text-xs font-mono-code font-medium text-zinc-600 capitalize">
            {effectiveOrientation}
          </span>
        </div>

        <div className="bg-zinc-100 rounded-xl p-4 flex items-center justify-center border border-zinc-200">
          <div
            className={`bg-white border border-zinc-300 shadow-xs p-3 flex items-center justify-center transition-all ${
              isLandscape
                ? "w-full max-w-[280px] aspect-[1.414/1]"
                : "w-48 sm:w-52 aspect-[1/1.414]"
            }`}
          >
            {previewObjectUrl ? (
              <img
                src={previewObjectUrl}
                alt={originalName || "Uploaded image"}
                className={`max-w-full max-h-full object-contain ${
                  colorMode === "bw" ? "grayscale contrast-125" : ""
                }`}
              />
            ) : (
              <span className="text-xs text-zinc-400">Image Preview</span>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
          <span>
            {colorMode === "bw" ? "Black & White" : "Colour"} • Fitted to {paperSize}
          </span>
          <span className="font-mono-code capitalize">{effectiveOrientation} sheet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-[#8D0100] shrink-0" />
            <span>PDF Preview</span>
          </h3>
          <p className="text-xs text-zinc-600 mt-0.5">
            <span className="font-semibold text-zinc-900 font-mono-code">
              {selectedPages.length}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-zinc-900 font-mono-code">
              {pageCount}
            </span>{" "}
            {pageCount === 1 ? "page" : "pages"} selected
          </p>
        </div>

        {previewObjectUrl && (
          <div className="flex items-center bg-zinc-100 p-0.5 rounded-lg border border-zinc-200 shrink-0">
            <button
              type="button"
              onClick={() => setViewMode("thumbnails")}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition ${
                viewMode === "thumbnails"
                  ? "bg-white text-zinc-900 shadow-2xs"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
              <span>Pages</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("pdf")}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition ${
                viewMode === "pdf"
                  ? "bg-white text-zinc-900 shadow-2xs"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Document</span>
            </button>
          </div>
        )}
      </div>

      {viewMode === "pdf" && previewObjectUrl ? (
        <div className="space-y-2">
          <div className="w-full h-64 sm:h-72 rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50">
            <iframe
              src={`${previewObjectUrl}#toolbar=0&navpanes=0`}
              title={originalName || "PDF Preview"}
              className={`w-full h-full border-0 ${colorMode === "bw" ? "grayscale" : ""}`}
            />
          </div>
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              {colorMode === "bw" ? "Black & White preview" : "Colour preview"}
            </span>
            <a
              href={previewObjectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-[#8D0100] hover:underline"
            >
              <span>Open Full PDF</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {visiblePages.map((pageNumber) => {
              const isSelected = selectedSet.has(pageNumber);
              return (
                <div
                  key={pageNumber}
                  className={`${
                    isLandscape ? "aspect-[1.35/1]" : "aspect-[1/1.35]"
                  } rounded-lg border p-2 flex flex-col justify-between transition ${
                    isSelected
                      ? "border-[#8D0100] bg-white"
                      : "border-zinc-200 bg-zinc-50 opacity-45"
                  }`}
                >
                  <div className="space-y-1 mt-0.5">
                    <div
                      className={`h-1 w-3/4 rounded-xs ${
                        !isSelected
                          ? "bg-zinc-300"
                          : colorMode === "color"
                            ? "bg-[#8D0100]"
                            : "bg-zinc-700"
                      }`}
                    />
                    <div className="h-1 w-full rounded-xs bg-zinc-200" />
                    <div className="h-1 w-4/5 rounded-xs bg-zinc-200" />
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-zinc-100">
                    <span className="text-[10px] font-semibold font-mono-code text-zinc-600">
                      {pageNumber}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isSelected ? "bg-[#8D0100]" : "bg-zinc-300"
                      }`}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {pageCount > 8 && (
            <div className="mt-2.5 text-center">
              <button
                type="button"
                onClick={() => setShowAllThumbnails((prev) => !prev)}
                className="text-xs font-semibold text-[#8D0100] hover:underline py-1"
              >
                {showAllThumbnails
                  ? "Show fewer pages"
                  : `Show all ${pageCount} pages`}
              </button>
            </div>
          )}

          <div className="mt-3 pt-2.5 border-t border-zinc-100 flex items-center justify-between text-xs text-zinc-500">
            <span>
              {colorMode === "bw" ? "Black & White" : "Colour"} •{" "}
              {sides === "duplex" ? "Double-sided" : "Single-sided"}
            </span>
            <span className="font-mono-code font-medium text-zinc-700 capitalize">
              {paperSize} • {effectiveOrientation}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
