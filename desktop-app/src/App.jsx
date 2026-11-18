import React, { useState, useEffect, useCallback } from "react";
import toast, { Toaster } from "react-hot-toast";
import QRCode from "qrcode";
import {
  Printer,
  LayoutDashboard,
  QrCode,
  FileText,
  Cpu,
  Settings,
  LogOut,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
  Copy,
  ExternalLink,
  Search,
  RotateCcw,
  Trash2,
  Play,
  Square,
  ShieldCheck,
  Wifi,
  Usb,
  Sun,
  Moon,
  Lock,
  Server
} from "lucide-react";
import {
  configureDesktopApi,
  vendorLogin,
  pairDesktopAgent,
  revokeDesktopAgent,
  fetchVendorDashboard,
  selectVendorPrinter,
  updatePrinterCapabilities,
  updateVendorSettings,
  fetchVendorOrders,
  cancelVendorOrder,
  reprintVendorOrder,
  clearFailedVendorOrders,
  downloadVendorOrderBlob,
  getApiErrorMessage
} from "./services/desktopApi";

const ALL_PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "B5", "Executive"];

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "printers", label: "Printer Management", icon: Printer },
  { id: "qrcode", label: "Shop QR Code", icon: QrCode },
  { id: "jobs", label: "Print Jobs", icon: FileText },
  { id: "agent", label: "Agent Status", icon: Cpu },
  { id: "settings", label: "Settings", icon: Settings }
];

