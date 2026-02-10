const mongoose = require('mongoose');

const sendGridPendingSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true },
  sessionId: { type: String },
  messageId: { type: String, index: true },
  domain: String,
  provider: String,
  idemKey: String,
  sentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }, // 24 hours
  status: { type: String, default: 'pending' }, // pending, completed, expired
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

// Compound index for efficient queries
sendGridPendingSchema.index({ username: 1, email: 1 });
sendGridPendingSchema.index({ messageId: 1 });
sendGridPendingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

module.exports = mongoose.model('SendGridPending', sendGridPendingSchema);
