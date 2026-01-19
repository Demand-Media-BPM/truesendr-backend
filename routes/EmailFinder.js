// // routes/EmailFinder.js
// const express = require("express");
// const mongoose = require("mongoose");
// const multer = require("multer");
// const XLSX = require("xlsx");
// const stream = require("stream");
// const { GridFSBucket, ObjectId } = require("mongodb");

// const User = require("../models/User");
// const FinderGlobal = require("../models/Finder");
// const { validateSMTPStable } = require("../utils/smtpValidator");

// // global domain pattern model
// const DomainPattern = require("../models/DomainPattern");
// const Domain = require("../models/Domain");

// // memory upload (no tmp files)
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 25 * 1024 * 1024 },
// });

// /* ──────────────────────────────────────────────────────────────────────────────
//    TENANT HELPERS
// ────────────────────────────────────────────────────────────────────────────── */

// function normalizeTenant(username) {
//   return String(username || "")
//     .trim()
//     .toLowerCase()
//     .replace(/\s+/g, "-");
// }

// function getUserDbByTenant(tenant) {
//   const dbName = `${tenant}-emailTool`;
//   return mongoose.connection.useDb(dbName, { useCache: true });
// }

// function getFinderModelByTenant(tenant) {
//   const conn = getUserDbByTenant(tenant);
//   if (conn.models.Finder) return conn.models.Finder;
//   return conn.model("Finder", FinderGlobal.schema, "finders");
// }

// function getBulkModelByTenant(tenant) {
//   const conn = getUserDbByTenant(tenant);
//   if (conn.models.FinderBulkStat) return conn.models.FinderBulkStat;

//   const BulkSchema = new mongoose.Schema(
//     {
//       userId: { type: mongoose.Schema.Types.ObjectId, index: true },
//       filename: String,
//       rowsTotal: { type: Number, default: 0 },
//       processed: { type: Number, default: 0 },
//       rowsFound: { type: Number, default: 0 },
//       state: {
//         type: String,
//         default: "uploaded",
//         index: true,
//       }, // uploaded|running|done|error|canceled
//       resultFileId: mongoose.Schema.Types.ObjectId, // GridFS id for result in 'bulkfindfiles'
//       error: String,
//     },
//     { timestamps: true, collection: "finder_bulk_stats" }
//   );

//   return conn.model("FinderBulkStat", BulkSchema);
// }

// // Dedicated GridFS bucket ONLY for bulk finder results
// function getBulkBucketByTenant(tenant) {
//   const dbConn = getUserDbByTenant(tenant);
//   return new GridFSBucket(dbConn.db, { bucketName: "bulkfindfiles" });
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    AUTH
// ────────────────────────────────────────────────────────────────────────────── */
// async function requireAuth(req, res, next) {
//   try {
//     const headerUserRaw =
//       req.headers["x-user"] || req.query?.username || req.body?.username || "";
//     const headerUser = String(headerUserRaw).trim();

//     let userDoc = null;
//     if (headerUser) {
//       userDoc = await User.findOne({
//         username: new RegExp(`^${headerUser}$`, "i"),
//       }).lean();
//       if (!userDoc)
//         return res.status(401).json({ error: "Unauthorized (unknown X-User)" });
//     } else if (req.user?.id) {
//       userDoc = await User.findById(req.user.id).lean();
//       if (!userDoc)
//         return res
//           .status(401)
//           .json({ error: "Unauthorized (invalid token user)" });
//     } else {
//       return res.status(401).json({ error: "Unauthorized" });
//     }

//     const tenant = normalizeTenant(userDoc.username);
//     req.user = { id: userDoc._id, username: userDoc.username };
//     req.tenant = tenant;

//     next();
//   } catch (e) {
//     console.error("auth error", e);
//     return res.status(500).json({ error: "Auth error" });
//   }
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    FINDER UTILITIES
// ────────────────────────────────────────────────────────────────────────────── */
// function normalizeASCII(s = "") {
//   return s
//     .normalize("NFKD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/[^\w\s'-]/g, " ")
//     .toLowerCase()
//     .trim()
//     .replace(/\s+/g, " ");
// }
// function splitName(name = "") {
//   const parts = normalizeASCII(name).split(" ").filter(Boolean);
//   const first = parts[0] || "";
//   const last = parts.length > 1 ? parts[parts.length - 1] : "";
//   const F = first ? first[0] : "";
//   const L = last ? last[0] : "";
//   return { first, last, F, L };
// }

// function pick(obj, candidates) {
//   for (const k of candidates) {
//     if (obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]);
//   }
//   const lower = Object.fromEntries(
//     Object.keys(obj).map((k) => [k.toLowerCase(), k])
//   );
//   for (const k of candidates) {
//     const lk = String(k).toLowerCase();
//     if (lower[lk]) {
//       const v = obj[lower[lk]];
//       if (v != null && String(v).trim() !== "") return String(v);
//     }
//   }
//   return "";
// }

// function deriveConfidence(vr = {}) {
//   const cat = String(vr.category || "").toLowerCase();
//   const reason = String(vr.reason || "");
//   const catchAll =
//     vr.isCatchAll === true ||
//     /catch[- ]?all/i.test(reason) ||
//     String(vr.category_detail || "").toLowerCase() === "accept_all";

//   const smtpYes =
//     vr.smtpAccepted === true ||
//     /^2\d\d$/.test(String(vr.smtpCode || "")) ||
//     /\b2\d\d\b/i.test(reason) ||
//     /accepted|ok|success/i.test(reason);

//   const mxYes =
//     vr.hasMx === true ||
//     vr.mxFound === true ||
//     (Array.isArray(vr.mx) && vr.mx.length > 0) ||
//     /mx|dns/i.test(reason);

//   if (cat === "valid" && !catchAll && (smtpYes || mxYes)) return "High";
//   if (
//     cat === "valid" ||
//     catchAll ||
//     ["risky", "accept_all", "accept-all"].includes(cat)
//   )
//     return "Med";
//   return "Low";
// }

// function isDeliverable(vr = {}) {
//   const cat = String(vr.category || "").toLowerCase();
//   const reason = String(vr.reason || "");
//   const smtpYes =
//     vr.smtpAccepted === true ||
//     /^2\d\d$/.test(String(vr.smtpCode || "")) ||
//     /\b2\d\d\b/.test(reason) ||
//     /accepted|ok|success/i.test(reason);
//   return (
//     cat === "valid" ||
//     ((cat === "accept_all" || cat === "accept-all" || cat === "risky") &&
//       smtpYes)
//   );
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    DOMAIN IMPORT HELPERS
// ────────────────────────────────────────────────────────────────────────────── */

// function normalizeDomain(raw) {
//   if (!raw) return "";

//   let d = String(raw).trim().toLowerCase();

//   // remove protocol like http://, https://
//   d = d.replace(/^[a-z]+:\/\//, "");

