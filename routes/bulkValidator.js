// // routes/bulkValidator.js
// const express = require("express");
// const xlsx = require("xlsx");
// const { Readable } = require("stream");
// const router = express.Router();

// module.exports = function bulkValidatorRouter(deps) {
//   const {
//     mongoose,
//     EmailLog,
//     RegionStat,
//     DomainReputation,
//     User,
//     BulkStat,
//     incDashStat,
//     categoryFromStatus,
//     normEmail,
//     buildReasonAndMessage,
//     extractDomain,
//     replaceLatest,
//     bumpUpdatedAt,
//     detectProviderByMX,
//     FRESH_DB_MS,
//     validateSMTP,
//     validateSMTPStable,
//     sendProgressToFrontend,
//     sendStatusToFrontend,
//     sendBulkStatsToFrontend,
//     maybeBulkAuth,
//     getGridFSBucket,
//     cancelMap,
//   } = deps;

//   const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

//   // ---------- helpers: GridFS ----------
//   function bucket(username) {
//     const b = getGridFSBucket && getGridFSBucket(username);
//     if (!b) throw new Error("GridFS bucket not ready");
//     return b;
//   }

//   async function saveBufferToGridFS(
//     username,
//     buf,
//     filename,
//     mime,
//     metadata = {}
//   ) {
//     return new Promise((resolve, reject) => {
//       const upload = bucket(username).openUploadStream(filename, {
//         contentType: mime || "application/octet-stream",
//         metadata,
//       });
//       Readable.from(buf)
//         .pipe(upload)
//         .on("error", reject)
//         .on("finish", () =>
//           resolve({
//             id: upload.id,
//             length: upload.length,
//             filename: upload.filename,
//             contentType: upload.options.contentType,
//           })
//         );
//     });
//   }

//   async function readGridFSToBuffer(username, fileId) {
//     return new Promise((resolve, reject) => {
//       const chunks = [];
//       bucket(username)
//         .openDownloadStream(fileId)
//         .on("data", (c) => chunks.push(c))
//         .on("error", reject)
//         .on("end", () => resolve(Buffer.concat(chunks)));
//     });
//   }

//   // ---------- helpers: preflight stats ----------
//   function countPreflight(rows, emailCol) {
//     const seen = new Set();
//     let invalidFormat = 0;
//     let totalRows = 0;
//     const domains = new Set();
//     for (const r of rows) {
//       const raw = r[emailCol];
//       if (raw == null || String(raw).trim() === "") continue;
//       totalRows++;
//       const e = normEmail(String(raw));
//       if (!EMAIL_RE.test(e)) {
//         invalidFormat++;
//         continue;
//       }
//       seen.add(e);
//       const d = extractDomain(e);
//       if (d && d !== "N/A") domains.add(d);
//     }
//     const duplicates = totalRows - invalidFormat - seen.size;
//     return {
//       totalRows,
//       invalidFormat,
//       duplicates: Math.max(duplicates, 0),
//       domainsCount: domains.size,
//     };
//   }

//   // ───────────────────────────────────────────────────────────
//   // 1) PRE-FLIGHT: parse Excel, compute counts, store BulkStat + original in GridFS
//   // ───────────────────────────────────────────────────────────
//   router.post(
//     "/preflight",
//     maybeBulkAuth,
//     deps.upload.single("file"),
//     async (req, res) => {
//       const sessionId = req.body?.sessionId || req.query?.sessionId || null;
//       const username =
//         req.headers["x-user"] || req.body?.username || req.query?.username;
//       if (!username) return res.status(400).send("Username required");
//       if (!req.file || !req.file.buffer)
//         return res.status(400).send("No file uploaded");

//       try {
//         // read workbook from memory
//         const wb = xlsx.read(req.file.buffer, { type: "buffer" });
//         const sheetName = wb.SheetNames[0];
//         const ws = wb.Sheets[sheetName];
//         const rows = xlsx.utils.sheet_to_json(ws);
//         if (!rows.length) return res.status(400).send("Empty sheet");

//         const emailCol = Object.keys(rows[0]).find((c) =>
//           c.toLowerCase().includes("email")
//         );
//         if (!emailCol) return res.status(400).send("No email column found");

//         const stats = countPreflight(rows, emailCol);
//         const creditsRequired = stats.totalRows;

//         // credit check
//         const user = await User.findOne({ username });
//         if (!user) return res.status(404).send("User not found");
//         if ((user.credits || 0) < creditsRequired)
//           return res.status(400).send("You don't have enough credits");

//         const bulkId = require("crypto").randomUUID();
//         // store original in user's DB GridFS
//         const original = await saveBufferToGridFS(
//           username,
//           req.file.buffer,
//           req.file.originalname || "bulk.xlsx",
//           req.file.mimetype ||
//             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//           { username, kind: "original", bulkId }
//         );

//         const { BulkStat: UserBulkStat } = deps.getUserDb(
//           mongoose,
//           EmailLog,
//           RegionStat,
//           DomainReputation,
//           username,
//           BulkStat
//         );

//         await UserBulkStat.create({
//           bulkId,
//           username,
//           sessionId,
//           originalName: req.file.originalname,
//           originalFileId: original.id,
//           originalMime: original.contentType,
//           originalSize: original.length,
//           totalRows: stats.totalRows,
//           invalidFormat: stats.invalidFormat,
//           duplicates: stats.duplicates,
//           domainsCount: stats.domainsCount,
//           creditsRequired,
//           state: "preflight",
//         });

//         // WS snapshot
//         if (sessionId) {
//           sendBulkStatsToFrontend(sessionId, username, {
//             bulkId,
//             phase: "preflight",
//             fileName: req.file.originalname,
//             date: new Date().toISOString(),
//             totals: stats,
//             creditsRequired,
//           });
//         }

//         // response
//         res.json({
//           ok: true,
//           bulkId,
//           fileName: req.file.originalname,
//           date: new Date().toISOString(),
//           totals: stats,
//           creditsRequired,
//         });
//       } catch (err) {
//         console.error("❌ /api/bulk/preflight:", err);
//         res.status(500).send("Preflight failed");
//       }
//     }
//   );

//   // small helper to bump live counters and push WS
//   async function bumpLiveCounts(
//     UserBulkStat,
//     bulkId,
//     username,
//     sessionId,
//     cat
//   ) {
//     const inc = {};
//     if (cat === "valid") inc.valid = 1;
//     else if (cat === "invalid") inc.invalid = 1;
//     else if (cat === "risky") inc.risky = 1;
//     else inc.unknown = 1;

//     const doc = await UserBulkStat.findOneAndUpdate(
//       { bulkId },
//       { $inc: inc },
//       { new: true }
//     );
//     if (doc && sessionId) {
//       sendBulkStatsToFrontend(sessionId, username, {
//         bulkId,
//         phase: "running",
//         counts: {
//           valid: doc.valid,
//           invalid: doc.invalid,
//           risky: doc.risky,
//           unknown: doc.unknown,
//         },
//       });
//     }
//   }

//   // ───────────────────────────────────────────────────────────
//   // 2) START: load original from GridFS, validate, save result to GridFS, stream to client
//   // ───────────────────────────────────────────────────────────
//   router.post("/start", maybeBulkAuth, async (req, res) => {
//     const { bulkId, sessionId } =
//       typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
//     const username =
//       req.headers["x-user"] || req.body?.username || req.query?.username;
//     if (!username) return res.status(400).send("Username required");
//     if (!bulkId) return res.status(400).send("bulkId required");

//     // background flag decided UP FRONT
//     const noDownload =
//       req.query.noDownload === "1" || req.body?.noDownload === true;

//     const { BulkStat: UserBulkStat, EmailLog: UserEmailLog } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );

//     const meta = await UserBulkStat.findOne({ bulkId });
//     if (!meta) return res.status(404).send("Bulk session not found");
//     if (!meta.originalFileId)
//       return res.status(400).send("Original file missing");

//     // mark "running" immediately so list/progress UIs can reflect it
//     await UserBulkStat.updateOne(
//       { bulkId },
//       { state: "running", startedAt: new Date(), sessionId }
//     );

//     // --- The heavy job extracted into a helper so we can call it in foreground or background ---
//     const runJob = async ({ streamToRes = false }) => {
//       // read original from GridFS
//       let rows, emailCol;
//       try {
//         const origBuffer = await readGridFSToBuffer(
//           username,
//           meta.originalFileId
//         );
//         const wb = xlsx.read(origBuffer, { type: "buffer" });
//         const sheet = wb.SheetNames[0];
//         const ws = wb.Sheets[sheet];
//         rows = xlsx.utils.sheet_to_json(ws);
//         emailCol = Object.keys(rows[0] || {}).find((c) =>
//           c.toLowerCase().includes("email")
//         );
//         if (!emailCol) {
//           await UserBulkStat.updateOne(
//             { bulkId },
//             { state: "failed", error: "No email column found" }
//           );
//           if (streamToRes) res.status(400).send("No email column found");
//           return;
//         }
//         rows = rows.filter(
//           (r) => r[emailCol] != null && String(r[emailCol]).trim() !== ""
//         );
//       } catch (e) {
//         await UserBulkStat.updateOne(
//           { bulkId },
//           { state: "failed", error: "Unable to read original file" }
//         );
//         if (streamToRes) res.status(500).send("Unable to read original file");
//         return;
//       }

//       const total = rows.length;
//       sendProgressToFrontend(0, total, sessionId, username, bulkId);

//       let billableCount = 0;

//       const delay = (ms) => new Promise((r) => setTimeout(r, ms));
//       const mapWithConcurrency = async (items, limit, worker, onProgress) => {
//         let nextIndex = 0,
//           done = 0;
//         const results = new Array(items.length);
//         async function runner() {
//           while (true) {
//             if (deps.cancelMap?.get(bulkId)) break;
//             const i = nextIndex++;
//             if (i >= items.length) break;
//             try {
//               results[i] = await worker(items[i], i);
//             } catch {
//               results[i] = null;
//             } finally {
//               done++;
//               try {
//                 onProgress(done, items.length);
//               } catch {}
//               await delay(5);
//             }
//           }
//         }
//         await Promise.all(
//           Array.from(
//             { length: Math.min(limit, Math.max(1, items.length)) },
//             runner
//           )
//         );
//         return results;
//       };

//       const mxCache = new Map(); // cache domain→provider within this run

//       const worker = async (row) => {
//         if (deps.cancelMap?.get(bulkId)) throw new Error("CANCELED");
//         const raw = row[emailCol];
//         if (!raw) return null;
//         const E = normEmail(raw);

//         let final = null;
//         let usedCache = false;

//         const cached = await EmailLog.findOne({ email: E }).sort({
//           updatedAt: -1,
//           createdAt: -1,
//         });
//         const fresh = cached
//           ? Date.now() -
//               new Date(
//                 cached.updatedAt || cached.createdAt || cached.timestamp || 0
//               ).getTime() <=
//             FRESH_DB_MS
//           : false;

//         if (cached && fresh) {
//           usedCache = true;
//           const builtCached = buildReasonAndMessage(
//             cached.status,
//             cached.subStatus || null,
//             {
//               isDisposable: !!cached.isDisposable,
//               isRoleBased: !!cached.isRoleBased,
//               isFree: !!cached.isFree,
//             }
//           );
//           await bumpUpdatedAt(EmailLog, E, "bulk");
//           await UserEmailLog.findOneAndUpdate(
//             { email: E },
//             {
//               $set: {
//                 email: E,
//                 status: cached.status,
//                 subStatus: cached.subStatus || null,
//                 confidence:
//                   typeof cached.confidence === "number"
//                     ? cached.confidence
//                     : null,
//                 category: cached.category || categoryFromStatus(cached.status),
//                 reason: cached.reason || builtCached.reasonLabel,
//                 message: cached.message || builtCached.message,
//                 domain: cached.domain,
//                 domainProvider: cached.domainProvider,
//                 isDisposable: !!cached.isDisposable,
//                 isFree: !!cached.isFree,
//                 isRoleBased: !!cached.isRoleBased,
//                 score: cached.score ?? 0,
//                 timestamp: cached.timestamp || new Date(),
//                 section: "bulk",
//               },
//               $currentDate: { updatedAt: true },
//             },
//             { upsert: true, new: true }
//           );
//           final = {
//             status: cached.status,
//             subStatus: cached.subStatus || null,
//             confidence:
//               typeof cached.confidence === "number" ? cached.confidence : null,
//             category: cached.category || categoryFromStatus(cached.status),
//             reason: cached.reason || builtCached.reasonLabel,
//             message: cached.message || builtCached.message,
//             timestamp: cached.timestamp || new Date(),
//             domain: cached.domain,
//             domainProvider: cached.domainProvider,
//             isDisposable: !!cached.isDisposable,
//             isFree: !!cached.isFree,
//             isRoleBased: !!cached.isRoleBased,
//             score: cached.score ?? 0,
//             section: "bulk",
//           };
//         } else {
//           const prelim = await validateSMTP(E);
//           const subStatusP = prelim.sub_status || prelim.subStatus || null;
//           const catP = prelim.category || categoryFromStatus(prelim.status);
//           if (catP !== "unknown") {
//             const builtPrelim = buildReasonAndMessage(
//               prelim.status,
//               subStatusP,
//               {
//                 isDisposable: !!prelim.isDisposable,
//                 isRoleBased: !!prelim.isRoleBased,
//                 isFree: !!prelim.isFree,
//               }
//             );
//             final = {
//               status: prelim.status,
//               subStatus: subStatusP,
//               confidence:
//                 typeof prelim.confidence === "number"
//                   ? prelim.confidence
//                   : null,
//               category: catP,
//               reason: builtPrelim.reasonLabel,
//               message: builtPrelim.message,
//               timestamp: new Date(),
//               domain: prelim.domain || extractDomain(E),
//               domainProvider: prelim.provider || "Unavailable",
//               isDisposable: !!prelim.isDisposable,
//               isFree: !!prelim.isFree,
//               isRoleBased: !!prelim.isRoleBased,
//               score: prelim.score ?? 0,
//               section: "bulk",
//             };
//             await replaceLatest(EmailLog, E, { email: E, ...final });
//             await replaceLatest(UserEmailLog, E, { email: E, ...final });
//           } else {
//             try {
//               const stable = await validateSMTPStable(E);
//               const subStatusS = stable.sub_status || stable.subStatus || null;
//               const catS = stable.category || categoryFromStatus(stable.status);
//               const builtStable = buildReasonAndMessage(
//                 stable.status,
//                 subStatusS,
//                 {
//                   isDisposable: !!stable.isDisposable,
//                   isRoleBased: !!stable.isRoleBased,
//                   isFree: !!stable.isFree,
//                 }
//               );
//               final = {
//                 status: stable.status,
//                 subStatus: subStatusS,
//                 confidence:
//                   typeof stable.confidence === "number"
//                     ? stable.confidence
//                     : null,
//                 category: catS,
//                 reason: builtStable.reasonLabel,
//                 message: builtStable.message,
//                 timestamp: new Date(),
//                 domain: stable.domain || extractDomain(E),
//                 domainProvider: stable.provider || "Unavailable",
//                 isDisposable: !!stable.isDisposable,
//                 isFree: !!stable.isFree,
//                 isRoleBased: !!stable.isRoleBased,
//                 score: stable.score ?? 0,
//                 section: "bulk",
//               };
//               await replaceLatest(EmailLog, E, { email: E, ...final });
//               await replaceLatest(UserEmailLog, E, { email: E, ...final });
//             } catch {
//               const builtUnknown = buildReasonAndMessage(
//                 "❔ Unknown",
//                 null,
//                 {}
//               );
//               final = {
//                 status: "❔ Unknown",
//                 subStatus: null,
//                 confidence: null,
//                 category: "unknown",
//                 message: builtUnknown.message,
//                 reason: builtUnknown.reasonLabel,
//                 timestamp: null,
//                 score: 0,
//                 section: "bulk",
//                 domain: extractDomain(E),
//                 domainProvider: "Unavailable",
//               };
//               await replaceLatest(EmailLog, E, { email: E, ...final });
//               await replaceLatest(UserEmailLog, E, { email: E, ...final });
//             }
//           }
//         }

