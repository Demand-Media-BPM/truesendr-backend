// // server.js
// require("dotenv").config();

// const express = require("express");
// const bodyParser = require("body-parser");
// const cors = require("cors");
// const helmet = require("helmet");
// const compression = require("compression");
// const http = require("http");
// const WebSocket = require("ws");
// const multer = require("multer");

// // DB / models
// const mongoose = require("mongoose");
// const EmailLog = require("./models/EmailLog");
// const RegionStat = require("./models/RegionStats");
// const DomainReputation = require("./models/DomainReputation");
// const User = require("./models/User");
// const BulkStat = require("./models/BulkStat");

// // SMTP validators now live under utils
// const { validateSMTP, validateSMTPStable } = require("./utils/smtpValidator");

// // Routers
// const authRoutes = require("./routes/auth");

// // ─────────────────────────────────────────────────────────────────────────────
// // App / HTTP / WS
// // ─────────────────────────────────────────────────────────────────────────────
// const app = express();
// const PORT = process.env.PORTSERVER || 5000;
// const server = http.createServer(app);
// const wss = new WebSocket.Server({ server });

// // ─────────────────────────────────────────────────────────────────────────────
// // 🔒 ESSENTIAL CORS FIX: short-circuit preflights with proper headers
// // (Place this IMMEDIATELY after app = express(); before any other middleware.)
// // ─────────────────────────────────────────────────────────────────────────────
// app.use((req, res, next) => {
//   const origin = req.headers.origin;

//   if (origin) {
//     // Normal CORS: echo exact origin + allow credentials
//     res.header("Access-Control-Allow-Origin", origin);
//     res.header("Access-Control-Allow-Credentials", "true");
//   } else {
//     // No Origin header (some proxies/preflights): use wildcard WITHOUT credentials
//     res.header("Access-Control-Allow-Origin", "*");
//     res.removeHeader("Access-Control-Allow-Credentials");
//   }

//   res.header("Vary", "Origin");
//   res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

//   const reqHeaders = req.header("Access-Control-Request-Headers");
//   res.header(
//     "Access-Control-Allow-Headers",
//     reqHeaders ||
//       "Content-Type, Authorization, X-User, X-Idempotency-Key, Cache-Control, Pragma, If-Modified-Since, ngrok-skip-browser-warning, X-Requested-With"
//   );
//   res.header("Access-Control-Max-Age", "86400"); // cache preflights for a day

//   if (req.method === "OPTIONS") {
//     return res.sendStatus(204);
//   }
//   next();
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Caches & runtime state
// // ─────────────────────────────────────────────────────────────────────────────
// const stableCache = new Map(); // short-lived results for single validation
// const inflight = new Map(); // de-dupe concurrent validations per email
// const CACHE_TTL_MS = +(process.env.SMTP_STABLE_CACHE_TTL_MS || 10 * 60 * 1000);

// const IDEMP_TTL_MS = +(process.env.IDEMP_TTL_MS || 15 * 60 * 1000);
// const idempoStore = new Map();

// const FRESH_DB_MS = 2 * 24 * 60 * 60 * 1000; // 48h
// const cancelMap = new Map();

// // ─────────────────────────────────────────────────────────────────────────────
// // Behavior flags
// // ─────────────────────────────────────────────────────────────────────────────
// const REQUIRE_AUTH =
//   (process.env.REQUIRE_AUTH || "false").toLowerCase() === "true";
// const BULK_REQUIRE_AUTH =
//   (process.env.BULK_REQUIRE_AUTH || "false").toLowerCase() === "true";

// /* ─────────────────────────────────────────────────────────────────────────────
//    ✅ CORS — simple, permissive, and applied EARLY to every route
//    (reflect any Origin; allow credentials; handle all preflights)
// ────────────────────────────────────────────────────────────────────────────── */
// const corsOptions = {
//   origin: (origin, cb) => cb(null, true), // reflect any origin (dev-friendly; you can tighten later)
//   credentials: true,
//   methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//   allowedHeaders: [
//     "Content-Type",
//     "Authorization",
//     "X-User",
//     "X-Idempotency-Key",
//     "Cache-Control",
//     "Pragma",
//     "If-Modified-Since",
//     "ngrok-skip-browser-warning",
//     "X-Requested-With",
//   ],
//   exposedHeaders: ["Content-Disposition"],
// };

// // vary on Origin for caches/proxies
// app.use((req, res, next) => {
//   res.header("Vary", "Origin");
//   next();
// });
// // Mirror whatever headers the browser asks for (future-proof preflights)
// app.use((req, res, next) => {
//   const reqHeaders = req.header("Access-Control-Request-Headers");
//   if (reqHeaders) res.header("Access-Control-Allow-Headers", reqHeaders);
//   res.header("Vary", "Origin");
//   // Optional: cache successful preflights to reduce noise
//   res.header("Access-Control-Max-Age", "86400");
//   next();
// });

// // Apply CORS to everything and explicitly answer preflights
// app.use(cors(corsOptions));
// app.options("*", cors(corsOptions));

// /* ─────────────────────────────────────────────────────────────────────────────
//    Never cache the two polling endpoints (history/progress)
// ────────────────────────────────────────────────────────────────────────────── */
// app.use((req, res, next) => {
//   if (
//     req.method === "GET" &&
//     /\/api\/finder\/bulk\/(history|progress)/.test(req.originalUrl)
//   ) {
//     res.setHeader(
//       "Cache-Control",
//       "no-store, no-cache, must-revalidate, proxy-revalidate"
//     );
//     res.setHeader("Pragma", "no-cache");
//     res.setHeader("Expires", "0");
//     res.setHeader("Surrogate-Control", "no-store");
//   }
//   next();
// });

// // Security / compression / parsing
// app.use(
//   helmet({
//     crossOriginResourcePolicy: { policy: "cross-origin" },
//   })
// );
// app.use(compression());
// app.use((req, res, next) => {
//   // SNS sometimes sends text/plain
//   if (req.headers["x-amz-sns-message-type"])
//     bodyParser.text({ type: "*/*" })(req, res, next);
//   else bodyParser.json()(req, res, next);
// });

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: +(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024) }, // 25MB default
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Simple Basic Auth (for server-side gating)
// // ─────────────────────────────────────────────────────────────────────────────
// const credentials = {};
// const userPerms = {};
// (process.env.FULL_USERS || "").split(",").forEach((pair) => {
//   if (!pair) return;
//   const [u, p] = pair.split(":");
//   if (!u) return;
//   credentials[u] = p || "";
//   userPerms[u] = ["single", "bulk"];
// });
// (process.env.LIMITED_USERS || "").split(",").forEach((pair) => {
//   if (!pair) return;
//   const [u, p] = pair.split(":");
//   if (!u) return;
//   credentials[u] = p || "";
//   userPerms[u] = ["single"];
// });
// function auth(req, res, next) {
//   if (!REQUIRE_AUTH) return next();
//   const h = req.headers.authorization || "";
//   if (!h.startsWith("Basic "))
//     return res.status(401).json({ error: "Auth required" });
//   const [u, p] = Buffer.from(h.split(" ")[1] || "", "base64")
//     .toString()
//     .split(":");
//   if (!u || credentials[u] !== p)
//     return res.status(401).json({ error: "Invalid credentials" });
//   req.user = u;
//   next();
// }
// const maybeBulkAuth = (req, res, next) =>
//   BULK_REQUIRE_AUTH ? auth(req, res, next) : next();

// // ─────────────────────────────────────────────────────────────────────────────
// // WebSocket: progress + live status/logs
// // ─────────────────────────────────────────────────────────────────────────────
// const clients = new Set();
// const sessionClients = new Map();
// const progressStore = new Map();

// wss.on("connection", (ws, req) => {
//   clients.add(ws);
//   try {
//     const url = new URL(req.url, `http://${req.headers.host}`);
//     const sid = url.searchParams.get("sessionId");
//     const user = url.searchParams.get("user");
//     if (sid && user) sessionClients.set(`${user}:${sid}`, ws);
//     else if (sid) sessionClients.set(sid, ws);
//   } catch {}
//   ws.on("message", (msg) => {
//     try {
//       const data = JSON.parse(msg);
//       const userField = data.user || data.username;
//       if (data.sessionId && userField)
//         sessionClients.set(`${userField}:${data.sessionId}`, ws);
//       else if (data.sessionId) sessionClients.set(data.sessionId, ws);
//     } catch {}
//   });
//   ws.on("close", () => {
//     clients.delete(ws);
//     for (const [key, sock] of sessionClients.entries())
//       if (sock === ws) sessionClients.delete(key);
//   });
// });

// // server.js
// function sendProgressToFrontend(
//   current,
//   total,
//   sessionId = null,
//   username = null,
//   bulkId = null
// ) {
//   if (!sessionId || !username) return;
//   const sessKey = `${username}:${sessionId}`;
//   const ws = sessionClients.get(sessKey) || sessionClients.get(sessionId);

//   if (bulkId) {
//     const progKey = `${username}:${sessionId}:${bulkId}`;
//     progressStore.set(progKey, { bulkId, current, total, at: Date.now() });
//   } else {
//     progressStore.set(sessKey, { current, total, at: Date.now() });
//   }

//   const payload = bulkId
//     ? JSON.stringify({ type: "progress", bulkId, current, total })
//     : JSON.stringify({ type: "progress", current, total });

//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }

