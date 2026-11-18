require("dotenv").config();

const os = require("os");
const app = require("./app");
const connectDB = require("./config/db");
const { bootstrapOwner } = require("./controllers/adminController");

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || "0.0.0.0";

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const [name, netList] of Object.entries(nets)) {
    for (const net of netList || []) {
      if (net.family === "IPv4" && !net.internal) {
        addresses.push({ name, address: net.address });
      }
    }
  }
  return addresses;
}

async function start() {
  await connectDB();
  await bootstrapOwner();
  app.listen(PORT, HOST, () => {
    console.log(`Smart Xerox API listening on http://localhost:${PORT}`);
    const lanAddrs = getLanAddresses();
    for (const item of lanAddrs) {
      console.log(`LAN Network (${item.name}): http://${item.address}:${PORT}/api/health`);
    }
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
