// routes/EmailFinder.js
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const XLSX = require("xlsx");
const dns = require("dns").promises;

const User = require("../models/User");
const FinderGlobal = require("../models/Finder");

// ✅ bring both (so Finder can behave like bulk)
const { validateSMTP, validateSMTPStable } = require("../utils/smtpValidator");

// ✅ bulk-like merge + helpers (must exist in your utils/validator)
const {
  mergeSMTPWithHistory,
  categoryFromStatus,
  buildReasonAndMessage,
  extractDomain,
} = require("../utils/validator");

// ✅ training + reputation (same as bulk)
const TrainingSample = require("../models/TrainingSample");
const DomainReputation = require("../models/DomainReputation");

// GLOBAL collections (shared)
const DomainPattern = require("../models/DomainPattern");
const Domain = require("../models/Domain");

const PatternSetSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    attempts: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    lastTriedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
  },
  { collection: "patternsets", timestamps: true },
);

function getPatternSetModel() {
  if (mongoose.connection.models.PatternSet) {
    return mongoose.connection.models.PatternSet;
  }
  return mongoose.connection.model("PatternSet", PatternSetSchema);
}

// memory upload (only used for domains/import)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const virtualFinderJobs = new Map();
const VIRTUAL_JOB_TTL_MS = Number(
  process.env.FINDER_VIRTUAL_JOB_TTL_MS || 30 * 60 * 1000,
);

function cleanupVirtualFinderJobs() {
  const now = Date.now();
  for (const [id, job] of virtualFinderJobs.entries()) {
    const ts = new Date(job.updatedAt || job.createdAt || 0).getTime();
    if (!ts || now - ts > VIRTUAL_JOB_TTL_MS) {
      virtualFinderJobs.delete(id);
    }
  }
}

function createVirtualFinderJob(payload) {
  cleanupVirtualFinderJobs();
  const _id = new mongoose.Types.ObjectId().toString();
  const now = new Date();
  const job = {
    _id,
    state: payload.state || "done",
    status: payload.status || "Unknown",
    fullName: payload.fullName || "",
    domain: payload.domain || "",
    email: payload.email || "",
    confidence: payload.confidence || "Low",
    reason: payload.reason || "",
    error: payload.error || "",
    createdAt: now,
    updatedAt: now,
  };
  virtualFinderJobs.set(_id, job);
  return job;
}

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
      userDoc = await findUserWithRetry({
        username: new RegExp(`^${headerUser}$`, "i"),
      });
      if (!userDoc)
        return res.status(401).json({ error: "Unauthorized (unknown X-User)" });
    } else if (req.user?.id) {
      userDoc = await findUserByIdWithRetry(req.user.id);
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

function normEmail(x) {
  return String(x || "")
    .trim()
    .toLowerCase();
}

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
    String(vr.category_detail || "").toLowerCase() === "accept_all" ||
    String(vr.subStatus || vr.sub_status || "")
      .toLowerCase()
      .includes("catch");

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
   BULK-LIKE HISTORY MERGE (DomainReputation + TrainingSample)
─────────────────────────────────────────────────────────────── */

async function buildHistoryForEmail(emailNorm, shared = null) {
  const E = normEmail(emailNorm);
  const domain = extractDomain(E);
  if (!domain || domain === "N/A") return {};

  const domainPromise =
    shared?.domain === domain && shared?.domainReputation !== undefined
      ? Promise.resolve(shared.domainReputation)
      : DomainReputation.findOne({ domain }).lean();
  const trainingPromise = TrainingSample.findOne({ email: E }).lean();

  const [stats, ts] = await Promise.all([domainPromise, trainingPromise]);

  const history = {};

  if (stats && stats.sent && stats.sent > 0) {
    const domainSamples = stats.sent;
    const domainInvalidRate =
      typeof stats.invalid === "number" && stats.sent > 0
        ? stats.invalid / stats.sent
        : null;

    if (domainInvalidRate != null) {
      history.domainInvalidRate = domainInvalidRate;
      history.domainSamples = domainSamples;

      // keep same mapping style used in bulk
      history.providerInvalidRate = domainInvalidRate;
      history.providerSamples = domainSamples;
    }
  }

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
    history.trainingLabel = ts.lastLabel || null;
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
    (a, b) => (b.success || 0) - (a.success || 0),
  );
  return sorted
    .map((p) => p.code)
    .filter((c) => c && FIXED_CODES_50.includes(c));
}

