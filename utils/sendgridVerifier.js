// backend/utils/sendgridVerifier.js
// ============================================================================
// SENDGRID EMAIL VERIFIER - For Proofpoint & Enterprise Gateways
// Sends actual test emails via SendGrid Web API to verify deliverability
// ============================================================================

const sgMail = require('@sendgrid/mail');
const dns = require('dns').promises;

// Initialize SendGrid with API key from environment
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_VERIFIED_SENDER = process.env.SENDGRID_VERIFIED_SENDER || 'jenny.j@truesendr.com';
const SENDGRID_ENABLED = process.env.SENDGRID_ENABLED === 'true';
const SENDGRID_TIMEOUT_MS = +(process.env.SENDGRID_TIMEOUT_MS || 10000);

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/**
 * Detect if domain uses Proofpoint email gateway
 * @param {string} domain - Email domain to check
 * @returns {Promise<boolean>} - True if Proofpoint detected
 */
async function isProofpointDomain(domain) {
  try {
    const records = await dns.resolveMx(domain);
    const mxHosts = records.map(r => r.exchange.toLowerCase()).join(',');
    
    // Check for Proofpoint MX patterns (including Proofpoint Essentials)
    return /pphosted\.com|ppe-hosted\.com|proofpoint\.com/i.test(mxHosts);
  } catch {
    return false;
  }
}

/**
 * Send verification email via SendGrid
 * @param {string} email - Email address to verify
 * @param {object} options - Additional options
 * @returns {Promise<object>} - Verification result
 */
