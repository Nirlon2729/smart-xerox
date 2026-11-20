const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  shell
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { validateSelectedPrinterPayload } = require("./ipcValidators.cjs");

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let agentProcess = null;
let agentRestartTimer = null;
let agentState = {
  running: false,
  pid: null,
  startedAt: null,
  lastExitCode: null,
  lastError: null,
  pythonPath: null,
  agentScriptPath: null
};

function getStorePath() {
  return path.join(app.getPath("userData"), "secure-vendor-store.json");
}

function getAgentRuntimeConfigPath() {
  return path.join(app.getPath("userData"), "agent-runtime-config.json");
}

function getAgentLogPath() {
  return path.join(app.getPath("userData"), "agent.log");
}

function getAgentLedgerPath() {
  return path.join(app.getPath("userData"), "completed_jobs.json");
}

function encryptSecret(plainText) {
  if (!plainText) return null;
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return {
        dpapi: true,
        data: safeStorage.encryptString(String(plainText)).toString("base64")
      };
    }
  } catch (_err) {
    // Fallback below
  }
  return {
    dpapi: false,
    data: Buffer.from(String(plainText), "utf-8").toString("base64")
  };
}

function decryptSecret(payload) {
  if (!payload || !payload.data) return "";
  try {
    const buf = Buffer.from(payload.data, "base64");
    if (payload.dpapi && safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf-8");
  } catch (_err) {
    return "";
  }
}

const DEFAULT_PRODUCTION_API_URL = "https://smart-xerox-api.onrender.com/api";
const DEFAULT_PRODUCTION_WEB_URL = "https://smart-xerox-web-2mwa.onrender.com";

function normalizeStoredApiUrl(value) {
  const cleaned = String(value || "").trim().replace(/\/+$/, "");
  if (
    !cleaned ||
    cleaned === "http://localhost:5000/api" ||
    cleaned === "http://localhost:5000" ||
    cleaned === "http://127.0.0.1:5000/api" ||
    cleaned === "http://127.0.0.1:5000" ||
    cleaned === "https://smart-xerox-api" ||
    cleaned === "https://smart-xerox-api.onrender.com"
  ) {
    return DEFAULT_PRODUCTION_API_URL;
  }
  let withProtocol = cleaned;
  if (!/^https?:\/\//i.test(withProtocol)) {
    const isLocal = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(
      withProtocol
    );
    withProtocol = `${isLocal ? "http" : "https"}://${withProtocol}`;
  }
  const withoutTrailingApi = withProtocol.replace(/(\/api)+$/i, "");
  return `${withoutTrailingApi}/api`;
}

function normalizeStoredCustomerUrl(value) {
  const cleaned = String(value || "").trim().replace(/\/+$/, "");
  if (
    !cleaned ||
    cleaned.includes("smartxerox.com") ||
    cleaned === "https://smart-xerox-web" ||
    cleaned === "https://smart-xerox-web-2mwa" ||
    cleaned === "https://smart-xerox-web.onrender.com" ||
    cleaned.includes("localhost") ||
    cleaned.includes("127.0.0.1")
  ) {
    return DEFAULT_PRODUCTION_WEB_URL;
  }
  const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    const parsed = new URL(withProto);
    if (!parsed.hostname.includes(".")) {
      return DEFAULT_PRODUCTION_WEB_URL;
    }
  } catch (_e) {
    return DEFAULT_PRODUCTION_WEB_URL;
  }
  return withProto;
}

