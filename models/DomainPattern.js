// models/DomainPattern.js
const mongoose = require("mongoose");

const domainPatternSchema = new mongoose.Schema(
  {
    // lowercased domain, unique
    domain: { type: String, required: true, unique: true },

    attempts: { type: Number, default: 0 },

    patterns: [
      {
        code: { type: String, required: true },
        success: { type: Number, default: 0 },
        lastSuccessAt: { type: Date, default: null },
      },
    ],

    primary: { type: String, default: null },
  },
  { timestamps: true, collection: "domain_patterns" }
);

module.exports = mongoose.model("DomainPattern", domainPatternSchema);
