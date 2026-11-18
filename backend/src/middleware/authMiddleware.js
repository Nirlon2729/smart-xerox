const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: "Admin authentication required" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(payload.sub).select("_id email role active");
    if (!admin || !admin.active) return res.status(401).json({ success: false, message: "Invalid admin session" });

    req.admin = admin;
    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
  }
}

function requireAgent(req, res, next) {
  const provided = req.headers["x-agent-token"];
  const expected = process.env.PRINT_AGENT_TOKEN;
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Print agent authentication failed" });
  }
  next();
}

module.exports = { requireAdmin, requireAgent };
