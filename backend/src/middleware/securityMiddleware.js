const rateLimit = require("express-rate-limit");
const { recordAuditLog } = require("../utils/auditLogger");

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function findMaliciousKey(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 12) return null;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findMaliciousKey(obj[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key) || key.startsWith("$") || key.includes(".")) {
      return key;
    }
    const hit = findMaliciousKey(obj[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Blocks MongoDB operator injection ($ne, $gt, $where, $regex, dotted paths)
 * and JavaScript prototype pollution keys (__proto__, constructor, prototype)
 * across req.body, req.query, and req.params.
 */
function rejectNoSqlInjection(req, res, next) {
  const suspiciousKey =
    findMaliciousKey(req.body) ||
    findMaliciousKey(req.query) ||
    findMaliciousKey(req.params);

  if (suspiciousKey) {
    recordAuditLog({
      tenantId: req.tenantId || null,
      actorType: req.admin ? "VENDOR_ADMIN" : "SYSTEM",
      actorId: req.admin?._id || req.ip,
      action: "SUSPICIOUS_INPUT_BLOCKED",
      details: {
        path: req.originalUrl,
        method: req.method,
        key: String(suspiciousKey).slice(0, 40)
      },
      req
    }).catch(() => {});

    return res.status(400).json({
      success: false,
      message: "Invalid request parameters."
    });
  }

  return next();
}

/**
 * Strict brute-force and credential-stuffing protection for login endpoints.
 * Allows up to 15 failed authentication attempts per 15-minute window per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordAuditLog({
      actorType: "SYSTEM",
      actorId: req.ip,
      action: "AUTH_RATE_LIMIT_EXCEEDED",
      details: { path: req.originalUrl },
      req
    }).catch(() => {});

    res.status(429).json({
      success: false,
      message:
        "Too many failed sign-in attempts. Please wait 15 minutes before trying again."
    });
  }
});

module.exports = {
  rejectNoSqlInjection,
  authLimiter
};
