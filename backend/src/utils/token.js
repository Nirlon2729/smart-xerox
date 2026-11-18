const crypto = require("crypto");

function createPrintToken() {
  const date = new Date();
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
  const suffix = crypto.randomInt(1000, 10000);
  return `XR-${ymd}-${suffix}`;
}

module.exports = { createPrintToken };