// function sendLogToFrontend(
//   sessionId,
//   email,
//   message,
//   step = null,
//   level = "info",
//   username = null
// ) {
//   const payload = JSON.stringify({
//     type: "log",
//     email,
//     step,
//     level,
//     message,
//     at: new Date().toISOString(),
//   });
//   const ws =
//     (username && sessionClients.get(`${username}:${sessionId}`)) ||
//     sessionClients.get(sessionId);
//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }
// function sendStatusToFrontend(
//   email,
//   status,
//   timestamp,
//   details,
//   sessionId = null,
//   _persist = true,
//   username = null
// ) {
//   const payload = JSON.stringify({
//     type: "status",
//     email,
//     status,
//     timestamp,
//     domain: details?.domain || "N/A",
//     domainProvider: details?.provider || "N/A",
//     isDisposable: !!details?.isDisposable,
//     isFree: !!details?.isFree,
//     isRoleBased: !!details?.isRoleBased,
//     score: typeof details?.score === "number" ? details.score : 0,
//     subStatus: details?.subStatus || details?.sub_status || null,
//     confidence:
//       typeof details?.confidence === "number" ? details.confidence : null,
//     category: details?.category || "unknown",
//     message: details?.message || "",
//     reason: details?.reason || "",
//   });
//   const ws =
//     (username && sessionClients.get(`${username}:${sessionId}`)) ||
//     sessionClients.get(sessionId);
//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }

// function sendBulkStatsToFrontend(sessionId, username, payload) {
//   const key = username ? `${username}:${sessionId}` : sessionId;
//   const ws =
//     (username && sessionClients.get(key)) || sessionClients.get(sessionId);
//   const data = JSON.stringify({ type: "bulk:stats", ...payload });
//   if (ws?.readyState === WebSocket.OPEN) ws.send(data);
//   else clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
// }

// mongoose
//   .connect(process.env.MONGO_URI)
//   .then(async () => {
//     console.log("✅ Connected to MongoDB");
//   })
//   .catch((err) => console.error("❌ MongoDB error:", err));

// // build a GridFS bucket bound to the *per-user* database
// const { dbNameFromUsername } = require("./utils/validator");
// function getGridFSBucket(username) {
//   if (!username) throw new Error("getGridFSBucket: username is required");
//   const dbName = dbNameFromUsername(username);
//   const conn = mongoose.connection.useDb(dbName, { useCache: true });
//   const bucketName = process.env.GRIDFS_BUCKET || "bulkfiles";
//   return new mongoose.mongo.GridFSBucket(conn.db, { bucketName });
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Idempotency & credits
// // ─────────────────────────────────────────────────────────────────────────────
// function idempoKey(username, email, key) {
//   if (!username || !email || !key) return null;
//   return `${username}:${email}:${key}`;
// }
// function idempoGet(username, email, key) {
//   const k = idempoKey(username, email, key);
//   if (!k) return null;
//   const rec = idempoStore.get(k);
//   if (!rec) return null;
//   if (Date.now() - rec.ts > IDEMP_TTL_MS) {
//     idempoStore.delete(k);
//     return null;
//   }
//   return rec;
// }
// function idempoSet(username, email, key, creditsAfter) {
//   const k = idempoKey(username, email, key);
//   if (!k) return;
//   idempoStore.set(k, { ts: Date.now(), creditsAfter });
// }
// setInterval(() => {
//   const now = Date.now();
//   for (const [k, v] of idempoStore.entries())
//     if (now - v.ts > IDEMP_TTL_MS) idempoStore.delete(k);
// }, 60_000);

// // Shared validator helpers
// const {
//   categoryFromStatus,
//   normEmail,
//   buildReasonAndMessage,
//   extractDomain,
//   detectProviderByMX,
//   getUserDb,
//   bumpUpdatedAt,
//   replaceLatest,
//   lastTouch,
//   getFreshestFromDBs,
//   incDashStat,
// } = require("./utils/validator");

// async function debitOneCreditIfNeeded(
//   username,
//   status,
//   email = null,
//   idemKey = null,
//   mode = null // pass "single" from singleValidator.js (already done)
// ) {
//   const cat = categoryFromStatus(status);

//   // ── Unknown: don't charge, but count once for single
//   if (cat === "unknown") {
//     // Use idempotency guard to avoid double counting on retries
//     if (mode === "single") {
//       if (idemKey && email) {
//         const rec = idempoGet(username, email, idemKey);
//         if (!rec) {
//           // mark this request as handled so retries don't double count
//           const uNow = await User.findOne({ username });
//           idempoSet(username, email, idemKey, uNow?.credits ?? null);
//           try {
//             await incDashStat(
//               mongoose,
//               EmailLog,
//               RegionStat,
//               DomainReputation,
//               username,
//               { mode: "single", counts: { unknown: 1, requests: 1 } }
//             );
//           } catch (e) {
//             console.warn("dashstat (single unknown) inc failed:", e.message);
//           }
//           return uNow?.credits ?? null;
//         }
//       } else {
//         // No idempotency key: best-effort increment
//         try {
//           await incDashStat(
//             mongoose,
//             EmailLog,
//             RegionStat,
//             DomainReputation,
//             username,
//             { mode: "single", counts: { unknown: 1, requests: 1 } }
//           );
//         } catch (e) {
//           console.warn("dashstat (single unknown) inc failed:", e.message);
//         }
//       }
//     }
//     const u = await User.findOne({ username });
//     return u?.credits ?? null;
//   }

//   // ── Billable categories (valid/invalid/risky): charge once (your existing logic)
//   if (idemKey && email) {
//     const rec = idempoGet(username, email, idemKey);
//     if (rec) return rec.creditsAfter;
//   }
//   const updated = await User.findOneAndUpdate(
//     { username },
//     { $inc: { credits: -1 } },
//     { new: true }
//   );
//   const creditsAfter = updated?.credits ?? null;
//   if (idemKey && email) idempoSet(username, email, idemKey, creditsAfter);

//   // Optional: if you also want to count single billables exactly once here:
//   if (mode === "single") {
//     try {
//       await incDashStat(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         { mode: "single", counts: { [cat]: 1, requests: 1 } }
//       );
//     } catch (e) {
//       console.warn("dashstat (single billable) inc failed:", e.message);
//     }
//   }

//   return creditsAfter;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Health & user
// // ─────────────────────────────────────────────────────────────────────────────
// app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// app.get("/user/:username", async (req, res) => {
//   try {
//     const user = await User.findOne({ username: req.params.username });
//     if (!user) return res.status(404).json({ error: "User not found" });
//     res.json({ credits: user.credits });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // Auth routes (unchanged)
// app.use(authRoutes);

// // ─────────────────────────────────────────────────────────────────────────────
// /* Mount split routers (same style as authRoutes) */
// // ─────────────────────────────────────────────────────────────────────────────
// const routeDeps = {
//   // libs / models
//   mongoose,
//   EmailLog,
//   RegionStat,
//   DomainReputation,
//   User,
//   BulkStat,
//   incDashStat,
//   // utils
//   categoryFromStatus,
//   normEmail,
//   buildReasonAndMessage,
//   extractDomain,
//   getUserDb,
//   bumpUpdatedAt,
//   replaceLatest,
//   lastTouch,
//   getFreshestFromDBs,
//   detectProviderByMX,
//   // runtime config / state
//   FRESH_DB_MS,
//   CACHE_TTL_MS,
//   stableCache,
//   inflight,
//   upload,
//   getGridFSBucket,
//   progressStore,
//   cancelMap,
//   // validators
//   validateSMTP,
//   validateSMTPStable,
//   // credits / idempotency
//   debitOneCreditIfNeeded,
//   idempoGet,
//   // ws
//   sendProgressToFrontend,
//   sendLogToFrontend,
//   sendStatusToFrontend,
//   sendBulkStatsToFrontend,
//   // auth
//   maybeBulkAuth,
// };
// const dashboardRouter = require("./routes/Dashboard")(routeDeps);
// const singleValidatorRouter = require("./routes/singleValidator")(routeDeps);
// const bulkValidatorRouter = require("./routes/bulkValidator")(routeDeps);
// const EmailFinderRouter = require("./routes/EmailFinder");
// const ToxicityCheckerRouter = require("./routes/ToxicityChecker");
// const phoneValidatorRoutes = require("./routes/phoneValidator");
// const deliverabilityRoutes = require("./routes/deliverability");

// app.use("/api/single", singleValidatorRouter);
// app.use("/api/bulk", bulkValidatorRouter);
// app.use("/api/dashboard", dashboardRouter);
// app.use("/api/finder", EmailFinderRouter());
// app.use("/api/toxicity", ToxicityCheckerRouter(routeDeps));
// app.use("/api/phone", phoneValidatorRoutes);
// app.use("/api/deliverability", deliverabilityRoutes);

// // ─────────────────────────────────────────────────────────────────────────────
// // Remaining APIs (stay inline here; not related to single/bulk validator)
// // ─────────────────────────────────────────────────────────────────────────────

// // Stats per user (uses per-user DB)
// app.get("/stats", async (req, res) => {
//   try {
//     const username =
//       req.query.username || req.headers["x-user"] || req.body.username || null;
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const { EmailLog: UserEmailLog } = getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username
//     );

//     const total = await UserEmailLog.countDocuments();
//     const valid = await UserEmailLog.countDocuments({ status: /Valid/i });
//     const invalid = await UserEmailLog.countDocuments({ status: /Invalid/i });
//     const unknown = await UserEmailLog.countDocuments({ status: /Unknown/i });

//     res.json({ total, valid, invalid, unknown });
//   } catch (err) {
//     console.error("Error in /stats:", err);
//     res.status(500).json({ error: "Failed to fetch stats" });
//   }
// });

