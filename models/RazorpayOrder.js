// models/RazorpayOrder.js
const mongoose = require("mongoose");

const razorpayOrderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true, index: true },

    // credits purchase intent
    credits: { type: Number, required: true },
amountMinor: { type: Number, required: true },      // ✅ NEW (use this everywhere going forward)
amountPaise: { type: Number, required: false },     // ✅ keep for old records (not required anymore)

currency: { type: String, default: "USD" },         // ✅ default USD now

    // Razorpay identifiers
    razorpayOrderId: { type: String, required: true, unique: true, index: true },
    razorpayPaymentId: { type: String, default: null, index: true },

    // status machine
    status: {
      type: String,
      enum: ["created", "paid_pending", "captured", "failed", "credited", "refunded"],
      default: "created",
      index: true,
    },

    signatureVerified: { type: Boolean, default: false },
    creditedAt: { type: Date, default: null },

    // optional metadata
    notes: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RazorpayOrder", razorpayOrderSchema);
