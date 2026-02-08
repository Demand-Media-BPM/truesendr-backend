// // utils/validator.js
// const dns = require("dns").promises;

// // ─────────────────────────────────────────────────────────────────────────────
// // Basic status helpers
// // ─────────────────────────────────────────────────────────────────────────────
// function categoryFromStatus(status = "") {
//   const s = String(status || "");
//   if (/\bInvalid\b/i.test(s)) return "invalid";
//   if (/\bRisky\b/i.test(s)) return "risky";
//   if (/\bValid\b/i.test(s)) return "valid";
//   return "unknown";
// }

// function normalizeStatus(status, categoryHint) {
//   const cat = categoryHint || categoryFromStatus(status);
//   if (cat === "valid") return { status: "Valid", category: "valid" };
//   if (cat === "invalid") return { status: "Invalid", category: "invalid" };
//   if (cat === "risky") return { status: "Risky", category: "risky" };
//   return { status: "Unknown", category: "unknown" };
// }

// function normEmail(email) {
//   return String(email || "").trim().toLowerCase();
// }

// function getStatusMessage(status) {
//   const s = String(status || "");
//   if (/\bInvalid\b/i.test(s))
//     return "You should not send emails to this address because, ";
//   if (/\bRisky\b/i.test(s))
//     return "This address looks risky to send to because, ";
//   if (/\bValid\b/i.test(s))
//     return "You can safely send emails to this address because, ";
//   return "Status is unknown for this address";
// }

// function mapReason(subStatus, status, flags = {}) {
//   const cat = categoryFromStatus(status);
//   const key = String(subStatus || "").toLowerCase();

//   if (cat === "valid") {
//     if (key === "owner_verified")
//       return {
//         reasonCode: "OWNER_VERIFIED",
//         reasonLabel: "Owner Verified",
//         reasonText: "Owner service verified the mailbox exists.",
//       };
//     return {
//       reasonCode: "ACCEPTED_EMAIL",
//       reasonLabel: "Accepted Email",
//       reasonText: "Email address was accepted.",
//     };
//   }

//   if (cat === "risky") {
//     if (flags.isDisposable || flags.isRoleBased)
//       return {
//         reasonCode: "LOW_QUALITY",
//         reasonLabel: "Low Quality",
//         reasonText:
//           "Email address has quality issues that may make it a risky or low-value address.",
//       };
//     if (
//       [
//         "catch_all",
//         "greylisted",
//         "gateway_protected",
//         "policy_block_spf",
//         "catch_all_owner_says_missing",
//       ].includes(key)
//     )
//       return {
//         reasonCode: "LOW_DELIVERABILITY",
//         reasonLabel: "Low Deliverability",
//         reasonText:
//           "Email address appears to be deliverable, but deliverability cannot be guaranteed.",
//       };
//     return {
//       reasonCode: "LOW_DELIVERABILITY",
//       reasonLabel: "Low Deliverability",
//       reasonText:
//         "Email address appears to be deliverable, but deliverability cannot be guaranteed.",
//     };
//   }

//   if (cat === "invalid") {
//     if (key === "syntax")
//       return {
//         reasonCode: "INVALID_EMAIL",
//         reasonLabel: "Invalid Email",
//         reasonText:
//           "Specified email doesn't have a valid email address syntax.",
//       };
//     if (key === "no_mx_or_a")
//       return {
//         reasonCode: "INVALID_DOMAIN",
//         reasonLabel: "Invalid Domain",
//         reasonText:
//           "Domain for email does not exist or has no valid DNS records.",
//       };
//     if (key === "owner_verified_missing")
//       return {
//         reasonCode: "OWNER_VERIFIED_MISSING",
//         reasonLabel: "Owner Says Missing",
//         reasonText: "Owner service reports the mailbox is missing.",
//       };
//     return {
//       reasonCode: "REJECTED_EMAIL",
//       reasonLabel: "Rejected Email",
//       reasonText:
//         "Email address was rejected by the SMTP server; it does not exist.",
//     };
//   }

//   if (key === "no_connect" || key === "network")
//     return {
//       reasonCode: "UNAVAILABLE_SMTP",
//       reasonLabel: "Unavailable SMTP",
//       reasonText:
//         "SMTP server was unavailable to process our request or we were unable to connect to it.",
//     };

//   if (key === "smtp_ambiguous")
//     return {
//       reasonCode: "TIMEOUT",
//       reasonLabel: "Timeout",
//       reasonText: "Verification required more time than was available.",
//     };

//   return {
//     reasonCode: "UNKNOWN",
//     reasonLabel: "Unknown",
//     reasonText: "An unexpected error has occurred.",
//   };
// }

// function buildReasonAndMessage(status, subStatus, flags = {}) {
//   const base = getStatusMessage(status);
//   const r = mapReason(subStatus, status, flags);
//   return { ...r, message: `${base} ${r.reasonText}` };
// }

