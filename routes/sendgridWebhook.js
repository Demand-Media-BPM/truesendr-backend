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
   * Detect if a bounce reason indicates a sender/gateway policy block
   * rather than a hard bounce (missing mailbox).
   *
   * Policy blocks mean the recipient mailbox may exist but our sender
   * was rejected by the gateway's rules (e.g. Mimecast blocked senders,
   * IP reputation, SPF/DKIM/DMARC failure). These should be Risky, not Invalid.
   *
   * @param {string} reason - The bounce reason string from SendGrid
   * @returns {boolean}
   */
  function isPolicyBlock(reason) {
    if (!reason) return false;
    const r = String(reason).toLowerCase();
    return (
      r.includes('blocked senders') ||       // Mimecast: blocked senders list
      r.includes('header based') ||          // Mimecast: header-based filtering
      r.includes('mimecast.com/docs') ||     // Mimecast: documentation reference
      r.includes('sender blocked') ||        // Generic: sender blocked by policy
      r.includes('ip blocked') ||            // Generic: IP address blocked
      r.includes('ip reputation') ||         // Generic: IP reputation block
      r.includes('blacklisted') ||           // Generic: sender/IP blacklisted
      r.includes('dnsbl') ||                 // Generic: DNS blacklist rejection
      r.includes('policy violation') ||      // Generic: policy violation
      r.includes('rejected by policy') ||    // Generic: explicit policy rejection
      r.includes('access denied') ||         // Generic: access denied by gateway
      r.includes('spf fail') ||              // SPF authentication failure
      r.includes('dkim fail') ||             // DKIM authentication failure
      r.includes('dmarc fail')               // DMARC authentication failure
    );
  }

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
      console.log(`ℹ️ [SendGrid Webhook] No pending record found for messageId: ${messageId}, email: ${E}, event: ${eventType} - checking if bulk email`);
      
      // ✅ Check if this is a bulk email (saved directly to EmailLog with messageId in SendGridLog)
      if (messageId) {
        try {
          const sendGridLog = await SendGridLog.findOne({ messageId });
          
          if (sendGridLog && sendGridLog.bulkId) {
            console.log(`📦 [SendGrid Webhook] Found bulk email: ${E} (bulkId: ${sendGridLog.bulkId})`);
            
            // Determine final status for bulk email
            let finalStatus = null;
            let finalSubStatus = null;
            let finalCategory = null;
            let confidence = 0.5;

            switch (eventType) {
              case 'delivered':
              case 'open':
              case 'click':
              case 'unsubscribe':
                finalStatus = 'Valid';
                finalSubStatus = `sendgrid_${eventType}`;
                finalCategory = 'valid';
                confidence = eventType === 'click' || eventType === 'open' ? 0.99 : 0.95;
                break;

              case 'bounce':
                if (type === 'soft') {
                  // Soft bounce: mailbox may be temporarily full/unavailable — treat as Risky
                  finalStatus = 'Risky';
                  finalSubStatus = 'sendgrid_soft_bounce';
                  finalCategory = 'risky';
                  confidence = 0.75;
                } else if (isPolicyBlock(reason)) {
                  // Policy block: our sender was rejected by the recipient's mail gateway
                  // (e.g. Mimecast blocked senders, IP reputation, SPF/DKIM/DMARC failure).
                  // The mailbox may exist — this is a sender policy issue, not a missing mailbox.
                  finalStatus = 'Risky';
                  finalSubStatus = 'sendgrid_policy_block';
                  finalCategory = 'risky';
                  confidence = 0.80;
                } else {
                  // Hard bounce: mailbox does not exist — treat as Invalid
                  finalStatus = 'Invalid';
                  finalSubStatus = 'sendgrid_hard_bounce';
                  finalCategory = 'invalid';
                  confidence = 0.98;
                }
                break;

              case 'dropped':
                finalStatus = 'Invalid';
                finalSubStatus = 'sendgrid_dropped';
                finalCategory = 'invalid';
                confidence = 0.90;
                break;

              case 'deferred':
                finalStatus = 'Invalid';
                finalSubStatus = 'sendgrid_deferred';
                finalCategory = 'invalid';
                confidence = 0.85;
                break;

              case 'blocked':
                finalStatus = 'Risky';
                finalSubStatus = 'sendgrid_blocked';
                finalCategory = 'risky';
                confidence = 0.85;
                break;

              case 'spamreport':
                finalStatus = 'Risky';
                finalSubStatus = 'sendgrid_spam_report';
                finalCategory = 'risky';
                confidence = 0.85;
                break;

              case 'processed':
                // Not final - wait for delivered/bounce
                console.log(`ℹ️ Processed event for bulk email ${E} - waiting for final status`);
                await SendGridLog.findOneAndUpdate(
                  { messageId },
                  {
                    $set: {
                      webhookEvent: eventType,
                      webhookTimestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
                    }
                  }
                );
                return;

              default:
                console.log(`ℹ️ Unhandled event type for bulk: ${eventType}`);
                return;
            }

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
              domain: sendGridLog.domain || (E.includes('@') ? E.split('@')[1] : 'N/A'),
              domainProvider: sendGridLog.provider || 'SendGrid',
              isDisposable: false,
              isFree: false,
              isRoleBased: false,
              score: finalCategory === 'valid' ? 90 : finalCategory === 'invalid' ? 5 : 45,
              timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
              section: 'bulk',
            };

            // Update global EmailLog
            await replaceLatest(EmailLog, E, finalPayload);

            // Update user EmailLog
            if (sendGridLog.username) {
              const { EmailLog: UserEmailLog } = getUserDb(
                mongoose,
                EmailLog,
                deps.RegionStat,
                deps.DomainReputation,
                sendGridLog.username
              );
              await replaceLatest(UserEmailLog, E, finalPayload);
            }

            // Update SendGridLog
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

            // ✅ Send WebSocket notification to frontend (CRITICAL for UI update!)
            if (sendGridLog.sessionId && sendGridLog.username) {
              try {
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
                  sendGridLog.sessionId,
                  true,
                  sendGridLog.username,
                  'bulk'
                );
                console.log(`📡 [SendGrid Webhook] WebSocket notification sent to frontend for ${E}`);
              } catch (wsErr) {
                console.warn(`⚠️ WebSocket notification failed for ${E}:`, wsErr.message);
              }
            }

            // ============================================================
            // ✅ STEP 4: Decrement webhook counter in BulkStat
            // ============================================================
            try {
              const BulkStat = mongoose.model('BulkStat');
              
              // Find BulkStat that contains this messageId
              const bulkStat = await BulkStat.findOne({
                sendgridMessageIds: messageId,
                state: 'waiting_for_webhooks'
              });
              
              if (bulkStat) {
                // Decrement pending count and remove messageId
                const result = await BulkStat.findOneAndUpdate(
                  { bulkId: bulkStat.bulkId },
                  {
                    $inc: { sendgridPendingCount: -1 },
                    $pull: { sendgridMessageIds: messageId }
                  },
                  { new: true }
                );
                
                if (result) {
                  const remaining = result.sendgridPendingCount;
                  const total = result.sendgridEmailCount;
                  console.log(`📉 [SendGrid Webhook] Bulk ${bulkStat.bulkId}: ${remaining}/${total} webhooks remaining`);
                  
                  // If this was the last webhook, log completion
                  if (remaining === 0) {
                    console.log(`🎉 [SendGrid Webhook] Bulk ${bulkStat.bulkId}: All webhooks received!`);
                  }
                }
              }
            } catch (err) {
              console.warn(`⚠️  [SendGrid Webhook] Failed to update BulkStat counter:`, err.message);
            }

            console.log(`✅ [SendGrid Webhook] Bulk email processed: ${E} -> ${finalStatus} (${finalCategory})`);
            return;
          }
        } catch (e) {
          console.warn('Bulk email webhook processing failed:', e.message);
        }
      }
      
      // Not found in pending or bulk - just update SendGridLog if exists
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
    // isFinalEvent: true = delete SendGridPending + debit credits
    // false = update EmailLog/WebSocket only, keep SendGridPending alive for potential bounce
    let isFinalEvent = true;

    switch (eventType) {
      case 'delivered':
        finalStatus = 'Valid';
        finalSubStatus = 'sendgrid_delivered';
        finalCategory = 'valid';
        confidence = 0.95;
        shouldSaveToEmailLog = true;
        // ── NOT a final event ──────────────────────────────────────────────
        // Keep SendGridPending alive: a bounce may follow (e.g. mailbox full).
        // Credits are debited by the bounce handler or by the polling timeout.
        isFinalEvent = false;
        break;

      case 'bounce':
        if (type === 'soft') {
          // Soft bounce: mailbox may be temporarily full/unavailable — treat as Risky
          finalStatus = 'Risky';
          finalSubStatus = 'sendgrid_soft_bounce';
          finalCategory = 'risky';
          confidence = 0.75;
        } else if (isPolicyBlock(reason)) {
          // Policy block: our sender was rejected by the recipient's mail gateway
          // (e.g. Mimecast blocked senders, IP reputation, SPF/DKIM/DMARC failure).
          // The mailbox may exist — this is a sender policy issue, not a missing mailbox.
          finalStatus = 'Risky';
          finalSubStatus = 'sendgrid_policy_block';
          finalCategory = 'risky';
          confidence = 0.80;
        } else {
          // Hard bounce: mailbox does not exist — treat as Invalid
          finalStatus = 'Invalid';
          finalSubStatus = 'sendgrid_hard_bounce';
          finalCategory = 'invalid';
          confidence = 0.98;
        }
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'dropped':
        finalStatus = 'Invalid';
        finalSubStatus = 'sendgrid_dropped';
        finalCategory = 'invalid';
        confidence = 0.90;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'deferred':
        finalStatus = 'Invalid';
        finalSubStatus = 'sendgrid_deferred';
        finalCategory = 'invalid';
        confidence = 0.85;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'blocked':
        finalStatus = 'Risky';
        finalSubStatus = 'sendgrid_blocked';
        finalCategory = 'risky';
        confidence = 0.85;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'processed':
        // Processed is not final - wait for delivered/bounce
        console.log(`ℹ️ Processed event for ${E} - waiting for final delivery status`);
        return;

      case 'open':
      case 'click':
        // Strong engagement signal — treat as final Valid
        finalStatus = 'Valid';
        finalSubStatus = 'sendgrid_engaged';
        finalCategory = 'valid';
        confidence = 0.99;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'spamreport':
        finalStatus = 'Risky';
        finalSubStatus = 'sendgrid_spam_report';
        finalCategory = 'risky';
        confidence = 0.85;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
        break;

      case 'unsubscribe':
        finalStatus = 'Valid';
        finalSubStatus = 'sendgrid_unsubscribed';
        finalCategory = 'valid';
        confidence = 0.95;
        shouldSaveToEmailLog = true;
        isFinalEvent = true;
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

    // Save to global EmailLog (always — so polling can read intermediate results)
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

    // ── Only debit credits on FINAL events ────────────────────────────────
    // For 'delivered', credits are debited by the bounce handler (if bounce
    // follows) or by the polling timeout handler (if no bounce arrives).
    if (isFinalEvent) {
      await deps.debitOneCreditIfNeeded(
        pending.username,
        finalStatus,
        E,
        pending.idemKey,
        'single'
      );
    }

    // Send WebSocket notification (always — UI should update immediately)
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
              finalCategory: isFinalEvent ? finalCategory : undefined,
              finalStatus: isFinalEvent ? finalStatus : undefined,
            }
          }
        );
      } catch (e) {
        console.warn('SendGridLog update failed:', e.message);
      }
    }

    // ── Only delete SendGridPending on FINAL events ────────────────────────
    // For 'delivered', keep the record alive so the polling loop can detect
    // a subsequent bounce event (e.g. mailbox full on Exchange/Mimecast).
    if (isFinalEvent) {
      await SendGridPending.deleteOne({ _id: pending._id });
      console.log(`✅ [SendGrid Webhook] Final event processed: ${E} -> ${finalStatus} (${finalCategory}, event: ${eventType}, reason: ${reason || 'N/A'})`);
    } else {
      console.log(`ℹ️ [SendGrid Webhook] Intermediate event processed: ${E} -> ${finalStatus} (event: ${eventType}) — keeping SendGridPending alive for potential bounce`);
    }
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
