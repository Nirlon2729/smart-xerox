const crypto = require("crypto");

function generateAgentCredentials() {
  const agentId = `agt_${crypto.randomBytes(10).toString("hex")}`;
  const agentSecret = `sxk_${crypto.randomBytes(32).toString("hex")}`;
  const secretHash = hashAgentSecret(agentSecret);
  return { agentId, agentSecret, secretHash };
}

function hashAgentSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function verifyAgentSecret(secret, expectedHash) {
  if (!secret || !expectedHash) return false;
  const actualHash = hashAgentSecret(secret);
  const aBuf = Buffer.from(actualHash, "hex");
  const bBuf = Buffer.from(String(expectedHash), "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function slugifyShopName(input) {
  const base = String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "smart-xerox-shop";
}

function isLocalOrLanHost(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
    if (!host.includes(".")) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch (_err) {
    return true;
  }
}

const PRODUCTION_SHOP_BASE_URL = "https://smart-xerox-web-2mwa.onrender.com";

function normalizePublicOrigin(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "*") return "";
  if (
    trimmed === "smart-xerox-web" ||
    trimmed === "smart-xerox-web-2mwa" ||
    trimmed === "https://smart-xerox-web-2mwa" ||
    trimmed === "smart-xerox-web.onrender.com" ||
    trimmed === "https://smart-xerox-web.onrender.com" ||
    trimmed.includes("smartxerox.com") ||
    trimmed.includes("smart-xerox-web.onrender.com")
  ) {
    return PRODUCTION_SHOP_BASE_URL;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
        return `https://${parsed.hostname}.onrender.com`;
      }
    } catch (_e) {
      return PRODUCTION_SHOP_BASE_URL;
    }
    return trimmed;
  }
  if (!trimmed.includes(".") && !trimmed.startsWith("localhost")) {
    return `https://${trimmed}.onrender.com`;
  }
  return `https://${trimmed}`;
}

function buildShopPublicUrl(shopSlug, customBaseUrl = null) {
  const candidates = [
    customBaseUrl,
    process.env.PUBLIC_SHOP_BASE_URL,
    ...(process.env.CUSTOMER_ORIGIN || "").split(",").map((s) => s.trim())
  ]
    .map(normalizePublicOrigin)
    .filter(Boolean);

  let publicOrigin = candidates.find(
    (url) =>
      !isLocalOrLanHost(url) &&
      !url.includes("smartxerox.com") &&
      !url.includes("smart-xerox-web.onrender.com")
  );
  if (!publicOrigin) {
    publicOrigin = PRODUCTION_SHOP_BASE_URL;
  }
  const cleanBase = publicOrigin.replace(/\/+$/, "");
  return `${cleanBase}/shop/${encodeURIComponent(shopSlug)}`;
}

module.exports = {
  generateAgentCredentials,
  hashAgentSecret,
  verifyAgentSecret,
  slugifyShopName,
  buildShopPublicUrl,
  PRODUCTION_SHOP_BASE_URL
};