const STATUS_BADGES = {
  QUEUED: "bg-amber-50 text-amber-800 border-amber-200",
  DOWNLOADING: "bg-blue-50 text-blue-800 border-blue-200",
  PROCESSING: "bg-indigo-50 text-indigo-800 border-indigo-200",
  PRINTING: "bg-[#8D0100]/10 text-[#8D0100] border-[#8D0100]/30",
  COMPLETED: "bg-emerald-50 text-emerald-800 border-emerald-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  CANCELLED: "bg-zinc-100 text-zinc-600 border-zinc-200"
};

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [initializing, setInitializing] = useState(true);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [theme, setTheme] = useState("light");

  // Session & Config State (kept in memory & Electron DPAPI secure store; never in localStorage)
  const [session, setSession] = useState({
    deviceId: "",
    apiBaseUrl: "https://smart-xerox-api.onrender.com/api",
    customerBaseUrl: "https://smart-xerox-web-2mwa.onrender.com",
    autoStartWithWindows: true,
    vendorToken: "",
    admin: null,
    tenant: null,
    agentId: null,
    hasAgentCredentials: false,
    hostname: "WINDOWS-PC",
    osVersion: "Windows 11"
  });

  // Login Form State
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginApiUrl, setLoginApiUrl] = useState("https://smart-xerox-api.onrender.com/api");
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);

  // Live Vendor Data
  const [printerState, setPrinterState] = useState(null);
  const [localPrinters, setLocalPrinters] = useState([]);
  const [localVirtualPrinters, setLocalVirtualPrinters] = useState([]);
  const [showVirtualPrinters, setShowVirtualPrinters] = useState(false);
  const [expandedPrinterName, setExpandedPrinterName] = useState(null);
  const [discoveringPrinters, setDiscoveringPrinters] = useState(false);
  const [stats, setStats] = useState({
    todaysJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    pendingJobs: 0,
    totalJobs: 0
  });
  const [orders, setOrders] = useState([]);
  const [orderStatusFilter, setOrderStatusFilter] = useState("ALL");
  const [orderSearch, setOrderSearch] = useState("");
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  // Local Agent Process State
  const [localAgentStatus, setLocalAgentStatus] = useState({
    running: false,
    pid: null,
    startedAt: null,
    agentId: null,
    deviceId: null,
    logTail: ""
  });
  const [diagOutput, setDiagOutput] = useState(null);
  const [runningDiag, setRunningDiag] = useState(false);

  // QR Code Data URL
  const [qrDataUrl, setQrDataUrl] = useState("");

  // Modals
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [confirmReprintJob, setConfirmReprintJob] = useState(null);

  // Capability Override Form
  const [capForm, setCapForm] = useState({
    useManualOverride: false,
    supportedPaperSizes: ["A4", "Legal", "Letter", "A5"],
    supportsColor: false,
    supportsDuplex: false
  });
  const [savingCaps, setSavingCaps] = useState(false);

  // Settings Form
  const [settingsForm, setSettingsForm] = useState({
    shopName: "",
    phone: "",
    address: "",
    logoUrl: "",
    maxCopies: 100,
    maxUploadMb: 20,
    acceptingOrders: true,
    apiBaseUrl: "https://smart-xerox-api.onrender.com/api",
    customerBaseUrl: "https://smart-xerox-web-2mwa.onrender.com",
    autoStartWithWindows: true
  });
  const [savingSettings, setSavingSettings] = useState(false);

  const isDark = theme === "dark";

  // 1. Load encrypted session from Electron Main on startup
  useEffect(() => {
    async function boot() {
      try {
        if (window.electronAPI) {
          const stored = await window.electronAPI.getSession();
          const safeCustomerBaseUrl =
            stored.customerBaseUrl &&
            !stored.customerBaseUrl.includes("smartxerox.com") &&
            !stored.customerBaseUrl.includes("localhost")
              ? stored.customerBaseUrl
              : "https://smart-xerox-web-2mwa.onrender.com";

          const safeApiBaseUrl =
            stored.apiBaseUrl &&
            !stored.apiBaseUrl.includes("localhost") &&
            !stored.apiBaseUrl.includes("127.0.0.1")
              ? stored.apiBaseUrl
              : "https://smart-xerox-api.onrender.com/api";

          const safeTenant = stored.tenant
            ? {
                ...stored.tenant,
                publicUrl: `https://smart-xerox-web-2mwa.onrender.com/shop/${stored.tenant.shopSlug}`
              }
            : null;

          setSession({
            ...stored,
            customerBaseUrl: safeCustomerBaseUrl,
            apiBaseUrl: safeApiBaseUrl,
            tenant: safeTenant
          });
          setTheme(stored.theme || "light");
          setLoginApiUrl(safeApiBaseUrl);
          configureDesktopApi({
            apiBaseUrl: safeApiBaseUrl,
            vendorToken: stored.vendorToken
          });
        }
      } catch (_err) {
        // Fallback if opened in browser dev preview
      } finally {
        setInitializing(false);
      }
    }
    boot();
  }, []);

  // 2. Discover local Windows printers via Python agent IPC
  const applyLocalDiscoveryResult = useCallback((res) => {
    if (!res) return;
    const physical = Array.isArray(res.physicalPrinters)
      ? res.physicalPrinters
      : Array.isArray(res.printers)
        ? res.printers.filter((p) => !p.isVirtual && p.printerCategory !== "VIRTUAL")
        : [];
    const virtualList = Array.isArray(res.virtualPrinters)
      ? res.virtualPrinters
      : Array.isArray(res.printers)
        ? res.printers.filter((p) => p.isVirtual || p.printerCategory === "VIRTUAL")
        : [];
    setLocalPrinters(physical);
    setLocalVirtualPrinters(virtualList);
  }, []);

  const refreshLocalPrinters = useCallback(
    async (showSpinner = false) => {
      if (!window.electronAPI) return;
      if (showSpinner) setDiscoveringPrinters(true);
      try {
        const res = await window.electronAPI.discoverLocalPrinters({
          includeVirtual: true
        });
        applyLocalDiscoveryResult(res);
      } catch (_e) {
        // Handled gracefully
      } finally {
        if (showSpinner) setDiscoveringPrinters(false);
      }
    },
    [applyLocalDiscoveryResult]
  );

  // Subscribe to real-time printer change notifications from Electron main process
  useEffect(() => {
    if (!window.electronAPI || typeof window.electronAPI.onPrintersUpdated !== "function") {
      return undefined;
    }
    const unsubscribe = window.electronAPI.onPrintersUpdated((res) => {
      applyLocalDiscoveryResult(res);
    });
    return unsubscribe;
  }, [applyLocalDiscoveryResult]);

  // 3. Refresh local background agent status
  const refreshLocalAgentStatus = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const st = await window.electronAPI.getAgentStatus();
      if (st) setLocalAgentStatus(st);
    } catch (_e) {
      // Ignore
    }
  }, []);

  // 4. Refresh cloud dashboard, orders, and printer status
  const refreshCloudData = useCallback(
    async (silent = true) => {
      if (!session.vendorToken) return;
      if (!silent) setLoadingDashboard(true);
      try {
        const [dashRes, ordersRes] = await Promise.all([
          fetchVendorDashboard(),
          fetchVendorOrders({ status: orderStatusFilter, search: orderSearch })
        ]);

        if (dashRes?.success) {
          if (dashRes.printer) setPrinterState(dashRes.printer);
          if (dashRes.stats) setStats(dashRes.stats);
          if (dashRes.tenant) {
            const rawPub = dashRes.tenant.publicUrl || "";
            const isValidPub =
              rawPub.startsWith("https://smart-xerox-web-2mwa.onrender.com/shop/") ||
              (rawPub &&
                !rawPub.includes("smartxerox.com") &&
                !rawPub.includes("smart-xerox-web.onrender.com") &&
                !rawPub.includes("https://smart-xerox-web-2mwa/") &&
                !rawPub.includes("localhost") &&
                !rawPub.includes("127.0.0.1"));
            const cleanTenant = {
              ...dashRes.tenant,
              publicUrl: isValidPub
                ? rawPub
                : `https://smart-xerox-web-2mwa.onrender.com/shop/${dashRes.tenant.shopSlug}`
            };
            setSession((prev) => ({ ...prev, tenant: cleanTenant }));
          }
        }
        if (ordersRes?.success && Array.isArray(ordersRes.orders)) {
          setOrders(ordersRes.orders);
        }
      } catch (err) {
        if (err?.response?.status === 401) {
          toast.error("Session expired. Please sign in again.");
          if (window.electronAPI) {
            await window.electronAPI.clearSession({ keepAgentRunning: true });
          }
          setSession((prev) => ({ ...prev, vendorToken: "", admin: null }));
        } else if (!silent) {
          toast.error(getApiErrorMessage(err));
        }
      } finally {
        if (!silent) setLoadingDashboard(false);
      }
    },
    [session.vendorToken, orderStatusFilter, orderSearch]
  );

  // Sync forms when tenant loads
  useEffect(() => {
    if (!session.tenant) return;
    const t = session.tenant;
    if (t.capabilityOverrides) {
      setCapForm({
        useManualOverride: Boolean(t.capabilityOverrides.useManualOverride),
        supportedPaperSizes: t.capabilityOverrides.supportedPaperSizes || ["A4"],
        supportsColor: Boolean(t.capabilityOverrides.supportsColor),
        supportsDuplex: Boolean(t.capabilityOverrides.supportsDuplex)
      });
    }
    setSettingsForm({
      shopName: t.shopName || "",
      phone: t.phone || "",
      address: t.address || "",
      logoUrl: t.logoUrl || "",
      maxCopies: t.config?.maxCopies || 100,
      maxUploadMb: t.config?.maxUploadMb || 20,
      acceptingOrders: t.config?.acceptingOrders !== false,
      apiBaseUrl: session.apiBaseUrl || "https://smart-xerox-api.onrender.com/api",
      customerBaseUrl: session.customerBaseUrl || "https://smart-xerox-web-2mwa.onrender.com",
      autoStartWithWindows: session.autoStartWithWindows !== false
    });
  }, [
    session.tenant?.id,
    session.tenant?.shopName,
    session.apiBaseUrl,
    session.customerBaseUrl,
    session.autoStartWithWindows
  ]);

  // Periodic polling while logged in
  useEffect(() => {
    if (!session.vendorToken) return;
    refreshCloudData(false);
    refreshLocalPrinters(true);
    refreshLocalAgentStatus();

    const cloudTimer = setInterval(() => {
      refreshCloudData(true);
      refreshLocalAgentStatus();
    }, 4000);

    const printerTimer = setInterval(() => {
      refreshLocalPrinters(false);
    }, 6000);

    return () => {
      clearInterval(cloudTimer);
      clearInterval(printerTimer);
    };
  }, [
    session.vendorToken,
    refreshCloudData,
    refreshLocalPrinters,
    refreshLocalAgentStatus
  ]);

  // Compute permanent Shop QR URL (never uses localhost or local IP address)
  const resolvedShopUrl = React.useMemo(() => {
    const slug = session.tenant?.shopSlug;
    if (!slug) return "";
    const customBase = (session.customerBaseUrl || "").trim().replace(/\/+$/, "");
    const isCustomPublic =
      customBase &&
      customBase.includes(".") &&
      !customBase.includes("localhost") &&
      !customBase.includes("127.0.0.1") &&
      !customBase.includes("smartxerox.com") &&
      !customBase.includes("smart-xerox-web.onrender.com") &&
      !/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(customBase);

    if (isCustomPublic) {
      return `${customBase}/shop/${slug}`;
    }
    const tenantPublic = session.tenant?.publicUrl || "";
    if (
      tenantPublic &&
      tenantPublic.includes(".onrender.com") &&
      !tenantPublic.includes("localhost") &&
      !tenantPublic.includes("127.0.0.1") &&
      !tenantPublic.includes("smartxerox.com") &&
      !tenantPublic.includes("smart-xerox-web.onrender.com")
    ) {
      return tenantPublic;
    }
    return `https://smart-xerox-web-2mwa.onrender.com/shop/${slug}`;
  }, [session.tenant, session.customerBaseUrl]);

  // Generate QR code image whenever resolvedShopUrl changes
  useEffect(() => {
    if (!resolvedShopUrl) {
      setQrDataUrl("");
      return;
    }
    QRCode.toDataURL(resolvedShopUrl, {
      width: 480,
      margin: 2,
      color: {
        dark: "#18181B",
        light: "#FFFFFF"
      }
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => {});
  }, [resolvedShopUrl]);

  // Automatic single-printer selection if only 1 compatible physical printer is detected
  useEffect(() => {
    if (
      session.vendorToken &&
      session.tenant &&
      !session.tenant.selectedPrinterName &&
      localPrinters.length === 1
    ) {
      const singlePrinterName = localPrinters[0].name;
      selectVendorPrinter(singlePrinterName, true)
        .then((res) => {
          if (res?.tenant) {
            setSession((prev) => ({ ...prev, tenant: res.tenant }));
          }
          if (window.electronAPI) {
            window.electronAPI.setSelectedPrinterLocal(singlePrinterName);
          }
        })
        .catch(() => {});
    }
  }, [session.vendorToken, session.tenant, localPrinters]);

  /* ==========================================================================
     HANDLERS
     ========================================================================== */

  const handleVendorLogin = async (e) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword || loggingIn) return;

    try {
      setLoggingIn(true);
      const cleanApiUrl = loginApiUrl.trim().replace(/\/+$/, "");
      const res = await vendorLogin(loginEmail.trim(), loginPassword, cleanApiUrl);

      if (!res?.success || !res.token) {
        throw new Error("Login failed");
      }

      if (!res.tenant) {
        toast.error(
          "This account is not linked to a Xerox shop tenant. Please sign in with a Vendor Shop account."
        );
        return;
      }

      configureDesktopApi({
        apiBaseUrl: cleanApiUrl,
        vendorToken: res.token
      });

      // Automatically pair this desktop installation with the signed-in vendor's tenant
      let pairedAgentId = session.agentId;
      let pairedAgentSecret = undefined;

      const pairRes = await pairDesktopAgent({
        deviceId: session.deviceId || `win-pc-${Date.now()}`,
        name: `${res.tenant.shopName} Desktop Host`,
        hostname: session.hostname,
        osVersion: session.osVersion,
        agentVersion: "3.0.0"
      });

      if (pairRes?.success && pairRes.credentials) {
        pairedAgentId = pairRes.credentials.agentId;
        pairedAgentSecret = pairRes.credentials.agentSecret;
      }

      const sanitizedTenant = {
        ...res.tenant,
        publicUrl: `https://smart-xerox-web-2mwa.onrender.com/shop/${res.tenant.shopSlug}`
      };

      if (window.electronAPI) {
        await window.electronAPI.saveSession({
          apiBaseUrl: cleanApiUrl,
          vendorToken: res.token,
          admin: res.admin,
          tenant: sanitizedTenant,
          agentId: pairedAgentId,
          agentSecret: pairedAgentSecret
        });
      }

      setSession((prev) => ({
        ...prev,
        apiBaseUrl: cleanApiUrl,
        vendorToken: res.token,
        admin: res.admin,
        tenant: sanitizedTenant,
        agentId: pairedAgentId,
        hasAgentCredentials: true
      }));
      setLoginPassword("");
      setActiveTab("dashboard");
      toast.success(`Welcome to ${res.tenant.shopName}! Desktop agent paired and running.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Invalid vendor credentials"));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleSelectPrinter = async (printerName) => {
    try {
      const res = await selectVendorPrinter(printerName, true);
      if (res?.success) {
        if (window.electronAPI) {
          await window.electronAPI.setSelectedPrinterLocal(printerName);
        }
        setSession((prev) => ({
          ...prev,
          tenant: res.tenant || { ...prev.tenant, selectedPrinterName: printerName }
        }));
        if (res.printer) setPrinterState(res.printer);
        toast.success(`Preferred printer set to ${printerName}`);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Failed to select printer"));
    }
  };

  const handleSaveCapabilities = async (e) => {
    e.preventDefault();
    if (savingCaps) return;
    try {
      setSavingCaps(true);
      const res = await updatePrinterCapabilities(capForm);
      if (res?.success) {
        setSession((prev) => ({ ...prev, tenant: res.tenant }));
        if (res.printer) setPrinterState(res.printer);
        toast.success("Printer capability configuration saved.");
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not update capabilities"));
    } finally {
      setSavingCaps(false);
    }
  };

  const handleDownloadQrPng = () => {
    if (!qrDataUrl || !session.tenant) return;
    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `${session.tenant.shopSlug}-smart-xerox-qr.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Downloaded Shop QR Code PNG");
  };

  const handlePrintQrPoster = () => {
    if (!qrDataUrl || !session.tenant) return;
    const win = window.open("", "_blank", "width=720,height=900");
    if (!win) return;
    win.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>${session.tenant.shopName} — Smart Xerox QR Code</title>
          <style>
            body { font-family: Segoe UI, Arial, sans-serif; text-align: center; padding: 48px; color: #18181B; }
            .card { border: 3px solid #8D0100; border-radius: 24px; padding: 40px; max-width: 480px; margin: 0 auto; }
            .brand { color: #8D0100; font-weight: 800; letter-spacing: 2px; font-size: 16px; text-transform: uppercase; }
            h1 { font-size: 32px; margin: 12px 0 8px; }
            p { color: #52525B; font-size: 16px; margin-bottom: 24px; }
            img { width: 320px; height: 320px; border: 1px solid #E4E4E7; border-radius: 16px; padding: 12px; }
            .url { font-family: monospace; font-size: 14px; color: #27272A; margin-top: 20px; word-break: break-all; background: #F4F4F5; padding: 10px 14px; border-radius: 10px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="brand">SMART XEROX INSTANT PRINT</div>
            <h1>${session.tenant.shopName}</h1>
            <p>Scan this QR code with your phone camera to upload & print PDF or Image documents</p>
            <img src="${qrDataUrl}" alt="Shop QR Code" />
            <div class="url">${resolvedShopUrl}</div>
          </div>
          <script>window.onload = () => { window.print(); };</script>
        </body>
      </html>
    `);
    win.document.close();
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (savingSettings) return;
    try {
      setSavingSettings(true);
      const res = await updateVendorSettings({
        shopName: settingsForm.shopName,
        phone: settingsForm.phone,
        address: settingsForm.address,
        logoUrl: settingsForm.logoUrl,
        maxCopies: Number(settingsForm.maxCopies) || 100,
        maxUploadMb: Number(settingsForm.maxUploadMb) || 20,
        acceptingOrders: settingsForm.acceptingOrders
      });

      if (window.electronAPI) {
        await window.electronAPI.updateLocalSettings({
          apiBaseUrl: settingsForm.apiBaseUrl,
          customerBaseUrl: settingsForm.customerBaseUrl,
          autoStartWithWindows: settingsForm.autoStartWithWindows,
          tenant: res?.tenant || session.tenant
        });
      }

      configureDesktopApi({
        apiBaseUrl: settingsForm.apiBaseUrl,
        vendorToken: session.vendorToken
      });

      setSession((prev) => ({
        ...prev,
        tenant: res?.tenant || prev.tenant,
        apiBaseUrl: settingsForm.apiBaseUrl,
        customerBaseUrl: settingsForm.customerBaseUrl,
        autoStartWithWindows: settingsForm.autoStartWithWindows
      }));
      toast.success("Shop & desktop settings saved.");
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Failed to save settings"));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleToggleTheme = async () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    if (window.electronAPI) {
      await window.electronAPI.updateLocalSettings({ theme: nextTheme });
    }
  };

  const handleLogout = async (unpairAgent = false) => {
    try {
      if (unpairAgent && session.agentId) {
        await revokeDesktopAgent(session.agentId).catch(() => {});
      }
      if (window.electronAPI) {
        await window.electronAPI.clearSession({ keepAgentRunning: !unpairAgent });
      }
      configureDesktopApi({ vendorToken: "" });
      setSession((prev) => ({
        ...prev,
        vendorToken: "",
        admin: null,
        ...(unpairAgent ? { tenant: null, agentId: null, hasAgentCredentials: false } : {})
      }));
      setShowLogoutModal(false);
      toast.success(
        unpairAgent
          ? "Signed out and unpaired desktop print agent."
          : "Signed out (background agent remains active for printing)."
      );
    } catch (_err) {
      setShowLogoutModal(false);
    }
  };

  const handleCancelOrder = async (order) => {
    try {
      const res = await cancelVendorOrder(order.token);
      if (res?.success) {
        toast.success(`Cancelled ${order.originalName}`);
        refreshCloudData(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job"));
    }
  };

  const handleConfirmReprint = async () => {
    if (!confirmReprintJob) return;
    const job = confirmReprintJob;
    setConfirmReprintJob(null);
    try {
      const res = await reprintVendorOrder(job.token);
      if (res?.success) {
        toast.success(`Reprint queued for ${job.originalName}`);
        refreshCloudData(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not reprint job"));
    }
  };

  const handleClearFailedOrders = async () => {
    try {
      const res = await clearFailedVendorOrders();
      if (res?.success) {
        toast.success(res.message || "Cleared failed jobs");
        refreshCloudData(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not clear failed jobs"));
    }
  };

  const handleOpenGridFsFile = async (order) => {
    try {
      const blob = await downloadVendorOrderBlob(order._id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err.message || "Could not open document file");
    }
  };

  const handleRunDiagnostics = async () => {
    if (!window.electronAPI || runningDiag) return;
    setRunningDiag(true);
    try {
      const res = await window.electronAPI.runAgentDiagnostics();
      setDiagOutput(res?.output || res?.error || JSON.stringify(res, null, 2));
      toast.success("Diagnostics completed");
    } catch (err) {
      toast.error("Diagnostics failed: " + err.message);
    } finally {
      setRunningDiag(false);
    }
  };

  if (initializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 text-zinc-700 text-sm font-medium">
        Loading Smart Xerox Desktop Console...
      </div>
    );
  }

  /* ==========================================================================
     SECTION 1: VENDOR LOGIN VIEW
     ========================================================================== */
  if (!session.vendorToken) {
    return (
      <div className="min-h-screen bg-[#F7F6F3] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-[#8D0100] text-white flex items-center justify-center shadow-xs">
              <Printer className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-zinc-900 tracking-tight">
                SMART XEROX
              </h1>
              <p className="text-xs font-medium text-zinc-500">
                Windows Vendor Desktop Console & Print Agent
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-50 border border-zinc-200/80 text-xs text-zinc-600 leading-relaxed">
            Sign in with your Xerox Shop vendor account to pair this Windows computer, automatically detect connected printers, and receive customer print jobs.
          </div>

          <form onSubmit={handleVendorLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1.5">
                Vendor Email Address
              </label>
              <input
                type="email"
                required
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="shopkeeper@smartxerox.com"
                className="w-full h-11 px-3.5 rounded-xl border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full h-11 px-3.5 rounded-xl border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowServerConfig((v) => !v)}
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-800 inline-flex items-center gap-1.5"
              >
                <Server className="w-3.5 h-3.5" />
                <span>{showServerConfig ? "Hide Cloud Server URL" : "Cloud Server Connection"}</span>
              </button>

              {showServerConfig && (
                <div className="mt-2">
                  <input
                    type="url"
                    required
                    value={loginApiUrl}
                    onChange={(e) => setLoginApiUrl(e.target.value)}
                    placeholder="https://smart-xerox-api.onrender.com/api"
                    className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-xs font-mono-code focus:border-[#8D0100] focus:outline-none"
                  />
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loggingIn}
              className="w-full h-11 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-sm font-semibold transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Lock className="w-4 h-4" />
              <span>{loggingIn ? "Signing In & Pairing Agent..." : "Sign In & Connect Printer"}</span>
            </button>
          </form>

          <div className="pt-2 border-t border-zinc-100 flex items-center justify-between text-[11px] text-zinc-400">
            <span>Host: {session.hostname}</span>
            <span>Smart Xerox Desktop v3.0</span>
          </div>
        </div>
        <Toaster position="top-right" />
      </div>
    );
  }

  // Merge local hardware discovery with cloud printer state
  const basePhysicalPrinters =
    localPrinters.length > 0
      ? localPrinters
      : (printerState?.availablePrinters || []).filter(
          (p) => !p.isVirtual && p.printerCategory !== "VIRTUAL"
        );

  const selectedPrinterPref =
    session.tenant?.selectedPrinterName || printerState?.selectedPrinterName || null;

  // If the vendor had selected a printer that is currently disconnected/unplugged from Windows,
  // keep it in the list as OFFLINE (Disconnected) so the vendor sees its status and never loses their selection.
  const selectedExistsInList = selectedPrinterPref
    ? basePhysicalPrinters.some(
        (p) => p.name.toLowerCase() === String(selectedPrinterPref).toLowerCase()
      )
    : false;

  const mergedPhysicalPrinters =
    selectedPrinterPref && !selectedExistsInList
      ? [
          {
            name: selectedPrinterPref,
            printerName: selectedPrinterPref,
            manufacturer: printerState?.manufacturer || null,
            model: printerState?.model || selectedPrinterPref,
            portName: printerState?.portName || null,
            driverName: printerState?.driverName || null,
            connectionType: printerState?.connectionType || "USB",
            printerCategory: "PHYSICAL",
            isVirtual: false,
            isDefault: false,
            isDisconnected: true,
            driverMissing: false,
            printerAvailable: false,
            status: "OFFLINE",
            statusMessage: `${selectedPrinterPref} is disconnected or turned off. Reconnect via USB or network to resume printing.`,
            spoolerJobCount: 0,
            capabilities: printerState?.detectedCapabilities ||
              printerState?.capabilities || {
                supportedPaperSizes: ["A4"],
                supportsColor: false,
                supportsDuplex: false
              }
          },
          ...basePhysicalPrinters
        ]
      : basePhysicalPrinters;

  const mergedPrinters = showVirtualPrinters
    ? [...mergedPhysicalPrinters, ...localVirtualPrinters]
    : mergedPhysicalPrinters;

  const requiresManualPrinterSelection =
    !selectedPrinterPref && basePhysicalPrinters.length > 1;

  const activePrinterName =
    selectedPrinterPref ||
    (basePhysicalPrinters.length === 1
      ? basePhysicalPrinters[0].name
      : requiresManualPrinterSelection
        ? "Multiple Printers Detected — Select One"
        : "No Printer Detected");

  const activeLocalPrinterObj =
    mergedPhysicalPrinters.find(
      (p) => p.name.toLowerCase() === String(activePrinterName).toLowerCase()
    ) ||
    (basePhysicalPrinters.length === 1 ? basePhysicalPrinters[0] : null);

  const isPrinterOnline = Boolean(
    !requiresManualPrinterSelection &&
      (activeLocalPrinterObj
        ? activeLocalPrinterObj.printerAvailable
        : printerState?.printerAvailable)
  );
  const isAgentOnline = Boolean(localAgentStatus.running || printerState?.agentOnline);

  return (
    <div
      className={`min-h-screen flex ${
        isDark ? "bg-zinc-950 text-zinc-100" : "bg-[#F7F6F3] text-zinc-900"
      }`}
    >
      {/* LEFT SIDEBAR NAVIGATION */}
      <aside
        className={`w-64 shrink-0 border-r flex flex-col justify-between ${
          isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
        }`}
      >
        <div>
          {/* Brand Header */}
          <div
            className={`p-5 border-b flex items-center gap-3 ${
              isDark ? "border-zinc-800" : "border-zinc-100"
            }`}
          >
            <div className="w-10 h-10 rounded-xl bg-[#8D0100] text-white flex items-center justify-center shrink-0">
              <Printer className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <span className="block text-sm font-bold tracking-wider uppercase truncate">
                SMART XEROX
              </span>
              <span className="block text-xs text-zinc-500 truncate mt-0.5">
                {session.tenant?.shopName || "Vendor Console"}
              </span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition ${
                    active
                      ? "bg-[#8D0100] text-white shadow-2xs"
                      : isDark
                        ? "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </span>
                  {item.id === "jobs" && stats.pendingJobs > 0 && (
                    <span
                      className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                        active ? "bg-white text-[#8D0100]" : "bg-[#8D0100] text-white"
                      }`}
                    >
                      {stats.pendingJobs}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Status & Logout */}
        <div
          className={`p-3 border-t space-y-2 ${
            isDark ? "border-zinc-800" : "border-zinc-100"
          }`}
        >
          <div
            className={`p-3 rounded-xl border text-xs space-y-1.5 ${
              isDark
                ? "bg-zinc-950 border-zinc-800"
                : "bg-zinc-50 border-zinc-200/70"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Agent</span>
              <span
                className={`inline-flex items-center gap-1 font-semibold ${
                  isAgentOnline ? "text-emerald-600" : "text-amber-600"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    isAgentOnline ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                  }`}
                />
                {isAgentOnline ? "Connected" : "Starting"}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Printer</span>
              <span
                className={`font-semibold truncate max-w-[120px] ${
                  isPrinterOnline ? "text-emerald-600" : "text-amber-600"
                }`}
              >
                {isPrinterOnline ? "Ready" : "Offline"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleToggleTheme}
              title="Toggle Light / Dark Theme"
              className={`p-2.5 rounded-xl border text-xs font-semibold transition ${
                isDark
                  ? "border-zinc-800 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => setShowLogoutModal(true)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-xs font-semibold transition ${
                isDark
                  ? "border-zinc-800 text-red-400 hover:bg-red-950/40"
                  : "border-zinc-200 text-red-700 hover:bg-red-50"
              }`}
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header
          className={`h-16 px-6 border-b flex items-center justify-between gap-4 shrink-0 ${
            isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-base font-bold truncate">
              {NAV_ITEMS.find((n) => n.id === activeTab)?.label || "Dashboard"}
            </h2>
            <span
              className={`px-2.5 py-0.5 rounded-md text-[11px] font-semibold border ${
                session.tenant?.status === "ACTIVE"
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : "bg-red-50 text-red-700 border-red-200"
              }`}
            >
              Shop {session.tenant?.status || "ACTIVE"}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <div
              className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                isPrinterOnline
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-amber-50 border-amber-200 text-amber-800"
              }`}
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="truncate max-w-[220px]">{activePrinterName}</span>
              <span>• {isPrinterOnline ? "Online" : "Offline"}</span>
            </div>

            <button
              type="button"
              onClick={() => {
                refreshCloudData(false);
                refreshLocalPrinters(true);
                refreshLocalAgentStatus();
              }}
              className={`px-3 py-1.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 transition ${
                isDark
                  ? "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  loadingDashboard || discoveringPrinters ? "animate-spin" : ""
                }`}
              />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        {/* Scrollable Body */}
        <main className="flex-1 p-6 overflow-y-auto space-y-6">
          {/* ================================================================
              SECTION 2: DASHBOARD
              ================================================================ */}
          {activeTab === "dashboard" && (
            <div className="space-y-6">
              {requiresManualPrinterSelection && (
                <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-bold">
                        Multiple Windows Printers Detected ({basePhysicalPrinters.length}) — Select Your Active Shop Printer
                      </h4>
                      <p className="text-xs text-amber-800 mt-0.5">
                        Smart Xerox detected {basePhysicalPrinters.map((p) => p.name).join(", ")}. Choose which printer to use for incoming customer jobs.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab("printers")}
                    className="px-4 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold shrink-0"
                  >
                    Select Shop Printer →
                  </button>
                </div>
              )}

              {/* Top Status Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  className={`rounded-2xl border p-5 ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Shop Status
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                      {session.tenant?.status || "ACTIVE"}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold mt-2 truncate">
                    {session.tenant?.shopName}
                  </h3>
                  <p className="text-xs text-zinc-500 font-mono-code mt-1 truncate">
                    /shop/{session.tenant?.shopSlug}
                  </p>
                </div>

                <div
                  className={`rounded-2xl border p-5 ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Selected Printer
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                        isPrinterOnline
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-amber-50 text-amber-800 border-amber-200"
                      }`}
                    >
                      {isPrinterOnline ? "Online & Ready" : "Offline"}
                    </span>
                  </div>
                  <h3 className="text-base font-bold mt-2 truncate">
                    {activePrinterName}
                  </h3>
                  <p className="text-xs text-zinc-500 mt-1 truncate">
                    {activeLocalPrinterObj?.statusMessage ||
                      printerState?.statusMessage ||
                      "Connect USB or network printer"}
                  </p>
                </div>

                <div
                  className={`rounded-2xl border p-5 ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Print Agent Status
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                        isAgentOnline
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-amber-50 text-amber-800 border-amber-200"
                      }`}
                    >
                      {isAgentOnline ? "Connected" : "Reconnecting"}
                    </span>
                  </div>
                  <h3 className="text-base font-bold mt-2 truncate">
                    {localAgentStatus.running
                      ? `Background Agent (PID ${localAgentStatus.pid})`
                      : "Cloud Print Agent"}
                  </h3>
                  <p className="text-xs text-zinc-500 font-mono-code mt-1 truncate">
                    ID: {session.agentId || printerState?.agentId || "Paired"}
                  </p>
                </div>
              </div>

              {/* Job Counters */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  {
                    label: "Today's Print Jobs",
                    value: stats.todaysJobs,
                    color: "text-zinc-900"
                  },
                  {
                    label: "Pending / Active Jobs",
                    value: stats.pendingJobs,
                    color: "text-amber-600"
                  },
                  {
                    label: "Completed Jobs",
                    value: stats.completedJobs,
                    color: "text-emerald-600"
                  },
                  {
                    label: "Failed Jobs",
                    value: stats.failedJobs,
                    color: "text-red-600"
                  }
                ].map((metric) => (
                  <div
                    key={metric.label}
                    className={`rounded-2xl border p-5 ${
                      isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                    }`}
                  >
                    <span className="text-xs font-semibold text-zinc-500 block">
                      {metric.label}
                    </span>
                    <span
                      className={`text-2xl font-bold font-mono-code mt-1.5 block ${
                        isDark ? "text-zinc-100" : metric.color
                      }`}
                    >
                      {metric.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* QR Code Card + Recent Jobs Preview */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div
                  className={`rounded-2xl border p-5 flex flex-col items-center text-center space-y-3 ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    Your Shop QR Code
                  </span>
                  {qrDataUrl && (
                    <img
                      src={qrDataUrl}
                      alt="Shop QR Code"
                      className="w-44 h-44 rounded-xl border border-zinc-200 p-2 bg-white"
                    />
                  )}
                  <p className="text-xs font-mono-code text-zinc-500 break-all px-2">
                    {resolvedShopUrl}
                  </p>
                  <div className="flex items-center gap-2 w-full pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(resolvedShopUrl);
                        toast.success("Copied Shop URL");
                      }}
                      className="flex-1 py-2 px-3 rounded-xl border border-zinc-200 text-xs font-semibold hover:bg-zinc-50 text-zinc-700 bg-white inline-flex items-center justify-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy URL</span>
                    </button>
                    <button
                      type="button"
                      onClick={handlePrintQrPoster}
                      className="flex-1 py-2 px-3 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Print QR</span>
                    </button>
                  </div>
                </div>

                {/* Recent Incoming Jobs */}
                <div
                  className={`lg:col-span-2 rounded-2xl border p-5 flex flex-col justify-between ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between pb-3 border-b border-zinc-100">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                        Recent Incoming Print Jobs
                      </h3>
                      <button
                        type="button"
                        onClick={() => setActiveTab("jobs")}
                        className="text-xs font-semibold text-[#8D0100] hover:underline"
                      >
                        View All Jobs →
                      </button>
                    </div>

                    {orders.length === 0 ? (
                      <div className="py-12 text-center text-xs text-zinc-500">
                        No print jobs yet. Display your Shop QR code for customers to scan and print.
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-100 mt-1">
                        {orders.slice(0, 5).map((job) => (
                          <div
                            key={job._id}
                            className="py-3 flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-semibold truncate">
                                {job.originalName}
                              </p>
                              <p className="text-xs text-zinc-500 font-mono-code mt-0.5">
                                {job.token} • {job.copies}x • {job.paperSize} •{" "}
                                {job.colorMode === "color" ? "Colour" : "B&W"} •{" "}
                                {job.printablePageCount} page(s)
                              </p>
                            </div>
                            <span
                              className={`px-2.5 py-0.5 rounded-md text-[11px] font-semibold border shrink-0 ${
                                STATUS_BADGES[job.status] || STATUS_BADGES.QUEUED
                              }`}
                            >
                              {job.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 3: PRINTER MANAGEMENT
              ================================================================ */}
          {activeTab === "printers" && (
            <div className="space-y-6">
              {requiresManualPrinterSelection && (
                <div className="rounded-2xl border-2 border-[#8D0100] bg-[#8D0100]/5 p-5 space-y-2">
                  <div className="flex items-center gap-2 text-[#8D0100]">
                    <Printer className="w-5 h-5" />
                    <h4 className="text-sm font-bold">
                      Multiple Physical Printers Detected — Choose Your Active Smart Xerox Printer
                    </h4>
                  </div>
                  <p className="text-xs text-zinc-600">
                    We detected {basePhysicalPrinters.length} physical printers connected to this Windows computer. Click <strong>Set as Default for Smart Xerox</strong> on the printer you want to use for customer print jobs. Your choice will be remembered automatically across restarts.
                  </p>
                </div>
              )}

              <div
                className={`rounded-2xl border p-5 ${
                  isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-zinc-100">
                  <div>
                    <h3 className="text-base font-bold">
                      Universal Windows Printer Discovery ({mergedPhysicalPrinters.length} Physical
                      {showVirtualPrinters ? ` • ${localVirtualPrinters.length} Virtual` : ""})
                    </h3>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Automatically discovers USB, Wi-Fi, Network, Shared, and Local printers across all brands (HP, Canon, Epson, Brother, Samsung, Xerox, Ricoh, Kyocera, Pantum, Lexmark, and more) via Windows Print Spooler.
                    </p>
                  </div>

                  <div className="flex items-center gap-2.5 flex-wrap">
                    <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-zinc-200 text-xs font-semibold cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showVirtualPrinters}
                        onChange={(e) => setShowVirtualPrinters(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#8D0100]"
                      />
                      <span>Show Virtual Printers ({localVirtualPrinters.length})</span>
                    </label>

                    <button
                      type="button"
                      onClick={() => refreshLocalPrinters(true)}
                      disabled={discoveringPrinters}
                      className="px-3.5 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${discoveringPrinters ? "animate-spin" : ""}`}
                      />
                      <span>Refresh Printers</span>
                    </button>
                  </div>
                </div>

                {mergedPrinters.length === 0 ? (
                  <div className="py-10 text-center space-y-3">
                    <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
                    <p className="text-sm font-bold">
                      No Physical Windows Printers Detected
                    </p>
                    <p className="text-xs text-zinc-500 max-w-lg mx-auto leading-relaxed">
                      Connect your printer via USB cable, Wi-Fi, or Ethernet network and ensure the manufacturer&apos;s official Windows printer driver (HP, Canon, Epson, Brother, Xerox, Ricoh, Kyocera, etc.) is installed in Windows Settings → Bluetooth &amp; devices → Printers &amp; scanners. Smart Xerox will detect it automatically without restarting.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    {mergedPrinters.map((p) => {
                      const isVirtual = Boolean(
                        p.isVirtual || p.printerCategory === "VIRTUAL"
                      );
                      const isSelected =
                        !isVirtual &&
                        p.name.toLowerCase() === String(activePrinterName).toLowerCase();
                      const isExpanded = expandedPrinterName === p.name;
                      const caps = p.capabilities || {};
                      const brandLabel = p.manufacturer || "Windows Compatible";
                      const modelLabel = p.model || p.name;
                      const categoryLabel =
                        p.printerCategory === "VIRTUAL"
                          ? "Virtual Software Printer"
                          : p.printerCategory === "UNKNOWN"
                            ? "Unknown Classification"
                            : "Physical Printer";

                      const statusText = p.driverMissing
                        ? "Driver Error"
                        : p.status === "ERROR"
                          ? "Hardware Error"
                          : p.status === "PRINTING"
                            ? "Printing"
                            : p.printerAvailable
                              ? "Ready"
                              : "Offline";

                      return (
                        <div
                          key={p.name}
                          className={`rounded-2xl border p-4 space-y-3 transition ${
                            isSelected
                              ? "border-[#8D0100] ring-1 ring-[#8D0100] bg-[#8D0100]/5"
                              : isVirtual
                                ? "border-zinc-200 bg-zinc-100/70 opacity-80"
                                : isDark
                                  ? "border-zinc-800 bg-zinc-950"
                                  : "border-zinc-200 bg-zinc-50/60"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-10 h-10 rounded-xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center shrink-0">
                                {["NETWORK", "WIFI", "SHARED"].includes(p.connectionType) ? (
                                  <Wifi className="w-5 h-5" />
                                ) : (
                                  <Usb className="w-5 h-5" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-[#8D0100]/10 text-[#8D0100]">
                                    {brandLabel}
                                  </span>
                                  <h4 className="text-sm font-bold truncate" title={p.name}>
                                    {p.name}
                                  </h4>
                                  {p.isDefault && (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-zinc-200 text-zinc-800">
                                      Windows Default
                                    </span>
                                  )}
                                  {isSelected && (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#8D0100] text-white">
                                      Smart Xerox Default
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-zinc-500 font-mono-code mt-0.5 truncate">
                                  Model: {modelLabel} • {p.connectionType || "USB"} • Port:{" "}
                                  {p.portName || "N/A"}
                                </p>
                              </div>
                            </div>

                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <span
                                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                                  p.printerAvailable && !isVirtual
                                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                    : p.status === "ERROR" || p.driverMissing
                                      ? "bg-red-50 text-red-700 border-red-200"
                                      : "bg-amber-50 text-amber-800 border-amber-200"
                                }`}
                              >
                                {p.printerAvailable ? "Online" : "Offline"} • {statusText}
                              </span>
                              <span className="text-[10px] font-semibold text-zinc-400">
                                {categoryLabel}
                              </span>
                            </div>
                          </div>

                          {p.driverMissing && (
                            <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>
                                Windows printer driver is missing for <strong>{p.name}</strong>. Please install the official <strong>{brandLabel}</strong> Windows driver so Windows Print Spooler can communicate with the device.
                              </span>
                            </div>
                          )}

                          {!p.printerAvailable && !p.driverMissing && !isVirtual && (
                            <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>
                                {p.statusMessage ||
                                  `${p.name} is currently offline or disconnected. Check power and USB/network cable. Smart Xerox will automatically mark it Ready when reconnected.`}
                              </span>
                            </div>
                          )}

                          <div className="text-xs text-zinc-500 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate">
                                Driver: <strong className="text-zinc-700">{p.driverName || "Missing Windows driver"}</strong>
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                              <span className="px-2 py-0.5 rounded-md bg-white border border-zinc-200 text-[11px] font-semibold text-zinc-700">
                                {caps.supportsColor
                                  ? "Colour & B&W"
                                  : caps.colorSupportKnown === false
                                    ? "B&W (Colour Unknown)"
                                    : "B&W Only"}
                              </span>
                              <span className="px-2 py-0.5 rounded-md bg-white border border-zinc-200 text-[11px] font-semibold text-zinc-700">
                                {caps.supportsDuplex
                                  ? "Auto Duplex & Single-Sided"
                                  : caps.duplexSupportKnown === false
                                    ? "Single-Sided (Duplex Unknown)"
                                    : "Single-Sided Only"}
                              </span>
                              <span className="px-2 py-0.5 rounded-md bg-white border border-zinc-200 text-[11px] font-mono-code font-semibold text-zinc-700">
                                Sizes: {(caps.supportedPaperSizes || ["A4"]).join(", ")}
                                {caps.paperSizesKnown === false ? " (Fallback)" : ""}
                              </span>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="p-3 rounded-xl bg-white border border-zinc-200 text-xs text-zinc-700 space-y-1.5 font-mono-code">
                              <div>Brand / Manufacturer : {brandLabel}</div>
                              <div>Model                : {modelLabel}</div>
                              <div>Windows Printer Name : {p.name}</div>
                              <div>Windows Driver       : {p.driverName || "N/A"}</div>
                              <div>Port / Connection    : {p.portName || "N/A"} ({p.connectionType || "UNKNOWN"})</div>
                              <div>Classification       : {categoryLabel}</div>
                              <div>Status Detail        : {p.statusMessage || statusText}</div>
                              <div>Orientations         : {(caps.supportedOrientations || ["portrait", "landscape"]).join(", ")}</div>
                              <div>Hardware Max Copies  : {caps.maxCopies || 99}</div>
                            </div>
                          )}

                          <div className="pt-1 flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-zinc-500">
                                Queue: {p.spoolerJobCount || 0} job(s)
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPrinterName(isExpanded ? null : p.name)
                                }
                                className="text-[11px] font-semibold text-[#8D0100] hover:underline"
                              >
                                {isExpanded ? "Hide Details" : "Printer Details"}
                              </button>
                            </div>

                            {isVirtual ? (
                              <span className="px-2.5 py-1 rounded-lg bg-zinc-200 text-zinc-600 text-[11px] font-semibold">
                                Virtual Printer (Disabled for Shop Jobs)
                              </span>
                            ) : isSelected ? (
                              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#8D0100] text-white text-xs font-semibold">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>Active Smart Xerox Printer</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSelectPrinter(p.name)}
                                className="px-3 py-1.5 rounded-xl border border-[#8D0100] bg-white hover:bg-[#8D0100] hover:text-white text-[#8D0100] text-xs font-semibold transition"
                              >
                                Set as Default for Smart Xerox
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Printer Capability Configuration / Manual Override */}
              <div
                className={`rounded-2xl border p-5 space-y-4 ${
                  isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                }`}
              >
                <div>
                  <h3 className="text-base font-bold">
                    Printer Capabilities & Customer Options
                  </h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    By default, Smart Xerox exposes only the hardware capabilities reported by your Windows printer driver. If your driver does not report capabilities accurately, enable manual configuration below.
                  </p>
                </div>

                <form onSubmit={handleSaveCapabilities} className="space-y-4">
                  <label className="flex items-center gap-2.5 text-sm font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={capForm.useManualOverride}
                      onChange={(e) =>
                        setCapForm((prev) => ({
                          ...prev,
                          useManualOverride: e.target.checked
                        }))
                      }
                      className="w-4 h-4 accent-[#8D0100]"
                    />
                    <span>Configure printer capabilities manually</span>
                  </label>

                  {capForm.useManualOverride && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-xl bg-zinc-50 border border-zinc-200 text-zinc-900">
                      <div>
                        <span className="block text-xs font-bold uppercase text-zinc-500 mb-2">
                          Supported Paper Sizes
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {ALL_PAPER_SIZES.map((sz) => {
                            const checked = capForm.supportedPaperSizes.includes(sz);
                            return (
                              <button
                                key={sz}
                                type="button"
                                onClick={() => {
                                  const next = checked
                                    ? capForm.supportedPaperSizes.filter((s) => s !== sz)
                                    : [...capForm.supportedPaperSizes, sz];
                                  if (next.length > 0) {
                                    setCapForm({ ...capForm, supportedPaperSizes: next });
                                  }
                                }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-mono-code font-semibold border ${
                                  checked
                                    ? "bg-[#8D0100] text-white border-[#8D0100]"
                                    : "bg-white text-zinc-700 border-zinc-300"
                                }`}
                              >
                                {sz}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <span className="block text-xs font-bold uppercase text-zinc-500 mb-2">
                          Colour Support
                        </span>
                        <label className="flex items-center gap-2 text-xs font-semibold">
                          <input
                            type="checkbox"
                            checked={capForm.supportsColor}
                            onChange={(e) =>
                              setCapForm({ ...capForm, supportsColor: e.target.checked })
                            }
                            className="w-4 h-4 accent-[#8D0100]"
                          />
                          <span>Printer supports Colour printing</span>
                        </label>
                      </div>

                      <div>
                        <span className="block text-xs font-bold uppercase text-zinc-500 mb-2">
                          Duplex (Double-Sided)
                        </span>
                        <label className="flex items-center gap-2 text-xs font-semibold">
                          <input
                            type="checkbox"
                            checked={capForm.supportsDuplex}
                            onChange={(e) =>
                              setCapForm({ ...capForm, supportsDuplex: e.target.checked })
                            }
                            className="w-4 h-4 accent-[#8D0100]"
                          />
                          <span>Printer supports automatic Duplex</span>
                        </label>
                      </div>
                    </div>
                  )}

                  <div>
                    <button
                      type="submit"
                      disabled={savingCaps}
                      className="px-4 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold disabled:opacity-50"
                    >
                      {savingCaps ? "Saving..." : "Save Capability Settings"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 4: UNIQUE VENDOR QR CODE
              ================================================================ */}
          {activeTab === "qrcode" && (
            <div
              className={`rounded-2xl border p-6 max-w-2xl mx-auto text-center space-y-5 ${
                isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
              }`}
            >
              <div>
                <span className="px-3 py-1 rounded-full bg-[#8D0100]/10 text-[#8D0100] text-xs font-bold uppercase tracking-wider">
                  Permanent Shop QR Code
                </span>
                <h3 className="text-xl font-bold mt-3">
                  {session.tenant?.shopName}
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Customers scan this QR code with their mobile phone camera to open your shop&apos;s dedicated printing website.
                </p>
              </div>

              {qrDataUrl && (
                <div className="inline-block p-5 rounded-2xl border-2 border-[#8D0100] bg-white shadow-xs">
                  <img
                    src={qrDataUrl}
                    alt="Vendor Shop QR Code"
                    className="w-64 h-64 mx-auto"
                  />
                </div>
              )}

              <div className="max-w-md mx-auto space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Unique Shop URL
                </label>
                <div className="p-3 rounded-xl bg-zinc-100 text-zinc-800 font-mono-code text-xs break-all border border-zinc-200">
                  {resolvedShopUrl}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleDownloadQrPng}
                  className="px-4 py-2.5 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  <span>Download QR Code (PNG)</span>
                </button>

                <button
                  type="button"
                  onClick={handlePrintQrPoster}
                  className="px-4 py-2.5 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-800 text-xs font-semibold inline-flex items-center gap-2"
                >
                  <Printer className="w-4 h-4 text-[#8D0100]" />
                  <span>Print Counter QR Standee</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(resolvedShopUrl);
                    toast.success("Copied Shop URL to clipboard");
                  }}
                  className="px-4 py-2.5 rounded-xl border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-800 text-xs font-semibold inline-flex items-center gap-2"
                >
                  <Copy className="w-4 h-4" />
                  <span>Copy Shop URL</span>
                </button>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 5: PRINT JOBS
              ================================================================ */}
          {activeTab === "jobs" && (
            <div className="space-y-4">
              <div
                className={`rounded-2xl border p-4 flex flex-wrap items-center justify-between gap-3 ${
                  isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                }`}
              >
                <div className="relative flex-1 min-w-[240px]">
                  <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={orderSearch}
                    onChange={(e) => setOrderSearch(e.target.value)}
                    placeholder="Search by file name or job token (XR-...)"
                    className="w-full h-10 pl-9 pr-3.5 rounded-xl border border-zinc-200 text-xs focus:border-[#8D0100] focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {["ALL", "QUEUED", "PRINTING", "COMPLETED", "FAILED", "CANCELLED"].map(
                    (st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setOrderStatusFilter(st)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                          orderStatusFilter === st
                            ? "bg-[#8D0100] text-white border-[#8D0100]"
                            : "bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100"
                        }`}
                      >
                        {st === "ALL" ? "All Jobs" : st}
                      </button>
                    )
                  )}

                  <button
                    type="button"
                    onClick={handleClearFailedOrders}
                    className="px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs font-semibold inline-flex items-center gap-1 hover:bg-red-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear Failed</span>
                  </button>
                </div>
              </div>

              {orders.length === 0 ? (
                <div
                  className={`rounded-2xl border p-12 text-center text-sm text-zinc-500 ${
                    isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                  }`}
                >
                  No print jobs matching the current filter.
                </div>
              ) : (
                <div className="space-y-3">
                  {orders.map((order) => {
                    const canCancel = [
                      "UPLOADING",
                      "QUEUED",
                      "DOWNLOADING",
                      "PROCESSING"
                    ].includes(order.status);
                    const canReprint =
                      !order.fileDeleted &&
                      ["COMPLETED", "FAILED", "CANCELLED"].includes(order.status);

                    return (
                      <div
                        key={order._id}
                        className={`rounded-2xl border p-4 space-y-3 ${
                          isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold truncate">
                                {order.originalName}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                                  STATUS_BADGES[order.status] || STATUS_BADGES.QUEUED
                                }`}
                              >
                                {order.status}
                              </span>
                            </div>
                            <p className="text-xs text-zinc-500 font-mono-code mt-0.5">
                              {order.token} • {formatBytes(order.fileSize)} •{" "}
                              {new Date(order.createdAt).toLocaleString()}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {!order.fileDeleted && (
                              <button
                                type="button"
                                onClick={() => handleOpenGridFsFile(order)}
                                className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 text-xs font-semibold inline-flex items-center gap-1.5"
                              >
                                <ExternalLink className="w-3.5 h-3.5 text-[#8D0100]" />
                                <span>Inspect File</span>
                              </button>
                            )}

                            {canReprint && (
                              <button
                                type="button"
                                onClick={() => setConfirmReprintJob(order)}
                                className="px-3 py-1.5 rounded-lg bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                                <span>Reprint</span>
                              </button>
                            )}

                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => handleCancelOrder(order)}
                                className="px-3 py-1.5 rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 text-xs font-semibold inline-flex items-center gap-1"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                <span>Cancel</span>
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded-xl bg-zinc-50 border border-zinc-100 text-xs text-zinc-800">
                          <div>
                            <span className="text-zinc-400 block text-[10px] uppercase">
                              Paper & Orientation
                            </span>
                            <span className="font-semibold capitalize">
                              {order.paperSize || "A4"} • {order.orientation || "portrait"}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-400 block text-[10px] uppercase">
                              Colour & Sides
                            </span>
                            <span className="font-semibold">
                              {order.colorMode === "color" ? "Colour" : "B&W"} •{" "}
                              {order.sides === "duplex" ? "Double-sided" : "Single-sided"}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-400 block text-[10px] uppercase">
                              Copies & Pages
                            </span>
                            <span className="font-semibold font-mono-code">
                              {order.copies}x ({order.printablePageCount} total pages)
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-400 block text-[10px] uppercase">
                              Target Printer
                            </span>
                            <span className="font-semibold truncate block">
                              {order.targetPrinterName || activePrinterName}
                            </span>
                          </div>
                        </div>

                        {order.failureReason && (
                          <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                            {order.failureReason}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ================================================================
              SECTION 6: AGENT STATUS
              ================================================================ */}
          {activeTab === "agent" && (
            <div className="space-y-6">
              <div
                className={`rounded-2xl border p-5 space-y-4 ${
                  isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                        localAgentStatus.running
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                      }`}
                    >
                      <Cpu className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold">
                        Background Python Print Agent
                      </h3>
                      <p className="text-xs text-zinc-500">
                        {localAgentStatus.running
                          ? `Running in background (PID ${localAgentStatus.pid})`
                          : "Stopped or restarting"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        if (window.electronAPI) {
                          await window.electronAPI.restartAgent();
                          refreshLocalAgentStatus();
                          toast.success("Background print agent restarted");
                        }
                      }}
                      className="px-3.5 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>{localAgentStatus.running ? "Restart Agent" : "Start Agent"}</span>
                    </button>

                    {localAgentStatus.running && (
                      <button
                        type="button"
                        onClick={async () => {
                          if (window.electronAPI) {
                            await window.electronAPI.stopAgent();
                            refreshLocalAgentStatus();
                            toast.success("Background print agent stopped");
                          }
                        }}
                        className="px-3.5 py-2 rounded-xl border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 text-xs font-semibold inline-flex items-center gap-1.5"
                      >
                        <Square className="w-3.5 h-3.5" />
                        <span>Stop</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleRunDiagnostics}
                      disabled={runningDiag}
                      className="px-3.5 py-2 rounded-xl border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50 text-xs font-semibold inline-flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-[#8D0100]" />
                      <span>{runningDiag ? "Running..." : "Run Diagnostics"}</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3.5 rounded-xl bg-zinc-50 border border-zinc-100 text-xs text-zinc-800">
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Paired Agent ID
                    </span>
                    <span className="font-mono-code font-semibold">
                      {session.agentId || localAgentStatus.agentId || "N/A"}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Device ID / Host
                    </span>
                    <span className="font-mono-code font-semibold">
                      {session.hostname} ({session.deviceId})
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Last Cloud Heartbeat
                    </span>
                    <span className="font-semibold">
                      {printerState?.lastSeenAt
                        ? new Date(printerState.lastSeenAt).toLocaleTimeString()
                        : "Syncing..."}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Spooler Queue
                    </span>
                    <span className="font-mono-code font-semibold">
                      {printerState?.spoolerJobCount || 0} active job(s)
                    </span>
                  </div>
                </div>

                {diagOutput && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Diagnostic Output
                    </span>
                    <pre className="p-3.5 rounded-xl bg-zinc-900 text-emerald-400 font-mono-code text-xs overflow-x-auto max-h-56">
                      {diagOutput}
                    </pre>
                  </div>
                )}

                <div className="space-y-1.5">
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    Background Agent Log (agent.log)
                  </span>
                  <pre className="p-4 rounded-xl bg-zinc-950 text-zinc-200 font-mono-code text-xs overflow-x-auto max-h-72 leading-relaxed">
                    {localAgentStatus.logTail || "No log output yet."}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================
              SECTION 7: SETTINGS
              ================================================================ */}
          {activeTab === "settings" && (
            <div
              className={`rounded-2xl border p-6 max-w-2xl space-y-5 ${
                isDark ? "bg-zinc-900 border-zinc-800" : "bg-white border-zinc-200"
              }`}
            >
              <div>
                <h3 className="text-base font-bold">Shop & Desktop Settings</h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Configure your Xerox shop profile, customer limits, and Windows startup preferences.
                </p>
              </div>

              <form onSubmit={handleSaveSettings} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Shop Name
                    </label>
                    <input
                      type="text"
                      required
                      value={settingsForm.shopName}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, shopName: e.target.value })
                      }
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Contact Phone
                    </label>
                    <input
                      type="text"
                      value={settingsForm.phone}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, phone: e.target.value })
                      }
                      placeholder="+91 ..."
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-600 mb-1">
                    Shop Address
                  </label>
                  <input
                    type="text"
                    value={settingsForm.address}
                    onChange={(e) =>
                      setSettingsForm({ ...settingsForm, address: e.target.value })
                    }
                    placeholder="Shop address displayed to customers"
                    className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-sm"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Maximum Copies per Job
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={settingsForm.maxCopies}
                      onChange={(e) =>
                        setSettingsForm({ ...settingsForm, maxCopies: e.target.value })
                      }
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-sm font-mono-code"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Max Upload File Size (MB)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={settingsForm.maxUploadMb}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          maxUploadMb: e.target.value
                        })
                      }
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-sm font-mono-code"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-zinc-100">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Customer Website Domain (for QR Code)
                    </label>
                    <input
                      type="url"
                      required
                      value={settingsForm.customerBaseUrl}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          customerBaseUrl: e.target.value
                        })
                      }
                      placeholder="https://smart-xerox-web-2mwa.onrender.com"
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-xs font-mono-code"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 mb-1">
                      Cloud Backend API URL
                    </label>
                    <input
                      type="url"
                      required
                      value={settingsForm.apiBaseUrl}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          apiBaseUrl: e.target.value
                        })
                      }
                      className="w-full h-10 px-3 rounded-lg border border-zinc-300 text-xs font-mono-code"
                    />
                  </div>
                </div>

                <div className="space-y-2.5 pt-2">
                  <label className="flex items-center gap-2.5 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingsForm.acceptingOrders}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          acceptingOrders: e.target.checked
                        })
                      }
                      className="w-4 h-4 accent-[#8D0100]"
                    />
                    <span>Accept incoming customer print jobs</span>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingsForm.autoStartWithWindows}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          autoStartWithWindows: e.target.checked
                        })
                      }
                      className="w-4 h-4 accent-[#8D0100]"
                    />
                    <span>Start Smart Xerox background agent automatically when Windows starts</span>
                  </label>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="px-5 py-2.5 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {savingSettings ? "Saving..." : "Save Settings"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </main>
      </div>

      {/* ====================================================================
          SECTION 8: LOGOUT CONFIRMATION MODAL
          ==================================================================== */}
      {showLogoutModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-6 max-w-md w-full space-y-4 text-zinc-900 shadow-lg">
            <h3 className="text-base font-bold">Sign Out of Smart Xerox</h3>
            <p className="text-xs text-zinc-600 leading-relaxed">
              Choose whether to sign out of the dashboard while keeping the background print agent active, or completely unpair this computer from your shop.
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleLogout(false)}
                className="w-full py-2.5 px-4 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold"
              >
                Sign Out (Keep Background Print Agent Active)
              </button>
              <button
                type="button"
                onClick={() => handleLogout(true)}
                className="w-full py-2.5 px-4 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-semibold"
              >
                Sign Out & Unpair This Computer
              </button>
              <button
                type="button"
                onClick={() => setShowLogoutModal(false)}
                className="w-full py-2 px-4 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-600 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REPRINT CONFIRMATION MODAL */}
      {confirmReprintJob && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-sm w-full space-y-4 text-zinc-900 shadow-lg">
            <h3 className="text-base font-bold">Confirm Reprint</h3>
            <p className="text-xs text-zinc-600 leading-relaxed">
              Send <strong>{confirmReprintJob.originalName}</strong> (
              {confirmReprintJob.copies}{" "}
              {confirmReprintJob.copies === 1 ? "copy" : "copies"}) to{" "}
              <strong>{activePrinterName}</strong>?
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReprintJob(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReprint}
                className="px-4 py-2 rounded-xl bg-[#8D0100] text-white text-xs font-semibold"
              >
                Print Now
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster position="top-right" />
    </div>
  );
}
