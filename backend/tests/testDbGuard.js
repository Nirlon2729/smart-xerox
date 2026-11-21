const mongoose = require("mongoose");

const FORBIDDEN_HOST_PATTERNS = [
  /mongodb\+srv:\/\//i,
  /\.mongodb\.net/i,
  /atlas/i,
  /render\.com/i,
  /amazonaws\.com/i,
  /azure\.com/i,
  /gcp\./i
];

/**
 * Refuses to execute automated tests against any production or remote MongoDB URI.
 * Only permits local loopback hosts (127.0.0.1 / localhost / ::1) or ephemeral mongodb-memory-server.
 */
function assertSafeTestUri(uri, { allowMemoryServer = false } = {}) {
  const raw = String(uri || "").trim();
  if (!raw) {
    throw new Error("TEST SAFETY BLOCK: No test MongoDB URI provided.");
  }

  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(raw)) {
      throw new Error(
        `TEST SAFETY BLOCK: Refusing to run automated tests against remote/production MongoDB URI.`
      );
    }
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_err) {
    throw new Error("TEST SAFETY BLOCK: Invalid MongoDB URI format.");
  }

  const host = String(parsed.hostname || "").toLowerCase();
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocal) {
    throw new Error(
      `TEST SAFETY BLOCK: Host "${host}" is not a local loopback test host. Refusing to run tests.`
    );
  }

  if (!allowMemoryServer) {
    const dbName = String(parsed.pathname || "").replace(/^\/+/, "").toLowerCase();
    if (!dbName || !dbName.includes("test")) {
      throw new Error(
        `TEST SAFETY BLOCK: Local test database name "${dbName || "(empty)"}" must contain "test".`
      );
    }
  }

  return raw;
}

/**
 * Boots an isolated MongoDB test database using mongodb-memory-server (preferred)
 * or an explicitly validated local TEST_MONGODB_URI. Never touches backend/.env production URI.
 */
async function startIsolatedTestDatabase() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || "smart-xerox-isolated-test-jwt-secret-key";
  process.env.ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || "test-superadmin@smartxerox.local";
  process.env.ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "TestSuperAdmin@123";

  let memoryServer = null;
  let uri = null;

  if (process.env.TEST_MONGODB_URI) {
    uri = assertSafeTestUri(process.env.TEST_MONGODB_URI);
  } else {
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = require("mongodb-memory-server"));
    } catch (err) {
      throw new Error(
        "mongodb-memory-server is not installed and TEST_MONGODB_URI is not set. " +
          "Refusing to fall back to production MONGODB_URI."
      );
    }

    memoryServer = await MongoMemoryServer.create({
      instance: {
        dbName: "smart_xerox_test"
      }
    });
    uri = assertSafeTestUri(memoryServer.getUri("smart_xerox_test"), {
      allowMemoryServer: true
    });
  }

  process.env.MONGODB_URI = uri;

  return {
    uri,
    memoryServer,
    isInMemory: Boolean(memoryServer)
  };
}

async function stopIsolatedTestDatabase(handle) {
  try {
    if (mongoose.connection.readyState === 1) {
      if (!handle?.isInMemory && mongoose.connection.db) {
        const dbName = mongoose.connection.db.databaseName || "";
        if (dbName.toLowerCase().includes("test")) {
          await mongoose.connection.db.dropDatabase();
        }
      }
      await mongoose.disconnect();
    }
  } catch (_err) {
    // Best-effort cleanup
  }

  if (handle?.memoryServer) {
    await handle.memoryServer.stop();
  }
}

module.exports = {
  assertSafeTestUri,
  startIsolatedTestDatabase,
  stopIsolatedTestDatabase
};
