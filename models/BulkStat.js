// models/BulkStat.js
const mongoose = require("mongoose");

const BulkStatSchema = new mongoose.Schema(
  {
    // identity
    bulkId: { type: String, index: true, unique: true, required: true },
    username: { type: String, index: true, required: true },
    sessionId: { type: String, default: null, index: true },

    // ─────────────────────────────────────────────
    // Original upload (GridFS)
    // ─────────────────────────────────────────────
    originalName: { type: String, default: "" },
    originalFileId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      default: null,
    },
    originalMime: {
      type: String,
      default:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    originalSize: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // Cleaned file (GridFS) - after /cleanup
    // ─────────────────────────────────────────────
    cleanedFileId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      default: null,
    },
    cleanedMime: {
      type: String,
      default:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    cleanedSize: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // Fix file (GridFS) - invalid format rows after /cleanup
    // used by GET /download-fix
    // ─────────────────────────────────────────────
    fixFileId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      default: null,
    },
    fixMime: {
      type: String,
      default:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    fixSize: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // Result file (GridFS) - after /start
    // ─────────────────────────────────────────────
    resultFileId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
      default: null,
    },
    resultMime: {
      type: String,
      default:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    resultSize: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // Preflight / analysis snapshot
    // ─────────────────────────────────────────────
    emailCol: { type: String, default: null },

    totalRowsWithEmailCell: { type: Number, default: 0 },
    emptyOrJunk: { type: Number, default: 0 },
    invalidFormat: { type: Number, default: 0 },
    duplicates: { type: Number, default: 0 },
    uniqueValid: { type: Number, default: 0 },

    errorsFound: { type: Number, default: 0 },
    cleanupSaves: { type: Number, default: 0 },
    creditsRequired: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // Cleanup stats (after /cleanup)
    // ─────────────────────────────────────────────
    removedDuplicates: { type: Number, default: 0 },
    removedEmptyOrJunk: { type: Number, default: 0 },
    invalidFormatRemaining: { type: Number, default: 0 },
    cleanedRows: { type: Number, default: 0 },
    cleanedAt: { type: Date, default: null },

    // ─────────────────────────────────────────────
    // Live validation counters (updated during /start)
    // ─────────────────────────────────────────────
    progressCurrent: { type: Number, default: 0 },
    progressTotal: { type: Number, default: 0 },
    valid: { type: Number, default: 0 },
    invalid: { type: Number, default: 0 },
    risky: { type: Number, default: 0 },
    unknown: { type: Number, default: 0 },

    // credits used in this run (billableCount)
    creditsUsed: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // State machine (match routes/bulkValidator.js)
    // ─────────────────────────────────────────────
    phase: {
      type: String,
      enum: [
        "analyzed",
        "preflight",
        "cleaning",
        "cleaned",
        "running",
        "done",
        "failed",
        "canceled",
      ],
      default: "analyzed",
    },

    state: {
      type: String,
      enum: [
        "analyzed",
        "needs_cleanup",
        "cleaning",
        "needs_fix",
        "ready",
        "running",
        "done",
        "failed",
        "canceled",
      ],
      default: "analyzed",
      index: true,
    },

    error: { type: String, default: null },

    // timestamps
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Helpful indexes for history/list queries
BulkStatSchema.index({ username: 1, createdAt: -1 });
BulkStatSchema.index({ username: 1, state: 1, createdAt: -1 });

module.exports = mongoose.model("BulkStat", BulkStatSchema);
