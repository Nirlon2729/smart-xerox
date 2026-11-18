import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { fetchPrinterStatus } from "../services/api";

const PrintSessionContext = createContext(null);

const DEFAULT_SETTINGS = {
  paperSize: "A4",
  colorMode: "bw",
  sides: "single",
  orientation: "auto",
  pageSelectionMode: "all",
  customPageRange: "",
  selectedPages: [1],
  copies: 1
};

export function PrintSessionProvider({ children }) {
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
    printerName: "HP LaserJet MFP M129-M134",
    portName: "USB002",
    status: "CONNECTING",
    statusMessage: "Checking Windows print agent and USB printer status...",
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

  const refreshPrinterStatus = useCallback(async () => {
    try {
      const res = await fetchPrinterStatus();
      if (res?.success && res.printer) {
        setPrinterState(res.printer);
      }
    } catch (_err) {
      setPrinterState((prev) => ({
        ...prev,
        online: false,
        connectionState: "AGENT_OFFLINE",
        statusLabel: "Agent Offline",
        agentOnline: false,
        printerAvailable: false,
        statusMessage: "Cannot reach backend server to verify printer status."
      }));
    }
  }, []);

  useEffect(() => {
    refreshPrinterStatus();
    const interval = setInterval(refreshPrinterStatus, 4000);
    return () => clearInterval(interval);
  }, [refreshPrinterStatus]);

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
        orientation: serverMeta?.detectedOrientation || "auto",
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
        pdfFile: selectedFile,
        selectedFile,
        previewObjectUrl,
        documentMeta,
        settings,
        updateSettings,
        printerState,
        refreshPrinterStatus,
        shopConfig: printerState.config,
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
