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
import LoadingButton, { InlineSpinner } from "../components/LoadingButton";
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
    uploadedDocuments,
    activeDocIndex,
    setActiveDocIndex,
    addUploadedDocument,
    replaceActiveDocument,
    removeUploadedDocument,
    totalBatchPages,
    selectedFile,
    documentMeta,
    previewObjectUrl,
    printerState,
    refreshPrinterStatus,
    shopConfig,
    shopPricing,
    clearDocument
  } = usePrintSession();

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);

  const [myRecentJobs, setMyRecentJobs] = useState([]);
  const [busyJobToken, setBusyJobToken] = useState(null);
  const [refreshingShop, setRefreshingShop] = useState(false);

  const handleRefreshShopStatus = async () => {
    if (refreshingShop) return;
    try {
      setRefreshingShop(true);
      await Promise.all([refreshPrinterStatus(), loadCustomerRecentJobs()]);
    } finally {
      setRefreshingShop(false);
    }
  };

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

  const validateSingleFile = (file) => {
    if (!file) return "No file selected.";
    const lowerName = String(file.name || "").toLowerCase();
    const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    const hasValidMime = ALLOWED_MIMES.includes(String(file.type || "").toLowerCase());

    if (!hasValidExt && !hasValidMime) {
      return `"${file.name}": Please select a PDF, JPG, JPEG, or PNG file.`;
    }
    if (file.size <= 0) {
      return `"${file.name}" is empty.`;
    }
    if (file.size > maxBytes) {
      return `"${file.name}" exceeds the ${maxUploadMb} MB limit.`;
    }
    return null;
  };

  const validateAndUploadFiles = async (filesInput, replaceCurrent = false) => {
    if (uploading || !activeSlug) return;
    setUploadError(null);

    const files = Array.isArray(filesInput) ? filesInput : [filesInput].filter(Boolean);
    if (files.length === 0) return;

    for (const f of files) {
      const errMsg = validateSingleFile(f);
      if (errMsg) {
        setUploadError(errMsg);
        toast.error(errMsg);
        return;
      }
    }

    try {
      setUploading(true);
      setUploadProgress(5);

      let uploadedCount = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const response = await inspectAndStagePdf(activeSlug, f, (percent) => {
          const overall = Math.round(((i + percent / 100) / files.length) * 100);
          setUploadProgress(Math.max(5, Math.min(100, overall)));
        });

        if (response?.success && response.document) {
          if (replaceCurrent && i === 0) {
            replaceActiveDocument(f, response.document);
          } else {
            addUploadedDocument(f, response.document);
          }
          uploadedCount++;
        } else {
          throw new Error(`Could not verify "${f.name}".`);
        }
      }

      if (uploadedCount > 0) {
        toast.success(
          uploadedCount === 1
            ? `Uploaded ${files[0].name}`
            : `Uploaded ${uploadedCount} documents`
        );
        navigate(`/shop/${activeSlug}/settings`);
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
    if (uploadedDocuments.length > 1) {
      removeUploadedDocument(activeDocIndex);
    } else {
      clearDocument();
    }
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

  const connBadge = getConnectionBadgeStyle(printerState?.connectionState, printerState);
  // A manually paused shop (shopAvailable === false) must remain unavailable even if agent/printer are online
  const isShopAvailable = Boolean(printerState?.shopAvailable);

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
                {isShopAvailable
                  ? `Ready to print on ${printerState.printerName}`
                  : printerState?.unavailableReason ||
                    printerState?.statusMessage ||
                    "Checking printer connection..."}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={refreshingShop}
            aria-busy={refreshingShop}
            onClick={handleRefreshShopStatus}
            aria-label="Refresh printer status"
            className="w-9 h-9 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-700 flex items-center justify-center shrink-0 transition disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${refreshingShop ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Shop Unavailable Warning Banner */}
        {!isShopAvailable && printerState?.connectionState !== "CONNECTING" && (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">Shop Temporarily Unavailable</p>
                <p className="text-amber-800 mt-0.5 leading-relaxed">
                  {printerState?.unavailableReason ||
                    printerState?.statusMessage ||
                    "This shop is currently offline or its printer is not ready. Please wait for the shop to come online."}
                </p>
              </div>
            </div>
            <LoadingButton
              type="button"
              loading={refreshingShop}
              loadingText="Checking..."
              icon={RefreshCw}
              spinnerClassName="w-3.5 h-3.5"
              onClick={handleRefreshShopStatus}
              className="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold text-xs shrink-0"
            >
              Check Availability
            </LoadingButton>
          </div>
        )}

        {/* Live Shop Printing Rates Summary */}
        {shopPricing && (
          <div className="pt-2.5 border-t border-zinc-100">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Shop Printing Rates
              </span>
              <span className="text-[11px] font-medium text-zinc-400">
                Live shop pricing (₹)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {shopPricing.enabledOptions?.bwSingle !== false && (
                <div className="p-2 rounded-xl bg-zinc-50 border border-zinc-200/80">
                  <span className="block text-[10px] font-semibold text-zinc-500">
                    B&amp;W Single
                  </span>
                  <span className="font-mono-code font-bold text-zinc-900">
                    ₹{shopPricing.bwSingleRate} / page
                  </span>
                </div>
              )}
              {shopPricing.enabledOptions?.colorSingle !== false &&
                printerState?.capabilities?.supportsColor && (
                  <div className="p-2 rounded-xl bg-zinc-50 border border-zinc-200/80">
                    <span className="block text-[10px] font-semibold text-zinc-500">
                      Colour Single
                    </span>
                    <span className="font-mono-code font-bold text-zinc-900">
                      ₹{shopPricing.colorSingleRate} / page
                    </span>
                  </div>
                )}
              {shopPricing.enabledOptions?.bwDuplex !== false &&
                printerState?.capabilities?.supportsDuplex && (
                  <div className="p-2 rounded-xl bg-zinc-50 border border-zinc-200/80">
                    <span className="block text-[10px] font-semibold text-zinc-500">
                      B&amp;W Duplex
                    </span>
                    <span className="font-mono-code font-bold text-zinc-900">
                      ₹{shopPricing.bwDuplexRate} / sheet
                    </span>
                  </div>
                )}
              {shopPricing.enabledOptions?.colorDuplex !== false &&
                printerState?.capabilities?.supportsColor &&
                printerState?.capabilities?.supportsDuplex && (
                  <div className="p-2 rounded-xl bg-zinc-50 border border-zinc-200/80">
                    <span className="block text-[10px] font-semibold text-zinc-500">
                      Colour Duplex
                    </span>
                    <span className="font-mono-code font-bold text-zinc-900">
                      ₹{shopPricing.colorDuplexRate} / sheet
                    </span>
                  </div>
                )}
            </div>
          </div>
        )}

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

      {/* Upload Box or Currently Staged Document(s) */}
      {!documentMeta ? (
        <UploadBox
          onSelectFile={(f) => validateAndUploadFiles([f], false)}
          onSelectFiles={(files) => validateAndUploadFiles(files, false)}
          maxUploadMb={maxUploadMb}
          uploading={uploading}
          uploadProgress={uploadProgress}
          error={uploadError}
        />
      ) : (
        <div className="space-y-4">
          {uploadedDocuments.length > 1 && (
            <div className="bg-white rounded-2xl border border-zinc-200 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold uppercase tracking-wider text-zinc-500">
                  Uploaded Documents ({uploadedDocuments.length})
                </span>
                <span className="font-mono-code font-semibold text-zinc-800">
                  Total: {totalBatchPages} {totalBatchPages === 1 ? "page" : "pages"}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {uploadedDocuments.map((doc, idx) => {
                  const active = idx === activeDocIndex;
                  return (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => setActiveDocIndex(idx)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 transition ${
                        active
                          ? "border-[#8D0100] bg-[#8D0100] text-white"
                          : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
                      }`}
                    >
                      <span className="truncate max-w-[140px]">
                        {doc.meta?.originalName}
                      </span>
                      <span className="font-mono-code text-[10px] opacity-80">
                        ({doc.meta?.pageCount || 1}p)
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <FileCard
            originalName={documentMeta.originalName}
            fileSize={documentMeta.fileSize}
            pageCount={documentMeta.pageCount}
            documentType={documentMeta.documentType}
            width={documentMeta.width}
            height={documentMeta.height}
            onRemove={handleRemoveFile}
            onReplace={(f) => validateAndUploadFiles([f], true)}
            disabled={uploading}
          />

          <DocumentPreview
            file={selectedFile}
            originalName={documentMeta.originalName}
            fileSize={documentMeta.fileSize}
            documentType={documentMeta.documentType}
            pageCount={documentMeta.pageCount}
            width={documentMeta.width}
            height={documentMeta.height}
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-xs sm:text-sm font-semibold text-zinc-900 truncate group-hover:text-[#8D0100]">
                          {job.originalName}
                        </p>
                        {job.pickupCode && (
                          <span className="px-1.5 py-0.5 rounded bg-[#8D0100]/10 border border-[#8D0100]/25 text-[#8D0100] font-mono-code text-[10px] font-bold shrink-0">
                            CODE: {job.pickupCode}
                          </span>
                        )}
                      </div>
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
                        aria-busy={isBusy}
                        onClick={() => handleCancelJob(job)}
                        title="Cancel queued job"
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-700 hover:bg-red-50 transition disabled:opacity-60"
                      >
                        {isBusy ? (
                          <InlineSpinner className="w-4 h-4 text-red-600" />
                        ) : (
                          <XCircle className="w-4 h-4" />
                        )}
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
