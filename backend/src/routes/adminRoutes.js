const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { requireAdmin } = require("../middleware/authMiddleware");
const {
  login,
  getAdminProfile,
  listOrders,
  downloadAdminOrderFile,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
} = require("../controllers/adminController");

router.post("/login", asyncHandler(login));
router.get("/me", requireAdmin, asyncHandler(getAdminProfile));
router.get("/orders", requireAdmin, asyncHandler(listOrders));
router.get("/orders/:id/file", requireAdmin, asyncHandler(downloadAdminOrderFile));
router.post("/orders/:token/cancel", requireAdmin, asyncHandler(cancelOrder));
router.post("/orders/:token/reprint", requireAdmin, asyncHandler(reprintOrder));
router.delete("/orders/failed", requireAdmin, asyncHandler(clearFailedOrders));

module.exports = router;
