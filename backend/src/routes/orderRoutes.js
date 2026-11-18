const router = require("express").Router();

/**
 * Legacy unscoped /api/orders endpoints are disabled in multi-vendor mode to prevent cross-tenant leakage.
 * All customer requests must use /api/shops/:shopSlug/orders/* and vendor requests must use /api/vendor/orders/*.
 */
router.use((_req, res) => {
  res.status(400).json({
    success: false,
    message:
      "Unscoped order endpoint is disabled in multi-vendor mode. Use /api/shops/:shopSlug/... for customer orders or /api/vendor/... for authenticated vendor operations."
  });
});

module.exports = router;
