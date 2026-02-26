// // routes/EmailFinder.js
// const express = require("express");
// const mongoose = require("mongoose");
// const multer = require("multer");
// const XLSX = require("xlsx");

// const User = require("../models/User");
// const FinderGlobal = require("../models/Finder");
// const { validateSMTPStable } = require("../utils/smtpValidator");

// // GLOBAL collections (shared)
// const DomainPattern = require("../models/DomainPattern");
// const Domain = require("../models/Domain");

// // memory upload (only used for domains/import)
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 25 * 1024 * 1024 },
// });

// /* ───────────────────────────────────────────────────────────────
//    TENANT HELPERS (User-level DB)
// ─────────────────────────────────────────────────────────────── */

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

// /* ───────────────────────────────────────────────────────────────
//    AUTH
// ─────────────────────────────────────────────────────────────── */
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

// /* ───────────────────────────────────────────────────────────────
//    UTILITIES
// ─────────────────────────────────────────────────────────────── */

// function normalizeASCII(s = "") {
//   return String(s || "")
//     .normalize("NFKD")
//     .replace(/[\u0300-\u036f]/g, "")
//     .replace(/[^\w\s'-]/g, " ")
//     .toLowerCase()
//     .trim()
//     .replace(/\s+/g, " ");
// }

// // Full name -> {first,last,F,L} (lowercase ascii)
// function splitFullName(full = "") {
//   const parts = normalizeASCII(full).split(" ").filter(Boolean);
//   const first = parts[0] || "";
//   const last = parts.length > 1 ? parts[parts.length - 1] : "";
//   const F = first ? first[0] : "";
//   const L = last ? last[0] : "";
//   return { first, last, F, L };
// }

// function normalizeDomain(raw) {
//   if (!raw) return "";

//   let d = String(raw).trim().toLowerCase();
//   d = d.replace(/^[a-z]+:\/\//, "");
//   d = d.split("/")[0].split("?")[0].split("#")[0];
//   d = d.replace(/^www\./, "").trim();

//   if (!d.includes(".") || d.includes(" ")) return "";
//   return d;
// }

// function splitBaseAndTld(domain) {
//   if (!domain) return { base: "", tld: "" };
//   const parts = domain.split(".").filter(Boolean);
//   if (parts.length < 2) return { base: parts[0] || "", tld: "" };
//   return { base: parts[0], tld: parts[parts.length - 1] };
// }

// async function upsertDomainSample(domain, email) {
//   if (!domain) return;
//   const d = String(domain).toLowerCase();
//   const { base, tld } = splitBaseAndTld(d);
//   const sampleEmail = email ? String(email).trim() : null;

//   const update = { $setOnInsert: { domain: d, base, tld } };

//   if (sampleEmail) {
//     update.$set = { sampleEmail };
//     update.$inc = { emailsCount: 1 };
//   }

//   await Domain.updateOne({ domain: d }, update, { upsert: true });
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
//   return cat === "valid";
// }

// /* ───────────────────────────────────────────────────────────────
//    PATTERNS
// ─────────────────────────────────────────────────────────────── */

// const FIXED_CODES_50 = [
//   "f.l",
//   "l.f",
//   "f.L",
//   "F.l",
//   "fl",
//   "lf",
//   "f",
//   "l",

//   "f_l",
//   "l_f",
//   "f_L",
//   "F_l",
//   "fL",
//   "Fl",

//   "f-l",
//   "l-f",
//   "f-L",
//   "F-l",
//   "f-Ll",
//   "fLl",

//   "f.lL",
//   "fL.l",
//   "F.lL",
//   "F.L",
//   "FL",

//   "l.fL",
//   "l.F",
//   "lF",

//   "F.f.l",
//   "f.F.l",
//   "f.l.F",
//   "f.lL",
//   "fL.l",

//   "fL",
//   "lF",

//   "f.L",
//   "F.l",
//   "F.lL",
//   "F.Ll",

//   "f_lL",
//   "fL_l",
//   "F_lL",
//   "F_L",
//   "FL_",
//   "F_Ll",
//   "f_Ll",
//   "l_F",
//   "l_Ff",

//   "f-lL",
//   "fL-l",
//   "F-lL",
//   "l-fL",
// ];

// function sanitizeLocal(local) {
//   return String(local || "")
//     .replace(/[^\w.-]/g, "")
//     .replace(/\.+/g, ".")
//     .replace(/[_-]{2,}/g, "_")
//     .replace(/^[._-]+|[._-]+$/g, "");
// }

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

// async function getPreferredCodesForDomain(domain) {
//   const d = String(domain || "").toLowerCase();
//   const doc = await DomainPattern.findOne({ domain: d }).lean();
//   if (!doc || !Array.isArray(doc.patterns) || doc.patterns.length === 0)
//     return [];
//   const sorted = [...doc.patterns].sort(
//     (a, b) => (b.success || 0) - (a.success || 0)
//   );
//   return sorted
//     .map((p) => p.code)
//     .filter((c) => c && FIXED_CODES_50.includes(c));
// }

// async function bumpAttempts(domain) {
//   const d = String(domain || "").toLowerCase();
//   await DomainPattern.updateOne(
//     { domain: d },
//     { $setOnInsert: { domain: d, attempts: 0 } },
//     { upsert: true }
//   );
//   await DomainPattern.updateOne({ domain: d }, { $inc: { attempts: 1 } });
// }

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
//       { $push: { patterns: { code, success: 1, lastSuccessAt: new Date() } } }
//     );
//   }
// }

// async function recordPatternSuccessFromCache(domain, code) {
//   return recordPatternSuccess(domain, code);
// }

