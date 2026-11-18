const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { requireSuperAdmin } = require("../middleware/authMiddleware");
const {
  login,
  getSuperAdminOverview,
  createVendor,
  updateVendorStatus,
  resetVendorPassword,
  listAuditLogs
} = require("../controllers/adminController");

router.post("/login", asyncHandler(login));
router.get("/overview", requireSuperAdmin, asyncHandler(getSuperAdminOverview));
router.post("/vendors", requireSuperAdmin, asyncHandler(createVendor));
router.patch("/vendors/:tenantId/status", requireSuperAdmin, asyncHandler(updateVendorStatus));
router.post("/vendors/:tenantId/reset-password", requireSuperAdmin, asyncHandler(resetVendorPassword));
router.get("/audit-logs", requireSuperAdmin, asyncHandler(listAuditLogs));

module.exports = router;
