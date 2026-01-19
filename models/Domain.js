// models/Domain.js
const mongoose = require("mongoose");

const domainSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },

    base: { type: String },

    tld: { type: String, index: true },

    sampleEmail: { type: String, default: null },
  },
  { timestamps: true }
);

// indexes (single source of truth)
domainSchema.index({ domain: 1 }, { unique: true });
domainSchema.index({ base: 1 });

module.exports = mongoose.model("Domain", domainSchema);