//   // remove path / query / fragment / port
//   d = d.split("/")[0].split("?")[0].split("#")[0];

//   // drop leading www.
//   d = d.replace(/^www\./, "");

//   d = d.trim();

//   // must contain a dot and no spaces
//   if (!d.includes(".") || d.includes(" ")) return "";

//   return d;
// }

// function extractDomainFromEmail(rawEmail) {
//   if (!rawEmail) return "";
//   const s = String(rawEmail).trim().toLowerCase();
//   const parts = s.split("@");
//   if (parts.length !== 2) return "";
//   return normalizeDomain(parts[1]);
// }

// function splitBaseAndTld(domain) {
//   if (!domain) return { base: "", tld: "" };
//   const parts = domain.split(".").filter(Boolean);
//   if (parts.length < 2) {
//     return { base: parts[0] || "", tld: "" };
//   }
//   const tld = parts[parts.length - 1]; // last label
//   const base = parts[0]; // first label
//   return { base, tld };
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    DOMAIN IMPORT HELPERS end here
// ────────────────────────────────────────────────────────────────────────────── */
// async function upsertDomainSample(domain, email) {
//   if (!domain) return;
//   const d = String(domain).toLowerCase();
//   const { base, tld } = splitBaseAndTld(d);
//   const sampleEmail = email ? String(email).trim() : null;

//   const update = {
//     // these only apply on insert
//     $setOnInsert: {
//       domain: d,
//       base,
//       tld,
//     },
//   };

//   if (sampleEmail) {
//     // this applies on both insert + update
//     update.$set = { sampleEmail };
//     update.$inc = { emailsCount: 1 };
//   }

//   await Domain.updateOne({ domain: d }, update, { upsert: true });
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    Normalize company name to tokens
// ────────────────────────────────────────────────────────────────────────────── */

// /**
//  * Normalize company name to tokens.
//  * Examples:
//  *  "Demand Media BPM Inc." -> ["demand","media","bpm"]
//  */
// function normalizeCompanyNameToTokens(raw = "") {
//   let s = String(raw || "").toLowerCase();

//   // remove protocol / www if user pasted URLs or similar
//   s = s.replace(/https?:\/\//g, "");
//   s = s.replace(/^www\./, "");

//   // remove common company suffixes
//   s = s
//     .replace(
//       /\b(inc|inc\.|llc|ltd|ltd\.|limited|pvt|pvt\.|pvt ltd|pvt. ltd.|private|gmbh|corp|corp\.|corporation|co|co\.|company|plc|plc\.|group|sa|s\.a\.|sarl|spa|bv)\b/g,
//       " "
//     )
//     .replace(/[^a-z0-9\s]/g, " ") // strip non-alphanum
//     .replace(/\s+/g, " ")
//     .trim();

//   if (!s) return [];
//   return s.split(" ").filter(Boolean);
// }

// /**
//  * From tokens build candidate "base" keys for domain lookup.
//  * Example tokens: ["demand","media","bpm"]
//  *  -> ["demandmediabpm","demandmedia","demand"]
//  */
// function buildCompanyKeys(tokens) {
//   const keys = [];
//   if (!tokens || !tokens.length) return keys;

//   if (tokens.length >= 3) {
//     keys.push(tokens.join("")); // demandmediabpm
//     keys.push(tokens.slice(0, 2).join("")); // demandmedia
//     keys.push(tokens[0]); // demand
//   } else if (tokens.length === 2) {
//     keys.push(tokens.join("")); // demandmedia
//     keys.push(tokens[0]); // demand
//   } else {
//     keys.push(tokens[0]); // demand
//   }

//   // de-duplicate
//   return Array.from(new Set(keys));
// }

// /**
//  * Main resolver for user input in "domain/company" field.
//  *
//  * 1) First, try to treat input as a real domain (with dot, etc) using normalizeDomain().
//  *    - If that succeeds, we just use that, no need to be in Domains collection.
//  * 2) If not a valid domain, we treat input as company name and look it up in Domains:
//  *    - Use tokens and candidate base keys.
//  *    - Prefer base+TLD=com, else any TLD.
//  *
//  * Returns: { domain, source }
//  *   - domain: lowercased concrete domain string, e.g. "demandmedia.com"
//  *   - source: "domain" | "company" | "none"
//  */

// /**
//  * Build candidate domains for any user input:
//  *  - If it's already a domain -> [that]
//  *  - If it's a company:
//  *      1) Try "no-space" + .com, .in
//  *      2) Query Domain collection for base + plural/singular variants
//  *         and return ALL domains, preferring .com, then .in, then others.
//  */
// async function getCandidateDomainsForInput(rawInput) {
//   const out = [];
//   const seen = new Set();
//   const input = String(rawInput || "").trim();

//   if (!input) return out;

//   // 1) If it already looks like a domain, just use that.
//   const asDomain = normalizeDomain(input);
//   if (asDomain) {
//     const d = asDomain.toLowerCase();
//     out.push(d);
//     return out;
//   }

//   // 2) Treat as company: first try "no-space" + common TLDs
//   const rawLower = input.toLowerCase();
//   const compact = rawLower.replace(/\s+/g, ""); // demandmediabpm

//   const popularTlds = ["com", "in"];
//   if (compact) {
//     for (const tld of popularTlds) {
//       const guess = normalizeDomain(`${compact}.${tld}`);
//       if (guess && !seen.has(guess)) {
//         seen.add(guess);
//         out.push(guess);
//       }
//     }
//   }

//   // 3) Use our token-based keys + Domain collection
//   const tokens = normalizeCompanyNameToTokens(input);
//   if (!tokens.length) return out;

//   const keys = buildCompanyKeys(tokens); // e.g. ["demandmediabpm","demandmedia","demand"]

//   for (const key of keys) {
//     if (!key) continue;

//     // handle singular/plural, e.g. "solution" <-> "solutions"
//     const baseCandidates = new Set([key]);
//     if (!key.endsWith("s")) baseCandidates.add(key + "s");
//     if (key.endsWith("s")) baseCandidates.add(key.slice(0, -1));

//     let docs = [];

//     for (const base of baseCandidates) {
//       const found = await Domain.find({ base }).lean();
//       if (found && found.length) {
//         docs.push(...found);
//       }
//     }

//     // if still nothing, fallback to exact "key.com" doc
//     if (!docs.length) {
//       const guess = normalizeDomain(`${key}.com`);
//       if (guess) {
//         const doc = await Domain.findOne({ domain: guess }).lean();
//         if (doc) docs.push(doc);
//       }
//     }

//     if (!docs.length) continue;

//     // Prefer .com, then .in, then others; tie-break by emailsCount desc
//     docs.sort((a, b) => {
//       const orderTld = (t) => (t === "com" ? 0 : t === "in" ? 1 : 2);
//       const ta = orderTld(a.tld || "");
//       const tb = orderTld(b.tld || "");
//       if (ta !== tb) return ta - tb;

