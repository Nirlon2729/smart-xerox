const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSession: () => ipcRenderer.invoke("session:get"),
  saveSession: (payload) => ipcRenderer.invoke("session:save", payload),
  clearSession: (opts) => ipcRenderer.invoke("session:clear", opts),
  discoverLocalPrinters: (opts = {}) =>
    ipcRenderer.invoke("printers:discover-local", opts),
  setSelectedPrinterLocal: (printerName) =>
    ipcRenderer.invoke("printers:set-selected", { printerName }),
  onPrintersUpdated: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === "function") {
        callback(payload);
      }
    };
    ipcRenderer.on("printers:updated", handler);
    return () => {
      ipcRenderer.removeListener("printers:updated", handler);
    };
  },
  getAgentStatus: () => ipcRenderer.invoke("agent:status"),
  restartAgent: () => ipcRenderer.invoke("agent:restart"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  runAgentDiagnostics: () => ipcRenderer.invoke("agent:diagnose"),
  updateLocalSettings: (partial) => ipcRenderer.invoke("settings:update", partial),
  openExternalUrl: (url) => ipcRenderer.invoke("external:open", url)
});
