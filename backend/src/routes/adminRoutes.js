const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { requireVendorAdmin } = require("../middleware/authMiddleware");
const { authLimiter } = require("../middleware/securityMiddleware");
const {
  login,
  changeVendorPassword,
  getAdminProfile,
  pairDesktopAgent,
  listVendorAgents,
  revokeVendorAgent,
  getVendorPrinters,
  selectVendorPrinter,
  updateVendorPrinterCapabilities,
  updateVendorSettings,
  getVendorPricing,
  updateVendorPricing,
  updateVendorShopAvailability,
  markVendorAgentOffline,
  listOrders,
  downloadAdminOrderFile,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
} = require("../controllers/adminController");

router.post("/login", authLimiter, asyncHandler(login));
router.get("/me", requireVendorAdmin, asyncHandler(getAdminProfile));
router.get("/dashboard", requireVendorAdmin, asyncHandler(getAdminProfile));

// Desktop Agent Pairing & Lifecycle
router.post("/agents/pair", requireVendorAdmin, asyncHandler(pairDesktopAgent));
router.get("/agents", requireVendorAdmin, asyncHandler(listVendorAgents));
router.post("/agents/offline", requireVendorAdmin, asyncHandler(markVendorAgentOffline));
router.post("/agents/:agentId/revoke", requireVendorAdmin, asyncHandler(revokeVendorAgent));

// Printer Management & Capability Configuration
router.get("/printers", requireVendorAdmin, asyncHandler(getVendorPrinters));
router.put("/printers/select", requireVendorAdmin, asyncHandler(selectVendorPrinter));
router.put("/printers/capabilities", requireVendorAdmin, asyncHandler(updateVendorPrinterCapabilities));

// Dynamic Vendor Printing Prices & Shop Availability Controls
router.get("/pricing", requireVendorAdmin, asyncHandler(getVendorPricing));
router.put("/pricing", requireVendorAdmin, asyncHandler(updateVendorPricing));
router.put("/availability", requireVendorAdmin, asyncHandler(updateVendorShopAvailability));

// Vendor Shop Profile, Settings & Password Management
router.put("/profile", requireVendorAdmin, asyncHandler(updateVendorSettings));
router.put("/settings", requireVendorAdmin, asyncHandler(updateVendorSettings));
router.put("/password", requireVendorAdmin, asyncHandler(changeVendorPassword));

// Tenant-Scoped Print Jobs & GridFS Document Inspection
router.get("/orders", requireVendorAdmin, asyncHandler(listOrders));
router.get("/orders/:id/file", requireVendorAdmin, asyncHandler(downloadAdminOrderFile));
router.post("/orders/:token/cancel", requireVendorAdmin, asyncHandler(cancelOrder));
router.post("/orders/:token/reprint", requireVendorAdmin, asyncHandler(reprintOrder));
router.delete("/orders/failed", requireVendorAdmin, asyncHandler(clearFailedOrders));

module.exports = router;