//       const ea = a.emailsCount || 0;
//       const eb = b.emailsCount || 0;
//       return eb - ea;
//     });

//     for (const doc of docs) {
//       const d = String(doc.domain || "").toLowerCase();
//       if (!d || seen.has(d)) continue;
//       seen.add(d);
//       out.push(d);
//     }
//   }

//   return out;
// }

// /**
//  * Legend for tokens:
//  *  f = full first name      → "saurabh"
//  *  l = full last name       → "shinde"
//  *  F = first initial        → "s"
//  *  L = last initial         → "s"
//  *
//  * We'll define codes of how to join them.
//  * Examples:
//  *   "f.l"   -> "saurabh.shinde"
//  *   "l.f"   -> "shinde.saurabh"
//  *   "f.L"   -> "saurabh.s"
//  *   "F.l"   -> "s.shinde"
//  *   "fl"    -> "saurabhshinde"
//  *   "lf"    -> "shindesaurabh"
//  *   "f"     -> "saurabh"
//  *   "l"     -> "shinde"
//  *
//  * We'll also include "_", "-" variants and some common 3-piece ones.
//  *
//  * ORDER MATTERS. Earlier = higher priority to test.
//  */
// const FIXED_CODES_50 = [
//   // super common dot / no sep / initial combos
//   "f.l", // saurabh.shinde
//   "l.f", // shinde.saurabh
//   "f.L", // saurabh.s
//   "F.l", // s.shinde
//   "fl", // saurabhshinde
//   "lf", // shindesaurabh
//   "f", // saurabh
//   "l", // shinde

//   // underscore versions (still common in older orgs / Outlook exports)
//   "f_l", // saurabh_shinde
//   "l_f", // shinde_saurabh
//   "f_L", // saurabh_s
//   "F_l", // s_shinde
//   "fL", // saurabhs
//   "Fl", // sshinde

//   // hyphen / dash
//   "f-l", // saurabh-shinde
//   "l-f", // shinde-saurabh
//   "f-L", // saurabh-s
//   "F-l", // s-shinde
//   "f-Ll", // saurabh-ss (first + "-" + last initial + last initial)
//   "fLl", // saurabhss

//   // dot with initials flipped
//   "f.lL", // saurabh.s
//   "fL.l", // saurabhs.shinde
//   "F.lL", // s.shindes
//   "F.L", // s.s
//   "FL", // ss

//   // last first-initial patterns
//   "l.fL", // shinde.s
//   "l.F", // shinde.s
//   "lF", // shindes

//   // three-part (people love first.middle.last style, we fake middle as initials)
//   "F.f.l", // s.saurabh.shinde  (rare but possible in aliases)
//   "f.F.l", // saurabh.s.shinde
//   "f.l.F", // saurabh.shinde.s
//   "f.lL", // saurabh.shindes    (dup-ish but keep explicit)
//   "fL.l", // saurabhs.shinde    (dup-ish but we want both orderings)

//   // first + lastinitial only, and last + firstinitial only
//   "fL", // saurabhs
//   "lF", // shindes

//   // dot between first and lastinitial, etc.
//   "f.L", // saurabh.s
//   "F.l", // s.shinde (already earlier but keep to ensure code is present if DB learns it)
//   "F.lL", // s.shindes
//   "F.Ll", // s.ss

//   // underscore equivalents for HR/CRM style exports
//   "f_lL", // saurabh.shindes style but with _
//   "fL_l", // saurabhs_shinde
//   "F_lL", // s_shindes
//   "F_L", // s_s
//   "FL_", // ss_  (some orgs appends underscore or prefix)
//   "F_Ll", // s_ss
//   "f_Ll", // saurabh_ss
//   "l_F", // shinde_s
//   "l_Ff", // shinde_ssaurabh (dirty but shows up in some exports)

//   // hyphenated company conventions
//   "f-lL", // saurabh-shindes
//   "fL-l", // saurabhs-shinde
//   "F-lL", // s-shindes
//   "l-fL", // shinde-saurabhs
// ];

// /**
//  * sanitize local part
//  */
// function sanitizeLocal(local) {
//   return String(local || "")
//     .replace(/[^\w.-]/g, "")
//     .replace(/\.+/g, ".")
//     .replace(/[_-]{2,}/g, "_")
//     .replace(/^[._-]+|[._-]+$/g, "");
// }

// /**
//  * renderLocalFromCode("f.l", {first:"saurabh",last:"shinde",F:"s",L:"s"})
//  *  -> "saurabh.shinde"
//  */
// function renderLocalFromCode(code, { first, last, F, L }) {
//   const pieces = [];
//   for (let i = 0; i < code.length; i++) {
//     const c = code[i];
//     if (c === "." || c === "_" || c === "-") {
//       pieces.push(c);
//       continue;
//     }
//     if (c === "f") pieces.push(first);
//     else if (c === "l") pieces.push(last);
//     else if (c === "F") pieces.push(F);
//     else if (c === "L") pieces.push(L);
//     else pieces.push(c);
//   }
//   return sanitizeLocal(pieces.join(""));
// }

// /**
//  * Build candidate pairs just from FIXED_CODES_50, in our priority order.
//  * Returns [{ code, email }, ...] in same order.
//  */
// function buildFixedPairs(nameParts, domain) {
//   const d = String(domain || "")
//     .toLowerCase()
//     .trim();
//   if (!d || !nameParts.first) return [];
//   const out = [];
//   const seen = new Set();

//   for (const code of FIXED_CODES_50) {
//     const local = renderLocalFromCode(code, nameParts);
//     if (!local) continue;
//     if (seen.has(local)) continue;
//     seen.add(local);
//     out.push({ code, email: `${local}@${d}` });
//   }

//   return out;
// }

// /**
//  * Preferred codes loader (sorted by success desc in DB).
//  * We'll still only keep ones that exist in FIXED_CODES_50.
//  */
// async function getPreferredCodesForDomain(domain) {
//   const d = String(domain || "").toLowerCase();
//   const doc = await DomainPattern.findOne({ domain: d }).lean();
//   if (!doc || !Array.isArray(doc.patterns) || doc.patterns.length === 0)
//     return [];
//   const sorted = [...doc.patterns].sort(
//     (a, b) => (b.success || 0) - (a.success || 0)
//   );
//   return sorted.map((p) => p.code).filter(Boolean);
// }

// /**
//  * We increment attempts per domain. This helps tracking domain difficulty.
//  */
// async function bumpAttempts(domain) {
//   const d = String(domain || "").toLowerCase();

//   // step 1: make sure doc exists
//   await DomainPattern.updateOne(
//     { domain: d },
//     { $setOnInsert: { domain: d, attempts: 0 } },
//     { upsert: true }
//   );

//   // step 2: now safely increment attempts
//   await DomainPattern.updateOne({ domain: d }, { $inc: { attempts: 1 } });
// }