// function makeCandidatesWithPriorityParts(
//   domain,
//   nameParts,
//   preferredCodes = []
// ) {
//   const d = String(domain || "")
//     .toLowerCase()
//     .trim();
//   if (!d || !nameParts?.first) return [];

//   const finalPairs = [];
//   const seenLocal = new Set();

//   for (const code of preferredCodes || []) {
//     if (!FIXED_CODES_50.includes(code)) continue;
//     const local = renderLocalFromCode(code, nameParts);
//     if (!local) continue;
//     if (seenLocal.has(local)) continue;
//     seenLocal.add(local);
//     finalPairs.push({ code, email: `${local}@${d}` });
//   }

//   for (const code of FIXED_CODES_50) {
//     const local = renderLocalFromCode(code, nameParts);
//     if (!local) continue;
//     if (seenLocal.has(local)) continue;
//     seenLocal.add(local);
//     finalPairs.push({ code, email: `${local}@${d}` });
//   }

//   return finalPairs;
// }

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
//       let best = deliverables[0];
//       let bestIdx = candidates.findIndex((c) => c.email === best.email);

//       for (const d of deliverables) {
//         const idx = candidates.findIndex((c) => c.email === d.email);
//         if (idx >= 0 && idx < bestIdx) {
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

// /* ───────────────────────────────────────────────────────────────
//    ROUTER
// ─────────────────────────────────────────────────────────────── */
// module.exports = function EmailFinderRouter() {
//   const router = express.Router();

//   /* ───────────────────────────── DOMAIN IMPORT ───────────────────────────── */
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

//         const wb = XLSX.read(req.file.buffer, { type: "buffer" });
//         const ws = wb.Sheets[wb.SheetNames[0]];
//         const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

//         const bulkOps = [];
//         let processed = 0;
//         let skippedNoDomain = 0;
//         let affectedDomains = 0;

//         for (const row of rows) {
//           const rawDomain =
//             row.Domain || row["Domain"] || row.domain || row["domain"] || "";

//           const rawEmail =
//             row["Email Address"] ||
//             row["Email"] ||
//             row["email address"] ||
//             row.email ||
//             "";

//           let domain = normalizeDomain(rawDomain);

//           if (!domain && rawEmail) {
//             const parts = String(rawEmail).trim().toLowerCase().split("@");
//             if (parts.length === 2) domain = normalizeDomain(parts[1]);
//           }

//           if (!domain) {
//             skippedNoDomain++;
//             processed++;
//             continue;
//           }

//           const { base, tld } = splitBaseAndTld(domain);
//           const sampleEmail = rawEmail ? String(rawEmail).trim() : null;

//           const update = {
//             $setOnInsert: { domain, base, tld, sampleEmail },
//           };
//           if (sampleEmail) update.$inc = { emailsCount: 1 };

//           bulkOps.push({
//             updateOne: { filter: { domain }, update, upsert: true },
//           });

//           if (bulkOps.length >= 1000) {
//             const bulkResult = await Domain.bulkWrite(bulkOps, {
//               ordered: false,
//             });
//             affectedDomains +=
//               (bulkResult.upsertedCount || 0) + (bulkResult.modifiedCount || 0);
//             bulkOps.length = 0;
//           }

//           processed++;
//         }

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
//           affectedDomains,
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

//   /* ───────────────────────────── DOMAIN SUGGEST ───────────────────────────── */
//   router.get("/domains/suggest", requireAuth, async (req, res) => {
//     try {
//       const qRaw = String(req.query.q || "").trim();
//       const limit = Math.max(1, Math.min(50, +(req.query.limit || 10)));
//       if (!qRaw) return res.json({ suggestions: [] });

//       const escapeRegex = (s = "") =>
//         String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

//       const qLower = qRaw.toLowerCase();
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

//       return res.json({ suggestions: results.map((d) => d.domain) });
//     } catch (e) {
//       console.error("[domains.suggest] error", e);
//       return res.status(500).json({ error: "Suggestion lookup failed" });
//     }
//   });

//   /* ───────────────────────────── PARALLEL START ─────────────────────────────
//    POST /api/finder/start
//    Body: { fullName, domain }
//    Returns immediately: { ok:true, jobId }
// ─────────────────────────────────────────────────────────────────────────── */
//   router.post("/start", requireAuth, async (req, res) => {
//     try {
//       const { fullName, domain } = req.body || {};

//       if (!fullName || !domain) {
//         return res
//           .status(400)
//           .json({ error: "fullName and domain are required" });
//       }

//       const domainLC = normalizeDomain(domain);
//       if (!domainLC) {
//         return res
//           .status(400)
//           .json({ error: "Please provide a valid domain." });
//       }

//       const nameParts = splitFullName(fullName);
//       if (!nameParts.first) {
//         return res.status(400).json({ error: "Could not parse first name." });
//       }

//       const tenant = req.tenant;
//       const userId = req.user.id;

//       const Finder = getFinderModelByTenant(tenant);

//       const first = nameParts.first;
//       const last = nameParts.last || "";

//       const baseFilter = { userId, domain: domainLC, first, last };

//       /* ✅ 0) GLOBAL CACHE CHECK FIRST (BEFORE touching user record) */
//       const globalHit = await FinderGlobal.findOne({
//         domain: domainLC,
//         first,
//         last,
//         email: { $ne: null },
//       }).lean();

//       if (globalHit?.email) {
//         // Touch global timestamp (and optionally hitCount)
//         await FinderGlobal.updateOne(
//           { _id: globalHit._id },
//           {
//             $set: { updatedAt: new Date() },
//             // OPTIONAL (only if your schema allows it):
//             // $inc: { hitCount: 1 },
//           }
//         );

