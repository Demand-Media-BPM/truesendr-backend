const mongoose = require("mongoose");

const domainReputationSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true },
  sent: { type: Number, default: 0 },
  invalid: { type: Number, default: 0 },
}, {
  timestamps: true
});

module.exports = mongoose.model("DomainReputation", domainReputationSchema);