function readRawStore() {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    const initial = {
      deviceId: `win-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "")}-${crypto.randomBytes(4).toString("hex")}`,
      apiBaseUrl: normalizeStoredApiUrl(process.env.SMART_XEROX_API_URL),
      customerBaseUrl: normalizeStoredCustomerUrl(process.env.SMART_XEROX_WEB_URL),
      autoStartWithWindows: true,
      theme: "light",
      admin: null,
      tenant: null,
      agentId: null,
      encryptedVendorToken: null,
      encryptedAgentSecret: null
    };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    let migrated = false;
    const normalizedApi = normalizeStoredApiUrl(parsed.apiBaseUrl);
    if (parsed.apiBaseUrl !== normalizedApi) {
      parsed.apiBaseUrl = normalizedApi;
      migrated = true;
    }
    const normalizedWeb = normalizeStoredCustomerUrl(parsed.customerBaseUrl);
    if (parsed.customerBaseUrl !== normalizedWeb) {
      parsed.customerBaseUrl = normalizedWeb;
      migrated = true;
    }
    if (parsed.tenant && parsed.tenant.shopSlug) {
      const expectedPublicUrl = `${DEFAULT_PRODUCTION_WEB_URL}/shop/${parsed.tenant.shopSlug}`;
      if (parsed.tenant.publicUrl !== expectedPublicUrl) {
        parsed.tenant.publicUrl = expectedPublicUrl;
        migrated = true;
      }
    }
    if (migrated) {
      fs.writeFileSync(storePath, JSON.stringify(parsed, null, 2), "utf-8");
    }
    return parsed;
  } catch (_e) {
    return {
      deviceId: `win-${crypto.randomBytes(4).toString("hex")}`,
      apiBaseUrl: DEFAULT_PRODUCTION_API_URL,
      customerBaseUrl: DEFAULT_PRODUCTION_WEB_URL,
      autoStartWithWindows: true,
      theme: "light"
    };
  }
}

function writeRawStore(data) {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
}

function getDecryptedSession() {
  const raw = readRawStore();
  const vendorToken = decryptSecret(raw.encryptedVendorToken);
  const agentSecret = decryptSecret(raw.encryptedAgentSecret);

  return {
    deviceId: raw.deviceId,
    apiBaseUrl: normalizeStoredApiUrl(raw.apiBaseUrl),
    customerBaseUrl: normalizeStoredCustomerUrl(raw.customerBaseUrl),
    autoStartWithWindows: raw.autoStartWithWindows !== false,
    theme: raw.theme || "light",
    admin: raw.admin || null,
    tenant: raw.tenant || null,
    agentId: raw.agentId || null,
    vendorToken: vendorToken || "",
    hasAgentCredentials: Boolean(raw.agentId && agentSecret),
    agentSecret
  };
}

function resolvePythonAndAgentPaths() {
  const candidates = [];

  if (app.isPackaged) {
    const resDir = path.join(process.resourcesPath, "print-agent");
    candidates.push({
      python: path.join(resDir, "python", "python.exe"),
      script: path.join(resDir, "agent.py"),
      cwd: resDir
    });
  }

  // Local dev / workspace paths
  const localRuntimeDir = path.resolve(__dirname, "../agent-runtime");
  candidates.push({
    python: path.join(localRuntimeDir, "python", "python.exe"),
    script: path.join(localRuntimeDir, "agent.py"),
    cwd: localRuntimeDir
  });

  const repoAgentDir = path.resolve(__dirname, "../../print-agent");
  candidates.push({
    python: path.join(repoAgentDir, ".venv", "Scripts", "python.exe"),
    script: path.join(repoAgentDir, "agent.py"),
    cwd: repoAgentDir
  });

  for (const item of candidates) {
    if (fs.existsSync(item.python) && fs.existsSync(item.script)) {
      return item;
    }
  }

  return {
    python: "python",
    script: path.join(repoAgentDir, "agent.py"),
    cwd: repoAgentDir
  };
}

function syncAgentRuntimeConfigFile() {
  const session = getDecryptedSession();
  const cfgPath = getAgentRuntimeConfigPath();
  const payload = {
    backendApiUrl: session.apiBaseUrl,
    agentId: session.agentId || "",
    agentSecret: session.agentSecret || "",
    deviceId: session.deviceId,
    selectedPrinterName: session.tenant?.selectedPrinterName || "",
    pollIntervalSeconds: 3,
    logFile: getAgentLogPath(),
    ledgerFile: getAgentLedgerPath()
  };

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2), "utf-8");
  return cfgPath;
}

