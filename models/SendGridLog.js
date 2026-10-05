// backend/models/SendGridLog.js
// ============================================================================
// SENDGRID VERIFICATION LOG MODEL
// Tracks all SendGrid verification attempts and results
// ============================================================================

const mongoose = require('mongoose');

const sendGridLogSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  domain: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  status: {
    type: String,
    enum: ['deliverable', 'undeliverable', 'risky', 'unknown'],
    required: true,
    index: true
  },
  sub_status: {
    type: String,
    default: null
  },
  category: {
    type: String,
    enum: ['valid', 'invalid', 'risky', 'unknown'],
    required: true,
    index: true
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.5
  },
  score: {
    type: Number,
    min: 0,
    max: 100,
    default: 50
  },
  reason: {
    type: String,
    default: null
  },
  messageId: {
    type: String,
    default: null
  },
  statusCode: {
    type: Number,
    default: null
  },
  method: {
    type: String,
    enum: ['web_api', 'smtp_relay', 'validation_api', 'skipped'],
    default: 'web_api'
  },
  isProofpoint: {
    type: Boolean,
    default: false,
    index: true
  },
  isFallback: {
    type: Boolean,
    default: false,
    index: true
  },
  smtpCategory: {
    type: String,
    enum: ['valid', 'invalid', 'risky', 'unknown', null],
    default: null
  },
  smtpSubStatus: {
    type: String,
    default: null
  },
  provider: {
    type: String,
    default: 'SendGrid'
  },
  // Webhook tracking
  webhookReceived: {
    type: Boolean,
    default: false
  },
  webhookEvent: {
    type: String,
    enum: ['delivered', 'bounce', 'dropped', 'deferred', 'processed', null],
    default: null
  },
  webhookTimestamp: {
    type: Date,
    default: null
  },
  bounceReason: {
    type: String,
    default: null
  },
  bounceType: {
    type: String,
    enum: ['hard', 'soft', 'block', null],
    default: null
  },
  // Raw webhook event fields (written by sendgridWebhook.js)
  webhookReason: {
    type: String,
    default: null
  },
  webhookType: {
    type: String,
    default: null
  },
  webhookResponse: {
    type: String,
    default: null
  },
  webhookStatus: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  webhookAttempt: {
    type: String,
    default: null
  },
  // Final webhook verdict (written by sendgridWebhook.js on delivered/bounce/etc.)
  // Used by the dedupe layer in sendgridVerifier.js to reuse known results.
  finalStatus: {
    type: String,
    default: null,
    index: true
  }, // 'Valid' | 'Invalid' | 'Risky'
  finalCategory: {
    type: String,
    enum: ['valid', 'invalid', 'risky', null],
    default: null,
    index: true
  },
  finalSubStatus: {
    type: String,
    default: null
  },
  // Metadata
  elapsed_client_ms: {
    type: Number,
    default: null
  },
  elapsed_ms: {
    type: Number,
    default: null
  },
  error: {
    type: String,
    default: null
  },
  username: {
    type: String,
    index: true,
    default: null
  },
  sessionId: {
    type: String,
    index: true,
    default: null
  },
  bulkId: {
    type: String,
    default: null
  },
  // Flags
  isDisposable: {
    type: Boolean,
    default: false
  },
  isFree: {
    type: Boolean,
    default: false
  },
  isRoleBased: {
    type: Boolean,
    default: false
  },
  // Raw response
  rawResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true,
  collection: 'sendgrid_logs'
});

// Indexes for performance
sendGridLogSchema.index({ email: 1, createdAt: -1 });
sendGridLogSchema.index({ domain: 1, category: 1 });
sendGridLogSchema.index({ username: 1, createdAt: -1 });
sendGridLogSchema.index({ messageId: 1 }, { sparse: true });
sendGridLogSchema.index({ bulkId: 1 }, { sparse: true });
sendGridLogSchema.index({ isProofpoint: 1, category: 1 });
sendGridLogSchema.index({ createdAt: -1 });

// Static method: Get recent verification for email
sendGridLogSchema.statics.getRecentVerification = async function(email, maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return await this.findOne({
    email: email.toLowerCase(),
    createdAt: { $gte: cutoff }
  }).sort({ createdAt: -1 });
};

// Static method: Get most recent webhook-FINALIZED verification for an email.
// Used by the SendGrid dedupe layer to reuse a known verdict instead of
// sending a duplicate verification email.
sendGridLogSchema.statics.getRecentFinalVerification = async function(email, maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return await this.findOne({
    email: String(email || '').toLowerCase(),
    finalStatus: { $ne: null },
    finalCategory: { $in: ['valid', 'invalid', 'risky'] },
    createdAt: { $gte: cutoff }
  }).sort({ createdAt: -1 });
};

// Static method: Get most recent send that was ACCEPTED by SendGrid but has
// no final webhook verdict yet (i.e. still in flight).
sendGridLogSchema.statics.getRecentInFlightVerification = async function(email, maxAgeMs = 15 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return await this.findOne({
    email: String(email || '').toLowerCase(),
    messageId: { $ne: null },
    createdAt: { $gte: cutoff }
  }).sort({ createdAt: -1 });
};

// Static method: Get domain statistics
sendGridLogSchema.statics.getDomainStats = async function(domain) {
  const stats = await this.aggregate([
    { $match: { domain: domain.toLowerCase() } },
    {
      $group: {
        _id: '$category',
        count: { $sum: 1 },
        avgConfidence: { $avg: '$confidence' },
        avgScore: { $avg: '$score' }
      }
    }
  ]);

  const result = {
    total: 0,
    valid: 0,
    invalid: 0,
    risky: 0,
    unknown: 0,
    avgConfidence: 0,
    avgScore: 0
  };

  stats.forEach(s => {
    result.total += s.count;
    result[s._id] = s.count;
    result.avgConfidence += s.avgConfidence * s.count;
    result.avgScore += s.avgScore * s.count;
  });

  if (result.total > 0) {
    result.avgConfidence /= result.total;
    result.avgScore /= result.total;
  }

  return result;
};

// Static method: Update with webhook data
sendGridLogSchema.statics.updateWithWebhook = async function(messageId, webhookData) {
  const event = webhookData.event || null;
  const timestamp = webhookData.timestamp ? new Date(webhookData.timestamp * 1000) : new Date();
  
  const update = {
    webhookReceived: true,
    webhookEvent: event,
    webhookTimestamp: timestamp
  };

  // Handle bounce events
  if (event === 'bounce' || event === 'dropped') {
    update.bounceReason = webhookData.reason || null;
    update.bounceType = webhookData.type || 'hard';
    
    // Update status to invalid if bounced
    update.status = 'undeliverable';
    update.category = 'invalid';
    update.sub_status = 'sendgrid_bounced';
    update.confidence = 0.95;
  }

  // Handle delivery
  if (event === 'delivered') {
    update.status = 'deliverable';
    update.category = 'valid';
    update.sub_status = 'sendgrid_delivered';
    update.confidence = 0.95;
  }

  return await this.findOneAndUpdate(
    { messageId },
    { $set: update },
    { new: true }
  );
};

const SendGridLog = mongoose.model('SendGridLog', sendGridLogSchema);

module.exports = SendGridLog;
