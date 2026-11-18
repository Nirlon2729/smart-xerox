import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  Printer,
  RefreshCw,
  ArrowRight,
  XCircle,
  FileText,
  Image as ImageIcon,
  AlertCircle,
  MapPin,
  Phone
} from "lucide-react";
import UploadBox from "../components/UploadBox";
import FileCard from "../components/FileCard";
import DocumentPreview from "../components/DocumentPreview";
import BottomActionBar from "../components/BottomActionBar";
import Loader from "../components/Loader";
import { getConnectionBadgeStyle } from "../components/Header";
import { getOrderStatusMeta } from "../components/OrderStatus";
import { usePrintSession } from "../context/PrintSessionContext";
import {
  inspectAndStagePdf,
  fetchOrderByToken,
  cancelPendingOrder,
  getSavedCustomerOrderTokens,
  getApiErrorMessage
} from "../services/api";
import { summarizeSelectedPages } from "../utils/formatters";

const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];
const ALLOWED_MIMES = [
  "application/pdf",
  "application/x-pdf",
  "image/jpeg",
  "image/jpg",
  "image/png"
];

export default function Home() {
  const { shopSlug: routeShopSlug } = useParams();
  const navigate = useNavigate();
  const {
    shopSlug,
    setShopSlug,
    shopInfo,
    shopLoading,
    shopError,
    documentMeta,
    previewObjectUrl,
    printerState,
    refreshPrinterStatus,
    shopConfig,
    setUploadedDocument,
    clearDocument
  } = usePrintSession();

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);

  const [myRecentJobs, setMyRecentJobs] = useState([]);
  const [busyJobToken, setBusyJobToken] = useState(null);

  useEffect(() => {
    if (routeShopSlug) {
      setShopSlug(routeShopSlug);
    }
  }, [routeShopSlug, setShopSlug]);

  const activeSlug = routeShopSlug || shopSlug;
  const maxUploadMb = shopConfig?.maxUploadMb || 20;
  const maxBytes = maxUploadMb * 1024 * 1024;

  const loadCustomerRecentJobs = useCallback(async () => {
    if (!activeSlug) return;
    const savedTokens = getSavedCustomerOrderTokens(activeSlug);
    if (savedTokens.length === 0) {
      setMyRecentJobs([]);
      return;
    }

    const results = await Promise.all(
      savedTokens.slice(0, 6).map(async (tok) => {
        try {
          const res = await fetchOrderByToken(activeSlug, tok);
          return res?.order || null;
        } catch (_e) {
          return null;
        }
      })
    );
    setMyRecentJobs(results.filter(Boolean));
  }, [activeSlug]);

  useEffect(() => {
    loadCustomerRecentJobs();
    const interval = setInterval(loadCustomerRecentJobs, 5000);
    return () => clearInterval(interval);
  }, [loadCustomerRecentJobs]);

  if (shopLoading && !shopInfo && !shopError) {
    return <Loader fullScreen label="Loading print shop..." />;
  }

  if (shopError) {
    return (
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 text-center space-y-4 mt-4">
        <div className="w-12 h-12 rounded-xl bg-red-50 text-red-600 flex items-center justify-center mx-auto">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h1 className="text-lg font-bold text-zinc-900">Shop Unavailable</h1>
        <p className="text-xs sm:text-sm text-zinc-600 max-w-xs mx-auto leading-relaxed">
          {shopError}
        </p>
        <div className="pt-2">
          <Link
            to="/"
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-xl bg-[#8D0100] text-white text-xs font-semibold"
          >
            Enter Another Shop Code
          </Link>
        </div>
      </div>
    );
  }

  const validateAndUploadFile = async (file) => {
    if (uploading || !activeSlug) return;
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

      const response = await inspectAndStagePdf(activeSlug, file, (percent) => {
        setUploadProgress(percent);
      });

      if (response?.success && response.document) {
        setUploadedDocument(file, response.document);
        toast.success(
          response.document.documentType === "image"
            ? "Image uploaded"
            : `PDF uploaded (${response.document.pageCount} ${
                response.document.pageCount === 1 ? "page" : "pages"
              })`
        );
        navigate(`/shop/${activeSlug}/settings`);
      } else {
        throw new Error("Could not verify document.");
      }
    } catch (err) {
      const message = getApiErrorMessage(
        err,
        "Unable to upload file. Please check your connection and try again."
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
      setBusyJobToken(job.token);
      await cancelPendingOrder(activeSlug, job.token);
      toast.success(`Cancelled ${job.originalName}`);
      loadCustomerRecentJobs();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job"));
    } finally {
      setBusyJobToken(null);
    }
  };

  const connBadge = getConnectionBadgeStyle(printerState?.connectionState);

  return (
    <div className={documentMeta ? "pb-24 space-y-5" : "pb-12 space-y-5"}>
      {/* Shop Banner & Printer Availability Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {shopInfo?.logoUrl ? (
              <img
                src={shopInfo.logoUrl}
                alt={shopInfo.shopName}
                className="w-11 h-11 rounded-xl object-cover border border-zinc-200 shrink-0"
              />
            ) : (
              <div
                className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${connBadge.pillClass}`}
              >
                <Printer className="w-5 h-5" />
              </div>
            )}

            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-sm sm:text-base font-bold text-zinc-900 truncate">
                  {shopInfo?.shopName || "Smart Xerox Shop"}
                </h1>
                <span
                  className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${connBadge.pillClass}`}
                >
                  {connBadge.label}
                </span>
              </div>
              <p className="text-xs text-zinc-500 truncate mt-0.5">
                {printerState?.online
                  ? `Ready to print on ${printerState.printerName}`
                  : printerState?.statusMessage || "Checking printer connection..."}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              refreshPrinterStatus();
              loadCustomerRecentJobs();
            }}
            aria-label="Refresh printer status"
            className="w-9 h-9 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-700 flex items-center justify-center shrink-0 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {(shopInfo?.address || shopInfo?.phone) && (
          <div className="pt-2.5 border-t border-zinc-100 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            {shopInfo.address && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span>{shopInfo.address}</span>
              </span>
            )}
            {shopInfo.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span>{shopInfo.phone}</span>
              </span>
            )}
          </div>
        )}
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
        <div className="space-y-4">
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

          <DocumentPreview
            originalName={documentMeta.originalName}
            documentType={documentMeta.documentType}
            pageCount={documentMeta.pageCount}
            selectedPages={Array.from({ length: documentMeta.pageCount || 1 }, (_, i) => i + 1)}
            previewObjectUrl={previewObjectUrl}
          />
        </div>
      )}

      {/* Customer's Own Recent Print Jobs on This Device */}
      {myRecentJobs.length > 0 && (
        <div className="bg-white rounded-2xl border border-zinc-200 p-4">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-zinc-100">
            <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              Your Recent Print Jobs
            </h2>
          </div>

          <div className="divide-y divide-zinc-100 mt-1">
            {myRecentJobs.map((job) => {
              const meta = getOrderStatusMeta(job.status);
              const isQueued = ["UPLOADING", "QUEUED"].includes(job.status);
              const isBusy = busyJobToken === job.token;

              return (
                <div
                  key={job.token}
                  className="py-3 flex items-center justify-between gap-3"
                >
                  <Link
                    to={`/shop/${activeSlug}/job/${job.token}`}
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
                        {job.token} • {job.copies}x • {job.paperSize || "A4"} •{" "}
                        {job.colorMode === "color" ? "Colour" : "B&W"} •{" "}
                        {job.documentType === "image"
                          ? "Image"
                          : summarizeSelectedPages(job.selectedPages, job.pageCount)}
                      </p>
                    </div>
                  </Link>

                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      to={`/shop/${activeSlug}/job/${job.token}`}
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
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {documentMeta && (
        <BottomActionBar
          primaryLabel="Select Print Options"
          onPrimaryClick={() => navigate(`/shop/${activeSlug}/settings`)}
          primaryDisabled={!documentMeta || uploading}
          primaryLoading={uploading}
          primaryIcon={ArrowRight}
        />
      )}
    </div>
  );
}
