// models/BounceLog.js

const mongoose = require("mongoose");

const bounceLogSchema = new mongoose.Schema({
  email: { type: String, required: true },
  region: { type: String, required: true },
  reason: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("BounceLog", bounceLogSchema);