//         // per-item WS status
//         try {
//           const domain = extractDomain(E);
//           let provider = mxCache.get(domain);
//           if (!provider) {
//             provider = await detectProviderByMX(domain);
//             mxCache.set(domain, provider);
//           }
//           sendStatusToFrontend(
//             E,
//             final.status || "❔ Unknown",
//             final.timestamp || null,
//             {
//               domain,
//               provider,
//               isDisposable: !!final.isDisposable,
//               isFree: !!final.isFree,
//               isRoleBased: !!final.isRoleBased,
//               score: typeof final.score === "number" ? final.score : 0,
//               subStatus: final.subStatus || null,
//               confidence:
//                 typeof final.confidence === "number" ? final.confidence : null,
//               category:
//                 final.category || categoryFromStatus(final.status || ""),
//               message: final.message,
//               reason: final.reason,
//             },
//             sessionId,
//             true,
//             username
//           );
//         } catch {}

//         const cat = categoryFromStatus(final?.status);
//         if (["valid", "invalid", "risky"].includes(cat)) billableCount++;

//         await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, cat);

//         return {
//           Email: E,
//           Status: final?.status
//             ? final.status.replace(/^[^a-zA-Z0-9]+/, "")
//             : "Unknown",
//           Timestamp: final?.timestamp
//             ? new Date(final.timestamp).toLocaleString()
//             : "N/A",
//           Domain: final?.domain || extractDomain(E),
//           Provider: final?.domainProvider || final?.provider || "Unavailable",
//           Disposable: final?.isDisposable ? "Yes" : "No",
//           Free: final?.isFree ? "Yes" : "No",
//           RoleBased: final?.isRoleBased ? "Yes" : "No",
//           Score: typeof final?.score === "number" ? final.score : 0,
//           SubStatus: final?.subStatus || "",
//           Confidence:
//             typeof final?.confidence === "number" ? final.confidence : "",
//           Category: final?.category || categoryFromStatus(final?.status || ""),
//           Message: final?.message || "",
//           Reason: final?.reason || "",
//           Source: usedCache ? "Cache" : "Live",
//         };
//       };

//       try {
//         const processed = await mapWithConcurrency(
//           rows,
//           Number(process.env.BULK_CONCURRENCY || 8),
//           worker,
//           (done, total) =>
//             sendProgressToFrontend(done, total, sessionId, username, bulkId)
//         );

//         if (billableCount > 0) {
//           await User.updateOne(
//             { username },
//             { $inc: { credits: -billableCount } }
//           );
//         }

//         // 🔢 Final per-category counts (valid/invalid/risky/unknown) for dash
//         const printable = processed.filter(Boolean);
//         const catCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
//         for (const row of printable) {
//           const k = String(row.Category || "unknown").toLowerCase();
//           if (catCounts[k] !== undefined) catCounts[k] += 1;
//           else catCounts.unknown += 1;
//         }

//         const sheet = xlsx.utils.json_to_sheet(printable);
//         const book = xlsx.utils.book_new();
//         xlsx.utils.book_append_sheet(book, sheet, "Results");

//         // write result workbook to a Buffer
//         const outBuffer = xlsx.write(book, {
//           type: "buffer",
//           bookType: "xlsx",
//         });

//         // save to GridFS
//         const saved = await saveBufferToGridFS(
//           username,
//           outBuffer,
//           `result_${bulkId}.xlsx`,
//           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//           { username, kind: "result", bulkId }
//         );

//         await UserBulkStat.updateOne(
//           { bulkId },
//           {
//             state: "done",
//             finishedAt: new Date(),
//             resultFileId: saved.id,
//             resultMime: saved.contentType,
//             resultSize: saved.length,
//           }
//         );

//         sendProgressToFrontend(total, total, sessionId, username, bulkId);

//         // 🧮 Record this job’s daily “bulk” totals once
//         try {
//           await incDashStat(
//             mongoose,
//             EmailLog,
//             RegionStat,
//             DomainReputation,
//             username,
//             { mode: "bulk", counts: { ...catCounts, requests: 1 } }
//           );
//         } catch (e) {
//           console.warn("dashstat (bulk) inc failed:", e.message);
//         }

//         // Clean just THIS job’s progress key; leave others running
//         if (sessionId)
//           setTimeout(
//             () =>
//               deps.progressStore.delete(`${username}:${sessionId}:${bulkId}`),
//             60_000
//           );

//         // Foreground path: stream the file to client
//         if (streamToRes) {
//           res.setHeader("Content-Type", saved.contentType);
//           res.setHeader(
//             "Content-Disposition",
//             `attachment; filename="validated_emails.xlsx"`
//           );
//           bucket(username).openDownloadStream(saved.id).pipe(res);
//         }
//       } catch (err) {
//         console.error("❌ /api/bulk/start:", err);
//         if (err && err.message === "CANCELED") {
//           await UserBulkStat.updateOne(
//             { bulkId },
//             { state: "canceled", finishedAt: new Date() }
//           );
//           if (streamToRes) {
//             return res.status(200).json({ ok: false, canceled: true });
//           }
//           return;
//         }
//         await UserBulkStat.updateOne(
//           { bulkId },
//           { state: "failed", error: err.message }
//         );
//         if (streamToRes) res.status(500).send("Bulk validation failed");
//       }
//     };

//     // === Background vs Foreground branching ===
//     if (noDownload) {
//       // ✅ immediate ACK so the dialog can close and the horizontal strip can start
//       res.json({ ok: true, bulkId });
//       // run the heavy work without holding the HTTP connection
//       setImmediate(() => {
//         runJob({ streamToRes: false }).catch(async (err) => {
//           console.error("Background job failed:", err);
//           try {
//             await UserBulkStat.updateOne(
//               { bulkId },
//               { state: "failed", error: err.message }
//             );
//           } catch {}
//         });
//       });
//       return;
//     }

//     // Foreground (normal) — run and stream result
//     await runJob({ streamToRes: true });
//   });

//   router.post("/attach", async (req, res) => {
//     const username = req.headers["x-user"] || req.body?.username;
//     const { bulkId, sessionId } = req.body || {};
//     if (!username || !bulkId || !sessionId)
//       return res.status(400).send("username, bulkId, sessionId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOneAndUpdate(
//       { bulkId },
//       { sessionId },
//       { new: true }
//     );
//     if (!doc) return res.status(404).send("Bulk not found");
//     return res.json({ ok: true });
//   });

//   router.get("/list", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     if (!username) return res.status(400).send("username required");

//     const states = (req.query.state || "preflight,running,done,failed,canceled")
//       .split(",")
//       .map((s) => s.trim());
//     const limit = Math.min(+req.query.limit || 50, 200);

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const docs = await UserBulkStat.find({ state: { $in: states } })
//       .sort({ createdAt: -1 })
//       .limit(limit)
//       .select(
//         "bulkId originalName state valid invalid risky unknown totalRows creditsRequired createdAt updatedAt"
//       );

//     const items = docs.map((d) => {
//       const processed =
//         (d.valid || 0) + (d.invalid || 0) + (d.risky || 0) + (d.unknown || 0);
//       const total = d.totalRows || d.creditsRequired || 0;
//       const pct =
//         total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
//       return {
//         bulkId: d.bulkId,
//         originalName: d.originalName,
//         state: d.state,
//         counts: {
//           valid: d.valid || 0,
//           invalid: d.invalid || 0,
//           risky: d.risky || 0,
//           unknown: d.unknown || 0,
//         },
//         totalRows: total,
//         progressPct: pct,
//         createdAt: d.createdAt,
//         updatedAt: d.updatedAt,
//       };
//     });

//     res.json({ items });
//   });

//   router.post("/cancel", async (req, res) => {
//     const username = req.headers["x-user"] || req.body?.username;
//     const { bulkId } = req.body || {};
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     cancelMap.set(bulkId, true);
//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     await UserBulkStat.updateOne(
//       { bulkId },
//       { state: "canceled", finishedAt: new Date() }
//     );
//     res.json({ ok: true });
//   });

//   router.delete("/:bulkId", async (req, res) => {
//     try {
//       const username = req.headers["x-user"] || req.query.username;
//       const { bulkId } = req.params;
//       const hard = (req.query.hard || "true") === "true";
//       const sessionId = String(req.query.sessionId || "");

//       if (!username || !bulkId) {
//         return res.status(400).send("username and bulkId required");
//       }

//       // get row in the correct (per-user) DB
//       const { BulkStat: UserBulkStat } = deps.getUserDb(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         BulkStat
//       );
//       const doc = await UserBulkStat.findOne({ bulkId });
//       if (!doc) return res.status(404).send("Not found");

//       // cancel & wipe progress keys (don’t block even if many keys)
//       deps.cancelMap?.set(bulkId, true);
//       for (const k of deps.progressStore.keys()) {
//         const exact = `${username}:${sessionId}:${bulkId}`;
//         if (
//           (sessionId && k === exact) ||
//           (!sessionId &&
//             k.startsWith(`${username}:`) &&
//             k.endsWith(`:${bulkId}`))
//         )
//           deps.progressStore.delete(k);
//       }

//       // 🔹 Fast path: remove the BulkStat row first, then acknowledge to client
//       await UserBulkStat.deleteOne({ _id: doc._id });
//       res.json({ ok: true }); // <-- respond immediately

//       // 🔹 Continue cleanup in background (won’t block the client)
//       setImmediate(async () => {
//         if (!hard) return; // nothing else to do
//         const b = bucket(username);

//         const safeDelete = async (rawId) => {
//           if (!rawId) return;
//           try {
//             const oid =
//               typeof rawId === "string"
//                 ? new mongoose.Types.ObjectId(rawId)
//                 : rawId;
//             const exists = await b.find({ _id: oid }).toArray();
//             if (!exists.length) return;
//             await new Promise((resolve) => b.delete(oid, () => resolve()));
//           } catch (e) {
//             // swallow; just log for diagnostics
//             console.warn(
//               "GridFS delete (background) warning:",
//               String(rawId),
//               e.message
//             );
//           }
//         };

//         await Promise.all([
//           safeDelete(doc.originalFileId),
//           safeDelete(doc.resultFileId),
//         ]);

//         // optional: notify any open UIs to close themselves
//         try {
//           if (sessionId) {
//             sendBulkStatsToFrontend(sessionId, username, {
//               type: "bulk:deleted",
//               bulkId,
//             });
//           }
//         } catch {}
//       });
//     } catch (err) {
//       console.error("❌ DELETE /api/bulk:", err);
//       return res.status(500).send("Delete failed");
//     }
//   });

//   router.get("/original", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const bulkId = req.query.bulkId;
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOne({ bulkId });
//     if (!doc || !doc.originalFileId)
//       return res.status(404).send("Original not found");

//     res.setHeader(
//       "Content-Type",
//       doc.originalMime || "application/octet-stream"
//     );
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="${doc.originalName || "uploaded.xlsx"}"`
//     );
//     const dl = bucket(username).openDownloadStream(doc.originalFileId);
//     dl.on("error", () => res.status(404).end());
//     dl.pipe(res);
//   });

//   // ───────────────────────────────────────────────────────────
//   // 3) RESULT (download by bulkId) – stream from GridFS
//   // ───────────────────────────────────────────────────────────
//   router.get("/result", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const bulkId = req.query.bulkId;
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOne({ bulkId });
//     if (!doc || !doc.resultFileId)
//       return res.status(404).send("Result not found");

//     res.setHeader("Content-Type", doc.resultMime || "application/octet-stream");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="${
//         doc.originalName
//           ? `validated_${doc.originalName}`
//           : "validated_emails.xlsx"
//       }"`
//     );
//     const dl = bucket(username).openDownloadStream(doc.resultFileId);
//     dl.on("error", () => res.status(404).end());
//     dl.pipe(res);
//   });

//   // template (unchanged except no fs)
//   router.get("/download-template", (_req, res) => {
//     const workbook = xlsx.utils.book_new();
//     const worksheet = xlsx.utils.json_to_sheet([{ Email: "" }]);
//     xlsx.utils.book_append_sheet(workbook, worksheet, "Template");
//     const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
//     res.setHeader(
//       "Content-Disposition",
//       "attachment; filename=email_template.xlsx"
//     );
//     res.setHeader(
//       "Content-Type",
//       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );
//     res.send(buffer);
//   });

