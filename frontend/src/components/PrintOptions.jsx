import React from "react";
import { Minus, Plus, Check, AlertCircle } from "lucide-react";

const ALL_PAPER_SIZES = ["A4", "A3", "Legal", "Letter", "A5"];

export default function PrintOptions({
  settings,
  onUpdateSettings,
  totalPages = 1,
  documentType = "pdf",
  maxCopies = 100,
  capabilities = null,
  customRangeError = null
}) {
  const {
    paperSize,
    colorMode,
    sides,
    orientation,
    pageSelectionMode,
    customPageRange,
    copies
  } = settings;

  const supportedPaperSizes =
    Array.isArray(capabilities?.supportedPaperSizes) &&
    capabilities.supportedPaperSizes.length > 0
      ? capabilities.supportedPaperSizes.filter((s) => ALL_PAPER_SIZES.includes(s))
      : ["A4", "Letter", "Legal", "A5"];

  const supportsColor = capabilities?.supportsColor !== false;
  const supportsDuplex =
    capabilities?.supportsDuplex !== false && documentType === "pdf" && totalPages > 1;

  const handleCopiesStep = (delta) => {
    const next = Math.min(maxCopies, Math.max(1, Number(copies || 1) + delta));
    onUpdateSettings({ copies: next });
  };

  const handleCopiesInput = (e) => {
    const raw = e.target.value;
    if (raw === "") {
      onUpdateSettings({ copies: 1 });
      return;
    }
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      onUpdateSettings({
        copies: Math.min(maxCopies, Math.max(1, parsed))
      });
    }
  };

  const colorOptions = [
    { id: "bw", title: "Black & White", desc: "Monochrome grayscale" },
    ...(supportsColor
      ? [{ id: "color", title: "Colour", desc: "Full colour output" }]
      : [])
  ];

  const sideOptions = [
    { id: "single", title: "Single-sided", desc: "One side per sheet" },
    ...(supportsDuplex
      ? [{ id: "duplex", title: "Double-sided", desc: "Both sides (Duplex)" }]
      : [])
  ];

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 divide-y divide-zinc-100">
      {/* 1. PAPER SIZE (only sizes supported by configured printer) */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          Paper Size
        </label>
        <div className="flex flex-wrap gap-2">
          {supportedPaperSizes.map((size) => {
            const active = paperSize === size;
            return (
              <button
                key={size}
                type="button"
                onClick={() => onUpdateSettings({ paperSize: size })}
                className={`min-h-[40px] px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold font-mono-code border transition ${
                  active
                    ? "border-[#8D0100] bg-[#8D0100] text-white"
                    : "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50"
                }`}
              >
                {size}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. COLOUR */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          Colour Mode
        </label>
        <div className={`grid gap-2.5 ${colorOptions.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {colorOptions.map((option) => {
            const active = colorMode === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onUpdateSettings({ colorMode: option.id })}
                className={`text-left p-3.5 rounded-xl border transition flex items-start justify-between gap-2 ${
                  active
                    ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                    : "border-zinc-200 bg-white hover:bg-zinc-50"
                }`}
              >
                <div>
                  <span className="block text-sm font-semibold text-zinc-900">
                    {option.title}
                  </span>
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    {option.desc}
                  </span>
                </div>
                {active && (
                  <span className="w-5 h-5 rounded-md bg-[#8D0100] text-white flex items-center justify-center shrink-0">
                    <Check className="w-3.5 h-3.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. PRINT SIDES */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          Print Sides
        </label>
        <div className={`grid gap-2.5 ${sideOptions.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {sideOptions.map((option) => {
            const active = sides === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onUpdateSettings({ sides: option.id })}
                className={`text-left p-3.5 rounded-xl border transition flex items-start justify-between gap-2 ${
                  active
                    ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                    : "border-zinc-200 bg-white hover:bg-zinc-50"
                }`}
              >
                <div>
                  <span className="block text-sm font-semibold text-zinc-900">
                    {option.title}
                  </span>
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    {option.desc}
                  </span>
                </div>
                {active && (
                  <span className="w-5 h-5 rounded-md bg-[#8D0100] text-white flex items-center justify-center shrink-0">
                    <Check className="w-3.5 h-3.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 4. ORIENTATION */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          Orientation
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: "auto", label: "Auto" },
            { id: "portrait", label: "Portrait" },
            { id: "landscape", label: "Landscape" }
          ].map((item) => {
            const active = orientation === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onUpdateSettings({ orientation: item.id })}
                className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs sm:text-sm font-semibold transition flex items-center justify-center gap-1.5 ${
                  active
                    ? "border-[#8D0100] bg-[#8D0100]/5 text-[#8D0100] ring-1 ring-[#8D0100]"
                    : "border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50"
                }`}
              >
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 5. PAGES (shown for PDFs) */}
      {documentType === "pdf" && (
        <div className="p-4">
          <div className="flex items-center justify-between mb-2.5">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              Pages
            </label>
            <span className="text-xs text-zinc-500 font-mono-code">
              Total: {totalPages} {totalPages === 1 ? "page" : "pages"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() =>
                onUpdateSettings({
                  pageSelectionMode: "all",
                  selectedPages: Array.from({ length: totalPages }, (_, i) => i + 1)
                })
              }
              className={`p-3.5 rounded-xl border text-left transition flex items-start justify-between gap-2 ${
                pageSelectionMode === "all"
                  ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                  : "border-zinc-200 bg-white hover:bg-zinc-50"
              }`}
            >
              <div>
                <span className="block text-sm font-semibold text-zinc-900">
                  All pages
                </span>
                <span className="block text-xs text-zinc-500 font-mono-code mt-0.5">
                  {totalPages === 1 ? "Page 1" : `1–${totalPages}`}
                </span>
              </div>
              {pageSelectionMode === "all" && (
                <span className="w-5 h-5 rounded-md bg-[#8D0100] text-white flex items-center justify-center shrink-0">
                  <Check className="w-3.5 h-3.5" />
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() =>
                onUpdateSettings({
                  pageSelectionMode: "custom",
                  customPageRange:
                    customPageRange || (totalPages > 1 ? `1-${Math.min(2, totalPages)}` : "1")
                })
              }
              className={`p-3.5 rounded-xl border text-left transition flex items-start justify-between gap-2 ${
                pageSelectionMode === "custom"
                  ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                  : "border-zinc-200 bg-white hover:bg-zinc-50"
              }`}
            >
              <div>
                <span className="block text-sm font-semibold text-zinc-900">
                  Custom range
                </span>
                <span className="block text-xs text-zinc-500 mt-0.5">
                  Specific pages
                </span>
              </div>
              {pageSelectionMode === "custom" && (
                <span className="w-5 h-5 rounded-md bg-[#8D0100] text-white flex items-center justify-center shrink-0">
                  <Check className="w-3.5 h-3.5" />
                </span>
              )}
            </button>
          </div>

          {pageSelectionMode === "custom" && (
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <label
                htmlFor="custom-page-range"
                className="block text-xs font-medium text-zinc-700 mb-1.5"
              >
                Enter page numbers or ranges
              </label>
              <input
                id="custom-page-range"
                type="text"
                inputMode="text"
                value={customPageRange}
                onChange={(e) => onUpdateSettings({ customPageRange: e.target.value })}
                placeholder="e.g. 1-5, 1,3,5, 1-3,7,9-12"
                className={`w-full min-h-[44px] px-3.5 py-2 rounded-lg border text-sm font-mono-code focus:outline-none transition ${
                  customRangeError
                    ? "border-red-400 bg-red-50/30"
                    : "border-zinc-300 bg-white focus:border-[#8D0100]"
                }`}
              />
              <p className="text-[11px] text-zinc-500 mt-1.5">
                Examples: <span className="font-mono-code">1-5</span>,{" "}
                <span className="font-mono-code">1,3,5</span>,{" "}
                <span className="font-mono-code">1-3,7,9-12</span>
              </p>

              {customRangeError && (
                <div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{customRangeError}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 6. COPIES */}
      <div className="p-4 flex items-center justify-between gap-4">
        <div>
          <span className="block text-xs font-bold uppercase tracking-wider text-zinc-500">
            Copies
          </span>
          <span className="text-xs text-zinc-500 mt-0.5 block">
            1 to {maxCopies} copies
          </span>
        </div>

        <div className="flex items-center gap-1.5 border border-zinc-200 rounded-xl p-1 bg-zinc-50">
          <button
            type="button"
            onClick={() => handleCopiesStep(-1)}
            disabled={copies <= 1}
            aria-label="Decrease copies"
            className="w-10 h-10 rounded-lg bg-white border border-zinc-200 text-zinc-800 flex items-center justify-center hover:bg-zinc-50 active:bg-zinc-100 disabled:opacity-40 disabled:pointer-events-none transition"
          >
            <Minus className="w-4 h-4" />
          </button>

          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={maxCopies}
            value={copies}
            onChange={handleCopiesInput}
            aria-label="Number of copies"
            className="w-12 text-center font-bold text-sm font-mono-code text-zinc-900 bg-transparent focus:outline-none"
          />

          <button
            type="button"
            onClick={() => handleCopiesStep(1)}
            disabled={copies >= maxCopies}
            aria-label="Increase copies"
            className="w-10 h-10 rounded-lg bg-[#8D0100] text-white flex items-center justify-center hover:bg-[#730100] active:bg-[#5e0100] disabled:opacity-40 disabled:pointer-events-none transition"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
