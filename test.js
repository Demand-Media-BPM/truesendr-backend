// storage-and-routes.js

const upsertQueues = new Map();

// ────────── Deterministic comparison helpers ──────────
function rankCategory(cat) {
  const c = String(cat || 'unknown').toLowerCase();
  // definitive invalid outranks everything, then valid, then risky, then unknown
  return ({ invalid: 4, valid: 3, risky: 2, unknown: 1 })[c] || 0;
}
function rankSubStatus(cat, sub) {
  const c = String(cat || 'unknown').toLowerCase();
  const s = String(sub || '');

  if (c === 'valid') {
    // prefer accepted > owner_verified > other valid
    if (/accepted/.test(s)) return 3;
    if (/owner_verified/.test(s)) return 2;
    return 1;
  }
  if (c === 'risky') {
    // gateway_protected > policy_block > catch_all > other risky
    if (/gateway_protected/.test(s)) return 4;
    if (/policy_block/.test(s)) return 3;
    if (/catch_all/.test(s)) return 2;
    return 1;
  }
  if (c === 'invalid') {
    // mailbox_not_found > other 5xx
    if (/mailbox_not_found/.test(s)) return 2;
    return 1;
  }
  return 0;
}
function isBetter(newDoc, oldDoc) {
  if (!oldDoc) return true;

  const nc = String(newDoc.category || 'unknown').toLowerCase();
  const oc = String(oldDoc.category || 'unknown').toLowerCase();

  // 1) Category
  const catDelta = rankCategory(nc) - rankCategory(oc);
  if (catDelta !== 0) return catDelta > 0;

  // 2) Sub-status (category-specific nuance)
  const ns = String(newDoc.sub_status || '');
  const os = String(oldDoc.sub_status || '');
  const subDelta = rankSubStatus(nc, ns) - rankSubStatus(oc, os);
  if (subDelta !== 0) return subDelta > 0;

  // 3) Provisional flag: definitive beats provisional
  const nProv = !!newDoc.provisional;
  const oProv = !!oldDoc.provisional;
  if (nProv !== oProv) return oProv && !nProv;

  // 4) Confidence (higher wins)
  const nConf = typeof newDoc.confidence === 'number' ? newDoc.confidence : 0;
  const oConf = typeof oldDoc.confidence === 'number' ? oldDoc.confidence : 0;
  if (nConf !== oConf) return nConf > oConf;

  // 5) Score (higher wins)
  const nScore = typeof newDoc.score === 'number' ? newDoc.score : 0;
  const oScore = typeof oldDoc.score === 'number' ? oldDoc.score : 0;
  if (nScore !== oScore) return nScore > oScore;

  // 6) Final tie → prefer the incoming (newer) write
  return true;
}