// /**
//  * When we confirm a working code for domain, we upsert it / bump success.
//  */
// async function recordPatternSuccess(domain, code) {
//   if (!code) return;
//   const d = String(domain || "").toLowerCase();

//   await DomainPattern.updateOne(
//     { domain: d },
//     { $setOnInsert: { domain: d, attempts: 0 } },
//     { upsert: true }
//   );

//   const bump = await DomainPattern.updateOne(
//     { domain: d, "patterns.code": code },
//     {
//       $inc: { "patterns.$.success": 1 },
//       $set: { "patterns.$.lastSuccessAt": new Date() },
//     }
//   );

//   if (!bump.matchedCount && !bump.modifiedCount) {
//     await DomainPattern.updateOne(
//       { domain: d },
//       {
//         $push: {
//           patterns: { code, success: 1, lastSuccessAt: new Date() },
//         },
//       }
//     );
//   }
// }

// /**
//  * Used for "from cache" case. We detected pattern after the fact,
//  * and we want to bump success without incrementing attempts this request.
//  */
// async function recordPatternSuccessFromCache(domain, code) {
//   if (!code) return;
//   const d = String(domain || "").toLowerCase();

//   await DomainPattern.updateOne(
//     { domain: d },
//     { $setOnInsert: { domain: d, attempts: 0 } },
//     { upsert: true }
//   );

//   const bump = await DomainPattern.updateOne(
//     { domain: d, "patterns.code": code },
//     {
//       $inc: { "patterns.$.success": 1 },
//       $set: { "patterns.$.lastSuccessAt": new Date() },
//     }
//   );

//   if (!bump.matchedCount && !bump.modifiedCount) {
//     await DomainPattern.updateOne(
//       { domain: d },
//       {
//         $push: {
//           patterns: { code, success: 1, lastSuccessAt: new Date() },
//         },
//       }
//     );
//   }
// }

// /**
//  * Build the final ordered candidate list as [{code,email}, ...]
//  *
//  * Order:
//  *   1. preferredCodes for that domain (from DB, most successful first),
//  *      but ONLY if the code is in our FIXED_CODES_50.
//  *   2. all FIXED_CODES_50 in the defined priority order.
//  *
//  * We explicitly DO NOT brute force beyond these.
//  */
// function makeCandidatesWithPriority(name, domain, preferredCodes = []) {
//   const d = String(domain || "")
//     .toLowerCase()
//     .trim();
//   const { first, last, F, L } = splitName(name);
//   if (!first || !d) return [];

//   const nameParts = { first, last, F, L };
//   const finalPairs = [];
//   const seenLocal = new Set();

//   // 1. domain-learned preferred codes first
//   for (const code of preferredCodes) {
//     if (!FIXED_CODES_50.includes(code)) continue;
//     const local = renderLocalFromCode(code, nameParts);
//     if (!local) continue;
//     if (seenLocal.has(local)) continue;
//     seenLocal.add(local);
//     finalPairs.push({ code, email: `${local}@${d}` });
//   }

//   // 2. our fixed curated codes
//   for (const code of FIXED_CODES_50) {
//     const local = renderLocalFromCode(code, nameParts);
//     if (!local) continue;
//     if (seenLocal.has(local)) continue;
//     seenLocal.add(local);
//     finalPairs.push({ code, email: `${local}@${d}` });
//   }

//   return finalPairs;
// }

// /**
//  * Try candidates in batches. Stop at first deliverable.
//  * Return { email, vr, code, index }
//  */
// async function findDeliverableParallel(candidates, concurrency = 8) {
//   for (let i = 0; i < candidates.length; i += concurrency) {
//     const slice = candidates.slice(i, i + concurrency);

//     const results = await Promise.all(
//       slice.map(async (cObj) => {
//         try {
//           const vr = await validateSMTPStable(cObj.email);
//           return {
//             code: cObj.code,
//             email: cObj.email,
//             vr,
//             ok: isDeliverable(vr),
//           };
//         } catch {
//           return { code: cObj.code, email: cObj.email, vr: null, ok: false };
//         }
//       })
//     );

//     const deliverables = results.filter((r) => r.ok);
//     if (deliverables.length) {
//       // pick one that was earliest in original list
//       let best = deliverables[0];
//       let bestIdx = candidates.findIndex((cObj) => cObj.email === best.email);
//       for (const d of deliverables) {
//         const idx = candidates.findIndex((cObj) => cObj.email === d.email);
//         if (idx < bestIdx) {
//           best = d;
//           bestIdx = idx;
//         }
//       }
//       return {
//         email: best.email,
//         vr: best.vr,
//         code: best.code,
//         index: bestIdx,
//       };
//     }
//   }
//   return null;
// }

// /**
//  * After we've already sent result to UI:
//  * keep testing next few patterns (up to maxExtraToTest).
//  * If they also work, record those codes for future speed.
//  */
// async function enrichDomainPatternsAfterResponse({
//   allCandidates,
//   alreadyTestedUntilIndex,
//   firstCode,
//   domainLC,
//   maxExtraToTest = 40,
// }) {
//   try {
//     if (!domainLC) return;

//     // record primary winner immediately (safe even if dup)
//     if (firstCode) {
//       await recordPatternSuccess(domainLC, firstCode);
//     }

//     const remaining = allCandidates.slice(alreadyTestedUntilIndex + 1);
//     const limited = remaining.slice(0, maxExtraToTest);

//     const seenCodes = new Set();
//     if (firstCode) seenCodes.add(firstCode);

//     for (const cObj of limited) {
//       try {
//         const vr = await validateSMTPStable(cObj.email);
//         if (!isDeliverable(vr)) continue;
//       } catch {
//         continue;
//       }

//       if (!cObj.code) continue;
//       if (seenCodes.has(cObj.code)) continue;

//       seenCodes.add(cObj.code);
//       await recordPatternSuccess(domainLC, cObj.code);
//     }
//   } catch (err) {
//     console.warn(
//       "[enrichDomainPatternsAfterResponse] warn:",
//       err?.message || err
//     );
//   }
// }

// /* ──────────────────────────────────────────────────────────────────────────────
//    ROUTER
// ────────────────────────────────────────────────────────────────────────────── */
// module.exports = function EmailFinderRouter() {
//   const router = express.Router();
//   const workers = new Map(); // bulk workers by key: "<tenant>:<bulkId>"

//   /* ─────────────────────────────  DOMAIN IMPORT (GLOBAL)  ──────────────────── */

//   /**
//    * POST /api/email-finder/domains/import
//    * Upload Excel with columns:
//    *   - "Domain"          (or "domain")
//    *   - "Email Address"   (or "Email" / "email")
//    *
//    * Body: multipart/form-data, field "file"
//    *
//    * NOTE:
//    * - Uses global Domain model, NOT tenant DB.
//    * - Auth is required; remove `requireAuth` if you want open access.
//    */
//   router.post(
//     "/domains/import",
//     requireAuth,
//     upload.single("file"),
//     async (req, res) => {
//       try {
//         if (!req.file || !req.file.buffer) {
//           return res
//             .status(400)
//             .json({ error: "No file uploaded. Use field name 'file'." });
//         }