//   // GET /api/bulk/history  → table-friendly list for the UI
//   router.get("/history", async (req, res) => {
//     try {
//       const username = req.headers["x-user"] || req.query.username;
//       if (!username) return res.status(400).send("username required");

//       const states = (
//         req.query.state || "preflight,running,done,failed,canceled"
//       )
//         .split(",")
//         .map((s) => s.trim());

//       const limit = Math.min(+req.query.limit || 200, 500);

//       const { BulkStat: UserBulkStat } = deps.getUserDb(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         BulkStat
//       );

//       const docs = await UserBulkStat.find({ state: { $in: states } })
//         .sort({ createdAt: -1 })
//         .limit(limit)
//         .select(
//           // keep this list tight so results are small
//           "bulkId originalName totalRows creditsRequired state " +
//             "createdAt startedAt finishedAt resultFileId"
//         )
//         .lean();

//       const items = docs.map((d) => ({
//         bulkId: d.bulkId,
//         name: d.originalName || "EnteredManually",
//         emails: d.totalRows || d.creditsRequired || 0,
//         status: d.state, // "preflight" | "running" | "done" | "failed" | "canceled"
//         createdAt: d.createdAt || null,
//         startedAt: d.startedAt || null,
//         completedAt: d.finishedAt || null,
//         canDownload: !!d.resultFileId,
//       }));

//       res.json({ items });
//     } catch (err) {
//       console.error("❌ /api/bulk/history:", err);
//       res.status(500).send("History fetch failed");
//     }
//   });

//   // progress (multi-job aware)
//   router.get("/progress", (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const sid = String(req.query.sessionId || "");
//     const bid = req.query.bulkId; // optional
//     if (!username || !sid)
//       return res
//         .status(400)
//         .json({ error: "username and sessionId are required" });

//     // If bulkId given, return that single job's progress
//     if (bid) {
//       const one = deps.progressStore.get(`${username}:${sid}:${bid}`);
//       return res.json(one || { bulkId: bid, current: 0, total: 0 });
//     }

//     // Else return all progresses for this sessionId
//     const prefix = `${username}:${sid}:`;
//     const items = [];
//     for (const [k, v] of deps.progressStore.entries()) {
//       if (k.startsWith(prefix)) items.push(v);
//     }
//     return res.json({ items });
//   });

//   return router;
// };

// ........................................................................................................................... start .......................................................

// // routes/bulkValidator.js
// const express = require("express");
// const xlsx = require("xlsx");
// const { Readable } = require("stream");
// const router = express.Router();

// // ⬇️ NEW: import mergeSMTPWithHistory from utils
// const { mergeSMTPWithHistory } = require("../utils/validator");

// module.exports = function bulkValidatorRouter(deps) {
//   const {
//     mongoose,
//     EmailLog,
//     RegionStat,
//     DomainReputation,
//     User,
//     BulkStat,
//     incDashStat,
//     categoryFromStatus,
//     normEmail,
//     buildReasonAndMessage,
//     extractDomain,
//     replaceLatest,
//     bumpUpdatedAt,
//     detectProviderByMX, // still available if you want later
//     FRESH_DB_MS,
//     validateSMTP,
//     validateSMTPStable,
//     sendProgressToFrontend,
//     sendStatusToFrontend,
//     sendBulkStatsToFrontend,
//     maybeBulkAuth,
//     getGridFSBucket,
//     cancelMap,
//   } = deps;

//   const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

//   // ---------- helpers: GridFS ----------
//   function bucket(username) {
//     const b = getGridFSBucket && getGridFSBucket(username);
//     if (!b) throw new Error("GridFS bucket not ready");
//     return b;
//   }

//   async function saveBufferToGridFS(
//     username,
//     buf,
//     filename,
//     mime,
//     metadata = {}
//   ) {
//     return new Promise((resolve, reject) => {
//       const upload = bucket(username).openUploadStream(filename, {
//         contentType: mime || "application/octet-stream",
//         metadata,
//       });
//       Readable.from(buf)
//         .pipe(upload)
//         .on("error", reject)
//         .on("finish", () =>
//           resolve({
//             id: upload.id,
//             length: upload.length,
//             filename: upload.filename,
//             contentType: upload.options.contentType,
//           })
//         );
//     });
//   }

//   async function readGridFSToBuffer(username, fileId) {
//     return new Promise((resolve, reject) => {
//       const chunks = [];
//       bucket(username)
//         .openDownloadStream(fileId)
//         .on("data", (c) => chunks.push(c))
//         .on("error", reject)
//         .on("end", () => resolve(Buffer.concat(chunks)));
//     });
//   }

//   // ---------- helpers: preflight stats ----------
//   function countPreflight(rows, emailCol) {
//     const seen = new Set();
//     let invalidFormat = 0;
//     let totalRows = 0;
//     const domains = new Set();
//     for (const r of rows) {
//       const raw = r[emailCol];
//       if (raw == null || String(raw).trim() === "") continue;
//       totalRows++;
//       const e = normEmail(String(raw));
//       if (!EMAIL_RE.test(e)) {
//         invalidFormat++;
//         continue;
//       }
//       seen.add(e);
//       const d = extractDomain(e);
//       if (d && d !== "N/A") domains.add(d);
//     }
//     const duplicates = totalRows - invalidFormat - seen.size;
//     return {
//       totalRows,
//       invalidFormat,
//       duplicates: Math.max(duplicates, 0),
//       domainsCount: domains.size,
//     };
//   }

//   // ───────────────────────────────────────────────────────────
//   // small helper: build domain/provider history for an email
//   // ───────────────────────────────────────────────────────────
//   async function buildHistoryForEmail(emailNorm) {
//     const domain = extractDomain(emailNorm);
//     if (!domain || domain === "N/A") return {};
//     const stats = await DomainReputation.findOne({ domain }).lean();
//     if (!stats || !stats.sent || stats.sent <= 0) return {};
//     const domainSamples = stats.sent;
//     const domainInvalidRate =
//       typeof stats.invalid === "number" && stats.sent > 0
//         ? stats.invalid / stats.sent
//         : null;
//     if (domainInvalidRate == null) return {};
//     return {
//       domainInvalidRate,
//       domainSamples,
//       // mirror for provider for now
//       providerInvalidRate: domainInvalidRate,
//       providerSamples: domainSamples,
//     };
//   }

//   // ───────────────────────────────────────────────────────────
//   // 1) PRE-FLIGHT
//   // ───────────────────────────────────────────────────────────
//   router.post(
//     "/preflight",
//     maybeBulkAuth,
//     deps.upload.single("file"),
//     async (req, res) => {
//       const sessionId = req.body?.sessionId || req.query?.sessionId || null;
//       const username =
//         req.headers["x-user"] || req.body?.username || req.query?.username;
//       if (!username) return res.status(400).send("Username required");
//       if (!req.file || !req.file.buffer)
//         return res.status(400).send("No file uploaded");

//       try {
//         const wb = xlsx.read(req.file.buffer, { type: "buffer" });
//         const sheetName = wb.SheetNames[0];
//         const ws = wb.Sheets[sheetName];
//         const rows = xlsx.utils.sheet_to_json(ws);
//         if (!rows.length) return res.status(400).send("Empty sheet");

//         const emailCol = Object.keys(rows[0]).find((c) =>
//           c.toLowerCase().includes("email")
//         );
//         if (!emailCol) return res.status(400).send("No email column found");

//         const stats = countPreflight(rows, emailCol);
//         const creditsRequired = stats.totalRows;

//         // credit check
//         const user = await User.findOne({ username });
//         if (!user) return res.status(404).send("User not found");
//         if ((user.credits || 0) < creditsRequired)
//           return res.status(400).send("You don't have enough credits");

//         const bulkId = require("crypto").randomUUID();
//         const original = await saveBufferToGridFS(
//           username,
//           req.file.buffer,
//           req.file.originalname || "bulk.xlsx",
//           req.file.mimetype ||
//             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//           { username, kind: "original", bulkId }
//         );

//         const { BulkStat: UserBulkStat } = deps.getUserDb(
//           mongoose,
//           EmailLog,
//           RegionStat,
//           DomainReputation,
//           username,
//           BulkStat
//         );

//         await UserBulkStat.create({
//           bulkId,
//           username,
//           sessionId,
//           originalName: req.file.originalname,
//           originalFileId: original.id,
//           originalMime: original.contentType,
//           originalSize: original.length,
//           totalRows: stats.totalRows,
//           invalidFormat: stats.invalidFormat,
//           duplicates: stats.duplicates,
//           domainsCount: stats.domainsCount,
//           creditsRequired,
//           state: "preflight",
//         });

//         if (sessionId) {
//           sendBulkStatsToFrontend(sessionId, username, {
//             bulkId,
//             phase: "preflight",
//             fileName: req.file.originalname,
//             date: new Date().toISOString(),
//             totals: stats,
//             creditsRequired,
//           });
//         }

//         res.json({
//           ok: true,
//           bulkId,
//           fileName: req.file.originalname,
//           date: new Date().toISOString(),
//           totals: stats,
//           creditsRequired,
//         });
//       } catch (err) {
//         console.error("❌ /api/bulk/preflight:", err);
//         res.status(500).send("Preflight failed");
//       }
//     }
//   );

//   // small helper to bump live counters and push WS
//   async function bumpLiveCounts(
//     UserBulkStat,
//     bulkId,
//     username,
//     sessionId,
//     cat
//   ) {
//     const inc = {};
//     if (cat === "valid") inc.valid = 1;
//     else if (cat === "invalid") inc.invalid = 1;
//     else if (cat === "risky") inc.risky = 1;
//     else inc.unknown = 1;

//     const doc = await UserBulkStat.findOneAndUpdate(
//       { bulkId },
//       { $inc: inc },
//       { new: true }
//     );
//     if (doc && sessionId) {
//       sendBulkStatsToFrontend(sessionId, username, {
//         bulkId,
//         phase: "running",
//         counts: {
//           valid: doc.valid,
//           invalid: doc.invalid,
//           risky: doc.risky,
//           unknown: doc.unknown,
//         },
//       });
//     }
//   }

//   // ───────────────────────────────────────────────────────────
//   // 2) START
//   // ───────────────────────────────────────────────────────────
//   router.post("/start", maybeBulkAuth, async (req, res) => {
//     const { bulkId, sessionId } =
//       typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
//     const username =
//       req.headers["x-user"] || req.body?.username || req.query?.username;
//     if (!username) return res.status(400).send("Username required");
//     if (!bulkId) return res.status(400).send("bulkId required");

//     const noDownload =
//       req.query.noDownload === "1" || req.body?.noDownload === true;

//     const { BulkStat: UserBulkStat, EmailLog: UserEmailLog } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );

//     const meta = await UserBulkStat.findOne({ bulkId });
//     if (!meta) return res.status(404).send("Bulk session not found");
//     if (!meta.originalFileId)
//       return res.status(400).send("Original file missing");

//     await UserBulkStat.updateOne(
//       { bulkId },
//       { state: "running", startedAt: new Date(), sessionId }
//     );

//     const runJob = async ({ streamToRes = false }) => {
//       let rows, emailCol;
//       try {
//         const origBuffer = await readGridFSToBuffer(
//           username,
//           meta.originalFileId
//         );
//         const wb = xlsx.read(origBuffer, { type: "buffer" });
//         const sheet = wb.SheetNames[0];
//         const ws = wb.Sheets[sheet];
//         rows = xlsx.utils.sheet_to_json(ws);
//         emailCol = Object.keys(rows[0] || {}).find((c) =>
//           c.toLowerCase().includes("email")
//         );
//         if (!emailCol) {
//           await UserBulkStat.updateOne(
//             { bulkId },
//             { state: "failed", error: "No email column found" }
//           );
//           if (streamToRes) res.status(400).send("No email column found");
//           return;
//         }
//         rows = rows.filter(
//           (r) => r[emailCol] != null && String(r[emailCol]).trim() !== ""
//         );
//       } catch (e) {
//         await UserBulkStat.updateOne(
//           { bulkId },
//           { state: "failed", error: "Unable to read original file" }
//         );
//         if (streamToRes) res.status(500).send("Unable to read original file");
//         return;
//       }

//       const total = rows.length;
//       sendProgressToFrontend(0, total, sessionId, username, bulkId);

//       let billableCount = 0;

//       const delay = (ms) => new Promise((r) => setTimeout(r, ms));
//       const mapWithConcurrency = async (items, limit, worker, onProgress) => {
//         let nextIndex = 0,
//           done = 0;
//         const results = new Array(items.length);
//         async function runner() {
//           while (true) {
//             if (deps.cancelMap?.get(bulkId)) break;
//             const i = nextIndex++;
//             if (i >= items.length) break;
//             try {
//               results[i] = await worker(items[i], i);
//             } catch {
//               results[i] = null;
//             } finally {
//               done++;
//               try {
//                 onProgress(done, items.length);
//               } catch {}
//               await delay(5);
//             }
//           }
//         }
//         await Promise.all(
//           Array.from(
//             { length: Math.min(limit, Math.max(1, items.length)) },
//             runner
//           )
//         );
//         return results;
//       };

//       const worker = async (row) => {
//         if (deps.cancelMap?.get(bulkId)) throw new Error("CANCELED");
//         const raw = row[emailCol];
//         if (!raw) return null;
//         const E = normEmail(raw);

//         // 🔹 NEW: logger for this email (bulk)
//         const logger = (step, message, level = "info") => {
//           console.log(
//             `[BULK][${username}][${bulkId}][${E}] ${step} (${level}): ${message}`
//           );
//         };

//         let final = null;
//         let usedCache = false;

//         // 🔹 NEW: remember what SMTP alone said
//         let smtpPrimaryCat = null;
//         let smtpStableCat = null;

//         const cached = await EmailLog.findOne({ email: E }).sort({
//           updatedAt: -1,
//           createdAt: -1,
//         });
//         const fresh = cached
//           ? Date.now() -
//               new Date(
//                 cached.updatedAt || cached.createdAt || cached.timestamp || 0
//               ).getTime() <=
//             FRESH_DB_MS
//           : false;

