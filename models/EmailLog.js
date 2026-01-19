const mongoose = require("mongoose");

const EmailLogSchema = new mongoose.Schema({
  email: String,
  status: String,

  subStatus: { type: String, default: null },      
  confidence: { type: Number, min: 0, max: 1, default: null }, 
  category: { type: String, enum: ["valid","invalid","risky","unknown"], default: "unknown" },
  message: { type: String, default: null },         
  reason:  { type: String, default: null },
  section: { type: String, enum: ["single", "bulk"], default: null },

  domain: String,
  domainProvider: String,
  isDisposable: Boolean,
  isFree: Boolean,
  isRoleBased: Boolean,
  score: Number,
  timestamp: Date,
  expiresAt: Date
}, { timestamps: true });

EmailLogSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model("EmailLog", EmailLogSchema);
