// routes/phoneValidator.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const twilio = require("twilio");

const User = require("../models/User"); // global User collection

const router = express.Router();

/* ─────────────────────────────────────────────
   Helpers to normalize tenant and get tenant DB
───────────────────────────────────────────── */
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

/**
 * Create a stable cache key for both global and user-level lookups.
 * We avoid relying only on E.164 because we won't have it before Twilio.
 *
 * Example: "IN:919999888877"  (digits only)
 */
function buildLookupKey(phoneRaw, countryCode) {
  const digitsOnly = String(phoneRaw || "").replace(/[^\d]/g, "");
  const cc = String(countryCode || "").trim().toUpperCase();
  return `${cc}:${digitsOnly}`;
}

/* ─────────────────────────────────────────────
   Tenant model (per-user DB)
───────────────────────────────────────────── */
function getPhoneModelByTenant(tenant) {
  const conn = getUserDbByTenant(tenant);

  // reuse compiled model if present
  if (conn.models.PhoneCheck) return conn.models.PhoneCheck;

  const PhoneSchema = new mongoose.Schema(
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true,
      },

      // cache key for quick lookup
      lookupKey: { type: String, required: true, index: true },

      // raw input from user (no +)
      inputNumber: { type: String, required: true },

      // dropdown choice e.g. "IN", "US"
      inputCountry: { type: String },

      // normalized +E.164 from Twilio
      e164: { type: String },

      // Twilio countryCode ("IN","US", etc.)
      country: { type: String },

      // carrier name like "Bharti Airtel Limited"
      carrier: { type: String },

      // "mobile" | "landline" | "voip" | "fixedVoip" etc.
      lineType: { type: String },

      // CNAM / Caller name (mostly US)
      callerName: { type: String },

      // caller_type / owner type (BUSINESS / CONSUMER / UNDETERMINED)
      ownerType: { type: String },

      // Twilio validity
      valid: { type: Boolean, default: false },

      // Our own scoring
      leadQualityScore: { type: Number, default: null }, // (raw points)
      leadQualityPercentage: { type: Number, default: null }, // 0–100 (NEW)
      leadQualityBand: {
        type: String,
        enum: ["high", "medium", "low", null],
        default: null,
      },

      // where the response came from (helps debugging)
      source: {
        type: String,
        enum: ["global-cache", "user-cache", "twilio"],
        default: "twilio",
      },
    },
    {
      timestamps: true,
      collection: "phone_checks",
    }
  );

  return conn.model("PhoneCheck", PhoneSchema);
}

/* ─────────────────────────────────────────────
   Global model (default DB)
   Stores shared phone lookup results for caching across users.
───────────────────────────────────────────── */
function getGlobalPhoneModel() {
  // reuse compiled model if present
  if (mongoose.models.GlobalPhoneCheck) return mongoose.models.GlobalPhoneCheck;

  const GlobalPhoneSchema = new mongoose.Schema(
    {
      // cache key for quick lookup
      lookupKey: { type: String, required: true, unique: true, index: true },

      // last raw input observed (optional)
      lastInputNumber: { type: String, default: null },
      lastInputCountry: { type: String, default: null },

      // normalized +E.164 from Twilio
      e164: { type: String, default: null },

      // Twilio countryCode ("IN","US", etc.)
      country: { type: String, default: null },

      carrier: { type: String, default: null },
      lineType: { type: String, default: null },
      callerName: { type: String, default: null },
      ownerType: { type: String, default: null },

      valid: { type: Boolean, default: false },

      leadQualityScore: { type: Number, default: null },
      leadQualityPercentage: { type: Number, default: null }, // 0–100 (NEW)
      leadQualityBand: {
        type: String,
        enum: ["high", "medium", "low", null],
        default: null,
      },

      // optional usage info
      lastCheckedAt: { type: Date, default: null },
    },
    {
      timestamps: true,
      collection: "phone_checks_global",
    }
  );

  return mongoose.model("GlobalPhoneCheck", GlobalPhoneSchema);
}

/* ─────────────────────────────────────────────
   Lead quality scorer (UPDATED to your new rules)
───────────────────────────────────────────── */

/**
 * Max possible score depends on country:
 * - US: max 98
 * - CA: max 45 (valid only), invalid 0
 * - Others: max 78 (no ownerType contribution)
 */
