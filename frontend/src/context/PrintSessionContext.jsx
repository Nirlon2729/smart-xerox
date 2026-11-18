import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { fetchShopInfo, getApiErrorMessage } from "../services/api";

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

  const [selectedFile, setSelectedFile] = useState(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState(null);
  const [documentMeta, setDocumentMeta] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activeOrder, setActiveOrder] = useState(null);

  const [printerState, setPrinterState] = useState({
    online: false,
    connectionState: "CONNECTING",
    statusLabel: "Connecting...",
    agentOnline: false,
    printerAvailable: false,
    printerName: "Shop Printer",
    portName: null,
    status: "CONNECTING",
    statusMessage: "Checking shop printer availability...",
    spoolerJobCount: 0,
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

  const setShopSlug = useCallback(
    (newSlug) => {
      const normalized = newSlug ? String(newSlug).trim().toLowerCase() : null;
      setShopSlugState((prev) => {
        if (prev !== normalized) {
          setSelectedFile(null);
          setDocumentMeta(null);
          setSettings(DEFAULT_SETTINGS);
          setActiveOrder(null);
          setShopError(null);
        }
        return normalized;
      });
    },
    []
  );

  useEffect(() => {
    if (!shopSlug) return;
    refreshPrinterStatus(shopSlug, true);
    const interval = setInterval(() => refreshPrinterStatus(shopSlug, false), 4000);
    return () => clearInterval(interval);
  }, [shopSlug, refreshPrinterStatus]);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedFile]);

  useEffect(() => {
    const caps = printerState?.capabilities;
    if (!caps) return;
    setSettings((prev) => {
      const next = { ...prev };
      let changed = false;
      if (!caps.supportsColor && prev.colorMode === "color") {
        next.colorMode = "bw";
        changed = true;
      }
      if (!caps.supportsDuplex && prev.sides === "duplex") {
        next.sides = "single";
        changed = true;
      }
      const allowedSizes =
        Array.isArray(caps.supportedPaperSizes) && caps.supportedPaperSizes.length > 0
          ? caps.supportedPaperSizes
          : ["A4"];
      if (!allowedSizes.includes(prev.paperSize)) {
        next.paperSize = allowedSizes.includes("A4") ? "A4" : allowedSizes[0];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [printerState?.capabilities]);

  const setUploadedDocument = useCallback(
    (file, serverMeta) => {
      setSelectedFile(file);
      setDocumentMeta(serverMeta);
      const total = serverMeta?.pageCount || 1;
      const allPages = Array.from({ length: total }, (_, i) => i + 1);
      const supportedSizes = printerState?.capabilities?.supportedPaperSizes || ["A4"];
      const defaultPaper = supportedSizes.includes("A4") ? "A4" : supportedSizes[0] || "A4";

      setSettings({
        ...DEFAULT_SETTINGS,
        paperSize: defaultPaper,
        orientation:
          serverMeta?.detectedOrientation === "landscape" ? "landscape" : "portrait",
        selectedPages: allPages,
        customPageRange: total === 1 ? "1" : `1-${total}`
      });
      setActiveOrder(null);
    },
    [printerState]
  );

  const clearDocument = useCallback(() => {
    setSelectedFile(null);
    setDocumentMeta(null);
    setSettings(DEFAULT_SETTINGS);
    setActiveOrder(null);
  }, []);

  const updateSettings = useCallback((partial) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  return (
    <PrintSessionContext.Provider
      value={{
        shopSlug,
        setShopSlug,
        shopInfo,
        shopLoading,
        shopError,
        pdfFile: selectedFile,
        selectedFile,
        previewObjectUrl,
        documentMeta,
        settings,
        updateSettings,
        printerState,
        refreshPrinterStatus: () => refreshPrinterStatus(shopSlug, false),
        shopConfig: shopInfo?.config || printerState.config,
        activeOrder,
        setActiveOrder,
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
