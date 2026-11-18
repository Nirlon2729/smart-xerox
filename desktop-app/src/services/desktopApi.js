import axios from "axios";

export const DEFAULT_PRODUCTION_API_URL = "https://smart-xerox-api.onrender.com/api";

let activeApiBaseUrl = DEFAULT_PRODUCTION_API_URL;
let activeVendorToken = "";

export function normalizeDesktopApiUrl(url) {
  const cleaned = String(url || "").trim().replace(/\/+$/, "");
  if (!cleaned) return DEFAULT_PRODUCTION_API_URL;
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

export function configureDesktopApi({ apiBaseUrl, vendorToken }) {
  if (apiBaseUrl) {
    activeApiBaseUrl = normalizeDesktopApiUrl(apiBaseUrl);
  }
  if (vendorToken !== undefined) {
    activeVendorToken = vendorToken || "";
  }
}

export function getActiveApiBaseUrl() {
  return activeApiBaseUrl;
}

function getClient() {
  const headers = {
    Accept: "application/json"
  };
  if (activeVendorToken) {
    headers.Authorization = `Bearer ${activeVendorToken}`;
  }
  return axios.create({
    baseURL: activeApiBaseUrl,
    timeout: 30000,
    headers
  });
}

export function getApiErrorMessage(error, fallback = "Operation failed. Please try again.") {
  if (error?.response?.data?.message) {
    return error.response.data.message;
  }
  if (!error?.response && error?.request) {
    return `Cannot reach Smart Xerox Cloud API (${activeApiBaseUrl}). Verify internet or server connection.`;
  }
  return error?.message || fallback;
}

export async function vendorLogin(email, password, apiBaseUrlOverride = null) {
  if (apiBaseUrlOverride) {
    activeApiBaseUrl = normalizeDesktopApiUrl(apiBaseUrlOverride);
  }
  const { data } = await getClient().post("/vendor/login", { email, password });
  return data;
}

export async function pairDesktopAgent({ deviceId, name, hostname, osVersion, agentVersion = "3.0.0" }) {
  const { data } = await getClient().post("/vendor/agents/pair", {
    deviceId,
    name,
    hostname,
    osVersion,
    agentVersion
  });
  return data;
}

export async function revokeDesktopAgent(agentId) {
  const { data } = await getClient().post(
    `/vendor/agents/${encodeURIComponent(agentId)}/revoke`
  );
  return data;
}

export async function fetchVendorDashboard() {
  const { data } = await getClient().get("/vendor/dashboard");
  return data;
}

export async function fetchVendorPrinters() {
  const { data } = await getClient().get("/vendor/printers");
  return data;
}

export async function selectVendorPrinter(printerName, autoSelectSinglePrinter = true) {
  const { data } = await getClient().put("/vendor/printers/select", {
    printerName,
    autoSelectSinglePrinter
  });
  return data;
}

export async function updatePrinterCapabilities(payload) {
  const { data } = await getClient().put("/vendor/printers/capabilities", payload);
  return data;
}

export async function updateVendorSettings(payload) {
  const { data } = await getClient().put("/vendor/settings", payload);
  return data;
}

export async function fetchVendorOrders({ status = "ALL", search = "" } = {}) {
  const params = {};
  if (status && status !== "ALL") params.status = status;
  if (search && search.trim()) params.search = search.trim();
  const { data } = await getClient().get("/vendor/orders", { params });
  return data;
}

export async function cancelVendorOrder(tokenOrId) {
  const { data } = await getClient().post(
    `/vendor/orders/${encodeURIComponent(tokenOrId)}/cancel`
  );
  return data;
}

export async function reprintVendorOrder(tokenOrId) {
  const { data } = await getClient().post(
    `/vendor/orders/${encodeURIComponent(tokenOrId)}/reprint`
  );
  return data;
}

export async function clearFailedVendorOrders() {
  const { data } = await getClient().delete("/vendor/orders/failed");
  return data;
}

export async function downloadVendorOrderBlob(orderId) {
  const response = await fetch(
    `${activeApiBaseUrl}/vendor/orders/${encodeURIComponent(orderId)}/file`,
    {
      headers: {
        Authorization: `Bearer ${activeVendorToken}`
      }
    }
  );
  if (!response.ok) {
    throw new Error("Document file was already cleaned up from GridFS.");
  }
  return response.blob();
}
