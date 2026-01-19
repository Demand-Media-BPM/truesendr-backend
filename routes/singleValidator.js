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

module.exports = function singleValidatorRouter(deps) {
  const {
    // libs / models
    mongoose,
    EmailLog,
    RegionStat,
    DomainReputation,
    User,
    SinglePending,
    // utils
    categoryFromStatus,
    normEmail,
    buildReasonAndMessage,
    getFreshestFromDBs,
    replaceLatest,
    bumpUpdatedAt,
    // runtime config / state
    FRESH_DB_MS,
    stableCache,
    inflight,
    // validators
    validateSMTP,
    validateSMTPStable,
    // credits / idempotency
    debitOneCreditIfNeeded,
    idempoGet,
    // ws helpers
    sendLogToFrontend,
    sendStatusToFrontend,
  } = deps;

  // ────────────────────────────────────────────────────────────
  // Pending job helpers – one row per (username, email) job
  // ────────────────────────────────────────────────────────────
  async function upsertPendingJob({ username, email, idemKey, sessionId }) {
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
      { upsert: true, new: true }
    );
  }

  async function markPendingDone(username, email) {
    if (!username || !email) return;
    await SinglePending.updateOne(
      { username, email },
      { $set: { status: "done" } }
    );
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

    // ----- domain / provider invalid-rate -----
    if (stats && stats.sent && stats.sent > 0) {
      const domainSamples = stats.sent;
      const domainInvalidRate =
        typeof stats.invalid === "number" && stats.sent > 0
          ? stats.invalid / stats.sent
          : null;

      if (domainInvalidRate !== null) {
        history.domainInvalidRate = domainInvalidRate;
        history.domainSamples = domainSamples;

        // Mirror to provider for now
        history.providerInvalidRate = domainInvalidRate;
        history.providerSamples = domainSamples;
      }
    }

    // ----- TrainingSample: lastLabel + counts -----
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
      history.trainingLabel = ts.lastLabel || null; // alias for merge helper
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
  // Helper: build payload + send + cache + debit
  // (used in both /validate and /verify-smart branches)
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
      merged.provider ||
      merged.domainProvider ||
      rawResult.domainProvider ||
      "Unavailable";

    const payload = {
      email: E,
      status,
      subStatus,
      confidence,
      category,
      reason: built.reasonLabel,
      message: built.message,
      domain,
      domainProvider: provider,
      isDisposable: !!merged.isDisposable,
      isFree: !!merged.isFree,
      isRoleBased: !!merged.isRoleBased,
      score:
        typeof merged.score === "number" ? merged.score : rawResult.score ?? 0,
      timestamp:
        rawResult.timestamp instanceof Date ? rawResult.timestamp : new Date(),
      section: "single",
    };

    // persist in both global and user DBs
    await replaceLatest(EmailLogModel, E, payload);
    await replaceLatest(UserEmailLogModel, E, payload);

    // in-memory cache if needed
    if (shouldCache) {
      stableCache.set(E, {
        until: Date.now() + deps.CACHE_TTL_MS,
        result: payload,
      });
    }

    const credits = await debitOneCreditIfNeeded(
      username,
      payload.status,
      E,
      idemKey,
      "single"
    );

    // push to WS
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
      username
    );

    return res.json({
      ...payload,
      via,
      cached,
      credits,
    });
  }

  // POST /api/single/validate   (old: /validate-email)
  router.post("/validate", async (req, res) => {
    const idemKey =
      req.headers["x-idempotency-key"] ||
      (req.body && req.body.idempotencyKey) ||
      null;

    try {
      const { email, sessionId, username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!username)
        return res.status(400).json({ error: "Username is required" });

      const E = normEmail(email);

      // credits must exist (still won't charge for Unknown)
      const user = await User.findOne({ username });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.credits <= 0) {
        const alreadyPaid = idemKey && idempoGet(username, E, idemKey);
        if (!alreadyPaid)
          return res.status(400).json({ error: "You don't have credits" });
      }

      // Freshest cache (global + user)
      const { best: cachedDb, UserEmailLog } = await getFreshestFromDBs(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        EmailLog,
        username,
        E
      );
      if (cachedDb) {
        const fresh =
          Date.now() - (cachedDb.updatedAt || cachedDb.createdAt) <=
          FRESH_DB_MS;

        if (fresh) {
          await bumpUpdatedAt(EmailLog, E, "single");

          // build history & merge cached DB with training/domain history
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
              timestamp:
                cachedDb.timestamp || cachedDb.updatedAt || cachedDb.createdAt,
            },
            history,
            {
              domain: cachedDb.domain || extractDomain(E),
              provider:
                cachedDb.domainProvider || cachedDb.provider || "Unavailable",
            }
          );

          const subStatus = merged.sub_status || merged.subStatus || null;
          const rawStatus = merged.status || cachedDb.status || "Unknown";
          const rawCategory =
            merged.category || categoryFromStatus(rawStatus || "");
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
            score:
              typeof merged.score === "number"
                ? merged.score
                : cachedDb.score ?? 0,
            timestamp: cachedDb.timestamp || new Date(),
            section: "single",
          };

          // sync back merged view into both DBs
          await replaceLatest(EmailLog, E, payload);
          await replaceLatest(UserEmailLog, E, payload);

          stableCache.set(E, {
            until: Date.now() + deps.CACHE_TTL_MS,
            result: payload,
          });

          const credits = await debitOneCreditIfNeeded(
            username,
            payload.status,
            E,
            idemKey,
            "single"
          );

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
            username
          );

          return res.json({
            ...payload,
            via: "db-cache",
            cached: true,
            credits,
          });
        }
      }

      // in-flight guard (per user+email)
      const inflightKey = username ? `${username}:${E}` : E;

      if (inflight.has(inflightKey)) {
        sendLogToFrontend(
          sessionId,
          E,
          "Another validation is already running; skipping duplicate",
          "attach",
          "info",
          username
        );
        return res.json({
          email: E,
          status: "⏳ In progress",
          category: "unknown",
          via: "smtp",
          inProgress: true,
        });
      }

      let resolveInflight;
      const p = new Promise((r) => (resolveInflight = r));
      inflight.set(inflightKey, p);

      try {
        const logger = (step, message, level = "info") =>
          sendLogToFrontend(sessionId, E, message, step, level, username);

        const result = await deps.validateSMTP(E, { logger });
        const history = await buildHistoryForEmail(E);

        // Use shared helper to merge + persist + respond
        const { EmailLog: UserEmailLog2 } = deps.getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username
        );

        return await finalizeAndRespond({
          E,
          rawResult: result,
          history,
          idemKey,
          username,
          sessionId,
          EmailLogModel: EmailLog,
          UserEmailLogModel: UserEmailLog2,
          via: "smtp",
          cached: false,
          res,
          shouldCache: true,
        });
      } finally {
        inflight.delete(inflightKey);
        resolveInflight();
      }
    } catch (err) {
      console.error("❌ /api/single/validate:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/single/verify-smart   (old: /verify-smart)
  router.post("/verify-smart", async (req, res) => {
    try {
      const idemKey =
        req.headers["x-idempotency-key"] ||
        (req.body && req.body.idempotencyKey) ||
        null;

      const { email, sessionId, username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!username)
        return res.status(400).json({ error: "Username is required" });

      const E = normEmail(email);

      const user = await User.findOne({ username });
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.credits <= 0) {
        const alreadyPaid = idemKey && deps.idempoGet(username, E, idemKey);
        if (!alreadyPaid)
          return res.status(400).json({ error: "You don't have credits" });
      }

      // Create/refresh a pending job row for this (username, email).
      // This makes the job visible in /pending immediately, so loaders
      // can be restored after refresh / tab switch / logout+login.
      await upsertPendingJob({ username, email: E, idemKey, sessionId });

      // freshest (global + user)
      const { best: cachedDb, UserEmailLog } = await getFreshestFromDBs(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        EmailLog,
        username,
        E
      );
      if (cachedDb) {
        const fresh =
          Date.now() - (cachedDb.updatedAt || cachedDb.createdAt) <=
          FRESH_DB_MS;

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
              timestamp:
                cachedDb.timestamp || cachedDb.updatedAt || cachedDb.createdAt,
            },
            history,
            {
              domain: cachedDb.domain || extractDomain(E),
              provider:
                cachedDb.domainProvider || cachedDb.provider || "Unavailable",
            }
          );

          const subStatus = merged.sub_status || merged.subStatus || null;
          const rawStatus = merged.status || cachedDb.status || "Unknown";
          const rawCategory =
            merged.category || categoryFromStatus(rawStatus || "");
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
            score:
              typeof merged.score === "number"
                ? merged.score
                : cachedDb.score ?? 0,
            timestamp: cachedDb.timestamp || new Date(),
            section: "single",
          };

          await replaceLatest(EmailLog, E, payload);
          await replaceLatest(UserEmailLog, E, payload);

          stableCache.set(E, {
            until: Date.now() + deps.CACHE_TTL_MS,
            result: payload,
          });

          const credits = await debitOneCreditIfNeeded(
            username,
            payload.status,
            E,
            idemKey,
            "single"
          );

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
            username
          );

          // cache hit is a "finished" job -> mark as done
          await markPendingDone(username, E);

          const pending = await SinglePending.findOne({
            username,
            email: E,
            status: "in_progress",
          }).lean();

          const isUnknown = categoryFromStatus(payload.status) === "unknown";
          const inProgressFlag = !!(pending && isUnknown);

          return res.json({
            ...payload,
            via: "db-cache",
            cached: true,
            inProgress: inProgressFlag,
            credits,
          });
        }
      }

      // short cache?
      const hit = stableCache.get(E);
      if (hit && hit.until > Date.now()) {
        const { EmailLog: UserEmailLog2 } = deps.getUserDb(
          mongoose,
          EmailLog,
          RegionStat,
          DomainReputation,
          username
        );

        const historyHit = await buildHistoryForEmail(E);
        const mergedHit = mergeSMTPWithHistory(hit.result, historyHit, {
          domain: hit.result.domain || extractDomain(E),
          provider:
            hit.result.provider || hit.result.domainProvider || "Unavailable",
        });

        const subStatusH = mergedHit.sub_status || mergedHit.subStatus || null;
        const rawStatusH = mergedHit.status || hit.result.status || "Unknown";
        const rawCategoryH =
          mergedHit.category || categoryFromStatus(rawStatusH || "");
        const { status: statusH, category: categoryH } = normalizeStatus(
          rawStatusH,
          rawCategoryH
        );

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

        const domainH =
          mergedHit.domain || hit.result.domain || extractDomain(E);
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
              score:
                typeof mergedHit.score === "number"
                  ? mergedHit.score
                  : hit.result.score ?? 0,
              timestamp: hit.result.timestamp || new Date(),
              section: "single",
            },
            $currentDate: { updatedAt: true },
          },
          { upsert: true, new: true }
        );

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

        const credits = await debitOneCreditIfNeeded(
          username,
          statusH,
          E,
          idemKey,
          "single"
        );

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
            score:
              typeof mergedHit.score === "number"
                ? mergedHit.score
                : hit.result.score ?? 0,
            subStatus: subStatusH,
            confidence: confidenceH,
            category: categoryH,
            message: mergedHit.message || builtHit.message,
            reason: mergedHit.reason || builtHit.reasonLabel,
          },
          sessionId,
          false,
          username
        );

        await markPendingDone(username, E);

        const pending = await SinglePending.findOne({
          username,
          email: E,
          status: "in_progress",
        }).lean();

        const inProgressFlag = !!(pending && categoryH === "unknown");

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
          score:
            typeof mergedHit.score === "number"
              ? mergedHit.score
              : hit.result.score ?? 0,
          timestamp: hit.result.timestamp || new Date(),
          section: "single",
          via: "smtp-stable",
          cached: true,
          inProgress: inProgressFlag,
          credits,
        });
      }

      // in-flight guard (per user+email)
      const inflightKey = username ? `${username}:${E}` : E;

      if (inflight.has(inflightKey)) {
        sendLogToFrontend(
          sessionId,
          E,
          "Another verification is already running; attaching via WS",
          "attach",
          "info",
          username
        );
        return res.json({
          email: E,
          status: "⏳ In progress",
          category: "unknown",
          via: "smtp",
          inProgress: true,
        });
      }

      const logger = (step, message, level = "info") =>
        sendLogToFrontend(sessionId, E, message, step, level, username);

      // ────────────────────────────────────────────────────────
      // 1) PRELIM SMTP + history merge
      // ────────────────────────────────────────────────────────
      const prelimRaw = await validateSMTP(E, { logger });
      const history = await buildHistoryForEmail(E);
      const prelim = mergeSMTPWithHistory(prelimRaw, history, {
        domain: prelimRaw.domain || extractDomain(E),
        provider: prelimRaw.provider || "Unavailable",
      });

      const subStatusP = prelim.sub_status || prelim.subStatus || null;
      const rawStatusP = prelim.status || prelimRaw.status || "Unknown";
      const rawCategoryP =
        prelim.category || categoryFromStatus(rawStatusP || "");
      const { status: statusP, category: categoryP } = normalizeStatus(
        rawStatusP,
        rawCategoryP
      );

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
        reason: builtPrelim.reasonLabel,
        message: builtPrelim.message,
        domain: prelim.domain || extractDomain(E),
        domainProvider: prelim.provider || "Unavailable",
        isDisposable: !!prelim.isDisposable,
        isFree: !!prelim.isFree,
        isRoleBased: !!prelim.isRoleBased,
        score:
          typeof prelim.score === "number"
            ? prelim.score
            : prelimRaw.score ?? 0,
        timestamp: new Date(),
        section: "single",
      };

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
        username
      );

      const credits = await debitOneCreditIfNeeded(
        username,
        prelimPayload.status,
        E,
        idemKey,
        "single"
      );

      const prelimCat = categoryFromStatus(prelimPayload.status);
      if (["valid", "invalid", "risky"].includes(prelimCat)) {
        stableCache.set(E, {
          until: Date.now() + deps.CACHE_TTL_MS,
          result: prelimPayload,
        });

        await markPendingDone(username, E);

        return res.json({
          ...prelimPayload,
          via: "smtp",
          inProgress: false,
          credits,
        });
      }

      // Unknown → background stabilization, keep job as in_progress
      await SinglePending.findOneAndUpdate(
        { username, email: E },
        {
          username,
          email: E,
          idemKey,
          sessionId,
          status: "in_progress",
        },
        { upsert: true, new: true }
      );

      // return Unknown prelim; stabilize in background
      res.json({
        ...prelimPayload,
        via: "smtp",
        inProgress: true,
        credits,
      });

      let resolveInflight;
      const p2 = new Promise((r) => (resolveInflight = r));
      inflight.set(inflightKey, p2);

      (async () => {
        try {
          // ────────────────────────────────────────────────
          // 2) FINAL SMTP-STABLE + history merge
          // ────────────────────────────────────────────────
          const finalRaw = await validateSMTPStable(E, { logger });
          const historyFinal = await buildHistoryForEmail(E);
          const final = mergeSMTPWithHistory(finalRaw, historyFinal, {
            domain: finalRaw.domain || extractDomain(E),
            provider: finalRaw.provider || "Unavailable",
          });

          const subStatusF = final.sub_status || final.subStatus || null;
          const rawStatusF = final.status || finalRaw.status || "Unknown";
          const rawCategoryF =
            final.category || categoryFromStatus(rawStatusF || "");
          const { status: statusF, category: categoryF } = normalizeStatus(
            rawStatusF,
            rawCategoryF
          );

          const confidenceF =
            typeof final.confidence === "number"
              ? final.confidence
              : typeof finalRaw.confidence === "number"
              ? finalRaw.confidence
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
            reason: builtFinal.reasonLabel,
            message: builtFinal.message,
            domain: final.domain || prelimPayload.domain,
            domainProvider:
              final.provider || prelimPayload.domainProvider || "Unavailable",
            isDisposable: !!final.isDisposable,
            isFree: !!final.isFree,
            isRoleBased: !!final.isRoleBased,
            score:
              typeof final.score === "number"
                ? final.score
                : prelimPayload.score ?? 0,
            timestamp: new Date(),
            section: "single",
          };

          await replaceLatest(EmailLog, E, finalPayload);
          await replaceLatest(UserEmailLog, E, finalPayload);

          if (/Valid|Invalid|Risky/i.test(finalPayload.status)) {
            stableCache.set(E, {
              until: Date.now() + deps.CACHE_TTL_MS,
              result: finalPayload,
            });
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
            username
          );
        } finally {
          await markPendingDone(username, E);
          inflight.delete(inflightKey);
          resolveInflight();
        }
      })();
    } catch (err) {
      console.error("❌ /api/single/verify-smart:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/single/clear-history   (old: /clear-single-history)
  router.post("/clear-history", async (req, res) => {
    try {
      const { username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!username)
        return res
          .status(400)
          .json({ success: false, error: "Username required" });

      const now = new Date();
      const updatedUser = await User.findOneAndUpdate(
        { username },
        { singleTimestamp: now },
        { new: true }
      );
      if (!updatedUser)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

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

  // POST /api/single/pending  – get current in-progress single validations
  router.post("/pending", async (req, res) => {
    try {
      const { username } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!username)
        return res
          .status(400)
          .json({ ok: false, error: "Username is required" });

      // You can choose: latest only, or all. Let's return all in-progress for that user.
      const pendings = await SinglePending.find({
        username,
        status: "in_progress",
      })
        .sort({ createdAt: -1 })
        .lean();

      res.json({ ok: true, pendings });
    } catch (err) {
      console.error("❌ /api/single/pending:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/single/history  (old: /single-validation-history)
  router.post("/history", async (req, res) => {
    try {
      const {
        username,
        limit: rawLimit = 50,
        pageSize, // for compatibility with old frontend shape
      } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!username)
        return res
          .status(400)
          .json({ success: false, error: "Username is required" });

      const user = await User.findOne({ username });
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User not found" });

      // final limit: prefer explicit limit, then pageSize, else 50
      const limit = rawLimit || pageSize || 50;

      const { EmailLog: UserEmailLog } = deps.getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username
      );

      // ---- 1) Base query (respect singleTimestamp) ----
      const query = {section: "single"};
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

      // ---- 2) Pull latest logs from user DB ----
      let validations = await UserEmailLog.find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit * 2); // little buffer, we'll filter below

      // ---- 3) Get currently in-progress jobs for this user ----
      const pendings = await SinglePending.find({
        username,
        status: "in_progress",
      })
        .select("email")
        .lean();

      const inProgressSet = new Set(
        pendings
          .map((p) => (p && p.email ? normEmail(p.email) : null))
          .filter(Boolean)
      );

      // ---- 4) Remove any email that is currently pending ----
      validations = validations.filter((v) => {
        const e = normEmail(v.email);
        return !inProgressSet.has(e);
      });

      // ---- 5) Extra safety: hide Unknown / "in progress" snapshots ----
      validations = validations.filter((v) => {
        const cat = catFromStatus(v.status || "");
        // hide unknown category completely from history
        if (cat === "unknown") return false;

        // if your status has any "⏳ In progress" text, hide that too
        const s = String(v.status || "");
        if (/in\s*progress/i.test(s)) return false;

        return true;
      });

      // ---- 6) Map to response format ----
      const formatted = validations.slice(0, limit).map((v) => {
        const built = buildReasonAndMessage(
          v.status || "",
          v.subStatus || null,
          {
            isDisposable: !!v.isDisposable,
            isRoleBased: !!v.isRoleBased,
            isFree: !!v.isFree,
          }
        );
        return {
          id: v._id,
          email: v.email,
          status: v.status || "❔ Unknown",
          subStatus: v.subStatus || null,
          confidence: typeof v.confidence === "number" ? v.confidence : null,
          category: v.category || categoryFromStatus(v.status || ""),
          domain: v.domain || "N/A",
          provider: v.domainProvider || v.provider || "Unavailable",
          isDisposable: !!v.isDisposable,
          isFree: !!v.isFree,
          isRoleBased: !!v.isRoleBased,
          score: v.score != null ? v.score : 0,
          timestamp: (
            v.updatedAt ||
            v.createdAt ||
            v.timestamp ||
            null
          )?.toISOString(),
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
