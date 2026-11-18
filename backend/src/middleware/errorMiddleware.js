const multer = require("multer");

function notFound(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

function errorHandler(error, _req, res, _next) {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      const maxMb = Number(process.env.MAX_UPLOAD_MB) || 20;
      return res.status(413).json({
        success: false,
        message: `File is too large. Maximum allowed file size is ${maxMb} MB.`
      });
    }
    return res.status(400).json({
      success: false,
      message: error.message || "File upload error"
    });
  }

  const status = error.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? "Internal server error" : error.message
  });
}

module.exports = { notFound, errorHandler };
