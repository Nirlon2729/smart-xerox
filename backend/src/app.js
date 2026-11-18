const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const orderRoutes = require("./routes/orderRoutes");
const agentRoutes = require("./routes/agentRoutes");
const adminRoutes = require("./routes/adminRoutes");
const { notFound, errorHandler } = require("./middleware/errorMiddleware");

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

const configuredOrigins = (process.env.CUSTOMER_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const isPrivateLanOrigin = (origin) => {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch (_err) {
    return false;
  }
};

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin, server-to-server, print-agent, or mobile native requests without Origin header
      if (!origin) return callback(null, true);

      const normalized = origin.replace(/\/+$/, "");
      if (configuredOrigins.includes(normalized)) {
        return callback(null, true);
      }

      // Allow phones on the same Wi-Fi LAN in development
      if (process.env.NODE_ENV !== "production" && isPrivateLanOrigin(normalized)) {
        return callback(null, true);
      }

      const corsError = new Error(`Origin ${origin} not allowed by CORS`);
      corsError.statusCode = 403;
      return callback(corsError);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "x-agent-token",
      "x-agent-job-id"
    ]
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "smart-xerox-personal-print-api",
    storage: "mongodb-gridfs",
    timestamp: new Date().toISOString()
  });
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/orders", apiLimiter, orderRoutes);
app.use("/api/jobs", apiLimiter, orderRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/admin", adminRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