function getMaxScoreByCountry(ccUpper) {
  const cc = String(ccUpper || "").trim().toUpperCase();
  if (cc === "US") return 98;
  if (cc === "CA") return 45;
  return 78;
}

function scoreToPercentage(score, ccUpper) {
  const max = getMaxScoreByCountry(ccUpper);
  if (score === null || score === undefined) return null;
  if (!max) return 0;
  let pct = (Number(score) / max) * 100;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return Math.round(pct); // percentage as whole number
}

function computeLeadQuality(normalized, inputCountryCode) {
  const cc = String(inputCountryCode || normalized.country || "")
    .trim()
    .toUpperCase();

  // COUNTRY RULES
  const isUS = cc === "US";
  const isCA = cc === "CA";

  // 1) Validity
  if (!normalized.valid) {
    const score = 0;
    const percentage = 0;
    const band = "low";
    return { score, percentage, band };
  }

  // Canada: only validity matters
  if (isCA) {
    const score = 45;
    const percentage = scoreToPercentage(score, cc); // will be 100
    const band = "high"; // valid in CA is max possible
    return { score, percentage, band };
  }

  let score = 0;

  // Valid baseline
  score += 45;

  // 2) Line type (VOIP/nonFixedVoip = 0 now)
  const line = (normalized.lineType || "").toLowerCase();
  if (line === "mobile") score += 25;
  else if (line === "landline") score += 15;
  else if (line === "voip" || line === "fixedvoip" || line === "nonfixedvoip")
    score += 0;

  // 3) Owner type (ONLY for US)
  if (isUS) {
    const owner = (normalized.ownerType || "").toUpperCase();
    if (owner === "BUSINESS") score += 20;
    else if (owner === "CONSUMER") score += 10;
    // UNDETERMINED / missing = 0
  }

  // 4) Carrier reputation (missing -10, voip carrier 0, real telecom +8)
  const carrier = (normalized.carrier || "").toLowerCase();
  if (!carrier) score -= 10;
  else if (
    carrier.includes("twilio") ||
    carrier.includes("google voice") ||
    carrier.includes("onvoy") ||
    carrier.includes("bandwidth") ||
    carrier.includes("voip")
  ) {
    score += 0;
  } else {
    score += 8;
  }

  // Clamp score to 0..100 (as you already do)
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  const percentage = scoreToPercentage(score, cc);

  // band on percentage (keeps old thresholds but now truly normalized)
  let band = "low";
  if (percentage >= 75) band = "high";
  else if (percentage >= 45) band = "medium";

  return { score, percentage, band };
}

/* ─────────────────────────────────────────────
   Auth middleware (your same pattern)
───────────────────────────────────────────── */
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

      if (!userDoc) {
        return res.status(401).json({ error: "Unauthorized (unknown X-User)" });
      }
    } else if (req.user?.id) {
      userDoc = await User.findById(req.user.id).lean();
      if (!userDoc) {
        return res
          .status(401)
          .json({ error: "Unauthorized (invalid token user)" });
      }
    } else {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tenant = normalizeTenant(userDoc.username);
    req.user = { id: userDoc._id, username: userDoc.username };
    req.tenant = tenant;

    next();
  } catch (e) {
    console.error("auth error (phoneValidator)", e);
    return res.status(500).json({ error: "Auth error" });
  }
}

/* ─────────────────────────────────────────────
   Twilio client
───────────────────────────────────────────── */
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const DEV_PHONE_LOG = String(process.env.DEV_PHONE_LOG || "").trim() === "1";

if (!accountSid || !authToken) {
  console.warn(
    "[PhoneValidator] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env"
  );
}

const twilioClient = twilio(accountSid, authToken);

/* ─────────────────────────────────────────────
   Credit helper
   Deduct exactly 1 credit only on successful validation (cache or twilio).
───────────────────────────────────────────── */
async function deductOneCreditOrFail(userId) {
  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, credits: { $gt: 0 } },
    { $inc: { credits: -1 } },
    { new: true }
  ).lean();

  if (!updatedUser) return { ok: false, creditsLeft: 0 };
  return { ok: true, creditsLeft: updatedUser.credits };
}

