import axios from "axios";

function normalizeConfiguredApiUrl(value) {
  const cleaned = String(value || "").trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  let withProtocol = cleaned;
  if (!/^https?:\/\//i.test(withProtocol) && !withProtocol.startsWith("/")) {
    const isLocal = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(
      withProtocol
    );
    withProtocol = `${isLocal ? "http" : "https"}://${withProtocol}`;
  }
  if (!withProtocol.endsWith("/api")) {
    withProtocol = `${withProtocol}/api`;
  }
  return withProtocol;
}

/**
 * Resolves the backend API base URL for mobile browsers, LAN testing, and Render HTTPS production.
 */
export function resolveApiBaseUrl() {
  const rawEnvUrl = normalizeConfiguredApiUrl(import.meta.env.VITE_API_BASE_URL);

  if (typeof window !== "undefined" && window.location?.hostname) {
    const currentHost = window.location.hostname;
    const isBrowserOnLanIp =
      currentHost !== "localhost" &&
      currentHost !== "127.0.0.1" &&
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(currentHost);

    if (isBrowserOnLanIp) {
      if (!rawEnvUrl || rawEnvUrl.includes("localhost") || rawEnvUrl.includes("127.0.0.1")) {
        return `http://${currentHost}:5000/api`;
      }
      try {
        const parsed = new URL(rawEnvUrl);
        if (
          /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(parsed.hostname) &&
          parsed.hostname !== currentHost
        ) {
          parsed.hostname = currentHost;
          return parsed.toString().replace(/\/+$/, "");
        }
      } catch (_err) {
        // Fall through
      }
    }
  }

  if (rawEnvUrl) {
    return rawEnvUrl;
  }

  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:5000/api`;
  }

  return "/api";
}

export const API_BASE_URL = resolveApiBaseUrl();

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
  headers: {
    Accept: "application/json"
  }
});

export function getApiErrorMessage(error, fallback = "Something went wrong. Please try again.") {
  if (axios.isCancel(error)) return "Request cancelled.";
  if (error?.response?.data?.message) {
    return error.response.data.message;
  }
  if (error?.code === "ECONNABORTED") {
    return "Upload timed out. Please check your internet connection and try again.";
  }
  if (!error?.response && error?.request) {
    return `Cannot reach the Smart Xerox cloud server (${API_BASE_URL}). Please check your internet connection.`;
  }
  return error?.message || fallback;
}

export async function checkHealth() {
  const { data } = await apiClient.get("/health");
  return data;
}

/* ==========================================================================
   CUSTOMER SHOP-SCOPED API (/api/shops/:shopSlug/*)
   ========================================================================== */

function encodeSlug(shopSlug) {
  return encodeURIComponent(String(shopSlug || "").trim().toLowerCase());
}

export async function fetchShopInfo(shopSlug) {
  const { data } = await apiClient.get(`/shops/${encodeSlug(shopSlug)}`);
  return data;
}

export async function fetchPrinterStatus(shopSlug) {
  const { data } = await apiClient.get(`/shops/${encodeSlug(shopSlug)}/printer-status`);
  return data;
}

export async function inspectAndStagePdf(shopSlug, file, onProgress, signal) {
  const formData = new FormData();
  formData.append("document", file, file.name || "document");

  const { data } = await apiClient.post(
    `/shops/${encodeSlug(shopSlug)}/orders/inspect`,
    formData,
    {
      signal,
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percent = Math.min(
            100,
            Math.round((progressEvent.loaded * 100) / progressEvent.total)
          );
          onProgress(percent);
        }
      }
    }
  );
  return data;
}

export async function createPrintOrder(
  shopSlug,
  {
    file,
    uploadId,
    idempotencyKey,
    pageSelectionMode,
    customPageRange,
    selectedPages,
    copies,
    colorMode,
    sides,
    paperSize,
    orientation
  }
) {
  const formData = new FormData();
  if (uploadId) {
    formData.append("uploadId", uploadId);
  } else if (file) {
    formData.append("document", file, file.name || "document");
  }
  if (idempotencyKey) {
    formData.append("idempotencyKey", idempotencyKey);
  }
  formData.append(
    "pageSelectionMode",
    pageSelectionMode === "all" ? "all" : "custom"
  );
  if (customPageRange && pageSelectionMode === "custom") {
    formData.append("customPageRange", customPageRange);
  }
  formData.append("selectedPages", JSON.stringify(selectedPages || [1]));
  formData.append("copies", String(copies || 1));
  formData.append("colorMode", colorMode || "bw");
  formData.append("sides", sides || "single");
  formData.append("paperSize", paperSize || "A4");
  formData.append("orientation", orientation || "portrait");

  const { data } = await apiClient.post(
    `/shops/${encodeSlug(shopSlug)}/orders`,
    formData
  );
  return data;
}

export async function fetchOrderByToken(shopSlug, tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.get(
    `/shops/${encodeSlug(shopSlug)}/orders/${clean}`
  );
  return data;
}

export async function cancelPendingOrder(shopSlug, tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.post(
    `/shops/${encodeSlug(shopSlug)}/orders/${clean}/cancel`
  );
  return data;
}

/* ==========================================================================
   CUSTOMER LOCAL SESSION JOB HISTORY (SCOPED PER SHOP SLUG)
   ========================================================================== */

function getCustomerJobStorageKey(shopSlug) {
  return `smart_xerox_customer_tokens_${String(shopSlug || "default").toLowerCase()}`;
}

export function saveCustomerOrderToken(shopSlug, token) {
  if (!shopSlug || !token || typeof window === "undefined") return;
  try {
    const key = getCustomerJobStorageKey(shopSlug);
    const existing = JSON.parse(localStorage.getItem(key) || "[]");
    const updated = [token, ...existing.filter((t) => t !== token)].slice(0, 10);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch (_e) {
    // Ignore storage errors
  }
}

export function getSavedCustomerOrderTokens(shopSlug) {
  if (!shopSlug || typeof window === "undefined") return [];
  try {
    const key = getCustomerJobStorageKey(shopSlug);
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}

/* ==========================================================================
   PLATFORM SUPER ADMIN API (/api/super-admin/*)
   ========================================================================== */

function getSuperAdminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`
  };
}

export async function superAdminLoginRequest(email, password) {
  const { data } = await apiClient.post("/super-admin/login", { email, password });
  return data;
}

export async function fetchSuperAdminOverview(token) {
  const { data } = await apiClient.get("/super-admin/overview", {
    headers: getSuperAdminHeaders(token)
  });
  return data;
}

export async function createVendorRequest(token, payload) {
  const { data } = await apiClient.post("/super-admin/vendors", payload, {
    headers: getSuperAdminHeaders(token)
  });
  return data;
}

export async function updateVendorStatusRequest(token, tenantId, status) {
  const { data } = await apiClient.patch(
    `/super-admin/vendors/${encodeURIComponent(tenantId)}/status`,
    { status },
    { headers: getSuperAdminHeaders(token) }
  );
  return data;
}

export async function resetVendorPasswordRequest(token, tenantId, newPassword) {
  const { data } = await apiClient.post(
    `/super-admin/vendors/${encodeURIComponent(tenantId)}/reset-password`,
    { newPassword },
    { headers: getSuperAdminHeaders(token) }
  );
  return data;
}

export async function fetchSuperAdminAuditLogs(token, limit = 50) {
  const { data } = await apiClient.get("/super-admin/audit-logs", {
    params: { limit },
    headers: getSuperAdminHeaders(token)
  });
  return data;
}

export default apiClient;