//         // Create/update user history record as DONE (do NOT reset to running)
//         const userDoc = await Finder.findOneAndUpdate(
//           baseFilter,
//           {
//             $set: {
//               userId,
//               domain: domainLC,
//               first,
//               last,
//               nameInput: fullName.trim(),
//               state: "done",
//               status: globalHit.status || "Valid",
//               confidence: globalHit.confidence || "Med",
//               reason: globalHit.reason || "",
//               error: "",
//               email: globalHit.email,
//               updatedAt: new Date(),
//             },
//             $setOnInsert: { createdAt: new Date() },
//           },
//           { upsert: true, new: true }
//         ).lean();

//         // pattern learning from cache (best effort)
//         const quickPairs = buildFixedPairs(nameParts, domainLC);
//         const hit = quickPairs.find(
//           (p) => p.email.toLowerCase() === String(globalHit.email).toLowerCase()
//         );
//         if (hit?.code) await recordPatternSuccessFromCache(domainLC, hit.code);

//         // charge credit
//         await User.findOneAndUpdate(
//           { _id: userId, credits: { $gt: 0 } },
//           { $inc: { credits: -1 } },
//           { new: true }
//         ).lean();

//         return res.json({ ok: true, jobId: String(userDoc._id) });
//       }

//       /* ✅ 1) USER CACHE CHECK SECOND (BEFORE resetting) */
//       const userHit = await Finder.findOne({
//         ...baseFilter,
//         email: { $ne: null },
//       }).lean();

//       if (userHit?.email) {
//         // Touch user timestamp
//         await Finder.updateOne(
//           { _id: userHit._id, userId },
//           { $set: { updatedAt: new Date() } }
//         );

//         // ALSO optionally touch global cache if you want (upsert)
//         // This makes global stronger even if user found it earlier.
//         await FinderGlobal.updateOne(
//           { domain: domainLC, first, last },
//           {
//             $set: {
//               domain: domainLC,
//               first,
//               last,
//               email: userHit.email,
//               status: userHit.status || "Valid",
//               confidence: userHit.confidence || "Med",
//               reason: userHit.reason || "",
//               updatedAt: new Date(),
//             },
//             $setOnInsert: { createdAt: new Date() },
//           },
//           { upsert: true }
//         );

//         // charge credit
//         await User.findOneAndUpdate(
//           { _id: userId, credits: { $gt: 0 } },
//           { $inc: { credits: -1 } },
//           { new: true }
//         ).lean();

//         return res.json({ ok: true, jobId: String(userHit._id) });
//       }

//       /* ✅ 2) NO CACHE → NOW create/reset running record */
//       const doc = await Finder.findOneAndUpdate(
//         baseFilter,
//         {
//           $set: {
//             userId,
//             domain: domainLC,
//             first,
//             last,
//             nameInput: fullName.trim(),
//             state: "running",
//             status: "Unknown",
//             confidence: "Low",
//             reason: "",
//             error: "",
//             email: null,
//             updatedAt: new Date(),
//           },
//           $setOnInsert: { createdAt: new Date() },
//         },
//         { upsert: true, new: true }
//       ).lean();

//       // Return jobId immediately
//       res.json({ ok: true, jobId: String(doc._id) });

//       // Background execution
//       setImmediate(async () => {
//         try {
//           // Domain patterns
//           await bumpAttempts(domainLC);
//           const preferredCodes = await getPreferredCodesForDomain(domainLC);

//           const candidates = makeCandidatesWithPriorityParts(
//             domainLC,
//             nameParts,
//             preferredCodes
//           );

//           const found = await findDeliverableParallel(candidates, 8);

//           if (!found) {
//             await Finder.updateOne(
//               { _id: doc._id, userId },
//               {
//                 $set: {
//                   state: "done",
//                   status: "Unknown",
//                   confidence: "Low",
//                   email: null,
//                   reason: "Result not found",
//                   error: "",
//                   updatedAt: new Date(),
//                 },
//               }
//             );

//             return;
//           }

//           const bestEmail = found.email;
//           const bestVR = found.vr;
//           const bestCode = found.code;
//           const confidence = deriveConfidence(bestVR);

//           // store in USER history
//           await Finder.updateOne(
//             { _id: doc._id, userId },
//             {
//               $set: {
//                 state: "done",
//                 status: "Valid",
//                 confidence,
//                 email: bestEmail,
//                 reason: bestVR?.reason || "",
//                 error: "",
//                 updatedAt: new Date(),
//               },
//             }
//           );

//           // ✅ store in GLOBAL cache too (same schema, same collection name "finders")
//           await FinderGlobal.updateOne(
//             { domain: domainLC, first, last },
//             {
//               $set: {
//                 domain: domainLC,
//                 first,
//                 last,
//                 nameInput: fullName.trim(),
//                 state: "done", // ✅ FIX
//                 status: "Valid",
//                 confidence,
//                 email: bestEmail,
//                 reason: bestVR?.reason || "",
//                 error: "", // ✅ keep clean
//                 updatedAt: new Date(),
//               },
//               $setOnInsert: {
//                 createdAt: new Date(),
//               },
//             },
//             { upsert: true }
//           );

//           // learn pattern
//           if (bestCode) await recordPatternSuccess(domainLC, bestCode);

//           // update domain dataset
//           await upsertDomainSample(domainLC, bestEmail);

//           // charge credit
//           await User.findOneAndUpdate(
//             { _id: userId, credits: { $gt: 0 } },
//             { $inc: { credits: -1 } },
//             { new: true }
//           ).lean();
//         } catch (err) {
//           console.error("[finder.start worker] error", err);

//           await Finder.updateOne(
//             { _id: doc._id, userId },
//             {
//               $set: {
//                 state: "error",
//                 status: "Unknown",
//                 confidence: "Low",
//                 email: null,
//                 error: err?.message || "Finder failed",
//                 updatedAt: new Date(),
//               },
//             }
//           );
//         }
//       });
//     } catch (e) {
//       console.error("finder start error", e);
//       return res.status(500).json({ error: e?.message || "Internal error" });
//     }
//   });

