// models/CreditsLedger.js
const mongoose = require("mongoose");

const creditsLedgerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true, index: true },

    type: { type: String, enum: ["purchase", "refund", "admin_adjustment", "usage"], required: true },
    creditsDelta: { type: Number, required: true },

    refType: { type: String, default: "razorpay" },
    refId: { type: String, default: null }, // paymentId or orderId

    openingBalance: { type: Number, default: null },
    closingBalance: { type: Number, default: null },

    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CreditsLedger", creditsLedgerSchema);
