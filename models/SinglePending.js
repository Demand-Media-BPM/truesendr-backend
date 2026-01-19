// models/SinglePending.js
const mongoose = require("mongoose");

const singlePendingSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, index: true },
    email:    { type: String, required: true },
    idemKey:  { type: String, default: "" }, // X-Idempotency-Key used
    sessionId:{ type: String },              // optional, for WS/debug
    status:   { type: String, default: "in_progress" }, // in_progress | done
  },
  { timestamps: true }
);

// helpful for queries & to ensure uniqueness per user+email if needed
singlePendingSchema.index({ username: 1, email: 1, status: 1 });

module.exports = mongoose.model("SinglePending", singlePendingSchema);