// app.get("/get-credits", async (req, res) => {
//   try {
//     const { username } = req.query;
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const user = await User.findOne({ username });
//     if (!user) return res.status(404).json({ error: "User not found" });

//     res.json({ credits: user.credits });
//   } catch (err) {
//     console.error("❌ /get-credits error:", err.message);
//     res.status(500).json({ error: "Server error" });
//   }
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // 🔒 ESSENTIAL CORS FIX: ensure even errors include CORS headers
// // (Place this AFTER all routers, BEFORE server.listen)
// // ─────────────────────────────────────────────────────────────────────────────
// app.use((err, req, res, next) => {
//   const origin = req.headers.origin;
//   if (origin) {
//     res.header("Access-Control-Allow-Origin", origin);
//     res.header("Access-Control-Allow-Credentials", "true");
//   } else {
//     res.header("Access-Control-Allow-Origin", "*");
//     res.removeHeader("Access-Control-Allow-Credentials");
//   }
//   res.header("Vary", "Origin");
//   if (res.headersSent) return next(err);
//   const status = err.status || 500;
//   res.status(status).json({ error: err.message || "Server error" });
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Start
// // ─────────────────────────────────────────────────────────────────────────────
// server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// require("dotenv").config();

// const express = require("express");
// const bodyParser = require("body-parser");
// const cors = require("cors");
// const helmet = require("helmet");
// const compression = require("compression");
// const http = require("http");
// const WebSocket = require("ws");
// const multer = require("multer");
// const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

// // DB / models
// const mongoose = require("mongoose");
// const EmailLog = require("./models/EmailLog");
// const RegionStat = require("./models/RegionStats");
// const DomainReputation = require("./models/DomainReputation");
// const ProviderReputation = require("./models/ProviderReputation"); // 👈 NEW
// const User = require("./models/User");
// const BulkStat = require("./models/BulkStat");
// const SinglePending = require("./models/SinglePending");

// // SMTP validators now live under utils
// const { validateSMTP, validateSMTPStable } = require("./utils/smtpValidator");

// // Routers
// const authRoutes = require("./routes/auth");
// const phoneValidatorRoutes = require("./routes/phoneValidator");
// const deliverabilityRoutes = require("./routes/deliverability");

// // ─────────────────────────────────────────────────────────────────────────────
// // App / HTTP / WS
// // ─────────────────────────────────────────────────────────────────────────────
// const app = express();
// const PORT = process.env.PORTSERVER || 5000;
// const server = http.createServer(app);
// const wss = new WebSocket.Server({ server });

// // ─────────────────────────────────────────────────────────────────────────────
// // 🔒 ESSENTIAL CORS FIX: short-circuit preflights with proper headers
// // (Place this IMMEDIATELY after app = express(); before any other middleware.)
// // ─────────────────────────────────────────────────────────────────────────────
// app.use((req, res, next) => {
//   const origin = req.headers.origin;

//   if (origin) {
//     // Normal CORS: echo exact origin + allow credentials
//     res.header("Access-Control-Allow-Origin", origin);
//     res.header("Access-Control-Allow-Credentials", "true");
//   } else {
//     // No Origin header (some proxies/preflights): use wildcard WITHOUT credentials
//     res.header("Access-Control-Allow-Origin", "*");
//     res.removeHeader("Access-Control-Allow-Credentials");
//   }

//   res.header("Vary", "Origin");
//   res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

//   const reqHeaders = req.header("Access-Control-Request-Headers");
//   res.header(
//     "Access-Control-Allow-Headers",
//     reqHeaders ||
//       "Content-Type, Authorization, X-User, X-Idempotency-Key, Cache-Control, Pragma, If-Modified-Since, ngrok-skip-browser-warning, X-Requested-With"
//   );
//   res.header("Access-Control-Max-Age", "86400"); // cache preflights for a day

//   if (req.method === "OPTIONS") {
//     return res.sendStatus(204);
//   }
//   next();
// });

// // ─────────────────────────────────────────────────────────────────────────────
// const stableCache = new Map(); // short-lived results for single validation
// const inflight = new Map(); // de-dupe concurrent validations per email
// const CACHE_TTL_MS = +(process.env.SMTP_STABLE_CACHE_TTL_MS || 10 * 60 * 1000);

// const IDEMP_TTL_MS = +(process.env.IDEMP_TTL_MS || 15 * 60 * 1000);
// const idempoStore = new Map();

// const FRESH_DB_MS = 2 * 24 * 60 * 60 * 1000; // 48h
// const cancelMap = new Map();

// // ─────────────────────────────────────────────────────────────────────────────
// // Behavior flags
// // ─────────────────────────────────────────────────────────────────────────────
// const REQUIRE_AUTH =
//   (process.env.REQUIRE_AUTH || "false").toLowerCase() === "true";
// const BULK_REQUIRE_AUTH =
//   (process.env.BULK_REQUIRE_AUTH || "false").toLowerCase() === "true";

// /* ─────────────────────────────────────────────────────────────────────────────
//    ✅ CORS — simple, permissive, and applied EARLY to every route
//    (reflect any Origin; allow credentials; handle all preflights)
// ────────────────────────────────────────────────────────────────────────────── */
// const corsOptions = {
//   origin: (origin, cb) => cb(null, true), // reflect any origin (dev-friendly; you can tighten later)
//   credentials: true,
//   methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//   allowedHeaders: [
//     "Content-Type",
//     "Authorization",
//     "X-User",
//     "X-Idempotency-Key",
//     "Cache-Control",
//     "Pragma",
//     "If-Modified-Since",
//     "ngrok-skip-browser-warning",
//     "X-Requested-With",
//   ],
//   exposedHeaders: ["Content-Disposition"],
// };

// // vary on Origin for caches/proxies
// app.use((req, res, next) => {
//   res.header("Vary", "Origin");
//   next();
// });
// // Mirror whatever headers the browser asks for (future-proof preflights)
// app.use((req, res, next) => {
//   const reqHeaders = req.header("Access-Control-Request-Headers");
//   if (reqHeaders) res.header("Access-Control-Allow-Headers", reqHeaders);
//   res.header("Vary", "Origin");
//   // Optional: cache successful preflights to reduce noise
//   res.header("Access-Control-Max-Age", "86400");
//   next();
// });

// // Apply CORS to everything and explicitly answer preflights
// app.use(cors(corsOptions));
// app.options("*", cors(corsOptions));

// /* ─────────────────────────────────────────────────────────────────────────────
//    Never cache the two polling endpoints (history/progress)
// ────────────────────────────────────────────────────────────────────────────── */
// app.use((req, res, next) => {
//   if (
//     req.method === "GET" &&
//     /\/api\/finder\/bulk\/(history|progress)/.test(req.originalUrl)
//   ) {
//     res.setHeader(
//       "Cache-Control",
//       "no-store, no-cache, must-revalidate, proxy-revalidate"
//     );
//     res.setHeader("Pragma", "no-cache");
//     res.setHeader("Expires", "0");
//     res.setHeader("Surrogate-Control", "no-store");
//   }
//   next();
// });

// // Security / compression / parsing
// app.use(
//   helmet({
//     crossOriginResourcePolicy: { policy: "cross-origin" },
//   })
// );
// app.use(compression());
// app.use((req, res, next) => {
//   // SNS sometimes sends text/plain
//   if (req.headers["x-amz-sns-message-type"])
//     bodyParser.text({ type: "*/*" })(req, res, next);
//   else bodyParser.json()(req, res, next);
// });

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: +(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024) }, // 25MB default
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Simple Basic Auth (for server-side gating)
// // ─────────────────────────────────────────────────────────────────────────────
// const credentials = {};
// const userPerms = {};
// (process.env.FULL_USERS || "").split(",").forEach((pair) => {
//   if (!pair) return;
//   const [u, p] = pair.split(":");
//   if (!u) return;
//   credentials[u] = p || "";
//   userPerms[u] = ["single", "bulk"];
// });
// (process.env.LIMITED_USERS || "").split(",").forEach((pair) => {
//   if (!pair) return;
//   const [u, p] = pair.split(":");
//   if (!u) return;
//   credentials[u] = p || "";
//   userPerms[u] = ["single"];
// });
// function auth(req, res, next) {
//   if (!REQUIRE_AUTH) return next();
//   const h = req.headers.authorization || "";
//   if (!h.startsWith("Basic "))
//     return res.status(401).json({ error: "Auth required" });
//   const [u, p] = Buffer.from(h.split(" ")[1] || "", "base64")
//     .toString()
//     .split(":");
//   if (!u || credentials[u] !== p)
//     return res.status(401).json({ error: "Invalid credentials" });
//   req.user = u;
//   next();
// }
// const maybeBulkAuth = (req, res, next) =>
//   BULK_REQUIRE_AUTH ? auth(req, res, next) : next();

// // ─────────────────────────────────────────────────────────────────────────────
// // WebSocket: progress + live status/logs
// // ─────────────────────────────────────────────────────────────────────────────
// const clients = new Set();
// const sessionClients = new Map();
// const progressStore = new Map();

// wss.on("connection", (ws, req) => {
//   clients.add(ws);
//   try {
//     const url = new URL(req.url, `http://${req.headers.host}`);
//     const sid = url.searchParams.get("sessionId");
//     const user = url.searchParams.get("user");
//     if (sid && user) sessionClients.set(`${user}:${sid}`, ws);
//     else if (sid) sessionClients.set(sid, ws);
//   } catch {}
//   ws.on("message", (msg) => {
//     try {
//       const data = JSON.parse(msg);
//       const userField = data.user || data.username;
//       if (data.sessionId && userField)
//         sessionClients.set(`${userField}:${data.sessionId}`, ws);
//       else if (data.sessionId) sessionClients.set(data.sessionId, ws);
//     } catch {}
//   });
//   ws.on("close", () => {
//     clients.delete(ws);
//     for (const [key, sock] of sessionClients.entries())
//       if (sock === ws) sessionClients.delete(key);
//   });
// });

