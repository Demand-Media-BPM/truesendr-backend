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
    // ✅ TEMPORARILY DISABLED FOR TESTING - Re-enable in production
    return true;
    
    // Original code (commented out for testing):
    // if (!WEBHOOK_SECRET) return true;
    // const signature = req.headers['x-twilio-email-event-webhook-signature'];
    // const timestamp = req.headers['x-twilio-email-event-webhook-timestamp'];
    // if (!signature || !timestamp) return false;
    // const payload = timestamp + JSON.stringify(req.body);
    // const expectedSignature = crypto
    //   .createHmac('sha256', WEBHOOK_SECRET)
    //   .update(payload)
    //   .digest('base64');
    // return signature === expectedSignature;
  }

  /**
   * POST /api/sendgrid/webhook
   * POST /sendgrid/events (for ngrok local testing)
   * Receives events from SendGrid (bounce, delivered, dropped, etc.)
   */
  const webhookHandler = async (req, res) => {
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
  };

  // Mount on both paths
  router.post('/webhook', express.json(), webhookHandler);
  router.post('/events', express.json(), webhookHandler);

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
      console.warn('⚠️ Webhook event missing email or event type', event);
      return;
    }

    const E = normEmail(email);
    const fullMessageId = sg_message_id || smtp_id || null;
    
    // ✅ Extract base messageId (SendGrid appends extra data in webhooks)
    // Example: "Oc9Vts_KRcK_e-CXI1BmEA.recvd-7bd9484584-qt86v-1-698B2E9F-D.0"
    // We need: "Oc9Vts_KRcK_e-CXI1BmEA"
    const messageId = fullMessageId ? fullMessageId.split('.')[0] : null;

    console.log(`📬 [SendGrid Webhook] Processing ${eventType} event for ${E} (messageId: ${messageId}, fullMessageId: ${fullMessageId}, reason: ${reason || 'N/A'})`);

    // ✅ Find pending email by base messageId
    const SendGridPending = mongoose.model('SendGridPending');
    const pending = await SendGridPending.findOne({ messageId });

    if (!pending) {
      console.log(`ℹ️ [SendGrid Webhook] No pending record found for messageId: ${messageId}, email: ${E}, event: ${eventType} - may be already processed or non-pending email`);
      // Still update SendGridLog if exists
      if (messageId) {
        try {
          await SendGridLog.findOneAndUpdate(
            { messageId },
            {
              $set: {
                webhookEvent: eventType,
                webhookTimestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
                webhookReason: reason,
                webhookType: type,
                webhookResponse: response,
                webhookStatus: status,
                webhookAttempt: attempt,
              }
            }
          );
        } catch (e) {
          console.warn('SendGridLog update failed:', e.message);
        }
      }
      return;
    }

    // Determine final status based on event type
    let finalStatus = null;
    let finalSubStatus = null;
    let finalCategory = null;
    let confidence = 0.5;
    let shouldSaveToEmailLog = false;

    switch (eventType) {
      case 'delivered':
        finalStatus = '✅ Valid Email (SendGrid)';
        finalSubStatus = 'sendgrid_delivered';
        finalCategory = 'valid';
        confidence = 0.95;
        shouldSaveToEmailLog = true;
        break;

      case 'bounce':
        finalStatus = '❌ Invalid Email (SendGrid)';
        finalSubStatus = type === 'soft' ? 'sendgrid_soft_bounce' : 'sendgrid_hard_bounce';
        finalCategory = 'invalid';
        confidence = type === 'soft' ? 0.75 : 0.98;
        shouldSaveToEmailLog = true;
        break;

      case 'dropped':
        finalStatus = '❌ Invalid Email (SendGrid)';
        finalSubStatus = 'sendgrid_dropped';
        finalCategory = 'invalid';
        confidence = 0.90;
        shouldSaveToEmailLog = true;
        break;

      case 'deferred':
        finalStatus = '❌ Invalid Email (SendGrid)';
        finalSubStatus = 'sendgrid_deferred';
        finalCategory = 'invalid';
        confidence = 0.85;
        shouldSaveToEmailLog = true;
        break;

      case 'processed':
        // Processed is not final - wait for delivered/bounce
        console.log(`ℹ️ Processed event for ${E} - waiting for final delivery status`);
        return;

      case 'open':
      case 'click':
        // Strong signal - email was delivered
        finalStatus = '✅ Valid Email (SendGrid)';
        finalSubStatus = 'sendgrid_engaged';
        finalCategory = 'valid';
        confidence = 0.99;
        shouldSaveToEmailLog = true;
        break;

      case 'spamreport':
        finalStatus = '⚠️ Risky (SendGrid)';
        finalSubStatus = 'sendgrid_spam_report';
        finalCategory = 'risky';
        confidence = 0.85;
        shouldSaveToEmailLog = true;
        break;

      case 'unsubscribe':
        finalStatus = '✅ Valid Email (SendGrid)';
        finalSubStatus = 'sendgrid_unsubscribed';
        finalCategory = 'valid';
        confidence = 0.95;
        shouldSaveToEmailLog = true;
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${eventType} - ignoring`);
        return;
    }

    if (!shouldSaveToEmailLog) return;

    // Build final payload
    const built = buildReasonAndMessage(finalStatus, finalSubStatus, {
      isDisposable: false,
      isRoleBased: false,
      isFree: false,
    });

    const finalPayload = {
      email: E,
      status: finalStatus,
      subStatus: finalSubStatus,
      confidence,
      category: finalCategory,
      reason: reason || built.reasonLabel,
      message: `SendGrid ${eventType}: ${reason || built.message}`,
      domain: pending.domain || (E.includes('@') ? E.split('@')[1] : 'N/A'),
      domainProvider: pending.provider || 'Proofpoint Email Protection (via SendGrid)',
      isDisposable: false,
      isFree: false,
      isRoleBased: false,
      score: finalCategory === 'valid' ? 90 : finalCategory === 'invalid' ? 5 : 45,
      timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
      section: 'single',
    };

    // Save to global EmailLog
    await replaceLatest(EmailLog, E, finalPayload);

    // Save to user EmailLog
    const { EmailLog: UserEmailLog } = getUserDb(
      mongoose,
      EmailLog,
      deps.RegionStat,
      deps.DomainReputation,
      pending.username
    );
    await replaceLatest(UserEmailLog, E, finalPayload);

    // Debit credit now (was not debited when email was sent)
    await deps.debitOneCreditIfNeeded(
      pending.username,
      finalStatus,
      E,
      pending.idemKey,
      'single'
    );

    // Send WebSocket notification
    if (pending.sessionId) {
      sendStatusToFrontend(
        E,
        finalPayload.status,
        finalPayload.timestamp,
        {
          domain: finalPayload.domain,
          provider: finalPayload.domainProvider,
          isDisposable: finalPayload.isDisposable,
          isFree: finalPayload.isFree,
          isRoleBased: finalPayload.isRoleBased,
          score: finalPayload.score,
          subStatus: finalPayload.subStatus,
          confidence: finalPayload.confidence,
          category: finalPayload.category,
          message: finalPayload.message,
          reason: finalPayload.reason,
        },
        pending.sessionId,
        true,
        pending.username,
        'single'
      );
    }

    // Update SendGridLog with webhook data
    if (messageId) {
      try {
        await SendGridLog.findOneAndUpdate(
          { messageId },
          {
            $set: {
              webhookEvent: eventType,
              webhookTimestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
              webhookReason: reason,
              webhookType: type,
              webhookResponse: response,
              webhookStatus: status,
              webhookAttempt: attempt,
              finalCategory: finalCategory,
              finalStatus: finalStatus,
            }
          }
        );
      } catch (e) {
        console.warn('SendGridLog update failed:', e.message);
      }
    }

    // Delete from SendGridPending
    await SendGridPending.deleteOne({ _id: pending._id });

    console.log(`✅ [SendGrid Webhook] Successfully processed: ${E} -> ${finalStatus} (${finalCategory}, event: ${eventType}, reason: ${reason || 'N/A'})`);
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
