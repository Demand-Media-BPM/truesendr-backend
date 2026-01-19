// models/Finder.js
const mongoose = require("mongoose");

const finderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },

    // Raw input for UX/debug
    nameInput: { type: String, required: true, trim: true },

    // Normalized split name used for cache lookups
    first: { type: String, required: true, trim: true },
    last: { type: String, required: true, trim: true },

    // Domain & chosen result (always stored lowercase)
    domain: {
      type: String,
      required: true,
      trim: true,
      set: (v) => String(v || "").toLowerCase(),
    },

    // NEW: async job state
    state: {
      type: String,
      enum: ["running", "done", "error"],
      default: "running",
      index: true,
    },

    email: {
      type: String,
      trim: true,
      set: (v) => (v == null ? v : String(v).toLowerCase()),
    },

    status: {
      type: String,
      enum: ["Valid", "Risky", "Invalid", "Unknown"],
      default: "Unknown",
      index: true,
    },

    confidence: { type: String, enum: ["High", "Med", "Low"], default: "Low" },
    reason: { type: String, trim: true },

    // NEW: store errors if job fails
    error: { type: String, trim: true },
  },
  { timestamps: true, strict: true }
);

// Keep your cache uniqueness (prevents duplicate cache rows)
finderSchema.index(
  { userId: 1, domain: 1, first: 1, last: 1 },
  { unique: true, name: "uniq_user_domain_first_last" }
);

finderSchema.index({ userId: 1, email: 1 });
finderSchema.index({ userId: 1, createdAt: -1 });
finderSchema.index({ userId: 1, state: 1, createdAt: -1 });

module.exports = mongoose.model("Finder", finderSchema);
