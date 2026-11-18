const mongoose = require("mongoose");

let gridFSBucket = null;

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  gridFSBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: "printDocuments"
  });

  // Safely relax legacy single-shop global unique index on agents.deviceId if present
  try {
    const agentsColl = mongoose.connection.db.collection("agents");
    const indexes = await agentsColl.indexes();
    const legacyDeviceIdx = indexes.find(
      (idx) => idx.name === "deviceId_1" && idx.unique === true
    );
    if (legacyDeviceIdx) {
      await agentsColl.dropIndex("deviceId_1");
    }
  } catch (_err) {
    // Collection may not exist yet; safe to ignore
  }

  console.log("MongoDB Atlas connected (GridFS bucket: printDocuments)");
  return mongoose.connection;
}

function getGridFSBucket() {
  if (!gridFSBucket && mongoose.connection.readyState === 1 && mongoose.connection.db) {
    gridFSBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "printDocuments"
    });
  }
  if (!gridFSBucket) {
    throw Object.assign(new Error("MongoDB GridFS bucket is not initialized"), {
      statusCode: 503
    });
  }
  return gridFSBucket;
}

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.getGridFSBucket = getGridFSBucket;