//         if (cached && fresh) {
//           usedCache = true;
//           const builtCached = buildReasonAndMessage(
//             cached.status,
//             cached.subStatus || null,
//             {
//               isDisposable: !!cached.isDisposable,
//               isRoleBased: !!cached.isRoleBased,
//               isFree: !!cached.isFree,
//             }
//           );
//           await bumpUpdatedAt(EmailLog, E, "bulk");
//           await UserEmailLog.findOneAndUpdate(
//             { email: E },
//             {
//               $set: {
//                 email: E,
//                 status: cached.status,
//                 subStatus: cached.subStatus || null,
//                 confidence:
//                   typeof cached.confidence === "number"
//                     ? cached.confidence
//                     : null,
//                 category: cached.category || categoryFromStatus(cached.status),
//                 reason: cached.reason || builtCached.reasonLabel,
//                 message: cached.message || builtCached.message,
//                 domain: cached.domain,
//                 domainProvider: cached.domainProvider,
//                 isDisposable: !!cached.isDisposable,
//                 isFree: !!cached.isFree,
//                 isRoleBased: !!cached.isRoleBased,
//                 score: cached.score ?? 0,
//                 timestamp: cached.timestamp || new Date(),
//                 section: "bulk",
//               },
//               $currentDate: { updatedAt: true },
//             },
//             { upsert: true, new: true }
//           );
//           final = {
//             status: cached.status,
//             subStatus: cached.subStatus || null,
//             confidence:
//               typeof cached.confidence === "number" ? cached.confidence : null,
//             category: cached.category || categoryFromStatus(cached.status),
//             reason: cached.reason || builtCached.reasonLabel,
//             message: cached.message || builtCached.message,
//             timestamp: cached.timestamp || new Date(),
//             domain: cached.domain,
//             domainProvider: cached.domainProvider,
//             isDisposable: !!cached.isDisposable,
//             isFree: !!cached.isFree,
//             isRoleBased: !!cached.isRoleBased,
//             score: cached.score ?? 0,
//             section: "bulk",
//           };
//         } else {
//           // 🔹 Prelim SMTP + history (NOW with logger + trainingTag)
//           const prelimRaw = await validateSMTP(E, {
//             logger,
//             trainingTag: "bulk",
//           });

//           // SMTP-only classification before history
//           smtpPrimaryCat =
//             prelimRaw.category || categoryFromStatus(prelimRaw.status);

//           const history = await buildHistoryForEmail(E);
//           const prelim = mergeSMTPWithHistory(prelimRaw, history, {
//             domain: prelimRaw.domain || extractDomain(E),
//             provider: prelimRaw.provider || "Unavailable",
//           });

//           const subStatusP = prelim.sub_status || prelim.subStatus || null;
//           const catP = prelim.category || categoryFromStatus(prelim.status);

//           if (catP !== "unknown") {
//             const builtPrelim = buildReasonAndMessage(
//               prelim.status,
//               subStatusP,
//               {
//                 isDisposable: !!prelim.isDisposable,
//                 isRoleBased: !!prelim.isRoleBased,
//                 isFree: !!prelim.isFree,
//               }
//             );
//             final = {
//               status: prelim.status,
//               subStatus: subStatusP,
//               confidence:
//                 typeof prelim.confidence === "number"
//                   ? prelim.confidence
//                   : null,
//               category: catP,
//               reason: builtPrelim.reasonLabel,
//               message: builtPrelim.message,
//               timestamp: new Date(),
//               domain: prelim.domain || extractDomain(E),
//               domainProvider: prelim.provider || "Unavailable",
//               isDisposable: !!prelim.isDisposable,
//               isFree: !!prelim.isFree,
//               isRoleBased: !!prelim.isRoleBased,
//               score:
//                 typeof prelim.score === "number"
//                   ? prelim.score
//                   : prelimRaw.score ?? 0,
//               section: "bulk",
//             };
//             await replaceLatest(EmailLog, E, { email: E, ...final });
//             await replaceLatest(UserEmailLog, E, { email: E, ...final });
//           } else {
//             // 🔹 Stable SMTP + history (NOW with logger + trainingTag)
//             try {
//               const stableRaw = await validateSMTPStable(E, {
//                 logger,
//                 trainingTag: "bulk",
//               });

//               // SMTP-only classification for stable result
//               smtpStableCat =
//                 stableRaw.category || categoryFromStatus(stableRaw.status);

//               const historyStable = await buildHistoryForEmail(E);
//               const stable = mergeSMTPWithHistory(stableRaw, historyStable, {
//                 domain: stableRaw.domain || extractDomain(E),
//                 provider: stableRaw.provider || "Unavailable",
//               });
//               const subStatusS = stable.sub_status || stable.subStatus || null;
//               const catS =
//                 stable.category || categoryFromStatus(stable.status);
//               const builtStable = buildReasonAndMessage(
//                 stable.status,
//                 subStatusS,
//                 {
//                   isDisposable: !!stable.isDisposable,
//                   isRoleBased: !!stable.isRoleBased,
//                   isFree: !!stable.isFree,
//                 }
//               );
//               final = {
//                 status: stable.status,
//                 subStatus: subStatusS,
//                 confidence:
//                   typeof stable.confidence === "number"
//                     ? stable.confidence
//                     : null,
//                 category: catS,
//                 reason: builtStable.reasonLabel,
//                 message: builtStable.message,
//                 timestamp: new Date(),
//                 domain: stable.domain || extractDomain(E),
//                 domainProvider: stable.provider || "Unavailable",
//                 isDisposable: !!stable.isDisposable,
//                 isFree: !!stable.isFree,
//                 isRoleBased: !!stable.isRoleBased,
//                 score:
//                   typeof stable.score === "number"
//                     ? stable.score
//                     : prelim.score ?? 0,
//                 section: "bulk",
//               };
//               await replaceLatest(EmailLog, E, { email: E, ...final });
//               await replaceLatest(UserEmailLog, E, { email: E, ...final });
//             } catch {
//               const builtUnknown = buildReasonAndMessage(
//                 "❔ Unknown",
//                 null,
//                 {}
//               );
//               final = {
//                 status: "❔ Unknown",
//                 subStatus: null,
//                 confidence: null,
//                 category: "unknown",
//                 message: builtUnknown.message,
//                 reason: builtUnknown.reasonLabel,
//                 timestamp: null,
//                 score: 0,
//                 section: "bulk",
//                 domain: extractDomain(E),
//                 domainProvider: "Unavailable",
//               };
//               await replaceLatest(EmailLog, E, { email: E, ...final });
//               await replaceLatest(UserEmailLog, E, { email: E, ...final });
//             }
//           }
//         }

//         // 🔹 NEW: enforce "Always trust SMTP Valid over history"
//         if (final) {
//           const smtpCat = smtpStableCat || smtpPrimaryCat || null;
//           const finalCat = categoryFromStatus(final.status || "");
//           if (smtpCat === "valid" && finalCat === "risky") {
//             // Promote back to Valid but keep history in reason/message/score
//             final.category = "valid";
//             final.status = "✅ Valid";
//           }
//         }

//         // per-item WS status (no more overriding provider)
//         try {
//           const domain = final.domain || extractDomain(E);
//           const provider =
//             final.domainProvider || final.provider || "Unavailable";

//           sendStatusToFrontend(
//             E,
//             final.status || "❔ Unknown",
//             final.timestamp || null,
//             {
//               domain,
//               provider,
//               isDisposable: !!final.isDisposable,
//               isFree: !!final.isFree,
//               isRoleBased: !!final.isRoleBased,
//               score: typeof final.score === "number" ? final.score : 0,
//               subStatus: final.subStatus || null,
//               confidence:
//                 typeof final.confidence === "number"
//                   ? final.confidence
//                   : null,
//               category:
//                 final.category || categoryFromStatus(final.status || ""),
//               message: final.message,
//               reason: final.reason,
//             },
//             sessionId,
//             true,
//             username
//           );
//         } catch {}

//         const cat = categoryFromStatus(final?.status);
//         if (["valid", "invalid", "risky"].includes(cat)) billableCount++;

//         await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, cat);

//         return {
//           Email: E,
//           Status: final?.status
//             ? final.status.replace(/^[^a-zA-Z0-9]+/, "")
//             : "Unknown",
//           Timestamp: final?.timestamp
//             ? new Date(final.timestamp).toLocaleString()
//             : "N/A",
//           Domain: final?.domain || extractDomain(E),
//           Provider: final?.domainProvider || final?.provider || "Unavailable",
//           Disposable: final?.isDisposable ? "Yes" : "No",
//           Free: final?.isFree ? "Yes" : "No",
//           RoleBased: final?.isRoleBased ? "Yes" : "No",
//           Score: typeof final?.score === "number" ? final.score : 0,
//           SubStatus: final?.subStatus || "",
//           Confidence:
//             typeof final?.confidence === "number" ? final.confidence : "",
//           Category:
//             final?.category || categoryFromStatus(final?.status || ""),
//           Message: final?.message || "",
//           Reason: final?.reason || "",
//           Source: usedCache ? "Cache" : "Live",
//         };
//       };

//       try {
//         const processed = await mapWithConcurrency(
//           rows,
//           Number(process.env.BULK_CONCURRENCY || 8),
//           worker,
//           (done, total) =>
//             sendProgressToFrontend(done, total, sessionId, username, bulkId)
//         );

//         if (billableCount > 0) {
//           await User.updateOne(
//             { username },
//             { $inc: { credits: -billableCount } }
//           );
//         }

//         const printable = processed.filter(Boolean);
//         const catCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
//         for (const row of printable) {
//           const k = String(row.Category || "unknown").toLowerCase();
//           if (catCounts[k] !== undefined) catCounts[k] += 1;
//           else catCounts.unknown += 1;
//         }

//         const sheet = xlsx.utils.json_to_sheet(printable);
//         const book = xlsx.utils.book_new();
//         xlsx.utils.book_append_sheet(book, sheet, "Results");

//         const outBuffer = xlsx.write(book, {
//           type: "buffer",
//           bookType: "xlsx",
//         });

//         const saved = await saveBufferToGridFS(
//           username,
//           outBuffer,
//           `result_${bulkId}.xlsx`,
//           "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//           { username, kind: "result", bulkId }
//         );

//         await UserBulkStat.updateOne(
//           { bulkId },
//           {
//             state: "done",
//             finishedAt: new Date(),
//             resultFileId: saved.id,
//             resultMime: saved.contentType,
//             resultSize: saved.length,
//           }
//         );

//         sendProgressToFrontend(total, total, sessionId, username, bulkId);

//         try {
//           await incDashStat(
//             mongoose,
//             EmailLog,
//             RegionStat,
//             DomainReputation,
//             username,
//             { mode: "bulk", counts: { ...catCounts, requests: 1 } }
//           );
//         } catch (e) {
//           console.warn("dashstat (bulk) inc failed:", e.message);
//         }

//         if (sessionId)
//           setTimeout(
//             () =>
//               deps.progressStore.delete(`${username}:${sessionId}:${bulkId}`),
//             60_000
//           );

//         if (streamToRes) {
//           res.setHeader("Content-Type", saved.contentType);
//           res.setHeader(
//             "Content-Disposition",
//             `attachment; filename="validated_emails.xlsx"`
//           );
//           bucket(username).openDownloadStream(saved.id).pipe(res);
//         }
//       } catch (err) {
//         console.error("❌ /api/bulk/start:", err);
//         if (err && err.message === "CANCELED") {
//           await UserBulkStat.updateOne(
//             { bulkId },
//             { state: "canceled", finishedAt: new Date() }
//           );
//           if (streamToRes) {
//             return res.status(200).json({ ok: false, canceled: true });
//           }
//           return;
//         }
//         await UserBulkStat.updateOne(
//           { bulkId },
//           { state: "failed", error: err.message }
//         );
//         if (streamToRes) res.status(500).send("Bulk validation failed");
//       }
//     };

//     if (noDownload) {
//       res.json({ ok: true, bulkId });
//       setImmediate(() => {
//         runJob({ streamToRes: false }).catch(async (err) => {
//           console.error("Background job failed:", err);
//           try {
//             await UserBulkStat.updateOne(
//               { bulkId },
//               { state: "failed", error: err.message }
//             );
//           } catch {}
//         });
//       });
//       return;
//     }

//     await runJob({ streamToRes: true });
//   });

//   // (rest of file unchanged)

//   router.post("/attach", async (req, res) => {
//     const username = req.headers["x-user"] || req.body?.username;
//     const { bulkId, sessionId } = req.body || {};
//     if (!username || !bulkId || !sessionId)
//       return res.status(400).send("username, bulkId, sessionId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOneAndUpdate(
//       { bulkId },
//       { sessionId },
//       { new: true }
//     );
//     if (!doc) return res.status(404).send("Bulk not found");
//     return res.json({ ok: true });
//   });

//   router.get("/list", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     if (!username) return res.status(400).send("username required");

//     const states = (req.query.state || "preflight,running,done,failed,canceled")
//       .split(",")
//       .map((s) => s.trim());
//     const limit = Math.min(+req.query.limit || 50, 200);

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const docs = await UserBulkStat.find({ state: { $in: states } })
//       .sort({ createdAt: -1 })
//       .limit(limit)
//       .select(
//         "bulkId originalName state valid invalid risky unknown totalRows creditsRequired createdAt updatedAt"
//       );

//     const items = docs.map((d) => {
//       const processed =
//         (d.valid || 0) + (d.invalid || 0) + (d.risky || 0) + (d.unknown || 0);
//       const total = d.totalRows || d.creditsRequired || 0;
//       const pct =
//         total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
//       return {
//         bulkId: d.bulkId,
//         originalName: d.originalName,
//         state: d.state,
//         counts: {
//           valid: d.valid || 0,
//           invalid: d.invalid || 0,
//           risky: d.risky || 0,
//           unknown: d.unknown || 0,
//         },
//         totalRows: total,
//         progressPct: pct,
//         createdAt: d.createdAt,
//         updatedAt: d.updatedAt,
//       };
//     });

//     res.json({ items });
//   });

