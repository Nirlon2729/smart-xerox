import axios from "axios";

/**
 * Resolves the backend API base URL for desktop, mobile Wi-Fi LAN, and Render HTTPS production.
 * Ensures mobile phones visiting http://<LAN-IP>:5173 never accidentally call localhost on the phone.
 */
export function resolveApiBaseUrl() {
  const rawEnvUrl = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

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
    return "Upload timed out. Please check your Wi-Fi or mobile connection and try again.";
  }
  if (!error?.response && error?.request) {
    return `Cannot reach the Smart Xerox backend (${API_BASE_URL}). Verify the backend is running and your phone is on the same network.`;
  }
  return error?.message || fallback;
}

export async function checkHealth() {
  const { data } = await apiClient.get("/health");
  return data;
}

export async function fetchPrinterStatus() {
  const { data } = await apiClient.get("/orders/printer-status");
  return data;
}

export async function fetchRecentJobs(limit = 20) {
  const { data } = await apiClient.get("/orders", { params: { limit } });
  return data;
}

/**
 * Uploads and inspects a PDF, JPG, JPEG, or PNG file and stores it in MongoDB Atlas GridFS.
 * Does NOT manually set Content-Type so the browser attaches the multipart boundary automatically.
 */
export async function inspectAndStagePdf(file, onProgress, signal) {
  const formData = new FormData();
  formData.append("document", file, file.name || "document");

  const { data } = await apiClient.post("/orders/inspect", formData, {
    signal,
    onUploadProgress: (progressEvent) => {
      if (onProgress && progressEvent.total) {
        const percent = Math.min(100, Math.round((progressEvent.loaded * 100) / progressEvent.total));
        onProgress(percent);
      }
    }
  });
  return data;
}

/**
 * Direct PRINT NOW job submission.
 * Immediately sets job status to QUEUED in MongoDB so the Windows 11 print agent starts printing.
 */
export async function createPrintOrder({
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
}) {
  const formData = new FormData();
  if (uploadId) {
    formData.append("uploadId", uploadId);
  } else if (file) {
    formData.append("document", file, file.name || "document");
  }
  if (idempotencyKey) {
    formData.append("idempotencyKey", idempotencyKey);
  }
  formData.append("pageSelectionMode", pageSelectionMode || "all");
  if (customPageRange) {
    formData.append("customPageRange", customPageRange);
  }
  formData.append("selectedPages", JSON.stringify(selectedPages || [1]));
  formData.append("copies", String(copies || 1));
  formData.append("colorMode", colorMode || "bw");
  formData.append("sides", sides || "single");
  formData.append("paperSize", paperSize || "A4");
  formData.append("orientation", orientation || "auto");

  const { data } = await apiClient.post("/orders", formData);
  return data;
}

export async function fetchOrderByToken(tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.get(`/orders/${clean}`);
  return data;
}

export async function cancelPendingOrder(tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.post(`/orders/${clean}/cancel`);
  return data;
}

export async function reprintOrderRequest(tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.post(`/orders/${clean}/reprint`);
  return data;
}

export async function clearFailedOrdersRequest() {
  const { data } = await apiClient.delete("/orders/failed");
  return data;
}

/* ==========================================================================
   OWNER AUTHENTICATION & MANAGEMENT API
   ========================================================================== */

function getOwnerHeaders(ownerToken) {
  return {
    Authorization: `Bearer ${ownerToken}`
  };
}

export async function adminLoginRequest(email, password) {
  const { data } = await apiClient.post("/admin/login", { email, password });
  return data;
}

export async function fetchAdminOrders(ownerToken, { status = "ALL", search = "" } = {}) {
  const params = {};
  if (status && status !== "ALL") params.status = status;
  if (search && search.trim()) params.search = search.trim();

  const { data } = await apiClient.get("/admin/orders", {
    params,
    headers: getOwnerHeaders(ownerToken)
  });
  return data;
}

export async function adminCancelOrderRequest(ownerToken, tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.post(
    `/admin/orders/${clean}/cancel`,
    {},
    { headers: getOwnerHeaders(ownerToken) }
  );
  return data;
}

export async function adminReprintOrderRequest(ownerToken, tokenOrId) {
  const clean = encodeURIComponent(String(tokenOrId || "").trim());
  const { data } = await apiClient.post(
    `/admin/orders/${clean}/reprint`,
    {},
    { headers: getOwnerHeaders(ownerToken) }
  );
  return data;
}

export async function adminClearFailedRequest(ownerToken) {
  const { data } = await apiClient.delete("/admin/orders/failed", {
    headers: getOwnerHeaders(ownerToken)
  });
  return data;
}

export default apiClient;
