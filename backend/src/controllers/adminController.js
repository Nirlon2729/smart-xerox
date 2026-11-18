const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Order = require("../models/Order");
const {
  getActivePrinterState,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
} = require("./orderController");
const { openGridFSDownloadStream } = require("../services/gridfsService");

async function login(req, res) {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const admin = await Admin.findOne({ email, active: true });
  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    return res.status(401).json({ success: false, message: "Invalid owner credentials" });
  }

  const token = jwt.sign(
    { sub: admin._id.toString(), role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
  res.json({
    success: true,
    token,
    admin: { email: admin.email, role: admin.role }
  });
}

async function getAdminProfile(req, res) {
  const printer = await getActivePrinterState();
  res.json({
    success: true,
    admin: req.admin,
    printer
  });
}

async function listOrders(req, res) {
  const { status, search } = req.query;
  const filter = {};

  if (status && status !== "ALL") {
    filter.status = status;
  }

  if (search && String(search).trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    filter.$or = [{ token: regex }, { originalName: regex }];
  }

  const orders = await Order.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .select("-storedFileName");

  const printer = await getActivePrinterState();

  res.json({
    success: true,
    orders,
    printer
  });
}

/**
 * GET /api/admin/orders/:id/file
 * Allows authenticated owner to stream/inspect their uploaded document from MongoDB GridFS.
 */
async function downloadAdminOrderFile(req, res) {
  const order = await Order.findById(req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, message: "Print job not found" });
  }
  if (!order.gridFsFileId || order.fileDeleted) {
    return res.status(410).json({
      success: false,
      message: "Document file was already cleaned up from GridFS after printing."
    });
  }

  const { fileDoc, stream } = await openGridFSDownloadStream(order.gridFsFileId);
  res.setHeader("Content-Type", order.mimeType || fileDoc.contentType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileDoc.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(order.originalName || fileDoc.filename)}"`
  );
  stream.pipe(res);
}

async function bootstrapOwner() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  const exists = await Admin.findOne({ email: process.env.ADMIN_EMAIL.toLowerCase() });
  if (!exists) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await Admin.create({
      email: process.env.ADMIN_EMAIL.toLowerCase(),
      passwordHash,
      role: "OWNER"
    });
    console.log("Initial owner account created from environment variables");
  }
}

module.exports = {
  login,
  getAdminProfile,
  listOrders,
  downloadAdminOrderFile,
  cancelOrder,
  reprintOrder,
  clearFailedOrders,
  bootstrapOwner
};