function scorePatternDoc(doc = {}) {
  const attempts = Math.max(0, Number(doc.attempts || 0));
  const success = Math.max(0, Number(doc.success || 0));
  const smoothedRate = (success + 1) / (attempts + 3);
  const volumeBoost = Math.log10(success + 1);
  const recencyBonus = doc.lastSuccessAt ? 0.15 : 0;
  return smoothedRate * 100 + volumeBoost + recencyBonus;
}

async function getPreferredCodesGlobal(limit = FIXED_CODES_50.length) {
  const PatternSet = getPatternSetModel();
  const docs = await PatternSet.find(
    { code: { $in: FIXED_CODES_50 } },
    { code: 1, attempts: 1, success: 1, lastSuccessAt: 1 },
  ).lean();

  return docs
    .sort((a, b) => scorePatternDoc(b) - scorePatternDoc(a))
    .map((doc) => doc.code)
    .filter(Boolean)
    .slice(0, Math.max(0, limit));
}

async function bumpAttempts(domain) {
  const d = String(domain || "").toLowerCase();
  await DomainPattern.updateOne(
    { domain: d },
    { $setOnInsert: { domain: d, attempts: 0 } },
    { upsert: true },
  );
  await DomainPattern.updateOne({ domain: d }, { $inc: { attempts: 1 } });
}

async function recordPatternSuccess(domain, code) {
  if (!code) return;
  const d = String(domain || "").toLowerCase();

  await DomainPattern.updateOne(
    { domain: d },
    { $setOnInsert: { domain: d, attempts: 0 } },
    { upsert: true },
  );

  const bump = await DomainPattern.updateOne(
    { domain: d, "patterns.code": code },
    {
      $inc: { "patterns.$.success": 1 },
      $set: { "patterns.$.lastSuccessAt": new Date() },
    },
  );

  if (!bump.matchedCount && !bump.modifiedCount) {
    await DomainPattern.updateOne(
      { domain: d },
      { $push: { patterns: { code, success: 1, lastSuccessAt: new Date() } } },
    );
  }
}

function isTransientMongoAuthError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toUpperCase();
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("TOPOLOGY IS CLOSED") ||
    message.includes("SERVER SELECTION") ||
    err?.name === "MongoNetworkError" ||
    err?.name === "MongoServerSelectionError"
  );
}

async function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findUserWithRetry(filter, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await User.findOne(filter).lean();
    } catch (err) {
      lastErr = err;
      if (!isTransientMongoAuthError(err) || i === attempts - 1) throw err;
      await waitMs(150 * (i + 1));
    }
  }
  throw lastErr;
}

async function findUserByIdWithRetry(id, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await User.findById(id).lean();
    } catch (err) {
      lastErr = err;
      if (!isTransientMongoAuthError(err) || i === attempts - 1) throw err;
      await waitMs(150 * (i + 1));
    }
  }
  throw lastErr;
}