// function extractDomain(email) {
//   return !email || !email.includes("@")
//     ? "N/A"
//     : email.split("@")[1].toLowerCase();
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Provider detection by MX
// // ─────────────────────────────────────────────────────────────────────────────
// async function detectProviderByMX(domain) {
//   try {
//     const records = await dns.resolveMx(domain);
//     const mxHosts = records.map((r) => r.exchange.toLowerCase()).join(", ");
//     if (mxHosts.includes("google.com")) return "Gmail / Google Workspace";
//     if (
//       mxHosts.includes("outlook.com") ||
//       mxHosts.includes("protection.outlook.com")
//     )
//       return "Outlook / Microsoft 365";
//     if (mxHosts.includes("zoho.com")) return "Zoho Mail";
//     if (mxHosts.includes("yahoodns.net")) return "Yahoo Mail";
//     if (mxHosts.includes("protonmail")) return "ProtonMail";
//     return `Custom / Unknown Provider [${mxHosts.split(",")[0] || "n/a"}]`;
//   } catch {
//     return "Unavailable";
//   }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Env helpers
// // ─────────────────────────────────────────────────────────────────────────────
// function parseListEnv(name) {
//   return (process.env[name] || "")
//     .split(",")
//     .map((s) => s.trim().toLowerCase())
//     .filter(Boolean);
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Disposable domains
// // ─────────────────────────────────────────────────────────────────────────────
// const DISPOSABLE_DOMAINS_BASE = [
//   "mailinator.com",
//   "yopmail.com",
//   "guerrillamail.com",
//   "10minutemail.com",
//   "temp-mail.org",
//   "tempmail.email",
//   "getnada.com",
//   "trashmail.com",
//   "sharklasers.com",
//   "dispostable.com",
//   "spamgourmet.com",
//   "mytemp.email",
//   "mintemail.com",
//   "throwawaymail.com",
//   "maildrop.cc",
//   "moakt.com",
// ];

// const DISPOSABLE_DOMAINS = new Set([
//   ...DISPOSABLE_DOMAINS_BASE,
//   ...parseListEnv("DISPOSABLE_DOMAINS_EXTRA"),
// ]);

// function isDisposableDomain(domain) {
//   if (!domain) return false;
//   const d = String(domain).toLowerCase();
//   return DISPOSABLE_DOMAINS.has(d);
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Free / consumer providers
// // ─────────────────────────────────────────────────────────────────────────────
// const FREE_EMAIL_PROVIDERS_BASE = [
//   "gmail.com",
//   "googlemail.com",
//   "yahoo.com",
//   "yahoo.co.uk",
//   "outlook.com",
//   "hotmail.com",
//   "live.com",
//   "msn.com",
//   "aol.com",
//   "icloud.com",
//   "me.com",
//   "gmx.com",
//   "mail.com",
//   "protonmail.com",
//   "proton.me",
//   "yandex.com",
//   "yandex.ru",
//   "zoho.com",
// ];

// const FREE_EMAIL_PROVIDERS = new Set([
//   ...FREE_EMAIL_PROVIDERS_BASE,
//   ...parseListEnv("FREE_PROVIDERS_EXTRA"),
// ]);

// function isFreeProvider(domain) {
//   if (!domain) return false;
//   const d = String(domain).toLowerCase();
//   return FREE_EMAIL_PROVIDERS.has(d);
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Role-based local parts
// // ─────────────────────────────────────────────────────────────────────────────
// const ROLE_BASED_LOCAL_BASE = [
//   "admin",
//   "support",
//   "info",
//   "contact",
//   "help",
//   "sales",
//   "billing",
//   "accounts",
//   "hr",
//   "careers",
//   "jobs",
//   "team",
//   "office",
//   "enquiry",
//   "enquiries",
//   "marketing",
//   "newsletter",
//   "no-reply",
//   "noreply",
//   "postmaster",
//   "security",
//   "abuse",
//   "webmaster",
// ];

// function normalizeLocalForRole(local) {
//   return String(local || "")
//     .toLowerCase()
//     .split("+")[0]
//     .replace(/[._-]/g, "");
// }

// const ROLE_BASED_CANON = new Set(
//   [...ROLE_BASED_LOCAL_BASE, ...parseListEnv("ROLE_BASED_ALIASES")].map(
//     normalizeLocalForRole
//   )
// );

// function isRoleBasedLocal(localPart) {
//   const canon = normalizeLocalForRole(localPart);
//   return ROLE_BASED_CANON.has(canon);
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Per-user DB helpers
// // ─────────────────────────────────────────────────────────────────────────────
// function dbNameFromUsername(username) {
//   const base = String(username || "").trim().toLowerCase();
//   const cleaned = base.replace(/[^a-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
//   const name = `${cleaned || "user"}-emailTool`;
//   return name.slice(0, 63);
// }

