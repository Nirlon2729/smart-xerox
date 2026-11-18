import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Printer, ArrowLeft } from "lucide-react";
import { usePrintSession } from "../context/PrintSessionContext";

export function getConnectionBadgeStyle(connectionState) {
  switch (connectionState) {
    case "PRINTER_READY":
      return {
        label: "Printer Ready",
        pillClass: "bg-emerald-50 border-emerald-200 text-emerald-800",
        dotClass: "bg-emerald-600 animate-pulse"
      };
    case "PRINTER_OFFLINE":
      return {
        label: "Printer Offline",
        pillClass: "bg-amber-50 border-amber-200 text-amber-800",
        dotClass: "bg-amber-500"
      };
    case "CONNECTING":
      return {
        label: "Connecting",
        pillClass: "bg-blue-50 border-blue-200 text-blue-800",
        dotClass: "bg-blue-500 animate-pulse"
      };
    case "AGENT_OFFLINE":
    default:
      return {
        label: "Shop Offline",
        pillClass: "bg-zinc-100 border-zinc-200 text-zinc-600",
        dotClass: "bg-zinc-400"
      };
  }
}

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const { shopSlug, shopInfo, printerState } = usePrintSession();

  const homePath = shopSlug ? `/shop/${shopSlug}` : "/";
  const isShopHome =
    location.pathname === "/" ||
    location.pathname === `/shop/${shopSlug}` ||
    location.pathname.startsWith("/super-admin");

  const badge = getConnectionBadgeStyle(printerState?.connectionState);

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-zinc-200 pt-safe">
      <div className="max-w-xl mx-auto px-4 h-15 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {!isShopHome && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              aria-label="Go back"
              className="w-9 h-9 rounded-lg border border-zinc-200 flex items-center justify-center text-zinc-700 hover:bg-zinc-50 active:bg-zinc-100 transition shrink-0"
            >
              <ArrowLeft className="w-4.5 h-4.5" />
            </button>
          )}

          <Link
            to={homePath}
            className="flex items-center gap-2.5 focus:outline-none min-w-0"
          >
            {shopInfo?.logoUrl ? (
              <img
                src={shopInfo.logoUrl}
                alt={shopInfo.shopName || "Shop logo"}
                className="w-9 h-9 rounded-lg object-cover border border-zinc-200 shrink-0"
              />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-[#8D0100] flex items-center justify-center text-white shrink-0">
                <Printer className="w-4.5 h-4.5" />
              </div>
            )}

            <div className="truncate">
              <span className="block text-sm font-bold tracking-tight text-zinc-900 leading-none truncate">
                {shopInfo?.shopName || "SMART XEROX"}
              </span>
              <span className="block text-[11px] font-medium text-zinc-500 mt-1 leading-none truncate">
                {shopInfo ? "Instant Cloud Xerox" : "Multi-Vendor Print Platform"}
              </span>
            </div>
          </Link>
        </div>

        {shopSlug && (
          <div className="flex items-center gap-2 shrink-0">
            <div
              title={printerState?.statusMessage || printerState?.printerName}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${badge.pillClass}`}
            >
              <span className={`w-2 h-2 rounded-full ${badge.dotClass}`} />
              <span>{badge.label}</span>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
