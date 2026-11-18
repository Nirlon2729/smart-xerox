const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const { resolveShopTenant } = require("../middleware/authMiddleware");
const {
  uploadDocument,
  getShopPublicInfo,
  getPrinterStatus,
  inspectDocument,
  createOrder,
  getOrderByToken,
  cancelOrder
} = require("../controllers/orderController");

router.use("/:shopSlug", resolveShopTenant);

router.get("/:shopSlug", asyncHandler(getShopPublicInfo));
router.get("/:shopSlug/printer-status", asyncHandler(getPrinterStatus));
router.post("/:shopSlug/orders/inspect", uploadDocument, asyncHandler(inspectDocument));
router.post("/:shopSlug/orders", uploadDocument, asyncHandler(createOrder));
router.get("/:shopSlug/orders/:token", asyncHandler(getOrderByToken));
router.post("/:shopSlug/orders/:token/cancel", asyncHandler(cancelOrder));

module.exports = router;
