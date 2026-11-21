const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const { recordAuditLog } = require("../utils/auditLogger");
const { findGridFSFileById, deleteGridFSFile } = require("./gridfsService");

// Hard-enforced 48-hour retention policy for customer-uploaded print documents.
// Customers and vendors cannot override this policy.
const RETENTION_HOURS = 48;
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Hourly automatic sweep
const CLAIM_LEASE_MS = 5 * 60 * 1000; // 5-minute atomic claim lock across instances

const EXPIRED_DOCUMENT_MESSAGE =
  "This uploaded document has expired and was automatically deleted after 48 hours.";

// Printing safety: never delete a document referenced by any job in these states
const ACTIVE_PROTECTED_STATUSES = [
  "UPLOADING",
  "QUEUED",
  "DOWNLOADING",
  "PROCESSING",
  "PRINTING"
];

let cleanupTimer = null;
let initialStartupTimer = null;
let sweepInFlight = false;

/**
 * Resolves the authoritative original upload timestamp for a document:
 * prefers GridFS uploadDate / metadata.uploadedAt, then order.documentUploadedAt, then order.createdAt.
 */
function resolveOriginalUploadTime(order, gridFsDoc) {
  if (gridFsDoc?.uploadDate) return new Date(gridFsDoc.uploadDate);
  if (gridFsDoc?.metadata?.uploadedAt) return new Date(gridFsDoc.metadata.uploadedAt);
  if (order?.documentUploadedAt) return new Date(order.documentUploadedAt);
  if (order?.createdAt) return new Date(order.createdAt);
  return new Date();
}

/**
 * Runs a single tenant-aware, atomic, idempotent 48-hour customer document cleanup sweep.
 *
 * Guarantees:
 * - Deletes GridFS file + all associated chunks only when original upload age >= 48 hours.
 * - Never deletes while ANY order for that tenant referencing the file is UPLOADING, QUEUED,
 *   DOWNLOADING, PROCESSING, or PRINTING (marks cleanupEligible = true instead and retries later).
 * - Preserves full Order history, pickupCode, pricingSnapshot, printConfigSnapshot, and audit logs.
 * - Removes GridFS references (gridFsFileId = null, storedFileName = null) and sets documentStatus = "EXPIRED".
 * - Safe for concurrent multi-instance execution via atomic claim locks.
 * - Never deletes vendor/unrelated files.
 */
