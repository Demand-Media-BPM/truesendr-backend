// models/ProviderReputation.js
const mongoose = require("mongoose");

const providerReputationSchema = new mongoose.Schema(
  {
    // Normalised provider key, e.g.:
    // "gmail / google workspace", "outlook / microsoft 365",
    // "proofpoint", "mimecast", "barracuda", etc.
    provider: {
      type: String,
      required: true,
      unique: true,
    },

    // How many emails we've *attempted* (or validated) for this provider
    sent: {
      type: Number,
      default: 0,
    },

    // How many of those ended up as invalid / bounced
    invalid: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  "ProviderReputation",
  providerReputationSchema
);
