import React from "react";
import { Minus, Plus, Check, AlertCircle, IndianRupee } from "lucide-react";

const ALL_PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"];

export default function PrintOptions({
  settings,
  onUpdateSettings,
  totalPages = 1,
  documentType = "pdf",
  maxCopies = 100,
  capabilities = null,
  pricing = null,
  priceQuote = null,
  customRangeError = null
}) {
  const {
    paperSize,
    colorMode,
    sides,
    orientation,
    pageSelectionMode,
    customPageRange,
    selectedPages = [1],
    copies
  } = settings;

  const vendorEnabledOpts = pricing?.enabledOptions || {};
  const vendorEnabledSizes = Array.isArray(vendorEnabledOpts.enabledPaperSizes)
    ? vendorEnabledOpts.enabledPaperSizes
    : ALL_PAPER_SIZES;

  const rawCapSizes =
    Array.isArray(capabilities?.supportedPaperSizes) &&
    capabilities.supportedPaperSizes.length > 0
      ? capabilities.supportedPaperSizes.filter((s) => ALL_PAPER_SIZES.includes(s))
      : ["A4"];

  const intersectedSizes = rawCapSizes.filter((s) => vendorEnabledSizes.includes(s));
  const supportedPaperSizes = intersectedSizes.length > 0 ? intersectedSizes : rawCapSizes;

  const supportsBw =
    sides === "duplex"
      ? vendorEnabledOpts.bwDuplex !== false
      : vendorEnabledOpts.bwSingle !== false;

  const supportsColor =
    Boolean(capabilities?.supportsColor) &&
    (sides === "duplex"
      ? vendorEnabledOpts.colorDuplex !== false
      : vendorEnabledOpts.colorSingle !== false);

  const supportsSingle =
    colorMode === "color"
      ? vendorEnabledOpts.colorSingle !== false
      : vendorEnabledOpts.bwSingle !== false;

  const supportsDuplex =
    Boolean(capabilities?.supportsDuplex) &&
    documentType === "pdf" &&
    totalPages > 1 &&
    (colorMode === "color"
      ? vendorEnabledOpts.colorDuplex !== false
      : vendorEnabledOpts.bwDuplex !== false);

  const bwSingleRate = Number(pricing?.bwSingleRate ?? 2);
  const colorSingleRate = Number(pricing?.colorSingleRate ?? 5);
  const bwDuplexRate = Number(pricing?.bwDuplexRate ?? 3);
  const colorDuplexRate = Number(pricing?.colorDuplexRate ?? 8);

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

  const handleTogglePageNumber = (pageNum) => {
    const currentSet = new Set(selectedPages);
    if (currentSet.has(pageNum)) {
      if (currentSet.size <= 1) return; // Keep at least 1 page selected
      currentSet.delete(pageNum);
    } else {
      currentSet.add(pageNum);
    }
    const sorted = [...currentSet].sort((a, b) => a - b);
    onUpdateSettings({
      pageSelectionMode: "selected",
      selectedPages: sorted,
      customPageRange: sorted.join(",")
    });
  };

  const colorOptions = [
    ...(supportsBw || !supportsColor
      ? [
          {
            id: "bw",
            title: "Black & White",
            desc:
              sides === "duplex"
                ? `₹${bwDuplexRate} / duplex sheet`
                : `₹${bwSingleRate} / page`
          }
        ]
      : []),
    ...(supportsColor
      ? [
          {
            id: "color",
            title: "Colour",
            desc:
              sides === "duplex"
                ? `₹${colorDuplexRate} / duplex sheet`
                : `₹${colorSingleRate} / page`
          }
        ]
      : [])
  ];

  const sideOptions = [
    ...(supportsSingle || !supportsDuplex
      ? [
          {
            id: "single",
            title: "Single-sided",
            desc: `One side per sheet • ₹${
              colorMode === "color" ? colorSingleRate : bwSingleRate
            } / page`
          }
        ]
      : []),
    ...(supportsDuplex
      ? [
          {
            id: "duplex",
            title: "Double-sided (Duplex)",
            desc: `Front & back • ₹${
              colorMode === "color" ? colorDuplexRate : bwDuplexRate
            } / sheet`
          }
        ]
      : [])
  ];

  const selectedSet = new Set(selectedPages);
  const interactivePageLimit = Math.min(totalPages, 60);

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 divide-y divide-zinc-100">
      {/* 1. COLOUR MODE */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          1. Colour Mode
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
                  <span className="block text-xs font-mono-code font-semibold text-[#8D0100] mt-0.5">
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

      {/* 2. PAPER SIZE (only sizes supported by configured printer & enabled by vendor) */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          2. Paper Size
        </label>
        <div className="flex flex-wrap gap-2">
          {supportedPaperSizes.map((size) => {
            const active = paperSize === size;
            const surcharge = Number(pricing?.paperSizeAdjustments?.[size]) || 0;
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
                {surcharge > 0 ? ` (+₹${surcharge})` : ""}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. PRINT SIDES */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          3. Printing Sides
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
                  <span className="block text-xs font-mono-code font-semibold text-[#8D0100] mt-0.5">
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

      {/* 4. PAGE SELECTION (All pages / Selected pages / Custom page range) */}
      {documentType === "pdf" && (
        <div className="p-4">
          <div className="flex items-center justify-between mb-2.5">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              4. Page Selection
            </label>
            <span className="text-xs text-zinc-500 font-mono-code">
              Total: {totalPages} {totalPages === 1 ? "page" : "pages"}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              {
                id: "all",
                title: "All pages",
                desc: totalPages === 1 ? "Page 1" : `1–${totalPages}`
              },
              {
                id: "selected",
                title: "Selected pages",
                desc: "Tap pages"
              },
              {
                id: "custom",
                title: "Custom range",
                desc: "e.g. 1-5, 8"
              }
            ].map((modeItem) => {
              const active = pageSelectionMode === modeItem.id;
              return (
                <button
                  key={modeItem.id}
                  type="button"
                  onClick={() => {
                    if (modeItem.id === "all") {
                      onUpdateSettings({
                        pageSelectionMode: "all",
                        selectedPages: Array.from({ length: totalPages }, (_, i) => i + 1)
                      });
                    } else if (modeItem.id === "selected") {
                      const nextPages =
                        selectedPages && selectedPages.length > 0 ? selectedPages : [1];
                      onUpdateSettings({
                        pageSelectionMode: "selected",
                        selectedPages: nextPages,
                        customPageRange: nextPages.join(",")
                      });
                    } else {
                      onUpdateSettings({
                        pageSelectionMode: "custom",
                        customPageRange:
                          customPageRange ||
                          (totalPages > 1 ? `1-${Math.min(2, totalPages)}` : "1")
                      });
                    }
                  }}
                  className={`p-3 rounded-xl border text-left transition flex flex-col justify-between ${
                    active
                      ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                      : "border-zinc-200 bg-white hover:bg-zinc-50"
                  }`}
                >
                  <span className="block text-xs sm:text-sm font-semibold text-zinc-900">
                    {modeItem.title}
                  </span>
                  <span className="block text-[11px] text-zinc-500 font-mono-code mt-0.5">
                    {modeItem.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {pageSelectionMode === "selected" && (
            <div className="mt-3 pt-3 border-t border-zinc-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-zinc-700">
                  Tap page numbers to include ({selectedPages.length} selected)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const all = Array.from({ length: totalPages }, (_, i) => i + 1);
                      onUpdateSettings({
                        selectedPages: all,
                        customPageRange: all.join(",")
                      });
                    }}
                    className="text-[11px] font-semibold text-[#8D0100] hover:underline"
                  >
                    Select All
                  </button>
                  <span className="text-zinc-300">•</span>
                  <button
                    type="button"
                    onClick={() =>
                      onUpdateSettings({
                        selectedPages: [1],
                        customPageRange: "1"
                      })
                    }
                    className="text-[11px] font-semibold text-zinc-500 hover:underline"
                  >
                    Page 1 Only
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-1">
                {Array.from({ length: interactivePageLimit }, (_, i) => i + 1).map(
                  (pageNum) => {
                    const isChecked = selectedSet.has(pageNum);
                    return (
                      <button
                        key={pageNum}
                        type="button"
                        onClick={() => handleTogglePageNumber(pageNum)}
                        className={`w-9 h-9 rounded-lg text-xs font-mono-code font-semibold border transition ${
                          isChecked
                            ? "bg-[#8D0100] text-white border-[#8D0100]"
                            : "bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100"
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  }
                )}
              </div>
            </div>
          )}

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
                placeholder="e.g. 1-5, 8, 11-13"
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

      {/* 5. NUMBER OF COPIES */}
      <div className="p-4 flex items-center justify-between gap-4">
        <div>
          <span className="block text-xs font-bold uppercase tracking-wider text-zinc-500">
            5. Number of Copies
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

      {/* 6. ORIENTATION */}
      <div className="p-4">
        <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2.5">
          6. Orientation
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          {[
            { id: "portrait", label: "Portrait", desc: "Vertical page sheet" },
            { id: "landscape", label: "Landscape", desc: "Horizontal page sheet" }
          ].map((item) => {
            const active =
              orientation === item.id ||
              (orientation === "auto" && item.id === "portrait");
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onUpdateSettings({ orientation: item.id })}
                className={`text-left p-3.5 rounded-xl border transition flex items-start justify-between gap-2 ${
                  active
                    ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                    : "border-zinc-200 bg-white hover:bg-zinc-50"
                }`}
              >
                <div>
                  <span className="block text-sm font-semibold text-zinc-900">
                    {item.label}
                  </span>
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    {item.desc}
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

      {/* 7. LIVE PRICE SUMMARY & BREAKDOWN */}
      {priceQuote && (
        <div className="p-4 bg-zinc-50/70 space-y-2.5 rounded-b-2xl">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
              <IndianRupee className="w-3.5 h-3.5 text-[#8D0100]" />
              <span>7. Price Summary</span>
            </label>
            <span className="text-xs font-semibold text-zinc-700">
              {priceQuote.modeLabel}
            </span>
          </div>

          <div className="rounded-xl bg-white border border-zinc-200 p-3 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Selected Mode Rate:</span>
              <span className="font-mono-code font-semibold text-zinc-900">
                {priceQuote.sides === "duplex"
                  ? `₹${priceQuote.appliedDuplexRate} / duplex sheet (₹${priceQuote.appliedSingleRate} odd page)`
                  : `₹${priceQuote.appliedSingleRate} / page`}
              </span>
            </div>

            {priceQuote.paperSizeSurcharge > 0 && (
              <div className="flex justify-between">
                <span className="text-zinc-500">{priceQuote.paperSize} Paper Surcharge:</span>
                <span className="font-mono-code font-semibold text-zinc-900">
                  +₹{priceQuote.paperSizeSurcharge} / sheet
                </span>
              </div>
            )}

            <div className="flex justify-between">
              <span className="text-zinc-500">Pages to Print (Logical):</span>
              <span className="font-mono-code font-semibold text-zinc-900">
                {priceQuote.logicalPagesPerCopy}{" "}
                {priceQuote.logicalPagesPerCopy === 1 ? "page" : "pages"} (
                {priceQuote.printedSidesTotal} total printed sides)
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-zinc-500">Physical Paper Sheets:</span>
              <span className="font-mono-code font-semibold text-zinc-900">
                {priceQuote.physicalSheetsPerCopy} sheet(s)/copy × {priceQuote.copies} ={" "}
                {priceQuote.totalPhysicalSheets} sheet(s)
              </span>
            </div>

            {priceQuote.sides === "duplex" && (
              <div className="flex justify-between text-[11px] text-zinc-500">
                <span>Duplex Sheet Breakdown:</span>
                <span className="font-mono-code">
                  {priceQuote.duplexSheetsPerCopy} duplex sheet(s) @ ₹{priceQuote.appliedDuplexRate}
                  {priceQuote.singlePagesPerCopy > 0
                    ? ` + ${priceQuote.singlePagesPerCopy} single page @ ₹${priceQuote.appliedSingleRate}`
                    : ""}
                </span>
              </div>
            )}

            <div className="flex justify-between">
              <span className="text-zinc-500">Copies:</span>
              <span className="font-mono-code font-semibold text-zinc-900">
                {priceQuote.copies} {priceQuote.copies === 1 ? "copy" : "copies"} (₹
                {priceQuote.costPerCopy} / copy)
              </span>
            </div>

            <div className="pt-2 mt-1 border-t border-zinc-100 flex items-center justify-between">
              <span className="text-sm font-bold text-zinc-900">Estimated Total:</span>
              <span className="text-lg font-bold font-mono-code text-[#8D0100]">
                ₹{priceQuote.totalPrice}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
