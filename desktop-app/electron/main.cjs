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

function readRawStore() {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    const initial = {
      deviceId: `win-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "")}-${crypto.randomBytes(4).toString("hex")}`,
      apiBaseUrl: process.env.SMART_XEROX_API_URL || "http://localhost:5000/api",
      customerBaseUrl: process.env.SMART_XEROX_WEB_URL || "https://smartxerox.com",
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
    return JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch (_e) {
    return {
      deviceId: `win-${crypto.randomBytes(4).toString("hex")}`,
      apiBaseUrl: "http://localhost:5000/api",
      customerBaseUrl: "https://smartxerox.com",
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
    apiBaseUrl: raw.apiBaseUrl || "http://localhost:5000/api",
    customerBaseUrl: raw.customerBaseUrl || "https://smartxerox.com",
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

function stopBackgroundAgent() {
  if (agentRestartTimer) {
    clearTimeout(agentRestartTimer);
    agentRestartTimer = null;
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
        click: () => {
          isQuitting = true;
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
      sandbox: false
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

/* ==========================================================================
   IPC HANDLERS FOR ELECTRON RENDERER
   ========================================================================== */

ipcMain.handle("session:get", async () => {
  const s = getDecryptedSession();
  return {
    deviceId: s.deviceId,
    apiBaseUrl: s.apiBaseUrl,
    customerBaseUrl: s.customerBaseUrl,
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

ipcMain.handle("session:save", async (_event, payload) => {
  const raw = readRawStore();

  if (payload.apiBaseUrl) {
    raw.apiBaseUrl = String(payload.apiBaseUrl).trim().replace(/\/+$/, "");
  }
  if (payload.customerBaseUrl) {
    raw.customerBaseUrl = String(payload.customerBaseUrl).trim().replace(/\/+$/, "");
  }
  if (payload.admin !== undefined) {
    raw.admin = payload.admin;
  }
  if (payload.tenant !== undefined) {
    raw.tenant = payload.tenant;
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

ipcMain.handle("session:clear", async (_event, { keepAgentRunning = false } = {}) => {
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

ipcMain.handle("printers:discover-local", async () => {
  return runAgentCliJson(["--list-printers-json"]);
});

ipcMain.handle("printers:set-selected", async (_event, { printerName }) => {
  const raw = readRawStore();
  if (raw.tenant) {
    raw.tenant.selectedPrinterName = printerName;
    writeRawStore(raw);
  }
  syncAgentRuntimeConfigFile();
  return { success: true, selectedPrinterName: printerName };
});

ipcMain.handle("agent:status", async () => {
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

ipcMain.handle("agent:restart", async () => {
  const state = startBackgroundAgent();
  return {
    success: true,
    agentState: state,
    logTail: readAgentLogTail(80)
  };
});

ipcMain.handle("agent:stop", async () => {
  stopBackgroundAgent();
  return {
    success: true,
    agentState
  };
});

ipcMain.handle("agent:diagnose", async () => {
  const cfgPath = syncAgentRuntimeConfigFile();
  return runAgentCliJson(["--diagnose", "--config", cfgPath], 20000);
});

ipcMain.handle("settings:update", async (_event, partial) => {
  const raw = readRawStore();
  if (partial.apiBaseUrl !== undefined) {
    raw.apiBaseUrl = String(partial.apiBaseUrl).trim().replace(/\/+$/, "");
  }
  if (partial.customerBaseUrl !== undefined) {
    raw.customerBaseUrl = String(partial.customerBaseUrl).trim().replace(/\/+$/, "");
  }
  if (partial.autoStartWithWindows !== undefined) {
    raw.autoStartWithWindows = Boolean(partial.autoStartWithWindows);
    configureWindowsAutoStart(raw.autoStartWithWindows);
  }
  if (partial.theme !== undefined) {
    raw.theme = partial.theme === "dark" ? "dark" : "light";
  }
  if (partial.tenant !== undefined) {
    raw.tenant = partial.tenant;
  }
  writeRawStore(raw);
  syncAgentRuntimeConfigFile();
  return {
    success: true,
    settings: {
      apiBaseUrl: raw.apiBaseUrl,
      customerBaseUrl: raw.customerBaseUrl,
      autoStartWithWindows: raw.autoStartWithWindows,
      theme: raw.theme
    }
  };
});

ipcMain.handle("external:open", async (_event, url) => {
  if (url && /^https?:\/\//i.test(String(url))) {
    await shell.openExternal(String(url));
    return { success: true };
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
      if (s.hasAgentCredentials) {
        startBackgroundAgent();
      }
    });

    app.on("before-quit", () => {
      isQuitting = true;
      stopBackgroundAgent();
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin" && !tray) {
        stopBackgroundAgent();
        app.quit();
      }
    });
  }
}