async function runDocumentCleanupSweep(options = {}) {
  const {
    now = new Date(),
    tenantId = null,
    workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    batchSize = 100,
    deleteFn = deleteGridFSFile
  } = options;

  const summary = {
    workerId,
    startedAt: now.toISOString(),
    checkedOrders: 0,
    deletedOrderFiles: 0,
    deferredActiveOrders: 0,
    deletedOrphanFiles: 0,
    errors: 0
  };

  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return summary;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const cutoffDate = new Date(nowDate.getTime() - RETENTION_MS);
  const lockExpiryCutoff = new Date(nowDate.getTime() - CLAIM_LEASE_MS);

  // 1. Find candidate orders whose document has reached 48h (or was previously deferred as cleanupEligible)
  const baseQuery = {
    fileDeleted: { $ne: true },
    gridFsFileId: { $ne: null },
    documentStatus: { $nin: ["EXPIRED", "DELETED"] },
    $and: [
      {
        $or: [
          { cleanupEligible: true },
          { documentUploadedAt: { $lte: cutoffDate } },
          { documentUploadedAt: null, createdAt: { $lte: cutoffDate } }
        ]
      },
      {
        $or: [
          { cleanupClaimedAt: null },
          { cleanupClaimedAt: { $lte: lockExpiryCutoff } }
        ]
      }
    ]
  };

  if (tenantId) {
    baseQuery.tenantId = mongoose.Types.ObjectId.isValid(tenantId)
      ? new mongoose.Types.ObjectId(tenantId)
      : tenantId;
  }

  const candidates = await Order.find(baseQuery)
    .select("_id tenantId gridFsFileId token status documentUploadedAt createdAt cleanupEligible")
    .sort({ documentUploadedAt: 1, createdAt: 1 })
    .limit(batchSize)
    .lean();

  for (const candidate of candidates) {
    // Atomically claim this order so concurrent backend instances cannot double-process it
    const claimed = await Order.findOneAndUpdate(
      {
        _id: candidate._id,
        tenantId: candidate.tenantId,
        fileDeleted: { $ne: true },
        gridFsFileId: candidate.gridFsFileId,
        $or: [
          { cleanupClaimedAt: null },
          { cleanupClaimedAt: { $lte: lockExpiryCutoff } }
        ]
      },
      {
        $set: {
          cleanupClaimedAt: nowDate,
          cleanupClaimedBy: workerId
        }
      },
      { new: true }
    );

    if (!claimed) {
      continue;
    }

    summary.checkedOrders += 1;

    try {
      const targetFileId = claimed.gridFsFileId;
      const targetTenantId = claimed.tenantId;

      const gridFsDoc = await findGridFSFileById(targetFileId, targetTenantId);

      // Never delete non-customer / vendor files
      if (gridFsDoc?.metadata?.category === "vendor") {
        await Order.updateOne(
          { _id: claimed._id, cleanupClaimedBy: workerId },
          { $set: { cleanupClaimedAt: null, cleanupClaimedBy: null, cleanupEligible: false } }
        );
        continue;
      }

      const originalUploadedAt = resolveOriginalUploadTime(claimed, gridFsDoc);

      // Retain files strictly younger than 48 hours
      if (originalUploadedAt.getTime() > cutoffDate.getTime()) {
        await Order.updateOne(
          { _id: claimed._id, cleanupClaimedBy: workerId },
          {
            $set: {
              documentUploadedAt: originalUploadedAt,
              cleanupEligible: false,
              cleanupClaimedAt: null,
              cleanupClaimedBy: null
            }
          }
        );
        continue;
      }

      // Printing safety check across ALL orders in this tenant referencing this GridFS file
      const hasActiveReference = await Order.exists({
        tenantId: targetTenantId,
        gridFsFileId: targetFileId,
        status: { $in: ACTIVE_PROTECTED_STATUSES }
      });

      if (hasActiveReference) {
        // Defer safely until active print/download/pending job finishes
        await Order.updateMany(
          {
            tenantId: targetTenantId,
            gridFsFileId: targetFileId,
            fileDeleted: { $ne: true }
          },
          {
            $set: {
              cleanupEligible: true,
              documentUploadedAt: originalUploadedAt,
              cleanupClaimedAt: null,
              cleanupClaimedBy: null
            }
          }
        );
        summary.deferredActiveOrders += 1;
        continue;
      }

      // Safe to delete: remove GridFS file + all chunks strictly verifying tenantId ownership
      if (gridFsDoc) {
        await deleteFn(targetFileId, targetTenantId, { throwOnError: true });
      }

      // Preserve order history, pickupCode, pricingSnapshot, printConfigSnapshot;
      // remove only file references and mark documentStatus = EXPIRED.
      await Order.updateMany(
        {
          tenantId: targetTenantId,
          gridFsFileId: targetFileId
        },
        {
          $set: {
            fileDeleted: true,
            documentStatus: "EXPIRED",
            documentDeletedAt: nowDate,
            documentUploadedAt: originalUploadedAt,
            gridFsFileId: null,
            storedFileName: null,
            cleanupEligible: false,
            cleanupClaimedAt: null,
            cleanupClaimedBy: null,
            "printConfigSnapshot.documentId": null
          }
        }
      );

      await recordAuditLog({
        tenantId: targetTenantId,
        actorType: "SYSTEM",
        actorId: "document-cleanup-48h",
        action: "CUSTOMER_DOCUMENT_EXPIRED_CLEANUP",
        targetType: "Order",
        targetId: claimed._id,
        details: {
          token: claimed.token,
          originalUploadedAt: originalUploadedAt.toISOString(),
          retentionHours: RETENTION_HOURS
        }
      });

      summary.deletedOrderFiles += 1;
    } catch (err) {
      summary.errors += 1;
      // Release atomic claim so next hourly sweep retries cleanly
      await Order.updateOne(
        { _id: claimed._id, cleanupClaimedBy: workerId },
        {
          $set: {
            cleanupEligible: true,
            cleanupClaimedAt: null,
            cleanupClaimedBy: null
          }
        }
      ).catch(() => {});
      console.error(
        `[DocumentCleanup] Failed to clean order ${claimed._id}: ${err.message}`
      );
    }
  }

  // 2. Clean up orphaned customer GridFS files >= 48 hours old with no active order references
  try {
    const filesColl = mongoose.connection.db.collection("printDocuments.files");
    const orphanQuery = {
      uploadDate: { $lte: cutoffDate },
      "metadata.tenantId": { $exists: true, $ne: null },
      "metadata.category": { $ne: "vendor" },
      $or: [
        { "metadata.cleanupClaimedAt": { $exists: false } },
        { "metadata.cleanupClaimedAt": null },
        { "metadata.cleanupClaimedAt": { $lte: lockExpiryCutoff } }
      ]
    };

    if (tenantId) {
      orphanQuery["metadata.tenantId"] = String(tenantId);
    }

    const orphanFiles = await filesColl
      .find(orphanQuery)
      .project({ _id: 1, "metadata.tenantId": 1, uploadDate: 1 })
      .limit(batchSize)
      .toArray();

    for (const fileDoc of orphanFiles) {
      const fileTenantId = fileDoc.metadata?.tenantId;
      if (!fileTenantId) continue;

      const claimResult = await filesColl.updateOne(
        {
          _id: fileDoc._id,
          "metadata.tenantId": String(fileTenantId),
          $or: [
            { "metadata.cleanupClaimedAt": { $exists: false } },
            { "metadata.cleanupClaimedAt": null },
            { "metadata.cleanupClaimedAt": { $lte: lockExpiryCutoff } }
          ]
        },
        {
          $set: {
            "metadata.cleanupClaimedAt": nowDate,
            "metadata.cleanupClaimedBy": workerId
          }
        }
      );

      if (!claimResult.modifiedCount) continue;

      try {
        // Step 2 cleans ONLY unbound/orphaned GridFS files; order-bound files are managed by Step 1.
        const anyBoundOrder = await Order.exists({
          tenantId: mongoose.Types.ObjectId.isValid(fileTenantId)
            ? new mongoose.Types.ObjectId(fileTenantId)
            : fileTenantId,
          gridFsFileId: fileDoc._id
        });

        if (anyBoundOrder) {
          await filesColl.updateOne(
            { _id: fileDoc._id },
            { $set: { "metadata.cleanupClaimedAt": null, "metadata.cleanupClaimedBy": null } }
          );
          continue;
        }

        await deleteFn(fileDoc._id, fileTenantId, { throwOnError: true });

        await Order.updateMany(
          {
            tenantId: mongoose.Types.ObjectId.isValid(fileTenantId)
              ? new mongoose.Types.ObjectId(fileTenantId)
              : fileTenantId,
            gridFsFileId: fileDoc._id
          },
          {
            $set: {
              fileDeleted: true,
              documentStatus: "EXPIRED",
              documentDeletedAt: nowDate,
              gridFsFileId: null,
              storedFileName: null,
              cleanupEligible: false,
              "printConfigSnapshot.documentId": null
            }
          }
        );

        await recordAuditLog({
          tenantId: mongoose.Types.ObjectId.isValid(fileTenantId)
            ? new mongoose.Types.ObjectId(fileTenantId)
            : null,
          actorType: "SYSTEM",
          actorId: "document-cleanup-48h",
          action: "ORPHAN_CUSTOMER_DOCUMENT_EXPIRED_CLEANUP",
          targetType: "GridFSFile",
          targetId: String(fileDoc._id),
          details: {
            uploadDate: fileDoc.uploadDate ? new Date(fileDoc.uploadDate).toISOString() : null,
            retentionHours: RETENTION_HOURS
          }
        });

        summary.deletedOrphanFiles += 1;
      } catch (orphanErr) {
        summary.errors += 1;
        await filesColl
          .updateOne(
            { _id: fileDoc._id },
            { $set: { "metadata.cleanupClaimedAt": null, "metadata.cleanupClaimedBy": null } }
          )
          .catch(() => {});
        console.error(
          `[DocumentCleanup] Failed to clean orphan file ${fileDoc._id}: ${orphanErr.message}`
        );
      }
    }
  } catch (err) {
    summary.errors += 1;
    console.error(`[DocumentCleanup] Orphan sweep error: ${err.message}`);
  }

  return summary;
}

