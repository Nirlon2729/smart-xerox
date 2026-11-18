const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getSession: () => ipcRenderer.invoke("session:get"),
  saveSession: (payload) => ipcRenderer.invoke("session:save", payload),
  clearSession: (opts) => ipcRenderer.invoke("session:clear", opts),
  discoverLocalPrinters: () => ipcRenderer.invoke("printers:discover-local"),
  setSelectedPrinterLocal: (printerName) =>
    ipcRenderer.invoke("printers:set-selected", { printerName }),
  getAgentStatus: () => ipcRenderer.invoke("agent:status"),
  restartAgent: () => ipcRenderer.invoke("agent:restart"),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  runAgentDiagnostics: () => ipcRenderer.invoke("agent:diagnose"),
  updateLocalSettings: (partial) => ipcRenderer.invoke("settings:update", partial),
  openExternalUrl: (url) => ipcRenderer.invoke("external:open", url)
});