//   /* ───────────────────────────── JOB STATUS ─────────────────────────────
//      GET /api/finder/job/:id
//   ─────────────────────────────────────────────────────────────────────────── */
//   router.get("/job/:id", requireAuth, async (req, res) => {
//     try {
//       const tenant = req.tenant;
//       const userId = req.user.id;
//       const Finder = getFinderModelByTenant(tenant);

//       const job = await Finder.findOne({ _id: req.params.id, userId }).lean();
//       if (!job) return res.status(404).json({ error: "Not found" });

//       return res.json({
//         _id: String(job._id),
//         state: job.state || "done",
//         status: job.status || "Unknown",
//         fullName: job.nameInput,
//         domain: job.domain,
//         email: job.email || "",
//         confidence: job.confidence || "Low",
//         reason: job.reason || "",
//         error: job.error || "",
//         createdAt: job.createdAt,
//         updatedAt: job.updatedAt,
//       });
//     } catch (e) {
//       console.error("job fetch error", e);
//       return res.status(500).json({ error: "Job fetch failed" });
//     }
//   });

//   /* ───────────────────────────── HISTORY ─────────────────────────────
//      GET /api/finder/history?limit=50
//   ───────────────────────────────────────────────────────────────────── */
//   router.get("/history", requireAuth, async (req, res) => {
//     try {
//       const tenant = req.tenant;
//       const userId = req.user.id;
//       const limit = Math.max(1, Math.min(200, +(req.query.limit || 50)));

//       const Finder = getFinderModelByTenant(tenant);

//       const items = await Finder.find({ userId })
//         .sort({ createdAt: -1 })
//         .limit(limit)
//         .lean();

//       return res.json({
//         items: items.map((d) => ({
//           _id: String(d._id),
//           state: d.state || "done",
//           status: d.status || "Unknown",
//           fullName: d.nameInput,
//           domain: d.domain,
//           email: d.email || "",
//           confidence: d.confidence || "Low",
//           reason: d.reason || "",
//           error: d.error || "",
//           createdAt: d.createdAt,
//           updatedAt: d.updatedAt,
//         })),
//       });
//     } catch (e) {
//       console.error("finder history error", e);
//       return res.status(500).json({ error: "History failed" });
//     }
//   });

//   return router;
// };




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

// ✅ SendGrid + classifier (same as bulk)
const {
  verifySendGrid,
  isProofpointDomain,
  toTrueSendrFormat,
} = require("../utils/sendgridVerifier");
const SendGridLog = require("../models/SendGridLog");
const {
  classifyDomain,
  getDomainCategory,
} = require("../utils/domainClassifier");

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