// function getUserDb(
//   mongoose,
//   EmailLogModel,
//   RegionStatModel,
//   DomainRepModel,
//   username,
//   BulkStatModel,
//   DashStatModel
// ) {
//   const dbName = dbNameFromUsername(username);
//   const conn = mongoose.connection.useDb(dbName, { useCache: true });
//   return {
//     EmailLog: conn.model("EmailLog", EmailLogModel.schema),
//     RegionStat: conn.model("RegionStat", RegionStatModel.schema),
//     DomainReputation: conn.model("DomainReputation", DomainRepModel.schema),
//     BulkStat: BulkStatModel
//       ? conn.model("BulkStat", BulkStatModel.schema)
//       : undefined,
//     DashStat: DashStatModel
//       ? conn.model("DashStat", DashStatModel.schema)
//       : undefined,
//   };
// }

// async function bumpUpdatedAt(model, emailNorm, section = undefined) {
//   const update = { $currentDate: { updatedAt: true } };
//   if (section) update.$set = { section };
//   await model.updateMany({ email: emailNorm }, update);
// }

// async function replaceLatest(model, emailNorm, payload) {
//   await model.deleteMany({ email: emailNorm });
//   await model.create({ ...payload, email: emailNorm });
// }

// function lastTouch(doc) {
//   return new Date(
//     doc?.updatedAt || doc?.createdAt || doc?.timestamp || 0
//   ).getTime();
// }

// async function getFreshestFromDBs(
//   mongoose,
//   EmailLog,
//   RegionStat,
//   DomainRep,
//   EmailLogModel,
//   username,
//   E
// ) {
//   const { EmailLog: UserEmailLog } = getUserDb(
//     mongoose,
//     EmailLog,
//     RegionStat,
//     DomainRep,
//     username
//   );
//   const [g, u] = await Promise.all([
//     EmailLogModel.findOne({ email: E }).sort({ updatedAt: -1, createdAt: -1 }),
//     UserEmailLog.findOne({ email: E }).sort({ updatedAt: -1, createdAt: -1 }),
//   ]);
//   if (!g && !u) return { best: null, UserEmailLog };
//   if (g && !u) return { best: g, UserEmailLog };
//   if (!g && u) return { best: u, UserEmailLog };
//   return { best: lastTouch(g) >= lastTouch(u) ? g : u, UserEmailLog };
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Daily dash helpers
// // ─────────────────────────────────────────────────────────────────────────────
// function todayKey(d = new Date()) {
//   // normalize to UTC YYYY-MM-DD
//   return new Date(
//     Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
//   )
//     .toISOString()
//     .slice(0, 10);
// }

// const DashStatModel = require("../models/DashStat");

// async function incDashStat(
//   mongoose,
//   EmailLog,
//   RegionStat,
//   DomainRep,
//   username,
//   { mode, counts }
// ) {
//   const { DashStat } = getUserDb(
//     mongoose,
//     EmailLog,
//     RegionStat,
//     DomainRep,
//     username,
//     /* BulkStat */ undefined,
//     DashStatModel
//   );
//   const date = todayKey();
//   const prefix = mode === "bulk" ? "bulk" : "single";
//   const $inc = {};

//   for (const [k, v] of Object.entries(counts || {})) {
//     if (!v) continue;

//     if (["valid", "invalid", "risky", "unknown"].includes(k)) {
//       $inc[`${prefix}.${k}`] = v;
//       continue;
//     }
//     if (k === "requests") {
//       $inc[`${prefix}.requests`] = v;
//       continue;
//     }
//   }

//   if (Object.keys($inc).length === 0) return;
//   await DashStat.updateOne({ date }, { $inc }, { upsert: true });
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Training label canonicalisation
// // ─────────────────────────────────────────────────────────────────────────────
// function canonicalTrainingLabel(label) {
//   const raw = String(label || "").trim().toLowerCase();
//   if (!raw) return "unknown";

//   // Valid-ish
//   if (
//     [
//       "valid",
//       "deliverable",
//       "deliverable_mailbox",
//       "ok",
//       "good",
//       "exists",
//       "mailbox_exists",
//       "safe",
//     ].includes(raw)
//   )
//     return "valid";

//   // Invalid-ish
//   if (
//     [
//       "invalid",
//       "undeliverable",
//       "bounced",
//       "bounce",
//       "does_not_exist",
//       "no_mailbox",
//       "mailbox_does_not_exist",
//       "risky_invalid",
//     ].includes(raw)
//   )
//     return "invalid";

//   // Risky-ish
//   if (
//     [
//       "risky",
//       "lowdeliverability",
//       "low_deliverability",
//       "low_deliverability_risk",
//       "accept_all",
//       "catch_all",
//       "catchall",
//       "greylisted",
//       "greylisting",
//       "temporary_issue",
//       "disposable",
//     ].includes(raw)
//   )
//     return "risky";

//   return "unknown";
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // SMTP + domain/provider history + TrainingSample merge  (Option B)
// // ─────────────────────────────────────────────────────────────────────────────
// function mergeSMTPWithHistory(smtp = {}, history = {}, ctx = {}) {
//   if (!smtp || typeof smtp !== "object") return smtp;

//   const out = { ...smtp };