//         // parse workbook
//         const wb = XLSX.read(req.file.buffer, { type: "buffer" });
//         const sheetName = wb.SheetNames[0];
//         const ws = wb.Sheets[sheetName];
//         const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

//         console.log(
//           "[domains.import] file=%s rows=%d",
//           req.file.originalname,
//           rows.length
//         );

//         const bulkOps = [];
//         let processed = 0;
//         let skippedNoDomain = 0;
//         let affectedDomains = 0;

//         for (const row of rows) {
//           // Try to get domain from "Domain" column
//           const rawDomain =
//             row.Domain || row["Domain"] || row.domain || row["domain"] || "";

//           // Try to get email from "Email Address" / "Email"
//           const rawEmail =
//             row["Email Address"] ||
//             row["Email"] ||
//             row["email address"] ||
//             row.email ||
//             "";

//           let domain = normalizeDomain(rawDomain);

//           // If no valid domain column, derive from email
//           if (!domain && rawEmail) {
//             domain = extractDomainFromEmail(rawEmail);
//           }

//           if (!domain) {
//             skippedNoDomain++;
//             processed++;
//             continue;
//           }

//           const { base, tld } = splitBaseAndTld(domain);
//           const sampleEmail = rawEmail ? String(rawEmail).trim() : null;

//           // We set domain/base/tld/sampleEmail on insert
//           // and increment emailsCount (if sampleEmail present) every time.
//           const update = {
//             $setOnInsert: {
//               domain,
//               base,
//               tld,
//               sampleEmail,
//             },
//           };

//           if (sampleEmail) {
//             update.$inc = { emailsCount: 1 };
//           }

//           bulkOps.push({
//             updateOne: {
//               filter: { domain },
//               update,
//               upsert: true,
//             },
//           });

//           // flush batch every 1000 operations
//           if (bulkOps.length >= 1000) {
//             const bulkResult = await Domain.bulkWrite(bulkOps, {
//               ordered: false,
//             });
//             affectedDomains +=
//               (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
//             bulkOps.length = 0;

//             console.log(
//               "[domains.import] processed=%d affectedDomains=%d",
//               processed,
//               affectedDomains
//             );
//           }

//           processed++;
//         }

//         // final flush
//         if (bulkOps.length > 0) {
//           const bulkResult = await Domain.bulkWrite(bulkOps, {
//             ordered: false,
//           });
//           affectedDomains +=
//             (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
//         }

//         const totalDomains = await Domain.countDocuments({});

//         return res.json({
//           ok: true,
//           fileName: req.file.originalname,
//           rowsInFile: rows.length,
//           processedRows: processed,
//           skippedNoDomain,
//           affectedDomains, // inserted + updated in this import
//           totalDomainsInCollection: totalDomains,
//         });
//       } catch (err) {
//         console.error("[domains.import] error", err);
//         return res.status(500).json({
//           error: "Domain import failed",
//           details: err.message || String(err),
//         });
//       }
//     }
//   );

//   // ---- helper: safe regex for user input
//   function escapeRegex(s = "") {
//     return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//   }

//   router.get("/domains/suggest", requireAuth, async (req, res) => {
//     try {
//       const qRaw = String(req.query.q || "").trim();
//       const limit = Math.max(1, Math.min(50, +(req.query.limit || 10)));
//       if (!qRaw) return res.json({ suggestions: [] });

//       const qLower = qRaw.toLowerCase();

//       // Safe regex escape
//       const escapeRegex = (s = "") =>
//         String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//       // Direct domain prefix match only
//       const domainPrefix = escapeRegex(
//         qLower.replace(/^https?:\/\//, "").replace(/^www\./, "")
//       );

//       const results = await Domain.find(
//         { domain: { $regex: "^" + domainPrefix, $options: "i" } },
//         { domain: 1 }
//       )
//         .sort({ emailsCount: -1 })
//         .limit(limit)
//         .lean();

//       const suggestions = results.map((d) => d.domain);
//       return res.json({ suggestions });
//     } catch (e) {
//       console.error("[domains.suggest] error", e);
//       return res.status(500).json({ error: "Suggestion lookup failed" });
//     }
//   });

//   router.post("/", requireAuth, async (req, res) => {
//     try {
//       const { name, domain: domainOrCompany } = req.body || {};
//       if (!name || !domainOrCompany) {
//         return res
//           .status(400)
//           .json({ error: "name and domain/company are required" });
//       }

//       const tenant = req.tenant;
//       const userId = req.user.id;
//       const Finder = getFinderModelByTenant(tenant);

//       const { first, last, F, L } = splitName(name);
//       if (!first) {
//         return res.json({
//           found: false,
//           note: "Could not parse a first name from input.",
//         });
//       }

//       // NEW: get all candidate domains (direct guesses + DB-based)
//       const candidateDomains = await getCandidateDomainsForInput(
//         domainOrCompany
//       );

//       if (!candidateDomains.length) {
//         return res.json({
//           found: false,
//           note: "We could not map that company/domain to any valid domain candidates.",
//         });
//       }

//       // Try each candidate domain until one yields a valid email
//       for (const domainLC of candidateDomains) {
//         const domain = String(domainLC).toLowerCase();

//         // 1) Cache check for this (user, domain, first, last)
//         const existing = await Finder.findOne({
//           userId,
//           domain,
//           first,
//           last,
//         }).lean();

//         if (existing?.email) {
//           const nameParts = { first, last, F, L };
//           const quickPairs = buildFixedPairs(nameParts, domain);
//           const hit = quickPairs.find(
//             (p) => p.email.toLowerCase() === existing.email.toLowerCase()
//           );
//           if (hit && hit.code) {
//             await recordPatternSuccessFromCache(domain, hit.code);
//           }

//           const updated = await User.findOneAndUpdate(
//             { _id: userId, credits: { $gt: 0 } },
//             { $inc: { credits: -1 } },
//             { new: true }
//           ).lean();

//           return res.json({
//             found: true,
//             email: existing.email,
//             domain,
//             confidence: existing.confidence || "Med",
//             fromCache: true,
//             creditsUsed: updated ? 1 : 0,
//           });
//         }

//         // 2) Pattern-based guessing for this domain
//         await bumpAttempts(domain);

//         const preferredCodes = await getPreferredCodesForDomain(domain);
//         const candidates = makeCandidatesWithPriority(
//           name,
//           domain,
//           preferredCodes
//         ); // [{code,email},...]

//         const found = await findDeliverableParallel(candidates, 8);
//         if (!found) {
//           // No deliverable email for this domain; try next domain
//           continue;
//         }

