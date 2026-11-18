const router = require("express").Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  uploadDocument,
  getPrinterStatus,
  inspectDocument,
  createOrder,
  listRecentOrders,
  getOrderByToken,
  cancelOrder,
  reprintOrder,
  clearFailedOrders
} = require("../controllers/orderController");

router.get("/printer-status", asyncHandler(getPrinterStatus));
router.get("/", asyncHandler(listRecentOrders));
router.post("/inspect", uploadDocument, asyncHandler(inspectDocument));
router.post("/", uploadDocument, asyncHandler(createOrder));
router.delete("/failed", asyncHandler(clearFailedOrders));
router.get("/:token", asyncHandler(getOrderByToken));
router.post("/:token/cancel", asyncHandler(cancelOrder));
router.post("/:token/reprint", asyncHandler(reprintOrder));

module.exports = router;