async function safeUpsertEmail(email, newData, userDb) {
  const key = String(email).toLowerCase();

  // chain per-email upserts inside this Node process
  const lastPromise = upsertQueues.get(key) || Promise.resolve();

  const thisPromise = lastPromise.then(async () => {
    let existing = await EmailLog.findOne({ email: key });

    let shouldUpdate = isBetter(newData, existing);

    if (!shouldUpdate) {
      console.log(
        `[safeUpsertEmail] ⏭ Skipping update for ${key} (existing category=${existing?.category}, score=${existing?.score}, confidence=${existing?.confidence})`
      );
      return;
    }

    console.log(
      `[safeUpsertEmail] Preparing to update ${key} -> existing: { category: ${existing?.category}, sub_status: ${existing?.sub_status}, score: ${existing?.score}, conf: ${existing?.confidence} } new: { category: ${newData?.category}, sub_status: ${newData?.sub_status}, score: ${newData?.score}, conf: ${newData?.confidence}, provisional: ${!!newData?.provisional} }`
    );

    // Always bump updatedAt so cache freshness works consistently
    try {
      await EmailLog.findOneAndUpdate(
        { email: key },
        {
          $set: newData,
          $currentDate: { updatedAt: true, timestamp: true },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      if (err.code === 11000) {
        console.warn(`[safeUpsertEmail] Duplicate key (EmailLog) for ${key}, retrying with plain update`);
        await EmailLog.updateOne(
          { email: key },
          { $set: newData, $currentDate: { updatedAt: true, timestamp: true } }
        );
      } else {
        throw err;
      }
    }

    try {
      await userDb.findOneAndUpdate(
        { email: key },
        {
          $set: newData,
          $currentDate: { updatedAt: true, timestamp: true },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      if (err.code === 11000) {
        console.warn(`[safeUpsertEmail] Duplicate key (User DB) for ${key}, retrying with plain update`);
        await userDb.updateOne(
          { email: key },
          { $set: newData, $currentDate: { updatedAt: true, timestamp: true } }
        );
      } else {
        throw err;
      }
    }

    console.log(`[safeUpsertEmail] ✅ Stored/updated ${key} -> category: ${newData.category}, sub_status: ${newData.sub_status}, score: ${newData.score}, conf: ${newData.confidence}, provisional: ${!!newData.provisional}`);
  });

  upsertQueues.set(
    key,
    thisPromise.finally(() => {
      if (upsertQueues.get(key) === thisPromise) upsertQueues.delete(key);
    })
  );

  return thisPromise;
}


// ─────────────────────── /validate-email (single best, stabilized) ───────────────────────
app.post("/validate-email", async (req, res) => {
  try {
    const { email, sessionId, username } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!username) return res.status(400).json({ error: "Username is required" });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.credits <= 0) return res.status(400).json({ error: "You don't have credits" });

    const { EmailLog: UserEmailLog } = getUserDb(username);

    // ────────────── CACHE SHORT-CIRCUIT ──────────────
    try {
      const cachedDb = await UserEmailLog.findOne({ email }).sort({ updatedAt: -1 });
      if (cachedDb) {
        const ageMs = Date.now() - new Date(cachedDb.updatedAt).getTime();
        if (ageMs <= FRESH_DB_MS) {
          await UserEmailLog.updateOne(
            { _id: cachedDb._id },
            { $currentDate: { updatedAt: true, timestamp: true } }
          );
          await EmailLog.updateOne(
            { email },
            { $currentDate: { updatedAt: true, timestamp: true } }
          );

          const cachedObj = cachedDb.toObject();
          delete cachedObj.timestamp;

          const fullResult = {
            email,
            status: cachedDb.status || "❔ Unknown",
            category: /Valid/.test(cachedDb.status)
              ? "valid"
              : /Invalid/.test(cachedDb.status)
              ? "invalid"
              : /Risky/.test(cachedDb.status)
              ? "risky"
              : "unknown",
            domain: cachedDb.domain || extractDomain(email),
            provider: cachedDb.provider || "Unavailable",
            isDisposable: !!cachedDb.isDisposable,
            isFree: !!cachedDb.isFree,
            isRoleBased: !!cachedDb.isRoleBased,
            message: cachedDb.message || getStatusMessage(cachedDb.status),
            score: cachedDb.score ?? 0,
            confidence: cachedDb.confidence ?? undefined,
            sub_status: cachedDb.sub_status,
            via: "db-cache",
            cached: true,
          };

          sendStatusToFrontend(
            email,
            fullResult.status,
            new Date(),
            fullResult,
            sessionId,
            true,
            username
          );

          if (!/^❔/.test(cachedDb.status)) {
            await User.updateOne({ username }, { $inc: { credits: -1 } });
          }

          const updatedUser = await User.findOne({ username });
          return res.json({ ...fullResult, timestamp: new Date(), credits: updatedUser.credits });
        }
      }
    } catch (err) {
      console.warn("[validate-email] Cache lookup failed:", err.message);
    }

    // ────────────── SMTP VALIDATION (STABILIZED = single best) ──────────────
    const logger = (step, message, level = "info") =>
      sendLogToFrontend(sessionId, email, message, step, level);

    logger("start", "Starting SMTP validation (stabilized)");
    let final;
    try {
      final = await validateSMTPStable(email, { logger });
    } catch (err) {
      logger("error", "Validation failed due to technical issue");
      return res.status(500).json({ error: "Validation failed due to technical issue" });
    }

    if (!final || !final.status) {
      logger("error", "No status returned from SMTP validation");
      return res.status(500).json({ error: "Could not validate email" });
    }

    logger("finish", `SMTP stabilized: ${final.category || "unknown"} (${final.sub_status || "n/a"})`);

    const fullResult = {
      email,
      status: final.status,
      category: final.category ||
        (/Valid/.test(final.status) ? "valid" : /Invalid/.test(final.status) ? "invalid" : /Risky/.test(final.status) ? "risky" : "unknown"),
      domain: final.domain || extractDomain(email),
      provider: final.provider || "Unavailable",
      isDisposable: !!final.isDisposable,
      isFree: !!final.isFree,
      isRoleBased: !!final.isRoleBased,
      message: final.message || getStatusMessage(final.status),
      score: final.score ?? 0,
      confidence: final.confidence ?? undefined,
      sub_status: final.sub_status,
      provisional: undefined, // stabilized result is definitive
      via: "smtp",
      cached: false,
    };

    const response = { ...fullResult, timestamp: new Date() };
    await safeUpsertEmail(email, fullResult, getUserDb(username).EmailLog);

    sendStatusToFrontend(
      email,
      response.status,
      response.timestamp,
      response,
      sessionId,
      true,
      username
    );

    if (!/^❔/.test(fullResult.status)) {
      await User.updateOne({ username }, { $inc: { credits: -1 } });
    }

    const updatedUser = await User.findOne({ username });
    return res.json({ ...response, credits: updatedUser.credits });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ─────────────────────── /verify-smart (prelim to UI, store only stable) ───────────────────────
const inflight = new Map();

app.post("/verify-smart", async (req, res) => {
  try {
    const { email, sessionId, username } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });
    if (!username) return res.status(400).json({ error: "Username is required" });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.credits <= 0) return res.status(400).json({ error: "You don't have credits" });

    const deductCredit = async () => {
      const updated = await User.findOneAndUpdate(
        { username },
        { $inc: { credits: -1 } },
        { new: true }
      );
      return updated?.credits;
    };

    if (inflight.has(email)) {
      return res.json({
        email,
        status: "⏳ In progress",
        via: "smtp",
        inProgress: true,
      });
    }

    // ────────────── CACHE SHORT-CIRCUIT ──────────────
    try {
      const cachedDb = await EmailLog.findOne({ email }).sort({ updatedAt: -1 });
      if (cachedDb) {
        const ageMs = Date.now() - new Date(cachedDb.updatedAt).getTime();
        console.log(`[verify-smart] cache ageMs=${ageMs}, fresh=${ageMs <= FRESH_DB_MS}`);

        if (ageMs <= FRESH_DB_MS) {
          await EmailLog.updateOne(
            { _id: cachedDb._id },
            { $currentDate: { updatedAt: true, timestamp: true } }
          );

          const { EmailLog: UserEmailLog } = getUserDb(username);
          const cachedObj = cachedDb.toObject();
          delete cachedObj._id;
          delete cachedObj.timestamp;

          try {
            await UserEmailLog.findOneAndUpdate(
              { email },
              {
                $set: cachedObj,
                $currentDate: { updatedAt: true, timestamp: true },
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true, new: true }
            );
          } catch (err) {
            if (err.code === 11000) {
              await UserEmailLog.updateOne(
                { email },
                { $set: cachedObj, $currentDate: { updatedAt: true, timestamp: true } }
              );
            } else throw err;
          }

          const fullResult = {
            ...cachedObj,
            category: /Valid/.test(cachedDb.status)
              ? "valid"
              : /Invalid/.test(cachedDb.status)
              ? "invalid"
              : /Risky/.test(cachedDb.status)
              ? "risky"
              : "unknown",
            cached: true,
            via: "db-cache",
          };

          const response = { ...fullResult, timestamp: new Date() };
          let credits = null;
          if (!cachedDb.status.includes("Unknown")) credits = await deductCredit();

          return res.json({ ...response, credits, inProgress: false });
        }
      }
    } catch (err) {
      console.warn("[verify-smart] Cache lookup failed:", err.message);
    }

    // ────────────── START SMTP VALIDATION ──────────────
    let resolveInflight;
    const inflightPromise = new Promise((resolve) => (resolveInflight = resolve));
    inflight.set(email, inflightPromise);

    try {
      const logger = (step, message, level = "info") =>
        sendLogToFrontend(sessionId, email, message, step, level);

      // 1) Prelim (return to client UI only; DO NOT upsert)
      const prelim = await validateSMTP(email, { logger });

      if (!prelim || !prelim.status) {
        inflight.delete(email);
        resolveInflight();
        return res.status(500).json({ error: "Could not validate email" });
      }

      const prelimResult = {
        email,
        status: prelim.status,
        category:
          prelim.category ||
          (/Valid/.test(prelim.status)
            ? "valid"
            : /Invalid/.test(prelim.status)
            ? "invalid"
            : /Risky/.test(prelim.status)
            ? "risky"
            : "unknown"),
        domain: prelim.domain || extractDomain(email),
        provider: prelim.provider || "Unavailable",
        isDisposable: !!prelim.isDisposable,
        isFree: !!prelim.isFree,
        isRoleBased: !!prelim.isRoleBased,
        message: getStatusMessage(prelim.status),
        score: prelim.score ?? 0,
        confidence: prelim.confidence ?? undefined,
        sub_status: prelim.sub_status,
        provisional: true, // mark as provisional
        via: "smtp",
        cached: false,
      };

      const prelimResponse = { ...prelimResult, timestamp: new Date() };
      // Return prelim to client, but DO NOT write to DB (prevents worse-overwriting-better)
      res.json({ ...prelimResponse, credits: null, inProgress: true });

      // 2) Background: stabilized final → ONLY this is persisted
      (async () => {
        try {
          const final = await validateSMTPStable(email, { logger });
          const stableResult = {
            email,
            status: final.status,
            category:
              final.category ||
              (/Valid/.test(final.status)
                ? "valid"
                : /Invalid/.test(final.status)
                ? "invalid"
                : /Risky/.test(final.status)
                ? "risky"
                : "unknown"),
            domain: final.domain || extractDomain(email),
            provider: final.provider || prelimResult.provider || "Unavailable",
            isDisposable: !!final.isDisposable,
            isFree: !!final.isFree,
            isRoleBased: !!final.isRoleBased,
            message: getStatusMessage(final.status),
            score: final.score ?? prelimResult.score ?? 0,
            confidence: final.confidence ?? prelimResult.confidence ?? undefined,
            sub_status: final.sub_status,
            provisional: undefined, // definitive
            via: "smtp",
            cached: false,
          };

          const { EmailLog: UserEmailLog } = getUserDb(username);
          await safeUpsertEmail(email, stableResult, UserEmailLog);

          let credits = null;
          if (!stableResult.status.includes("Unknown")) {
            credits = await User.findOneAndUpdate(
              { username },
              { $inc: { credits: -1 } },
              { new: true }
            ).then(u => u?.credits);
          }

          // Push final to frontend
          sendStatusToFrontend(
            email,
            stableResult.status,
            new Date(),
            { ...stableResult, credits, inProgress: false },
            sessionId,
            true,
            username
          );
        } finally {
          inflight.delete(email);
          resolveInflight();
        }
      })();
    } catch (err) {
      inflight.delete(email);
      resolveInflight();
      throw err;
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ...................................................................................................................................................


// const upsertQueues = new Map();

// async function safeUpsertEmail(email, newData, userDb) {
//   const key = String(email).toLowerCase();

//   // If a queue exists for this email, wait for it
//   const lastPromise = upsertQueues.get(key) || Promise.resolve();

//   const thisPromise = lastPromise.then(async () => {
//     // Now we are guaranteed to be the only active writer for this email
//     let existing = await EmailLog.findOne({ email: key });

//     const priority = { valid: 4, risky: 3, invalid: 2, unknown: 1 };
//     const existingCategory = (existing?.category || "unknown").toLowerCase();
//     const newCategory = (newData.category || "unknown").toLowerCase();

//     const existingScore = existing?.score ?? 0;
//     const newScore = newData.score ?? 0;

//     let shouldUpdate =
//       !existing ||
//       priority[newCategory] > priority[existingCategory] ||
//       (newCategory === existingCategory && newScore > existingScore) ||
//       (!existing?.status && newData.status);

//     if (!shouldUpdate) {
//       console.log(
//         `[safeUpsertEmail] ⏭ Skipping update for ${key} (existing category=${existing?.category}, score=${existing?.score})`
//       );
//       return;
//     }

//     console.log(
//       `[safeUpsertEmail] Preparing to update ${key} -> existing: { category: ${existing?.category}, score: ${existing?.score} } new: { category: ${newCategory}, score: ${newScore} }`
//     );

//     try {
//       await EmailLog.findOneAndUpdate(
//         { email: key },
//         {
//           $set: newData,
//           $currentDate: { timestamp: true },
//           $setOnInsert: { createdAt: new Date() },
//         },
//         { upsert: true, new: true }
//       );
//     } catch (err) {
//       if (err.code === 11000) {
//         console.warn(`[safeUpsertEmail] Duplicate key (EmailLog) for ${key}, retrying with plain update`);
//         await EmailLog.updateOne(
//           { email: key },
//           { $set: newData, $currentDate: { timestamp: true } }
//         );
//       } else {
//         throw err;
//       }
//     }

//     try {
//       await userDb.findOneAndUpdate(
//         { email: key },
//         {
//           $set: newData,
//           $currentDate: { timestamp: true },
//           $setOnInsert: { createdAt: new Date() },
//         },
//         { upsert: true, new: true }
//       );
//     } catch (err) {
//       if (err.code === 11000) {
//         console.warn(`[safeUpsertEmail] Duplicate key (User DB) for ${key}, retrying with plain update`);
//         await userDb.updateOne(
//           { email: key },
//           { $set: newData, $currentDate: { timestamp: true } }
//         );
//       } else {
//         throw err;
//       }
//     }

//     console.log(`[safeUpsertEmail] ✅ Stored/updated ${key} -> category: ${newCategory}, score: ${newScore}`);
//   });

//   upsertQueues.set(key, thisPromise.finally(() => {
//     // Clean up queue after we're done
//     if (upsertQueues.get(key) === thisPromise) upsertQueues.delete(key);
//   }));

//   return thisPromise;
// }

// app.post("/validate-email", async (req, res) => {
//   try {
//     const { email, sessionId, username } =
//       typeof req.body === "string" ? JSON.parse(req.body) : req.body;

//     if (!email) return res.status(400).json({ error: "Email is required" });
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const user = await User.findOne({ username });
//     if (!user) return res.status(404).json({ error: "User not found" });
//     if (user.credits <= 0)
//       return res.status(400).json({ error: "You don't have credits" });

//     const { EmailLog: UserEmailLog } = getUserDb(username);

//     // ────────────── CACHE SHORT-CIRCUIT ──────────────
//     try {
//       const cachedDb = await UserEmailLog.findOne({ email }).sort({
//         updatedAt: -1,
//       });
//       if (cachedDb) {
//         const ageMs = Date.now() - new Date(cachedDb.updatedAt).getTime();
//         if (ageMs <= FRESH_DB_MS) {
//           await UserEmailLog.updateOne(
//             { _id: cachedDb._id },
//             { $currentDate: { updatedAt: true, timestamp: true } }
//           );
//           await EmailLog.updateOne(
//             { email },
//             { $currentDate: { updatedAt: true, timestamp: true } }
//           );

//           const cachedObj = cachedDb.toObject();
//           delete cachedObj.timestamp;

//           const fullResult = {
//             email,
//             status: cachedDb.status || "❔ Unknown",
//             category: /Valid/.test(cachedDb.status)
//               ? "valid"
//               : /Invalid/.test(cachedDb.status)
//               ? "invalid"
//               : /Risky/.test(cachedDb.status)
//               ? "risky"
//               : "unknown",
//             domain: cachedDb.domain || extractDomain(email),
//             provider: cachedDb.provider || "Unavailable",
//             isDisposable: !!cachedDb.isDisposable,
//             isFree: !!cachedDb.isFree,
//             isRoleBased: !!cachedDb.isRoleBased,
//             message: cachedDb.message || getStatusMessage(cachedDb.status),
//             timestamp: new Date(),
//             via: "db-cache",
//             cached: true,
//           };

//           sendStatusToFrontend(
//             email,
//             fullResult.status,
//             fullResult.timestamp,
//             fullResult,
//             sessionId,
//             true,
//             username
//           );

//           if (!/^❔/.test(cachedDb.status)) {
//             await User.updateOne({ username }, { $inc: { credits: -1 } });
//           }

//           const updatedUser = await User.findOne({ username });
//           return res.json({ ...fullResult, credits: updatedUser.credits });
//         }
//       }
//     } catch (err) {
//       console.warn("[validate-email] Cache lookup failed:", err.message);
//     }

//     // ────────────── SMTP VALIDATION ──────────────
//     const logger = (step, message, level = "info") =>
//       sendLogToFrontend(sessionId, email, message, step, level);

//     logger("start", "Starting SMTP validation");
//     let result;
//     try {
//       result = await validateSMTP(email, { logger });
//     } catch (err) {
//       logger("error", "Validation failed due to technical issue");
//       return res
//         .status(500)
//         .json({ error: "Validation failed due to technical issue" });
//     }

//     // ────────────── LOG SMTP RESPONSE ──────────────
//     console.log("[SMTP RESPONSE]", {
//       email,
//       status: result?.status,
//       category: result?.category,
//       score: result?.score,
//       provider: result?.provider,
//       isDisposable: result?.isDisposable,
//       isFree: result?.isFree,
//       isRoleBased: result?.isRoleBased,
//       message: result?.message,
//       raw: result,
//     });

//     if (!result || !result.status) {
//       logger(
//         "error",
//         "No status returned from SMTP validation, skipping DB update"
//       );
//       return res.status(500).json({ error: "Could not validate email" });
//     }

//     logger(
//       "finish",
//       `SMTP finished: ${result.category || "unknown"} (${
//         result.sub_status || "n/a"
//       })`
//     );

//     const fullResult = {
//       email,
//       status: result.status,
//       category:
//         result.category ||
//         (/Valid/.test(result.status)
//           ? "valid"
//           : /Invalid/.test(result.status)
//           ? "invalid"
//           : /Risky/.test(result.status)
//           ? "risky"
//           : "unknown"),
//       domain: result.domain || extractDomain(email),
//       provider: result.provider || "Unavailable",
//       isDisposable: !!result.isDisposable,
//       isFree: !!result.isFree,
//       isRoleBased: !!result.isRoleBased,
//       message: result.message || getStatusMessage(result.status),
//       score: result.score ?? 0,
//       via: "smtp",
//       cached: false,
//     };

//     const response = { ...fullResult, timestamp: new Date() };
//     await safeUpsertEmail(email, fullResult, UserEmailLog);

//     sendStatusToFrontend(
//       email,
//       response.status,
//       response.timestamp,
//       response,
//       sessionId,
//       true,
//       username
//     );

//     if (!/^❔/.test(fullResult.status)) {
//       await User.updateOne({ username }, { $inc: { credits: -1 } });
//     }

//     const updatedUser = await User.findOne({ username });
//     return res.json({ ...response, credits: updatedUser.credits });
//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });

// app.post("/verify-smart", async (req, res) => {
//   try {
//     const { email, sessionId, username } =
//       typeof req.body === "string" ? JSON.parse(req.body) : req.body;

//     if (!email) return res.status(400).json({ error: "Email is required" });
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const user = await User.findOne({ username });
//     if (!user) return res.status(404).json({ error: "User not found" });
//     if (user.credits <= 0)
//       return res.status(400).json({ error: "You don't have credits" });

//     const deductCredit = async () => {
//       const updated = await User.findOneAndUpdate(
//         { username },
//         { $inc: { credits: -1 } },
//         { new: true }
//       );
//       return updated?.credits;
//     };

//     if (inflight.has(email)) {
//       return res.json({
//         email,
//         status: "⏳ In progress",
//         via: "smtp",
//         inProgress: true,
//       });
//     }

//     // ────────────── CACHE SHORT-CIRCUIT ──────────────
//     try {
//       const cachedDb = await EmailLog.findOne({ email }).sort({
//         updatedAt: -1,
//       });

//       if (cachedDb) {
//         const ageMs = Date.now() - new Date(cachedDb.updatedAt).getTime();
//         console.log(
//           `[verify-smart] cache ageMs=${ageMs}, fresh=${ageMs <= FRESH_DB_MS}`
//         );

//         if (ageMs <= FRESH_DB_MS) {
//           await EmailLog.updateOne(
//             { _id: cachedDb._id },
//             { $currentDate: { timestamp: true } }
//           );

//           const { EmailLog: UserEmailLog } = getUserDb(username);
//           const cachedObj = cachedDb.toObject();
//           delete cachedObj._id;
//           delete cachedObj.timestamp;

//           try {
//             await UserEmailLog.findOneAndUpdate(
//               { email },
//               {
//                 $set: cachedObj,
//                 $currentDate: { timestamp: true },
//                 $setOnInsert: { createdAt: new Date() },
//               },
//               { upsert: true, new: true }
//             );
//           } catch (err) {
//             if (err.code === 11000) {
//               await UserEmailLog.updateOne(
//                 { email },
//                 { $set: cachedObj, $currentDate: { timestamp: true } }
//               );
//             } else throw err;
//           }

//           const fullResult = {
//             ...cachedObj,
//             category: /Valid/.test(cachedDb.status)
//               ? "valid"
//               : /Invalid/.test(cachedDb.status)
//               ? "invalid"
//               : /Risky/.test(cachedDb.status)
//               ? "risky"
//               : "unknown",
//             cached: true,
//             via: "db-cache",
//           };

//           const response = { ...fullResult, timestamp: new Date() };
//           let credits = null;
//           if (!cachedDb.status.includes("Unknown"))
//             credits = await deductCredit();

//           return res.json({ ...response, credits, inProgress: false });
//         }
//       }
//     } catch (err) {
//       console.warn("[verify-smart] Cache lookup failed:", err.message);
//     }

//     // ────────────── START SMTP VALIDATION ──────────────
//     let resolveInflight;
//     const inflightPromise = new Promise(
//       (resolve) => (resolveInflight = resolve)
//     );
//     inflight.set(email, inflightPromise);

//     try {
//       const logger = (step, message, level = "info") =>
//         sendLogToFrontend(sessionId, email, message, step, level);

//       const prelim = await validateSMTP(email, { logger });

//       console.log("[verify-smart SMTP RESPONSE]", {
//         email,
//         status: prelim?.status,
//         category: prelim?.category,
//         score: prelim?.score,
//         provider: prelim?.provider,
//         isDisposable: prelim?.isDisposable,
//         isFree: prelim?.isFree,
//         isRoleBased: prelim?.isRoleBased,
//         message: prelim?.message,
//         raw: prelim,
//       });

//       if (!prelim || !prelim.status) {
//         inflight.delete(email);
//         resolveInflight();
//         return res.status(500).json({ error: "Could not validate email" });
//       }

//       const fullResult = {
//         email,
//         status: prelim.status,
//         category:
//           prelim.category ||
//           (/Valid/.test(prelim.status)
//             ? "valid"
//             : /Invalid/.test(prelim.status)
//             ? "invalid"
//             : /Risky/.test(prelim.status)
//             ? "risky"
//             : "unknown"),
//         domain: prelim.domain || extractDomain(email),
//         provider: prelim.provider || "Unavailable",
//         isDisposable: !!prelim.isDisposable,
//         isFree: !!prelim.isFree,
//         isRoleBased: !!prelim.isRoleBased,
//         // message: prelim.message || getStatusMessage(prelim.status),
//         message: getStatusMessage(prelim.status),
//         score: prelim.score ?? 0,
//         via: "smtp",
//         cached: false,
//       };

//       const response = { ...fullResult, timestamp: new Date() };
//       const { EmailLog: UserEmailLog } = getUserDb(username);
//       await safeUpsertEmail(email, fullResult, UserEmailLog);

//       let credits = null;
//       if (!prelim.status.includes("Unknown")) credits = await deductCredit();

//       res.json({ ...response, credits, inProgress: false });

//       // ────────────── Background stable re-check ──────────────
//       (async () => {
//         try {
//           const final = await validateSMTPStable(email, { logger });
//           const stableResult = {
//             ...fullResult,
//             ...final,
//             provider: final.provider || fullResult.provider || "Unavailable",
//             message: getStatusMessage(final.status),
//           };

//           delete stableResult.timestamp;
//           await safeUpsertEmail(email, stableResult, UserEmailLog);

//           sendStatusToFrontend(
//             email,
//             stableResult.status,
//             Date.now(),
//             stableResult,
//             sessionId,
//             true,
//             username
//           );
//         } finally {
//           inflight.delete(email);
//           resolveInflight();
//         }
//       })();
//     } catch (err) {
//       inflight.delete(email);
//       resolveInflight();
//       throw err;
//     }
//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });




