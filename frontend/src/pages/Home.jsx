import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  Printer,
  RefreshCw,
  ArrowRight,
  RotateCcw,
  XCircle,
  Trash2,
  FileText,
  Image as ImageIcon
} from "lucide-react";
import UploadBox from "../components/UploadBox";
import FileCard from "../components/FileCard";
import BottomActionBar from "../components/BottomActionBar";
import { getConnectionBadgeStyle } from "../components/Header";
import { getOrderStatusMeta } from "../components/OrderStatus";
import { usePrintSession } from "../context/PrintSessionContext";
import {
  inspectAndStagePdf,
  fetchRecentJobs,
  cancelPendingOrder,
  reprintOrderRequest,
  clearFailedOrdersRequest,
  getApiErrorMessage
} from "../services/api";
import { formatFileSize, summarizeSelectedPages } from "../utils/formatters";

const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];
const ALLOWED_MIMES = [
  "application/pdf",
  "application/x-pdf",
  "image/jpeg",
  "image/jpg",
  "image/png"
];

export default function Home() {
  const navigate = useNavigate();
  const {
    selectedFile,
    documentMeta,
    printerState,
    refreshPrinterStatus,
    shopConfig,
    setUploadedDocument,
    clearDocument
  } = usePrintSession();

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);

  const [recentJobs, setRecentJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [confirmReprintJob, setConfirmReprintJob] = useState(null);
  const [busyJobId, setBusyJobId] = useState(null);

  const maxUploadMb = shopConfig?.maxUploadMb || 20;
  const maxBytes = maxUploadMb * 1024 * 1024;

  const loadRecentJobs = useCallback(async (silent = false) => {
    if (!silent) setLoadingJobs(true);
    try {
      const res = await fetchRecentJobs(15);
      if (res?.success && Array.isArray(res.orders)) {
        setRecentJobs(res.orders);
      }
    } catch (_err) {
      // Handled gracefully
    } finally {
      if (!silent) setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    loadRecentJobs(false);
    const interval = setInterval(() => loadRecentJobs(true), 4000);
    return () => clearInterval(interval);
  }, [loadRecentJobs]);

  const validateAndUploadFile = async (file) => {
    if (uploading) return;
    setUploadError(null);

    if (!file) return;

    const lowerName = String(file.name || "").toLowerCase();
    const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    const hasValidMime = ALLOWED_MIMES.includes(String(file.type || "").toLowerCase());

    if (!hasValidExt && !hasValidMime) {
      const msg = "Please select a PDF, JPG, JPEG, or PNG file.";
      setUploadError(msg);
      toast.error(msg);
      return;
    }

    if (file.size <= 0) {
      const msg = "The selected file is empty.";
      setUploadError(msg);
      toast.error(msg);
      return;
    }

    if (file.size > maxBytes) {
      const msg = `File exceeds the ${maxUploadMb} MB limit.`;
      setUploadError(msg);
      toast.error(msg);
      return;
    }

    try {
      setUploading(true);
      setUploadProgress(5);

      const response = await inspectAndStagePdf(file, (percent) => {
        setUploadProgress(percent);
      });

      if (response?.success && response.document) {
        setUploadedDocument(file, response.document);
        toast.success(
          response.document.documentType === "image"
            ? "Image uploaded to GridFS"
            : `PDF uploaded (${response.document.pageCount} ${
                response.document.pageCount === 1 ? "page" : "pages"
              })`
        );
        navigate("/settings");
      } else {
        throw new Error("Could not verify document.");
      }
    } catch (err) {
      const message = getApiErrorMessage(
        err,
        "Unable to upload file. Verify the backend is running."
      );
      setUploadError(message);
      toast.error(message);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleRemoveFile = () => {
    clearDocument();
    setUploadError(null);
  };

  const handleCancelJob = async (job) => {
    try {
      setBusyJobId(job.id);
      await cancelPendingOrder(job.token);
      toast.success(`Cancelled ${job.originalName}`);
      loadRecentJobs(true);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job"));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleConfirmReprint = async () => {
    if (!confirmReprintJob) return;
    const job = confirmReprintJob;
    setConfirmReprintJob(null);
    try {
      setBusyJobId(job.id);
      const res = await reprintOrderRequest(job.token);
      if (res?.success && res.order) {
        toast.success("Sending reprint to printer...");
        loadRecentJobs(true);
        navigate(`/job/${res.order.token}`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not reprint document"));
    } finally {
      setBusyJobId(null);
    }
  };

  const handleClearFailed = async () => {
    try {
      const res = await clearFailedOrdersRequest();
      if (res?.success) {
        toast.success(res.message || "Cleared failed jobs");
        loadRecentJobs(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not clear failed jobs"));
    }
  };

  const hasFailedOrCancelled = recentJobs.some((j) =>
    ["FAILED", "CANCELLED"].includes(j.status)
  );
  const connBadge = getConnectionBadgeStyle(printerState?.connectionState);

  return (
    <div className={documentMeta ? "pb-24 space-y-5" : "pb-12 space-y-5"}>
      {/* Live USB Printer Connection Status Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${connBadge.pillClass}`}
          >
            <Printer className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-zinc-900 truncate">
                {printerState?.printerName || "HP LaserJet MFP M129-M134"}
              </span>
              <span
                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${connBadge.pillClass}`}
              >
                {connBadge.label}
              </span>
            </div>
            <p className="text-xs text-zinc-500 truncate mt-0.5">
              {printerState?.statusMessage || "Ready for mobile print jobs"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            refreshPrinterStatus();
            loadRecentJobs(false);
          }}
          aria-label="Refresh printer status"
          className="w-9 h-9 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-700 flex items-center justify-center shrink-0 transition"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Upload Box or Currently Staged Document */}
      {!documentMeta ? (
        <UploadBox
          onSelectFile={validateAndUploadFile}
          maxUploadMb={maxUploadMb}
          uploading={uploading}
          uploadProgress={uploadProgress}
          error={uploadError}
        />
      ) : (
        <div className="space-y-3">
          <FileCard
            originalName={documentMeta.originalName}
            fileSize={documentMeta.fileSize}
            pageCount={documentMeta.pageCount}
            documentType={documentMeta.documentType}
            width={documentMeta.width}
            height={documentMeta.height}
            onRemove={handleRemoveFile}
            onReplace={validateAndUploadFile}
            disabled={uploading}
          />
        </div>
      )}

      {/* Recent Print Jobs */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-zinc-100">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              Recent Print Jobs
            </h2>
          </div>

          {hasFailedOrCancelled && (
            <button
              type="button"
              onClick={handleClearFailed}
              className="inline-flex items-center gap-1 text-xs font-semibold text-zinc-600 hover:text-red-700 transition"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Failed</span>
            </button>
          )}
        </div>

        {loadingJobs && recentJobs.length === 0 ? (
          <p className="text-xs text-zinc-500 py-6 text-center">
            Loading recent print jobs...
          </p>
        ) : recentJobs.length === 0 ? (
          <p className="text-xs text-zinc-500 py-6 text-center">
            No recent print jobs yet. Upload a PDF or image above to print.
          </p>
        ) : (
          <div className="divide-y divide-zinc-100 mt-1">
            {recentJobs.map((job) => {
              const meta = getOrderStatusMeta(job.status);
              const isQueued = ["UPLOADING", "QUEUED"].includes(job.status);
              const canReprint =
                !job.fileDeleted &&
                ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status);
              const isBusy = busyJobId === job.id;

              return (
                <div
                  key={job.id}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <Link
                    to={`/job/${job.token}`}
                    className="flex items-start gap-2.5 min-w-0 flex-1 group"
                  >
                    <div className="w-8 h-8 rounded-lg bg-zinc-100 text-zinc-700 flex items-center justify-center shrink-0 mt-0.5">
                      {job.documentType === "image" ? (
                        <ImageIcon className="w-4 h-4 text-[#8D0100]" />
                      ) : (
                        <FileText className="w-4 h-4 text-[#8D0100]" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold text-zinc-900 truncate group-hover:text-[#8D0100]">
                        {job.originalName}
                      </p>
                      <p className="text-[11px] text-zinc-500 font-mono-code mt-0.5">
                        {job.copies}x • {job.paperSize || "A4"} •{" "}
                        {job.colorMode === "color" ? "Colour" : "B&W"} •{" "}
                        {job.documentType === "image"
                          ? "Image"
                          : summarizeSelectedPages(job.selectedPages, job.pageCount)}
                      </p>
                    </div>
                  </Link>

                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      to={`/job/${job.token}`}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${meta.badgeClass}`}
                    >
                      {meta.label}
                    </Link>

                    {isQueued && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleCancelJob(job)}
                        title="Cancel queued job"
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-700 hover:bg-red-50 transition"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    )}

                    {canReprint && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmReprintJob(job)}
                        title="Reprint document"
                        className="p-1.5 rounded-lg text-zinc-600 hover:text-[#8D0100] hover:bg-zinc-100 transition"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Explicit Reprint Confirmation Dialog */}
      {confirmReprintJob && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-sm w-full space-y-4 shadow-lg">
            <h3 className="text-base font-bold text-zinc-900">
              Confirm Reprint
            </h3>
            <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
              Send{" "}
              <strong className="text-zinc-900">
                {confirmReprintJob.originalName}
              </strong>{" "}
              ({confirmReprintJob.copies}{" "}
              {confirmReprintJob.copies === 1 ? "copy" : "copies"},{" "}
              {confirmReprintJob.paperSize || "A4"}) to your USB HP printer now?
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setConfirmReprintJob(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReprint}
                className="px-4 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold"
              >
                Print Now
              </button>
            </div>
          </div>
        </div>
      )}

      {documentMeta && (
        <BottomActionBar
          primaryLabel="Configure & Print"
          onPrimaryClick={() => navigate("/settings")}
          primaryDisabled={!documentMeta || uploading}
          primaryLoading={uploading}
          primaryIcon={ArrowRight}
        />
      )}
    </div>
  );
}
