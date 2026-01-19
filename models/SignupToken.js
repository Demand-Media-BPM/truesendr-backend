// models/SignupToken.js
const mongoose = require("mongoose");

const signupTokenSchema = new mongoose.Schema(
  {
    email: { type: String, index: true, required: true, lowercase: true, trim: true },
    username: { type: String, required: true, trim: true },
    firstName: String,
    lastName: String,

    passwordHash: String,
    codeHash: String,

    attempts: { type: Number, default: 0 },
    resendCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: Date.now },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);


signupTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("SignupToken", signupTokenSchema);
