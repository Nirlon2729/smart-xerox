import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Printer } from "lucide-react";
import FileCard from "../components/FileCard";
import DocumentPreview from "../components/DocumentPreview";
import PrintOptions from "../components/PrintOptions";
import BottomActionBar from "../components/BottomActionBar";
import { usePrintSession } from "../context/PrintSessionContext";
import {
  inspectAndStagePdf,
  createPrintOrder,
  saveCustomerOrderToken,
  getApiErrorMessage
} from "../services/api";
import {
  validateCustomPageRangeInput,
  summarizeSelectedPages,
  formatFileSize
} from "../utils/formatters";

export default function PrintSettings() {
  const { shopSlug: routeShopSlug } = useParams();
  const navigate = useNavigate();
  const {
    shopSlug,
    setShopSlug,
    shopInfo,
    selectedFile,
    previewObjectUrl,
    documentMeta,
    settings,
    updateSettings,
    printerState,
    shopConfig,
    setUploadedDocument,
    setActiveOrder,
    clearDocument
  } = usePrintSession();

  const activeSlug = routeShopSlug || shopSlug;

  const [customRangeError, setCustomRangeError] = useState(null);
  const [replacing, setReplacing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const idempotencyKeyRef = useRef(
    `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );

  useEffect(() => {
    if (routeShopSlug) {
      setShopSlug(routeShopSlug);
    }
  }, [routeShopSlug, setShopSlug]);

  useEffect(() => {
    if (!documentMeta && activeSlug) {
      navigate(`/shop/${activeSlug}`, { replace: true });
    } else if (!documentMeta && !activeSlug) {
      navigate("/", { replace: true });
    }
  }, [documentMeta, activeSlug, navigate]);

  const totalPages = documentMeta?.pageCount || 1;
  const isImage = documentMeta?.documentType === "image";

  useEffect(() => {
    if (!documentMeta) return;

    if (
      isImage ||
      settings.pageSelectionMode === "all" ||
      settings.pageSelectionMode === "selected"
    ) {
      setCustomRangeError(null);
      return;
    }

    const validation = validateCustomPageRangeInput(
      settings.customPageRange,
      totalPages
    );
    if (!validation.valid) {
      setCustomRangeError(validation.error);
    } else {
      setCustomRangeError(null);
      updateSettings({ selectedPages: validation.pages });
    }
  }, [
    documentMeta,
    isImage,
    totalPages,
    settings.pageSelectionMode,
    settings.customPageRange,
    updateSettings
  ]);

  useEffect(() => {
    idempotencyKeyRef.current = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }, [
    documentMeta?.uploadId,
    settings.paperSize,
    settings.colorMode,
    settings.sides,
    settings.orientation,
    settings.pageSelectionMode,
    settings.customPageRange,
    settings.selectedPages,
    settings.copies
  ]);

  if (!documentMeta) return null;

  const handleReplaceFile = async (newFile) => {
    if (replacing || submitting || !activeSlug) return;
    try {
      setReplacing(true);
      const res = await inspectAndStagePdf(activeSlug, newFile);
      if (res?.success && res.document) {
        setUploadedDocument(newFile, res.document);
        toast.success(`Replaced with ${res.document.originalName}`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not replace file."));
    } finally {
      setReplacing(false);
    }
  };

  const handleRemoveFile = () => {
    clearDocument();
    navigate(activeSlug ? `/shop/${activeSlug}` : "/");
  };

  const handlePrintNow = async () => {
    if (submitting || !activeSlug) return;
    if (customRangeError) {
      toast.error(customRangeError);
      return;
    }

    let finalSelectedPages = Array.from({ length: totalPages }, (_, i) => i + 1);
    if (!isImage && settings.pageSelectionMode === "selected") {
      finalSelectedPages =
        settings.selectedPages && settings.selectedPages.length > 0
          ? settings.selectedPages
          : [1];
    } else if (!isImage && settings.pageSelectionMode === "custom") {
      const validation = validateCustomPageRangeInput(
        settings.customPageRange,
        totalPages
      );
      if (!validation.valid) {
        setCustomRangeError(validation.error);
        toast.error(validation.error);
        return;
      }
      finalSelectedPages = validation.pages;
    }

    try {
      setSubmitting(true);
      const response = await createPrintOrder(activeSlug, {
        file: selectedFile,
        uploadId: documentMeta.uploadId,
        idempotencyKey: idempotencyKeyRef.current,
        pageSelectionMode: isImage ? "all" : settings.pageSelectionMode,
        customPageRange:
          !isImage && settings.pageSelectionMode === "custom"
            ? settings.customPageRange
            : undefined,
        selectedPages: finalSelectedPages,
        copies: settings.copies,
        colorMode: settings.colorMode,
        sides: isImage ? "single" : settings.sides,
        paperSize: settings.paperSize,
        orientation: settings.orientation
      });

      if (response?.success && response.order) {
        saveCustomerOrderToken(activeSlug, response.order.token);
        setActiveOrder(response.order);
        toast.success("Sending to printer...");
        navigate(`/shop/${activeSlug}/job/${response.order.token}`, {
          replace: true
        });
      } else {
        throw new Error("Could not submit print job.");
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Failed to submit print job."));
    } finally {
      setSubmitting(false);
    }
  };

  const activeSelectedPages =
    isImage || settings.pageSelectionMode === "all"
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : settings.selectedPages || [1];

  const totalImpressions = activeSelectedPages.length * settings.copies;

  return (
    <div className="space-y-4 pb-28">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-zinc-900">
          Printing Options
        </h1>
        <p className="text-xs sm:text-sm text-zinc-600 mt-0.5">
          Shop:{" "}
          <strong className="text-zinc-900">
            {shopInfo?.shopName || activeSlug}
          </strong>{" "}
          • Printer:{" "}
          <strong className="text-zinc-900">
            {printerState?.printerName || "Shop Printer"}
          </strong>
        </p>
      </div>

      <FileCard
        originalName={documentMeta.originalName}
        fileSize={documentMeta.fileSize}
        pageCount={documentMeta.pageCount}
        documentType={documentMeta.documentType}
        width={documentMeta.width}
        height={documentMeta.height}
        onReplace={handleReplaceFile}
        onRemove={handleRemoveFile}
        disabled={replacing || submitting}
      />

      <DocumentPreview
        originalName={documentMeta.originalName}
        documentType={documentMeta.documentType}
        pageCount={totalPages}
        selectedPages={activeSelectedPages}
        colorMode={settings.colorMode}
        sides={settings.sides}
        paperSize={settings.paperSize}
        orientation={settings.orientation}
        detectedOrientation={documentMeta.detectedOrientation}
        previewObjectUrl={previewObjectUrl}
      />

      <PrintOptions
        settings={settings}
        onUpdateSettings={updateSettings}
        totalPages={totalPages}
        documentType={documentMeta.documentType}
        maxCopies={shopConfig?.maxCopies || 100}
        capabilities={printerState?.capabilities}
        customRangeError={customRangeError}
      />

      {/* Document Summary Card Before Printing */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 text-xs sm:text-sm space-y-2">
        <div className="pb-2 border-b border-zinc-100 font-bold uppercase tracking-wider text-xs text-zinc-500">
          Document Summary
        </div>
        <div className="flex items-center justify-between text-zinc-600">
          <span>Document</span>
          <span className="font-semibold text-zinc-900 truncate max-w-[200px]">
            {documentMeta.originalName} ({formatFileSize(documentMeta.fileSize)})
          </span>
        </div>
        <div className="flex items-center justify-between text-zinc-600">
          <span>Print Mode</span>
          <span className="font-mono-code font-semibold text-zinc-900">
            {settings.paperSize} •{" "}
            {settings.colorMode === "color" ? "Colour" : "Black & White"} •{" "}
            {isImage || settings.sides === "single"
              ? "Single-sided"
              : "Double-sided"}
          </span>
        </div>
        <div className="flex items-center justify-between text-zinc-600">
          <span>Orientation</span>
          <span className="font-mono-code font-semibold text-zinc-900 capitalize">
            {settings.orientation || "Portrait"}
          </span>
        </div>
        <div className="flex items-center justify-between text-zinc-600">
          <span>Pages & Copies</span>
          <span className="font-mono-code font-semibold text-zinc-900">
            {summarizeSelectedPages(activeSelectedPages, totalPages)} ×{" "}
            {settings.copies} ({totalImpressions} total{" "}
            {totalImpressions === 1 ? "page" : "pages"})
          </span>
        </div>
      </div>

      <BottomActionBar
        summaryLabel={printerState?.online ? "Ready to print" : "Queued for shop printer"}
        summaryValue={`${totalImpressions} ${totalImpressions === 1 ? "page" : "pages"}`}
        summarySubtext={`${settings.paperSize} • ${
          settings.colorMode === "color" ? "Colour" : "B&W"
        }`}
        primaryLabel="PRINT"
        onPrimaryClick={handlePrintNow}
        primaryDisabled={Boolean(customRangeError) || submitting || replacing}
        primaryLoading={submitting}
        primaryIcon={Printer}
      />
    </div>
  );
}