// function sendProgressToFrontend(
//   current,
//   total,
//   sessionId = null,
//   username = null,
//   bulkId = null
// ) {
//   if (!sessionId || !username) return;
//   const sessKey = `${username}:${sessionId}`;
//   const ws = sessionClients.get(sessKey) || sessionClients.get(sessionId);

//   if (bulkId) {
//     const progKey = `${username}:${sessionId}:${bulkId}`;
//     progressStore.set(progKey, { bulkId, current, total, at: Date.now() });
//   } else {
//     progressStore.set(sessKey, { current, total, at: Date.now() });
//   }

//   const payload = bulkId
//     ? JSON.stringify({ type: "progress", bulkId, current, total })
//     : JSON.stringify({ type: "progress", current, total });

//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }

// function sendLogToFrontend(
//   sessionId,
//   email,
//   message,
//   step = null,
//   level = "info",
//   username = null
// ) {
//   const payload = JSON.stringify({
//     type: "log",
//     email,
//     step,
//     level,
//     message,
//     at: new Date().toISOString(),
//   });
//   const ws =
//     (username && sessionClients.get(`${username}:${sessionId}`)) ||
//     sessionClients.get(sessionId);
//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }

// function sendStatusToFrontend(
//   email,
//   status,
//   timestamp,
//   details,
//   sessionId = null,
//   _persist = true,
//   username = null
// ) {
//   const payload = JSON.stringify({
//     type: "status",
//     email,
//     status,
//     timestamp,
//     domain: details?.domain || "N/A",
//     domainProvider: details?.provider || "N/A",
//     isDisposable: !!details?.isDisposable,
//     isFree: !!details?.isFree,
//     isRoleBased: !!details?.isRoleBased,
//     score: typeof details?.score === "number" ? details.score : 0,
//     subStatus: details?.subStatus || details?.sub_status || null,
//     confidence:
//       typeof details?.confidence === "number" ? details.confidence : null,
//     category: details?.category || "unknown",
//     message: details?.message || "",
//     reason: details?.reason || "",
//   });
//   const ws =
//     (username && sessionClients.get(`${username}:${sessionId}`)) ||
//     sessionClients.get(sessionId);
//   if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
//   else
//     clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
// }

// function sendBulkStatsToFrontend(sessionId, username, payload) {
//   const key = username ? `${username}:${sessionId}` : sessionId;
//   const ws =
//     (username && sessionClients.get(key)) || sessionClients.get(sessionId);
//   const data = JSON.stringify({ type: "bulk:stats", ...payload });
//   if (ws?.readyState === WebSocket.OPEN) ws.send(data);
//   else clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // SES regions & region stats (for /send-email)
// // ─────────────────────────────────────────────────────────────────────────────
// const regions = [
//   process.env.AWS_REGION,
//   process.env.AWS_REGION_EAST2,
//   process.env.AWS_REGION_WEST1,
// ].filter(Boolean);
// let regionStats = [];

// // Connect to MongoDB and initialize region stats
// mongoose
//   .connect(process.env.MONGO_URI)
//   .then(async () => {
//     console.log("✅ Connected to MongoDB");

//     if (regions.length) {
//       const existing = await RegionStat.find({ region: { $in: regions } });
//       regionStats = regions.map(
//         (r) =>
//           existing.find((e) => e.region === r) ||
//           new RegionStat({ region: r, sent: 0, bounces: 0 })
//       );
//     }
//   })
//   .catch((err) => console.error("❌ MongoDB error:", err));

// function getBounceRate(stat) {
//   return stat.sent > 0 ? (stat.bounces / stat.sent) * 100 : 0;
// }

// function getBestRegion() {
//   const override = process.env.FORCE_SES_REGION;
//   if (override && override.trim() && override !== "null") return override;
//   for (const s of regionStats) {
//     if (getBounceRate(s) < 4.5) return s.region;
//   }
//   // fallback
//   return process.env.AWS_REGION || regions[0];
// }

// async function incrementStat(region, type) {
//   const t = regionStats.find((r) => r.region === region);
//   if (t) {
//     if (type === "sent") t.sent++;
//     if (type === "bounce") t.bounces++;
//   }
//   await RegionStat.updateOne(
//     { region },
//     { $inc: { [type]: 1 } },
//     { upsert: true }
//   );
// }

// const sesClients = new Map();
// function getSesClient(region) {
//   if (!sesClients.has(region)) {
//     const accessKeyId =
//       process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SMTP_USER;
//     const secretAccessKey =
//       process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SMTP_PASS;
//     sesClients.set(
//       region,
//       new SESClient({
//         region,
//         credentials: { accessKeyId, secretAccessKey },
//       })
//     );
//   }
//   return sesClients.get(region);
// }

// // build a GridFS bucket bound to the *per-user* database
// const { dbNameFromUsername } = require("./utils/validator");
// function getGridFSBucket(username) {
//   if (!username) throw new Error("getGridFSBucket: username is required");
//   const dbName = dbNameFromUsername(username);
//   const conn = mongoose.connection.useDb(dbName, { useCache: true });
//   const bucketName = process.env.GRIDFS_BUCKET || "bulkfiles";
//   return new mongoose.mongo.GridFSBucket(conn.db, { bucketName });
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Idempotency & credits
// // ─────────────────────────────────────────────────────────────────────────────
// function idempoKey(username, email, key) {
//   if (!username || !email || !key) return null;
//   return `${username}:${email}:${key}`;
// }
// function idempoGet(username, email, key) {
//   const k = idempoKey(username, email, key);
//   if (!k) return null;
//   const rec = idempoStore.get(k);
//   if (!rec) return null;
//   if (Date.now() - rec.ts > IDEMP_TTL_MS) {
//     idempoStore.delete(k);
//     return null;
//   }
//   return rec;
// }
// function idempoSet(username, email, key, creditsAfter) {
//   const k = idempoKey(username, email, key);
//   if (!k) return;
//   idempoStore.set(k, { ts: Date.now(), creditsAfter });
// }
// setInterval(() => {
//   const now = Date.now();
//   for (const [k, v] of idempoStore.entries())
//     if (now - v.ts > IDEMP_TTL_MS) idempoStore.delete(k);
// }, 60_000);

// // Shared validator helpers
// const {
//   categoryFromStatus,
//   normEmail,
//   buildReasonAndMessage,
//   extractDomain,
//   detectProviderByMX,
//   getUserDb,
//   bumpUpdatedAt,
//   replaceLatest,
//   lastTouch,
//   getFreshestFromDBs,
//   incDashStat,
//   normalizeStatus,
// } = require("./utils/validator");

// // ─────────────────────────────────────────────────────────────────────────────
// // Simple domain flags for /send-email reputation checks
// // ─────────────────────────────────────────────────────────────────────────────
// const disposableDomains = [
//   "mailinator.com",
//   "tempmail.com",
//   "10minutemail.com",
// ];
// const freeEmailProviders = [
//   "gmail.com",
//   "yahoo.com",
//   "outlook.com",
//   "hotmail.com",
// ];
// const roleBasedEmails = [
//   "admin",
//   "support",
//   "info",
//   "contact",
//   "help",
//   "sales",
//   "development",
// ];

// async function debitOneCreditIfNeeded(
//   username,
//   status,
//   email = null,
//   idemKey = null,
//   mode = null // pass "single" from singleValidator.js (already done)
// ) {
//   const cat = categoryFromStatus(status);

//   // ── Unknown: don't charge, but count once for single
//   if (cat === "unknown") {
//     // Use idempotency guard to avoid double counting on retries
//     if (mode === "single") {
//       if (idemKey && email) {
//         const rec = idempoGet(username, email, idemKey);
//         if (!rec) {
//           // mark this request as handled so retries don't double count
//           const uNow = await User.findOne({ username });
//           idempoSet(username, email, idemKey, uNow?.credits ?? null);
//           try {
//             await incDashStat(
//               mongoose,
//               EmailLog,
//               RegionStat,
//               DomainReputation,
//               username,
//               { mode: "single", counts: { unknown: 1, requests: 1 } }
//             );
//           } catch (e) {
//             console.warn("dashstat (single unknown) inc failed:", e.message);
//           }
//           return uNow?.credits ?? null;
//         }
//       } else {
//         // No idempotency key: best-effort increment
//         try {
//           await incDashStat(
//             mongoose,
//             EmailLog,
//             RegionStat,
//             DomainReputation,
//             username,
//             { mode: "single", counts: { unknown: 1, requests: 1 } }
//           );
//         } catch (e) {
//           console.warn("dashstat (single unknown) inc failed:", e.message);
//         }
//       }
//     }
//     const u = await User.findOne({ username });
//     return u?.credits ?? null;
//   }

//   // ── Billable categories (valid/invalid/risky): charge once (your existing logic)
//   if (idemKey && email) {
//     const rec = idempoGet(username, email, idemKey);
//     if (rec) return rec.creditsAfter;
//   }
//   const updated = await User.findOneAndUpdate(
//     { username },
//     { $inc: { credits: -1 } },
//     { new: true }
//   );
//   const creditsAfter = updated?.credits ?? null;
//   if (idemKey && email) idempoSet(username, email, idemKey, creditsAfter);