//   // Ensure domain / provider present from context if missing
//   if (!out.domain && ctx.domain) out.domain = ctx.domain;
//   if (!out.provider && ctx.provider) out.provider = ctx.provider;

//   const baseStatus = out.status || "❔ Unknown";
//   let status = baseStatus;
//   let category = out.category || categoryFromStatus(baseStatus);
//   let score = typeof out.score === "number" ? out.score : 0;

//   // Domain / provider history
//   const dRate =
//     typeof history.domainInvalidRate === "number"
//       ? history.domainInvalidRate
//       : null;
//   const dSamples = history.domainSamples || 0;

//   const pRate =
//     typeof history.providerInvalidRate === "number"
//       ? history.providerInvalidRate
//       : null;
//   const pSamples = history.providerSamples || 0;

//   const hasDomain = dRate !== null && dSamples > 0;
//   const hasProvider = pRate !== null && pSamples > 0;

//   const extremeBad =
//     (hasDomain && dSamples >= 10 && dRate >= 0.8) ||
//     (hasProvider && pSamples >= 20 && pRate >= 0.8);

//   const mildlyBad =
//     !extremeBad &&
//     ((hasDomain && dSamples >= 5 && dRate >= 0.5) ||
//       (hasProvider && pSamples >= 5 && pRate >= 0.5));

//   // TrainingSample signals
//   const rawCounts = history.trainingCounts || {};
//   let tValid = rawCounts.valid || 0;
//   let tInvalid = rawCounts.invalid || 0;
//   let tRisky = rawCounts.risky || 0;
//   let tUnknown = rawCounts.unknown || 0;

//   // In case you ever push raw external labels into labelCounts
//   if (rawCounts.deliverable) tValid += rawCounts.deliverable;
//   if (rawCounts.undeliverable) tInvalid += rawCounts.undeliverable;
//   if (rawCounts.lowDeliverability) tRisky += rawCounts.lowDeliverability;

//   const cntSum = tValid + tInvalid + tRisky + tUnknown;

//   let trainingSamples =
//     typeof history.trainingSamples === "number"
//       ? history.trainingSamples
//       : cntSum;
//   if (!trainingSamples && cntSum > 0) trainingSamples = cntSum;

//   const lastRaw =
//     history.trainingLastLabel || history.trainingLabel || null;
//   const tCat = canonicalTrainingLabel(lastRaw);

//   const strongTrainingValid =
//     trainingSamples >= 3 &&
//     tCat === "valid" &&
//     tValid >= 2 &&
//     tValid >= tInvalid * 2 &&
//     tValid >= tRisky * 2;

//   const strongTrainingInvalid =
//     trainingSamples >= 3 &&
//     tCat === "invalid" &&
//     tInvalid >= 2 &&
//     tInvalid >= tValid * 2 &&
//     tInvalid >= tRisky * 2;

//   const strongTrainingRisky =
//     trainingSamples >= 3 &&
//     tCat === "risky" &&
//     tRisky >= 2 &&
//     tRisky >= tValid &&
//     tRisky >= tInvalid;

//   function statusForCat(cat, tag) {
//     if (cat === "valid") return `✅ Valid (${tag})`;
//     if (cat === "invalid") return `❌ Invalid (${tag})`;
//     if (cat === "risky") return `⚠️ Risky (${tag})`;
//     return `❔ Unknown (${tag})`;
//   }

//   // 1) SMTP Unknown → trust training label directly
//   if (category === "unknown" && tCat !== "unknown" && trainingSamples > 0) {
//     const newCat = tCat;
//     let newScore = score;

//     if (newCat === "valid" && newScore < 80) newScore = 80;
//     if (newCat === "risky" && newScore < 50) newScore = 50;
//     if (newCat === "invalid" && newScore < 20) newScore = 20;

//     return {
//       ...out,
//       status: statusForCat(newCat, "training sample"),
//       category: newCat,
//       score: newScore,
//     };
//   }

//   // 2) SMTP Invalid + strong training Valid → soften to Risky
//   if (category === "invalid" && strongTrainingValid && !extremeBad) {
//     category = "risky";
//     status =
//       "⚠️ Risky (history mostly deliverable, SMTP returned invalid)";
//     if (score < 70) score = 70;

//     return {
//       ...out,
//       status,
//       category,
//       score,
//     };
//   }

//   // 3) SMTP Valid: apply domain history + training (never flip to Invalid)
//   if (category === "valid") {
//     if (extremeBad) {
//       category = "risky";
//       if (!/Risky/i.test(status)) {
//         status = status.replace(/Valid/i, "Risky");
//         if (!/Risky/i.test(status)) {
//           status = "⚠️ Risky (history mismatch)";
//         }
//       }
//       if (score > 55) score = 55;
//     } else if (mildlyBad) {
//       if (score > 75) score = 75;
//     } else {
//       if (score < 85) score = Math.max(score, 85);
//     }

