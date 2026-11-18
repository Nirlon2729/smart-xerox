const adminController = require("./adminController");
const { getShopCustomerUrl } = require("../utils/qrService");

module.exports = {
  ...adminController,
  getShopCustomerUrl
};
