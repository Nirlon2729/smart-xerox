const { buildShopPublicUrl } = require("./agentCredentials");

const PRODUCTION_CUSTOMER_WEBSITE_URL = "https://smart-xerox-web-2mwa.onrender.com";

/**
 * Returns the exact customer shop URL for QR codes.
 * Guaranteed format: https://smart-xerox-web-2mwa.onrender.com/shop/{shopSlug}
 */
function getShopCustomerUrl(shopSlug, customBaseUrl = null) {
  if (!shopSlug) return "";
  return buildShopPublicUrl(shopSlug, customBaseUrl);
}

module.exports = {
  PRODUCTION_CUSTOMER_WEBSITE_URL,
  getShopCustomerUrl,
  buildShopPublicUrl
};