//   // Optional: if you also want to count single billables exactly once here:
//   if (mode === "single") {
//     try {
//       await incDashStat(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         { mode: "single", counts: { [cat]: 1, requests: 1 } }
//       );
//     } catch (e) {
//       console.warn("dashstat (single billable) inc failed:", e.message);
//     }
//   }

//   return creditsAfter;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Health & user
// // ─────────────────────────────────────────────────────────────────────────────
// app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// app.get("/user/:username", async (req, res) => {
//   try {
//     const user = await User.findOne({ username: req.params.username });
//     if (!user) return res.status(404).json({ error: "User not found" });
//     res.json({ credits: user.credits });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // Auth routes (unchanged)
// app.use(authRoutes);

// // ─────────────────────────────────────────────────────────────────────────────
// /* Mount split routers (same style as authRoutes) */
// // ─────────────────────────────────────────────────────────────────────────────
// const routeDeps = {
//   // libs / models
//   mongoose,
//   EmailLog,
//   RegionStat,
//   DomainReputation,
//   ProviderReputation, // 👈 NEW in deps (for later use)
//   User,
//   BulkStat,
//   SinglePending,
//   incDashStat,
//   // utils
//   categoryFromStatus,
//   normEmail,
//   buildReasonAndMessage,
//   extractDomain,
//   getUserDb,
//   bumpUpdatedAt,
//   replaceLatest,
//   lastTouch,
//   getFreshestFromDBs,
//   detectProviderByMX,
//   // runtime config / state
//   FRESH_DB_MS,
//   CACHE_TTL_MS,
//   stableCache,
//   inflight,
//   upload,
//   getGridFSBucket,
//   progressStore,
//   cancelMap,
//   // validators
//   validateSMTP,
//   validateSMTPStable,
//   // credits / idempotency
//   debitOneCreditIfNeeded,
//   idempoGet,
//   // ws
//   sendProgressToFrontend,
//   sendLogToFrontend,
//   sendStatusToFrontend,
//   sendBulkStatsToFrontend,
//   // auth
//   maybeBulkAuth,
// };

// const dashboardRouter = require("./routes/Dashboard")(routeDeps);
// const singleValidatorRouter = require("./routes/singleValidator")(routeDeps);
// const bulkValidatorRouter = require("./routes/bulkValidator")(routeDeps);
// const EmailFinderRouter = require("./routes/EmailFinder");
// const ToxicityCheckerRouter = require("./routes/ToxicityChecker")(routeDeps);
// const FileCleanerRouter = require("./routes/fileCleaner")

// // 🆕 NEW: Training / dataset routes (Bouncer import, domain stats)
// const TrainingRouter = require("./routes/training")(routeDeps);

// app.use("/api/single", singleValidatorRouter);
// app.use("/api/bulk", bulkValidatorRouter);
// app.use("/api/dashboard", dashboardRouter);
// app.use("/api/finder", EmailFinderRouter());
// app.use("/api/toxicity", ToxicityCheckerRouter);
// app.use("/api/training", TrainingRouter);
// app.use("/api/phone", phoneValidatorRoutes);
// app.use("/api/deliverability", deliverabilityRoutes);
// app.use("/api/file-cleaner", FileCleanerRouter);

// // ─────────────────────────────────────────────────────────────────────────────
// // Remaining APIs (stay inline here; not related to single/bulk validator)
// // ─────────────────────────────────────────────────────────────────────────────

// // Stats per user (uses per-user DB)
// app.get("/stats", async (req, res) => {
//   try {
//     const username =
//       req.query.username || req.headers["x-user"] || req.body.username || null;
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const { EmailLog: UserEmailLog } = getUserDb(
//       mongoose,
//       EmailLog,
//       RegionStat,
//       DomainReputation,
//       username
//     );

//     const total = await UserEmailLog.countDocuments();
//     const valid = await UserEmailLog.countDocuments({ status: /Valid/i });
//     const invalid = await UserEmailLog.countDocuments({
//       status: /Invalid/i,
//     });
//     const unknown = await UserEmailLog.countDocuments({
//       status: /Unknown/i,
//     });

//     res.json({ total, valid, invalid, unknown });
//   } catch (err) {
//     console.error("Error in /stats:", err);
//     res.status(500).json({ error: "Failed to fetch stats" });
//   }
// });

// app.get("/get-credits", async (req, res) => {
//   try {
//     const { username } = req.query;
//     if (!username)
//       return res.status(400).json({ error: "Username is required" });

//     const user = await User.findOne({ username });
//     if (!user) return res.status(404).json({ error: "User not found" });

//     res.json({ credits: user.credits });
//   } catch (err) {
//     console.error("❌ /get-credits error:", err.message);
//     res.status(500).json({ error: "Server error" });
//   }
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Send email (SES) with SMTP pre-check & domain reputation guard
// // (ported from old server.js, adapted to new WS + helpers)
// // ─────────────────────────────────────────────────────────────────────────────
// app.post("/send-email", auth, async (req, res) => {
//   try {
//     const { email, sessionId } =
//       typeof req.body === "string" ? JSON.parse(req.body) : req.body;

//     if (!email) return res.status(400).json({ error: "Email is required" });

//     const logger = (step, message, level = "info") =>
//       sendLogToFrontend(sessionId, email, message, step, level);

//     const domain = extractDomain(email);

//     // Domain reputation short-circuit
//     const domainStats = await DomainReputation.findOne({ domain });
//     if (domainStats && domainStats.sent >= 5) {
//       const bounceRate = domainStats.invalid / domainStats.sent;
//       if (bounceRate >= 0.6) {
//         const provider = await detectProviderByMX(domain);
//         sendStatusToFrontend(
//           email,
//           "⚠️ Risky (High Bounce Domain)",
//           null,
//           {
//             domain,
//             provider,
//             isDisposable: disposableDomains.includes(domain),
//             isFree: freeEmailProviders.includes(domain),
//             isRoleBased: roleBasedEmails.includes(
//               (email.split("@")[0] || "").toLowerCase()
//             ),
//           },
//           sessionId
//         );
//         logger(
//           "reputation",
//           `Blocked by domain reputation (bounceRate=${(bounceRate * 100).toFixed(
//             1
//           )}%)`,
//           "warn"
//         );
//         return res
//           .status(200)
//           .json({ skipped: true, reason: "High bounce domain" });
//       }
//     }

//     // Cached result reuse
//     const cached = await EmailLog.findOne({ email }).sort({ createdAt: -1 });
//     if (cached) {
//       const ageMs = Date.now() - new Date(cached.createdAt).getTime();
//       const isFresh = ageMs < 10 * 24 * 60 * 60 * 1000; // 10 days
//       const isValidType =
//         cached.status.includes("✅") ||
//         cached.status.includes("⚠️") ||
//         cached.status.includes("Unknown");
//       if ((isValidType && isFresh) || cached.status.includes("❌")) {
//         sendStatusToFrontend(
//           email,
//           cached.status,
//           cached.timestamp,
//           {
//             domain: cached.domain,
//             provider: cached.domainProvider,
//             isDisposable: cached.isDisposable,
//             isFree: cached.isFree,
//             isRoleBased: cached.isRoleBased,
//           },
//           sessionId
//         );
//         logger("cache", `Reused cached result: ${cached.status}`);
//         return res.json({ success: true, cached: true });
//       }
//     }

//     // SMTP pre-check
//     logger("start", "Starting SMTP validation (pre-check)");
//     const smtpResult = await validateSMTP(email, { logger });
//     logger(
//       "smtp_result",
//       `SMTP pre-check: ${smtpResult.category} (${smtpResult.sub_status || "n/a"})`
//     );

//     if (smtpResult.category === "invalid") {
//       // Undeliverable → don't send
//       sendStatusToFrontend(
//         email,
//         smtpResult.status,
//         null,
//         {
//           domain: smtpResult.domain,
//           provider: smtpResult.provider,
//           isDisposable: smtpResult.isDisposable,
//           isFree: smtpResult.isFree,
//           isRoleBased: smtpResult.isRoleBased,
//         },
//         sessionId
//       );
//       logger("done", "Pre-check says undeliverable → not sending");
//       return res.status(200).json({ skipped: true, reason: "SMTP invalid" });
//     }

//     if (smtpResult.category === "risky") {
//       // Risky: only send if we’ve never tried this address before
//       const previouslySent = await EmailLog.findOne({ email });
//       if (previouslySent) {
//         sendStatusToFrontend(
//           email,
//           smtpResult.status,
//           null,
//           {
//             domain: smtpResult.domain,
//             provider: smtpResult.provider,
//             isDisposable: smtpResult.isDisposable,
//             isFree: smtpResult.isFree,
//             isRoleBased: smtpResult.isRoleBased,
//           },
//           sessionId
//         );
//         logger("done", "Pre-check risky & previously tried → not sending");
//         return res
//           .status(200)
//           .json({ skipped: true, reason: "SMTP risky (already tried)" });
//       }
//       logger(
//         "info",
//         "Pre-check risky but first time → sending once via SES (one-shot)",
//         "warn"
//       );
//     }

//     // Choose SES region & send
//     const region = getBestRegion();
//     const ses = getSesClient(region);

//     const params = {
//       Source: process.env.VERIFIED_EMAIL,
//       Destination: { ToAddresses: [email] },
//       Message: {
//         Subject: { Data: "Hope this finds you well" },
//         Body: {
//           Text: {
//             Data: `Hey there!

// Just wanted to say a quick hello and check if everything’s going smoothly.
// Feel free to get in touch anytime — we’re always here to help.

// Warm wishes,
// Jenny
// Team TrueSendr`,
//           },
//         },
//       },
//       Tags: [{ Name: "region", Value: region }],
//     };

//     await ses.send(new SendEmailCommand(params));
//     await incrementStat(region, "sent");
//     logger("ses_sent", `Sent via SES region ${region}`);

//     return res.json({ success: true });
//   } catch (err) {
//     console.error("❌ Error in /send-email:", err.message);
//     return res.status(500).json({ error: err.message });
//   }
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // 🔒 ESSENTIAL CORS FIX: ensure even errors include CORS headers
// // (Place this AFTER all routers, BEFORE server.listen)
// // ─────────────────────────────────────────────────────────────────────────────
// app.use((err, req, res, next) => {
//   const origin = req.headers.origin;
//   if (origin) {
//     res.header("Access-Control-Allow-Origin", origin);
//     res.header("Access-Control-Allow-Credentials", "true");
//   } else {
//     res.header("Access-Control-Allow-Origin", "*");
//     res.removeHeader("Access-Control-Allow-Credentials");
//   }
//   res.header("Vary", "Origin");
//   if (res.headersSent) return next(err);
//   const status = err.status || 500;
//   res.status(status).json({ error: err.message || "Server error" });
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Start
// // ─────────────────────────────────────────────────────────────────────────────
// server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


require("dotenv").config();
const ENV = require("./config/env");
ENV.assertProdRequired();


const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

// DB / models
const mongoose = require("mongoose");
const EmailLog = require("./models/EmailLog");
const RegionStat = require("./models/RegionStats");
const DomainReputation = require("./models/DomainReputation");
const ProviderReputation = require("./models/ProviderReputation"); // 👈 NEW
const User = require("./models/User");
const BulkStat = require("./models/BulkStat");
const SinglePending = require("./models/SinglePending");

// SMTP validators now live under utils
const { validateSMTP, validateSMTPStable } = require("./utils/smtpValidator");

// Routers
const authRoutes = require("./routes/auth");
const phoneValidatorRoutes = require("./routes/phoneValidator");
const deliverabilityRoutes = require("./routes/deliverability");

// ─────────────────────────────────────────────────────────────────────────────
// App / HTTP / WS
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
// const PORT = process.env.PORTSERVER || 5000;
const PORT = ENV.PORTSERVER;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 ESSENTIAL CORS FIX: short-circuit preflights with proper headers
// (Place this IMMEDIATELY after app = express(); before any other middleware.)
// ─────────────────────────────────────────────────────────────────────────────
// app.use((req, res, next) => {
//   const origin = req.headers.origin;

//   if (origin) {
//     // Normal CORS: echo exact origin + allow credentials
//     res.header("Access-Control-Allow-Origin", origin);
//     res.header("Access-Control-Allow-Credentials", "true");
//   } else {
//     // No Origin header (some proxies/preflights): use wildcard WITHOUT credentials
//     res.header("Access-Control-Allow-Origin", "*");
//     res.removeHeader("Access-Control-Allow-Credentials");
//   }

//   res.header("Vary", "Origin");
//   res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

//   const reqHeaders = req.header("Access-Control-Request-Headers");
//   res.header(
//     "Access-Control-Allow-Headers",
//     reqHeaders ||
//       "Content-Type, Authorization, X-User, X-Idempotency-Key, Cache-Control, Pragma, If-Modified-Since, ngrok-skip-browser-warning, X-Requested-With"
//   );
//   res.header("Access-Control-Max-Age", "86400"); // cache preflights for a day

//   if (req.method === "OPTIONS") {
//     return res.sendStatus(204);
//   }
//   next();
// });

// ─────────────────────────────────────────────────────────────────────────────
// ✅ Stage-aware CORS
// - local/testing: allow any origin (dev-friendly)
// - production: only allow ENV.ALLOWED_ORIGINS + ENV.FRONTEND_URL
// ─────────────────────────────────────────────────────────────────────────────
const allowedSet = new Set((ENV.ALLOWED_ORIGINS || []).map((s) => s.trim()));

app.use((req, res, next) => {
  const origin = req.headers.origin;

  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

  const reqHeaders = req.header("Access-Control-Request-Headers");
  res.header(
    "Access-Control-Allow-Headers",
    reqHeaders ||
      "Content-Type, Authorization, X-User, X-Idempotency-Key, Cache-Control, Pragma, If-Modified-Since, ngrok-skip-browser-warning, X-Requested-With"
  );
  res.header("Access-Control-Max-Age", "86400");

  // No origin: allow (curl / server-to-server)
  if (!origin) {
    res.header("Access-Control-Allow-Origin", "*");
    res.removeHeader("Access-Control-Allow-Credentials");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }

  // local/testing -> allow all; production -> whitelist
  const allowed = !ENV.IS_PROD || allowedSet.has(origin);

  if (allowed) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }

  if (req.method === "OPTIONS") return res.sendStatus(403);
  return res.status(403).json({ error: "CORS blocked for this origin" });
});