//     if (strongTrainingInvalid) {
//       category = "risky";
//       if (!/Risky/i.test(status)) {
//         status = status.replace(/Valid/i, "Risky");
//         if (!/Risky/i.test(status)) {
//           status = "⚠️ Risky (training mismatch)";
//         }
//       }
//       if (score > 60) score = 60;
//     } else if (strongTrainingRisky) {
//       category = "risky";
//       if (!/Risky/i.test(status)) {
//         status = status.replace(/Valid/i, "Risky");
//         if (!/Risky/i.test(status)) {
//           status = "⚠️ Risky (training sample)";
//         }
//       }
//       if (score > 70) score = 70;
//     }

//     return {
//       ...out,
//       status,
//       category,
//       score,
//     };
//   }

//   // 4) Risky / Invalid without strong overrides → as is, but numeric score
//   return {
//     ...out,
//     status,
//     category,
//     score,
//   };
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Exports
// // ─────────────────────────────────────────────────────────────────────────────
// module.exports = {
//   categoryFromStatus,
//   normEmail,
//   buildReasonAndMessage,
//   extractDomain,
//   detectProviderByMX,
//   // training / history merge helper
//   mergeSMTPWithHistory,
//   // disposable / free / role helpers
//   isDisposableDomain,
//   isFreeProvider,
//   isRoleBasedLocal,
//   normalizeStatus,
//   // db + misc
//   dbNameFromUsername,
//   getUserDb,
//   bumpUpdatedAt,
//   replaceLatest,
//   lastTouch,
//   getFreshestFromDBs,
//   incDashStat,
// };




// utils/validator.js
const dns = require("dns").promises;

// ─────────────────────────────────────────────────────────────────────────────
// Basic status helpers
// ─────────────────────────────────────────────────────────────────────────────
function categoryFromStatus(status = "") {
  const s = String(status || "");
  if (/\bInvalid\b/i.test(s)) return "invalid";
  if (/\bRisky\b/i.test(s)) return "risky";
  if (/\bValid\b/i.test(s)) return "valid";
  return "unknown";
}

function normalizeStatus(status, categoryHint) {
  const cat = categoryHint || categoryFromStatus(status);
  if (cat === "valid") return { status: "Valid", category: "valid" };
  if (cat === "invalid") return { status: "Invalid", category: "invalid" };
  if (cat === "risky") return { status: "Risky", category: "risky" };
  return { status: "Unknown", category: "unknown" };
}

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getStatusMessage(status) {
  const s = String(status || "");
  if (/\bInvalid\b/i.test(s))
    return "You should not send emails to this address because, ";
  if (/\bRisky\b/i.test(s))
    return "This address looks risky to send to because, ";
  if (/\bValid\b/i.test(s))
    return "You can safely send emails to this address because, ";
  return "Status is unknown for this address";
}

function mapReason(subStatus, status, flags = {}) {
  const cat = categoryFromStatus(status);
  const key = String(subStatus || "").toLowerCase();

  if (cat === "valid") {
    if (key === "owner_verified")
      return {
        reasonCode: "OWNER_VERIFIED",
        reasonLabel: "Owner Verified",
        reasonText: "Owner service verified the mailbox exists.",
      };
    return {
      reasonCode: "ACCEPTED_EMAIL",
      reasonLabel: "Accepted Email",
      reasonText: "Email address was accepted.",
    };
  }

  if (cat === "risky") {
    if (flags.isDisposable || flags.isRoleBased)
      return {
        reasonCode: "LOW_QUALITY",
        reasonLabel: "Low Quality",
        reasonText:
          "Email address has quality issues that may make it a risky or low-value address.",
      };
    if (
      [
        "catch_all",
        "greylisted",
        "gateway_protected",
        "policy_block_spf",
        "catch_all_owner_says_missing",
      ].includes(key)
    )
      return {
        reasonCode: "LOW_DELIVERABILITY",
        reasonLabel: "Low Deliverability",
        reasonText:
          "Email address appears to be deliverable, but deliverability cannot be guaranteed.",
      };
    return {
      reasonCode: "LOW_DELIVERABILITY",
      reasonLabel: "Low Deliverability",
      reasonText:
        "Email address appears to be deliverable, but deliverability cannot be guaranteed.",
    };
  }

  if (cat === "invalid") {
    if (key === "syntax")
      return {
        reasonCode: "INVALID_EMAIL",
        reasonLabel: "Invalid Email",
        reasonText:
          "Specified email doesn't have a valid email address syntax.",
      };
    if (key === "no_mx_or_a")
      return {
        reasonCode: "INVALID_DOMAIN",
        reasonLabel: "Invalid Domain",
        reasonText:
          "Domain for email does not exist or has no valid DNS records.",
      };
    if (key === "owner_verified_missing")
      return {
        reasonCode: "OWNER_VERIFIED_MISSING",
        reasonLabel: "Owner Says Missing",
        reasonText: "Owner service reports the mailbox is missing.",
      };
    return {
      reasonCode: "REJECTED_EMAIL",
      reasonLabel: "Rejected Email",
      reasonText:
        "Email address was rejected by the SMTP server; it does not exist.",
    };
  }

  if (key === "no_connect" || key === "network")
    return {
      reasonCode: "UNAVAILABLE_SMTP",
      reasonLabel: "Unavailable SMTP",
      reasonText:
        "SMTP server was unavailable to process our request or we were unable to connect to it.",
    };

  if (key === "smtp_ambiguous")
    return {
      reasonCode: "TIMEOUT",
      reasonLabel: "Timeout",
      reasonText: "Verification required more time than was available.",
    };

  return {
    reasonCode: "UNKNOWN",
    reasonLabel: "Unknown",
    reasonText: "An unexpected error has occurred.",
  };
}

