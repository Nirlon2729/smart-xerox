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
