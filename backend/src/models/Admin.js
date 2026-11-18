const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["OWNER", "STAFF"], default: "OWNER" },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("Admin", adminSchema);
