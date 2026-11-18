const mongoose = require("mongoose");
const { Readable } = require("stream");
const { getGridFSBucket } = require("../config/db");

/**
 * Streams a validated file Buffer into MongoDB Atlas GridFS with strict tenantId metadata ownership.
 * Never stores large Base64 blobs in standard MongoDB documents.
 */
function uploadBufferToGridFS({ buffer, filename, contentType, tenantId, metadata = {} }) {
  return new Promise((resolve, reject) => {
    const resolvedTenantId = tenantId || metadata.tenantId;
    if (!resolvedTenantId) {
      return reject(
        Object.assign(new Error("tenantId is required to store files in GridFS"), {
          statusCode: 400
        })
      );
    }

    let bucket;
    try {
      bucket = getGridFSBucket();
    } catch (err) {
      return reject(err);
    }

    const uploadStream = bucket.openUploadStream(filename, {
      chunkSizeBytes: 255 * 1024,
      contentType,
      metadata: {
        ...metadata,
        tenantId: String(resolvedTenantId),
        uploadedAt: new Date()
      }
    });

    const readable = Readable.from(buffer);

    uploadStream.on("error", (err) => {
      reject(err);
    });

    uploadStream.on("finish", () => {
      resolve({
        gridFsFileId: uploadStream.id,
        filename: uploadStream.filename,
        size: buffer.length,
        contentType,
        tenantId: String(resolvedTenantId)
      });
    });

    readable.pipe(uploadStream);
  });
}

/**
 * Finds a GridFS file document by its ObjectId and enforces exact tenantId ownership when provided.
 */
async function findGridFSFileById(fileId, expectedTenantId = null) {
  if (!fileId || !mongoose.Types.ObjectId.isValid(fileId)) {
    return null;
  }
  const bucket = getGridFSBucket();
  const objectId = new mongoose.Types.ObjectId(fileId);
  const query = { _id: objectId };

  if (expectedTenantId) {
    query["metadata.tenantId"] = String(expectedTenantId);
  }

  const files = await bucket.find(query).limit(1).toArray();
  return files[0] || null;
}

/**
 * Opens a readable download stream from MongoDB Atlas GridFS after verifying tenant ownership.
 */
async function openGridFSDownloadStream(fileId, expectedTenantId = null) {
  const fileDoc = await findGridFSFileById(fileId, expectedTenantId);
  if (!fileDoc) {
    throw Object.assign(new Error("Document file not found in GridFS storage"), {
      statusCode: 404
    });
  }
  const bucket = getGridFSBucket();
  const stream = bucket.openDownloadStream(fileDoc._id);
  return { fileDoc, stream };
}

/**
 * Marks a staged GridFS file as bound to a created print job so it is not purged as an orphan.
 */
async function markGridFSFileBoundToJob(fileId, jobId, expectedTenantId = null) {
  if (!fileId || !mongoose.Types.ObjectId.isValid(fileId)) return;
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return;

  const objectId = new mongoose.Types.ObjectId(fileId);
  const filter = { _id: objectId };
  if (expectedTenantId) {
    filter["metadata.tenantId"] = String(expectedTenantId);
  }

  await mongoose.connection.db.collection("printDocuments.files").updateOne(filter, {
    $set: {
      "metadata.staged": false,
      "metadata.jobId": jobId ? String(jobId) : null,
      "metadata.boundAt": new Date()
    }
  });
}

/**
 * Deletes a file and all of its chunks from MongoDB Atlas GridFS, enforcing tenant ownership if specified.
 * Safe and idempotent if the file was already deleted.
 */
async function deleteGridFSFile(fileId, expectedTenantId = null) {
  if (!fileId || !mongoose.Types.ObjectId.isValid(fileId)) return false;
  try {
    if (expectedTenantId) {
      const existing = await findGridFSFileById(fileId, expectedTenantId);
      if (!existing) return false;
    }
    const bucket = getGridFSBucket();
    const objectId = new mongoose.Types.ObjectId(fileId);
    await bucket.delete(objectId);
    return true;
  } catch (err) {
    if (err && /FileNotFound/i.test(String(err.message))) {
      return false;
    }
    return false;
  }
}

/**
 * Cleans up:
 * 1) Abandoned staged GridFS files that were uploaded for preview/inspection but never submitted as a job.
 * 2) Completed / Cancelled / Failed job files whose configurable retention period has elapsed.
 */
async function cleanupExpiredGridFSFiles(OrderModel) {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return;

  const stagedTtlMinutes = Number(process.env.STAGED_UPLOAD_TTL_MINUTES) || 30;
  const retentionMinutes =
    process.env.FILE_RETENTION_MINUTES !== undefined
      ? Number(process.env.FILE_RETENTION_MINUTES)
      : 60;

  const stagedCutoff = new Date(Date.now() - stagedTtlMinutes * 60 * 1000);
  const filesColl = mongoose.connection.db.collection("printDocuments.files");

  // 1. Delete orphaned staged files older than stagedTtlMinutes
  const orphanedStaged = await filesColl
    .find({
      "metadata.staged": true,
      uploadDate: { $lt: stagedCutoff }
    })
    .project({ _id: 1 })
    .limit(50)
    .toArray();

  for (const doc of orphanedStaged) {
    await deleteGridFSFile(doc._id);
  }

  // 2. Delete GridFS files for completed/cancelled jobs past retention period
  if (OrderModel && Number.isFinite(retentionMinutes) && retentionMinutes >= 0) {
    const retentionCutoff = new Date(Date.now() - retentionMinutes * 60 * 1000);
    const expiredOrders = await OrderModel.find({
      status: { $in: ["COMPLETED", "CANCELLED"] },
      fileDeleted: { $ne: true },
      gridFsFileId: { $ne: null },
      updatedAt: { $lte: retentionCutoff }
    })
      .select("_id gridFsFileId tenantId")
      .limit(50);

    for (const order of expiredOrders) {
      await deleteGridFSFile(order.gridFsFileId, order.tenantId);
      order.fileDeleted = true;
      await order.save();
    }
  }
}

module.exports = {
  uploadBufferToGridFS,
  findGridFSFileById,
  openGridFSDownloadStream,
  markGridFSFileBoundToJob,
  deleteGridFSFile,
  cleanupExpiredGridFSFiles
};
