// models/TrainingSample.js
const mongoose = require("mongoose");

const TrainingSampleSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    domain: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["bouncer", "manual", "other"],
      index: true,
      default: "bouncer",
    },
    provider: {
      type: String,
      default: null,
    },

    // Aggregated counts by label
    // e.g. { valid: 120, invalid: 15, risky: 30, unknown: 10 }
    labelCounts: {
      type: Map,
      of: Number,
      default: {},
    },

    totalSamples: {
      type: Number,
      default: 0,
    },

    lastLabel: {
      type: String,
      enum: ["valid", "invalid", "risky", "unknown"],
      default: "unknown",
    },

    firstSeenAt: {
      type: Date,
      default: Date.now,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// unique per (email, source)
TrainingSampleSchema.index({ email: 1, source: 1 }, { unique: true });

// helpful domain+source index for analytics
TrainingSampleSchema.index({ domain: 1, source: 1 });

module.exports = mongoose.model("TrainingSample", TrainingSampleSchema);