// ─────────────────────────────────────────────────────────────────────────────
const stableCache = new Map(); // short-lived results for single validation
const inflight = new Map(); // de-dupe concurrent validations per email
const CACHE_TTL_MS = +(process.env.SMTP_STABLE_CACHE_TTL_MS || 10 * 60 * 1000);

const IDEMP_TTL_MS = +(process.env.IDEMP_TTL_MS || 15 * 60 * 1000);
const idempoStore = new Map();

const FRESH_DB_MS = 2 * 24 * 60 * 60 * 1000; // 48h
const cancelMap = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Behavior flags
// ─────────────────────────────────────────────────────────────────────────────
// const REQUIRE_AUTH =
//   (process.env.REQUIRE_AUTH || "false").toLowerCase() === "true";
// const BULK_REQUIRE_AUTH =
//   (process.env.BULK_REQUIRE_AUTH || "false").toLowerCase() === "true";

const REQUIRE_AUTH = ENV.REQUIRE_AUTH;
const BULK_REQUIRE_AUTH = ENV.BULK_REQUIRE_AUTH;


/* ─────────────────────────────────────────────────────────────────────────────
   ✅ CORS — simple, permissive, and applied EARLY to every route
   (reflect any Origin; allow credentials; handle all preflights)
────────────────────────────────────────────────────────────────────────────── */
const corsOptions = {
  origin: (origin, cb) => cb(null, true), // reflect any origin (dev-friendly; you can tighten later)
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User",
    "X-Idempotency-Key",
    "Cache-Control",
    "Pragma",
    "If-Modified-Since",
    "ngrok-skip-browser-warning",
    "X-Requested-With",
  ],
  exposedHeaders: ["Content-Disposition"],
};

// vary on Origin for caches/proxies
app.use((req, res, next) => {
  res.header("Vary", "Origin");
  next();
});
// Mirror whatever headers the browser asks for (future-proof preflights)
app.use((req, res, next) => {
  const reqHeaders = req.header("Access-Control-Request-Headers");
  if (reqHeaders) res.header("Access-Control-Allow-Headers", reqHeaders);
  res.header("Vary", "Origin");
  // Optional: cache successful preflights to reduce noise
  res.header("Access-Control-Max-Age", "86400");
  next();
});

// Apply CORS to everything and explicitly answer preflights
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* ─────────────────────────────────────────────────────────────────────────────
   Never cache the two polling endpoints (history/progress)
────────────────────────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    /\/api\/finder\/bulk\/(history|progress)/.test(req.originalUrl)
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

// Security / compression / parsing
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());
app.use((req, res, next) => {
  // SNS sometimes sends text/plain
  if (req.headers["x-amz-sns-message-type"])
    bodyParser.text({ type: "*/*" })(req, res, next);
  else bodyParser.json()(req, res, next);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: +(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024) }, // 25MB default
});

// ─────────────────────────────────────────────────────────────────────────────
// Simple Basic Auth (for server-side gating)
// ─────────────────────────────────────────────────────────────────────────────
const credentials = {};
const userPerms = {};
(process.env.FULL_USERS || "").split(",").forEach((pair) => {
  if (!pair) return;
  const [u, p] = pair.split(":");
  if (!u) return;
  credentials[u] = p || "";
  userPerms[u] = ["single", "bulk"];
});
(process.env.LIMITED_USERS || "").split(",").forEach((pair) => {
  if (!pair) return;
  const [u, p] = pair.split(":");
  if (!u) return;
  credentials[u] = p || "";
  userPerms[u] = ["single"];
});
function auth(req, res, next) {
  if (!REQUIRE_AUTH) return next();
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic "))
    return res.status(401).json({ error: "Auth required" });
  const [u, p] = Buffer.from(h.split(" ")[1] || "", "base64")
    .toString()
    .split(":");
  if (!u || credentials[u] !== p)
    return res.status(401).json({ error: "Invalid credentials" });
  req.user = u;
  next();
}
const maybeBulkAuth = (req, res, next) =>
  BULK_REQUIRE_AUTH ? auth(req, res, next) : next();

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: progress + live status/logs
// ─────────────────────────────────────────────────────────────────────────────
const clients = new Set();
const sessionClients = new Map();
const progressStore = new Map();

/* ✅ NEW: user-level socket rooms (for Deliverability realtime updates)
   - key: normalized username
   - value: Set of ws connections (supports multi-tabs)
*/
const userSockets = new Map();

/* ✅ NEW: normalize user key (consistent across app) */
function normUserKey(u) {
  return String(u || "")
    .trim()
    .toLowerCase();
}