async function buildHistoryForEmail(emailNorm) {
  const E = normEmail(emailNorm);
  const domain = extractDomain(E);
  if (!domain || domain === "N/A") return {};

  const domainPromise = DomainReputation.findOne({ domain }).lean();
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

async function recordPatternSuccessFromCache(domain, code) {
  return recordPatternSuccess(domain, code);
}

function makeCandidatesWithPriorityParts(
  domain,
  nameParts,
  preferredCodes = [],
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

/* ───────────────────────────────────────────────────────────────
   BULK-LIKE VALIDATION for ONE candidate
   ✅ NO EmailLog (no global cache, no global writes)
─────────────────────────────────────────────────────────────── */

const FRESH_DB_MS = Number(process.env.FRESH_DB_MS || 15 * 24 * 60 * 60 * 1000);
const FINDER_CONCURRENCY = Number(process.env.FINDER_CONCURRENCY || 8);

// FinderGlobal freshness window (no EmailLog)
const FRESH_FINDER_MS = Number(
  process.env.FRESH_FINDER_MS || 15 * 24 * 60 * 60 * 1000,
);

/**
 * ✅ FIX #1:
 * normalizeOutcomeCategory now understands SendGrid webhook events
 * so "delivered" becomes "valid" and "bounce/dropped/blocked" becomes "invalid".
 */
function normalizeOutcomeCategory(input) {
  const raw = String(input || "").trim().toLowerCase();

  // direct categories
  if (raw === "valid" || raw.startsWith("valid")) return "valid";
  if (raw === "invalid" || raw.startsWith("invalid")) return "invalid";
  if (raw === "risky" || raw.startsWith("risky")) return "risky";
  if (raw === "unknown" || raw.startsWith("unknown")) return "unknown";

  // sendgrid webhook events => category mapping
  // (this is the missing piece causing "Webhook finalized → unknown")
  const evt = raw.replace(/\s+/g, "");
  if (evt === "delivered" || evt === "open" || evt === "opened" || evt === "click" || evt === "clicked") {
    return "valid";
  }
  if (
    evt === "bounce" ||
    evt === "bounced" ||
    evt === "dropped" ||
    evt === "blocked" ||
    evt === "spamreport" ||
    evt === "unsubscribe"
  ) {
    return "invalid";
  }
  if (evt === "deferred") return "risky";

  // fuzzy matches
  if (raw.includes("deliver")) return "valid";
  if (raw.includes("bounce") || raw.includes("dropped") || raw.includes("blocked") || raw.includes("undeliverable"))
    return "invalid";
  if (raw.includes("risk")) return "risky";
  if (raw.includes("valid")) return "valid";
  if (raw.includes("invalid")) return "invalid";

  return "unknown";
}

function getOutcomeCategory(final) {
  return normalizeOutcomeCategory(final?.category || final?.status || "");
}

async function validateCandidateBulkLike({
  email,
  username,
  jobId,
  domainLC,
  cancel,
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

  // Early DNS/MX check
  try {
    const mxRecords = await dns.resolveMx(domain);
    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    if (!mxRecords || mxRecords.length === 0) {
      logger(
        "domain_validation",
        `Domain ${domain} has no MX records - cannot receive emails`,
        "warn",
      );
      const built = buildReasonAndMessage(
        "Invalid",
        "invalid_domain_no_mx",
        {},
      );
      return {
        ok: false,
        out: {
          email: E,
          status: "❌ Invalid",
          subStatus: "invalid_domain_no_mx",
          category: "invalid",
          confidence: 0.99,
          reason: "Invalid Domain",
          message:
            built.message ||
            `Domain ${domain} has no MX records and cannot receive emails`,
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
  } catch (dnsError) {
    logger(
      "domain_validation",
      `DNS lookup failed for ${domain}: ${dnsError.message}`,
      "warn",
    );
    const built = buildReasonAndMessage(
      "Invalid",
      "invalid_domain_dns_error",
      {},
    );
    return {
      ok: false,
      out: {
        email: E,
        status: "❌ Invalid",
        subStatus: "invalid_domain_dns_error",
        category: "invalid",
        confidence: 0.95,
        reason: "Invalid Domain",
        message:
          built.message || `Domain ${domain} does not exist or DNS failed`,
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

  // Domain flags (same as bulk)
  const domainClassification = classifyDomain(domain) || {};
  const isBankOrHealthcare =
    !!domainClassification &&
    (domainClassification.isBank || domainClassification.isHealthcare);

  let isProofpoint = false;
  try {
    isProofpoint = await isProofpointDomain(domain);
  } catch (e) {
    isProofpoint = false;
    logger("proofpoint_check_error", e.message || "failed", "warn");
  }

  if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

  // Track SMTP-only categories to apply “trust SMTP valid”
  let smtpPrimaryCat = null;
  let smtpStableCat = null;

  let final = null;

  // helper: merge with history and return final formatted object
  const finalize = async (raw, providerLabelForMerge) => {
    const history = await buildHistoryForEmail(E);

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

  // ✅ SendGrid "finalization" wait (robust)
  const SENDGRID_WAIT_MS = Number(
    process.env.SENDGRID_WAIT_MS || (isProofpoint ? 90000 : 30000)
  );
  const SENDGRID_POLL_MS = Number(process.env.SENDGRID_POLL_MS || 750);
  const SENDGRID_DEDUPE_MS = Number(process.env.SENDGRID_DEDUPE_MS || 10 * 60 * 1000); // 10 min

  const FINAL_EVENTS = new Set([
    "delivered",
    "bounce",
    "bounced",
    "dropped",
    "deferred",
    "spamreport",
    "open",
    "click",
    "unsubscribe",
    "blocked",
  ]);

  function isSendGridRowFinal(row) {
    if (!row) return false;

    if (row.webhookReceived === true) return true;

    const cat = String(row.category || "").toLowerCase();
    const finalCat = String(row.finalCategory || "").toLowerCase();
    if (cat && cat !== "unknown") return true;
    if (finalCat && finalCat !== "unknown") return true;

    const st = String(row.status || "").toLowerCase();
    const fst = String(row.finalStatus || "").toLowerCase();
    if (fst && fst !== "unknown") return true;
    if (st && st !== "unknown" && st !== "pending") return true;

    const evt = String(row.webhookEvent || row.event || "").toLowerCase();
    if (evt && FINAL_EVENTS.has(evt)) return true;

    return false;
  }

  /**
   * ✅ FIX #2:
   * pickDecidedCategoryFromRow now correctly interprets webhook event values
   * like "delivered/bounce/dropped" into valid/invalid/risky.
   */
  function pickDecidedCategoryFromRow(row) {
    return normalizeOutcomeCategory(
      row?.finalCategory ||
        row?.category ||
        row?.finalStatus ||
        row?.status ||
        row?.webhookEvent ||
        row?.event ||
        "unknown"
    );
  }

  /**
   * ✅ FIX #3 (safe):
   * Keep full messageId (don’t split by ".") and also compute a "base" for fallback matching.
   */
  function normalizeMsgIdFull(x) {
    if (!x) return null;
    let s = String(x).trim();
    s = s.replace(/^<|>$/g, ""); // remove angle brackets if present
    return s || null;
  }

  function normalizeMsgIdBase(x) {
    const full = normalizeMsgIdFull(x);
    if (!full) return null;
    // base is only used for startsWith/regex fallback; we do NOT destroy the id anymore
    return full.split(".")[0] || full;
  }

  async function getRecentSendGridRowByEmail(emailNorm) {
    const since = new Date(Date.now() - SENDGRID_DEDUPE_MS);
    return SendGridLog.findOne({ email: emailNorm, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .lean();
  }

  async function getSendGridRowByMessageIdSmart(messageIdFull) {
    if (!messageIdFull) return null;
    const full = normalizeMsgIdFull(messageIdFull);
    const base = normalizeMsgIdBase(messageIdFull);

    // 1) exact match (full)
    const exact = await SendGridLog.findOne({
      $or: [
        { messageId: full },
        { fullMessageId: full },
        { sg_message_id: full },
        { sgMessageId: full },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();
    if (exact) return exact;

    // 2) fallback: startsWith base (covers webhook IDs like base.something)
    if (base) {
      const re = new RegExp("^" + String(base).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const alt = await SendGridLog.findOne({
        $or: [
          { messageId: re },
          { fullMessageId: re },
          { sg_message_id: re },
          { sgMessageId: re },
        ],
      })
        .sort({ createdAt: -1 })
        .lean();
      if (alt) return alt;
    }

    return null;
  }

  async function waitForSendGridFinalSmart({ messageId, email }) {
    const started = Date.now();
    const msgFull = normalizeMsgIdFull(messageId);

    while (Date.now() - started < SENDGRID_WAIT_MS) {
      if (cancel?.isStopped?.()) return null;

      // 1) by messageId (best when it matches webhook)
      let row = await getSendGridRowByMessageIdSmart(msgFull);

      // 2) fallback by email+recent (covers messageId mismatch cases)
      if (!row && email) {
        row = await getRecentSendGridRowByEmail(email);
      }

      if (row && isSendGridRowFinal(row)) return row;

      await new Promise((r) => setTimeout(r, SENDGRID_POLL_MS));
    }

    return null;
  }

  // helper: sendgrid → (pending => wait webhook) → toTrueSendrFormat → merge → return
  async function doSendGrid({ providerLabel, isFallback, smtpRawForLog }) {
    if (cancel?.isStopped?.()) {
      logger("sendgrid_skip", "Skipped because winner already found", "info");
      throw new Error("cancelled");
    }

    // ✅ 0) DEDUPE: if we already sent recently for this email, reuse that log
    try {
      const recent = await getRecentSendGridRowByEmail(E);

      if (recent) {
        const recentMsgId =
          recent.fullMessageId ||
          recent.messageId ||
          recent.sg_message_id ||
          recent.sgMessageId ||
          null;

        if (isSendGridRowFinal(recent)) {
          const decidedCategory = pickDecidedCategoryFromRow(recent);

          const decidedStatus =
            decidedCategory === "valid"
              ? "✅ Valid"
              : decidedCategory === "invalid"
                ? "❌ Invalid"
                : decidedCategory === "risky"
                  ? "⚠️ Risky"
                  : "❔ Unknown";

          const sgTrueSendr = {
            email: E,
            domain,
            provider: providerLabel,
            status: decidedStatus,
            sub_status: recent.sub_status || recent.subStatus || null,
            category: decidedCategory,
            confidence:
              typeof recent.confidence === "number" ? recent.confidence : 0.85,
            reason:
              recent.bounceReason || recent.webhookReason || recent.reason || null,
            message: recent.bounceReason
              ? `SendGrid: ${recent.bounceReason}`
              : recent.webhookReason
                ? `SendGrid: ${recent.webhookReason}`
                : null,
            isDisposable: !!recent.isDisposable,
            isFree: !!recent.isFree,
            isRoleBased: !!recent.isRoleBased,
            score: typeof recent.score === "number" ? recent.score : 50,
            isCatchAll: false,
          };

          logger(
            "sendgrid_dedupe_final",
            `Reusing recent SendGridLog (final) → ${sgTrueSendr.category}`,
            "info"
          );

          return await finalize(sgTrueSendr, providerLabel);
        }

        // pending-like: wait using smart waiter (msgId or email fallback)
        if (recentMsgId) {
          logger(
            "sendgrid_dedupe_wait",
            `Reusing recent SendGridLog (pending) → waiting webhook for messageId=${normalizeMsgIdFull(recentMsgId)}`,
            "info"
          );

          const row = await waitForSendGridFinalSmart({
            messageId: recentMsgId,
            email: E,
          });

          if (row) {
            const decidedCategory = pickDecidedCategoryFromRow(row);

            const decidedStatus =
              decidedCategory === "valid"
                ? "✅ Valid"
                : decidedCategory === "invalid"
                  ? "❌ Invalid"
                  : decidedCategory === "risky"
                    ? "⚠️ Risky"
                    : "❔ Unknown";

            const sgTrueSendr = {
              email: E,
              domain,
              provider: providerLabel,
              status: decidedStatus,
              sub_status: row.sub_status || row.subStatus || null,
              category: decidedCategory,
              confidence:
                typeof row.confidence === "number" ? row.confidence : 0.85,
              reason: row.bounceReason || row.webhookReason || row.reason || null,
              message: row.bounceReason
                ? `SendGrid: ${row.bounceReason}`
                : row.webhookReason
                  ? `SendGrid: ${row.webhookReason}`
                  : null,
              isDisposable: !!row.isDisposable,
              isFree: !!row.isFree,
              isRoleBased: !!row.isRoleBased,
              score: typeof row.score === "number" ? row.score : 50,
              isCatchAll: false,
            };

            logger(
              "sendgrid_dedupe_wait_done",
              `Webhook finalized (dedupe) → ${sgTrueSendr.category}`,
              "info"
            );

            return await finalize(sgTrueSendr, providerLabel);
          }

          logger(
            "sendgrid_dedupe_wait_timeout",
            `No webhook final within ${SENDGRID_WAIT_MS}ms (dedupe)`,
            "warn"
          );
          // continue to "send new" as last resort
        }
      }
    } catch (e) {
      logger("sendgrid_dedupe_error", e.message || "dedupe failed", "warn");
    }

    // ✅ 1) SEND NEW via SendGrid
    const t0 = Date.now();
    const sgResult = await verifySendGrid(E, {
      logger,
      trainingTag: "finder",
      // harmless metadata (doesn't affect other features)
      username,
      jobId,
    });
    const elapsedMs = Date.now() - t0;
    logger("sendgrid_time", `verifySendGrid elapsed=${elapsedMs}ms`, "info");

    const fullMessageId =
      sgResult?.messageId || sgResult?.sg_message_id || sgResult?.sgMessageId || null;
    const messageIdFull = normalizeMsgIdFull(fullMessageId);
    const messageIdBase = normalizeMsgIdBase(fullMessageId);

    const schemaStatus = String(sgResult?.status || "unknown").toLowerCase();
    const statusSafe = ["deliverable", "undeliverable", "risky", "unknown"].includes(schemaStatus)
      ? schemaStatus
      : "unknown";

    const categorySafe = normalizeOutcomeCategory(
      sgResult?.category || sgResult?.status || sgResult?.event || sgResult?.webhookEvent || "unknown"
    );

    const isPendingLike =
      categorySafe === "unknown" ||
      /pending|processing|queued/i.test(String(sgResult?.sub_status || "")) ||
      /pending|processing|queued/i.test(String(sgResult?.status || ""));

    const metaSg = { domain, flags: { disposable: false, free: false, role: false } };

    let sgTrueSendr = toTrueSendrFormat(sgResult, metaSg);
    sgTrueSendr.provider = providerLabel;
    sgTrueSendr.domainProvider = providerLabel;

    // ✅ write log row (Finder-only)
    try {
      await SendGridLog.create({
        email: E,
        domain,
        username,
        sessionId: String(jobId || ""), // helps some webhook matchers; safe
        bulkId: null,

        // store both full + base
        fullMessageId: messageIdFull,
        messageId: messageIdFull || messageIdBase || null,

        status: statusSafe,
        category: categorySafe,
        sub_status: sgResult?.sub_status || (isPendingLike ? "sendgrid_pending" : null),

        confidence: typeof sgResult?.confidence === "number" ? sgResult.confidence : 0.5,
        score: typeof sgTrueSendr?.score === "number" ? sgTrueSendr.score : 50,

        reason: sgResult?.reason || null,
        statusCode: sgResult?.statusCode ?? null,
        method: sgResult?.method || "web_api",

        isProofpoint: !!isProofpoint,
        isFallback: !!isFallback,

        smtpCategory: smtpRawForLog?.category || null,
        smtpSubStatus: smtpRawForLog?.sub_status || null,

        provider: providerLabel,
        elapsed_ms: sgResult?.elapsed_ms ?? null,
        error: sgResult?.error || null,
        rawResponse: sgResult,

        isDisposable: !!sgTrueSendr?.isDisposable,
        isFree: !!sgTrueSendr?.isFree,
        isRoleBased: !!sgTrueSendr?.isRoleBased,
      });
    } catch (e) {
      logger("sendgrid_log_error", e.message, "warn");
    }

    // ✅ 2) Pending-like => wait with SMART waiter (messageId OR email fallback)
    if (isPendingLike) {
      logger(
        "sendgrid_wait",
        `Pending-like → waiting webhook for messageId=${messageIdFull || messageIdBase || "N/A"}`,
        "info"
      );

      const row = await waitForSendGridFinalSmart({
        messageId: messageIdFull || messageIdBase,
        email: E,
      });

      if (cancel?.isStopped?.()) return null;

      if (row) {
        const decidedCategory = pickDecidedCategoryFromRow(row);

        const decidedStatus =
          decidedCategory === "valid"
            ? "✅ Valid"
            : decidedCategory === "invalid"
              ? "❌ Invalid"
              : decidedCategory === "risky"
                ? "⚠️ Risky"
                : "❔ Unknown";

        sgTrueSendr = {
          email: E,
          domain,
          provider: providerLabel,
          status: decidedStatus,
          sub_status: row.sub_status || row.subStatus || null,
          category: decidedCategory,
          confidence: typeof row.confidence === "number" ? row.confidence : 0.85,
          reason: row.bounceReason || row.webhookReason || row.reason || null,
          message: row.bounceReason
            ? `SendGrid: ${row.bounceReason}`
            : row.webhookReason
              ? `SendGrid: ${row.webhookReason}`
              : null,
          isDisposable: !!row.isDisposable,
          isFree: !!row.isFree,
          isRoleBased: !!row.isRoleBased,
          score: typeof row.score === "number" ? row.score : 50,
          isCatchAll: false,
        };

        logger("sendgrid_wait_done", `Webhook finalized → ${sgTrueSendr.category}`, "info");
      } else {
        logger("sendgrid_wait_timeout", `No webhook final within ${SENDGRID_WAIT_MS}ms`, "warn");
      }
    }

    if (cancel?.isStopped?.()) return null;

    return await finalize(sgTrueSendr, providerLabel);
  }

  // 1) SPECIAL DOMAIN → SendGrid first + bank/healthcare reputation gate
  if (isBankOrHealthcare || isProofpoint) {
    const domainCategory = isBankOrHealthcare
      ? getDomainCategory(domain)
      : "Proofpoint Email Protection";

    logger(
      isBankOrHealthcare && isProofpoint
        ? "bank_healthcare_proofpoint"
        : isBankOrHealthcare
          ? "bank_healthcare"
          : "proofpoint",
      `${domainCategory} detected → using SendGrid verification`,
      "info",
    );

    // bank/healthcare domain reputation gate (same as bulk)
    if (isBankOrHealthcare) {
      try {
        const domainStats = await DomainReputation.findOne({ domain }).lean();
        if (cancel?.isStopped?.())
          return { ok: false, out: null, source: "Live" };

        if (domainStats && domainStats.sent >= 5) {
          const bounceRate =
            domainStats.sent > 0 ? domainStats.invalid / domainStats.sent : 0;

          logger(
            "domain_reputation",
            `Sent=${domainStats.sent} Invalid=${domainStats.invalid} BounceRate=${(
              bounceRate * 100
            ).toFixed(1)}%`,
            "info",
          );

          if (bounceRate >= 0.6) {
            const fastRiskyRaw = {
              email: E,
              status: "⚠️ Risky",
              sub_status: "high_bounce_bank_healthcare",
              category: "risky",
              confidence: 0.85,
              reason: "High Bounce Domain",
              message: `This ${domainCategory} domain has a high bounce rate (${(
                bounceRate * 100
              ).toFixed(1)}%). Sending to this address is risky.`,
              domain,
              provider: domainCategory,
              isDisposable: false,
              isFree: false,
              isRoleBased: false,
              score: 20,
            };

            final = await finalize(fastRiskyRaw, domainCategory);
            return { ok: isDeliverable(final), out: final, source: "Live" };
          }
        }
      } catch (e) {
        logger("domain_reputation_error", e.message, "warn");
      }
    }

    try {
      const providerLabel = `${domainCategory} (via SendGrid)`;
      final = await doSendGrid({
        providerLabel,
        isFallback: false,
        smtpRawForLog: null,
      });

      if (final) {
        return { ok: isDeliverable(final), out: final, source: "Live" };
      }

      if (cancel?.isStopped?.())
        return { ok: false, out: null, source: "Live" };
    } catch (sgErr) {
      logger("sendgrid_error", sgErr.message, "warn");
      // fall through to SMTP path
    }
  }

  if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

  // 2) SMTP prelim → if unknown -> SendGrid fallback
  try {
    const prelimRaw = await validateSMTP(E, { logger, trainingTag: "finder" });

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    smtpPrimaryCat =
      prelimRaw.category || categoryFromStatus(prelimRaw.status || "");

    if (prelimRaw.category === "unknown" && !cancel?.isStopped?.()) {
      logger(
        "sendgrid_fallback",
        "SMTP returned UNKNOWN → Attempting SendGrid fallback...",
        "info",
      );
      try {
        final = await doSendGrid({
          providerLabel: "SendGrid (fallback)",
          isFallback: true,
          smtpRawForLog: prelimRaw,
        });
      } catch (sgError) {
        logger("sendgrid_fallback_error", sgError.message, "warn");
      }
    }

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    // If still not final: merge prelim SMTP with history; accept if not unknown
    if (!final) {
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
    }

    if (cancel?.isStopped?.()) return { ok: false, out: null, source: "Live" };

    // 3) If still not final => SMTP stable → if unknown -> SendGrid fallback
    if (!final) {
      const stableRaw = await validateSMTPStable(E, {
        logger,
        trainingTag: "finder",
      });

      if (cancel?.isStopped?.())
        return { ok: false, out: null, source: "Live" };

      smtpStableCat =
        stableRaw.category || categoryFromStatus(stableRaw.status || "");

      if (stableRaw.category === "unknown" && !cancel?.isStopped?.()) {
        logger(
          "sendgrid_stable_fallback",
          "SMTP Stable returned UNKNOWN → Attempting SendGrid fallback...",
          "info",
        );
        try {
          final = await doSendGrid({
            providerLabel: "SendGrid (stable fallback)",
            isFallback: true,
            smtpRawForLog: stableRaw,
          });
        } catch (sgError) {
          logger("sendgrid_stable_fallback_error", sgError.message, "warn");
        }
      }

      if (cancel?.isStopped?.())
        return { ok: false, out: null, source: "Live" };

      if (!final) {
        final = await finalize(
          {
            ...stableRaw,
            category:
              stableRaw.category || categoryFromStatus(stableRaw.status || ""),
          },
          stableRaw.provider || "Unavailable",
        );
      }
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
    const smtpCat = String(smtpStableCat || smtpPrimaryCat || "")
      .trim()
      .toLowerCase();
    const finalCat = String(getOutcomeCategory(final)).toLowerCase();

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
  { concurrency = FINDER_CONCURRENCY, username, jobId, domainLC },
) {
  let nextIndex = 0;
  let winner = null;
  let stopped = false;

  const cancel = {
    isStopped: () => stopped,
    stop: () => {
      stopped = true;
    },
  };

  async function runOne(cObj) {
    if (cancel.isStopped()) return null;

    const r = await validateCandidateBulkLike({
      email: cObj.email,
      username,
      jobId,
      domainLC,
      cancel,
    });

    if (cancel.isStopped()) return null;

    if (r?.ok) {
      cancel.stop();
      return {
        code: cObj.code,
        email: cObj.email,
        out: r.out,
        source: r.source || "Live",
      };
    }

    return null;
  }

  async function worker() {
    while (!cancel.isStopped()) {
      const i = nextIndex++;
      if (i >= candidates.length) return;

      const cObj = candidates[i];
      try {
        const got = await runOne(cObj);
        if (got && !winner) {
          winner = { ...got, index: i };
          cancel.stop();
          return;
        }
      } catch {
        // ignore
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, candidates.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  if (!winner) return null;

  return {
    email: winner.email,
    final: winner.out,
    code: winner.code,
    index: winner.index,
    source: winner.source,
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
                status: "Valid",
                confidence: globalHit.confidence || "Med",
                reason: globalHit.reason || "",
                error: "",
                email: globalHit.email, // valid only
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true, new: true },
          ).lean();

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
        { upsert: true, new: true },
      ).lean();

      // Return jobId immediately
      res.json({ ok: true, jobId: String(doc._id) });

      // Background execution
      setImmediate(async () => {
        try {
          await bumpAttempts(domainLC);
          const preferredCodes = await getPreferredCodesForDomain(domainLC);

          const candidates = makeCandidatesWithPriorityParts(
            domainLC,
            nameParts,
            preferredCodes,
          );

          const found = await findDeliverableParallelEnhanced(candidates, {
            concurrency: FINDER_CONCURRENCY,
            username,
            jobId: String(doc._id),
            domainLC,
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

          await FinderGlobal.updateOne(
            { domain: domainLC, first, last },
            {
              $set: {
                domain: domainLC,
                first,
                last,
                nameInput: fullName.trim(),
                state: "done",
                status: finalIsValid ? "Valid" : "Unknown",
                confidence,
                email: finalIsValid ? bestEmail : null,
                reason: bestFinal?.reason || bestFinal?.message || "",
                error: "",
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
          );

          if (finalIsValid && bestCode)
            await recordPatternSuccess(domainLC, bestCode);

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