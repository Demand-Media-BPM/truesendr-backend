// // models/PasswordResetToken.js
// const mongoose = require("mongoose");

// const passwordResetTokenSchema = new mongoose.Schema(
//   {
//     email:     { type: String, required: true, lowercase: true, trim: true, index: true },
//     tokenHash: { type: String, required: true },
//     // TTL: document will expire automatically at this time
//     expiresAt: { type: Date, index: { expires: 0 } },
//     used:      { type: Boolean, default: false },
//   },
//   { timestamps: true }
// );

// passwordResetTokenSchema.index({ email: 1 });

// module.exports = mongoose.model("PasswordResetToken", passwordResetTokenSchema);


// models/PasswordResetToken.js
const mongoose = require("mongoose");

const passwordResetTokenSchema = new mongoose.Schema(
  {
    email:     { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true },

    // TTL: document will expire automatically at this time
    expiresAt: { type: Date, required: true },

    used:      { type: Boolean, default: false },
  },
  { timestamps: true }
);

// indexes (single source of truth)
passwordResetTokenSchema.index({ email: 1 });
// TTL: expire exactly at expiresAt time
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PasswordResetToken", passwordResetTokenSchema);
