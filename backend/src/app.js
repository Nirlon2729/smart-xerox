const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");

const shopRoutes = require("./routes/shopRoutes");
const orderRoutes = require("./routes/orderRoutes");
const agentRoutes = require("./routes/agentRoutes");
const adminRoutes = require("./routes/adminRoutes");
const superAdminRoutes = require("./routes/superAdminRoutes");
const { notFound, errorHandler } = require("./middleware/errorMiddleware");
const { rejectNoSqlInjection } = require("./middleware/securityMiddleware");
const { recordAuditLog } = require("./utils/auditLogger");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

const PRODUCTION_CUSTOMER_ORIGIN = "https://smart-xerox-web-2mwa.onrender.com";

const normalizeOriginValue = (val) => {
  const trimmed = String(val || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "*") return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed === "smart-xerox-web" || trimmed === "smart-xerox-web.onrender.com") {
    return PRODUCTION_CUSTOMER_ORIGIN;
  }
  if (!trimmed.includes(".") && !trimmed.startsWith("localhost")) {
    return `https://${trimmed}.onrender.com`;
  }
  return `https://${trimmed}`;
};

const configuredOrigins = Array.from(
  new Set(
    [
      PRODUCTION_CUSTOMER_ORIGIN,
      ...(process.env.CUSTOMER_ORIGIN || "http://localhost:5173,http://localhost:5174").split(",")
    ]
      .map(normalizeOriginValue)
      .filter(Boolean)
  )
);

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

const corsOptions = {
  origin: (origin, callback) => {
    // Allow same-origin, server-to-server, print-agent, or Electron desktop file:// / null origins
    if (
      !origin ||
      origin === "null" ||
      origin.startsWith("file://") ||
      origin.startsWith("app://")
    ) {
      return callback(null, true);
    }

    const normalized = origin.replace(/\/+$/, "");
    if (configuredOrigins.includes(normalized) || configuredOrigins.includes("*")) {
      return callback(null, true);
    }

    // Allow local/LAN origins in development or local Electron dev server
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
    "x-agent-id",
    "x-agent-secret",
    "x-agent-token",
    "x-agent-job-id"
  ],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(rejectNoSqlInjection);
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const isDbConnected = mongoose.connection.readyState === 1;

  if (!isDbConnected) {
    return res.status(503).json({
      success: false,
      status: "unhealthy",
      service: "smart-xerox-multi-vendor-print-api",
      database: "disconnected",
      timestamp: new Date().toISOString()
    });
  }

  return res.status(200).json({
    success: true,
    status: "ok",
    service: "smart-xerox-multi-vendor-print-api",
    architecture: "multi-tenant",
    storage: "mongodb-gridfs",
    database: "connected",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordAuditLog({
      actorType: "SYSTEM",
      actorId: req.ip,
      action: "API_RATE_LIMIT_EXCEEDED",
      details: { path: req.originalUrl },
      req
    }).catch(() => {});
    res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down and try again shortly."
    });
  }
});

// 1. Customer Shop-Scoped Routes (/api/shops/:shopSlug/*)
app.use("/api/shops", apiLimiter, shopRoutes);

// 2. Vendor Desktop App Routes (/api/vendor/* and /api/admin/*)
app.use("/api/vendor", apiLimiter, adminRoutes);
app.use("/api/admin", apiLimiter, adminRoutes);

// 3. Super Admin Platform Routes (/api/super-admin/*)
app.use("/api/super-admin", apiLimiter, superAdminRoutes);

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.AGENT_RATE_LIMIT_MAX) || 180,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    recordAuditLog({
      actorType: "AGENT",
      actorId: req.headers["x-agent-id"] || req.ip,
      action: "AGENT_RATE_LIMIT_EXCEEDED",
      details: { path: req.originalUrl },
      req
    }).catch(() => {});
    res.status(429).json({
      success: false,
      message: "Agent request rate limit exceeded. Please back off and retry."
    });
  }
});

// 4. Print Agent Routes (/api/agent/*)
app.use("/api/agent", agentLimiter, agentRoutes);

// 5. Legacy unscoped /api/orders & /api/jobs guard
app.use("/api/orders", orderRoutes);
app.use("/api/jobs", orderRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