//         const bestEmail = found.email;
//         const bestVR = found.vr;
//         const bestCode = found.code;
//         const confidence = deriveConfidence(bestVR);

//         // Store in per-user Finder cache
//         await Finder.updateOne(
//           { userId, domain, first, last },
//           {
//             $set: {
//               userId,
//               domain,
//               first,
//               last,
//               nameInput: name,
//               email: bestEmail,
//               status: "Valid",
//               confidence,
//               reason: bestVR?.reason || "",
//               updatedAt: new Date(),
//               section: "finder",
//             },
//             $setOnInsert: { createdAt: new Date() },
//           },
//           { upsert: true }
//         );

//         // NEW: upsert into global Domains collection with this sample email
//         await upsertDomainSample(domain, bestEmail);

//         // Charge credit
//         const updated = await User.findOneAndUpdate(
//           { _id: userId, credits: { $gt: 0 } },
//           { $inc: { credits: -1 } },
//           { new: true }
//         ).lean();

//         // Respond immediately with this domain
//         res.json({
//           found: true,
//           email: bestEmail,
//           domain,
//           confidence,
//           creditsUsed: updated ? 1 : 0,
//         });

//         // Enrich patterns for this domain in the background
//         setImmediate(() => {
//           enrichDomainPatternsAfterResponse({
//             allCandidates: candidates,
//             alreadyTestedUntilIndex: found.index,
//             firstCode: bestCode,
//             domainLC: domain,
//             maxExtraToTest: 40,
//           });
//         });

//         return;
//       }

//       // If we reach here, no candidate domain could produce a valid email
//       return res.json({ found: false, message: "Result not found" });
//     } catch (e) {
//       console.error("single finder error", e);
//       return res.status(500).json({ error: e?.message || "Internal error" });
//     }
//   });

//   /* ─────────────────────────────  BULK FINDER  ───────────────────────────── */

//   // ping
//   router.get("/bulk/ping", (req, res) => {
//     console.log("[bulk.ping] ok hit=%s", req.originalUrl);
//     res.json({ ok: true, msg: "bulk routes reachable" });
//   });

//   // template (CSV) — Excel-friendly
//   router.get("/bulk/template.csv", requireAuth, async (req, res) => {
//     try {
//       const csvBody = "Full Name,Domain\r\nJohn Doe,acme.com\r\n";
//       const csv = "\uFEFF" + csvBody; // BOM
//       res.setHeader("Content-Type", "text/csv; charset=utf-8");
//       res.setHeader(
//         "Content-Disposition",
//         'attachment; filename="finder_template.csv"'
//       );
//       res.end(csv, "utf8");
//     } catch (e) {
//       console.error("template csv error", e);
//       res.status(500).json({ error: "Failed to build template" });
//     }
//   });

//   // start bulk
//   router.post(
//     "/bulk/start",
//     requireAuth,
//     upload.single("file"),
//     async (req, res) => {
//       try {
//         if (!req.file?.buffer)
//           return res.status(400).json({ error: "No file uploaded" });

//         const tenant = req.tenant;
//         const userId = req.user.id;

//         const dbConn = getUserDbByTenant(tenant);

//         const Bulk = getBulkModelByTenant(tenant);
//         const job = await Bulk.create({
//           userId,
//           filename: req.file.originalname || "bulk.csv",
//           rowsTotal: 0,
//           processed: 0,
//           rowsFound: 0,
//           state: "running",
//         });

//         const bulkId = String(job._id);
//         const workerKey = `${tenant}:${bulkId}`;

//         if (workers.has(workerKey)) {
//           console.warn("[bulk.start] worker already exists for %s", workerKey);
//           return res.json({ bulkId });
//         }

//         // async worker
//         workers.set(
//           workerKey,
//           (async () => {
//             const Finder = getFinderModelByTenant(tenant);
//             const bucket = getBulkBucketByTenant(tenant);

//             // domain -> preferredCodes cache
//             const preferredCache = new Map();
//             function preferredFor(domain) {
//               const d = String(domain || "").toLowerCase();
//               return preferredCache.has(d) ? preferredCache.get(d) : null;
//             }
//             async function ensurePreferred(domain) {
//               const d = String(domain || "").toLowerCase();
//               const codes = await getPreferredCodesForDomain(d);
//               preferredCache.set(d, codes);
//               return codes;
//             }

//             try {
//               // parse spreadsheet
//               const wb = XLSX.read(req.file.buffer, { type: "buffer" });
//               const ws = wb.Sheets[wb.SheetNames[0]];
//               const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

//               await Bulk.updateOne(
//                 { _id: job._id },
//                 { $set: { rowsTotal: rows.length } }
//               );

//               const outRows = [];
//               let processed = 0;
//               let rowsFound = 0;

//               const bump = async (force = false) => {
//                 processed++;
//                 const should =
//                   force || processed % 5 === 0 || processed === rows.length;
//                 if (should) {
//                   await Bulk.updateOne(
//                     { _id: job._id },
//                     { $set: { processed, rowsFound } }
//                   );
//                 }
//               };

//               for (const row of rows) {
//                 const fullName = pick(row, [
//                   "Full Name",
//                   "Full name",
//                   "Name",
//                   "name",
//                   "full_name",
//                 ]).trim();

//                 const rawDomainOrCompany = pick(row, [
//                   "Domain",
//                   "domain",
//                   "Company Domain",
//                   "company_domain",
//                 ]).trim();

//                 if (!fullName || !rawDomainOrCompany) {
//                   outRows.push({
//                     ...row,
//                     Found: "No",
//                     Email: "",
//                     Confidence: "",
//                     Note: "Missing name or domain/company",
//                   });
//                   await bump();
//                   continue;
//                 }

//                 const { first, last, F, L } = splitName(fullName);
//                 if (!first) {
//                   outRows.push({
//                     ...row,
//                     Found: "No",
//                     Email: "",
//                     Confidence: "",
//                     Note: "Could not parse a first name.",
//                   });
//                   await bump();
//                   continue;
//                 }

//                 // NEW: get all candidate domains for this input
//                 const domainCandidates = await getCandidateDomainsForInput(
//                   rawDomainOrCompany
//                 );

//                 if (!domainCandidates.length) {
//                   outRows.push({
//                     ...row,
//                     Found: "No",
//                     Email: "",
//                     Confidence: "",
//                     Note: "Domain/company not recognized in dataset.",
//                   });
//                   await bump();
//                   continue;
//                 }

//                 let rowEmail = "";
//                 let rowConfidence = "";
//                 let rowDomainUsed = "";
//                 let fromCacheNote = "";

//                 // Try each domain until one yields an email
//                 for (const domain of domainCandidates) {
//                   const d = String(domain).toLowerCase();

//                   // 1) Cache check
//                   const existing = await Finder.findOne({
//                     userId,
//                     domain: d,
//                     first,
//                     last,
//                   }).lean();

