import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  RefreshCw,
  AlertCircle,
  Plus,
  XCircle,
  Printer,
  Copy,
  Check
} from "lucide-react";
import OrderStatus from "../components/OrderStatus";
import Loader from "../components/Loader";
import LoadingButton from "../components/LoadingButton";
import { useOrderPolling } from "../hooks/useOrderPolling";
import {
  cancelPendingOrder,
  getApiErrorMessage
} from "../services/api";
import { formatFileSize, summarizeSelectedPages } from "../utils/formatters";
import { usePrintSession } from "../context/PrintSessionContext";

export default function OrderSuccess() {
  const { shopSlug: routeShopSlug, token } = useParams();
  const navigate = useNavigate();
  const {
    shopSlug,
    setShopSlug,
    shopInfo,
    clearDocument,
    printerState,
    submittedBatchOrders
  } = usePrintSession();

  const activeSlug = routeShopSlug || shopSlug;

  useEffect(() => {
    if (routeShopSlug) {
      setShopSlug(routeShopSlug);
    }
  }, [routeShopSlug, setShopSlug]);

  const { order, loading, refreshing, error, refresh } = useOrderPolling(
    activeSlug,
    token,
    2500
  );
  const [cancelling, setCancelling] = useState(false);
  const [copyingCode, setCopyingCode] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyPickupCode = async () => {
    if (!order?.pickupCode || copyingCode) return;
    try {
      setCopyingCode(true);
      await navigator.clipboard.writeText(String(order.pickupCode));
      setCopiedCode(true);
      toast.success(`Copied Print Collection Code ${order.pickupCode}`);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (_err) {
      toast.error("Could not copy code. Please note it down manually.");
    } finally {
      setCopyingCode(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!order?.token || !activeSlug || cancelling) return;
    try {
      setCancelling(true);
      await cancelPendingOrder(activeSlug, order.token);
      toast.success("Print job cancelled.");
      refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job."));
    } finally {
      setCancelling(false);
    }
  };

  const handleStartNewOrder = () => {
    clearDocument();
    navigate(activeSlug ? `/shop/${activeSlug}` : "/");
  };

  if (loading && !order) {
    return <Loader fullScreen label="Connecting to shop print queue..." />;
  }

  if (error && !order) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 text-center space-y-4">
        <div className="w-11 h-11 rounded-xl bg-red-50 text-red-600 flex items-center justify-center mx-auto">
          <AlertCircle className="w-5 h-5" />
        </div>
        <h2 className="text-base font-bold text-zinc-900">Print Job Not Found</h2>
        <p className="text-xs sm:text-sm text-zinc-500 max-w-xs mx-auto">{error}</p>
        <div className="pt-2 flex justify-center">
          <button
            type="button"
            onClick={handleStartNewOrder}
            className="px-5 py-2.5 rounded-xl bg-[#8D0100] text-white text-xs font-semibold"
          >
            Back to Shop
          </button>
        </div>
      </div>
    );
  }

  if (!order) return null;

  const canCancel = ["UPLOADING", "QUEUED"].includes(order.status);

  return (
    <div className="space-y-4 pb-12">
      {/* Live Status Header */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-zinc-500 flex items-center gap-1.5">
          <Printer className="w-3.5 h-3.5 text-[#8D0100]" />
          <span>
            {shopInfo?.shopName || activeSlug} •{" "}
            {order.targetPrinterName || printerState?.printerName || "Shop Printer"}
          </span>
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8D0100] hover:underline disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          <span>{refreshing ? "Updating..." : "Refresh"}</span>
        </button>
      </div>

      {/* Multi-file Batch Switcher if multiple documents were submitted together */}
      {Array.isArray(submittedBatchOrders) && submittedBatchOrders.length > 1 && (
        <div className="bg-white rounded-2xl border border-zinc-200 p-3.5 space-y-2">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500">
            Submitted Batch Jobs ({submittedBatchOrders.length} documents)
          </span>
          <div className="flex flex-wrap gap-2">
            {submittedBatchOrders.map((bOrder, idx) => {
              const isCurrent = bOrder.token === order.token;
              return (
                <button
                  key={bOrder.token}
                  type="button"
                  onClick={() => navigate(`/shop/${activeSlug}/job/${bOrder.token}`)}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition ${
                    isCurrent
                      ? "border-[#8D0100] bg-[#8D0100] text-white"
                      : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  {idx + 1}. {bOrder.originalName} ({bOrder.token})
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Prominent 4-Digit Print Collection Code Card (strictly from backend order response) */}
      {order.pickupCode && (
        <div className="bg-white rounded-2xl border-2 border-[#8D0100]/30 p-5 text-center space-y-3 shadow-xs">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-bold uppercase tracking-wider">
            <span>Print Order Confirmed</span>
          </div>

          <div>
            <h2 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-zinc-500">
              Your Print Collection Code
            </h2>
            <div
              data-testid="pickup-code-display"
              className="mt-2 inline-flex items-center justify-center px-6 py-3 rounded-2xl bg-[#8D0100]/5 border border-[#8D0100]/20"
            >
              <span className="text-4xl sm:text-5xl font-extrabold font-mono-code tracking-[0.22em] text-[#8D0100] pl-[0.22em]">
                {order.pickupCode}
              </span>
            </div>
          </div>

          <p className="text-xs sm:text-sm text-zinc-600 max-w-xs mx-auto leading-relaxed">
            Show this code to the shop vendor to identify your print.
          </p>

          <div className="pt-1 flex justify-center">
            <LoadingButton
              type="button"
              onClick={handleCopyPickupCode}
              loading={copyingCode}
              loadingText="Copying..."
              icon={copiedCode ? Check : Copy}
              className="min-h-[40px] px-4 py-2 rounded-xl border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-800 text-xs font-semibold"
            >
              {copiedCode ? "Code Copied" : "Copy Code"}
            </LoadingButton>
          </div>
        </div>
      )}

      {/* Live Status Card */}
      <OrderStatus
        status={order.status}
        failureReason={order.failureReason}
        printerState={printerState}
      />

      {/* Job Details Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3">
        <div className="flex items-center justify-between pb-2.5 border-b border-zinc-100">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
            Print Job Details
          </h3>
          <span className="text-xs font-mono-code font-semibold text-zinc-700">
            {order.token}
          </span>
        </div>

        <dl className="space-y-2 text-xs sm:text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500">Document</dt>
            <dd className="font-medium text-zinc-900 truncate max-w-[220px]">
              {order.originalName} ({formatFileSize(order.fileSize)})
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500">Paper & Orientation</dt>
            <dd className="font-mono-code font-medium text-zinc-900 capitalize">
              {order.paperSize || "A4"} • {order.orientation || "portrait"}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500">Print Mode</dt>
            <dd className="font-medium text-zinc-900">
              {order.colorMode === "color" ? "Colour" : "Black & White"} •{" "}
              {order.sides === "duplex" ? "Double-sided" : "Single-sided"}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500">Pages</dt>
            <dd className="font-mono-code font-medium text-zinc-900">
              {order.documentType === "image"
                ? "1 image sheet"
                : summarizeSelectedPages(order.selectedPages, order.pageCount)}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-zinc-500">Copies &amp; Sheets</dt>
            <dd className="font-mono-code font-medium text-zinc-900">
              {order.copies || 1}x ({order.printablePageCount} printed{" "}
              {order.printablePageCount === 1 ? "side" : "sides"}
              {order.pricingSnapshot?.totalPhysicalSheets
                ? ` • ${order.pricingSnapshot.totalPhysicalSheets} physical sheet(s)`
                : ""}
              )
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4 pt-2 border-t border-zinc-100">
            <dt className="text-zinc-700 font-bold">Total Print Amount</dt>
            <dd className="font-mono-code font-bold text-base text-[#8D0100]">
              ₹{order.totalPrice ?? order.pricingSnapshot?.totalPrice ?? 0}
            </dd>
          </div>
        </dl>

        {canCancel && (
          <div className="pt-3 border-t border-zinc-100 flex items-center justify-end">
            <LoadingButton
              type="button"
              onClick={handleCancelOrder}
              loading={cancelling}
              loadingText="Cancelling..."
              icon={XCircle}
              spinnerClassName="w-3.5 h-3.5"
              className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-red-200 bg-red-50/70 text-xs font-semibold text-red-700 hover:bg-red-100"
            >
              Cancel Job
            </LoadingButton>
          </div>
        )}
      </div>

      <div className="pt-1">
        <button
          type="button"
          onClick={handleStartNewOrder}
          className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-sm font-semibold flex items-center justify-center gap-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>Print Another Document</span>
        </button>
      </div>
    </div>
  );
}
