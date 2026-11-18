import React, { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  RefreshCw,
  AlertCircle,
  Plus,
  XCircle,
  RotateCcw,
  Printer
} from "lucide-react";
import OrderStatus from "../components/OrderStatus";
import Loader from "../components/Loader";
import { useOrderPolling } from "../hooks/useOrderPolling";
import {
  cancelPendingOrder,
  reprintOrderRequest,
  getApiErrorMessage
} from "../services/api";
import { formatFileSize, summarizeSelectedPages } from "../utils/formatters";
import { usePrintSession } from "../context/PrintSessionContext";

export default function OrderSuccess() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { clearDocument, printerState } = usePrintSession();
  const { order, loading, refreshing, error, refresh } = useOrderPolling(token, 2500);
  const [cancelling, setCancelling] = useState(false);
  const [confirmReprint, setConfirmReprint] = useState(false);
  const [reprinting, setReprinting] = useState(false);

  const handleCancelOrder = async () => {
    if (!order?.token || cancelling) return;
    try {
      setCancelling(true);
      await cancelPendingOrder(order.token);
      toast.success("Print job cancelled.");
      refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job."));
    } finally {
      setCancelling(false);
    }
  };

  const handleConfirmReprint = async () => {
    if (!order?.token || reprinting) return;
    setConfirmReprint(false);
    try {
      setReprinting(true);
      const res = await reprintOrderRequest(order.token);
      if (res?.success && res.order) {
        toast.success("Sending reprint to printer...");
        navigate(`/job/${res.order.token}`, { replace: true });
        refresh();
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not reprint job."));
    } finally {
      setReprinting(false);
    }
  };

  const handleStartNewOrder = () => {
    clearDocument();
    navigate("/");
  };

  if (loading && !order) {
    return <Loader fullScreen label="Connecting to print queue..." />;
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
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (!order) return null;

  const canCancel = ["UPLOADING", "QUEUED"].includes(order.status);
  const canReprint =
    !order.fileDeleted && ["COMPLETED", "FAILED", "CANCELLED"].includes(order.status);

  return (
    <div className="space-y-4 pb-12">
      {/* Live Status Header */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-zinc-500 flex items-center gap-1.5">
          <Printer className="w-3.5 h-3.5 text-[#8D0100]" />
          <span>{printerState?.printerName || "HP USB Printer"}</span>
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

      {/* Live Status Card ("Sending to printer...", "Printer is printing...", "Completed" / "Failed") */}
      <OrderStatus status={order.status} failureReason={order.failureReason} />

      {/* Job Details Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3">
        <div className="flex items-center justify-between pb-2.5 border-b border-zinc-100">
          <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
            Print Job Details
          </h3>
          <span className="text-xs font-mono-code text-zinc-500">
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
              {order.paperSize || "A4"} • {order.orientation || "auto"}
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
            <dt className="text-zinc-500">Copies</dt>
            <dd className="font-mono-code font-medium text-zinc-900">
              {order.copies || 1} ({order.printablePageCount} total{" "}
              {order.printablePageCount === 1 ? "page" : "pages"})
            </dd>
          </div>
        </dl>

        {(canCancel || canReprint) && (
          <div className="pt-3 border-t border-zinc-100 flex items-center justify-end gap-2.5">
            {canCancel && (
              <button
                type="button"
                onClick={handleCancelOrder}
                disabled={cancelling}
                className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-red-200 bg-red-50/70 text-xs font-semibold text-red-700 inline-flex items-center gap-1.5 hover:bg-red-100 disabled:opacity-50"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>{cancelling ? "Cancelling..." : "Cancel Job"}</span>
              </button>
            )}

            {canReprint && (
              <button
                type="button"
                onClick={() => setConfirmReprint(true)}
                disabled={reprinting}
                className="min-h-[38px] px-3.5 py-1.5 rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-800 inline-flex items-center gap-1.5 hover:bg-zinc-100 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#8D0100]" />
                <span>{reprinting ? "Reprinting..." : "Reprint"}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Explicit Reprint Confirmation Modal */}
      {confirmReprint && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-sm w-full space-y-4 shadow-lg">
            <h3 className="text-base font-bold text-zinc-900">
              Confirm Reprint
            </h3>
            <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
              Send <strong className="text-zinc-900">{order.originalName}</strong>{" "}
              ({order.copies} {order.copies === 1 ? "copy" : "copies"}) to the USB HP printer again?
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReprint(false)}
                className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReprint}
                className="px-4 py-2 rounded-xl bg-[#8D0100] text-white text-xs font-semibold"
              >
                Print Now
              </button>
            </div>
          </div>
        </div>
      )}

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