//                   if (existing?.email) {
//                     const nameParts = { first, last, F, L };
//                     const quickPairs = buildFixedPairs(nameParts, d);
//                     const hit = quickPairs.find(
//                       (p) =>
//                         p.email.toLowerCase() === existing.email.toLowerCase()
//                     );
//                     if (hit && hit.code) {
//                       await recordPatternSuccessFromCache(d, hit.code);
//                     }

//                     const updatedCredits = await User.findOneAndUpdate(
//                       { _id: userId, credits: { $gt: 0 } },
//                       { $inc: { credits: -1 } },
//                       { new: true }
//                     ).lean();

//                     rowEmail = existing.email;
//                     rowConfidence = existing.confidence || "Med";
//                     rowDomainUsed = d;
//                     fromCacheNote = updatedCredits
//                       ? "Charged 1 credit (cache)"
//                       : "";
//                     break;
//                   }

//                   // 2) Pattern + SMTP for this domain
//                   await bumpAttempts(d);

//                   let codes = preferredFor(d);
//                   if (!codes) codes = await ensurePreferred(d);

//                   const candidates = makeCandidatesWithPriority(
//                     fullName,
//                     d,
//                     codes
//                   );
//                   const found = await findDeliverableParallel(candidates, 8);

//                   if (!found) {
//                     // Try next domain
//                     continue;
//                   }

//                   const email = found.email;
//                   const conf = deriveConfidence(found.vr);
//                   const codeHit = found.code;

//                   // Charge credit for a fresh lookup
//                   await User.findOneAndUpdate(
//                     { _id: userId, credits: { $gt: 0 } },
//                     { $inc: { credits: -1 } },
//                     { new: true }
//                   ).lean();

//                   try {
//                     await Finder.updateOne(
//                       { userId, domain: d, first, last },
//                       {
//                         $set: {
//                           userId,
//                           domain: d,
//                           first,
//                           last,
//                           nameInput: fullName,
//                           email,
//                           status: "Valid",
//                           confidence: conf,
//                           updatedAt: new Date(),
//                           section: "finder",
//                         },
//                         $setOnInsert: { createdAt: new Date() },
//                       },
//                       { upsert: true }
//                     );
//                   } catch (e) {
//                     console.error("finder upsert (valid) failed", {
//                       userId,
//                       domain: d,
//                       first,
//                       last,
//                       email,
//                       e: e?.message || e,
//                     });
//                   }

//                   // Learn / refresh pattern stats
//                   if (codeHit) {
//                     await recordPatternSuccess(d, codeHit);
//                     preferredCache.set(d, await getPreferredCodesForDomain(d));
//                   }

//                   // NEW: upsert into global Domains collection with this sample email
//                   await upsertDomainSample(d, email);

//                   rowEmail = email;
//                   rowConfidence = conf;
//                   rowDomainUsed = d;
//                   break;
//                 }

//                 if (rowEmail) {
//                   // At least one domain worked
//                   outRows.push({
//                     ...row,
//                     Domain: rowDomainUsed,
//                     Found: "Yes",
//                     Email: rowEmail,
//                     Confidence: rowConfidence,
//                     Note: fromCacheNote,
//                   });
//                   rowsFound++;
//                 } else {
//                   // none of the candidate domains produced an email
//                   try {
//                     const firstDomain = String(
//                       domainCandidates[0]
//                     ).toLowerCase();
//                     await Finder.updateOne(
//                       { userId, domain: firstDomain, first, last },
//                       {
//                         $set: {
//                           userId,
//                           domain: firstDomain,
//                           first,
//                           last,
//                           nameInput: fullName,
//                           status: "NotFound",
//                           confidence: "",
//                           updatedAt: new Date(),
//                           section: "finder",
//                         },
//                         $setOnInsert: { createdAt: new Date() },
//                       },
//                       { upsert: true }
//                     );
//                   } catch (e) {
//                     console.error("finder upsert (notfound) failed", {
//                       userId,
//                       domain: domainCandidates[0],
//                       first,
//                       last,
//                       e: e?.message || e,
//                     });
//                   }

//                   outRows.push({
//                     ...row,
//                     Domain: domainCandidates[0],
//                     Found: "No",
//                     Email: "",
//                     Confidence: "",
//                     Note: "Mailbox could not be confirmed.",
//                   });
//                 }

//                 await bump();
//               }

//               // Build XLSX result file
//               const outWs = XLSX.utils.json_to_sheet(outRows);
//               const outWb = XLSX.utils.book_new();
//               XLSX.utils.book_append_sheet(outWb, outWs, "Results");
//               const xlsxBuf = XLSX.write(outWb, {
//                 type: "buffer",
//                 bookType: "xlsx",
//               });

//               // Save XLSX to GridFS bucket
//               const bucket2 = getBulkBucketByTenant(tenant);
//               const uploadStream = bucket2.openUploadStream(
//                 `result_${
//                   job.filename?.replace(/\.(xlsx|xls|csv)$/i, "") || "bulk"
//                 }.xlsx`,
//                 {
//                   metadata: { type: "result", bulkId: String(job._id) },
//                 }
//               );

//               await new Promise((resolve, reject) => {
//                 const s = new stream.PassThrough();
//                 s.end(xlsxBuf);
//                 s.pipe(uploadStream).on("finish", resolve).on("error", reject);
//               });

//               await Bulk.updateOne(
//                 { _id: job._id },
//                 {
//                   $set: {
//                     processed: rows.length,
//                     rowsFound,
//                     rowsTotal: rows.length,
//                     resultFileId: uploadStream.id,
//                     state: "done",
//                   },
//                 }
//               );
//             } catch (err) {
//               console.error("[bulk.worker] error bulkId=%s", bulkId, err);
//               await Bulk.updateOne(
//                 { _id: job._id },
//                 {
//                   $set: {
//                     state: "error",
//                     error: err?.message || "Bulk failed",
//                   },
//                 }
//               );
//             } finally {
//               workers.delete(workerKey);
//             }
//           })()
//         );

//         return res.json({ bulkId });
//       } catch (e) {
//         console.error("bulk start error", e);
//         return res.status(500).json({ error: "Failed to start bulk" });
//       }
//     }
//   );

//   // progress  (no-store headers)
//   router.get("/bulk/progress", requireAuth, async (req, res) => {
//     try {
//       res.set(
//         "Cache-Control",
//         "no-store, no-cache, must-revalidate, proxy-revalidate"
//       );
//       res.set("Pragma", "no-cache");
//       res.set("Expires", "0");

//       const tenant = req.tenant;
//       const userId = req.user.id;
//       const bulkId = req.query?.bulkId;
//       if (!bulkId) return res.status(400).json({ error: "bulkId required" });

//       const Bulk = getBulkModelByTenant(tenant);
//       const doc = await Bulk.findOne({ _id: bulkId, userId }).lean();
//       if (!doc) return res.status(404).json({ error: "Not found" });

