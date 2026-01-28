
// routes/EmailFinder.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const XLSX = require("xlsx");

const User = require("../models/User");
const FinderGlobal = require("../models/Finder");
const { validateSMTPStable } = require("../utils/smtpValidator");

// GLOBAL collections (shared)
const DomainPattern = require("../models/DomainPattern");
const Domain = require("../models/Domain");

// memory upload (only used for domains/import)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ───────────────────────────────────────────────────────────────
   TENANT HELPERS (User-level DB)
─────────────────────────────────────────────────────────────── */

function normalizeTenant(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function getUserDbByTenant(tenant) {
  const dbName = `${tenant}-emailTool`;
  return mongoose.connection.useDb(dbName, { useCache: true });
}

function getFinderModelByTenant(tenant) {
  const conn = getUserDbByTenant(tenant);
  if (conn.models.Finder) return conn.models.Finder;
  return conn.model("Finder", FinderGlobal.schema, "finders");
}

/* ───────────────────────────────────────────────────────────────
   AUTH
─────────────────────────────────────────────────────────────── */
async function requireAuth(req, res, next) {
  try {
    const headerUserRaw =
      req.headers["x-user"] || req.query?.username || req.body?.username || "";
    const headerUser = String(headerUserRaw).trim();

    let userDoc = null;

    if (headerUser) {
      userDoc = await User.findOne({
        username: new RegExp(`^${headerUser}$`, "i"),
      }).lean();
      if (!userDoc)
        return res.status(401).json({ error: "Unauthorized (unknown X-User)" });
    } else if (req.user?.id) {
      userDoc = await User.findById(req.user.id).lean();
      if (!userDoc)
        return res
          .status(401)
          .json({ error: "Unauthorized (invalid token user)" });
    } else {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tenant = normalizeTenant(userDoc.username);
    req.user = { id: userDoc._id, username: userDoc.username };
    req.tenant = tenant;

    next();
  } catch (e) {
    console.error("auth error", e);
    return res.status(500).json({ error: "Auth error" });
  }
}

/* ───────────────────────────────────────────────────────────────
   UTILITIES
─────────────────────────────────────────────────────────────── */

function normalizeASCII(s = "") {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s'-]/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Full name -> {first,last,F,L} (lowercase ascii)
function splitFullName(full = "") {
  const parts = normalizeASCII(full).split(" ").filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const F = first ? first[0] : "";
  const L = last ? last[0] : "";
  return { first, last, F, L };
}

function normalizeDomain(raw) {
  if (!raw) return "";

  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/^www\./, "").trim();

  if (!d.includes(".") || d.includes(" ")) return "";
  return d;
}

function splitBaseAndTld(domain) {
  if (!domain) return { base: "", tld: "" };
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return { base: parts[0] || "", tld: "" };
  return { base: parts[0], tld: parts[parts.length - 1] };
}

async function upsertDomainSample(domain, email) {
  if (!domain) return;
  const d = String(domain).toLowerCase();
  const { base, tld } = splitBaseAndTld(d);
  const sampleEmail = email ? String(email).trim() : null;

  const update = { $setOnInsert: { domain: d, base, tld } };

  if (sampleEmail) {
    update.$set = { sampleEmail };
    update.$inc = { emailsCount: 1 };
  }

  await Domain.updateOne({ domain: d }, update, { upsert: true });
}

function deriveConfidence(vr = {}) {
  const cat = String(vr.category || "").toLowerCase();
  const reason = String(vr.reason || "");

  const catchAll =
    vr.isCatchAll === true ||
    /catch[- ]?all/i.test(reason) ||
    String(vr.category_detail || "").toLowerCase() === "accept_all";

  const smtpYes =
    vr.smtpAccepted === true ||
    /^2\d\d$/.test(String(vr.smtpCode || "")) ||
    /\b2\d\d\b/i.test(reason) ||
    /accepted|ok|success/i.test(reason);

  const mxYes =
    vr.hasMx === true ||
    vr.mxFound === true ||
    (Array.isArray(vr.mx) && vr.mx.length > 0) ||
    /mx|dns/i.test(reason);

  if (cat === "valid" && !catchAll && (smtpYes || mxYes)) return "High";
  if (
    cat === "valid" ||
    catchAll ||
    ["risky", "accept_all", "accept-all"].includes(cat)
  )
    return "Med";
  return "Low";
}

function isDeliverable(vr = {}) {
  const cat = String(vr.category || "").toLowerCase();
  return cat === "valid";
}


/* ───────────────────────────────────────────────────────────────
   PATTERNS
─────────────────────────────────────────────────────────────── */

const FIXED_CODES_50 = [
  "f.l",
  "l.f",
  "f.L",
  "F.l",
  "fl",
  "lf",
  "f",
  "l",

  "f_l",
  "l_f",
  "f_L",
  "F_l",
  "fL",
  "Fl",

  "f-l",
  "l-f",
  "f-L",
  "F-l",
  "f-Ll",
  "fLl",

  "f.lL",
  "fL.l",
  "F.lL",
  "F.L",
  "FL",

  "l.fL",
  "l.F",
  "lF",

  "F.f.l",
  "f.F.l",
  "f.l.F",
  "f.lL",
  "fL.l",

  "fL",
  "lF",

  "f.L",
  "F.l",
  "F.lL",
  "F.Ll",

  "f_lL",
  "fL_l",
  "F_lL",
  "F_L",
  "FL_",
  "F_Ll",
  "f_Ll",
  "l_F",
  "l_Ff",

  "f-lL",
  "fL-l",
  "F-lL",
  "l-fL",
];

function sanitizeLocal(local) {
  return String(local || "")
    .replace(/[^\w.-]/g, "")
    .replace(/\.+/g, ".")
    .replace(/[_-]{2,}/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function renderLocalFromCode(code, { first, last, F, L }) {
  const pieces = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "." || c === "_" || c === "-") {
      pieces.push(c);
      continue;
    }
    if (c === "f") pieces.push(first);
    else if (c === "l") pieces.push(last);
    else if (c === "F") pieces.push(F);
    else if (c === "L") pieces.push(L);
    else pieces.push(c);
  }
  return sanitizeLocal(pieces.join(""));
}

function buildFixedPairs(nameParts, domain) {
  const d = String(domain || "")
    .toLowerCase()
    .trim();
  if (!d || !nameParts.first) return [];
  const out = [];
  const seen = new Set();

  for (const code of FIXED_CODES_50) {
    const local = renderLocalFromCode(code, nameParts);
    if (!local) continue;
    if (seen.has(local)) continue;
    seen.add(local);
    out.push({ code, email: `${local}@${d}` });
  }
  return out;
}

async function getPreferredCodesForDomain(domain) {
  const d = String(domain || "").toLowerCase();
  const doc = await DomainPattern.findOne({ domain: d }).lean();
  if (!doc || !Array.isArray(doc.patterns) || doc.patterns.length === 0)
    return [];
  const sorted = [...doc.patterns].sort(
    (a, b) => (b.success || 0) - (a.success || 0)
  );
  return sorted
    .map((p) => p.code)
    .filter((c) => c && FIXED_CODES_50.includes(c));
}

async function bumpAttempts(domain) {
  const d = String(domain || "").toLowerCase();
  await DomainPattern.updateOne(
    { domain: d },
    { $setOnInsert: { domain: d, attempts: 0 } },
    { upsert: true }
  );
  await DomainPattern.updateOne({ domain: d }, { $inc: { attempts: 1 } });
}

async function recordPatternSuccess(domain, code) {
  if (!code) return;
  const d = String(domain || "").toLowerCase();

  await DomainPattern.updateOne(
    { domain: d },
    { $setOnInsert: { domain: d, attempts: 0 } },
    { upsert: true }
  );

  const bump = await DomainPattern.updateOne(
    { domain: d, "patterns.code": code },
    {
      $inc: { "patterns.$.success": 1 },
      $set: { "patterns.$.lastSuccessAt": new Date() },
    }
  );

  if (!bump.matchedCount && !bump.modifiedCount) {
    await DomainPattern.updateOne(
      { domain: d },
      { $push: { patterns: { code, success: 1, lastSuccessAt: new Date() } } }
    );
  }
}

async function recordPatternSuccessFromCache(domain, code) {
  return recordPatternSuccess(domain, code);
}

function makeCandidatesWithPriorityParts(
  domain,
  nameParts,
  preferredCodes = []
) {
  const d = String(domain || "")
    .toLowerCase()
    .trim();
  if (!d || !nameParts?.first) return [];

  const finalPairs = [];
  const seenLocal = new Set();

  for (const code of preferredCodes || []) {
    if (!FIXED_CODES_50.includes(code)) continue;
    const local = renderLocalFromCode(code, nameParts);
    if (!local) continue;
    if (seenLocal.has(local)) continue;
    seenLocal.add(local);
    finalPairs.push({ code, email: `${local}@${d}` });
  }

  for (const code of FIXED_CODES_50) {
    const local = renderLocalFromCode(code, nameParts);
    if (!local) continue;
    if (seenLocal.has(local)) continue;
    seenLocal.add(local);
    finalPairs.push({ code, email: `${local}@${d}` });
  }

  return finalPairs;
}

async function findDeliverableParallel(candidates, concurrency = 8) {
  for (let i = 0; i < candidates.length; i += concurrency) {
    const slice = candidates.slice(i, i + concurrency);

    const results = await Promise.all(
      slice.map(async (cObj) => {
        try {
          const vr = await validateSMTPStable(cObj.email);
          return {
            code: cObj.code,
            email: cObj.email,
            vr,
            ok: isDeliverable(vr),
          };
        } catch {
          return { code: cObj.code, email: cObj.email, vr: null, ok: false };
        }
      })
    );

    const deliverables = results.filter((r) => r.ok);
    if (deliverables.length) {
      let best = deliverables[0];
      let bestIdx = candidates.findIndex((c) => c.email === best.email);

      for (const d of deliverables) {
        const idx = candidates.findIndex((c) => c.email === d.email);
        if (idx >= 0 && idx < bestIdx) {
          best = d;
          bestIdx = idx;
        }
      }

      return {
        email: best.email,
        vr: best.vr,
        code: best.code,
        index: bestIdx,
      };
    }
  }
  return null;
}

/* ───────────────────────────────────────────────────────────────
   ROUTER
─────────────────────────────────────────────────────────────── */
module.exports = function EmailFinderRouter() {
  const router = express.Router();

  /* ───────────────────────────── DOMAIN IMPORT ───────────────────────────── */
  router.post(
    "/domains/import",
    requireAuth,
    upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer) {
          return res
            .status(400)
            .json({ error: "No file uploaded. Use field name 'file'." });
        }

        const wb = XLSX.read(req.file.buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

        const bulkOps = [];
        let processed = 0;
        let skippedNoDomain = 0;
        let affectedDomains = 0;

        for (const row of rows) {
          const rawDomain =
            row.Domain || row["Domain"] || row.domain || row["domain"] || "";

          const rawEmail =
            row["Email Address"] ||
            row["Email"] ||
            row["email address"] ||
            row.email ||
            "";

          let domain = normalizeDomain(rawDomain);

          if (!domain && rawEmail) {
            const parts = String(rawEmail).trim().toLowerCase().split("@");
            if (parts.length === 2) domain = normalizeDomain(parts[1]);
          }

          if (!domain) {
            skippedNoDomain++;
            processed++;
            continue;
          }

          const { base, tld } = splitBaseAndTld(domain);
          const sampleEmail = rawEmail ? String(rawEmail).trim() : null;

          const update = {
            $setOnInsert: { domain, base, tld, sampleEmail },
          };
          if (sampleEmail) update.$inc = { emailsCount: 1 };

          bulkOps.push({
            updateOne: { filter: { domain }, update, upsert: true },
          });

          if (bulkOps.length >= 1000) {
            const bulkResult = await Domain.bulkWrite(bulkOps, {
              ordered: false,
            });
            affectedDomains +=
              (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
            bulkOps.length = 0;
          }

          processed++;
        }

        if (bulkOps.length > 0) {
          const bulkResult = await Domain.bulkWrite(bulkOps, {
            ordered: false,
          });
          affectedDomains +=
            (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
        }

        const totalDomains = await Domain.countDocuments({});
        return res.json({
          ok: true,
          fileName: req.file.originalname,
          rowsInFile: rows.length,
          processedRows: processed,
          skippedNoDomain,
          affectedDomains,
          totalDomainsInCollection: totalDomains,
        });
      } catch (err) {
        console.error("[domains.import] error", err);
        return res.status(500).json({
          error: "Domain import failed",
          details: err.message || String(err),
        });
      }
    }
  );

  /* ───────────────────────────── DOMAIN SUGGEST ───────────────────────────── */
  router.get("/domains/suggest", requireAuth, async (req, res) => {
    try {
      const qRaw = String(req.query.q || "").trim();
      const limit = Math.max(1, Math.min(50, +(req.query.limit || 10)));
      if (!qRaw) return res.json({ suggestions: [] });

      const escapeRegex = (s = "") =>
        String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const qLower = qRaw.toLowerCase();
      const domainPrefix = escapeRegex(
        qLower.replace(/^https?:\/\//, "").replace(/^www\./, "")
      );

      const results = await Domain.find(
        { domain: { $regex: "^" + domainPrefix, $options: "i" } },
        { domain: 1 }
      )
        .sort({ emailsCount: -1 })
        .limit(limit)
        .lean();

      return res.json({ suggestions: results.map((d) => d.domain) });
    } catch (e) {
      console.error("[domains.suggest] error", e);
      return res.status(500).json({ error: "Suggestion lookup failed" });
    }
  });

  /* ───────────────────────────── PARALLEL START ─────────────────────────────
   POST /api/finder/start
   Body: { fullName, domain }
   Returns immediately: { ok:true, jobId }
─────────────────────────────────────────────────────────────────────────── */
  router.post("/start", requireAuth, async (req, res) => {
    try {
      const { fullName, domain } = req.body || {};

      if (!fullName || !domain) {
        return res
          .status(400)
          .json({ error: "fullName and domain are required" });
      }

      const domainLC = normalizeDomain(domain);
      if (!domainLC) {
        return res
          .status(400)
          .json({ error: "Please provide a valid domain." });
      }

      const nameParts = splitFullName(fullName);
      if (!nameParts.first) {
        return res.status(400).json({ error: "Could not parse first name." });
      }

      const tenant = req.tenant;
      const userId = req.user.id;

      const Finder = getFinderModelByTenant(tenant);

      const first = nameParts.first;
      const last = nameParts.last || "";

      const baseFilter = { userId, domain: domainLC, first, last };

      /* ✅ 0) GLOBAL CACHE CHECK FIRST (BEFORE touching user record) */
      const globalHit = await FinderGlobal.findOne({
        domain: domainLC,
        first,
        last,
        email: { $ne: null },
      }).lean();

      if (globalHit?.email) {
        // Touch global timestamp (and optionally hitCount)
        await FinderGlobal.updateOne(
          { _id: globalHit._id },
          {
            $set: { updatedAt: new Date() },
            // OPTIONAL (only if your schema allows it):
            // $inc: { hitCount: 1 },
          }
        );

        // Create/update user history record as DONE (do NOT reset to running)
        const userDoc = await Finder.findOneAndUpdate(
          baseFilter,
          {
            $set: {
              userId,
              domain: domainLC,
              first,
              last,
              nameInput: fullName.trim(),
              state: "done",
              status: globalHit.status || "Valid",
              confidence: globalHit.confidence || "Med",
              reason: globalHit.reason || "",
              error: "",
              email: globalHit.email,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true, new: true }
        ).lean();

        // pattern learning from cache (best effort)
        const quickPairs = buildFixedPairs(nameParts, domainLC);
        const hit = quickPairs.find(
          (p) => p.email.toLowerCase() === String(globalHit.email).toLowerCase()
        );
        if (hit?.code) await recordPatternSuccessFromCache(domainLC, hit.code);

        // charge credit
        await User.findOneAndUpdate(
          { _id: userId, credits: { $gt: 0 } },
          { $inc: { credits: -1 } },
          { new: true }
        ).lean();

        return res.json({ ok: true, jobId: String(userDoc._id) });
      }

      /* ✅ 1) USER CACHE CHECK SECOND (BEFORE resetting) */
      const userHit = await Finder.findOne({
        ...baseFilter,
        email: { $ne: null },
      }).lean();

      if (userHit?.email) {
        // Touch user timestamp
        await Finder.updateOne(
          { _id: userHit._id, userId },
          { $set: { updatedAt: new Date() } }
        );

        // ALSO optionally touch global cache if you want (upsert)
        // This makes global stronger even if user found it earlier.
        await FinderGlobal.updateOne(
          { domain: domainLC, first, last },
          {
            $set: {
              domain: domainLC,
              first,
              last,
              email: userHit.email,
              status: userHit.status || "Valid",
              confidence: userHit.confidence || "Med",
              reason: userHit.reason || "",
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true }
        );

        // charge credit
        await User.findOneAndUpdate(
          { _id: userId, credits: { $gt: 0 } },
          { $inc: { credits: -1 } },
          { new: true }
        ).lean();

        return res.json({ ok: true, jobId: String(userHit._id) });
      }

      /* ✅ 2) NO CACHE → NOW create/reset running record */
      const doc = await Finder.findOneAndUpdate(
        baseFilter,
        {
          $set: {
            userId,
            domain: domainLC,
            first,
            last,
            nameInput: fullName.trim(),
            state: "running",
            status: "Unknown",
            confidence: "Low",
            reason: "",
            error: "",
            email: null,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
      ).lean();

      // Return jobId immediately
      res.json({ ok: true, jobId: String(doc._id) });

      // Background execution
      setImmediate(async () => {
        try {
          // Domain patterns
          await bumpAttempts(domainLC);
          const preferredCodes = await getPreferredCodesForDomain(domainLC);

          const candidates = makeCandidatesWithPriorityParts(
            domainLC,
            nameParts,
            preferredCodes
          );

          const found = await findDeliverableParallel(candidates, 8);

          if (!found) {
            await Finder.updateOne(
              { _id: doc._id, userId },
              {
                $set: {
                  state: "done",
                  status: "Unknown",
                  confidence: "Low",
                  email: null,
                  reason: "Result not found",
                  error: "",
                  updatedAt: new Date(),
                },
              }
            );

            return;
          }

          const bestEmail = found.email;
          const bestVR = found.vr;
          const bestCode = found.code;
          const confidence = deriveConfidence(bestVR);

          // store in USER history
          await Finder.updateOne(
            { _id: doc._id, userId },
            {
              $set: {
                state: "done",
                status: "Valid",
                confidence,
                email: bestEmail,
                reason: bestVR?.reason || "",
                error: "",
                updatedAt: new Date(),
              },
            }
          );

          // ✅ store in GLOBAL cache too (same schema, same collection name "finders")
          await FinderGlobal.updateOne(
            { domain: domainLC, first, last },
            {
              $set: {
                domain: domainLC,
                first,
                last,
                nameInput: fullName.trim(),
                state: "done", // ✅ FIX
                status: "Valid",
                confidence,
                email: bestEmail,
                reason: bestVR?.reason || "",
                error: "", // ✅ keep clean
                updatedAt: new Date(),
              },
              $setOnInsert: {
                createdAt: new Date(),
              },
            },
            { upsert: true }
          );

          // learn pattern
          if (bestCode) await recordPatternSuccess(domainLC, bestCode);

          // update domain dataset
          await upsertDomainSample(domainLC, bestEmail);

          // charge credit
          await User.findOneAndUpdate(
            { _id: userId, credits: { $gt: 0 } },
            { $inc: { credits: -1 } },
            { new: true }
          ).lean();
        } catch (err) {
          console.error("[finder.start worker] error", err);

          await Finder.updateOne(
            { _id: doc._id, userId },
            {
              $set: {
                state: "error",
                status: "Unknown",
                confidence: "Low",
                email: null,
                error: err?.message || "Finder failed",
                updatedAt: new Date(),
              },
            }
          );
        }
      });
    } catch (e) {
      console.error("finder start error", e);
      return res.status(500).json({ error: e?.message || "Internal error" });
    }
  });

  /* ───────────────────────────── JOB STATUS ─────────────────────────────
     GET /api/finder/job/:id
  ─────────────────────────────────────────────────────────────────────────── */
  router.get("/job/:id", requireAuth, async (req, res) => {
    try {
      const tenant = req.tenant;
      const userId = req.user.id;
      const Finder = getFinderModelByTenant(tenant);

      const job = await Finder.findOne({ _id: req.params.id, userId }).lean();
      if (!job) return res.status(404).json({ error: "Not found" });

      return res.json({
        _id: String(job._id),
        state: job.state || "done",
        status: job.status || "Unknown",
        fullName: job.nameInput,
        domain: job.domain,
        email: job.email || "",
        confidence: job.confidence || "Low",
        reason: job.reason || "",
        error: job.error || "",
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch (e) {
      console.error("job fetch error", e);
      return res.status(500).json({ error: "Job fetch failed" });
    }
  });

  /* ───────────────────────────── HISTORY ─────────────────────────────
     GET /api/finder/history?limit=50
  ───────────────────────────────────────────────────────────────────── */
  router.get("/history", requireAuth, async (req, res) => {
    try {
      const tenant = req.tenant;
      const userId = req.user.id;
      const limit = Math.max(1, Math.min(200, +(req.query.limit || 50)));

      const Finder = getFinderModelByTenant(tenant);

      const items = await Finder.find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return res.json({
        items: items.map((d) => ({
          _id: String(d._id),
          state: d.state || "done",
          status: d.status || "Unknown",
          fullName: d.nameInput,
          domain: d.domain,
          email: d.email || "",
          confidence: d.confidence || "Low",
          reason: d.reason || "",
          error: d.error || "",
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      });
    } catch (e) {
      console.error("finder history error", e);
      return res.status(500).json({ error: "History failed" });
    }
  });

  return router;
};
