const AuditLog = require("../models/AuditLog");

async function recordAuditLog({
  tenantId = null,
  actorType = "SYSTEM",
  actorId = null,
  action,
  targetType = null,
  targetId = null,
  details = {},
  req = null
}) {
  try {
    const ipAddress = req
      ? String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null
      : null;

    await AuditLog.create({
      tenantId: tenantId || null,
      actorType,
      actorId: actorId ? String(actorId) : null,
      action,
      targetType,
      targetId: targetId ? String(targetId) : null,
      details,
      ipAddress
    });
  } catch (err) {
    // Non-fatal: do not crash main request if audit log write fails
    console.error("AuditLog write warning:", err.message);
  }
}

module.exports = { recordAuditLog };
