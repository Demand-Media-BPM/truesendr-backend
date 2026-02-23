// .......................................................................................................

// routes/singleValidator.js
const express = require("express");
const router = express.Router();

// Pull mergeSMTPWithHistory + extractDomain from utils
const {
  mergeSMTPWithHistory,
  extractDomain,
  categoryFromStatus: catFromStatus,
  normalizeStatus,
} = require("../utils/validator");

// Training samples model
const TrainingSample = require("../models/TrainingSample");

// 🆕 SendGrid integration (Yash logic)
const {
  verifySendGrid,
  isProofpointDomain,
  toTrueSendrFormat,
} = require("../utils/sendgridVerifier");
const SendGridLog = require("../models/SendGridLog");

// 🆕 Bank/Healthcare domain classifier (Yash logic)
const { classifyDomain, getDomainCategory, hasBankWordInDomain, isOrgEduGovDomain, isTwDomain } = require("../utils/domainClassifier");

module.exports = function singleValidatorRouter(deps) {
  const {
    // models / db
    mongoose,
    EmailLog,
    RegionStat,
    DomainReputation,
    User,

    // OPTIONAL (kept for your frontend UX; NOT used to affect validation logic)
    SinglePending,

    // helpers / utils
    categoryFromStatus,
    normEmail,
    buildReasonAndMessage,
    getFreshestFromDBs,
    replaceLatest,
    bumpUpdatedAt,
    getUserDb, // ✅ must exist in deps (you already use deps.getUserDb in your code)

    // config / state
    FRESH_DB_MS,
    stableCache,
    inflight,
    CACHE_TTL_MS,

    // validators
    validateSMTP,
    validateSMTPStable,

    // credits / idempotency
    debitOneCreditIfNeeded,
    idempoGet,

    // WS logging / updates
    sendLogToFrontend,
    sendStatusToFrontend,
  } = deps;

  // ────────────────────────────────────────────────────────────
  // Terminal + Frontend logger (keeps your existing WS logs, adds terminal logs)
  // ────────────────────────────────────────────────────────────
  function mkLogger(sessionId, E, username) {
    return (step, message, level = "info") => {
      try {
        const ts = new Date().toISOString();
        console.log(
          `[${ts}][single][${level}][${username || "na"}][${sessionId || "na"}][${E}] ${step}: ${message}`,
        );
      } catch (e) {}
      try {
        sendLogToFrontend(sessionId, E, message, step, level, username);
      } catch (e) {}
    };
  }

  // ────────────────────────────────────────────────────────────
  // SinglePending helpers (OPTIONAL)
  // IMPORTANT: These do NOT change validation logic; only for UI tracking.
  // ────────────────────────────────────────────────────────────
  async function upsertPendingJob({ username, email, idemKey, sessionId }) {
    if (!SinglePending) return;
    if (!username || !email) return;
    await SinglePending.findOneAndUpdate(
      { username, email },
      {
        $setOnInsert: { username, email },
        $set: {
          idemKey: idemKey || "",
          sessionId: sessionId || null,
          status: "in_progress",
        },
      },
      { upsert: true, new: true },
    );
  }

  async function markPendingDone(username, email) {
    if (!SinglePending) return;
    if (!username || !email) return;
    await SinglePending.updateOne({ username, email }, { $set: { status: "done" } });
  }

  // ────────────────────────────────────────────────────────────
  // Helper: build domain/provider + training history
  // ────────────────────────────────────────────────────────────
  async function buildHistoryForEmail(emailNorm) {
    const E = normEmail(emailNorm);
    const domain = extractDomain(E);

    const domainPromise =
      domain && domain !== "N/A"
        ? DomainReputation.findOne({ domain }).lean()
        : Promise.resolve(null);

    const trainingPromise = TrainingSample.findOne({ email: E }).lean();

    const [stats, ts] = await Promise.all([domainPromise, trainingPromise]);

    const history = {};

    // domain invalid-rate
    if (stats && stats.sent && stats.sent > 0) {
      const domainSamples = stats.sent;
      const domainInvalidRate =
        typeof stats.invalid === "number" && stats.sent > 0
          ? stats.invalid / stats.sent
          : null;

      if (domainInvalidRate !== null) {
        history.domainInvalidRate = domainInvalidRate;
        history.domainSamples = domainSamples;

        // mirror to provider (your existing merge expects provider-like fields)
        history.providerInvalidRate = domainInvalidRate;
        history.providerSamples = domainSamples;
      }
    }

    // TrainingSample counts
    if (ts) {
      const rawCounts = ts.labelCounts || {};
      const trainingCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };

      for (const [label, value] of rawCounts.entries
        ? rawCounts.entries()
        : Object.entries(rawCounts)) {
        const l = String(label || "").toLowerCase();
        const v = typeof value === "number" ? value : 0;
        if (!v) continue;

        if (l === "valid") trainingCounts.valid += v;
        else if (l === "invalid") trainingCounts.invalid += v;
        else if (l === "risky") trainingCounts.risky += v;
        else trainingCounts.unknown += v;
      }

      history.trainingLastLabel = ts.lastLabel || null;
      history.trainingLabel = ts.lastLabel || null; // alias used by merge helper
      history.trainingCounts = trainingCounts;

      const totalFromCounts =
        trainingCounts.valid +
        trainingCounts.invalid +
        trainingCounts.risky +
        trainingCounts.unknown;

      history.trainingSamples =
        typeof ts.totalSamples === "number" ? ts.totalSamples : totalFromCounts;
    }

    return history;
  }

  // ────────────────────────────────────────────────────────────
  // Helper: finalize payload + save + cache + debit + WS + respond
  // ────────────────────────────────────────────────────────────
  async function finalizeAndRespond({
    E,
    rawResult,
    history,
    idemKey,
    username,
    sessionId,
    EmailLogModel,
    UserEmailLogModel,
    via,
    cached,
    res,
    shouldCache = true,
  }) {
    const merged = mergeSMTPWithHistory(rawResult, history || {}, {
      domain: rawResult.domain || extractDomain(E),
      provider: rawResult.provider || rawResult.domainProvider || "Unavailable",
    });

    const subStatus = merged.sub_status || merged.subStatus || null;
    const rawStatus = merged.status || rawResult.status || "Unknown";
    const rawCategory = merged.category || categoryFromStatus(rawStatus || "");
    const { status, category } = normalizeStatus(rawStatus, rawCategory);

    const confidence =
      typeof merged.confidence === "number"
        ? merged.confidence
        : typeof rawResult.confidence === "number"
          ? rawResult.confidence
          : null;

    const built = buildReasonAndMessage(status, subStatus, {
      isDisposable: !!merged.isDisposable,
      isRoleBased: !!merged.isRoleBased,
      isFree: !!merged.isFree,
    });

    const domain = merged.domain || extractDomain(E);
    const provider =
      merged.provider || merged.domainProvider || rawResult.domainProvider || "Unavailable";

    const payload = {
      email: E,
      status,
      subStatus,
      confidence,
      category,
      reason: merged.reason || built.reasonLabel,
      message: merged.message || built.message,
      domain,
      domainProvider: provider,
      isDisposable: !!merged.isDisposable,
      isFree: !!merged.isFree,
      isRoleBased: !!merged.isRoleBased,
      score: typeof merged.score === "number" ? merged.score : rawResult.score ?? 0,
      timestamp: rawResult.timestamp instanceof Date ? rawResult.timestamp : new Date(),
      section: "single",
    };

    // ─────────────────────────────────────────────────────────
    // 🏦 Bank domain override: if validation returned Valid AND
    //    the domain contains "bank" → downgrade to Risky.
    //    (Domain is good and mailbox exists, but banking domains
    //     are high-risk for cold email sending.)
    // ─────────────────────────────────────────────────────────
    if (payload.category === "valid" && hasBankWordInDomain(payload.domain)) {
      console.log(`[single][bank_override] ${E} → domain "${payload.domain}" contains "bank", overriding Valid → Risky`);
      payload.status = "Risky";
      payload.category = "risky";
      payload.subStatus = "bank_domain";
      payload.score = Math.min(payload.score, 45);
      payload.reason = "Banking Domain";
      payload.message = "This address belongs to a banking/financial domain. Sending cold emails to banking domains is risky and may result in blocks or bounces.";
    }

    // ─────────────────────────────────────────────────────────
    // 🏛️ .org / .edu / .gov domain override: if validation returned
    //    Valid AND domain ends with .org, .edu, or .gov → downgrade
    //    to Risky. These are organizational, educational, and
    //    government domains that are high-risk for cold email sending.
    // ─────────────────────────────────────────────────────────
    if (payload.category !== "invalid" && isOrgEduGovDomain(payload.domain)) {
      console.log(`[single][org_edu_gov_override] ${E} → domain "${payload.domain}" ends with .org/.edu/.gov/.mx/.tw, overriding ${payload.category} → Risky`);
      payload.status = "Risky";
      payload.category = "risky";
      payload.subStatus = "org_edu_gov_domain";
      payload.score = Math.min(payload.score, 45);
      payload.reason = "Restricted Domain TLD";
      payload.message = "This address belongs to an organizational, educational, government, or country-specific domain (.org/.edu/.gov/.mx). Sending cold emails to these domains is risky and may result in blocks or bounces.";
    }

    // persist in both global + user DB
    await replaceLatest(EmailLogModel, E, payload);
    await replaceLatest(UserEmailLogModel, E, payload);

    // memory cache
    if (shouldCache && stableCache) {
      stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: payload });
    }

    const credits = await debitOneCreditIfNeeded(
      username,
      payload.status,
      E,
      idemKey,
      "single",
    );

    // WS push
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
      sessionId,
      true,
      username,
      "single"
    );

    return res.json({ ...payload, via, cached, credits });
  }

  // ────────────────────────────────────────────────────────────
  // ✅ Yash validation logic helpers:
  // 1) Bank/Healthcare OR Proofpoint => SendGrid direct
  // 2) SMTP Unknown => SendGrid fallback
  // ────────────────────────────────────────────────────────────
  async function maybeSendgridDirectOrNull({ E, username, sessionId, idemKey, res }) {
    const domain = extractDomain(E);

    // ✅ Early domain validation - check if domain has MX records
    const dns = require('dns').promises;
    try {
      const mxRecords = await dns.resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        const logger = mkLogger(sessionId, E, username);
        logger("domain_validation", `Domain ${domain} has no MX records - cannot receive emails`, "warn");
        
        // Return invalid domain response immediately
        const { EmailLog: UserEmailLog2 } = getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username,
        );

        const invalidPayload = {
          email: E,
          status: "Invalid",
          subStatus: "invalid_domain_no_mx",
          confidence: 0.99,
          category: "invalid",
          reason: "Invalid Domain",
          message: `Domain ${domain} has no MX records and cannot receive emails`,
          domain,
          domainProvider: "N/A",
          isDisposable: false,
          isFree: false,
          isRoleBased: false,
          score: 0,
          timestamp: new Date(),
          section: "single",
        };

        await replaceLatest(EmailLog, E, invalidPayload);
        await replaceLatest(UserEmailLog2, E, invalidPayload);

        sendStatusToFrontend(
          E,
          invalidPayload.status,
          invalidPayload.timestamp,
          {
            domain: invalidPayload.domain,
            provider: invalidPayload.domainProvider,
            isDisposable: invalidPayload.isDisposable,
            isFree: invalidPayload.isFree,
            isRoleBased: invalidPayload.isRoleBased,
            score: invalidPayload.score,
            subStatus: invalidPayload.subStatus,
            confidence: invalidPayload.confidence,
            category: invalidPayload.category,
            message: invalidPayload.message,
            reason: invalidPayload.reason,
          },
          sessionId,
          true,
          username,
          "single"
        );

        const userCredits = await debitOneCreditIfNeeded(
          username,
          invalidPayload.status,
          E,
          idemKey,
          "single",
        );

        if (stableCache) {
          stableCache.set(E, {
            until: Date.now() + (CACHE_TTL_MS || 0),
            result: invalidPayload,
          });
        }

        return res.json({
          ...invalidPayload,
          via: "domain-validation",
          cached: false,
          inProgress: false,
          credits: userCredits,
        });
      }
    } catch (dnsError) {
      const logger = mkLogger(sessionId, E, username);
      logger("domain_validation", `DNS lookup failed for ${domain}: ${dnsError.message}`, "warn");
      
      // Return invalid domain response for DNS errors
      const { EmailLog: UserEmailLog2 } = getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
      );

        const invalidPayload = {
          email: E,
          status: "Invalid",
          subStatus: "invalid_domain_dns_error",
        confidence: 0.95,
        category: "invalid",
        reason: "Invalid Domain",
        message: `Domain ${domain} does not exist or DNS lookup failed`,
        domain,
        domainProvider: "N/A",
        isDisposable: false,
        isFree: false,
        isRoleBased: false,
        score: 0,
        timestamp: new Date(),
        section: "single",
      };

      await replaceLatest(EmailLog, E, invalidPayload);
      await replaceLatest(UserEmailLog2, E, invalidPayload);

      sendStatusToFrontend(
        E,
        invalidPayload.status,
        invalidPayload.timestamp,
        {
          domain: invalidPayload.domain,
          provider: invalidPayload.domainProvider,
          isDisposable: invalidPayload.isDisposable,
          isFree: invalidPayload.isFree,
          isRoleBased: invalidPayload.isRoleBased,
          score: invalidPayload.score,
          subStatus: invalidPayload.subStatus,
          confidence: invalidPayload.confidence,
          category: invalidPayload.category,
          message: invalidPayload.message,
          reason: invalidPayload.reason,
        },
        sessionId,
        true,
        username,
        "single"
      );

      const userCredits = await debitOneCreditIfNeeded(
        username,
        invalidPayload.status,
        E,
        idemKey,
        "single",
      );

      if (stableCache) {
        stableCache.set(E, {
          until: Date.now() + (CACHE_TTL_MS || 0),
          result: invalidPayload,
        });
      }

      return res.json({
        ...invalidPayload,
        via: "domain-validation",
        cached: false,
        inProgress: false,
        credits: userCredits,
      });
    }

    const domainClassification = classifyDomain(domain);
    const isBankOrHealthcare =
      !!domainClassification?.isBank || !!domainClassification?.isHealthcare;

    const isProofpoint = await isProofpointDomain(domain);

    if (!isBankOrHealthcare && !isProofpoint) return null;

    const domainCategory = isBankOrHealthcare
      ? getDomainCategory(domain)
      : "Proofpoint Email Protection";

    const logger = mkLogger(sessionId, E, username);

    // Resolve user DB model
    const { EmailLog: UserEmailLog2 } = getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
    );

    // Bank/Healthcare: optional domain reputation short-circuit
    if (isBankOrHealthcare) {
      const domainStats = await DomainReputation.findOne({ domain }).lean();
      if (domainStats && domainStats.sent >= 5) {
        const bounceRate = domainStats.sent > 0 ? domainStats.invalid / domainStats.sent : 0;

        if (bounceRate >= 0.6) {
          logger(
            "high_risk_domain",
            `${domainCategory} domain high bounce (${(bounceRate * 100).toFixed(1)}%) → Risky`,
            "warn",
          );

          const riskyPayload = {
            email: E,
            status: "Risky",
            subStatus: "high_bounce_bank_healthcare",
            confidence: 0.85,
            category: "risky",
            reason: "High Bounce Domain",
            message: `This ${domainCategory} domain has a high bounce rate (${(
              bounceRate * 100
            ).toFixed(1)}%). Sending is risky.`,
            domain,
            domainProvider: domainCategory,
            isDisposable: false,
            isFree: false,
            isRoleBased: false,
            score: 20,
            timestamp: new Date(),
            section: "single",
          };

          await replaceLatest(EmailLog, E, riskyPayload);
          await replaceLatest(UserEmailLog2, E, riskyPayload);

          sendStatusToFrontend(
            E,
            riskyPayload.status,
            riskyPayload.timestamp,
            {
              domain: riskyPayload.domain,
              provider: riskyPayload.domainProvider,
              isDisposable: riskyPayload.isDisposable,
              isFree: riskyPayload.isFree,
              isRoleBased: riskyPayload.isRoleBased,
              score: riskyPayload.score,
              subStatus: riskyPayload.subStatus,
              confidence: riskyPayload.confidence,
              category: riskyPayload.category,
              message: riskyPayload.message,
              reason: riskyPayload.reason,
            },
            sessionId,
            true,
            username,
            "single"
          );

          const userCredits = await debitOneCreditIfNeeded(
            username,
            riskyPayload.status,
            E,
            idemKey,
            "single",
          );

          if (stableCache) {
            stableCache.set(E, {
              until: Date.now() + (CACHE_TTL_MS || 0),
              result: riskyPayload,
            });
          }

          return res.json({
            ...riskyPayload,
            via: "domain-reputation",
            cached: false,
            inProgress: false,
            credits: userCredits,
          });
        }
      }
    }

    logger(
      isBankOrHealthcare && isProofpoint
        ? "bank_healthcare_proofpoint"
        : isBankOrHealthcare
          ? "bank_healthcare"
          : "proofpoint",
      `${domainCategory} domain detected → SendGrid direct verification`,
      "info",
    );

    // ✅ Check if this email was already sent recently (deduplication) - BEFORE sending to SendGrid
    const SendGridPending = deps.SendGridPending || mongoose.model('SendGridPending');
    const recentPending = await SendGridPending.findOne({
      email: E,
      username,
      createdAt: { $gte: new Date(Date.now() - 60000) } // within last 60 seconds
    });

    if (recentPending) {
      logger("sendgrid_duplicate", "Email already sent recently, returning existing pending status", "warn");
      
      // Get user for credits display
      const user = await User.findOne({ username });
      
      const viaLabel =
        isBankOrHealthcare && isProofpoint
          ? "sendgrid-bank-healthcare-proofpoint"
          : isBankOrHealthcare
            ? "sendgrid-bank-healthcare"
            : "sendgrid-proofpoint";
      
        return res.json({
          email: E,
          status: "Processing",
          category: "pending",
        subStatus: "sendgrid_pending_webhook",
        message: "Email verification already in progress. Waiting for delivery confirmation...",
        domain,
        domainProvider: domainCategory,
        via: viaLabel,
        awaitingWebhook: true,
        messageId: recentPending.messageId,
        credits: user?.credits || 0,
        isDisposable: false,
        isFree: false,
        isRoleBased: false,
        score: 50,
        timestamp: new Date()
      });
    }

    // ✅ No duplicate found - proceed with SendGrid verification
    const sgResult = await verifySendGrid(E, { logger });

    const viaLabel =
      isBankOrHealthcare && isProofpoint
        ? "sendgrid-bank-healthcare-proofpoint"
        : isBankOrHealthcare
          ? "sendgrid-bank-healthcare"
          : "sendgrid-proofpoint";

    // ✅ Check if result is pending (awaiting webhook)
    if (sgResult.awaitingWebhook && sgResult.messageId) {
      logger("sendgrid_pending", "Email sent to SendGrid, awaiting webhook confirmation", "info");
      
      // Get user for credits display
      const user = await User.findOne({ username });
      
      // Save to SendGridPending (NOT EmailLog)
      await SendGridPending.create({
        email: E,
        username,
        sessionId,
        messageId: sgResult.messageId,
        domain,
        provider: domainCategory,
        idemKey,
        metadata: {
          isProofpoint,
          isBankOrHealthcare,
          domainCategory
        }
      });
      
      // ✅ Log to SendGridLog for tracking (use valid enum values)
      try {
        await SendGridLog.create({
          email: E,
          domain,
          status: 'unknown', // ✅ Use valid enum value instead of 'pending'
          sub_status: 'sendgrid_pending_webhook',
          category: 'unknown', // ✅ Use valid enum value instead of 'pending'
          confidence: 0.5,
          score: 50,
          reason: 'Email sent to SendGrid, awaiting webhook confirmation',
          messageId: sgResult.messageId,
          statusCode: sgResult.statusCode,
          method: sgResult.method || "web_api",
          isProofpoint: !!isProofpoint,
          isFallback: false,
          provider: `${domainCategory} (via SendGrid)`,
          elapsed_ms: sgResult.elapsed_ms,
          error: sgResult.error,
          username,
          sessionId,
          isDisposable: false,
          isFree: false,
          isRoleBased: false,
          rawResponse: sgResult,
        });
        logger("sendgrid_log", `SendGridLog created with messageId: ${sgResult.messageId}`, "info");
      } catch (e) {
        console.warn("SendGridLog create failed:", e.message);
      }
      
      // Return response WITHOUT saving to EmailLog
        return res.json({
          email: E,
          status: "Processing",
          category: "pending",
        subStatus: "sendgrid_pending_webhook",
        message: "Email sent for verification. Waiting for delivery confirmation...",
        domain,
        domainProvider: domainCategory,
        via: viaLabel,
        awaitingWebhook: true,
        messageId: sgResult.messageId,
        credits: user?.credits || 0,
        isDisposable: false,
        isFree: false,
        isRoleBased: false,
        score: 50,
        timestamp: new Date()
      });
    }

    // Normal flow for non-pending results
    const meta = { domain, flags: { disposable: false, free: false, role: false } };
    const result = toTrueSendrFormat(sgResult, meta);

    // best-effort SendGridLog
    try {
      await SendGridLog.create({
        email: E,
        domain,
        status: sgResult.status,
        sub_status: sgResult.sub_status,
        category: sgResult.category,
        confidence: sgResult.confidence || 0.5,
        score: result.score || 50,
        reason: sgResult.reason,
        messageId: sgResult.messageId,
        statusCode: sgResult.statusCode,
        method: sgResult.method || "web_api",
        isProofpoint: !!isProofpoint,
        isFallback: false,
        provider: `${domainCategory} (via SendGrid)`,
        elapsed_ms: sgResult.elapsed_ms,
        error: sgResult.error,
        username,
        sessionId,
        isDisposable: result.isDisposable,
        isFree: result.isFree,
        isRoleBased: result.isRoleBased,
        rawResponse: sgResult,
      });
    } catch (e) {
      console.warn("SendGridLog create failed:", e.message);
    }

    const history = await buildHistoryForEmail(E);

    return finalizeAndRespond({
      E,
      rawResult: result,
      history,
      idemKey,
      username,
      sessionId,
      EmailLogModel: EmailLog,
      UserEmailLogModel: UserEmailLog2,
      via: viaLabel,
      cached: false,
      res,
      shouldCache: true,
    });
  }

  async function maybeSendgridFallbackOnUnknown({ E, username, sessionId, smtpRaw }) {
    if (!smtpRaw) return null;

    const cat = smtpRaw.category || categoryFromStatus(smtpRaw.status || "");
    if (String(cat).toLowerCase() !== "unknown") return null;

    const logger = mkLogger(sessionId, E, username);

    logger("sendgrid_fallback", "SMTP returned unknown → SendGrid fallback", "info");

    const domain = extractDomain(E);

    try {
      const sgResult = await verifySendGrid(E, { logger });
      const meta = { domain, flags: { disposable: false, free: false, role: false } };
      const sgTrueSendrResult = toTrueSendrFormat(sgResult, meta);

      if (!sgTrueSendrResult.provider && !sgTrueSendrResult.domainProvider) {
        sgTrueSendrResult.provider = "SendGrid (fallback)";
        sgTrueSendrResult.domainProvider = "SendGrid (fallback)";
      }

      // best-effort fallback log
      try {
        await SendGridLog.create({
          email: E,
          domain,
          status: sgResult.status,
          sub_status: sgResult.sub_status,
          category: sgResult.category,
          confidence: sgResult.confidence || 0.5,
          score: sgTrueSendrResult.score || 50,
          reason: sgResult.reason,
          messageId: sgResult.messageId,
          statusCode: sgResult.statusCode,
          method: sgResult.method || "web_api",
          isProofpoint: false,
          isFallback: true,
          smtpCategory: smtpRaw.category,
          smtpSubStatus: smtpRaw.sub_status,
          provider: smtpRaw.provider || "Unknown (SMTP fallback)",
          elapsed_ms: sgResult.elapsed_ms,
          error: sgResult.error,
          username,
          sessionId,
          isDisposable: sgTrueSendrResult.isDisposable,
          isFree: sgTrueSendrResult.isFree,
          isRoleBased: sgTrueSendrResult.isRoleBased,
          rawResponse: sgResult,
        });
      } catch (e) {
        console.warn("SendGridLog fallback create failed:", e.message);
      }

      return { sgTrueSendrResult, via: "sendgrid-fallback" };
    } catch (e) {
      logger("sendgrid_fallback_error", `SendGrid fallback failed: ${e.message}`, "warn");
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────
  // POST /api/single/validate
  // (sync-style: does a single live SMTP pass; applies Yash SendGrid rules)
  // ────────────────────────────────────────────────────────────
  router.post("/validate", async (req, res) => {
    const idemKey =
      req.headers["x-idempotency-key"] ||
      (req.body && req.body.idempotencyKey) ||
      null;

    try {
      const { email, sessionId, username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!username) return res.status(400).json({ error: "Username is required" });

      const E = normEmail(email);
      const logger = mkLogger(sessionId, E, username);

      // credits check (still respects idempotency)
      const user = await User.findOne({ username });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.credits <= 0) {
        const alreadyPaid = idemKey && idempoGet(username, E, idemKey);
        if (!alreadyPaid) return res.status(400).json({ error: "You don't have credits" });
      }

      // ─────────────────────────────────────────────────────────
      // 🇹🇼 .tw domain direct Risky: skip all validation entirely.
      //    SMTP cannot probe .tw domains reliably — return Risky immediately.
      // ─────────────────────────────────────────────────────────
      if (isTwDomain(extractDomain(E))) {
        const twDomain = extractDomain(E);
        console.log(`[single][tw_direct_risky] ${E} → domain "${twDomain}" ends with .tw, returning Risky directly (no SMTP/SendGrid)`);
        const { EmailLog: UserEmailLog2 } = getUserDb(mongoose, EmailLog, RegionStat, DomainReputation, username);
        const twPayload = {
          email: E, status: "Risky", subStatus: "tw_domain", confidence: 0.9,
          category: "risky", reason: "Restricted Country TLD",
          message: "This address belongs to a Taiwanese domain (.tw). SMTP probing is unreliable for .tw domains and sending cold emails is risky.",
          domain: twDomain, domainProvider: "Taiwan (.tw)", isDisposable: false,
          isFree: false, isRoleBased: false, score: 30, timestamp: new Date(), section: "single",
        };
        await replaceLatest(EmailLog, E, twPayload);
        await replaceLatest(UserEmailLog2, E, twPayload);
        if (stableCache) stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: twPayload });
        const credits = await debitOneCreditIfNeeded(username, twPayload.status, E, idemKey, "single");
        sendStatusToFrontend(E, twPayload.status, twPayload.timestamp, {
          domain: twPayload.domain, provider: twPayload.domainProvider,
          isDisposable: false, isFree: false, isRoleBased: false, score: twPayload.score,
          subStatus: twPayload.subStatus, confidence: twPayload.confidence,
          category: twPayload.category, message: twPayload.message, reason: twPayload.reason,
        }, sessionId, true, username, "single");
        return res.json({ ...twPayload, via: "tw-direct", cached: false, credits });
      }

      // Freshest cache (global + user)
      const { best: cachedDb, UserEmailLog } = await getFreshestFromDBs(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        EmailLog,
        username,
        E,
      );

      if (cachedDb) {
        const fresh =
          Date.now() - (cachedDb.updatedAt || cachedDb.createdAt) <= FRESH_DB_MS;

        if (fresh) {
          await bumpUpdatedAt(EmailLog, E, "single");

          const history = await buildHistoryForEmail(E);
          const merged = mergeSMTPWithHistory(
            {
              status: cachedDb.status,
              subStatus: cachedDb.subStatus,
              category: cachedDb.category,
              score: cachedDb.score,
              domain: cachedDb.domain,
              provider: cachedDb.domainProvider || cachedDb.provider,
              isDisposable: cachedDb.isDisposable,
              isFree: cachedDb.isFree,
              isRoleBased: cachedDb.isRoleBased,
              confidence: cachedDb.confidence,
              timestamp: cachedDb.timestamp || cachedDb.updatedAt || cachedDb.createdAt,
            },
            history,
            {
              domain: cachedDb.domain || extractDomain(E),
              provider: cachedDb.domainProvider || cachedDb.provider || "Unavailable",
            },
          );

          const subStatus = merged.sub_status || merged.subStatus || null;
          const rawStatus = merged.status || cachedDb.status || "Unknown";
          const rawCategory = merged.category || categoryFromStatus(rawStatus || "");
          const { status, category } = normalizeStatus(rawStatus, rawCategory);

          const confidence =
            typeof merged.confidence === "number"
              ? merged.confidence
              : typeof cachedDb.confidence === "number"
                ? cachedDb.confidence
                : null;

          const builtCached = buildReasonAndMessage(status, subStatus, {
            isDisposable: !!merged.isDisposable,
            isRoleBased: !!merged.isRoleBased,
            isFree: !!merged.isFree,
          });

          const domain = merged.domain || cachedDb.domain || extractDomain(E);
          const provider =
            merged.provider ||
            cachedDb.domainProvider ||
            cachedDb.provider ||
            "Unavailable";

          const payload = {
            email: E,
            status,
            subStatus,
            confidence,
            category,
            reason: merged.reason || builtCached.reasonLabel,
            message: merged.message || builtCached.message,
            domain,
            domainProvider: provider,
            isDisposable: !!merged.isDisposable,
            isFree: !!merged.isFree,
            isRoleBased: !!merged.isRoleBased,
            score: typeof merged.score === "number" ? merged.score : cachedDb.score ?? 0,
            timestamp: cachedDb.timestamp || new Date(),
            section: "single",
          };

          await replaceLatest(EmailLog, E, payload);
          await replaceLatest(UserEmailLog, E, payload);

          if (stableCache) {
            stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: payload });
          }

          const credits = await debitOneCreditIfNeeded(username, payload.status, E, idemKey, "single");

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
            sessionId,
            false,
            username,
            "single"
          );

          logger("db_cache", "Cache hit (fresh) → returning cached result", "info");

          return res.json({ ...payload, via: "db-cache", cached: true, credits });
        }
      }

      // ✅ Yash: bank/healthcare OR proofpoint => SendGrid direct
      const direct = await maybeSendgridDirectOrNull({ E, username, sessionId, idemKey, res });
      if (direct) return direct;

      // inflight guard
      const inflightKey = username ? `${username}:${E}` : E;
      if (inflight && inflight.has(inflightKey)) {
        logger("attach", "Another validation is already running; skipping duplicate", "info");
        return res.json({
          email: E,
          status: "In progress",
          category: "unknown",
          via: "smtp",
          inProgress: true,
        });
      }

      let resolveInflight;
      const p = new Promise((r) => (resolveInflight = r));
      inflight && inflight.set(inflightKey, p);

      try {
        logger("start", "Running SMTP validation", "info");
        const smtpResult = await validateSMTP(E, { logger });

        // ✅ Yash: if SMTP unknown => SendGrid fallback
        const fb = await maybeSendgridFallbackOnUnknown({
          E,
          username,
          sessionId,
          smtpRaw: smtpResult,
        });

        const rawToUse = fb?.sgTrueSendrResult || smtpResult;
        const viaLabel = fb?.via || "smtp";

        const history = await buildHistoryForEmail(E);
        const { EmailLog: UserEmailLog2 } = getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username,
        );

        return await finalizeAndRespond({
          E,
          rawResult: rawToUse,
          history,
          idemKey,
          username,
          sessionId,
          EmailLogModel: EmailLog,
          UserEmailLogModel: UserEmailLog2,
          via: viaLabel,
          cached: false,
          res,
          shouldCache: true,
        });
      } finally {
        inflight && inflight.delete(inflightKey);
        try {
          resolveInflight && resolveInflight();
        } catch (e) {}
      }
    } catch (err) {
      console.error("❌ /api/single/validate:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/single/verify-smart
  // (your existing flow: prelim -> if unknown, background stable)
  // Yash rules are applied:
  //   - direct sendgrid for bank/healthcare/proofpoint BEFORE SMTP
  //   - fallback sendgrid when SMTP says unknown
  // ────────────────────────────────────────────────────────────
  router.post("/verify-smart", async (req, res) => {
    let inflightKey = null;
    let resolveInflight = null;

    try {
      const idemKey =
        req.headers["x-idempotency-key"] ||
        (req.body && req.body.idempotencyKey) ||
        null;

      const { email, sessionId, username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!username) return res.status(400).json({ error: "Username is required" });

      const E = normEmail(email);
      const logger = mkLogger(sessionId, E, username);

      // credits check (idempotency aware)
      const user = await User.findOne({ username });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.credits <= 0) {
        const alreadyPaid = idemKey && idempoGet(username, E, idemKey);
        if (!alreadyPaid) return res.status(400).json({ error: "You don't have credits" });
      }

      // ─────────────────────────────────────────────────────────
      // 🇹🇼 .tw domain direct Risky (verify-smart): skip all validation.
      // ─────────────────────────────────────────────────────────
      if (isTwDomain(extractDomain(E))) {
        const twDomain = extractDomain(E);
        console.log(`[single][tw_direct_risky][verify-smart] ${E} → domain "${twDomain}" ends with .tw, returning Risky directly`);
        const { EmailLog: UserEmailLog2 } = getUserDb(mongoose, EmailLog, RegionStat, DomainReputation, username);
        const twPayload = {
          email: E, status: "Risky", subStatus: "tw_domain", confidence: 0.9,
          category: "risky", reason: "Restricted Country TLD",
          message: "This address belongs to a Taiwanese domain (.tw). SMTP probing is unreliable for .tw domains and sending cold emails is risky.",
          domain: twDomain, domainProvider: "Taiwan (.tw)", isDisposable: false,
          isFree: false, isRoleBased: false, score: 30, timestamp: new Date(), section: "single",
        };
        await replaceLatest(EmailLog, E, twPayload);
        await replaceLatest(UserEmailLog2, E, twPayload);
        if (stableCache) stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: twPayload });
        const twCredits = await debitOneCreditIfNeeded(username, twPayload.status, E, idemKey, "single");
        sendStatusToFrontend(E, twPayload.status, twPayload.timestamp, {
          domain: twPayload.domain, provider: twPayload.domainProvider,
          isDisposable: false, isFree: false, isRoleBased: false, score: twPayload.score,
          subStatus: twPayload.subStatus, confidence: twPayload.confidence,
          category: twPayload.category, message: twPayload.message, reason: twPayload.reason,
        }, sessionId, true, username, "single");
        await markPendingDone(username, E);
        return res.json({ ...twPayload, via: "tw-direct", cached: false, inProgress: false, credits: twCredits });
      }

      // OPTIONAL UI pending (does not affect validation logic)
      await upsertPendingJob({ username, email: E, idemKey, sessionId });

      // inflight guard EARLY
      inflightKey = username ? `${username}:${E}` : E;

      if (inflight && inflight.has(inflightKey)) {
        logger("attach", "Another verification is already running; attaching via WS", "info");
        return res.json({
          email: E,
          status: "In progress",
          category: "unknown",
          via: "smtp",
          inProgress: true,
        });
      }

      const p = new Promise((r) => (resolveInflight = r));
      inflight && inflight.set(inflightKey, p);

      const clearInflight = () => {
        try {
          inflight && inflight.delete(inflightKey);
        } catch (e) {}
        try {
          resolveInflight && resolveInflight();
        } catch (e) {}
      };

      // Freshest (global + user)
      const { best: cachedDb, UserEmailLog } = await getFreshestFromDBs(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        EmailLog,
        username,
        E,
      );

      if (cachedDb) {
        const fresh =
          Date.now() - (cachedDb.updatedAt || cachedDb.createdAt) <= FRESH_DB_MS;

        if (fresh) {
          await bumpUpdatedAt(EmailLog, E, "single");

          const history = await buildHistoryForEmail(E);
          const merged = mergeSMTPWithHistory(
            {
              status: cachedDb.status,
              subStatus: cachedDb.subStatus,
              category: cachedDb.category,
              score: cachedDb.score,
              domain: cachedDb.domain,
              provider: cachedDb.domainProvider || cachedDb.provider,
              isDisposable: cachedDb.isDisposable,
              isFree: cachedDb.isFree,
              isRoleBased: cachedDb.isRoleBased,
              confidence: cachedDb.confidence,
              timestamp: cachedDb.timestamp || cachedDb.updatedAt || cachedDb.createdAt,
            },
            history,
            {
              domain: cachedDb.domain || extractDomain(E),
              provider: cachedDb.domainProvider || cachedDb.provider || "Unavailable",
            },
          );

          const subStatus = merged.sub_status || merged.subStatus || null;
          const rawStatus = merged.status || cachedDb.status || "Unknown";
          const rawCategory = merged.category || categoryFromStatus(rawStatus || "");
          const { status, category } = normalizeStatus(rawStatus, rawCategory);

          const confidence =
            typeof merged.confidence === "number"
              ? merged.confidence
              : typeof cachedDb.confidence === "number"
                ? cachedDb.confidence
                : null;

          const builtCached = buildReasonAndMessage(status, subStatus, {
            isDisposable: !!merged.isDisposable,
            isRoleBased: !!merged.isRoleBased,
            isFree: !!merged.isFree,
          });

          const domain = merged.domain || cachedDb.domain || extractDomain(E);
          const provider =
            merged.provider ||
            cachedDb.domainProvider ||
            cachedDb.provider ||
            "Unavailable";

          const payload = {
            email: E,
            status,
            subStatus,
            confidence,
            category,
            reason: merged.reason || builtCached.reasonLabel,
            message: merged.message || builtCached.message,
            domain,
            domainProvider: provider,
            isDisposable: !!merged.isDisposable,
            isFree: !!merged.isFree,
            isRoleBased: !!merged.isRoleBased,
            score: typeof merged.score === "number" ? merged.score : cachedDb.score ?? 0,
            timestamp: cachedDb.timestamp || new Date(),
            section: "single",
          };

          await replaceLatest(EmailLog, E, payload);
          await replaceLatest(UserEmailLog, E, payload);

          if (stableCache) {
            stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: payload });
          }

          const credits = await debitOneCreditIfNeeded(username, payload.status, E, idemKey, "single");

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
            sessionId,
            false,
            username,
            "single"
          );

          await markPendingDone(username, E);
          logger("db_cache", "Cache hit (fresh) → returning cached result", "info");

          clearInflight();
          return res.json({
            ...payload,
            via: "db-cache",
            cached: true,
            inProgress: false,
            credits,
          });
        }
      }

      // stable cache hit (if you use it)
      const hit = stableCache ? stableCache.get(E) : null;
      if (hit && hit.until > Date.now()) {
        const { EmailLog: UserEmailLog2 } = getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username,
        );

        const historyHit = await buildHistoryForEmail(E);
        const mergedHit = mergeSMTPWithHistory(hit.result, historyHit, {
          domain: hit.result.domain || extractDomain(E),
          provider: hit.result.provider || hit.result.domainProvider || "Unavailable",
        });

        const subStatusH = mergedHit.sub_status || mergedHit.subStatus || null;
        const rawStatusH = mergedHit.status || hit.result.status || "Unknown";
        const rawCategoryH = mergedHit.category || categoryFromStatus(rawStatusH || "");
        const { status: statusH, category: categoryH } = normalizeStatus(rawStatusH, rawCategoryH);

        const confidenceH =
          typeof mergedHit.confidence === "number"
            ? mergedHit.confidence
            : typeof hit.result.confidence === "number"
              ? hit.result.confidence
              : null;

        const builtHit = buildReasonAndMessage(statusH, subStatusH, {
          isDisposable: !!mergedHit.isDisposable,
          isRoleBased: !!mergedHit.isRoleBased,
          isFree: !!mergedHit.isFree,
        });

        const domainH = mergedHit.domain || hit.result.domain || extractDomain(E);
        const providerH =
          mergedHit.provider ||
          hit.result.provider ||
          hit.result.domainProvider ||
          "Unavailable";

        await UserEmailLog2.findOneAndUpdate(
          { email: E },
          {
            $set: {
              email: E,
              status: statusH,
              subStatus: subStatusH || null,
              confidence: confidenceH,
              category: categoryH,
              reason: mergedHit.reason || builtHit.reasonLabel,
              message: mergedHit.message || builtHit.message,
              domain: domainH,
              domainProvider: providerH,
              isDisposable: !!mergedHit.isDisposable,
              isFree: !!mergedHit.isFree,
              isRoleBased: !!mergedHit.isRoleBased,
              score: typeof mergedHit.score === "number" ? mergedHit.score : hit.result.score ?? 0,
              timestamp: hit.result.timestamp || new Date(),
              section: "single",
            },
            $currentDate: { updatedAt: true },
          },
          { upsert: true, new: true },
        );

        // keep cache updated
        stableCache.set(E, {
          until: hit.until,
          result: {
            ...hit.result,
            status: statusH,
            subStatus: subStatusH,
            category: categoryH,
            confidence: confidenceH,
            domain: domainH,
            domainProvider: providerH,
            isDisposable: !!mergedHit.isDisposable,
            isFree: !!mergedHit.isFree,
            isRoleBased: !!mergedHit.isRoleBased,
          },
        });

        const credits = await debitOneCreditIfNeeded(username, statusH, E, idemKey, "single");

        sendStatusToFrontend(
          E,
          statusH,
          Date.now(),
          {
            domain: domainH,
            provider: providerH,
            isDisposable: !!mergedHit.isDisposable,
            isFree: !!mergedHit.isFree,
            isRoleBased: !!mergedHit.isRoleBased,
            score: typeof mergedHit.score === "number" ? mergedHit.score : hit.result.score ?? 0,
            subStatus: subStatusH,
            confidence: confidenceH,
            category: categoryH,
            message: mergedHit.message || builtHit.message,
            reason: mergedHit.reason || builtHit.reasonLabel,
          },
          sessionId,
          false,
          username,
          "single"
        );

        await markPendingDone(username, E);
        logger("stable_cache", "StableCache hit → returning cached result", "info");

        clearInflight();
        return res.json({
          email: E,
          status: statusH,
          subStatus: subStatusH,
          confidence: confidenceH,
          category: categoryH,
          domain: domainH,
          domainProvider: providerH,
          isDisposable: !!mergedHit.isDisposable,
          isFree: !!mergedHit.isFree,
          isRoleBased: !!mergedHit.isRoleBased,
          score: typeof mergedHit.score === "number" ? mergedHit.score : hit.result.score ?? 0,
          timestamp: hit.result.timestamp || new Date(),
          section: "single",
          via: "smtp-stable",
          cached: true,
          inProgress: false,
          credits,
        });
      }

      // ✅ Yash: direct SendGrid before SMTP (verify-smart too)
      const direct = await maybeSendgridDirectOrNull({ E, username, sessionId, idemKey, res });
      if (direct) {
        await markPendingDone(username, E);
        clearInflight();
        return direct;
      }

      // 1) PRELIM SMTP
      logger("start", "verify-smart: running prelim SMTP validation", "info");
      const prelimRawSmtp = await validateSMTP(E, { logger });

      // ✅ Yash: if SMTP unknown => SendGrid fallback (prefer SG result)
      const fb = await maybeSendgridFallbackOnUnknown({
        E,
        username,
        sessionId,
        smtpRaw: prelimRawSmtp,
      });

      const prelimRaw = fb?.sgTrueSendrResult || prelimRawSmtp;
      const prelimVia = fb?.via || "smtp";

      const history = await buildHistoryForEmail(E);
      const prelim = mergeSMTPWithHistory(prelimRaw, history, {
        domain: prelimRaw.domain || extractDomain(E),
        provider: prelimRaw.provider || prelimRaw.domainProvider || (fb ? "SendGrid (fallback)" : "Unavailable"),
      });

      const subStatusP = prelim.sub_status || prelim.subStatus || null;
      const rawStatusP = prelim.status || prelimRaw.status || "Unknown";
      const rawCategoryP = prelim.category || categoryFromStatus(rawStatusP || "");
      const { status: statusP, category: categoryP } = normalizeStatus(rawStatusP, rawCategoryP);

      const confidenceP =
        typeof prelim.confidence === "number"
          ? prelim.confidence
          : typeof prelimRaw.confidence === "number"
            ? prelimRaw.confidence
            : null;

      const builtPrelim = buildReasonAndMessage(statusP, subStatusP, {
        isDisposable: !!prelim.isDisposable,
        isRoleBased: !!prelim.isRoleBased,
        isFree: !!prelim.isFree,
      });

      const prelimPayload = {
        email: E,
        status: statusP,
        subStatus: subStatusP,
        confidence: confidenceP,
        category: categoryP,
        reason: prelim.reason || builtPrelim.reasonLabel,
        message: prelim.message || builtPrelim.message,
        domain: prelim.domain || extractDomain(E),
        domainProvider: prelim.provider || prelim.domainProvider || (fb ? "SendGrid (fallback)" : "Unavailable"),
        isDisposable: !!prelim.isDisposable,
        isFree: !!prelim.isFree,
        isRoleBased: !!prelim.isRoleBased,
        score: typeof prelim.score === "number" ? prelim.score : prelimRaw.score ?? 0,
        timestamp: new Date(),
        section: "single",
      };

      // ─────────────────────────────────────────────────────────
      // 🏦 Bank domain override (prelim stage)
      // ─────────────────────────────────────────────────────────
      if (prelimPayload.category === "valid" && hasBankWordInDomain(prelimPayload.domain)) {
        console.log(`[single][bank_override][prelim] ${E} → domain "${prelimPayload.domain}" contains "bank", overriding Valid → Risky`);
        prelimPayload.status = "Risky";
        prelimPayload.category = "risky";
        prelimPayload.subStatus = "bank_domain";
        prelimPayload.score = Math.min(prelimPayload.score, 45);
        prelimPayload.reason = "Banking Domain";
        prelimPayload.message = "This address belongs to a banking/financial domain. Sending cold emails to banking domains is risky and may result in blocks or bounces.";
      }

      // ─────────────────────────────────────────────────────────
      // 🏛️ .org / .edu / .gov domain override (prelim stage)
      // ─────────────────────────────────────────────────────────
      if (prelimPayload.category !== "invalid" && isOrgEduGovDomain(prelimPayload.domain)) {
        console.log(`[single][org_edu_gov_override][prelim] ${E} → domain "${prelimPayload.domain}" ends with .org/.edu/.gov/.mx/.tw, overriding ${prelimPayload.category} → Risky`);
        prelimPayload.status = "Risky";
        prelimPayload.category = "risky";
        prelimPayload.subStatus = "org_edu_gov_domain";
        prelimPayload.score = Math.min(prelimPayload.score, 45);
        prelimPayload.reason = "Restricted Domain TLD";
        prelimPayload.message = "This address belongs to an organizational, educational, government, or country-specific domain (.org/.edu/.gov/.mx). Sending cold emails to these domains is risky and may result in blocks or bounces.";
      }

      await replaceLatest(EmailLog, E, prelimPayload);
      await replaceLatest(UserEmailLog, E, prelimPayload);

      sendStatusToFrontend(
        E,
        prelimPayload.status,
        prelimPayload.timestamp,
        {
          domain: prelimPayload.domain,
          provider: prelimPayload.domainProvider,
          isDisposable: prelimPayload.isDisposable,
          isFree: prelimPayload.isFree,
          isRoleBased: prelimPayload.isRoleBased,
          score: prelimPayload.score,
          subStatus: prelimPayload.subStatus,
          confidence: prelimPayload.confidence,
          category: prelimPayload.category,
          message: prelimPayload.message,
          reason: prelimPayload.reason,
        },
        sessionId,
        true,
        username,
        "single"
      );

      const credits = await debitOneCreditIfNeeded(username, prelimPayload.status, E, idemKey, "single");

      const prelimCat = categoryFromStatus(prelimPayload.status);
      if (["valid", "invalid", "risky"].includes(prelimCat)) {
        if (stableCache) {
          stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: prelimPayload });
        }
        await markPendingDone(username, E);

        logger("final", `verify-smart resolved at prelim stage (${prelimCat})`, "info");

        clearInflight();
        return res.json({ ...prelimPayload, via: prelimVia, inProgress: false, credits });
      }

      // Unknown → background stabilization
      await upsertPendingJob({ username, email: E, idemKey, sessionId });

      // respond immediately (existing behavior)
      res.json({ ...prelimPayload, via: prelimVia, inProgress: true, credits });

      // keep inflight until background finishes
      (async () => {
        try {
          logger("stabilize_start", "Running SMTP-stable (background)", "info");
          const finalRaw = await validateSMTPStable(E, { logger });

          // OPTIONAL: apply Yash fallback again if stable also unknown
          const fb2 = await maybeSendgridFallbackOnUnknown({
            E,
            username,
            sessionId,
            smtpRaw: finalRaw,
          });

          const rawToUse = fb2?.sgTrueSendrResult || finalRaw;

          const historyFinal = await buildHistoryForEmail(E);
          const final = mergeSMTPWithHistory(rawToUse, historyFinal, {
            domain: rawToUse.domain || extractDomain(E),
            provider:
              rawToUse.provider ||
              rawToUse.domainProvider ||
              (fb2 ? "SendGrid (fallback)" : "Unavailable"),
          });

          const subStatusF = final.sub_status || final.subStatus || null;
          const rawStatusF = final.status || rawToUse.status || "Unknown";
          const rawCategoryF = final.category || categoryFromStatus(rawStatusF || "");
          const { status: statusF, category: categoryF } = normalizeStatus(rawStatusF, rawCategoryF);

          const confidenceF =
            typeof final.confidence === "number"
              ? final.confidence
              : typeof rawToUse.confidence === "number"
                ? rawToUse.confidence
                : null;

          const builtFinal = buildReasonAndMessage(statusF, subStatusF, {
            isDisposable: !!final.isDisposable,
            isRoleBased: !!final.isRoleBased,
            isFree: !!final.isFree,
          });

          const finalPayload = {
            email: E,
            status: statusF,
            subStatus: subStatusF,
            confidence: confidenceF,
            category: categoryF,
            reason: final.reason || builtFinal.reasonLabel,
            message: final.message || builtFinal.message,
            domain: final.domain || prelimPayload.domain,
            domainProvider:
              final.provider ||
              final.domainProvider ||
              prelimPayload.domainProvider ||
              "Unavailable",
            isDisposable: !!final.isDisposable,
            isFree: !!final.isFree,
            isRoleBased: !!final.isRoleBased,
            score: typeof final.score === "number" ? final.score : prelimPayload.score ?? 0,
            timestamp: new Date(),
            section: "single",
          };

          // ─────────────────────────────────────────────────────────
          // 🏦 Bank domain override (stable background stage)
          // ─────────────────────────────────────────────────────────
          if (finalPayload.category === "valid" && hasBankWordInDomain(finalPayload.domain)) {
            console.log(`[single][bank_override][stable] ${E} → domain "${finalPayload.domain}" contains "bank", overriding Valid → Risky`);
            finalPayload.status = "Risky";
            finalPayload.category = "risky";
            finalPayload.subStatus = "bank_domain";
            finalPayload.score = Math.min(finalPayload.score, 45);
            finalPayload.reason = "Banking Domain";
            finalPayload.message = "This address belongs to a banking/financial domain. Sending cold emails to banking domains is risky and may result in blocks or bounces.";
          }

          // ─────────────────────────────────────────────────────────
          // 🏛️ .org / .edu / .gov domain override (stable background stage)
          // ─────────────────────────────────────────────────────────
          if (finalPayload.category !== "invalid" && isOrgEduGovDomain(finalPayload.domain)) {
            console.log(`[single][org_edu_gov_override][stable] ${E} → domain "${finalPayload.domain}" ends with .org/.edu/.gov/.mx/.tw, overriding ${finalPayload.category} → Risky`);
            finalPayload.status = "Risky";
            finalPayload.category = "risky";
            finalPayload.subStatus = "org_edu_gov_domain";
            finalPayload.score = Math.min(finalPayload.score, 45);
            finalPayload.reason = "Restricted Domain TLD";
            finalPayload.message = "This address belongs to an organizational, educational, government, or country-specific domain (.org/.edu/.gov/.mx). Sending cold emails to these domains is risky and may result in blocks or bounces.";
          }

          await replaceLatest(EmailLog, E, finalPayload);
          await replaceLatest(UserEmailLog, E, finalPayload);

          if (stableCache && /Valid|Invalid|Risky/i.test(finalPayload.status)) {
            stableCache.set(E, { until: Date.now() + (CACHE_TTL_MS || 0), result: finalPayload });
          }

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
            sessionId,
            true,
            username,
            "single"
          );

          logger("stabilize_done", `SMTP-stable finished → ${finalPayload.status}`, "info");
        } catch (e) {
          logger("stabilize_error", `SMTP-stable failed: ${e.message}`, "warn");
        } finally {
          await markPendingDone(username, E);
          try {
            inflight && inflight.delete(inflightKey);
          } catch (e) {}
          try {
            resolveInflight && resolveInflight();
          } catch (e) {}
        }
      })();
    } catch (err) {
      console.error("❌ /api/single/verify-smart:", err.message);
      try {
        if (inflight && inflightKey) inflight.delete(inflightKey);
      } catch (e) {}
      try {
        resolveInflight && resolveInflight();
      } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/single/clear-history (unchanged)
  // ────────────────────────────────────────────────────────────
  router.post("/clear-history", async (req, res) => {
    try {
      const { username } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!username) {
        return res.status(400).json({ success: false, error: "Username required" });
      }

      const now = new Date();
      const updatedUser = await User.findOneAndUpdate(
        { username },
        { singleTimestamp: now },
        { new: true },
      );

      if (!updatedUser) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      res.json({
        success: true,
        message: "Single validation history cleared",
        singleTimestamp: updatedUser.singleTimestamp,
      });
    } catch (err) {
      console.error("❌ /api/single/clear-history:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/single/pending (kept for your frontend; safe if SinglePending not provided)
  // ────────────────────────────────────────────────────────────
  router.post("/pending", async (req, res) => {
    try {
      const { username } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!username) return res.status(400).json({ ok: false, error: "Username is required" });

      if (!SinglePending) return res.json({ ok: true, pendings: [] });

      const pendings = await SinglePending.find({ username, status: "in_progress" })
        .sort({ createdAt: -1 })
        .lean();

      res.json({ ok: true, pendings });
    } catch (err) {
      console.error("❌ /api/single/pending:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/single/history (kept as your existing flow)
  // ────────────────────────────────────────────────────────────
  router.post("/history", async (req, res) => {
    try {
      const { username, limit: rawLimit = 50, pageSize } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!username) {
        return res.status(400).json({ success: false, error: "Username is required" });
      }

      const user = await User.findOne({ username });
      if (!user) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const limit = rawLimit || pageSize || 50;

      const { EmailLog: UserEmailLog } = getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
      );

      const query = { section: "single" };
      if (user.singleTimestamp) {
        query.$or = [
          { updatedAt: { $gt: new Date(user.singleTimestamp) } },
          {
            $and: [
              { updatedAt: { $exists: false } },
              { createdAt: { $gt: new Date(user.singleTimestamp) } },
            ],
          },
        ];
      }

      let validations = await UserEmailLog.find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit * 2);

      // filter out pending in_progress if model exists
      let inProgressSet = new Set();
      if (SinglePending) {
        const pendings = await SinglePending.find({ username, status: "in_progress" })
          .select("email")
          .lean();

        inProgressSet = new Set(
          pendings
            .map((p) => (p && p.email ? normEmail(p.email) : null))
            .filter(Boolean),
        );
      }

      validations = validations.filter((v) => {
        const e = normEmail(v.email);
        return !inProgressSet.has(e);
      });

      validations = validations.filter((v) => {
        const cat = catFromStatus(v.status || "");
        if (cat === "unknown") return false;
        const s = String(v.status || "");
        if (/in\s*progress/i.test(s)) return false;
        return true;
      });

      const formatted = validations.slice(0, limit).map((v) => {
        const built = buildReasonAndMessage(v.status || "", v.subStatus || null, {
          isDisposable: !!v.isDisposable,
          isRoleBased: !!v.isRoleBased,
          isFree: !!v.isFree,
        });

        return {
          id: v._id,
          email: v.email,
          status: v.status || "Unknown",
          subStatus: v.subStatus || null,
          confidence: typeof v.confidence === "number" ? v.confidence : null,
          category: v.category || categoryFromStatus(v.status || ""),
          domain: v.domain || "N/A",
          provider: v.domainProvider || v.provider || "Unavailable",
          isDisposable: !!v.isDisposable,
          isFree: !!v.isFree,
          isRoleBased: !!v.isRoleBased,
          score: v.score != null ? v.score : 0,
          timestamp: (v.updatedAt || v.createdAt || v.timestamp || null)?.toISOString(),
          message: v.message || built.message,
        };
      });

      res.json({ success: true, count: formatted.length, data: formatted });
    } catch (err) {
      console.error("❌ /api/single/history:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
