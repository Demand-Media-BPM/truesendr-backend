const mongoose = require("mongoose");

const RegionStatsSchema = new mongoose.Schema({
  region: { type: String, required: true },
  sent: { type: Number, default: 0 },
  bounced: { type: Number, default: 0 },
  lastSwitched: { type: Date, default: Date.now }
});

module.exports = mongoose.model("RegionStats", RegionStatsSchema);
