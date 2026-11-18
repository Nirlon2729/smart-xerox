import React from "react";
import { Loader2 } from "lucide-react";

/**
 * Sticky mobile-first bottom action bar with safe-area padding for iOS & Android phones.
 */
export default function BottomActionBar({
  primaryLabel,
  onPrimaryClick,
  primaryDisabled = false,
  primaryLoading = false,
  primaryIcon: PrimaryIcon = null,
  summaryLabel = null,
  summaryValue = null,
  summarySubtext = null
}) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-30 bg-white border-t border-zinc-200 shadow-[0_-2px_12px_rgba(0,0,0,0.04)] pb-safe">
      <div className="max-w-xl mx-auto px-4 pt-3 pb-1 flex items-center justify-between gap-3">
        {summaryValue !== null && (
          <div className="min-w-0">
            {summaryLabel && (
              <span className="block text-[11px] font-medium text-zinc-500">
                {summaryLabel}
              </span>
            )}
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg sm:text-xl font-bold text-zinc-900 font-mono-code">
                {summaryValue}
              </span>
              {summarySubtext && (
                <span className="text-xs text-zinc-500 truncate">
                  {summarySubtext}
                </span>
              )}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onPrimaryClick}
          disabled={primaryDisabled || primaryLoading}
          className={`flex-1 min-h-[50px] px-5 py-3 rounded-xl font-semibold text-sm sm:text-base flex items-center justify-center gap-2 transition ${
            summaryValue !== null ? "max-w-[230px] sm:max-w-[260px]" : "w-full"
          } ${
            primaryDisabled || primaryLoading
              ? "bg-zinc-200 text-zinc-500 cursor-not-allowed"
              : "bg-[#8D0100] hover:bg-[#730100] active:bg-[#5e0100] text-white"
          }`}
        >
          {primaryLoading ? (
            <>
              <Loader2 className="w-4.5 h-4.5 animate-spin" />
              <span>Submitting...</span>
            </>
          ) : (
            <>
              <span>{primaryLabel}</span>
              {PrimaryIcon && <PrimaryIcon className="w-4 h-4" />}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