async function recordGlobalPatternAttempts(codes = []) {
  const normalized = [...new Set((codes || []).filter((code) => FIXED_CODES_50.includes(code)))];
  if (!normalized.length) return;

  const now = new Date();
  const PatternSet = getPatternSetModel();

  await PatternSet.bulkWrite(
    normalized.map((code) => ({
      updateOne: {
        filter: { code },
        update: {
          $setOnInsert: { code },
          $inc: { attempts: 1 },
          $set: { lastTriedAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function recordGlobalPatternSuccess(code) {
  if (!FIXED_CODES_50.includes(code)) return;

  const now = new Date();
  const PatternSet = getPatternSetModel();
  await PatternSet.updateOne(
    { code },
    {
      $setOnInsert: { code },
      $inc: { success: 1 },
      $set: { lastSuccessAt: now },
    },
    { upsert: true },
  );
}

async function recordPatternSuccessFromCache(domain, code) {
  await Promise.all([
    recordPatternSuccess(domain, code),
    recordGlobalPatternSuccess(code),
  ]);
}

async function createFinderJob(Finder, payload) {
  const now = new Date();
  try {
    const doc = new Finder({
      ...payload,
      createdAt: now,
      updatedAt: now,
    });
    await doc.save();
    const out = doc.toObject ? doc.toObject() : doc;
    out.__reusedExisting = false;
    out.__shouldStartWorker = payload.state === "running";
    return out;
  } catch (err) {
    const isDup = err?.code === 11000;
    if (!isDup) throw err;

    const identity = {
      userId: payload.userId,
      domain: payload.domain,
      first: payload.first,
      last: payload.last,
    };

    const existing = await Finder.findOne(identity).lean();
    if (!existing) throw err;

    if (payload.state === "running" && existing.state === "running") {
      return {
        ...existing,
        __reusedExisting: true,
        __shouldStartWorker: false,
      };
    }

    const updated = await Finder.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          ...payload,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: existing.createdAt || now },
      },
      { new: true },
    ).lean();

    return {
      ...updated,
      __reusedExisting: true,
      __shouldStartWorker: payload.state === "running",
    };
  }
}

function makeCandidatesWithPriorityParts(
  domain,
  nameParts,
  preferredCodes = [],
  globalPreferredCodes = [],
) {
  const d = String(domain || "")
    .toLowerCase()
    .trim();
  if (!d || !nameParts?.first) return [];

  const finalPairs = [];
  const seenLocal = new Set();

  const orderedCodes = [
    ...(preferredCodes || []),
    ...(globalPreferredCodes || []),
    ...FIXED_CODES_50,
  ];

  for (const code of orderedCodes) {
    if (!FIXED_CODES_50.includes(code)) continue;
    const local = renderLocalFromCode(code, nameParts);
    if (!local) continue;
    if (seenLocal.has(local)) continue;
    seenLocal.add(local);
    finalPairs.push({ code, email: `${local}@${d}` });
  }

  return finalPairs;
}

/* ───────────────────────────────────────────────────────────────
   BULK-LIKE VALIDATION for ONE candidate
   ✅ NO EmailLog (no global cache, no global writes)
─────────────────────────────────────────────────────────────── */

const FRESH_DB_MS = Number(process.env.FRESH_DB_MS || 15 * 24 * 60 * 60 * 1000);
const FINDER_CONCURRENCY = Number(process.env.FINDER_CONCURRENCY || 8);
const FINDER_WAVE1 = Number(process.env.FINDER_WAVE1 || 6);
const FINDER_WAVE2 = Number(process.env.FINDER_WAVE2 || 14);
const FINDER_STABLE_TOP = Number(process.env.FINDER_STABLE_TOP || 3);
const FINDER_STABLE_WAVE2_TOP = Number(
  process.env.FINDER_STABLE_WAVE2_TOP || 6,
);
const FINDER_TOP_ONLY_COUNT = Number(process.env.FINDER_TOP_ONLY_COUNT || 5);
const FINDER_TOP_ONLY_STABLE = Number(
  process.env.FINDER_TOP_ONLY_STABLE || 2,
);

// FinderGlobal freshness window (no EmailLog)
const FRESH_FINDER_MS = Number(
  process.env.FRESH_FINDER_MS || 15 * 24 * 60 * 60 * 1000,
);

async function preloadDomainContext(domain) {
  const domainNorm = String(domain || "").trim().toLowerCase();
  if (!domainNorm) {
    return {
      domain: "",
      mxState: "invalid",
      mxRecords: [],
      mxReason: "missing_domain",
      domainReputation: null,
    };
  }

  const [mxResult, domainReputation] = await Promise.all([
    (async () => {
      try {
        const mxRecords = await dns.resolveMx(domainNorm);
        if (Array.isArray(mxRecords) && mxRecords.length > 0) {
          return { mxState: "exists", mxRecords };
        }
        return { mxState: "invalid", mxRecords: [], mxReason: "no_mx" };
      } catch (err) {
        const code = String(err?.code || "").toUpperCase();
        if (["ENOTFOUND", "NXDOMAIN", "ENODATA", "NOTFOUND"].includes(code)) {
          return {
            mxState: "invalid",
            mxRecords: [],
            mxReason: "dns_not_found",
            dnsCode: code,
          };
        }
        return {
          mxState: "unknown",
          mxRecords: [],
          mxReason: "dns_transient",
          dnsCode: code || "UNKNOWN",
        };
      }
    })(),
    DomainReputation.findOne({ domain: domainNorm }).lean(),
  ]);

  return {
    domain: domainNorm,
    domainReputation: domainReputation || null,
    ...mxResult,
  };
}

function detectGatewayFlavor(mxRecords = []) {
  const blob = (mxRecords || [])
    .map((r) => String(r?.exchange || "").toLowerCase())
    .join(" ");

  if (!blob) return "";
  if (/pphosted|ppe-hosted|proofpoint/.test(blob)) return "proofpoint";
  if (/mimecast|mcsv\.net/.test(blob)) return "mimecast";
  if (/barracuda|barracudanetworks/.test(blob)) return "barracuda";
  if (/iphmx|ironport|cisco/.test(blob)) return "ironport";
  if (/messagelabs|sophos|topsec/.test(blob)) return "gateway";
  if (/protection\.outlook\.com/.test(blob)) return "microsoft_gateway";
  return "";
}

function chooseFinderStrategy({
  shared,
  preferredCodes = [],
  globalPreferredCodes = [],
}) {
  const gatewayFlavor = detectGatewayFlavor(shared?.mxRecords);
  const hasDomainPattern = preferredCodes.length > 0;
  const hasGlobalPattern = globalPreferredCodes.length > 0;
  const mxState = String(shared?.mxState || "unknown").toLowerCase();

  const smtpUnfriendlyGateway = [
    "proofpoint",
    "mimecast",
    "barracuda",
    "ironport",
    "gateway",
  ].includes(gatewayFlavor);

  if (mxState === "invalid") {
    return {
      mode: "no_lookup",
      gatewayFlavor,
      maxCandidates: 0,
      wave1: 0,
      wave2: 0,
      stableTopWave1: 0,
      stableTopWave2: 0,
    };
  }

  if (
    smtpUnfriendlyGateway ||
    (mxState === "unknown" && (hasDomainPattern || hasGlobalPattern))
  ) {
    const maxCandidates = Math.max(
      1,
      Math.min(
        FINDER_TOP_ONLY_COUNT,
        hasDomainPattern ? preferredCodes.length + 2 : FINDER_TOP_ONLY_COUNT,
      ),
    );

    return {
      mode: "top_patterns_only",
      gatewayFlavor,
      maxCandidates,
      wave1: maxCandidates,
      wave2: 0,
      stableTopWave1: Math.min(FINDER_TOP_ONLY_STABLE, maxCandidates),
      stableTopWave2: 0,
    };
  }

  return {
    mode: "smtp_full",
    gatewayFlavor,
    maxCandidates: Number.POSITIVE_INFINITY,
    wave1: FINDER_WAVE1,
    wave2: FINDER_WAVE2,
    stableTopWave1: FINDER_STABLE_TOP,
    stableTopWave2: FINDER_STABLE_WAVE2_TOP,
  };
}

function normalizeOutcomeCategory(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase();

  // direct categories
  if (raw === "valid" || raw.startsWith("valid")) return "valid";
  if (raw === "invalid" || raw.startsWith("invalid")) return "invalid";
  if (raw === "risky" || raw.startsWith("risky")) return "risky";
  if (raw === "unknown" || raw.startsWith("unknown")) return "unknown";

  // fuzzy matches
  if (raw.includes("risk")) return "risky";
  if (raw.includes("valid")) return "valid";
  if (raw.includes("invalid")) return "invalid";

  return "unknown";
}

async function validateCandidateBulkLike({
  email,
  username,
  jobId,
  domainLC,
  cancel,
  shared,
  allowStable = false,
}) {
  const E = normEmail(email);
  const domain = extractDomain(E) || domainLC;

  const logger = (step, message, level = "info") => {
    console.log(
      `[FINDER][${username}][${jobId}][${E}] ${step} (${level}): ${message}`,
    );
  };

  // ✅ cooperative stop ASAP
  if (cancel?.isStopped?.()) {
    return { ok: false, out: null, source: "Live" };
  }

  const mxState = shared?.mxState || "unknown";
  if (mxState === "invalid") {
    logger(
      "domain_validation",
      `Domain ${domain} is invalid for receiving mail (${shared?.mxReason || "no_mx"})`,
      "warn",
    );
    const built = buildReasonAndMessage(
      "Invalid",
      shared?.mxReason === "no_mx"
        ? "invalid_domain_no_mx"
        : "invalid_domain_dns_error",
      {},
    );
    return {
      ok: false,
      out: {
        email: E,
        status: "❌ Invalid",
        subStatus:
          shared?.mxReason === "no_mx"
            ? "invalid_domain_no_mx"
            : "invalid_domain_dns_error",
        category: "invalid",
        confidence: 0.99,
        reason: "Invalid Domain",
        message:
          built.message ||
          `Domain ${domain} does not exist or cannot receive emails`,
        domain,
        domainProvider: "N/A",
        isDisposable: false,
        isFree: false,
        isRoleBased: false,
        score: 0,
      },
      source: "Live",
    };
  }

  if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

  // Track SMTP-only categories to apply "trust SMTP valid"
  let smtpPrimaryCat = null;
  let smtpStableCat = null;

  let final = null;

  // helper: merge with history and return final formatted object
  const finalize = async (raw, providerLabelForMerge) => {
    const history = await buildHistoryForEmail(E, shared);

    const merged = mergeSMTPWithHistory(raw, history, {
      domain: raw.domain || domain,
      provider: raw.provider || providerLabelForMerge || "Unavailable",
    });

    const subStatus = merged.sub_status || merged.subStatus || null;
    const status = merged.status || raw.status || "❔ Unknown";
    const cat = merged.category || categoryFromStatus(status || "");

    const confidence =
      typeof merged.confidence === "number"
        ? merged.confidence
        : typeof raw.confidence === "number"
          ? raw.confidence
          : null;

    const built = buildReasonAndMessage(status, subStatus, {
      isDisposable: !!merged.isDisposable,
      isRoleBased: !!merged.isRoleBased,
      isFree: !!merged.isFree,
    });

    return {
      email: E,
      status,
      subStatus,
      category: String(cat || "unknown").toLowerCase(),
      confidence,
      reason: merged.reason || built.reasonLabel,
      message: merged.message || built.message,
      domain: merged.domain || domain,
      domainProvider: merged.provider || raw.provider || providerLabelForMerge,
      isDisposable: !!merged.isDisposable,
      isFree: !!merged.isFree,
      isRoleBased: !!merged.isRoleBased,
      score:
        typeof merged.score === "number"
          ? merged.score
          : typeof raw.score === "number"
            ? raw.score
            : 0,
      isCatchAll: merged.isCatchAll === true,
      timestamp: new Date(),
    };
  };

  if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

  // Finder uses SMTP/history only. No SendGrid fallback is allowed here.
  try {
    const prelimRaw = await validateSMTP(E, { logger, trainingTag: "finder" });

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    smtpPrimaryCat =
      prelimRaw.category || categoryFromStatus(prelimRaw.status || "");

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    const prelimMerged = await finalize(
      {
        ...prelimRaw,
        category:
          prelimRaw.category || categoryFromStatus(prelimRaw.status || ""),
      },
      prelimRaw.provider || "Unavailable",
    );

    if (
      String(prelimMerged.category || "unknown").toLowerCase() !== "unknown"
    ) {
      final = prelimMerged;
    }

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    // If still not final, run SMTP stable only for top-ranked candidates.
    if (!final && allowStable) {
      const stableRaw = await validateSMTPStable(E, {
        logger,
        trainingTag: "finder",
      });

      if (cancel?.isStopped?.())
        return { ok: false, out: null, source: "Live" };

      smtpStableCat =
        stableRaw.category || categoryFromStatus(stableRaw.status || "");

      if (cancel?.isStopped?.())
        return { ok: false, out: null, source: "Live" };

      final = await finalize(
        {
          ...stableRaw,
          category:
            stableRaw.category || categoryFromStatus(stableRaw.status || ""),
        },
        stableRaw.provider || "Unavailable",
      );
    }
  } catch (e) {
    logger("smtp_error", e?.message || "SMTP error", "warn");
    const builtUnknown = buildReasonAndMessage("❔ Unknown", null, {});
    final = {
      email: E,
      status: "❔ Unknown",
      subStatus: null,
      category: "unknown",
      confidence: null,
      reason: builtUnknown.reasonLabel,
      message: builtUnknown.message,
      domain,
      domainProvider: "Unavailable",
      isDisposable: false,
      isFree: false,
      isRoleBased: false,
      score: 0,
      isCatchAll: false,
      timestamp: new Date(),
    };
  }

  if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

  // ✅ Bulk rule: always trust SMTP Valid over history downgrade to Risky
  if (final) {
    const smtpCat = String(smtpStableCat || smtpPrimaryCat || "").trim().toLowerCase();
    const finalCat = String(
      normalizeOutcomeCategory(final?.category || final?.status || ""),
    ).toLowerCase();

    if (smtpCat === "valid" && finalCat === "risky") {
      final.category = "valid";
      final.status = "✅ Valid";
    }
  }

  return {
    ok: isDeliverable(final),
    out: final,
    source: "Live",
  };
}

/* ───────────────────────────────────────────────────────────────
   FIND deliverable among candidates (first valid wins)
   ✅ worker-pool + cooperative stop
─────────────────────────────────────────────────────────────── */

async function findDeliverableParallelEnhanced(
  candidates,
  { concurrency = FINDER_CONCURRENCY, username, jobId, domainLC, shared, strategy },
) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const domainShared = shared || (await preloadDomainContext(domainLC));
  if (domainShared.mxState === "invalid") return null;

  const executionPlan =
    strategy ||
    chooseFinderStrategy({
      shared: domainShared,
      preferredCodes: [],
      globalPreferredCodes: [],
    });

  if (executionPlan.mode === "no_lookup") return null;

  const scopedCandidates = Number.isFinite(executionPlan.maxCandidates)
    ? candidates.slice(0, executionPlan.maxCandidates)
    : candidates;

  if (!scopedCandidates.length) return null;

  async function runBatch(batch, startIndex, stableTopCount) {
    let nextIndex = 0;
    let winner = null;
    let stopped = false;
    const triedCodes = [];

    const cancel = {
      isStopped: () => stopped,
      stop: () => {
        stopped = true;
      },
    };

    async function worker() {
      while (!cancel.isStopped()) {
        const localIndex = nextIndex++;
        if (localIndex >= batch.length) return;

        const cObj = batch[localIndex];
        triedCodes.push(cObj.code);
        try {
          const got = await validateCandidateBulkLike({
            email: cObj.email,
            username,
            jobId,
            domainLC,
            cancel,
            shared: domainShared,
            allowStable: localIndex < stableTopCount,
          });

          if (cancel.isStopped()) return;

          if (got?.ok && !winner) {
            winner = {
              code: cObj.code,
              email: cObj.email,
              out: got.out,
              source: got.source || "Live",
              index: startIndex + localIndex,
            };
            cancel.stop();
            return;
          }
        } catch {
          // ignore individual candidate failure
        }
      }
    }

    const n = Math.max(1, Math.min(concurrency, batch.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    await recordGlobalPatternAttempts(triedCodes);
    return winner;
  }

  const wave1End = Math.min(executionPlan.wave1, scopedCandidates.length);
  const wave2End = Math.min(
    executionPlan.wave1 + executionPlan.wave2,
    scopedCandidates.length,
  );

  const wave1 = scopedCandidates.slice(0, wave1End);
  const wave2 = scopedCandidates.slice(wave1End, wave2End);
  const wave3 = scopedCandidates.slice(wave2End);

  let winner = await runBatch(
    wave1,
    0,
    Math.min(executionPlan.stableTopWave1, wave1.length),
  );

  if (!winner && wave2.length) {
    winner = await runBatch(
      wave2,
      wave1End,
      Math.min(executionPlan.stableTopWave2, wave2.length),
    );
  }

  if (!winner && wave3.length) {
    winner = await runBatch(wave3, wave2End, 0);
  }

  if (!winner) return null;

  return {
    email: winner.email,
    final: winner.out,
    code: winner.code,
    index: winner.index,
    source: winner.source,
    mode: executionPlan.mode,
  };
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

          const update = { $setOnInsert: { domain, base, tld, sampleEmail } };
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
    },
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
        qLower.replace(/^https?:\/\//, "").replace(/^www\./, ""),
      );

      const results = await Domain.find(
        { domain: { $regex: "^" + domainPrefix, $options: "i" } },
        { domain: 1 },
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
      const username = req.user.username;

      const Finder = getFinderModelByTenant(tenant);

      const first = nameParts.first;
      const last = nameParts.last || "";

      const baseFilter = { userId, domain: domainLC, first, last };

      /* ✅ 0) GLOBAL FINDER CACHE CHECK FIRST (NO EmailLog)
         Trust global cache ONLY if FinderGlobal is fresh + Valid.
      */
      const globalHit = await FinderGlobal.findOne({
        domain: domainLC,
        first,
        last,
        email: { $ne: null },
      }).lean();

      if (globalHit?.email) {
        const gUpdated = new Date(
          globalHit.updatedAt || globalHit.createdAt || 0,
        ).getTime();
        const gFresh = gUpdated
          ? Date.now() - gUpdated <= FRESH_FINDER_MS
          : false;

        const gStatus = String(globalHit.status || "").toLowerCase();
        const gValid = gStatus === "valid";

        if (gFresh && gValid) {
          await FinderGlobal.updateOne(
            { _id: globalHit._id },
            { $set: { updatedAt: new Date() } },
          );

          const userDoc = createVirtualFinderJob({
            state: "done",
            status: "Valid",
            fullName: fullName.trim(),
            domain: domainLC,
            email: globalHit.email,
            confidence: globalHit.confidence || "Med",
            reason: globalHit.reason || "",
            error: "",
          });

          const quickPairs = buildFixedPairs(nameParts, domainLC);
          const hit = quickPairs.find(
            (p) =>
              p.email.toLowerCase() === String(globalHit.email).toLowerCase(),
          );
          if (hit?.code)
            await recordPatternSuccessFromCache(domainLC, hit.code);

          await User.findOneAndUpdate(
            { _id: userId, credits: { $gt: 0 } },
            { $inc: { credits: -1 } },
            { new: true },
          ).lean();

          return res.json({ ok: true, jobId: String(userDoc._id) });
        }
      }

      /* ✅ 1) USER FINDER CACHE CHECK SECOND (ONLY if stored result is Valid) */
      const userHit = await Finder.findOne({
        ...baseFilter,
        email: { $ne: null },
      }).lean();

      if (
        userHit?.email &&
        String(userHit.status || "").toLowerCase() === "valid"
      ) {
        await Finder.updateOne(
          { _id: userHit._id, userId },
          { $set: { updatedAt: new Date() } },
        );

        await FinderGlobal.updateOne(
          { domain: domainLC, first, last },
          {
            $set: {
              domain: domainLC,
              first,
              last,
              email: userHit.email,
              status: "Valid",
              confidence: userHit.confidence || "Med",
              reason: userHit.reason || "",
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        );

        await User.findOneAndUpdate(
          { _id: userId, credits: { $gt: 0 } },
          { $inc: { credits: -1 } },
          { new: true },
        ).lean();

        const userDoc = createVirtualFinderJob({
          state: "done",
          status: "Valid",
          fullName: fullName.trim(),
          domain: domainLC,
          email: userHit.email,
          confidence: userHit.confidence || "Med",
          reason: userHit.reason || "",
          error: "",
        });

        return res.json({ ok: true, jobId: String(userDoc._id) });
      }

      /* ✅ 2) NO CACHE → create a fresh independent running job */
      const doc = await createFinderJob(Finder, {
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
      });

      // Return jobId immediately
      res.json({ ok: true, jobId: String(doc._id) });

      if (doc.__shouldStartWorker === false) {
        return;
      }

      // Background execution
      setImmediate(async () => {
        try {
          await bumpAttempts(domainLC);
          const [shared, preferredCodes, globalPreferredCodes] = await Promise.all([
            preloadDomainContext(domainLC),
            getPreferredCodesForDomain(domainLC),
            getPreferredCodesGlobal(),
          ]);

          const strategy = chooseFinderStrategy({
            shared,
            preferredCodes,
            globalPreferredCodes,
          });

          const candidates = makeCandidatesWithPriorityParts(
            domainLC,
            nameParts,
            preferredCodes,
            globalPreferredCodes,
          );

          const found = await findDeliverableParallelEnhanced(candidates, {
            concurrency: FINDER_CONCURRENCY,
            username,
            jobId: String(doc._id),
            domainLC,
            shared,
            strategy,
          });

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
              },
            );
            return;
          }

          const bestEmail = found.email;
          const bestFinal = found.final || {};
          const bestCode = found.code;

          const confidence = deriveConfidence({
            category: bestFinal.category || "valid",
            reason: bestFinal.reason || "",
            subStatus: bestFinal.subStatus || bestFinal.sub_status || "",
            isCatchAll: bestFinal.isCatchAll,
            smtpAccepted: bestFinal.category === "valid",
          });

          const finalIsValid =
            String(bestFinal?.category || "").toLowerCase() === "valid";

          // ✅ Store ONLY if final is Valid, else store null email
          await Finder.updateOne(
            { _id: doc._id, userId },
            {
              $set: {
                state: "done",
                status: finalIsValid ? "Valid" : "Unknown",
                confidence,
                email: finalIsValid ? bestEmail : null,
                reason: bestFinal?.reason || bestFinal?.message || "",
                error: "",
                updatedAt: new Date(),
              },
            },
          );

          if (finalIsValid) {
            await FinderGlobal.updateOne(
              { domain: domainLC, first, last },
              {
                $set: {
                  domain: domainLC,
                  first,
                  last,
                  nameInput: fullName.trim(),
                  state: "done",
                  status: "Valid",
                  confidence,
                  email: bestEmail,
                  reason: bestFinal?.reason || bestFinal?.message || "",
                  error: "",
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true },
            );
          }

          if (finalIsValid && bestCode)
            await Promise.all([
              recordPatternSuccess(domainLC, bestCode),
              recordGlobalPatternSuccess(bestCode),
            ]);

          // domain sample only if valid
          if (finalIsValid) {
            await upsertDomainSample(domainLC, bestEmail);
          }

          await User.findOneAndUpdate(
            { _id: userId, credits: { $gt: 0 } },
            { $inc: { credits: -1 } },
            { new: true },
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
            },
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
      cleanupVirtualFinderJobs();
      const virtualJob = virtualFinderJobs.get(String(req.params.id));
      if (virtualJob) {
        return res.json({
          _id: String(virtualJob._id),
          state: virtualJob.state || "done",
          status: virtualJob.status || "Unknown",
          fullName: virtualJob.fullName || "",
          domain: virtualJob.domain || "",
          email: virtualJob.email || "",
          confidence: virtualJob.confidence || "Low",
          reason: virtualJob.reason || "",
          error: virtualJob.error || "",
          createdAt: virtualJob.createdAt,
          updatedAt: virtualJob.updatedAt,
        });
      }

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
  ──────────────────────────────────────────────────────────────── */
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