function buildReasonAndMessage(status, subStatus, flags = {}) {
  const base = getStatusMessage(status);
  const r = mapReason(subStatus, status, flags);
  return { ...r, message: `${base} ${r.reasonText}` };
}

function extractDomain(email) {
  return !email || !email.includes("@")
    ? "N/A"
    : email.split("@")[1].toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection by MX
// ─────────────────────────────────────────────────────────────────────────────
async function detectProviderByMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    const mxHosts = records.map((r) => r.exchange.toLowerCase()).join(", ");
    if (mxHosts.includes("google.com")) return "Gmail / Google Workspace";
    if (
      mxHosts.includes("outlook.com") ||
      mxHosts.includes("protection.outlook.com")
    )
      return "Outlook / Microsoft 365";
    if (mxHosts.includes("zoho.com")) return "Zoho Mail";
    if (mxHosts.includes("yahoodns.net")) return "Yahoo Mail";
    if (mxHosts.includes("protonmail")) return "ProtonMail";
    return `Custom / Unknown Provider [${mxHosts.split(",")[0] || "n/a"}]`;
  } catch {
    return "Unavailable";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────────────
function parseListEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Disposable domains
// ─────────────────────────────────────────────────────────────────────────────
const DISPOSABLE_DOMAINS_BASE = [
  "mailinator.com",
  "yopmail.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.email",
  "getnada.com",
  "trashmail.com",
  "sharklasers.com",
  "dispostable.com",
  "spamgourmet.com",
  "mytemp.email",
  "mintemail.com",
  "throwawaymail.com",
  "maildrop.cc",
  "moakt.com",
];

const DISPOSABLE_DOMAINS = new Set([
  ...DISPOSABLE_DOMAINS_BASE,
  ...parseListEnv("DISPOSABLE_DOMAINS_EXTRA"),
]);

function isDisposableDomain(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  return DISPOSABLE_DOMAINS.has(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Free / consumer providers
// ─────────────────────────────────────────────────────────────────────────────
const FREE_EMAIL_PROVIDERS_BASE = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "gmx.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
];

const FREE_EMAIL_PROVIDERS = new Set([
  ...FREE_EMAIL_PROVIDERS_BASE,
  ...parseListEnv("FREE_PROVIDERS_EXTRA"),
]);

function isFreeProvider(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  return FREE_EMAIL_PROVIDERS.has(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Role-based local parts
// ─────────────────────────────────────────────────────────────────────────────
const ROLE_BASED_LOCAL_BASE = [
  "admin",
  "support",
  "info",
  "contact",
  "help",
  "sales",
  "billing",
  "accounts",
  "hr",
  "careers",
  "jobs",
  "team",
  "office",
  "enquiry",
  "enquiries",
  "marketing",
  "newsletter",
  "no-reply",
  "noreply",
  "postmaster",
  "security",
  "abuse",
  "webmaster",
];

function normalizeLocalForRole(local) {
  return String(local || "")
    .toLowerCase()
    .split("+")[0]
    .replace(/[._-]/g, "");
}

const ROLE_BASED_CANON = new Set(
  [...ROLE_BASED_LOCAL_BASE, ...parseListEnv("ROLE_BASED_ALIASES")].map(
    normalizeLocalForRole
  )
);

function isRoleBasedLocal(localPart) {
  const canon = normalizeLocalForRole(localPart);
  return ROLE_BASED_CANON.has(canon);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user DB helpers
// ─────────────────────────────────────────────────────────────────────────────
function dbNameFromUsername(username) {
  const base = String(username || "").trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${cleaned || "user"}-emailTool`;
  return name.slice(0, 63);
}

function getUserDb(
  mongoose,
  EmailLogModel,
  RegionStatModel,
  DomainRepModel,
  username,
  BulkStatModel,
  DashStatModel
) {
  const dbName = dbNameFromUsername(username);
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  return {
    EmailLog: conn.model("EmailLog", EmailLogModel.schema),
    RegionStat: conn.model("RegionStat", RegionStatModel.schema),
    DomainReputation: conn.model("DomainReputation", DomainRepModel.schema),
    BulkStat: BulkStatModel
      ? conn.model("BulkStat", BulkStatModel.schema)
      : undefined,
    DashStat: DashStatModel
      ? conn.model("DashStat", DashStatModel.schema)
      : undefined,
  };
}

async function bumpUpdatedAt(model, emailNorm, section = undefined) {
  const update = { $currentDate: { updatedAt: true } };
  if (section) update.$set = { section };
  await model.updateMany({ email: emailNorm }, update);
}

async function replaceLatest(model, emailNorm, payload) {
  await model.deleteMany({ email: emailNorm });
  await model.create({ ...payload, email: emailNorm });
}

function lastTouch(doc) {
  return new Date(
    doc?.updatedAt || doc?.createdAt || doc?.timestamp || 0
  ).getTime();
}

async function getFreshestFromDBs(
  mongoose,
  EmailLog,
  RegionStat,
  DomainRep,
  EmailLogModel,
  username,
  E
) {
  const { EmailLog: UserEmailLog } = getUserDb(
    mongoose,
    EmailLog,
    RegionStat,
    DomainRep,
    username
  );
  const [g, u] = await Promise.all([
    EmailLogModel.findOne({ email: E }).sort({ updatedAt: -1, createdAt: -1 }),
    UserEmailLog.findOne({ email: E }).sort({ updatedAt: -1, createdAt: -1 }),
  ]);
  if (!g && !u) return { best: null, UserEmailLog };
  if (g && !u) return { best: g, UserEmailLog };
  if (!g && u) return { best: u, UserEmailLog };
  return { best: lastTouch(g) >= lastTouch(u) ? g : u, UserEmailLog };
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily dash helpers
// ─────────────────────────────────────────────────────────────────────────────
function todayKey(d = new Date()) {
  // normalize to UTC YYYY-MM-DD
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  )
    .toISOString()
    .slice(0, 10);
}

const DashStatModel = require("../models/DashStat");

async function incDashStat(
  mongoose,
  EmailLog,
  RegionStat,
  DomainRep,
  username,
  { mode, counts }
) {
  const { DashStat } = getUserDb(
    mongoose,
    EmailLog,
    RegionStat,
    DomainRep,
    username,
    /* BulkStat */ undefined,
    DashStatModel
  );
  const date = todayKey();
  const prefix = mode === "bulk" ? "bulk" : "single";
  const $inc = {};

  for (const [k, v] of Object.entries(counts || {})) {
    if (!v) continue;

    if (["valid", "invalid", "risky", "unknown"].includes(k)) {
      $inc[`${prefix}.${k}`] = v;
      continue;
    }
    if (k === "requests") {
      $inc[`${prefix}.requests`] = v;
      continue;
    }
  }

  if (Object.keys($inc).length === 0) return;
  await DashStat.updateOne({ date }, { $inc }, { upsert: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Training label canonicalisation
// ─────────────────────────────────────────────────────────────────────────────
function canonicalTrainingLabel(label) {
  const raw = String(label || "").trim().toLowerCase();
  if (!raw) return "unknown";

  // Valid-ish
  if (
    [
      "valid",
      "deliverable",
      "deliverable_mailbox",
      "ok",
      "good",
      "exists",
      "mailbox_exists",
      "safe",
    ].includes(raw)
  )
    return "valid";

  // Invalid-ish
  if (
    [
      "invalid",
      "undeliverable",
      "bounced",
      "bounce",
      "does_not_exist",
      "no_mailbox",
      "mailbox_does_not_exist",
      "risky_invalid",
    ].includes(raw)
  )
    return "invalid";

  // Risky-ish
  if (
    [
      "risky",
      "lowdeliverability",
      "low_deliverability",
      "low_deliverability_risk",
      "accept_all",
      "catch_all",
      "catchall",
      "greylisted",
      "greylisting",
      "temporary_issue",
      "disposable",
    ].includes(raw)
  )
    return "risky";

  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// SMTP + domain/provider history + TrainingSample merge  (Option B)
// ─────────────────────────────────────────────────────────────────────────────
function mergeSMTPWithHistory(smtp = {}, history = {}, ctx = {}) {
  if (!smtp || typeof smtp !== "object") return smtp;

  const out = { ...smtp };

  // Ensure domain / provider present from context if missing
  if (!out.domain && ctx.domain) out.domain = ctx.domain;
  if (!out.provider && ctx.provider) out.provider = ctx.provider;

  const baseStatus = out.status || "❔ Unknown";
  let status = baseStatus;
  let category = out.category || categoryFromStatus(baseStatus);
  let score = typeof out.score === "number" ? out.score : 0;

  // Domain / provider history
  const dRate =
    typeof history.domainInvalidRate === "number"
      ? history.domainInvalidRate
      : null;
  const dSamples = history.domainSamples || 0;

  const pRate =
    typeof history.providerInvalidRate === "number"
      ? history.providerInvalidRate
      : null;
  const pSamples = history.providerSamples || 0;

  const hasDomain = dRate !== null && dSamples > 0;
  const hasProvider = pRate !== null && pSamples > 0;

  const extremeBad =
    (hasDomain && dSamples >= 10 && dRate >= 0.8) ||
    (hasProvider && pSamples >= 20 && pRate >= 0.8);

  const mildlyBad =
    !extremeBad &&
    ((hasDomain && dSamples >= 5 && dRate >= 0.5) ||
      (hasProvider && pSamples >= 5 && pRate >= 0.5));

  // TrainingSample signals
  const rawCounts = history.trainingCounts || {};
  let tValid = rawCounts.valid || 0;
  let tInvalid = rawCounts.invalid || 0;
  let tRisky = rawCounts.risky || 0;
  let tUnknown = rawCounts.unknown || 0;

  // In case you ever push raw external labels into labelCounts
  if (rawCounts.deliverable) tValid += rawCounts.deliverable;
  if (rawCounts.undeliverable) tInvalid += rawCounts.undeliverable;
  if (rawCounts.lowDeliverability) tRisky += rawCounts.lowDeliverability;

  const cntSum = tValid + tInvalid + tRisky + tUnknown;

  let trainingSamples =
    typeof history.trainingSamples === "number"
      ? history.trainingSamples
      : cntSum;
  if (!trainingSamples && cntSum > 0) trainingSamples = cntSum;

  const lastRaw =
    history.trainingLastLabel || history.trainingLabel || null;
  const tCat = canonicalTrainingLabel(lastRaw);

  const strongTrainingValid =
    trainingSamples >= 3 &&
    tCat === "valid" &&
    tValid >= 2 &&
    tValid >= tInvalid * 2 &&
    tValid >= tRisky * 2;

  const strongTrainingInvalid =
    trainingSamples >= 3 &&
    tCat === "invalid" &&
    tInvalid >= 2 &&
    tInvalid >= tValid * 2 &&
    tInvalid >= tRisky * 2;

  const strongTrainingRisky =
    trainingSamples >= 3 &&
    tCat === "risky" &&
    tRisky >= 2 &&
    tRisky >= tValid &&
    tRisky >= tInvalid;

  function statusForCat(cat, tag) {
    if (cat === "valid") return `✅ Valid (${tag})`;
    if (cat === "invalid") return `❌ Invalid (${tag})`;
    if (cat === "risky") return `⚠️ Risky (${tag})`;
    return `❔ Unknown (${tag})`;
  }

  // 1) SMTP Unknown → trust training label directly
  if (category === "unknown" && tCat !== "unknown" && trainingSamples > 0) {
    const newCat = tCat;
    let newScore = score;

    if (newCat === "valid" && newScore < 80) newScore = 80;
    if (newCat === "risky" && newScore < 50) newScore = 50;
    if (newCat === "invalid" && newScore < 20) newScore = 20;

    return {
      ...out,
      status: statusForCat(newCat, "training sample"),
      category: newCat,
      score: newScore,
    };
  }

  // 2) SMTP Invalid + strong training Valid → soften to Risky
  if (category === "invalid" && strongTrainingValid && !extremeBad) {
    category = "risky";
    status =
      "⚠️ Risky (history mostly deliverable, SMTP returned invalid)";
    if (score < 70) score = 70;

    return {
      ...out,
      status,
      category,
      score,
    };
  }

  // 3) SMTP Valid: apply domain history + training (never flip to Invalid)
  if (category === "valid") {
    if (extremeBad) {
      category = "risky";
      if (!/Risky/i.test(status)) {
        status = status.replace(/Valid/i, "Risky");
        if (!/Risky/i.test(status)) {
          status = "⚠️ Risky (history mismatch)";
        }
      }
      if (score > 55) score = 55;
    } else if (mildlyBad) {
      if (score > 75) score = 75;
    } else {
      if (score < 85) score = Math.max(score, 85);
    }

    if (strongTrainingInvalid) {
      category = "risky";
      if (!/Risky/i.test(status)) {
        status = status.replace(/Valid/i, "Risky");
        if (!/Risky/i.test(status)) {
          status = "⚠️ Risky (training mismatch)";
        }
      }
      if (score > 60) score = 60;
    } else if (strongTrainingRisky) {
      category = "risky";
      if (!/Risky/i.test(status)) {
        status = status.replace(/Valid/i, "Risky");
        if (!/Risky/i.test(status)) {
          status = "⚠️ Risky (training sample)";
        }
      }
      if (score > 70) score = 70;
    }

    return {
      ...out,
      status,
      category,
      score,
    };
  }

  // 4) Risky / Invalid without strong overrides → as is, but numeric score
  return {
    ...out,
    status,
    category,
    score,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  categoryFromStatus,
  normEmail,
  buildReasonAndMessage,
  extractDomain,
  detectProviderByMX,
  // training / history merge helper
  mergeSMTPWithHistory,
  // disposable / free / role helpers
  isDisposableDomain,
  isFreeProvider,
  isRoleBasedLocal,
  normalizeStatus,
  // db + misc
  dbNameFromUsername,
  getUserDb,
  bumpUpdatedAt,
  replaceLatest,
  lastTouch,
  getFreshestFromDBs,
  incDashStat,
};