//   router.post("/cancel", async (req, res) => {
//     const username = req.headers["x-user"] || req.body?.username;
//     const { bulkId } = req.body || {};
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     cancelMap.set(bulkId, true);
//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     await UserBulkStat.updateOne(
//       { bulkId },
//       { state: "canceled", finishedAt: new Date() }
//     );
//     res.json({ ok: true });
//   });

//   router.delete("/:bulkId", async (req, res) => {
//     try {
//       const username = req.headers["x-user"] || req.query.username;
//       const { bulkId } = req.params;
//       const hard = (req.query.hard || "true") === "true";
//       const sessionId = String(req.query.sessionId || "");

//       if (!username || !bulkId) {
//         return res.status(400).send("username and bulkId required");
//       }

//       const { BulkStat: UserBulkStat } = deps.getUserDb(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         BulkStat
//       );
//       const doc = await UserBulkStat.findOne({ bulkId });
//       if (!doc) return res.status(404).send("Not found");

//       deps.cancelMap?.set(bulkId, true);
//       for (const k of deps.progressStore.keys()) {
//         const exact = `${username}:${sessionId}:${bulkId}`;
//         if (
//           (sessionId && k === exact) ||
//           (!sessionId &&
//             k.startsWith(`${username}:`) &&
//             k.endsWith(`:${bulkId}`))
//         )
//           deps.progressStore.delete(k);
//       }

//       await UserBulkStat.deleteOne({ _id: doc._id });
//       res.json({ ok: true });

//       setImmediate(async () => {
//         if (!hard) return;
//         const b = bucket(username);

//         const safeDelete = async (rawId) => {
//           if (!rawId) return;
//           try {
//             const oid =
//               typeof rawId === "string"
//                 ? new mongoose.Types.ObjectId(rawId)
//                 : rawId;
//             const exists = await b.find({ _id: oid }).toArray();
//             if (!exists.length) return;
//             await new Promise((resolve) => b.delete(oid, () => resolve()));
//           } catch (e) {
//             console.warn(
//               "GridFS delete (background) warning:",
//               String(rawId),
//               e.message
//             );
//           }
//         };

//         await Promise.all([
//           safeDelete(doc.originalFileId),
//           safeDelete(doc.resultFileId),
//         ]);

//         try {
//           if (sessionId) {
//             sendBulkStatsToFrontend(sessionId, username, {
//               type: "bulk:deleted",
//               bulkId,
//             });
//           }
//         } catch {}
//       });
//     } catch (err) {
//       console.error("❌ DELETE /api/bulk:", err);
//       return res.status(500).send("Delete failed");
//     }
//   });

//   router.get("/original", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const bulkId = req.query.bulkId;
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOne({ bulkId });
//     if (!doc || !doc.originalFileId)
//       return res.status(404).send("Original not found");

//     res.setHeader(
//       "Content-Type",
//       doc.originalMime || "application/octet-stream"
//     );
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="${doc.originalName || "uploaded.xlsx"}"`
//     );
//     const dl = bucket(username).openDownloadStream(doc.originalFileId);
//     dl.on("error", () => res.status(404).end());
//     dl.pipe(res);
//   });

//   router.get("/result", async (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const bulkId = req.query.bulkId;
//     if (!username || !bulkId)
//       return res.status(400).send("username and bulkId required");

//     const { BulkStat: UserBulkStat } = deps.getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username,
//       BulkStat
//     );
//     const doc = await UserBulkStat.findOne({ bulkId });
//     if (!doc || !doc.resultFileId)
//       return res.status(404).send("Result not found");

//     res.setHeader("Content-Type", doc.resultMime || "application/octet-stream");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="${
//         doc.originalName
//           ? `validated_${doc.originalName}`
//           : "validated_emails.xlsx"
//       }"`
//     );
//     const dl = bucket(username).openDownloadStream(doc.resultFileId);
//     dl.on("error", () => res.status(404).end());
//     dl.pipe(res);
//   });

//   router.get("/download-template", (_req, res) => {
//     const workbook = xlsx.utils.book_new();
//     const worksheet = xlsx.utils.json_to_sheet([{ Email: "" }]);
//     xlsx.utils.book_append_sheet(bookwork, worksheet, "Template");
//     const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
//     res.setHeader(
//       "Content-Disposition",
//       "attachment; filename=email_template.xlsx"
//     );
//     res.setHeader(
//       "Content-Type",
//       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );
//     res.send(buffer);
//   });

//   router.get("/history", async (req, res) => {
//     try {
//       const username = req.headers["x-user"] || req.query.username;
//       if (!username) return res.status(400).send("username required");

//       const states = (
//         req.query.state || "preflight,running,done,failed,canceled"
//       )
//         .split(",")
//         .map((s) => s.trim());

//       const limit = Math.min(+req.query.limit || 200, 500);

//       const { BulkStat: UserBulkStat } = deps.getUserDb(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         BulkStat
//       );

//       const docs = await UserBulkStat.find({ state: { $in: states } })
//         .sort({ createdAt: -1 })
//         .limit(limit)
//         .select(
//           "bulkId originalName totalRows creditsRequired state createdAt startedAt finishedAt resultFileId"
//         )
//         .lean();

//       const items = docs.map((d) => ({
//         bulkId: d.bulkId,
//         name: d.originalName || "EnteredManually",
//         emails: d.totalRows || d.creditsRequired || 0,
//         status: d.state,
//         createdAt: d.createdAt || null,
//         startedAt: d.startedAt || null,
//         completedAt: d.finishedAt || null,
//         canDownload: !!d.resultFileId,
//       }));

//       res.json({ items });
//     } catch (err) {
//       console.error("❌ /api/bulk/history:", err);
//       res.status(500).send("History fetch failed");
//     }
//   });

//   router.get("/progress", (req, res) => {
//     const username = req.headers["x-user"] || req.query.username;
//     const sid = String(req.query.sessionId || "");
//     const bid = req.query.bulkId;
//     if (!username || !sid)
//       return res
//         .status(400)
//         .json({ error: "username and sessionId are required" });

//     if (bid) {
//       const one = deps.progressStore.get(`${username}:${sid}:${bid}`);
//       return res.json(one || { bulkId: bid, current: 0, total: 0 });
//     }

//     const prefix = `${username}:${sid}:`;
//     const items = [];
//     for (const [k, v] of deps.progressStore.entries()) {
//       if (k.startsWith(prefix)) items.push(v);
//     }
//     return res.json({ items });
//   });

//   return router;
// };

// .............................................................................................end ........................................................................................

// routes/bulkValidator.js
const express = require("express");
const xlsx = require("xlsx");
const xlsxStyle = require("xlsx-js-style");
const { Readable } = require("stream");
const crypto = require("crypto");
const router = express.Router();

// ⬇️ import mergeSMTPWithHistory from utils
const { mergeSMTPWithHistory } = require("../utils/validator");

