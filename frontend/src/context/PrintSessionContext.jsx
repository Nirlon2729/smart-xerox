import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { fetchShopInfo, getApiErrorMessage } from "../services/api";
import { normalizeVendorPricing, DEFAULT_VENDOR_PRICING } from "../utils/pricingCalculator";

const PrintSessionContext = createContext(null);

const DEFAULT_SETTINGS = {
  paperSize: "A4",
  colorMode: "bw",
  sides: "single",
  orientation: "portrait",
  pageSelectionMode: "all",
  customPageRange: "",
  selectedPages: [1],
  copies: 1
};

export function PrintSessionProvider({ children }) {
  const [shopSlug, setShopSlugState] = useState(null);
  const [shopInfo, setShopInfo] = useState(null);
  const [shopLoading, setShopLoading] = useState(false);
  const [shopError, setShopError] = useState(null);

  // Multi-file staged documents list: [{ id, file, previewObjectUrl, meta, settings }]
  const [uploadedDocuments, setUploadedDocuments] = useState([]);
  const [activeDocIndex, setActiveDocIndex] = useState(0);
  const [activeOrder, setActiveOrder] = useState(null);
  const [submittedBatchOrders, setSubmittedBatchOrders] = useState([]);

  const [printerState, setPrinterState] = useState({
    online: false,
    shopAvailable: false,
    availabilityStatus: "CONNECTING",
    availabilityLabel: "Checking Shop Availability...",
    unavailableReason: "Checking shop printer availability...",
    connectionState: "CONNECTING",
    statusLabel: "Connecting...",
    agentOnline: false,
    printerAvailable: false,
    printerName: "Shop Printer",
    portName: null,
    status: "CONNECTING",
    statusMessage: "Checking shop printer availability...",
    spoolerJobCount: 0,
    pricing: DEFAULT_VENDOR_PRICING,
    capabilities: {
      supportedPaperSizes: ["A4", "Letter", "Legal", "A5"],
      supportsColor: false,
      supportsDuplex: false
    },
    config: {
      maxUploadMb: Number(import.meta.env.VITE_MAX_UPLOAD_MB) || 20,
      maxCopies: Number(import.meta.env.VITE_MAX_COPIES) || 100
    }
  });

  const refreshPrinterStatus = useCallback(
    async (slugOverride = null, showInitialLoader = false) => {
      const activeSlug = slugOverride || shopSlug;
      if (!activeSlug) return;

      if (showInitialLoader) setShopLoading(true);
      try {
        const res = await fetchShopInfo(activeSlug);
        if (res?.success) {
          if (res.shop) setShopInfo(res.shop);
          if (res.printer) setPrinterState(res.printer);
          setShopError(null);
        }
      } catch (err) {
        const status = err?.response?.status;
        if (status === 404 || status === 403 || status === 400) {
          setShopError(
            getApiErrorMessage(err, "Print shop not found or currently unavailable.")
          );
          setShopInfo(null);
        } else {
          setPrinterState((prev) => ({
            ...prev,
            online: false,
            connectionState: "AGENT_OFFLINE",
            statusLabel: "Offline",
            agentOnline: false,
            printerAvailable: false,
            statusMessage: "Cannot reach cloud server to verify printer status."
          }));
        }
      } finally {
        if (showInitialLoader) setShopLoading(false);
      }
    },
    [shopSlug]
  );

  const clearAllDocumentsInternal = useCallback(() => {
    setUploadedDocuments((prev) => {
      prev.forEach((doc) => {
        if (doc.previewObjectUrl) {
          try {
            URL.revokeObjectURL(doc.previewObjectUrl);
          } catch (_e) {
            // Ignore revoke error
          }
        }
      });
      return [];
    });
    setActiveDocIndex(0);
  }, []);

  const setShopSlug = useCallback(
    (newSlug) => {
      const normalized = newSlug ? String(newSlug).trim().toLowerCase() : null;
      setShopSlugState((prev) => {
        if (prev !== normalized) {
          clearAllDocumentsInternal();
          setActiveOrder(null);
          setSubmittedBatchOrders([]);
          setShopError(null);
        }
        return normalized;
      });
    },
    [clearAllDocumentsInternal]
  );

  useEffect(() => {
    if (!shopSlug) return;
    refreshPrinterStatus(shopSlug, true);
    const interval = setInterval(() => refreshPrinterStatus(shopSlug, false), 4000);
    return () => clearInterval(interval);
  }, [shopSlug, refreshPrinterStatus]);

  // Clamp settings across all staged documents when printer capabilities change
  useEffect(() => {
    const caps = printerState?.capabilities;
    if (!caps) return;
    const allowedSizes =
      Array.isArray(caps.supportedPaperSizes) && caps.supportedPaperSizes.length > 0
        ? caps.supportedPaperSizes
        : ["A4"];

    setUploadedDocuments((prev) => {
      if (prev.length === 0) return prev;
      let anyChanged = false;
      const updated = prev.map((item) => {
        const nextSettings = { ...item.settings };
        let changed = false;
        if (!caps.supportsColor && nextSettings.colorMode === "color") {
          nextSettings.colorMode = "bw";
          changed = true;
        }
        if (!caps.supportsDuplex && nextSettings.sides === "duplex") {
          nextSettings.sides = "single";
          changed = true;
        }
        if (!allowedSizes.includes(nextSettings.paperSize)) {
          nextSettings.paperSize = allowedSizes.includes("A4") ? "A4" : allowedSizes[0];
          changed = true;
        }
        if (changed) {
          anyChanged = true;
          return { ...item, settings: nextSettings };
        }
        return item;
      });
      return anyChanged ? updated : prev;
    });
  }, [printerState?.capabilities]);

  const buildDocumentEntry = useCallback(
    (file, serverMeta) => {
      const total = serverMeta?.pageCount || 1;
      const allPages = Array.from({ length: total }, (_, i) => i + 1);
      const supportedSizes = printerState?.capabilities?.supportedPaperSizes || ["A4"];
      const defaultPaper = supportedSizes.includes("A4") ? "A4" : supportedSizes[0] || "A4";
      const previewUrl = file ? URL.createObjectURL(file) : null;

      return {
        id: serverMeta?.uploadId || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewObjectUrl: previewUrl,
        meta: serverMeta,
        settings: {
          ...DEFAULT_SETTINGS,
          paperSize: defaultPaper,
          orientation:
            serverMeta?.detectedOrientation === "landscape" ? "landscape" : "portrait",
          selectedPages: allPages,
          customPageRange: total === 1 ? "1" : `1-${total}`
        }
      };
    },
    [printerState]
  );

  // Replaces entire list with a single document (backward compatible)
  const setUploadedDocument = useCallback(
    (file, serverMeta) => {
      const entry = buildDocumentEntry(file, serverMeta);
      setUploadedDocuments((prev) => {
        prev.forEach((d) => {
          if (d.previewObjectUrl) {
            try {
              URL.revokeObjectURL(d.previewObjectUrl);
            } catch (_e) {
              // Ignore
            }
          }
        });
        return [entry];
      });
      setActiveDocIndex(0);
      setActiveOrder(null);
      setSubmittedBatchOrders([]);
    },
    [buildDocumentEntry]
  );

  // Appends one or more documents to the uploaded list
  const addUploadedDocument = useCallback(
    (file, serverMeta) => {
      const entry = buildDocumentEntry(file, serverMeta);
      setUploadedDocuments((prev) => {
        const next = [...prev, entry];
        setActiveDocIndex(next.length - 1);
        return next;
      });
      setActiveOrder(null);
    },
    [buildDocumentEntry]
  );

  // Replaces the currently active document in-place
  const replaceActiveDocument = useCallback(
    (file, serverMeta) => {
      const entry = buildDocumentEntry(file, serverMeta);
      setUploadedDocuments((prev) => {
        if (prev.length === 0) return [entry];
        const safeIdx = Math.min(activeDocIndex, prev.length - 1);
        const old = prev[safeIdx];
        if (old?.previewObjectUrl) {
          try {
            URL.revokeObjectURL(old.previewObjectUrl);
          } catch (_e) {
            // Ignore
          }
        }
        const next = [...prev];
        next[safeIdx] = entry;
        return next;
      });
    },
    [activeDocIndex, buildDocumentEntry]
  );

  // Removes a specific document by index or id
  const removeUploadedDocument = useCallback((indexOrId) => {
    setUploadedDocuments((prev) => {
      const targetIdx =
        typeof indexOrId === "number"
          ? indexOrId
          : prev.findIndex((d) => d.id === indexOrId);
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const target = prev[targetIdx];
      if (target?.previewObjectUrl) {
        try {
          URL.revokeObjectURL(target.previewObjectUrl);
        } catch (_e) {
          // Ignore
        }
      }
      const next = prev.filter((_, i) => i !== targetIdx);
      setActiveDocIndex((curr) => Math.max(0, Math.min(curr, next.length - 1)));
      return next;
    });
  }, []);

  const clearDocument = useCallback(() => {
    clearAllDocumentsInternal();
    setActiveOrder(null);
    setSubmittedBatchOrders([]);
  }, [clearAllDocumentsInternal]);

  const safeActiveIndex =
    uploadedDocuments.length > 0
      ? Math.min(activeDocIndex, uploadedDocuments.length - 1)
      : 0;
  const activeDoc = uploadedDocuments[safeActiveIndex] || null;

  const updateSettings = useCallback(
    (partial) => {
      setUploadedDocuments((prev) => {
        if (prev.length === 0) return prev;
        const idx = Math.min(activeDocIndex, prev.length - 1);
        const current = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...current,
          settings: {
            ...current.settings,
            ...partial
          }
        };
        return next;
      });
    },
    [activeDocIndex]
  );

  const totalBatchPages = useMemo(() => {
    return uploadedDocuments.reduce(
      (sum, doc) => sum + (Number(doc.meta?.pageCount) || 1),
      0
    );
  }, [uploadedDocuments]);

  const totalBatchSelectedPages = useMemo(() => {
    return uploadedDocuments.reduce((sum, doc) => {
      const isImg = doc.meta?.documentType === "image";
      const total = Number(doc.meta?.pageCount) || 1;
      const selCount =
        isImg || doc.settings?.pageSelectionMode === "all"
          ? total
          : doc.settings?.selectedPages?.length || 1;
      return sum + selCount * (Number(doc.settings?.copies) || 1);
    }, 0);
  }, [uploadedDocuments]);

  const shopPricing = useMemo(() => {
    return normalizeVendorPricing(shopInfo?.pricing || printerState?.pricing);
  }, [shopInfo?.pricing, printerState?.pricing]);

  return (
    <PrintSessionContext.Provider
      value={{
        shopSlug,
        setShopSlug,
        shopInfo,
        shopPricing,
        shopLoading,
        shopError,
        uploadedDocuments,
        activeDocIndex: safeActiveIndex,
        setActiveDocIndex,
        addUploadedDocument,
        replaceActiveDocument,
        removeUploadedDocument,
        totalBatchPages,
        totalBatchSelectedPages,
        pdfFile: activeDoc?.file || null,
        selectedFile: activeDoc?.file || null,
        previewObjectUrl: activeDoc?.previewObjectUrl || null,
        documentMeta: activeDoc?.meta || null,
        settings: activeDoc?.settings || DEFAULT_SETTINGS,
        updateSettings,
        printerState,
        refreshPrinterStatus: () => refreshPrinterStatus(shopSlug, false),
        shopConfig: shopInfo?.config || printerState.config,
        activeOrder,
        setActiveOrder,
        submittedBatchOrders,
        setSubmittedBatchOrders,
        setUploadedDocument,
        clearDocument
      }}
    >
      {children}
    </PrintSessionContext.Provider>
  );
}

export function usePrintSession() {
  const ctx = useContext(PrintSessionContext);
  if (!ctx) {
    throw new Error("usePrintSession must be used within a PrintSessionProvider");
  }
  return ctx;
}