/* ─────────────────────────────────────────────
   POST /api/phone/validate
   Cache order: Global -> User -> Twilio
   Charge credits for all successful (cache/twilio).

   ✅ Requirement: If record exists, DO NOT add a new record.
   ✅ Just update timestamps (updatedAt / lastCheckedAt).
───────────────────────────────────────────── */
router.post("/validate", requireAuth, async (req, res) => {
  try {
    let { phone, countryCode } = req.body;

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        ok: false,
        error: "missing_phone",
        message: "Phone number is required",
      });
    }

    if (!countryCode || !String(countryCode).trim()) {
      return res.status(400).json({
        ok: false,
        error: "missing_country",
        message: "Country code is required",
      });
    }

    const tenant = req.tenant;
    const userId = req.user.id;
    const username = req.user.username;

    // keep raw copy for DB
    const rawInputNumber = String(phone).trim();

    // strip spaces/dashes etc. (keep + only for Twilio input)
    const phoneSanitized = rawInputNumber.replace(/[^\d+]/g, "");
    const cc = String(countryCode).trim().toUpperCase();

    // stable cache key (digits only)
    const lookupKey = buildLookupKey(rawInputNumber, cc);

    // Check credits availability (do NOT deduct yet; only deduct on success)
    const userDoc = await User.findOne({ _id: userId }).lean();
    if (!userDoc || (userDoc.credits || 0) <= 0) {
      return res.status(402).json({
        ok: false,
        error: "no_credits",
        message: "Not enough credits",
      });
    }

    const GlobalPhone = getGlobalPhoneModel();
    const PhoneCheck = getPhoneModelByTenant(tenant);
    const now = new Date();

    // ─────────────────────────────────────────
    // 1) GLOBAL cache lookup
    // ─────────────────────────────────────────
    const globalHit = await GlobalPhone.findOne({ lookupKey }).lean();

    if (globalHit) {
      // charge (even for cache)
      const charged = await deductOneCreditOrFail(userId);
      if (!charged.ok) {
        return res.status(402).json({
          ok: false,
          error: "no_credits",
          message: "Not enough credits",
        });
      }

      // Ensure percentage exists (for old cached rows)
      const computedPct =
        globalHit.leadQualityPercentage !== null &&
        globalHit.leadQualityPercentage !== undefined
          ? globalHit.leadQualityPercentage
          : scoreToPercentage(globalHit.leadQualityScore, cc);

      // Touch global timestamp (+ backfill percentage if needed)
      await GlobalPhone.updateOne(
        { lookupKey },
        {
          $set: {
            lastCheckedAt: now,
            updatedAt: now,
            ...(globalHit.leadQualityPercentage === null ||
            globalHit.leadQualityPercentage === undefined
              ? { leadQualityPercentage: computedPct }
              : {}),
          },
        }
      );

      // ✅ Upsert into tenant history (NO new record if exists)
      const saved = await PhoneCheck.findOneAndUpdate(
        { userId, lookupKey },
        {
          $set: {
            inputNumber: rawInputNumber,
            inputCountry: cc,
            e164: globalHit.e164,
            country: globalHit.country,
            carrier: globalHit.carrier,
            lineType: globalHit.lineType,
            callerName: globalHit.callerName,
            ownerType: globalHit.ownerType,
            valid: globalHit.valid,
            leadQualityScore: globalHit.leadQualityScore,
            leadQualityPercentage: computedPct,
            leadQualityBand: globalHit.leadQualityBand,
            source: "global-cache",
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, new: true }
      ).lean();

      return res.json({
        ok: true,
        phone: globalHit.e164 || phoneSanitized,
        valid: Boolean(globalHit.valid),
        carrier: globalHit.carrier,
        lineType: globalHit.lineType,
        country: globalHit.country,
        callerName: globalHit.callerName,
        ownerType: globalHit.ownerType,
        createdAt: saved.updatedAt,
        creditsLeft: charged.creditsLeft,
        username,
        leadQuality: globalHit.leadQualityBand,
        leadQualityScore: globalHit.leadQualityScore,
        leadQualityPercentage: computedPct, // NEW
        fromCache: true,
        cacheLevel: "global",
      });
    }

    // ─────────────────────────────────────────
    // 2) USER tenant cache lookup (for this user)
    // ─────────────────────────────────────────
    const userHit = await PhoneCheck.findOne({ userId, lookupKey }).lean();

    if (userHit) {
      // charge (even for cache)
      const charged = await deductOneCreditOrFail(userId);
      if (!charged.ok) {
        return res.status(402).json({
          ok: false,
          error: "no_credits",
          message: "Not enough credits",
        });
      }

      // Ensure percentage exists (for old cached rows)
      const computedPct =
        userHit.leadQualityPercentage !== null &&
        userHit.leadQualityPercentage !== undefined
          ? userHit.leadQualityPercentage
          : scoreToPercentage(userHit.leadQualityScore, cc);

      // ✅ Touch tenant timestamps only (NO new record)
      const touched = await PhoneCheck.findOneAndUpdate(
        { _id: userHit._id },
        {
          $set: {
            updatedAt: now,
            source: "user-cache",
            ...(userHit.leadQualityPercentage === null ||
            userHit.leadQualityPercentage === undefined
              ? { leadQualityPercentage: computedPct }
              : {}),
          },
        },
        { new: true }
      ).lean();

      // ✅ ALSO upsert into GLOBAL (so it becomes available to everyone)
      await GlobalPhone.updateOne(
        { lookupKey },
        {
          $set: {
            lookupKey,
            lastInputNumber: touched.inputNumber,
            lastInputCountry: touched.inputCountry,
            e164: touched.e164,
            country: touched.country,
            carrier: touched.carrier,
            lineType: touched.lineType,
            callerName: touched.callerName,
            ownerType: touched.ownerType,
            valid: touched.valid,
            leadQualityScore: touched.leadQualityScore,
            leadQualityPercentage: computedPct,
            leadQualityBand: touched.leadQualityBand,
            lastCheckedAt: now,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      return res.json({
        ok: true,
        phone: touched.e164 || phoneSanitized,
        valid: Boolean(touched.valid),
        carrier: touched.carrier,
        lineType: touched.lineType,
        country: touched.country,
        callerName: touched.callerName,
        ownerType: touched.ownerType,
        createdAt: touched.updatedAt,
        creditsLeft: charged.creditsLeft,
        username,
        leadQuality: touched.leadQualityBand,
        leadQualityScore: touched.leadQualityScore,
        leadQualityPercentage: computedPct, // NEW
        fromCache: true,
        cacheLevel: "user",
      });
    }

    // ─────────────────────────────────────────
    // 3) Twilio lookup (no cache found)
    // ─────────────────────────────────────────
    const DEFAULT_FIELDS = "caller_name,line_type_intelligence";
    const fieldsEnv = process.env.TWILIO_LOOKUP_FIELDS || DEFAULT_FIELDS;

    const fieldsArray = fieldsEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const ALLOWED_FIELDS = new Set([
      "validation",
      "caller_name",
      "sim_swap",
      "call_forwarding",
      "line_status",
      "line_type_intelligence",
      "identity_match",
      "reassigned_number",
      "sms_pumping_risk",
      "phone_number_quality_score",
      "pre_fill",
    ]);

    const safeFields = fieldsArray.filter((f) => ALLOWED_FIELDS.has(f));

    const fetchOptions = { countryCode: cc };
    if (safeFields.length) fetchOptions.fields = safeFields.join(",");

    if (DEV_PHONE_LOG) {
      console.log("───────────────────────────────");
      console.log("[PhoneValidator] Twilio request:");
      console.log("  phone        :", phoneSanitized);
      console.log("  countryCode  :", cc);
      console.log("  fields       :", fetchOptions.fields || "(none)");
      console.log("  lookupKey    :", lookupKey);
    }

    let twilioData;
    try {
      twilioData = await twilioClient.lookups.v2
        .phoneNumbers(phoneSanitized)
        .fetch(fetchOptions);

      if (DEV_PHONE_LOG) {
        console.log("[PhoneValidator] Twilio raw response:");
        console.log(JSON.stringify(twilioData, null, 2).slice(0, 4000));
      }
    } catch (err) {
      console.error("[Twilio Lookup Error]", err?.message || err);

      if (DEV_PHONE_LOG) {
        console.error(
          "[PhoneValidator] Twilio error full object:",
          JSON.stringify(
            {
              status: err?.status,
              code: err?.code,
              moreInfo: err?.moreInfo,
              details: err?.details,
              stack: err?.stack,
            },
            null,
            2
          )
        );
      }

      return res.status(500).json({
        ok: false,
        error: "twilio_failed",
        message: err?.message || "Twilio lookup failed",
      });
    }

    const lti = twilioData.lineTypeIntelligence || {};
    const caller = twilioData.callerName || {};

    const normalized = {
      valid: twilioData.valid === undefined ? true : Boolean(twilioData.valid),
      country: twilioData.countryCode || null,
      e164: twilioData.phoneNumber || phoneSanitized,
      carrier: lti.carrier_name || twilioData.carrier?.name || null,
      lineType: lti.type || twilioData.carrier?.type || null,
      callerName: caller.caller_name || null,
      ownerType: caller.caller_type || null,
    };

    const {
      score: leadQualityScore,
      percentage: leadQualityPercentage,
      band: leadQualityBand,
    } = computeLeadQuality(normalized, cc);

    // charge (twilio success)
    const charged = await deductOneCreditOrFail(userId);
    if (!charged.ok) {
      return res.status(402).json({
        ok: false,
        error: "no_credits",
        message: "Not enough credits",
      });
    }

    // 3A) Upsert into GLOBAL cache (shared)
    await GlobalPhone.updateOne(
      { lookupKey },
      {
        $set: {
          lookupKey,
          lastInputNumber: rawInputNumber,
          lastInputCountry: cc,
          e164: normalized.e164,
          country: normalized.country,
          carrier: normalized.carrier,
          lineType: normalized.lineType,
          callerName: normalized.callerName,
          ownerType: normalized.ownerType,
          valid: normalized.valid,
          leadQualityScore,
          leadQualityPercentage,
          leadQualityBand,
          lastCheckedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // 3B) Upsert into USER tenant history (NO new record if exists)
    const saved = await PhoneCheck.findOneAndUpdate(
      { userId, lookupKey },
      {
        $set: {
          inputNumber: rawInputNumber,
          inputCountry: cc,
          e164: normalized.e164,
          country: normalized.country,
          carrier: normalized.carrier,
          lineType: normalized.lineType,
          callerName: normalized.callerName,
          ownerType: normalized.ownerType,
          valid: normalized.valid,
          leadQualityScore,
          leadQualityPercentage,
          leadQualityBand,
          source: "twilio",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, new: true }
    ).lean();

    return res.json({
      ok: true,
      phone: normalized.e164,
      valid: normalized.valid,
      carrier: normalized.carrier,
      lineType: normalized.lineType,
      country: normalized.country,
      callerName: normalized.callerName,
      ownerType: normalized.ownerType,
      createdAt: saved.updatedAt,
      creditsLeft: charged.creditsLeft,
      username,
      leadQuality: leadQualityBand,
      leadQualityScore,
      leadQualityPercentage, // NEW
      fromCache: false,
      cacheLevel: null,
    });
  } catch (err) {
    console.error("[/api/phone/validate] Unexpected error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error",
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/phone/history
───────────────────────────────────────────── */
router.get("/history", requireAuth, async (req, res) => {
  try {
    const tenant = req.tenant;
    const userId = req.user.id;

    const PhoneCheck = getPhoneModelByTenant(tenant);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "500", 10) || 500, 1),
      500
    );

    const recent = await PhoneCheck.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      history: recent.map((row) => {
        const cc = String(row.inputCountry || row.country || "").toUpperCase();
        const pct =
          row.leadQualityPercentage !== null &&
          row.leadQualityPercentage !== undefined
            ? row.leadQualityPercentage
            : scoreToPercentage(row.leadQualityScore, cc);

        return {
          _id: row._id,
          inputNumber: row.inputNumber,
          inputCountry: row.inputCountry,
          e164: row.e164,
          valid: row.valid,
          carrier: row.carrier,
          lineType: row.lineType,
          callerName: row.callerName,
          ownerType: row.ownerType,
          country: row.country,
          createdAt: row.updatedAt,
          leadQuality: row.leadQualityBand || null,
          leadQualityScore: row.leadQualityScore || null,
          leadQualityPercentage: pct, // NEW
          source: row.source || "twilio",
        };
      }),
    });
  } catch (err) {
    console.error("[/api/phone/history] Unexpected error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error",
    });
  }
});

/* ─────────────────────────────────────────────
   DELETE /api/phone/history  (Clear history)
───────────────────────────────────────────── */
router.delete("/history", requireAuth, async (req, res) => {
  try {
    const tenant = req.tenant;
    const userId = req.user.id;

    const PhoneCheck = getPhoneModelByTenant(tenant);

    const out = await PhoneCheck.deleteMany({ userId });

    return res.json({
      ok: true,
      deletedCount: out?.deletedCount || 0,
    });
  } catch (err) {
    console.error("[/api/phone/history DELETE] Unexpected error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: "Internal server error",
    });
  }
});

module.exports = router;
