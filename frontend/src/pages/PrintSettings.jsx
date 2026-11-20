import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import {
  Printer,
  Plus,
  FileText,
  Image as ImageIcon,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  IndianRupee
} from "lucide-react";
import FileCard from "../components/FileCard";
import DocumentPreview from "../components/DocumentPreview";
import PrintOptions from "../components/PrintOptions";
import BottomActionBar from "../components/BottomActionBar";
import LoadingButton from "../components/LoadingButton";
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
import { calculateOrderPriceQuote } from "../utils/pricingCalculator";

export default function PrintSettings() {
  const { shopSlug: routeShopSlug } = useParams();
  const navigate = useNavigate();
  const {
    shopSlug,
    setShopSlug,
    shopInfo,
    uploadedDocuments,
    activeDocIndex,
    setActiveDocIndex,
    addUploadedDocument,
    replaceActiveDocument,
    removeUploadedDocument,
    totalBatchPages,
    selectedFile,
    previewObjectUrl,
    documentMeta,
    settings,
    updateSettings,
    printerState,
    refreshPrinterStatus,
    shopConfig,
    shopPricing,
    setActiveOrder,
    setSubmittedBatchOrders,
    clearDocument
  } = usePrintSession();

  const activeSlug = routeShopSlug || shopSlug;

  const [customRangeError, setCustomRangeError] = useState(null);
  const [replacing, setReplacing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const submittingRef = useRef(false);
  const addMoreInputRef = useRef(null);

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
    uploadedDocuments.length,
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
        replaceActiveDocument(newFile, res.document);
        toast.success(`Replaced with ${res.document.originalName}`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not replace file."));
    } finally {
      setReplacing(false);
    }
  };

  const handleAddMoreFiles = async (e) => {
    const files = Array.from(e.target.files || []).filter(Boolean);
    e.target.value = "";
    if (files.length === 0 || replacing || submitting || !activeSlug) return;

    try {
      setReplacing(true);
      let added = 0;
      for (const f of files) {
        const res = await inspectAndStagePdf(activeSlug, f);
        if (res?.success && res.document) {
          addUploadedDocument(f, res.document);
          added++;
        }
      }
      if (added > 0) {
        toast.success(
          added === 1 ? `Added ${files[0].name}` : `Added ${added} documents`
        );
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not add document."));
    } finally {
      setReplacing(false);
    }
  };

  const handleRemoveFile = () => {
    if (uploadedDocuments.length > 1) {
      removeUploadedDocument(activeDocIndex);
      toast.success("Removed document from list");
    } else {
      clearDocument();
      navigate(activeSlug ? `/shop/${activeSlug}` : "/");
    }
  };

  const handleToggleSinglePageFromPreview = (pageNum) => {
    if (isImage) return;
    const currentPages =
      settings.pageSelectionMode === "all"
        ? Array.from({ length: totalPages }, (_, i) => i + 1)
        : settings.selectedPages || [1];

    const currentSet = new Set(currentPages);
    if (currentSet.has(pageNum)) {
      if (currentSet.size <= 1) {
        toast.error("At least 1 page must remain selected for printing.");
        return;
      }
      currentSet.delete(pageNum);
    } else {
      currentSet.add(pageNum);
    }
    const sorted = [...currentSet].sort((a, b) => a - b);
    updateSettings({
      pageSelectionMode: sorted.length === totalPages ? "all" : "selected",
      selectedPages: sorted,
      customPageRange: sorted.join(",")
    });
  };

  const resolveDocSelectedPages = (docEntry) => {
    const docTotal = docEntry.meta?.pageCount || 1;
    const docIsImg = docEntry.meta?.documentType === "image";
    const s = docEntry.settings || settings;

    if (docIsImg || s.pageSelectionMode === "all") {
      return Array.from({ length: docTotal }, (_, i) => i + 1);
    }
    if (s.pageSelectionMode === "selected") {
      return s.selectedPages && s.selectedPages.length > 0 ? s.selectedPages : [1];
    }
    const validation = validateCustomPageRangeInput(s.customPageRange, docTotal);
    return validation.valid ? validation.pages : s.selectedPages || [1];
  };

  const isShopAvailable = Boolean(printerState?.shopAvailable || printerState?.online);

  const handleCheckAvailability = async () => {
    if (checkingAvailability) return;
    try {
      setCheckingAvailability(true);
      await refreshPrinterStatus();
    } finally {
      setCheckingAvailability(false);
    }
  };

  const handlePrintNow = async () => {
    if (submittingRef.current || submitting || !activeSlug) return;
    if (!isShopAvailable) {
      toast.error(
        printerState?.unavailableReason ||
          "Sorry, this shop is currently unavailable and cannot accept print orders right now."
      );
      handleCheckAvailability();
      return;
    }
    if (customRangeError) {
      toast.error(customRangeError);
      return;
    }

    submittingRef.current = true;

    const docsToSubmit =
      uploadedDocuments.length > 0
        ? uploadedDocuments
        : [
            {
              file: selectedFile,
              meta: documentMeta,
              settings
            }
          ];

    try {
      setSubmitting(true);
      const createdOrders = [];

      for (let i = 0; i < docsToSubmit.length; i++) {
        const docItem = docsToSubmit[i];
        const docIsImg = docItem.meta?.documentType === "image";
        const s = docItem.settings || settings;
        const finalPages = resolveDocSelectedPages(docItem);

        const response = await createPrintOrder(activeSlug, {
          file: docItem.file,
          uploadId: docItem.meta?.uploadId,
          idempotencyKey: `${idempotencyKeyRef.current}-${i}`,
          pageSelectionMode: docIsImg ? "all" : s.pageSelectionMode,
          customPageRange:
            !docIsImg && s.pageSelectionMode === "custom"
              ? s.customPageRange
              : undefined,
          selectedPages: finalPages,
          copies: s.copies,
          colorMode: s.colorMode,
          sides: docIsImg ? "single" : s.sides,
          paperSize: s.paperSize,
          orientation: s.orientation
        });

        if (response?.success && response.order) {
          saveCustomerOrderToken(activeSlug, response.order.token);
          createdOrders.push(response.order);
        } else {
          throw new Error(`Could not submit "${docItem.meta?.originalName}".`);
        }
      }

      if (createdOrders.length > 0) {
        setActiveOrder(createdOrders[0]);
        setSubmittedBatchOrders(createdOrders);
        toast.success(
          createdOrders.length === 1
            ? "Print request sent to shop!"
            : `Sent ${createdOrders.length} documents to shop print queue!`
        );
        navigate(`/shop/${activeSlug}/job/${createdOrders[0].token}`, {
          replace: true
        });
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Failed to submit print job."));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const activeSelectedPages =
    isImage || settings.pageSelectionMode === "all"
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : settings.selectedPages || [1];

  const activePriceQuote = calculateOrderPriceQuote({
    pricing: shopPricing,
    logicalPagesPerCopy: activeSelectedPages.length,
    copies: settings.copies,
    colorMode: settings.colorMode,
    sides: isImage ? "single" : settings.sides,
    paperSize: settings.paperSize
  });

  const totalImpressions = activePriceQuote.printedSidesTotal;
  const activePhysicalSheets = activePriceQuote.totalPhysicalSheets;

  const batchSummary = uploadedDocuments.reduce(
    (acc, docItem) => {
      const pages = resolveDocSelectedPages(docItem);
      const s = docItem.settings || settings;
      const docIsImg = docItem.meta?.documentType === "image";
      const docQuote = calculateOrderPriceQuote({
        pricing: shopPricing,
        logicalPagesPerCopy: pages.length,
        copies: s.copies,
        colorMode: s.colorMode,
        sides: docIsImg ? "single" : s.sides,
        paperSize: s.paperSize
      });
      acc.impressions += docQuote.printedSidesTotal;
      acc.sheets += docQuote.totalPhysicalSheets;
      acc.totalPrice = Math.round((acc.totalPrice + docQuote.totalPrice) * 100) / 100;
      return acc;
    },
    { impressions: 0, sheets: 0, totalPrice: 0 }
  );

  const displayedTotalPrice =
    uploadedDocuments.length > 1 ? batchSummary.totalPrice : activePriceQuote.totalPrice;

  return (
    <div className="space-y-4 pb-28">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-zinc-900">
            Preview &amp; Print Settings
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

        {/* Add Another Document Button */}
        <div>
          <input
            ref={addMoreInputRef}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
            onChange={handleAddMoreFiles}
            className="hidden"
            disabled={replacing || submitting}
          />
          <LoadingButton
            type="button"
            loading={replacing}
            loadingText="Uploading..."
            disabled={submitting}
            icon={Plus}
            spinnerClassName="w-3.5 h-3.5"
            onClick={() => addMoreInputRef.current?.click()}
            className="px-3.5 py-2 rounded-xl border border-[#8D0100]/30 bg-white hover:bg-[#8D0100]/5 text-[#8D0100] text-xs font-semibold shadow-2xs"
          >
            Add Another Document
          </LoadingButton>
        </div>
      </div>

      {/* Shop Availability Banner on Settings Page */}
      {!isShopAvailable && printerState?.connectionState !== "CONNECTING" && (
        <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 flex flex-wrap items-center justify-between gap-2.5 text-xs shadow-2xs">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">Shop Temporarily Unavailable</p>
              <p className="text-amber-800 mt-0.5 leading-relaxed">
                {printerState?.unavailableReason ||
                  printerState?.statusMessage ||
                  "Sorry, this shop is currently offline or its printer is disconnected. You can preview and configure your document, and Print Now will automatically unlock when the shop comes online."}
              </p>
            </div>
          </div>
          <LoadingButton
            type="button"
            loading={checkingAvailability}
            loadingText="Checking..."
            icon={RefreshCw}
            spinnerClassName="w-3.5 h-3.5"
            onClick={handleCheckAvailability}
            className="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold text-xs shrink-0"
          >
            Check Availability
          </LoadingButton>
        </div>
      )}

      {/* Multiple Uploaded Documents List & Switcher */}
      {uploadedDocuments.length > 1 && (
        <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3 shadow-2xs">
          <div className="flex items-center justify-between text-xs pb-2 border-b border-zinc-100">
            <span className="font-bold uppercase tracking-wider text-zinc-500">
              Uploaded Documents ({uploadedDocuments.length} files)
            </span>
            <span className="font-mono-code font-semibold text-zinc-800">
              Total Pages: {totalBatchPages} • Est. Sheets: {batchSummary.sheets} • ₹
              {batchSummary.totalPrice}
            </span>
          </div>

          <div className="space-y-2">
            {uploadedDocuments.map((doc, idx) => {
              const isCurrent = idx === activeDocIndex;
              const docIsImg = doc.meta?.documentType === "image";
              const docPages = doc.meta?.pageCount || 1;
              return (
                <div
                  key={doc.id}
                  onClick={() => setActiveDocIndex(idx)}
                  className={`p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition ${
                    isCurrent
                      ? "border-[#8D0100] bg-[#8D0100]/5 ring-1 ring-[#8D0100]"
                      : "border-zinc-200 bg-zinc-50/70 hover:bg-zinc-100"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isCurrent
                          ? "bg-[#8D0100] text-white"
                          : "bg-white border border-zinc-200 text-zinc-700"
                      }`}
                    >
                      {docIsImg ? (
                        <ImageIcon className="w-4 h-4" />
                      ) : (
                        <FileText className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-semibold text-zinc-900 truncate">
                        {idx + 1}. {doc.meta?.originalName}
                      </p>
                      <p className="text-[11px] font-mono-code text-zinc-500">
                        {formatFileSize(doc.meta?.fileSize)} •{" "}
                        {docIsImg
                          ? "1 image page"
                          : `${docPages} ${docPages === 1 ? "page" : "pages"} PDF`}{" "}
                        • {doc.settings?.copies || 1}x •{" "}
                        {doc.settings?.colorMode === "color" ? "Colour" : "B&W"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isCurrent && (
                      <span className="px-2 py-0.5 rounded bg-[#8D0100] text-white text-[10px] font-bold uppercase">
                        Previewing
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        removeUploadedDocument(idx);
                      }}
                      title="Remove this file"
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
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
        onReplace={handleReplaceFile}
        onRemove={handleRemoveFile}
        disabled={replacing || submitting}
      />

      <DocumentPreview
        file={selectedFile}
        originalName={documentMeta.originalName}
        fileSize={documentMeta.fileSize}
        documentType={documentMeta.documentType}
        pageCount={totalPages}
        width={documentMeta.width}
        height={documentMeta.height}
        selectedPages={activeSelectedPages}
        onTogglePage={handleToggleSinglePageFromPreview}
        onOrientationChange={(orient) => updateSettings({ orientation: orient })}
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
        pricing={shopPricing}
        priceQuote={activePriceQuote}
        customRangeError={customRangeError}
      />

      {/* Final Print Summary Card */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3 shadow-2xs">
        <div className="flex items-center justify-between pb-2.5 border-b border-zinc-100">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#8D0100]" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-700">
              Final Print Summary &amp; Estimated Price
            </h3>
          </div>
          <span className="px-2.5 py-0.5 rounded-md bg-[#8D0100]/10 text-[#8D0100] text-xs font-mono-code font-bold">
            Estimated Total: ₹{displayedTotalPrice}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
          <div>
            <dt className="text-zinc-500">Target Shop &amp; Printer</dt>
            <dd className="font-semibold text-zinc-900 truncate mt-0.5">
              {shopInfo?.shopName || activeSlug} •{" "}
              {printerState?.printerName || "Shop Printer"}
            </dd>
          </div>

          <div>
            <dt className="text-zinc-500">Paper Size &amp; Orientation</dt>
            <dd className="font-mono-code font-semibold text-zinc-900 capitalize mt-0.5">
              {settings.paperSize} •{" "}
              {settings.orientation === "auto"
                ? documentMeta.detectedOrientation || "portrait"
                : settings.orientation}
            </dd>
          </div>

          <div>
            <dt className="text-zinc-500">Colour &amp; Sides</dt>
            <dd className="font-semibold text-zinc-900 mt-0.5">
              {settings.colorMode === "color" ? "Full Colour" : "Black & White"} •{" "}
              {!isImage && settings.sides === "duplex"
                ? `Double-sided (₹${activePriceQuote.appliedDuplexRate}/sheet)`
                : `Single-sided (₹${activePriceQuote.appliedSingleRate}/page)`}
            </dd>
          </div>

          <div>
            <dt className="text-zinc-500">Selected Page Range</dt>
            <dd className="font-mono-code font-semibold text-zinc-900 mt-0.5">
              {isImage
                ? "Page 1 of 1"
                : summarizeSelectedPages(activeSelectedPages, totalPages)}
            </dd>
          </div>

          <div>
            <dt className="text-zinc-500">Copies &amp; Printed Sides</dt>
            <dd className="font-mono-code font-semibold text-zinc-900 mt-0.5">
              {settings.copies} {settings.copies === 1 ? "copy" : "copies"} (
              {uploadedDocuments.length > 1 ? batchSummary.impressions : totalImpressions}{" "}
              printed sides)
            </dd>
          </div>

          <div>
            <dt className="text-zinc-500">Physical Sheets &amp; Total Price</dt>
            <dd className="font-mono-code font-bold text-[#8D0100] mt-0.5">
              {uploadedDocuments.length > 1
                ? `${batchSummary.sheets} ${batchSummary.sheets === 1 ? "sheet" : "sheets"}`
                : `${activePhysicalSheets} ${activePhysicalSheets === 1 ? "sheet" : "sheets"}`}{" "}
              • ₹{displayedTotalPrice}
            </dd>
          </div>
        </dl>
      </div>

      <BottomActionBar
        primaryLabel={
          !isShopAvailable
            ? "Shop Temporarily Unavailable"
            : uploadedDocuments.length > 1
              ? `Print All ${uploadedDocuments.length} Documents — ₹${displayedTotalPrice}`
              : `Print Now — ₹${displayedTotalPrice}`
        }
        primaryLoadingLabel="Submitting..."
        onPrimaryClick={handlePrintNow}
        primaryDisabled={
          submitting ||
          replacing ||
          Boolean(customRangeError) ||
          !isShopAvailable
        }
        primaryLoading={submitting}
        primaryIcon={Printer}
        summaryLeft={
          uploadedDocuments.length > 1
            ? `${uploadedDocuments.length} files • ${totalBatchPages} pgs`
            : isImage
              ? `Image (${formatFileSize(documentMeta.fileSize)})`
              : summarizeSelectedPages(activeSelectedPages, totalPages)
        }
        summaryRight={`${settings.copies}x • ${
          uploadedDocuments.length > 1 ? batchSummary.sheets : activePhysicalSheets
        } ${
          (uploadedDocuments.length > 1 ? batchSummary.sheets : activePhysicalSheets) === 1
            ? "sheet"
            : "sheets"
        } • ₹${displayedTotalPrice}`}
      />
    </div>
  );
}