async function sendVerificationEmail(email, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const isBulkMode = options.bulkMode === true || options.trainingTag === 'bulk';
  
  if (!SENDGRID_ENABLED) {
    logger('sendgrid', 'SendGrid is disabled in environment');
    return {
      success: false,
      status: 'unknown',
      sub_status: 'sendgrid_disabled',
      reason: 'SendGrid verification is not enabled',
      provider: 'SendGrid',
      method: 'skipped'
    };
  }

  if (!SENDGRID_API_KEY) {
    logger('sendgrid', 'SendGrid API key not configured');
    return {
      success: false,
      status: 'unknown',
      sub_status: 'sendgrid_not_configured',
      reason: 'SendGrid API key is missing',
      provider: 'SendGrid',
      method: 'skipped'
    };
  }

  logger('sendgrid', `Sending verification email to ${email}${isBulkMode ? ' (bulk mode)' : ''}`);

  const msg = {
    to: email,
    from: {
      email: SENDGRID_VERIFIED_SENDER,
      name: 'TrueSendr Verification'
    },
    subject: 'Email Verification',
    text: 'This is an automated email verification. No action required.',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <p>This is an automated email verification.</p>
        <p style="color: #666; font-size: 12px;">No action required. This email confirms your address is active.</p>
      </div>
    `,
    // Custom args for tracking
    customArgs: {
      verification: 'true',
      email: email,
      timestamp: new Date().toISOString()
    },
    // Track clicks and opens
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: true }
    }
  };

  try {
    const startTime = Date.now();
    
    // Send email with timeout
    const response = await Promise.race([
      sgMail.send(msg),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('SendGrid timeout')), SENDGRID_TIMEOUT_MS)
      )
    ]);

    const elapsed = Date.now() - startTime;
    logger('sendgrid', `Email sent successfully in ${elapsed}ms`);

    // Parse SendGrid response
    const statusCode = response[0]?.statusCode || 0;
    const messageId = response[0]?.headers?.['x-message-id'] || null;

    if (statusCode >= 200 && statusCode < 300) {
      // ✅ BULK MODE: Return immediate "unknown" (webhook will update later)
      // ✅ SINGLE MODE: Return "pending" (wait for webhook)
      if (isBulkMode) {
        return {
          success: true,
          status: 'unknown',
          sub_status: 'sendgrid_sent_bulk',
          reason: 'Email sent to SendGrid (bulk mode - webhook will update if received)',
          provider: 'SendGrid',
          method: 'web_api',
          messageId,
          statusCode,
          confidence: 0.5,
          category: 'unknown',
          elapsed_ms: elapsed,
          awaitingWebhook: false
        };
      } else {
        return {
          success: true,
          status: 'pending',
          sub_status: 'sendgrid_pending_webhook',
          reason: 'Email sent to SendGrid. Waiting for delivery confirmation via webhook.',
          provider: 'SendGrid',
          method: 'web_api',
          messageId,
          statusCode,
          confidence: null,
          category: 'pending',
          elapsed_ms: elapsed,
          awaitingWebhook: true
        };
      }
    } else {
      return {
        success: false,
        status: 'unknown',
        sub_status: 'sendgrid_unexpected_status',
        reason: `SendGrid returned unexpected status code: ${statusCode}`,
        provider: 'SendGrid',
        method: 'web_api',
        statusCode,
        confidence: 0.3,
        category: 'unknown',
        elapsed_ms: elapsed
      };
    }

  } catch (error) {
    logger('sendgrid_error', `SendGrid error: ${error.message}`);

    // Parse SendGrid error response
    const errorCode = error.code;
    const errorMessage = error.message || '';
    const responseBody = error.response?.body;

    // Check for specific error patterns
    if (errorCode === 'ENOTFOUND' || errorCode === 'ETIMEDOUT') {
      return {
        success: false,
        status: 'unknown',
        sub_status: 'sendgrid_network_error',
        reason: 'Network error while contacting SendGrid',
        provider: 'SendGrid',
        method: 'web_api',
        error: errorMessage,
        confidence: 0.2,
        category: 'unknown'
      };
    }

    // SendGrid API errors (400-level)
    if (responseBody?.errors) {
      const errors = responseBody.errors;
      const firstError = errors[0] || {};
      
      // Check for invalid recipient errors
      if (firstError.message?.toLowerCase().includes('does not contain a valid address')) {
        return {
          success: false,
          status: 'undeliverable',
          sub_status: 'sendgrid_invalid_address',
          reason: 'SendGrid rejected the email address as invalid',
          provider: 'SendGrid',
          method: 'web_api',
          error: firstError.message,
          confidence: 0.9,
          category: 'invalid'
        };
      }

      // Check for suppression list (bounced/spam/unsubscribed)
      if (firstError.message?.toLowerCase().includes('suppressed')) {
        return {
          success: false,
          status: 'undeliverable',
          sub_status: 'sendgrid_suppressed',
          reason: 'Email is on SendGrid suppression list (previously bounced or marked as spam)',
          provider: 'SendGrid',
          method: 'web_api',
          error: firstError.message,
          confidence: 0.95,
          category: 'invalid'
        };
      }

      // Generic SendGrid error
      return {
        success: false,
        status: 'risky',
        sub_status: 'sendgrid_api_error',
        reason: `SendGrid API error: ${firstError.message || 'Unknown error'}`,
        provider: 'SendGrid',
        method: 'web_api',
        error: firstError.message,
        confidence: 0.4,
        category: 'risky'
      };
    }

    // Timeout error
    if (errorMessage.includes('timeout')) {
      return {
        success: false,
        status: 'unknown',
        sub_status: 'sendgrid_timeout',
        reason: 'SendGrid request timed out',
        provider: 'SendGrid',
        method: 'web_api',
        error: errorMessage,
        confidence: 0.3,
        category: 'unknown'
      };
    }

    // Generic error
    return {
      success: false,
      status: 'unknown',
      sub_status: 'sendgrid_error',
      reason: `SendGrid verification failed: ${errorMessage}`,
      provider: 'SendGrid',
      method: 'web_api',
      error: errorMessage,
      confidence: 0.3,
      category: 'unknown'
    };
  }
}

/**
 * Verify email using SendGrid (main entry point)
 * @param {string} email - Email address to verify
 * @param {object} options - Verification options
 * @returns {Promise<object>} - Verification result
 */
async function verifySendGrid(email, options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  
  logger('sendgrid_verify', `Starting SendGrid verification for ${email}`);

  // Extract domain
  const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : '';
  
  if (!domain) {
    return {
      success: false,
      status: 'undeliverable',
      sub_status: 'syntax',
      reason: 'Invalid email format',
      provider: 'SendGrid',
      method: 'validation',
      confidence: 1.0,
      category: 'invalid'
    };
  }

  // Check if Proofpoint (optional - can be called externally too)
  const isProofpoint = await isProofpointDomain(domain);
  logger('sendgrid_check', `Domain ${domain} is ${isProofpoint ? '' : 'NOT '}Proofpoint`);

  // Send verification email
  const result = await sendVerificationEmail(email, options);
  
  // Add domain info to result
  result.domain = domain;
  result.isProofpoint = isProofpoint;

  return result;
}

/**
 * Convert SendGrid result to TrueSendr format
 * @param {object} sgResult - SendGrid verification result
 * @param {object} meta - Email metadata (domain, flags, etc.)
 * @returns {object} - Formatted result for TrueSendr
 */
function toTrueSendrFormat(sgResult, meta = {}) {
  const flags = meta.flags || { disposable: false, free: false, role: false };
  
  // Calculate score based on status
  let score = 50;
  if (sgResult.category === 'valid') score = 90;
  else if (sgResult.category === 'invalid') score = 5;
  else if (sgResult.category === 'risky') score = 45;
  else score = 35;

  // Adjust for flags
  if (flags.disposable) score -= 30;
  if (flags.free) score -= 10;
  if (flags.role) score -= 10;
  score = Math.max(0, Math.min(100, score));

  // Build status text with icon
  const icon = 
    sgResult.category === 'valid' ? '✅' :
    sgResult.category === 'invalid' ? '❌' :
    sgResult.category === 'risky' ? '⚠️' : '❔';

  const statusText =
    sgResult.category === 'valid' ? 'Valid Email' :
    sgResult.category === 'invalid' ? 'Invalid Email' :
    sgResult.category === 'risky' ? 'Risky' :
    'Unknown';

  return {
    status: `${icon} ${statusText}`,
    category: sgResult.category,
    sub_status: sgResult.sub_status,
    domain: sgResult.domain || meta.domain || 'N/A',
    provider: 'Proofpoint Email Protection',
    isDisposable: flags.disposable,
    isFree: flags.free,
    isRoleBased: flags.role,
    score,
    confidence: sgResult.confidence || 0.5,
    reason: sgResult.reason || 'Verified via SendGrid',
    method: 'sendgrid_web_api',
    messageId: sgResult.messageId || null,
    elapsed_ms: sgResult.elapsed_ms || null,
    _raw: sgResult
  };
}

module.exports = {
  verifySendGrid,
  sendVerificationEmail,
  isProofpointDomain,
  toTrueSendrFormat
};