/**
 * Starts the automatic hourly 48-hour document cleanup scheduler with an initial
 * non-blocking startup sweep.
 */
function startDocumentCleanupScheduler(options = {}) {
  const {
    intervalMs = CLEANUP_INTERVAL_MS,
    initialDelayMs = 5000
  } = options;

  stopDocumentCleanupScheduler();

  const executeSafeSweep = async (trigger) => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      const result = await runDocumentCleanupSweep();
      if (
        result.deletedOrderFiles > 0 ||
        result.deletedOrphanFiles > 0 ||
        result.deferredActiveOrders > 0 ||
        result.errors > 0
      ) {
        console.log(
          `[DocumentCleanup:${trigger}] deletedOrders=${result.deletedOrderFiles} ` +
            `deletedOrphans=${result.deletedOrphanFiles} deferredActive=${result.deferredActiveOrders} ` +
            `errors=${result.errors}`
        );
      }
    } catch (err) {
      console.error(`[DocumentCleanup:${trigger}] Sweep error: ${err.message}`);
    } finally {
      sweepInFlight = false;
    }
  };

  initialStartupTimer = setTimeout(() => {
    executeSafeSweep("startup");
  }, initialDelayMs);
  if (typeof initialStartupTimer.unref === "function") {
    initialStartupTimer.unref();
  }

  cleanupTimer = setInterval(() => {
    executeSafeSweep("hourly");
  }, intervalMs);
  if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
  }
}

function stopDocumentCleanupScheduler() {
  if (initialStartupTimer) {
    clearTimeout(initialStartupTimer);
    initialStartupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = {
  RETENTION_HOURS,
  RETENTION_MS,
  CLEANUP_INTERVAL_MS,
  EXPIRED_DOCUMENT_MESSAGE,
  ACTIVE_PROTECTED_STATUSES,
  runDocumentCleanupSweep,
  startDocumentCleanupScheduler,
  stopDocumentCleanupScheduler
};
