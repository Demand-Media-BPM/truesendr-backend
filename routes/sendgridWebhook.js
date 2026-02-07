// backend/routes/sendgridWebhook.js
// ============================================================================
// SENDGRID WEBHOOK HANDLER
// Processes bounce, delivery, and other email events from SendGrid
// ============================================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

module.exports = function sendgridWebhookRouter(deps) {
  const {
    mongoose,
    EmailLog,
    User,
    normEmail,
    buildReasonAndMessage,
    getUserDb,
    replaceLatest,
    sendStatusToFrontend,
  } = deps;

  const SendGridLog = require('../models/SendGridLog');

  // Webhook secret for verification (optional but recommended)
  const WEBHOOK_SECRET = process.env.SENDGRID_WEBHOOK_SECRET || '';

  /**
   * Verify SendGrid webhook signature
   * @param {object} req - Express request object
   * @returns {boolean} - True if signature is valid
   */
  function verifyWebhookSignature(req) {
    if (!WEBHOOK_SECRET) return true; // Skip verification if no secret configured

    const signature = req.headers['x-twilio-email-event-webhook-signature'];
    const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];

    if (!signature || !timestamp) return false;

    const payload = timestamp + JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(payload)
      .digest('base64');

    return signature === expectedSignature;
  }

  /**
   * POST /api/sendgrid/webhook
   * Receives events from SendGrid (bounce, delivered, dropped, etc.)
   */
  router.post('/webhook', express.json(), async (req, res) => {
    try {
      // Verify webhook signature
      if (!verifyWebhookSignature(req)) {
        console.warn('⚠️ SendGrid webhook signature verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      const events = Array.isArray(req.body) ? req.body : [req.body];
      console.log(`📨 Received ${events.length} SendGrid webhook event(s)`);

      for (const event of events) {
        try {
          await processWebhookEvent(event);
        } catch (err) {
          console.error('❌ Error processing webhook event:', err.message);
          // Continue processing other events even if one fails
        }
      }

      res.status(200).json({ received: true, count: events.length });
    } catch (err) {
      console.error('❌ SendGrid webhook error:', err.message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  /**
   * Process individual webhook event
   * @param {object} event - SendGrid event data
   */
  async function processWebhookEvent(event) {
    const {
      event: eventType,
      email,
      timestamp,
      reason,
      type,
      sg_message_id,
      smtp_id,
      response,
      status,
      attempt,
    } = event;

    if (!email || !eventType) {
      console.warn('⚠️ Webhook event missing email or event type');
      return;
    }

    const E = normEmail(email);
    const messageId = sg_message_id || smtp_id || null;

    console.log(`📬 Processing ${eventType} event for ${E}`);

    // Update SendGridLog with webhook data
    if (messageId) {
      await SendGridLog.updateWithWebhook(messageId, {
        event: eventType,
        timestamp,
        reason,
        type,
        response,
        status,
        attempt,
      });
    }

    // Determine new status based on event type
    let newStatus = null;
    let newSubStatus = null;
    let newCategory = null;
    let confidence = 0.5;

    switch (eventType) {
      case 'delivered':
        newStatus = 'deliverable';
        newSubStatus = 'sendgrid_delivered';
        newCategory = 'valid';
        confidence = 0.95;
        break;

      case 'bounce':
        newStatus = 'undeliverable';
        newSubStatus = type === 'soft' ? 'sendgrid_soft_bounce' : 'sendgrid_hard_bounce';
        newCategory = 'invalid';
        confidence = type === 'soft' ? 0.75 : 0.98;
        break;

      case 'dropped':
        newStatus = 'undeliverable';
        newSubStatus = 'sendgrid_dropped';
        newCategory = 'invalid';
        confidence = 0.90;
        break;

      case 'deferred':
        newStatus = 'risky';
        newSubStatus = 'sendgrid_deferred';
        newCategory = 'risky';
        confidence = 0.60;
        break;

      case 'processed':
        // Email accepted by SendGrid but not yet delivered
        newStatus = 'deliverable';
        newSubStatus = 'sendgrid_processed';
        newCategory = 'valid';
        confidence = 0.70;
        break;

      case 'open':
      case 'click':
        // Strong signal that email was delivered and mailbox is active
        newStatus = 'deliverable';
        newSubStatus = 'sendgrid_engaged';
        newCategory = 'valid';
        confidence = 0.99;
        break;

      case 'spamreport':
        newStatus = 'risky';
        newSubStatus = 'sendgrid_spam_report';
        newCategory = 'risky';
        confidence = 0.85;
        break;

      case 'unsubscribe':
        // Email was delivered (mailbox exists) but user unsubscribed
        newStatus = 'deliverable';
        newSubStatus = 'sendgrid_unsubscribed';
        newCategory = 'valid';
        confidence = 0.95;
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${eventType}`);
        return;
    }

    if (!newStatus) return;

    // Build reason message
    const built = buildReasonAndMessage(
      newStatus === 'deliverable' ? '✅ Valid Email' :
      newStatus === 'undeliverable' ? '❌ Invalid Email' :
      '⚠️ Risky',
      newSubStatus,
      { isDisposable: false, isRoleBased: false, isFree: false }
    );

    const payload = {
      email: E,
      status: newStatus === 'deliverable' ? '✅ Valid Email (SendGrid)' :
              newStatus === 'undeliverable' ? '❌ Invalid Email (SendGrid)' :
              '⚠️ Risky (SendGrid)',
      subStatus: newSubStatus,
      confidence,
      category: newCategory,
      reason: `SendGrid ${eventType}: ${reason || built.reasonLabel}`,
      message: built.message,
      domain: E.includes('@') ? E.split('@')[1] : 'N/A',
      domainProvider: 'Proofpoint Email Protection (via SendGrid)',
      isDisposable: false,
      isFree: false,
      isRoleBased: false,
      score: newCategory === 'valid' ? 90 : newCategory === 'invalid' ? 5 : 45,
      timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
      section: 'single',
    };

    // Update global EmailLog
    await replaceLatest(EmailLog, E, payload);

    // Try to find which user this email belongs to (check SendGridLog)
    const sgLog = await SendGridLog.findOne({ email: E }).sort({ createdAt: -1 });
    if (sgLog && sgLog.username) {
      const { EmailLog: UserEmailLog } = getUserDb(
        mongoose,
        EmailLog,
        deps.RegionStat,
        deps.DomainReputation,
        sgLog.username
      );
      await replaceLatest(UserEmailLog, E, payload);

      // Send WebSocket update if we have session info
      if (sgLog.sessionId) {
        sendStatusToFrontend(
          E,
          payload.status,
          payload.timestamp,
          {
            domain: payload.domain,
            provider: payload.domainProvider,
            isDisposable: payload.isDisposable,
            isFree: payload.isFree,
            isRoleBased: payload.isRoleBased,
            score: payload.score,
            subStatus: payload.subStatus,
            confidence: payload.confidence,
            category: payload.category,
            message: payload.message,
            reason: payload.reason,
          },
          sgLog.sessionId,
          true,
          sgLog.username
        );
      }
    }

    console.log(`✅ Processed ${eventType} for ${E}: ${newCategory}`);
  }

  /**
   * GET /api/sendgrid/stats
   * Get SendGrid verification statistics
   */
  router.get('/stats', async (req, res) => {
    try {
      const { username } = req.query;

      const query = username ? { username } : {};
      const stats = await SendGridLog.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$category',
            count: { $sum: 1 },
            avgConfidence: { $avg: '$confidence' },
            avgScore: { $avg: '$score' },
          },
        },
      ]);

      const result = {
        total: 0,
        valid: 0,
        invalid: 0,
        risky: 0,
        unknown: 0,
        avgConfidence: 0,
        avgScore: 0,
      };

      stats.forEach((s) => {
        result.total += s.count;
        result[s._id] = s.count;
        result.avgConfidence += s.avgConfidence * s.count;
        result.avgScore += s.avgScore * s.count;
      });

      if (result.total > 0) {
        result.avgConfidence /= result.total;
        result.avgScore /= result.total;
      }

      res.json(result);
    } catch (err) {
      console.error('❌ Error fetching SendGrid stats:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/sendgrid/history
   * Get SendGrid verification history
   */
  router.get('/history', async (req, res) => {
    try {
      const { username, limit = 50 } = req.query;

      const query = username ? { username } : {};
      const logs = await SendGridLog.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      res.json({
        success: true,
        count: logs.length,
        data: logs,
      });
    } catch (err) {
      console.error('❌ Error fetching SendGrid history:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