//       const total = Math.max(0, doc.rowsTotal || 0);
//       const processed = Math.max(0, doc.processed || 0);
//       const found = Math.max(0, doc.rowsFound || 0);

//       return res.json({
//         state: doc.state || "uploaded",
//         total,
//         processed,
//         found,
//         pct: total > 0 ? Math.round((processed / total) * 100) : 0,
//         resultReady: !!doc.resultFileId,
//         resultFileId: doc.resultFileId || null,
//         updatedAt: doc.updatedAt,
//       });
//     } catch (e) {
//       console.error("bulk progress error", e);
//       return res.status(500).json({ error: "Progress failed" });
//     }
//   });

//   // history  (no-store headers)
//   router.get("/bulk/history", requireAuth, async (req, res) => {
//     try {
//       res.set(
//         "Cache-Control",
//         "no-store, no-cache, must-revalidate, proxy-revalidate"
//       );
//       res.set("Pragma", "no-cache");
//       res.set("Expires", "0");

//       const tenant = req.tenant;
//       const userId = req.user.id;

//       const Bulk = getBulkModelByTenant(tenant);
//       const items = await Bulk.find({ userId })
//         .sort({ createdAt: -1 })
//         .limit(100)
//         .lean();

//       return res.json({
//         items: items.map((d) => ({
//           _id: String(d._id),
//           filename: d.filename,
//           createdAt: d.createdAt,
//           rowsFound: d.rowsFound || 0,
//           rowsTotal: d.rowsTotal || 0,
//           state: d.state || "uploaded",
//           resultFileId: d.resultFileId || null,
//           processed: d.processed || 0,
//         })),
//       });
//     } catch (e) {
//       console.error("bulk history error", e);
//       return res.status(500).json({ error: "History failed" });
//     }
//   });

//   // JSON Preview of first N rows
//   router.get("/bulk/:bulkId/preview", requireAuth, async (req, res) => {
//     try {
//       res.set(
//         "Cache-Control",
//         "no-store, no-cache, must-revalidate, proxy-revalidate"
//       );
//       res.set("Pragma", "no-cache");
//       res.set("Expires", "0");

//       const tenant = req.tenant;
//       const userId = req.user.id;
//       const limit = Math.max(1, Math.min(500, +(req.query.limit || 50)));

//       const Bulk = getBulkModelByTenant(tenant);
//       const job = await Bulk.findOne({
//         _id: req.params.bulkId,
//         userId,
//       }).lean();
//       if (!job?.resultFileId)
//         return res.status(404).json({ error: "Result not ready" });

//       const bucket = getBulkBucketByTenant(tenant);

//       // read up to ~2MB for preview
//       const maxBytes = 2 * 1024 * 1024;
//       let size = 0;
//       const chunks = [];

//       await new Promise((resolve, reject) => {
//         bucket
//           .openDownloadStream(new ObjectId(String(job.resultFileId)))
//           .on("data", (chunk) => {
//             size += chunk.length;
//             if (size <= maxBytes) chunks.push(chunk);
//           })
//           .on("error", reject)
//           .on("end", resolve);
//       });

//       const fileBuf = Buffer.concat(chunks);
//       const wb = XLSX.read(fileBuf, { type: "buffer" });
//       const ws = wb.Sheets[wb.SheetNames[0]];
//       const all = XLSX.utils.sheet_to_json(ws, { defval: "" });

//       const rows = all.slice(0, limit).map((r) => ({
//         name: r["Full Name"] || r["Name"] || "",
//         domain: r["Domain"] || r["Company Domain"] || "",
//         email: r["Email"] || "",
//         confidence: r["Confidence"] || "",
//         found: r["Found"] || "",
//       }));

//       return res.json({ rows, total: all.length, shown: rows.length });
//     } catch (e) {
//       console.error("preview result error", e);
//       return res.status(500).json({ error: "Preview failed" });
//     }
//   });

//   // download XLSX
//   router.get("/bulk/:bulkId/result", requireAuth, async (req, res) => {
//     try {
//       const tenant = req.tenant;
//       const userId = req.user.id;

//       const Bulk = getBulkModelByTenant(tenant);
//       const job = await Bulk.findOne({
//         _id: req.params.bulkId,
//         userId,
//       }).lean();
//       if (!job?.resultFileId)
//         return res.status(404).json({ error: "Result not ready" });

//       const bucket = getBulkBucketByTenant(tenant);
//       const safeName = (job.filename || "bulk").replace(
//         /\.(xlsx|xls|csv)$/i,
//         ""
//       );

//       res.setHeader(
//         "Content-Type",
//         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//       );
//       res.setHeader("X-Content-Type-Options", "nosniff");
//       res.setHeader(
//         "Content-Disposition",
//         `attachment; filename="result_${safeName}.xlsx"`
//       );

//       bucket
//         .openDownloadStream(new ObjectId(String(job.resultFileId)))
//         .on("error", (err) => {
//           console.error("[bulk.download] stream error", err);
//           if (!res.headersSent) res.status(500).end("Download failed");
//         })
//         .pipe(res);
//     } catch (e) {
//       console.error("download result error", e);
//       return res.status(500).json({ error: "Download failed" });
//     }
//   });

//   // delete bulk job + file
//   router.delete("/bulk/:bulkId", requireAuth, async (req, res) => {
//     try {
//       const tenant = req.tenant;
//       const userId = req.user.id;

//       const Bulk = getBulkModelByTenant(tenant);
//       const bucket = getBulkBucketByTenant(tenant);

//       const job = await Bulk.findOne({
//         _id: req.params.bulkId,
//         userId,
//       }).lean();
//       if (!job) return res.status(404).json({ error: "Not found" });

//       if (job.resultFileId) {
//         try {
//           await bucket.delete(new ObjectId(String(job.resultFileId)));
//         } catch (e) {
//           console.warn("[bulk.delete] gridfs delete warn:", e?.message || e);
//         }
//       }

//       await Bulk.deleteOne({ _id: req.params.bulkId, userId });

//       return res.json({ ok: true });
//     } catch (e) {
//       console.error("delete job error", e);
//       return res.status(500).json({ error: "Delete failed" });
//     }
//   });

//   return router;
// };

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
  const reason = String(vr.reason || "");
  const smtpYes =
    vr.smtpAccepted === true ||
    /^2\d\d$/.test(String(vr.smtpCode || "")) ||
    /\b2\d\d\b/.test(reason) ||
    /accepted|ok|success/i.test(reason);

  return (
    cat === "valid" ||
    ((cat === "accept_all" || cat === "accept-all" || cat === "risky") &&
      smtpYes)
  );
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

            // charge credit
            await User.findOneAndUpdate(
              { _id: userId, credits: { $gt: 0 } },
              { $inc: { credits: -1 } },
              { new: true }
            ).lean();

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