async function notifyBackendAgentOffline(reason = "Vendor closed Smart Xerox desktop application.") {
  try {
    const session = getDecryptedSession();
    const apiBase = normalizeStoredApiUrl(session.apiBaseUrl);
    if (session.agentId && session.agentSecret) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      await fetch(`${apiBase}/agent/offline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-agent-id": session.agentId,
          "x-agent-secret": session.agentSecret
        },
        body: JSON.stringify({
          deviceId: session.deviceId || "",
          reason
        }),
        signal: controller.signal
      }).catch(() => {});
      clearTimeout(timeoutId);
    } else if (session.vendorToken) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      await fetch(`${apiBase}/vendor/agents/offline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.vendorToken}`
        },
        body: JSON.stringify({
          deviceId: session.deviceId || "",
          reason
        }),
        signal: controller.signal
      }).catch(() => {});
      clearTimeout(timeoutId);
    }
  } catch (_err) {
    // Non-fatal on exit
  }
}

function stopBackgroundAgent({ notifyOffline = false, reason = "Print agent stopped." } = {}) {
  if (agentRestartTimer) {
    clearTimeout(agentRestartTimer);
    agentRestartTimer = null;
  }

  if (notifyOffline) {
    notifyBackendAgentOffline(reason);
  }

  if (agentProcess && agentProcess.pid) {
    const pid = agentProcess.pid;
    agentProcess.removeAllListeners();
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        agentProcess.kill("SIGTERM");
      }
    } catch (_err) {
      // Ignore kill errors
    }
    agentProcess = null;
  }

  agentState.running = false;
  agentState.pid = null;
}

function startBackgroundAgent() {
  stopBackgroundAgent();

  const session = getDecryptedSession();
  if (!session.agentId || !session.agentSecret) {
    agentState.running = false;
    agentState.lastError = "Waiting for vendor sign-in and agent pairing.";
    return agentState;
  }

  const cfgPath = syncAgentRuntimeConfigFile();
  const { python, script, cwd } = resolvePythonAndAgentPaths();

  agentState.pythonPath = python;
  agentState.agentScriptPath = script;

  if (!fs.existsSync(script)) {
    agentState.running = false;
    agentState.lastError = `Print agent script not found at ${script}`;
    return agentState;
  }

  try {
    const child = spawn(python, [script, "--config", cfgPath], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    agentProcess = child;
    agentState.running = true;
    agentState.pid = child.pid;
    agentState.startedAt = new Date().toISOString();
    agentState.lastError = null;

    child.stderr.on("data", (chunk) => {
      const msg = String(chunk || "").trim();
      if (msg) {
        agentState.lastError = msg.slice(-300);
      }
    });

    child.on("exit", (code) => {
      agentState.running = false;
      agentState.pid = null;
      agentState.lastExitCode = code;

      if (!isQuitting) {
        const currentSession = getDecryptedSession();
        if (currentSession.agentId && currentSession.agentSecret) {
          agentRestartTimer = setTimeout(() => {
            startBackgroundAgent();
          }, 4000);
        }
      }
    });
  } catch (err) {
    agentState.running = false;
    agentState.lastError = err.message;
  }

  return agentState;
}

function runAgentCliJson(args = ["--list-printers-json"], timeoutMs = 12000) {
  return new Promise((resolve) => {
    const { python, script, cwd } = resolvePythonAndAgentPaths();
    if (!fs.existsSync(script)) {
      return resolve({
        success: false,
        error: `Print agent script not found at ${script}`,
        printers: []
      });
    }

    execFile(
      python,
      [script, ...args],
      { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          return resolve({
            success: false,
            error: stderr || error.message,
            output: stdout || stderr || error.message,
            printers: []
          });
        }
        const trimmed = String(stdout || "").trim();
        try {
          resolve(JSON.parse(trimmed));
        } catch (_e) {
          resolve({
            success: true,
            output: trimmed
          });
        }
      }
    );
  });
}

function readAgentLogTail(maxLines = 80) {
  const logPath = getAgentLogPath();
  if (!fs.existsSync(logPath)) {
    return "Print agent log will appear here once the agent starts polling.";
  }
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch (err) {
    return `Could not read agent log: ${err.message}`;
  }
}

function configureWindowsAutoStart(enable) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enable),
      path: process.execPath,
      args: ["--autostart"]
    });
  } catch (_err) {
    // Safe fallback
  }
}

function getAppIconPath() {
  const icoPath = path.join(__dirname, "../build/icon.ico");
  const pngPath = path.join(__dirname, "../build/icon.png");
  if (fs.existsSync(icoPath)) return icoPath;
  if (fs.existsSync(pngPath)) return pngPath;
  return undefined;
}

function createTray() {
  const iconPath = getAppIconPath();
  if (!iconPath) return;

  try {
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon);
    tray.setToolTip("Smart Xerox — Vendor Print Console & Background Agent");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Smart Xerox Console",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: "Restart Background Print Agent",
        click: () => {
          startBackgroundAgent();
        }
      },
      { type: "separator" },
      {
        label: "Quit Smart Xerox",
        click: async () => {
          isQuitting = true;
          await notifyBackendAgentOffline("Vendor quit Smart Xerox desktop application.");
          stopBackgroundAgent();
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (_err) {
    // Non-fatal
  }
}

function createMainWindow() {
  const startMinimized = process.argv.includes("--autostart");

  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Smart Xerox",
    show: !startMinimized,
    icon: getAppIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev
    }
  });

  // Block navigation away from the bundled application UI
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const allowedDev = isDev && process.env.VITE_DEV_SERVER_URL && targetUrl.startsWith(process.env.VITE_DEV_SERVER_URL);
    const allowedLocalFile = targetUrl.startsWith("file://");
    if (!allowedDev && !allowedLocalFile) {
      event.preventDefault();
    }
  });

  // Allow only about:blank popups (used for local QR standee print preview) and blob: document inspection
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url === "" || url.startsWith("blob:")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: false
          }
        }
      };
    }
    return { action: "deny" };
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("close", async (event) => {
    if (!isQuitting) {
      event.preventDefault();
      isQuitting = true;
      stopPrinterMonitor();
      await notifyBackendAgentOffline("Vendor closed Smart Xerox desktop application.");
      stopBackgroundAgent();
      app.exit(0);
    }
  });
}

/* ==========================================================================
   IPC SENDER VALIDATION & HANDLERS FOR ELECTRON RENDERER
   ========================================================================== */

function assertTrustedIpcSender(event) {
  if (!event || !event.sender || (mainWindow && event.sender !== mainWindow.webContents)) {
    throw new Error("Unauthorized IPC sender");
  }
  const frameUrl = String(event.senderFrame?.url || "");
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    if (!frameUrl.startsWith(process.env.VITE_DEV_SERVER_URL) && !frameUrl.startsWith("file://")) {
      throw new Error("Unauthorized IPC origin");
    }
  } else if (frameUrl && !frameUrl.startsWith("file://")) {
    throw new Error("Unauthorized IPC origin");
  }
}

ipcMain.handle("session:get", async (event) => {
  assertTrustedIpcSender(event);
  const s = getDecryptedSession();
  return {
    deviceId: s.deviceId,
    apiBaseUrl: DEFAULT_PRODUCTION_API_URL,
    customerBaseUrl: DEFAULT_PRODUCTION_WEB_URL,
    autoStartWithWindows: s.autoStartWithWindows,
    theme: s.theme,
    admin: s.admin,
    tenant: s.tenant,
    agentId: s.agentId,
    vendorToken: s.vendorToken,
    hasAgentCredentials: s.hasAgentCredentials,
    hostname: os.hostname(),
    osVersion: `${os.type()} ${os.release()}`
  };
});

ipcMain.handle("session:save", async (event, payload) => {
  assertTrustedIpcSender(event);
  const raw = readRawStore();

  // Production endpoints are centrally locked and cannot be overridden from renderer UI
  raw.apiBaseUrl = DEFAULT_PRODUCTION_API_URL;
  raw.customerBaseUrl = DEFAULT_PRODUCTION_WEB_URL;

  if (payload.admin !== undefined) {
    raw.admin = payload.admin;
  }
  if (payload.tenant !== undefined) {
    const prevSelectedPrinter =
      raw.tenant &&
      payload.tenant &&
      String(raw.tenant.id || raw.tenant.tenantId) ===
        String(payload.tenant.id || payload.tenant.tenantId)
        ? raw.tenant.selectedPrinterName
        : null;
    raw.tenant = payload.tenant;
    if (raw.tenant) {
      if (!raw.tenant.selectedPrinterName && prevSelectedPrinter) {
        raw.tenant.selectedPrinterName = prevSelectedPrinter;
      }
      if (raw.tenant.shopSlug) {
        raw.tenant.publicUrl = `${DEFAULT_PRODUCTION_WEB_URL}/shop/${raw.tenant.shopSlug}`;
      }
    }
  }
  if (payload.vendorToken !== undefined) {
    raw.encryptedVendorToken = payload.vendorToken
      ? encryptSecret(payload.vendorToken)
      : null;
  }
  if (payload.agentId !== undefined) {
    raw.agentId = payload.agentId;
  }
  if (payload.agentSecret !== undefined) {
    raw.encryptedAgentSecret = payload.agentSecret
      ? encryptSecret(payload.agentSecret)
      : null;
  }

  writeRawStore(raw);
  syncAgentRuntimeConfigFile();
  startBackgroundAgent();

  return {
    success: true,
    agentState: {
      ...agentState,
      agentId: raw.agentId,
      deviceId: raw.deviceId
    }
  };
});

ipcMain.handle("session:clear", async (event, { keepAgentRunning = false } = {}) => {
  assertTrustedIpcSender(event);
  if (!keepAgentRunning) {
    await notifyBackendAgentOffline("Vendor signed out of Smart Xerox desktop application.");
  }
  const raw = readRawStore();
  raw.admin = null;
  raw.encryptedVendorToken = null;

  if (!keepAgentRunning) {
    raw.agentId = null;
    raw.encryptedAgentSecret = null;
    raw.tenant = null;
    writeRawStore(raw);
    syncAgentRuntimeConfigFile();
    stopBackgroundAgent();
  } else {
    writeRawStore(raw);
  }

  return { success: true };
});

let lastPrinterSnapshotHash = "";
let lastDiscoveredPhysicalPrinters = [];
let printerMonitorTimer = null;
let printerMonitorBusy = false;

function computePrinterSnapshotHash(discovery) {
  if (!discovery || !Array.isArray(discovery.physicalPrinters || discovery.printers)) {
    return "";
  }
  const list = discovery.physicalPrinters || discovery.printers || [];
  return JSON.stringify(
    list.map((p) => ({
      name: p.name,
      portName: p.portName,
      driverName: p.driverName,
      connectionType: p.connectionType,
      isDefault: p.isDefault,
      printerAvailable: p.printerAvailable,
      status: p.status,
      workOffline: p.workOffline,
      driverMissing: p.driverMissing,
      spoolerJobCount: p.spoolerJobCount
    }))
  );
}

async function pollAndNotifyPrinters(includeVirtual = false) {
  const args = ["--list-printers-json"];
  if (includeVirtual) {
    args.push("--include-virtual");
  }
  const res = await runAgentCliJson(args);
  if (res && Array.isArray(res.physicalPrinters)) {
    lastDiscoveredPhysicalPrinters = res.physicalPrinters;
  } else if (res && Array.isArray(res.printers)) {
    lastDiscoveredPhysicalPrinters = res.printers.filter(
      (p) => !p.isVirtual && p.printerCategory !== "VIRTUAL"
    );
  }
  const nextHash = computePrinterSnapshotHash(res);
  if (nextHash && nextHash !== lastPrinterSnapshotHash) {
    lastPrinterSnapshotHash = nextHash;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("printers:updated", res);
    }
  }
  return res;
}

function startPrinterMonitor() {
  if (printerMonitorTimer) return;
  printerMonitorTimer = setInterval(async () => {
    if (printerMonitorBusy || isQuitting) return;
    printerMonitorBusy = true;
    try {
      await pollAndNotifyPrinters(false);
    } catch (_e) {
      // Ignore transient errors
    } finally {
      printerMonitorBusy = false;
    }
  }, 4500);
}

function stopPrinterMonitor() {
  if (printerMonitorTimer) {
    clearInterval(printerMonitorTimer);
    printerMonitorTimer = null;
  }
}

ipcMain.handle("printers:discover-local", async (event, opts = {}) => {
  assertTrustedIpcSender(event);
  return pollAndNotifyPrinters(Boolean(opts?.includeVirtual));
});

ipcMain.handle("printers:set-selected", async (event, payload) => {
  assertTrustedIpcSender(event);
  if (lastDiscoveredPhysicalPrinters.length === 0) {
    await pollAndNotifyPrinters(false);
  }
  const check = validateSelectedPrinterPayload(payload, lastDiscoveredPhysicalPrinters);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const raw = readRawStore();
  if (raw.tenant) {
    raw.tenant.selectedPrinterName = check.printerName;
    writeRawStore(raw);
  }
  syncAgentRuntimeConfigFile();
  return { success: true, selectedPrinterName: check.printerName };
});

ipcMain.handle("agent:status", async (event) => {
  assertTrustedIpcSender(event);
  const s = getDecryptedSession();
  return {
    running: agentState.running,
    pid: agentState.pid,
    startedAt: agentState.startedAt,
    lastExitCode: agentState.lastExitCode,
    lastError: agentState.lastError,
    pythonPath: agentState.pythonPath,
    agentId: s.agentId,
    deviceId: s.deviceId,
    hostname: os.hostname(),
    osVersion: `${os.type()} ${os.release()}`,
    logTail: readAgentLogTail(80)
  };
});

ipcMain.handle("agent:restart", async (event) => {
  assertTrustedIpcSender(event);
  const state = startBackgroundAgent();
  return {
    success: true,
    agentState: state,
    logTail: readAgentLogTail(80)
  };
});

ipcMain.handle("agent:stop", async (event) => {
  assertTrustedIpcSender(event);
  await notifyBackendAgentOffline("Background print agent stopped by vendor.");
  stopBackgroundAgent();
  return {
    success: true,
    agentState
  };
});

ipcMain.handle("agent:diagnose", async (event) => {
  assertTrustedIpcSender(event);
  const cfgPath = syncAgentRuntimeConfigFile();
  return runAgentCliJson(["--diagnose", "--config", cfgPath], 20000);
});

ipcMain.handle("settings:update", async (event, partial) => {
  assertTrustedIpcSender(event);
  const raw = readRawStore();
  // Server endpoints are centrally locked — never allow renderer override
  raw.apiBaseUrl = DEFAULT_PRODUCTION_API_URL;
  raw.customerBaseUrl = DEFAULT_PRODUCTION_WEB_URL;

  if (partial.autoStartWithWindows !== undefined) {
    raw.autoStartWithWindows = Boolean(partial.autoStartWithWindows);
    configureWindowsAutoStart(raw.autoStartWithWindows);
  }
  if (partial.theme !== undefined) {
    raw.theme = partial.theme === "dark" ? "dark" : "light";
  }
  if (partial.tenant !== undefined) {
    raw.tenant = partial.tenant;
    if (raw.tenant && raw.tenant.shopSlug) {
      raw.tenant.publicUrl = `${DEFAULT_PRODUCTION_WEB_URL}/shop/${raw.tenant.shopSlug}`;
    }
  }
  writeRawStore(raw);
  syncAgentRuntimeConfigFile();
  return {
    success: true,
    settings: {
      autoStartWithWindows: raw.autoStartWithWindows,
      theme: raw.theme
    }
  };
});

ipcMain.handle("external:open", async (event, url) => {
  assertTrustedIpcSender(event);
  try {
    const parsed = new URL(String(url || ""));
    if (
      parsed.protocol === "https:" &&
      parsed.origin === DEFAULT_PRODUCTION_WEB_URL
    ) {
      await shell.openExternal(parsed.toString());
      return { success: true };
    }
  } catch (_e) {
    // Reject invalid or non-allowlisted external URLs
  }
  return { success: false };
});

/* ==========================================================================
   APPLICATION LIFECYCLE
   ========================================================================== */

if (process.argv.includes("--cli-self-test")) {
  app.whenReady().then(async () => {
    const discovery = await runAgentCliJson(["--list-printers-json"]);
    console.log(
      JSON.stringify({
        selfTest: "PASS",
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        printerDiscovery: discovery
      })
    );
    app.exit(0);
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      const s = getDecryptedSession();
      configureWindowsAutoStart(s.autoStartWithWindows);
      createTray();
      createMainWindow();
      startPrinterMonitor();
      if (s.hasAgentCredentials) {
        startBackgroundAgent();
      }
    });

    app.on("before-quit", () => {
      isQuitting = true;
      stopPrinterMonitor();
      notifyBackendAgentOffline("Vendor closed Smart Xerox desktop application.");
      stopBackgroundAgent();
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        stopPrinterMonitor();
        stopBackgroundAgent();
        app.quit();
      }
    });
  }
}