/* ✅ NEW: add/remove ws from user room */
function addUserSocket(username, ws) {
  const key = normUserKey(username);
  if (!key) return;
  if (!userSockets.has(key)) userSockets.set(key, new Set());
  userSockets.get(key).add(ws);
}

function removeUserSocket(username, ws) {
  const key = normUserKey(username);
  if (!key) return;
  const set = userSockets.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userSockets.delete(key);
}

wss.on("connection", (ws, req) => {
  clients.add(ws);

  // ✅ NEW: store user on socket for cleanup
  ws.__userKey = null;

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sid = url.searchParams.get("sessionId");
    const user = url.searchParams.get("user");

    // ✅ NEW: register user room from WS URL (?user=...)
    if (user) {
      ws.__userKey = normUserKey(user);
      addUserSocket(user, ws);
    }

    if (sid && user) sessionClients.set(`${user}:${sid}`, ws);
    else if (sid) sessionClients.set(sid, ws);
  } catch {}

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      const userField = data.user || data.username;

      // ✅ NEW: also register/update user room from client message payload
      if (userField) {
        const nextKey = normUserKey(userField);
        if (nextKey && ws.__userKey !== nextKey) {
          if (ws.__userKey) removeUserSocket(ws.__userKey, ws);
          ws.__userKey = nextKey;
          addUserSocket(ws.__userKey, ws);
        }
      }

      if (data.sessionId && userField)
        sessionClients.set(`${userField}:${data.sessionId}`, ws);
      else if (data.sessionId) sessionClients.set(data.sessionId, ws);
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);

    // ✅ NEW: cleanup from user room
    if (ws.__userKey) removeUserSocket(ws.__userKey, ws);

    for (const [key, sock] of sessionClients.entries())
      if (sock === ws) sessionClients.delete(key);
  });
});

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);

wss.on("close", () => clearInterval(interval));


/* ✅ NEW: realtime deliverability broadcaster
   - routes/deliverability.js will call this when DB updates happen
*/
function sendDeliverabilityUpdateToFrontend(username, payloadObj) {
  const key = normUserKey(username);
  if (!key) return;

  const data = JSON.stringify({ type: "deliverability:update", ...payloadObj });

  const set = userSockets.get(key);
  if (set && set.size) {
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
    return;
  }

  // fallback: broadcast (rare)
  clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
}

function sendProgressToFrontend(
  current,
  total,
  sessionId = null,
  username = null,
  bulkId = null
) {
  if (!sessionId || !username) return;
  const sessKey = `${username}:${sessionId}`;
  const ws = sessionClients.get(sessKey) || sessionClients.get(sessionId);

  if (bulkId) {
    const progKey = `${username}:${sessionId}:${bulkId}`;
    progressStore.set(progKey, { bulkId, current, total, at: Date.now() });
  } else {
    progressStore.set(sessKey, { current, total, at: Date.now() });
  }

  const payload = bulkId
    ? JSON.stringify({ type: "progress", bulkId, current, total })
    : JSON.stringify({ type: "progress", current, total });

  if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  else
    clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
}

function sendLogToFrontend(
  sessionId,
  email,
  message,
  step = null,
  level = "info",
  username = null
) {
  const payload = JSON.stringify({
    type: "log",
    email,
    step,
    level,
    message,
    at: new Date().toISOString(),
  });
  const ws =
    (username && sessionClients.get(`${username}:${sessionId}`)) ||
    sessionClients.get(sessionId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  else
    clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
}

function sendStatusToFrontend(
  email,
  status,
  timestamp,
  details,
  sessionId = null,
  _persist = true,
  username = null
) {
  const payload = JSON.stringify({
    type: "status",
    email,
    status,
    timestamp,
    domain: details?.domain || "N/A",
    domainProvider: details?.provider || "N/A",
    isDisposable: !!details?.isDisposable,
    isFree: !!details?.isFree,
    isRoleBased: !!details?.isRoleBased,
    score: typeof details?.score === "number" ? details.score : 0,
    subStatus: details?.subStatus || details?.sub_status || null,
    confidence:
      typeof details?.confidence === "number" ? details.confidence : null,
    category: details?.category || "unknown",
    message: details?.message || "",
    reason: details?.reason || "",
  });
  const ws =
    (username && sessionClients.get(`${username}:${sessionId}`)) ||
    sessionClients.get(sessionId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  else
    clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(payload));
}

function sendBulkStatsToFrontend(sessionId, username, payload) {
  const key = username ? `${username}:${sessionId}` : sessionId;
  const ws =
    (username && sessionClients.get(key)) || sessionClients.get(sessionId);
  const data = JSON.stringify({ type: "bulk:stats", ...payload });
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// SES regions & region stats (for /send-email)
// ─────────────────────────────────────────────────────────────────────────────
const regions = [
  process.env.AWS_REGION,
  process.env.AWS_REGION_EAST2,
  process.env.AWS_REGION_WEST1,
].filter(Boolean);
let regionStats = [];

// Connect to MongoDB and initialize region stats
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ Connected to MongoDB");

    if (regions.length) {
      const existing = await RegionStat.find({ region: { $in: regions } });
      regionStats = regions.map(
        (r) =>
          existing.find((e) => e.region === r) ||
          new RegionStat({ region: r, sent: 0, bounces: 0 })
      );
    }
  })
  .catch((err) => console.error("❌ MongoDB error:", err));

function getBounceRate(stat) {
  return stat.sent > 0 ? (stat.bounces / stat.sent) * 100 : 0;
}

function getBestRegion() {
  const override = process.env.FORCE_SES_REGION;
  if (override && override.trim() && override !== "null") return override;
  for (const s of regionStats) {
    if (getBounceRate(s) < 4.5) return s.region;
  }
  // fallback
  return process.env.AWS_REGION || regions[0];
}

async function incrementStat(region, type) {
  const t = regionStats.find((r) => r.region === region);
  if (t) {
    if (type === "sent") t.sent++;
    if (type === "bounce") t.bounces++;
  }
  await RegionStat.updateOne(
    { region },
    { $inc: { [type]: 1 } },
    { upsert: true }
  );
}

const sesClients = new Map();
function getSesClient(region) {
  if (!sesClients.has(region)) {
    const accessKeyId =
      process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SMTP_USER;
    const secretAccessKey =
      process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SMTP_PASS;
    sesClients.set(
      region,
      new SESClient({
        region,
        credentials: { accessKeyId, secretAccessKey },
      })
    );
  }
  return sesClients.get(region);
}

// build a GridFS bucket bound to the *per-user* database
const { dbNameFromUsername } = require("./utils/validator");
function getGridFSBucket(username) {
  if (!username) throw new Error("getGridFSBucket: username is required");
  const dbName = dbNameFromUsername(username);
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  const bucketName = process.env.GRIDFS_BUCKET || "bulkfiles";
  return new mongoose.mongo.GridFSBucket(conn.db, { bucketName });
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency & credits
// ─────────────────────────────────────────────────────────────────────────────
function idempoKey(username, email, key) {
  if (!username || !email || !key) return null;
  return `${username}:${email}:${key}`;
}
function idempoGet(username, email, key) {
  const k = idempoKey(username, email, key);
  if (!k) return null;
  const rec = idempoStore.get(k);
  if (!rec) return null;
  if (Date.now() - rec.ts > IDEMP_TTL_MS) {
    idempoStore.delete(k);
    return null;
  }
  return rec;
}
function idempoSet(username, email, key, creditsAfter) {
  const k = idempoKey(username, email, key);
  if (!k) return;
  idempoStore.set(k, { ts: Date.now(), creditsAfter });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of idempoStore.entries())
    if (now - v.ts > IDEMP_TTL_MS) idempoStore.delete(k);
}, 60_000);

// Shared validator helpers
const {
  categoryFromStatus,
  normEmail,
  buildReasonAndMessage,
  extractDomain,
  detectProviderByMX,
  getUserDb,
  bumpUpdatedAt,
  replaceLatest,
  lastTouch,
  getFreshestFromDBs,
  incDashStat,
  normalizeStatus,
} = require("./utils/validator");

// ─────────────────────────────────────────────────────────────────────────────
// Simple domain flags for /send-email reputation checks
// ─────────────────────────────────────────────────────────────────────────────
const disposableDomains = [
  "mailinator.com",
  "tempmail.com",
  "10minutemail.com",
];
const freeEmailProviders = [
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
];
const roleBasedEmails = [
  "admin",
  "support",
  "info",
  "contact",
  "help",
  "sales",
  "development",
];