module.exports = function bulkValidatorRouter(deps) {
  const {
    mongoose,
    EmailLog,
    RegionStat,
    DomainReputation,
    User,
    BulkStat,
    incDashStat,
    categoryFromStatus,
    normEmail,
    buildReasonAndMessage,
    extractDomain,
    replaceLatest,
    bumpUpdatedAt,
    detectProviderByMX, // still available if needed later
    FRESH_DB_MS,
    validateSMTP,
    validateSMTPStable,
    sendProgressToFrontend,
    sendStatusToFrontend,
    sendBulkStatsToFrontend,
    maybeBulkAuth,
    getGridFSBucket,
    cancelMap,
  } = deps;

  // NOTE: invalid-format means syntactically invalid email string
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

  // ───────────────────────────────────────────────────────────
  // GridFS helpers
  // ───────────────────────────────────────────────────────────
  function bucket(username) {
    const b = getGridFSBucket && getGridFSBucket(username);
    if (!b) throw new Error("GridFS bucket not ready");
    return b;
  }

  async function saveBufferToGridFS(
    username,
    buf,
    filename,
    mime,
    metadata = {}
  ) {
    return new Promise((resolve, reject) => {
      const upload = bucket(username).openUploadStream(filename, {
        contentType: mime || "application/octet-stream",
        metadata,
      });
      Readable.from(buf)
        .pipe(upload)
        .on("error", reject)
        .on("finish", () =>
          resolve({
            id: upload.id,
            length: upload.length,
            filename: upload.filename,
            contentType: upload.options.contentType,
          })
        );
    });
  }

  async function readGridFSToBuffer(username, fileId) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      bucket(username)
        .openDownloadStream(fileId)
        .on("data", (c) => chunks.push(c))
        .on("error", reject)
        .on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  // ───────────────────────────────────────────────────────────
  // Workbook helpers
  // ───────────────────────────────────────────────────────────
  function readWorkbookFromBuffer(buf) {
    const wb = xlsx.read(buf, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });
    return { wb, sheetName, ws, rows };
  }

  function detectEmailCol(rows) {
    if (!rows || !rows.length) return null;
    const keys = Object.keys(rows[0] || {});
    // prefer exact-ish matches first
    const best =
      keys.find((k) => String(k).trim().toLowerCase() === "email") ||
      keys.find((k) => String(k).trim().toLowerCase().includes("email"));
    return best || null;
  }

  function isRowCompletelyEmpty(row) {
    const vals = Object.values(row || {});
    if (!vals.length) return true;
    return vals.every((v) => String(v ?? "").trim() === "");
  }

  // "empty/junk rows" definition (backend):
  // - email cell empty OR missing
  // - AND either row is completely empty OR only contains blanks/spaces (safe)
  // This matches your “Remove empty / junk rows” without accidentally dropping valid non-email rows.
  function isEmptyOrJunkRow(row, emailCol) {
    if (!row) return true;
    const emailVal = String(row[emailCol] ?? "").trim();
    if (emailVal !== "") return false;
    return isRowCompletelyEmpty(row);
  }

  // ───────────────────────────────────────────────────────────
  // Analysis (preflight) for your new flow
  // ───────────────────────────────────────────────────────────
  function analyzeRows(rows, emailCol) {
    const seenValid = new Set();

    let totalRowsWithEmailCell = 0; // rows where email cell is non-empty (raw)
    let emptyOrJunk = 0;
    let invalidFormat = 0;
    let duplicates = 0;

    for (const r of rows) {
      if (isEmptyOrJunkRow(r, emailCol)) {
        emptyOrJunk++;
        continue;
      }

      const raw = String(r[emailCol] ?? "").trim();
      if (!raw) {
        // non-empty row but email cell empty (rare due to our junk definition)
        emptyOrJunk++;
        continue;
      }

      totalRowsWithEmailCell++;

      const e = normEmail(raw);
      if (!EMAIL_RE.test(e)) {
        invalidFormat++;
        continue;
      }

      if (seenValid.has(e)) {
        duplicates++;
      } else {
        seenValid.add(e);
      }
    }

    const uniqueValid = seenValid.size;

    const errorsFound = invalidFormat + duplicates + emptyOrJunk;
    const cleanupSaves = duplicates + emptyOrJunk; // invalidFormat cannot be auto-fixed

    return {
      totalRowsWithEmailCell,
      emptyOrJunk,
      invalidFormat,
      duplicates,
      uniqueValid,
      errorsFound,
      cleanupSaves,
    };
  }

  // ───────────────────────────────────────────────────────────
  // Build cleaned + fix workbooks
  // ───────────────────────────────────────────────────────────
  function buildCleanedAndFixFiles(rows, emailCol) {
    const seenValid = new Set();

    const cleanedRows = []; // only valid + unique
    const fixRows = []; // user rows (post cleanup), includes invalid-format rows
    const invalidFixRowIdx = []; // indices within fixRows that are invalid-format

    let removedDuplicates = 0;
    let removedEmptyOrJunk = 0;

    for (const r of rows) {
      if (isEmptyOrJunkRow(r, emailCol)) {
        removedEmptyOrJunk++;
        continue;
      }

      const raw = String(r[emailCol] ?? "").trim();
      if (!raw) {
        removedEmptyOrJunk++;
        continue;
      }

      const e = normEmail(raw);

      // If invalid format → keep row in FIX file as-is (no extra cols), mark to highlight
      if (!EMAIL_RE.test(e)) {
        fixRows.push({ ...r }); // keep user columns only
        invalidFixRowIdx.push(fixRows.length - 1);
        continue;
      }

      // Valid format: remove duplicates (cleanup rule)
      if (seenValid.has(e)) {
        removedDuplicates++;
        continue;
      }
      seenValid.add(e);

      // FIX file should also contain this row (user columns), but normalize email cell (optional)
      fixRows.push({ ...r, [emailCol]: e });

      // CLEANED file contains only valid+unique, normalized email
      cleanedRows.push({ ...r, [emailCol]: e });
    }

    // ---------------------------
    // Cleaned workbook (no styles needed)
    // ---------------------------
    const cleanedWb = xlsx.utils.book_new();
    const cleanedWs = xlsx.utils.json_to_sheet(
      cleanedRows.length ? cleanedRows : [{ [emailCol]: "" }]
    );
    xlsx.utils.book_append_sheet(cleanedWb, cleanedWs, "Cleaned");
    const cleanedBuf = xlsx.write(cleanedWb, {
      type: "buffer",
      bookType: "xlsx",
    });

    // ---------------------------
    // Fix workbook (FULL user sheet + highlight invalid rows)
    // Use xlsx-js-style
    // ---------------------------
    const fixWb = xlsxStyle.utils.book_new();
    const fixWs = xlsxStyle.utils.json_to_sheet(
      fixRows.length ? fixRows : [{ [emailCol]: "" }]
    );

    // highlight style
    const yellowFill = {
      fill: { patternType: "solid", fgColor: { rgb: "FFFF00" } },
    };

    // Apply yellow fill to *entire row* for each invalid row
    // json_to_sheet puts headers on row 1, so data row index i maps to Excel row (i+2)
    const range = xlsxStyle.utils.decode_range(fixWs["!ref"] || "A1:A1");

    for (const i of invalidFixRowIdx) {
      const excelRow = i + 2;
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = xlsxStyle.utils.encode_cell({ r: excelRow - 1, c }); // 0-based
        if (!fixWs[addr]) continue;
        fixWs[addr].s = yellowFill;
      }
    }

    xlsxStyle.utils.book_append_sheet(fixWb, fixWs, "Fix");
    const fixBuf = xlsxStyle.write(fixWb, { type: "buffer", bookType: "xlsx" });

    return {
      cleanedRowsCount: cleanedRows.length,
      invalidFormatCount: invalidFixRowIdx.length,
      removedDuplicates,
      removedEmptyOrJunk,
      cleanedBuf,
      fixBuf,
    };
  }

  // ───────────────────────────────────────────────────────────
  // Domain/provider history helper
  // ───────────────────────────────────────────────────────────
  async function buildHistoryForEmail(emailNorm) {
    const domain = extractDomain(emailNorm);
    if (!domain || domain === "N/A") return {};
    const stats = await DomainReputation.findOne({ domain }).lean();
    if (!stats || !stats.sent || stats.sent <= 0) return {};
    const domainSamples = stats.sent;
    const domainInvalidRate =
      typeof stats.invalid === "number" && stats.sent > 0
        ? stats.invalid / stats.sent
        : null;
    if (domainInvalidRate == null) return {};
    return {
      domainInvalidRate,
      domainSamples,
      providerInvalidRate: domainInvalidRate,
      providerSamples: domainSamples,
    };
  }

  // ───────────────────────────────────────────────────────────
  // Shared preflight logic (used by file upload + copy/paste)
  // ───────────────────────────────────────────────────────────
  async function runPreflightFromBuffer({
    username,
    sessionId,
    bulkId,
    originalName,
    buffer,
    mime,
  }) {
    const { rows } = readWorkbookFromBuffer(buffer);
    if (!rows.length) throw new Error("Empty sheet");

    const emailCol = detectEmailCol(rows);
    if (!emailCol) throw new Error("No email column found");

    const stats = analyzeRows(rows, emailCol);

    // Credits required = unique valid emails
    const creditsRequired = stats.uniqueValid;

    const user = await User.findOne({ username });
    if (!user) throw new Error("User not found");

    if ((user.credits || 0) < creditsRequired) {
      const err = new Error("You don't have enough credits");
      err.status = 400;
      throw err;
    }

    const original = await saveBufferToGridFS(
      username,
      buffer,
      originalName || "bulk.xlsx",
      mime ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { username, kind: "original", bulkId }
    );

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const state = stats.errorsFound > 0 ? "needs_cleanup" : "ready";

    await UserBulkStat.updateOne(
      { bulkId },
      {
        $setOnInsert: {
          bulkId,
          username,
          createdAt: new Date(),
        },
        $set: {
          sessionId,
          originalName,
          originalFileId: original.id,
          originalMime: original.contentType,
          originalSize: original.length,

          emailCol,
          totalRowsWithEmailCell: stats.totalRowsWithEmailCell,
          emptyOrJunk: stats.emptyOrJunk,
          invalidFormat: stats.invalidFormat,
          duplicates: stats.duplicates,
          uniqueValid: stats.uniqueValid,

          errorsFound: stats.errorsFound,
          cleanupSaves: stats.cleanupSaves,
          creditsRequired,

          state,
          phase: "preflight",
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    if (sessionId) {
      sendBulkStatsToFrontend(sessionId, username, {
        bulkId,
        phase: "preflight",
        state,
        fileName: originalName,
        date: new Date().toISOString(),
        totals: stats,
        creditsRequired,
      });
    }

    return {
      ok: true,
      bulkId,
      fileName: originalName,
      date: new Date().toISOString(),
      state,
      totals: stats,
      creditsRequired,
    };
  }

  // ───────────────────────────────────────────────────────────
  // 1) ANALYZE (PRE-FLIGHT)
  // ───────────────────────────────────────────────────────────
  router.post(
    "/preflight",
    maybeBulkAuth,
    deps.upload.single("file"),
    async (req, res) => {
      const sessionId = req.body?.sessionId || req.query?.sessionId || null;
      const username =
        req.headers["x-user"] || req.body?.username || req.query?.username;

      if (!username) return res.status(400).send("Username required");
      if (!req.file || !req.file.buffer)
        return res.status(400).send("No file uploaded");

      try {
        const clientBulkId = (req.body?.bulkId || "").trim();
        const bulkId =
          clientBulkId && /^[0-9a-fA-F-]{16,}$/.test(clientBulkId)
            ? clientBulkId
            : crypto.randomUUID();

        const payload = await runPreflightFromBuffer({
          username,
          sessionId,
          bulkId,
          originalName: req.file.originalname || "bulk.xlsx",
          buffer: req.file.buffer,
          mime:
            req.file.mimetype ||
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        return res.json(payload);
      } catch (err) {
        console.error("❌ /api/bulk/preflight:", err);
        return res
          .status(err.status || 500)
          .send(err.message || "Preflight failed");
      }
    }
  );

  // ───────────────────────────────────────────────────────────
  // 1B) PREFLIGHT FROM COPY/PASTE (TEXT)
  // ───────────────────────────────────────────────────────────
  router.post("/preflight-text", maybeBulkAuth, async (req, res) => {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const sessionId = body?.sessionId || null;
    const username =
      req.headers["x-user"] || body?.username || req.query?.username;

    if (!username) return res.status(400).send("Username required");

    const text = String(body?.text || "");
    let fileName = String(body?.fileName || "EnteredManually.xlsx").trim();

    if (!fileName) fileName = "EnteredManually.xlsx";
    if (!fileName.toLowerCase().endsWith(".xlsx")) fileName += ".xlsx";

    // parse emails from text (newline/space/comma/semicolon)
    const parts = text
      .split(/[\s,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!parts.length) return res.status(400).send("No emails provided");

    // build workbook with a single Email column
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(parts.map((e) => ({ Email: e })));
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    const clientBulkId = String(body?.bulkId || "").trim();
    const bulkId =
      clientBulkId && /^[0-9a-fA-F-]{16,}$/.test(clientBulkId)
        ? clientBulkId
        : crypto.randomUUID();

    try {
      const payload = await runPreflightFromBuffer({
        username,
        sessionId,
        bulkId,
        originalName: fileName,
        buffer,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      return res.json(payload);
    } catch (err) {
      console.error("❌ /api/bulk/preflight-text:", err);
      return res
        .status(err.status || 500)
        .send(err.message || "Preflight failed");
    }
  });

  // ───────────────────────────────────────────────────────────
  // 1.5) CLEANUP (remove duplicates + empty/junk)
  // ───────────────────────────────────────────────────────────
  router.post("/cleanup", maybeBulkAuth, async (req, res) => {
    const { bulkId, sessionId } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const username =
      req.headers["x-user"] || req.body?.username || req.query?.username;

    if (!username) return res.status(400).send("Username required");
    if (!bulkId) return res.status(400).send("bulkId required");

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const meta = await UserBulkStat.findOne({ bulkId });
    if (!meta) return res.status(404).send("Bulk session not found");
    if (!meta.originalFileId)
      return res.status(400).send("Original file missing");

    try {
      await UserBulkStat.updateOne(
        { bulkId },
        {
          $set: {
            state: "cleaning",
            phase: "cleaning",
            sessionId,
            cleanedAt: null,
          },
          $currentDate: { updatedAt: true },
        }
      );

      // read original
      const origBuffer = await readGridFSToBuffer(
        username,
        meta.originalFileId
      );
      const { rows } = readWorkbookFromBuffer(origBuffer);
      if (!rows.length) return res.status(400).send("Empty sheet");

      const emailCol = meta.emailCol || detectEmailCol(rows);
      if (!emailCol) return res.status(400).send("No email column found");

      const built = buildCleanedAndFixFiles(rows, emailCol);

      // save cleaned and fix files
      const cleanedSaved = await saveBufferToGridFS(
        username,
        built.cleanedBuf,
        `cleaned_${bulkId}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        { username, kind: "cleaned", bulkId }
      );

      const fixSaved = await saveBufferToGridFS(
        username,
        built.fixBuf,
        `fix_invalid_${bulkId}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        { username, kind: "fix_invalid", bulkId }
      );

      // re-analyze using same logic (optional but consistent)
      const analysis = analyzeRows(rows, emailCol);

      // after cleanup, ready dataset size should match cleanedRowsCount
      // creditsRequired remains uniqueValid (unchanged), but we store cleaned counts for UI
      const nextState = built.invalidFormatCount > 0 ? "needs_fix" : "ready";

      await UserBulkStat.updateOne(
        { bulkId },
        {
          $set: {
            emailCol,
            cleanedFileId: cleanedSaved.id,
            cleanedMime: cleanedSaved.contentType,
            cleanedSize: cleanedSaved.length,

            fixFileId: fixSaved.id,
            fixMime: fixSaved.contentType,
            fixSize: fixSaved.length,

            removedDuplicates: built.removedDuplicates,
            removedEmptyOrJunk: built.removedEmptyOrJunk,
            invalidFormatRemaining: built.invalidFormatCount,
            cleanedRows: built.cleanedRowsCount,

            // keep original analysis too
            totalRowsWithEmailCell: analysis.totalRowsWithEmailCell,
            emptyOrJunk: analysis.emptyOrJunk,
            invalidFormat: analysis.invalidFormat,
            duplicates: analysis.duplicates,
            uniqueValid: analysis.uniqueValid,
            errorsFound: analysis.errorsFound,
            cleanupSaves: analysis.cleanupSaves,

            state: nextState,
            phase: "cleaned",
            cleanedAt: new Date(),
            sessionId,
          },
        }
      );

      if (sessionId) {
        sendBulkStatsToFrontend(sessionId, username, {
          bulkId,
          phase: "cleaned",
          state: nextState,
          cleaned: {
            removedDuplicates: built.removedDuplicates,
            removedEmptyOrJunk: built.removedEmptyOrJunk,
            invalidFormatRemaining: built.invalidFormatCount,
            cleanedRows: built.cleanedRowsCount,
          },
        });
      }

      return res.json({
        ok: true,
        bulkId,
        state: nextState,
        removedDuplicates: built.removedDuplicates,
        removedEmptyOrJunk: built.removedEmptyOrJunk,
        invalidFormatRemaining: built.invalidFormatCount,
        cleanedRows: built.cleanedRowsCount,
        // frontend can show: "X errors removed, Y syntax errors found"
      });
    } catch (err) {
      console.error("❌ /api/bulk/cleanup:", err);
      await UserBulkStat.updateOne(
        { bulkId },
        {
          $set: { state: "failed", phase: "failed", error: err.message },
          $currentDate: { updatedAt: true },
        }
      );

      return res.status(500).send("Cleanup failed");
    }
  });

  // ───────────────────────────────────────────────────────────
  // Download "fix invalid format" file
  // ───────────────────────────────────────────────────────────
  router.get("/download-fix", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    const bulkId = req.query.bulkId;
    if (!username || !bulkId)
      return res.status(400).send("username and bulkId required");

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );
    const doc = await UserBulkStat.findOne({ bulkId });
    if (!doc || !doc.fixFileId)
      return res.status(404).send("Fix file not found");

    res.setHeader("Content-Type", doc.fixMime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fix_invalid_format_${
        doc.originalName || bulkId
      }.xlsx"`
    );

    const dl = bucket(username).openDownloadStream(doc.fixFileId);
    dl.on("error", () => res.status(404).end());
    dl.pipe(res);
  });

  // ───────────────────────────────────────────────────────────
  // helper: bump live counters + WS
  // ───────────────────────────────────────────────────────────
  async function bumpLiveCounts(
    UserBulkStat,
    bulkId,
    username,
    sessionId,
    cat
  ) {
    const inc = {};
    if (cat === "valid") inc.valid = 1;
    else if (cat === "invalid") inc.invalid = 1;
    else if (cat === "risky") inc.risky = 1;
    else inc.unknown = 1;

    const doc = await UserBulkStat.findOneAndUpdate(
      { bulkId },
      { $inc: inc },
      { new: true }
    );

    if (doc && sessionId) {
      sendBulkStatsToFrontend(sessionId, username, {
        bulkId,
        phase: "running",
        counts: {
          valid: doc.valid,
          invalid: doc.invalid,
          risky: doc.risky,
          unknown: doc.unknown,
        },
      });
    }
  }

  // ───────────────────────────────────────────────────────────
  // 2) START (VERIFY)
  // supports: skipInvalidFormat (Skip & Continue)
  // ───────────────────────────────────────────────────────────
  router.post("/start", maybeBulkAuth, async (req, res) => {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const { bulkId, sessionId, skipInvalidFormat = false } = body;

    const username =
      req.headers["x-user"] || body?.username || req.query?.username;

    if (!username) return res.status(400).send("Username required");
    if (!bulkId) return res.status(400).send("bulkId required");

    const noDownload =
      req.query.noDownload === "1" || body?.noDownload === true;

    const { BulkStat: UserBulkStat, EmailLog: UserEmailLog } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const meta = await UserBulkStat.findOne({ bulkId });
    if (!meta) return res.status(404).send("Bulk session not found");

    // enforce flow:
    // - if needs_fix -> only allow start if user chose Skip & Continue
    if (meta.state === "needs_fix" && !skipInvalidFormat) {
      return res
        .status(400)
        .send(
          "Invalid format emails exist. Download & fix or Skip & Continue."
        );
    }

    // Choose input file for validation:
    // - If cleanup happened, use cleanedFileId (best)
    // - Else use original
    const inputFileId = meta.cleanedFileId || meta.originalFileId;
    if (!inputFileId) return res.status(400).send("Input file missing");

    // await UserBulkStat.updateOne(
    //   { bulkId },
    //   {
    //     $set: {
    //       state: "running",
    //       phase: "running",
    //       sessionId,
    //       startedAt: new Date(),

    //       valid: 0,
    //       invalid: 0,
    //       risky: 0,
    //       unknown: 0,
    //     },
    //     $currentDate: { updatedAt: true },
    //   }
    // );

    const initialTotal =
      meta.uniqueValid || meta.creditsRequired || meta.cleanedRows || 0;

    await UserBulkStat.updateOne(
      { bulkId },
      {
        $set: {
          state: "running",
          phase: "running",
          sessionId,
          startedAt: new Date(),

          // ✅ IMPORTANT: persist progress immediately (so refresh/tab switch never shows "Starting…")
          progressCurrent: 0,
          progressTotal: initialTotal,

          valid: 0,
          invalid: 0,
          risky: 0,
          unknown: 0,
        },
        $currentDate: { updatedAt: true },
      }
    );

    const runJob = async ({ streamToRes = false }) => {
      let rows, emailCol;
      try {
        const inBuffer = await readGridFSToBuffer(username, inputFileId);
        const parsed = readWorkbookFromBuffer(inBuffer);
        rows = parsed.rows;
        emailCol = meta.emailCol || detectEmailCol(rows);
        if (!emailCol) {
          await UserBulkStat.updateOne(
            { bulkId },
            {
              $set: {
                state: "failed",
                phase: "failed",
                error: "No email column found",
              },
              $currentDate: { updatedAt: true },
            }
          );

          if (streamToRes) res.status(400).send("No email column found");
          return;
        }
      } catch (e) {
        await UserBulkStat.updateOne(
          { bulkId },
          {
            $set: {
              state: "failed",
              phase: "failed",
              error: "Unable to read input file",
            },
            $currentDate: { updatedAt: true },
          }
        );

        if (streamToRes) res.status(500).send("Unable to read input file");
        return;
      }

      // Build validation list:
      // - remove empty/junk
      // - remove invalid format always (they should never be validated)
      // - remove duplicates (on the fly safety)
      const seen = new Set();
      const toValidate = [];
      for (const r of rows) {
        if (isEmptyOrJunkRow(r, emailCol)) continue;

        const raw = String(r[emailCol] ?? "").trim();
        if (!raw) continue;

        const e = normEmail(raw);
        if (!EMAIL_RE.test(e)) continue; // invalid-format never validated
        if (seen.has(e)) continue;

        seen.add(e);
        toValidate.push({ row: r, email: e });
      }

      const total = toValidate.length;
      // ---- init progress (WS + DB) ----
      sendProgressToFrontend(0, total, sessionId, username, bulkId);

      // ✅ persist progress so UI doesn't reset on tab switch
      try {
        await UserBulkStat.updateOne(
          { bulkId },
          { $set: { progressCurrent: 0, progressTotal: total } }
        );
      } catch {}

      let billableCount = 0;

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      // ✅ throttle DB progress writes (avoid DB spam)
      let _lastProgressDbWrite = 0;
      const writeProgressToDbThrottled = async (current, total0) => {
        const now = Date.now();
        const shouldWrite =
          now - _lastProgressDbWrite > 350 || current >= total0;
        if (!shouldWrite) return;
        _lastProgressDbWrite = now;

        try {
          await UserBulkStat.updateOne(
            { bulkId },
            { $set: { progressCurrent: current, progressTotal: total0 } }
          );
        } catch {}
      };

      const mapWithConcurrency = async (items, limit, worker, onProgress) => {
        let nextIndex = 0,
          done = 0;
        const results = new Array(items.length);

        async function runner() {
          while (true) {
            if (deps.cancelMap?.get(bulkId)) break;
            const i = nextIndex++;
            if (i >= items.length) break;

            try {
              results[i] = await worker(items[i], i);
            } catch {
              results[i] = null;
            } finally {
              done++;

              // ✅ send to WS + persist to DB (throttled)
              try {
                onProgress(done, items.length);
              } catch {}

              try {
                await writeProgressToDbThrottled(done, items.length);
              } catch {}

              await delay(5);
            }
          }
        }

        await Promise.all(
          Array.from(
            { length: Math.min(limit, Math.max(1, items.length)) },
            runner
          )
        );

        return results;
      };

      const worker = async (item) => {
        if (deps.cancelMap?.get(bulkId)) throw new Error("CANCELED");

        const E = item.email;

        const logger = (step, message, level = "info") => {
          console.log(
            `[BULK][${username}][${bulkId}][${E}] ${step} (${level}): ${message}`
          );
        };

        let final = null;
        let usedCache = false;

        let smtpPrimaryCat = null;
        let smtpStableCat = null;

        const cached = await EmailLog.findOne({ email: E }).sort({
          updatedAt: -1,
          createdAt: -1,
        });

        const fresh = cached
          ? Date.now() -
              new Date(
                cached.updatedAt || cached.createdAt || cached.timestamp || 0
              ).getTime() <=
            FRESH_DB_MS
          : false;

        if (cached && fresh) {
          usedCache = true;
          const builtCached = buildReasonAndMessage(
            cached.status,
            cached.subStatus || null,
            {
              isDisposable: !!cached.isDisposable,
              isRoleBased: !!cached.isRoleBased,
              isFree: !!cached.isFree,
            }
          );
          await bumpUpdatedAt(EmailLog, E, "bulk");

          await UserEmailLog.findOneAndUpdate(
            { email: E },
            {
              $set: {
                email: E,
                status: cached.status,
                subStatus: cached.subStatus || null,
                confidence:
                  typeof cached.confidence === "number"
                    ? cached.confidence
                    : null,
                category: cached.category || categoryFromStatus(cached.status),
                reason: cached.reason || builtCached.reasonLabel,
                message: cached.message || builtCached.message,
                domain: cached.domain,
                domainProvider: cached.domainProvider,
                isDisposable: !!cached.isDisposable,
                isFree: !!cached.isFree,
                isRoleBased: !!cached.isRoleBased,
                score: cached.score ?? 0,
                timestamp: cached.timestamp || new Date(),
                section: "bulk",
              },
              $currentDate: { updatedAt: true },
            },
            { upsert: true, new: true }
          );

          final = {
            status: cached.status,
            subStatus: cached.subStatus || null,
            confidence:
              typeof cached.confidence === "number" ? cached.confidence : null,
            category: cached.category || categoryFromStatus(cached.status),
            reason: cached.reason || builtCached.reasonLabel,
            message: cached.message || builtCached.message,
            timestamp: cached.timestamp || new Date(),
            domain: cached.domain,
            domainProvider: cached.domainProvider,
            isDisposable: !!cached.isDisposable,
            isFree: !!cached.isFree,
            isRoleBased: !!cached.isRoleBased,
            score: cached.score ?? 0,
            section: "bulk",
          };
        } else {
          const prelimRaw = await validateSMTP(E, {
            logger,
            trainingTag: "bulk",
          });
          smtpPrimaryCat =
            prelimRaw.category || categoryFromStatus(prelimRaw.status);

          const history = await buildHistoryForEmail(E);
          const prelim = mergeSMTPWithHistory(prelimRaw, history, {
            domain: prelimRaw.domain || extractDomain(E),
            provider: prelimRaw.provider || "Unavailable",
          });

          const subStatusP = prelim.sub_status || prelim.subStatus || null;
          const catP = prelim.category || categoryFromStatus(prelim.status);

          if (catP !== "unknown") {
            const builtPrelim = buildReasonAndMessage(
              prelim.status,
              subStatusP,
              {
                isDisposable: !!prelim.isDisposable,
                isRoleBased: !!prelim.isRoleBased,
                isFree: !!prelim.isFree,
              }
            );

            final = {
              status: prelim.status,
              subStatus: subStatusP,
              confidence:
                typeof prelim.confidence === "number"
                  ? prelim.confidence
                  : null,
              category: catP,
              reason: builtPrelim.reasonLabel,
              message: builtPrelim.message,
              timestamp: new Date(),
              domain: prelim.domain || extractDomain(E),
              domainProvider: prelim.provider || "Unavailable",
              isDisposable: !!prelim.isDisposable,
              isFree: !!prelim.isFree,
              isRoleBased: !!prelim.isRoleBased,
              score:
                typeof prelim.score === "number"
                  ? prelim.score
                  : prelimRaw.score ?? 0,
              section: "bulk",
            };

            await replaceLatest(EmailLog, E, { email: E, ...final });
            await replaceLatest(UserEmailLog, E, { email: E, ...final });
          } else {
            try {
              const stableRaw = await validateSMTPStable(E, {
                logger,
                trainingTag: "bulk",
              });

              smtpStableCat =
                stableRaw.category || categoryFromStatus(stableRaw.status);

              const historyStable = await buildHistoryForEmail(E);
              const stable = mergeSMTPWithHistory(stableRaw, historyStable, {
                domain: stableRaw.domain || extractDomain(E),
                provider: stableRaw.provider || "Unavailable",
              });

              const subStatusS = stable.sub_status || stable.subStatus || null;
              const catS = stable.category || categoryFromStatus(stable.status);

              const builtStable = buildReasonAndMessage(
                stable.status,
                subStatusS,
                {
                  isDisposable: !!stable.isDisposable,
                  isRoleBased: !!stable.isRoleBased,
                  isFree: !!stable.isFree,
                }
              );

              final = {
                status: stable.status,
                subStatus: subStatusS,
                confidence:
                  typeof stable.confidence === "number"
                    ? stable.confidence
                    : null,
                category: catS,
                reason: builtStable.reasonLabel,
                message: builtStable.message,
                timestamp: new Date(),
                domain: stable.domain || extractDomain(E),
                domainProvider: stable.provider || "Unavailable",
                isDisposable: !!stable.isDisposable,
                isFree: !!stable.isFree,
                isRoleBased: !!stable.isRoleBased,
                score:
                  typeof stable.score === "number"
                    ? stable.score
                    : prelim.score ?? 0,
                section: "bulk",
              };

              await replaceLatest(EmailLog, E, { email: E, ...final });
              await replaceLatest(UserEmailLog, E, { email: E, ...final });
            } catch {
              const builtUnknown = buildReasonAndMessage(
                "❔ Unknown",
                null,
                {}
              );
              final = {
                status: "❔ Unknown",
                subStatus: null,
                confidence: null,
                category: "unknown",
                message: builtUnknown.message,
                reason: builtUnknown.reasonLabel,
                timestamp: null,
                score: 0,
                section: "bulk",
                domain: extractDomain(E),
                domainProvider: "Unavailable",
              };
              await replaceLatest(EmailLog, E, { email: E, ...final });
              await replaceLatest(UserEmailLog, E, { email: E, ...final });
            }
          }
        }

        // Always trust SMTP Valid over history downgrade to Risky
        if (final) {
          const smtpCat = smtpStableCat || smtpPrimaryCat || null;
          const finalCat = categoryFromStatus(final.status || "");
          if (smtpCat === "valid" && finalCat === "risky") {
            final.category = "valid";
            final.status = "✅ Valid";
          }
        }

        // per item WS
        try {
          const domain = final.domain || extractDomain(E);
          const provider =
            final.domainProvider || final.provider || "Unavailable";

          sendStatusToFrontend(
            E,
            final.status || "❔ Unknown",
            final.timestamp || null,
            {
              domain,
              provider,
              isDisposable: !!final.isDisposable,
              isFree: !!final.isFree,
              isRoleBased: !!final.isRoleBased,
              score: typeof final.score === "number" ? final.score : 0,
              subStatus: final.subStatus || null,
              confidence:
                typeof final.confidence === "number" ? final.confidence : null,
              category:
                final.category || categoryFromStatus(final.status || ""),
              message: final.message,
              reason: final.reason,
            },
            sessionId,
            true,
            username
          );
        } catch {}

        const cat = categoryFromStatus(final?.status);
        if (["valid", "invalid", "risky"].includes(cat)) billableCount++;

        await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, cat);

        return {
          Email: E,
          Status: final?.status
            ? final.status.replace(/^[^a-zA-Z0-9]+/, "")
            : "Unknown",
          Timestamp: final?.timestamp
            ? new Date(final.timestamp).toLocaleString()
            : "N/A",
          Domain: final?.domain || extractDomain(E),
          Provider: final?.domainProvider || final?.provider || "Unavailable",
          Disposable: final?.isDisposable ? "Yes" : "No",
          Free: final?.isFree ? "Yes" : "No",
          RoleBased: final?.isRoleBased ? "Yes" : "No",
          Score: typeof final?.score === "number" ? final.score : 0,
          SubStatus: final?.subStatus || "",
          Confidence:
            typeof final?.confidence === "number" ? final.confidence : "",
          Category: final?.category || categoryFromStatus(final?.status || ""),
          Message: final?.message || "",
          Reason: final?.reason || "",
          Source: usedCache ? "Cache" : "Live",
        };
      };

      try {
        const processed = await mapWithConcurrency(
          toValidate,
          Number(process.env.BULK_CONCURRENCY || 8),
          worker,
          (done, total0) =>
            sendProgressToFrontend(done, total0, sessionId, username, bulkId)
        );

        // Bill only for checked categories
        if (billableCount > 0) {
          await User.updateOne(
            { username },
            { $inc: { credits: -billableCount } }
          );
        }

        const printable = processed.filter(Boolean);
        const catCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
        for (const row of printable) {
          const k = String(row.Category || "unknown").toLowerCase();
          if (catCounts[k] !== undefined) catCounts[k] += 1;
          else catCounts.unknown += 1;
        }

        const sheet = xlsx.utils.json_to_sheet(printable);
        const book = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(book, sheet, "Results");

        const outBuffer = xlsx.write(book, {
          type: "buffer",
          bookType: "xlsx",
        });

        const saved = await saveBufferToGridFS(
          username,
          outBuffer,
          `result_${bulkId}.xlsx`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          { username, kind: "result", bulkId }
        );

        await UserBulkStat.updateOne(
          { bulkId },
          {
            $set: {
              state: "done",
              phase: "done",
              finishedAt: new Date(),
              resultFileId: saved.id,
              resultMime: saved.contentType,
              resultSize: saved.length,
              creditsUsed: billableCount,

              // ✅ persist final category counts
              valid: catCounts.valid,
              invalid: catCounts.invalid,
              risky: catCounts.risky,
              unknown: catCounts.unknown,

              // ✅ optional but nice: lock final progress too
              progressCurrent: total,
              progressTotal: total,
            },
            $currentDate: { updatedAt: true },
          }
        );

        if (sessionId) {
          sendBulkStatsToFrontend(sessionId, username, {
            type: "bulk:done",
            bulkId,
            state: "done",
            phase: "done",
            finishedAt: new Date().toISOString(),
            creditsUsed: billableCount,
            counts: { ...catCounts },
            canDownload: true,
          });
        }

        sendProgressToFrontend(total, total, sessionId, username, bulkId);

        try {
          await incDashStat(
            mongoose,
            EmailLog,
            RegionStat,
            DomainReputation,
            username,
            { mode: "bulk", counts: { ...catCounts, requests: 1 } }
          );
        } catch (e) {
          console.warn("dashstat (bulk) inc failed:", e.message);
        }

        if (sessionId)
          setTimeout(
            () =>
              deps.progressStore.delete(`${username}:${sessionId}:${bulkId}`),
            60_000
          );

        if (streamToRes) {
          res.setHeader("Content-Type", saved.contentType);
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="validated_emails.xlsx"`
          );
          bucket(username).openDownloadStream(saved.id).pipe(res);
        }
      } catch (err) {
        console.error("❌ /api/bulk/start:", err);

        if (err && err.message === "CANCELED") {
          await UserBulkStat.updateOne(
            { bulkId },
            {
              $set: {
                state: "canceled",
                phase: "canceled",
                finishedAt: new Date(),
              },
              $currentDate: { updatedAt: true },
            }
          );

          if (streamToRes)
            return res.status(200).json({ ok: false, canceled: true });
          return;
        }

        await UserBulkStat.updateOne(
          { bulkId },
          {
            $set: { state: "failed", phase: "failed", error: err.message },
            $currentDate: { updatedAt: true },
          }
        );

        if (streamToRes) res.status(500).send("Bulk validation failed");
      }
    };

    if (noDownload) {
      res.json({ ok: true, bulkId });
      setImmediate(() => {
        runJob({ streamToRes: false }).catch(async (err) => {
          console.error("Background job failed:", err);
          try {
            await UserBulkStat.updateOne(
              { bulkId },
              {
                $set: { state: "failed", phase: "failed", error: err.message },
                $currentDate: { updatedAt: true },
              }
            );
          } catch {}
        });
      });
      return;
    }

    await runJob({ streamToRes: true });
  });

  // ───────────────────────────────────────────────────────────
  // attach sessionId to a running job
  // ───────────────────────────────────────────────────────────
  router.post("/attach", async (req, res) => {
    const username = req.headers["x-user"] || req.body?.username;
    const { bulkId, sessionId } = req.body || {};
    if (!username || !bulkId || !sessionId)
      return res.status(400).send("username, bulkId, sessionId required");

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const doc = await UserBulkStat.findOneAndUpdate(
      { bulkId },
      { $set: { sessionId }, $currentDate: { updatedAt: true } },
      { new: true }
    );

    if (!doc) return res.status(404).send("Bulk not found");
    return res.json({ ok: true });
  });

  // ───────────────────────────────────────────────────────────
  // list
  // ───────────────────────────────────────────────────────────
  router.get("/list", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    if (!username) return res.status(400).send("username required");

    const states = (
      req.query.state ||
      "needs_cleanup,cleaning,needs_fix,ready,running,done,failed,canceled"
    )
      .split(",")
      .map((s) => s.trim());

    const limit = Math.min(+req.query.limit || 50, 200);

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    // ✅ no sessionId filter (undo)
    const docs = await UserBulkStat.find({ state: { $in: states } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select(
        [
          "bulkId",
          "originalName",
          "state",
          "phase",
          "progressCurrent",
          "progressTotal",
          "emailCol",
          "totalRowsWithEmailCell",
          "emptyOrJunk",
          "invalidFormat",
          "duplicates",
          "uniqueValid",
          "errorsFound",
          "cleanupSaves",
          "creditsRequired",
          "removedDuplicates",
          "removedEmptyOrJunk",
          "invalidFormatRemaining",
          "cleanedRows",
          "valid",
          "invalid",
          "risky",
          "unknown",
          "createdAt",
          "updatedAt",
          "startedAt",
          "finishedAt",
          "resultFileId",
          "cleanedAt",
          "creditsUsed",
        ].join(" ")
      );

    const items = docs.map((d) => {
      const processedCounts =
        (d.valid || 0) + (d.invalid || 0) + (d.risky || 0) + (d.unknown || 0);

      // ✅ prefer persisted progress (stable across tab switches)
      const processed =
        typeof d.progressCurrent === "number"
          ? d.progressCurrent
          : processedCounts;

      const total =
        typeof d.progressTotal === "number" && d.progressTotal > 0
          ? d.progressTotal
          : d.uniqueValid || d.creditsRequired || 0;

      const pct =
        total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

      return {
        bulkId: d.bulkId,
        fileName: d.originalName,
        state: d.state,
        phase: d.phase,

        totals: {
          totalRowsWithEmailCell: d.totalRowsWithEmailCell || 0,
          emptyOrJunk: d.emptyOrJunk || 0,
          invalidFormat: d.invalidFormat || 0,
          duplicates: d.duplicates || 0,
          uniqueValid: d.uniqueValid || 0,
          errorsFound: d.errorsFound || 0,
          cleanupSaves: d.cleanupSaves || 0,
        },

        cleaned: {
          removedDuplicates: d.removedDuplicates || 0,
          removedEmptyOrJunk: d.removedEmptyOrJunk || 0,
          invalidFormatRemaining: d.invalidFormatRemaining || 0,
          cleanedRows: d.cleanedRows || 0,
        },

        creditsRequired: d.creditsRequired || 0,
        creditsUsed: d.creditsUsed || 0,

        counts: {
          valid: d.valid || 0,
          invalid: d.invalid || 0,
          risky: d.risky || 0,
          unknown: d.unknown || 0,
        },

        // ✅ IMPORTANT: persist progress to frontend so it never resets on tab switch
        progressCurrent: processed,
        progressTotal: total,
        progressPct: pct,

        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        startedAt: d.startedAt,
        finishedAt: d.finishedAt,
        canDownload: !!d.resultFileId,
      };
    });

    res.json({ items });
  });

  // ───────────────────────────────────────────────────────────
  // cancel
  // ───────────────────────────────────────────────────────────
  router.post("/cancel", async (req, res) => {
    const username = req.headers["x-user"] || req.body?.username;
    const { bulkId } = req.body || {};
    if (!username || !bulkId)
      return res.status(400).send("username and bulkId required");

    cancelMap.set(bulkId, true);

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    await UserBulkStat.updateOne(
      { bulkId },
      {
        $set: { state: "canceled", phase: "canceled", finishedAt: new Date() },
        $currentDate: { updatedAt: true },
      }
    );

    res.json({ ok: true });
  });

  // ───────────────────────────────────────────────────────────
  // delete bulk session
  // ───────────────────────────────────────────────────────────
  router.delete("/:bulkId", async (req, res) => {
    try {
      const username = req.headers["x-user"] || req.query.username;
      const { bulkId } = req.params;
      const hard = (req.query.hard || "true") === "true";
      const sessionId = String(req.query.sessionId || "");

      if (!username || !bulkId) {
        return res.status(400).send("username and bulkId required");
      }

      const { BulkStat: UserBulkStat } = deps.getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
        BulkStat
      );

      const doc = await UserBulkStat.findOne({ bulkId });
      if (!doc) return res.status(404).send("Not found");

      deps.cancelMap?.set(bulkId, true);

      for (const k of deps.progressStore.keys()) {
        const exact = `${username}:${sessionId}:${bulkId}`;
        if (
          (sessionId && k === exact) ||
          (!sessionId &&
            k.startsWith(`${username}:`) &&
            k.endsWith(`:${bulkId}`))
        ) {
          deps.progressStore.delete(k);
        }
      }

      await UserBulkStat.deleteOne({ _id: doc._id });
      res.json({ ok: true });

      setImmediate(async () => {
        if (!hard) return;
        const b = bucket(username);

        const safeDelete = async (rawId) => {
          if (!rawId) return;
          try {
            const oid =
              typeof rawId === "string"
                ? new mongoose.Types.ObjectId(rawId)
                : rawId;

            const exists = await b.find({ _id: oid }).toArray();
            if (!exists.length) return;

            await new Promise((resolve) => b.delete(oid, () => resolve()));
          } catch (e) {
            console.warn("GridFS delete warning:", String(rawId), e.message);
          }
        };

        await Promise.all([
          safeDelete(doc.originalFileId),
          safeDelete(doc.cleanedFileId),
          safeDelete(doc.fixFileId),
          safeDelete(doc.resultFileId),
        ]);

        try {
          if (sessionId) {
            sendBulkStatsToFrontend(sessionId, username, {
              type: "bulk:deleted",
              bulkId,
            });
          }
        } catch {}
      });
    } catch (err) {
      console.error("❌ DELETE /api/bulk:", err);
      return res.status(500).send("Delete failed");
    }
  });

  // ───────────────────────────────────────────────────────────
  // download original
  // ───────────────────────────────────────────────────────────
  router.get("/original", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    const bulkId = req.query.bulkId;
    if (!username || !bulkId)
      return res.status(400).send("username and bulkId required");

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const doc = await UserBulkStat.findOne({ bulkId });
    if (!doc || !doc.originalFileId)
      return res.status(404).send("Original not found");

    res.setHeader(
      "Content-Type",
      doc.originalMime || "application/octet-stream"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${doc.originalName || "uploaded.xlsx"}"`
    );

    const dl = bucket(username).openDownloadStream(doc.originalFileId);
    dl.on("error", () => res.status(404).end());
    dl.pipe(res);
  });

  // ───────────────────────────────────────────────────────────
  // download result
  // ───────────────────────────────────────────────────────────
  router.get("/result", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    const bulkId = req.query.bulkId;
    if (!username || !bulkId)
      return res.status(400).send("username and bulkId required");

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    const doc = await UserBulkStat.findOne({ bulkId });
    if (!doc || !doc.resultFileId)
      return res.status(404).send("Result not found");

    res.setHeader("Content-Type", doc.resultMime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${
        doc.originalName
          ? `validated_${doc.originalName}`
          : "validated_emails.xlsx"
      }"`
    );

    const dl = bucket(username).openDownloadStream(doc.resultFileId);
    dl.on("error", () => res.status(404).end());
    dl.pipe(res);
  });

  // ───────────────────────────────────────────────────────────
  // download template
  // ───────────────────────────────────────────────────────────
  router.get("/download-template", (_req, res) => {
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet([{ Email: "" }]);
    xlsx.utils.book_append_sheet(workbook, worksheet, "Template");
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=email_template.xlsx"
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  });

  // ───────────────────────────────────────────────────────────
  // history
  // ───────────────────────────────────────────────────────────
  router.get("/history", async (req, res) => {
    try {
      const username = req.headers["x-user"] || req.query.username;
      if (!username) return res.status(400).send("username required");

      const states = (
        req.query.state ||
        "needs_cleanup,cleaning,needs_fix,ready,running,done,failed,canceled"
      )
        .split(",")
        .map((s) => s.trim());

      const limit = Math.min(+req.query.limit || 200, 500);

      const { BulkStat: UserBulkStat } = deps.getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
        BulkStat
      );

      const docs = await UserBulkStat.find({ state: { $in: states } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          "bulkId originalName uniqueValid creditsRequired state createdAt startedAt finishedAt resultFileId valid invalid risky unknown"
        )

        .lean();

      const items = docs.map((d) => ({
        bulkId: d.bulkId,
        name: d.originalName || "EnteredManually",
        emails: d.uniqueValid || d.creditsRequired || 0,
        status: d.state,
        createdAt: d.createdAt || null,
        startedAt: d.startedAt || null,
        completedAt: d.finishedAt || null,
        canDownload: !!d.resultFileId,
        valid: d.valid || 0,
        invalid: d.invalid || 0,
        risky: d.risky || 0,
        unknown: d.unknown || 0,
      }));

      res.json({ items });
    } catch (err) {
      console.error("❌ /api/bulk/history:", err);
      res.status(500).send("History fetch failed");
    }
  });

  // ───────────────────────────────────────────────────────────
  // progress
  // ───────────────────────────────────────────────────────────
  router.get("/progress", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    const sid = String(req.query.sessionId || "");
    const bid = req.query.bulkId;

    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat
    );

    // If bulkId is provided, return single job progress
    // if (bid) {
    //   // 1) try session store
    //   if (sid) {
    //     const one = deps.progressStore.get(`${username}:${sid}:${bid}`);
    //     if (
    //       one &&
    //       typeof one.current === "number" &&
    //       typeof one.total === "number"
    //     ) {
    //       return res.json(one);
    //     }
    //   }

    //   // 2) fallback to DB (lifetime solution)
    //   try {
    //     const doc = await UserBulkStat.findOne({ bulkId: bid })
    //       .select("progressCurrent progressTotal")
    //       .lean();

    //     return res.json({
    //       bulkId: bid,
    //       current: doc?.progressCurrent || 0,
    //       total: doc?.progressTotal || 0,
    //     });
    //   } catch {
    //     return res.json({ bulkId: bid, current: 0, total: 0 });
    //   }
    // }

    // If bulkId is provided, return single job progress
    if (bid) {
      let storeCurrent = 0;
      let storeTotal = 0;

      // 1) read from session store (if any)
      if (sid) {
        const one = deps.progressStore.get(`${username}:${sid}:${bid}`);
        if (
          one &&
          typeof one.current === "number" &&
          typeof one.total === "number"
        ) {
          storeCurrent = one.current || 0;
          storeTotal = one.total || 0;
        }
      }

      // 2) read from DB (source of truth across page changes)
      let dbCurrent = 0;
      let dbTotal = 0;

      try {
        const doc = await UserBulkStat.findOne({ bulkId: bid })
          .select("progressCurrent progressTotal")
          .lean();

        dbCurrent = doc?.progressCurrent || 0;
        dbTotal = doc?.progressTotal || 0;
      } catch {}

      // 3) merge: never allow regressions / empty store to override DB
      const total = Math.max(storeTotal, dbTotal, 0);
      const current = Math.min(total, Math.max(storeCurrent, dbCurrent, 0));

      return res.json({ bulkId: bid, current, total });
    }

    // If no bulkId: return all session jobs (store only)
    if (!sid) {
      return res
        .status(400)
        .json({ error: "sessionId is required when bulkId is not provided" });
    }

    const prefix = `${username}:${sid}:`;
    const items = [];
    for (const [k, v] of deps.progressStore.entries()) {
      if (k.startsWith(prefix)) items.push(v);
    }
    return res.json({ items });
  });

  return router;
};
