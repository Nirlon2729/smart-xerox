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
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch (_err) {
    return true;
  }
}

function buildShopPublicUrl(shopSlug, customBaseUrl = null) {
  const candidates = [
    customBaseUrl,
    process.env.PUBLIC_SHOP_BASE_URL,
    ...(process.env.CUSTOMER_ORIGIN || "").split(",").map((s) => s.trim())
  ].filter(Boolean);

  const publicOrigin = candidates.find((url) => !isLocalOrLanHost(url));
  const cleanBase = (publicOrigin || "https://smartxerox.com").replace(/\/+$/, "");
  return `${cleanBase}/shop/${encodeURIComponent(shopSlug)}`;
}

module.exports = {
  generateAgentCredentials,
  hashAgentSecret,
  verifyAgentSecret,
  slugifyShopName,
  buildShopPublicUrl
};