async function debitOneCreditIfNeeded(
  username,
  status,
  email = null,
  idemKey = null,
  mode = null // pass "single" from singleValidator.js (already done)
) {
  const cat = categoryFromStatus(status);

  // ── Unknown: don't charge, but count once for single
  if (cat === "unknown") {
    // Use idempotency guard to avoid double counting on retries
    if (mode === "single") {
      if (idemKey && email) {
        const rec = idempoGet(username, email, idemKey);
        if (!rec) {
          // mark this request as handled so retries don't double count
          const uNow = await User.findOne({ username });
          idempoSet(username, email, idemKey, uNow?.credits ?? null);
          try {
            await incDashStat(
              mongoose,
              EmailLog,
              RegionStat,
              DomainReputation,
              username,
              { mode: "single", counts: { unknown: 1, requests: 1 } }
            );
          } catch (e) {
            console.warn("dashstat (single unknown) inc failed:", e.message);
          }
          return uNow?.credits ?? null;
        }
      } else {
        // No idempotency key: best-effort increment
        try {
          await incDashStat(
            mongoose,
            EmailLog,
            RegionStat,
            DomainReputation,
            username,
            { mode: "single", counts: { unknown: 1, requests: 1 } }
          );
        } catch (e) {
          console.warn("dashstat (single unknown) inc failed:", e.message);
        }
      }
    }
    const u = await User.findOne({ username });
    return u?.credits ?? null;
  }

  // ── Billable categories (valid/invalid/risky): charge once (your existing logic)
  if (idemKey && email) {
    const rec = idempoGet(username, email, idemKey);
    if (rec) return rec.creditsAfter;
  }
  const updated = await User.findOneAndUpdate(
    { username },
    { $inc: { credits: -1 } },
    { new: true }
  );
  const creditsAfter = updated?.credits ?? null;
  if (idemKey && email) idempoSet(username, email, idemKey, creditsAfter);

  // Optional: if you also want to count single billables exactly once here:
  if (mode === "single") {
    try {
      await incDashStat(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
        { mode: "single", counts: { [cat]: 1, requests: 1 } }
      );
    } catch (e) {
      console.warn("dashstat (single billable) inc failed:", e.message);
    }
  }

  return creditsAfter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health & user
// ─────────────────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.get("/user/:username", async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ credits: user.credits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auth routes (unchanged)
app.use(authRoutes);

// ─────────────────────────────────────────────────────────────────────────────
/* Mount split routers (same style as authRoutes) */
// ─────────────────────────────────────────────────────────────────────────────
const routeDeps = {
  // libs / models
  mongoose,
  EmailLog,
  RegionStat,
  DomainReputation,
  ProviderReputation, // 👈 NEW in deps (for later use)
  User,
  BulkStat,
  SinglePending,
  incDashStat,
  // utils
  categoryFromStatus,
  normEmail,
  buildReasonAndMessage,
  extractDomain,
  getUserDb,
  bumpUpdatedAt,
  replaceLatest,
  lastTouch,
  getFreshestFromDBs,
  detectProviderByMX,
  // runtime config / state
  FRESH_DB_MS,
  CACHE_TTL_MS,
  stableCache,
  inflight,
  upload,
  getGridFSBucket,
  progressStore,
  cancelMap,
  // validators
  validateSMTP,
  validateSMTPStable,
  // credits / idempotency
  debitOneCreditIfNeeded,
  idempoGet,
  // ws
  sendProgressToFrontend,
  sendLogToFrontend,
  sendStatusToFrontend,
  sendBulkStatsToFrontend,

  // ✅ NEW: deliverability realtime push helper (used by deliverability route)
  sendDeliverabilityUpdateToFrontend,

  // auth
  maybeBulkAuth,
};

const dashboardRouter = require("./routes/Dashboard")(routeDeps);
const singleValidatorRouter = require("./routes/singleValidator")(routeDeps);
const bulkValidatorRouter = require("./routes/bulkValidator")(routeDeps);
const EmailFinderRouter = require("./routes/EmailFinder");
const ToxicityCheckerRouter = require("./routes/ToxicityChecker")(routeDeps);
const FileCleanerRouter = require("./routes/fileCleaner");

// 🆕 NEW: Training / dataset routes (Bouncer import, domain stats)
const TrainingRouter = require("./routes/training")(routeDeps);

app.use("/api/single", singleValidatorRouter);
app.use("/api/bulk", bulkValidatorRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/finder", EmailFinderRouter());
app.use("/api/toxicity", ToxicityCheckerRouter);
app.use("/api/training", TrainingRouter);
app.use("/api/phone", phoneValidatorRoutes);

/* ✅ NEW: deliverability route must be mounted as factory to receive deps */
app.use("/api/deliverability", deliverabilityRoutes(routeDeps));

app.use("/api/file-cleaner", FileCleanerRouter);

// ─────────────────────────────────────────────────────────────────────────────
// Remaining APIs (stay inline here; not related to single/bulk validator)
// ─────────────────────────────────────────────────────────────────────────────

// Stats per user (uses per-user DB)
app.get("/stats", async (req, res) => {
  try {
    const username =
      req.query.username || req.headers["x-user"] || req.body.username || null;
    if (!username)
      return res.status(400).json({ error: "Username is required" });

    const { EmailLog: UserEmailLog } = getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username
    );

    const total = await UserEmailLog.countDocuments();
    const valid = await UserEmailLog.countDocuments({ status: /Valid/i });
    const invalid = await UserEmailLog.countDocuments({ status: /Invalid/i });
    const unknown = await UserEmailLog.countDocuments({ status: /Unknown/i });

    res.json({ total, valid, invalid, unknown });
  } catch (err) {
    console.error("Error in /stats:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/get-credits", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username)
      return res.status(400).json({ error: "Username is required" });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ credits: user.credits });
  } catch (err) {
    console.error("❌ /get-credits error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Send email (SES) with SMTP pre-check & domain reputation guard
// (ported from old server.js, adapted to new WS + helpers)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/send-email", auth, async (req, res) => {
  try {
    const { email, sessionId } =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (!email) return res.status(400).json({ error: "Email is required" });

    const logger = (step, message, level = "info") =>
      sendLogToFrontend(sessionId, email, message, step, level);

    const domain = extractDomain(email);

    // Domain reputation short-circuit
    const domainStats = await DomainReputation.findOne({ domain });
    if (domainStats && domainStats.sent >= 5) {
      const bounceRate = domainStats.invalid / domainStats.sent;
      if (bounceRate >= 0.6) {
        const provider = await detectProviderByMX(domain);
        sendStatusToFrontend(
          email,
          "⚠️ Risky (High Bounce Domain)",
          null,
          {
            domain,
            provider,
            isDisposable: disposableDomains.includes(domain),
            isFree: freeEmailProviders.includes(domain),
            isRoleBased: roleBasedEmails.includes(
              (email.split("@")[0] || "").toLowerCase()
            ),
          },
          sessionId
        );
        logger(
          "reputation",
          `Blocked by domain reputation (bounceRate=${(
            bounceRate * 100
          ).toFixed(1)}%)`,
          "warn"
        );
        return res
          .status(200)
          .json({ skipped: true, reason: "High bounce domain" });
      }
    }

    // Cached result reuse
    const cached = await EmailLog.findOne({ email }).sort({ createdAt: -1 });
    if (cached) {
      const ageMs = Date.now() - new Date(cached.createdAt).getTime();
      const isFresh = ageMs < 10 * 24 * 60 * 60 * 1000; // 10 days
      const isValidType =
        cached.status.includes("✅") ||
        cached.status.includes("⚠️") ||
        cached.status.includes("Unknown");
      if ((isValidType && isFresh) || cached.status.includes("❌")) {
        sendStatusToFrontend(
          email,
          cached.status,
          cached.timestamp,
          {
            domain: cached.domain,
            provider: cached.domainProvider,
            isDisposable: cached.isDisposable,
            isFree: cached.isFree,
            isRoleBased: cached.isRoleBased,
          },
          sessionId
        );
        logger("cache", `Reused cached result: ${cached.status}`);
        return res.json({ success: true, cached: true });
      }
    }

    // SMTP pre-check
    logger("start", "Starting SMTP validation (pre-check)");
    const smtpResult = await validateSMTP(email, { logger });
    logger(
      "smtp_result",
      `SMTP pre-check: ${smtpResult.category} (${
        smtpResult.sub_status || "n/a"
      })`
    );

    if (smtpResult.category === "invalid") {
      // Undeliverable → don't send
      sendStatusToFrontend(
        email,
        smtpResult.status,
        null,
        {
          domain: smtpResult.domain,
          provider: smtpResult.provider,
          isDisposable: smtpResult.isDisposable,
          isFree: smtpResult.isFree,
          isRoleBased: smtpResult.isRoleBased,
        },
        sessionId
      );
      logger("done", "Pre-check says undeliverable → not sending");
      return res.status(200).json({ skipped: true, reason: "SMTP invalid" });
    }

    if (smtpResult.category === "risky") {
      // Risky: only send if we’ve never tried this address before
      const previouslySent = await EmailLog.findOne({ email });
      if (previouslySent) {
        sendStatusToFrontend(
          email,
          smtpResult.status,
          null,
          {
            domain: smtpResult.domain,
            provider: smtpResult.provider,
            isDisposable: smtpResult.isDisposable,
            isFree: smtpResult.isFree,
            isRoleBased: smtpResult.isRoleBased,
          },
          sessionId
        );
        logger("done", "Pre-check risky & previously tried → not sending");
        return res
          .status(200)
          .json({ skipped: true, reason: "SMTP risky (already tried)" });
      }
      logger(
        "info",
        "Pre-check risky but first time → sending once via SES (one-shot)",
        "warn"
      );
    }

    // Choose SES region & send
    const region = getBestRegion();
    const ses = getSesClient(region);

    const params = {
      Source: process.env.VERIFIED_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: "Hope this finds you well" },
        Body: {
          Text: {
            Data: `Hey there!

Just wanted to say a quick hello and check if everything’s going smoothly.
Feel free to get in touch anytime — we’re always here to help.

Warm wishes,
Jenny
Team TrueSendr`,
          },
        },
      },
      Tags: [{ Name: "region", Value: region }],
    };

    await ses.send(new SendEmailCommand(params));
    await incrementStat(region, "sent");
    logger("ses_sent", `Sent via SES region ${region}`);

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Error in /send-email:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔒 ESSENTIAL CORS FIX: ensure even errors include CORS headers
// (Place this AFTER all routers, BEFORE server.listen)
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
    res.removeHeader("Access-Control-Allow-Credentials");
  }
  res.header("Vary", "Origin");
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Server error" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
