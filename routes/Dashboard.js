// // routes/Dashboard.js
// const express = require("express");
// const router = express.Router();
// const { FACTS } = require("../utils/facts");

// module.exports = function dashboardRouter(deps) {
//   const {
//     mongoose,
//     EmailLog,
//     RegionStat,
//     DomainReputation,
//     BulkStat,
//     getUserDb,
//   } = deps;

//   // DashStat (per-user) is accessed via getUserDb
//   const DashStatModel = require("../models/DashStat");

//   // simple memory cache of last fact per user (username -> {index, at})
//   const lastFactByUser = new Map();
//   // pick a random index different from prev (when possible)
//   function pickIndex(prev, len) {
//     // <-- add this
//     if (len <= 1) return 0;
//     let i = Math.floor(Math.random() * len);
//     if (prev == null) return i;
//     if (i === prev) i = (i + 1 + Math.floor(Math.random() * (len - 1))) % len;
//     return i;
//   }

//   // ---- date helpers (UTC, YYYY-MM-DD keys) ----
//   function toKeyUTC(d) {
//     const dt = new Date(
//       Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
//     );
//     return dt.toISOString().slice(0, 10);
//   }
//   function addDaysUTC(d, n) {
//     const x = new Date(
//       Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
//     );
//     x.setUTCDate(x.getUTCDate() + n);
//     return x;
//   }
//   function rangeKeys(startKey, endKey) {
//     const out = [];
//     let cur = new Date(`${startKey}T00:00:00.000Z`);
//     const end = new Date(`${endKey}T00:00:00.000Z`);
//     while (cur <= end) {
//       out.push(toKeyUTC(cur));
//       cur = addDaysUTC(cur, 1);
//     }
//     return out;
//   }

//   function normalizeRange(query) {
//     const mode = (query.mode || "last").toLowerCase(); // 'last' | 'range'
//     if (mode === "range") {
//       const from = String(query.from || "").slice(0, 10);
//       const to = String(query.to || "").slice(0, 10);
//       if (
//         !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
//         !/^\d{4}-\d{2}-\d{2}$/.test(to)
//       ) {
//         return { error: "from and to must be YYYY-MM-DD" };
//       }
//       if (from > to) return { error: "from must be <= to" };
//       return { start: from, end: to, days: rangeKeys(from, to).length };
//     }

//     const days = Math.max(1, Math.min(90, Number(query.days || 30)));
//     const today = new Date();
//     const end = toKeyUTC(today);
//     const start = toKeyUTC(addDaysUTC(today, -days + 1));
//     return { start, end, days };
//   }

//   // ---------------------------------------
//   // NEW: GET /api/dashboard/fact
//   // Returns one random fact (different from the last shown to this user)
//   // ---------------------------------------
//   router.get("/fact", async (req, res) => {
//     try {
//       const username =
//         req.headers["x-user"] ||
//         req.query.username ||
//         req.body?.username ||
//         "anonymous";
//       const prev = lastFactByUser.get(username)?.index ?? null;
//       const idx = pickIndex(prev, FACTS.length);
//       lastFactByUser.set(username, { index: idx, at: Date.now() });
//       res.json({ id: idx, text: FACTS[idx] });
//     } catch (e) {
//       console.error("❌ /api/dashboard/fact:", e);
//       res.status(500).json({ error: "Failed to load fact" });
//     }
//   });

//   // GET /api/dashboard/summary?username=&mode=last&days=30
//   // or /api/dashboard/summary?username=&mode=range&from=YYYY-MM-DD&to=YYYY-MM-DD
//   router.get("/summary", async (req, res) => {
//     try {
//       const username =
//         req.headers["x-user"] || req.query.username || req.body?.username;
//       if (!username)
//         return res.status(400).json({ error: "username is required" });

//       const rn = normalizeRange(req.query);
//       if (rn.error) return res.status(400).json({ error: rn.error });
//       const { start, end } = rn;

//       const { DashStat } = getUserDb(
//         mongoose,
//         EmailLog,
//         RegionStat,
//         DomainReputation,
//         username,
//         BulkStat,
//         DashStatModel
//       );

//       const docs = await DashStat.find({ date: { $gte: start, $lte: end } })
//         .sort({ date: 1 })
//         .lean();

//       const keys = rangeKeys(start, end);
//       const byDate = {};
//       for (const k of keys) {
//         byDate[k] = {
//           date: k,
//           single: {
//             valid: 0,
//             invalid: 0,
//             risky: 0,
//             unknown: 0,
//             requests: 0,
//             emails: 0,
//           },
//           bulk: {
//             valid: 0,
//             invalid: 0,
//             risky: 0,
//             unknown: 0,
//             requests: 0,
//             emails: 0,
//           },
//         };
//       }

//       for (const d of docs) {
//         const rec = byDate[d.date];
//         if (!rec) continue;
//         const s = d.single || {};
//         const b = d.bulk || {};

//         rec.single.valid = s.valid || 0;
//         rec.single.invalid = s.invalid || 0;
//         rec.single.risky = s.risky || 0;
//         rec.single.unknown = s.unknown || 0;
//         rec.single.requests = s.requests || 0;
//         rec.single.emails =
//           rec.single.valid +
//           rec.single.invalid +
//           rec.single.risky +
//           rec.single.unknown;

//         rec.bulk.valid = b.valid || 0;
//         rec.bulk.invalid = b.invalid || 0;
//         rec.bulk.risky = b.risky || 0;
//         rec.bulk.unknown = b.unknown || 0;
//         rec.bulk.requests = b.requests || 0;
//         rec.bulk.emails =
//           rec.bulk.valid + rec.bulk.invalid + rec.bulk.risky + rec.bulk.unknown;
//       }

//       const totals = {
//         single: {
//           emails: 0,
//           deliverable: 0,
//           risky: 0,
//           undeliverable: 0,
//           unknown: 0,
//           requests: 0,
//         },
//         bulk: {
//           emails: 0,
//           deliverable: 0,
//           risky: 0,
//           undeliverable: 0,
//           unknown: 0,
//           requests: 0,
//         },
//       };

//       for (const k of keys) {
//         const r = byDate[k];
//         totals.single.deliverable += r.single.valid;
//         totals.single.undeliverable += r.single.invalid;
//         totals.single.risky += r.single.risky;
//         totals.single.unknown += r.single.unknown;
//         totals.single.requests += r.single.requests;
//         totals.single.emails += r.single.emails;

//         totals.bulk.deliverable += r.bulk.valid;
//         totals.bulk.undeliverable += r.bulk.invalid;
//         totals.bulk.risky += r.bulk.risky;
//         totals.bulk.unknown += r.bulk.unknown;
//         totals.bulk.requests += r.bulk.requests;
//         totals.bulk.emails += r.bulk.emails;
//       }

//       res.json({
//         range: rn,
//         totals,
//         daily: keys.map((k) => byDate[k]),
//       });
//     } catch (e) {
//       console.error("❌ /api/dashboard/summary:", e);
//       res.status(500).json({ error: "Failed to build dashboard summary" });
//     }
//   });

//   return router;
// };

// routes/Dashboard.js
const express = require("express");
const router = express.Router();
const { FACTS } = require("../utils/facts");

module.exports = function dashboardRouter(deps) {
  const {
    mongoose,
    EmailLog,
    RegionStat,
    DomainReputation,
    BulkStat,
    getUserDb,
    User, // available in deps from other routes
  } = deps;

  // DashStat (per-user) is accessed via getUserDb
  const DashStatModel = require("../models/DashStat");

  // simple memory cache of last fact per user (username -> {index, at})
  const lastFactByUser = new Map();

  // pick a random index different from prev (when possible)
  function pickIndex(prev, len) {
    if (len <= 1) return 0;
    let i = Math.floor(Math.random() * len);
    if (prev == null) return i;
    if (i === prev) i = (i + 1 + Math.floor(Math.random() * (len - 1))) % len;
    return i;
  }

  // ---- date helpers (UTC, YYYY-MM-DD keys) ----
  function toKeyUTC(d) {
    const dt = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    return dt.toISOString().slice(0, 10);
  }
  function addDaysUTC(d, n) {
    const x = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    );
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  }
  function rangeKeys(startKey, endKey) {
    const out = [];
    let cur = new Date(`${startKey}T00:00:00.000Z`);
    const end = new Date(`${endKey}T00:00:00.000Z`);
    while (cur <= end) {
      out.push(toKeyUTC(cur));
      cur = addDaysUTC(cur, 1);
    }
    return out;
  }

  function normalizeRange(query) {
    const mode = (query.mode || "last").toLowerCase(); // 'last' | 'range'
    if (mode === "range") {
      const from = String(query.from || "").slice(0, 10);
      const to = String(query.to || "").slice(0, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(to)
      ) {
        return { error: "from and to must be YYYY-MM-DD" };
      }
      if (from > to) return { error: "from must be <= to" };
      return { start: from, end: to, days: rangeKeys(from, to).length };
    }

    const days = Math.max(1, Math.min(90, Number(query.days || 30)));
    const today = new Date();
    const end = toKeyUTC(today);
    const start = toKeyUTC(addDaysUTC(today, -days + 1));
    return { start, end, days };
  }

  // ---------------------------------------
  // GET /api/dashboard/fact
  // ---------------------------------------
  router.get("/fact", async (req, res) => {
    try {
      const username =
        req.headers["x-user"] ||
        req.query.username ||
        req.body?.username ||
        "anonymous";

      const prev = lastFactByUser.get(username)?.index ?? null;
      const idx = pickIndex(prev, FACTS.length);
      lastFactByUser.set(username, { index: idx, at: Date.now() });

      res.json({ id: idx, text: FACTS[idx] });
    } catch (e) {
      console.error("❌ /api/dashboard/fact:", e);
      res.status(500).json({ error: "Failed to load fact" });
    }
  });

  // ---------------------------------------
  // GET /api/dashboard/summary
  // ?username=&mode=last&days=30
  // or ?username=&mode=range&from=YYYY-MM-DD&to=YYYY-MM-DD
  // ---------------------------------------
  router.get("/summary", async (req, res) => {
    try {
      const username =
        req.headers["x-user"] || req.query.username || req.body?.username;
      if (!username)
        return res.status(400).json({ error: "username is required" });

      const rn = normalizeRange(req.query);
      if (rn.error) return res.status(400).json({ error: rn.error });
      const { start, end } = rn;

      const userDb = getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
        BulkStat,
        DashStatModel
      );

      const { DashStat: UserDashStat } = userDb;

      const docs = await UserDashStat.find({ date: { $gte: start, $lte: end } })
        .sort({ date: 1 })
        .lean();

      const keys = rangeKeys(start, end);
      const byDate = {};
      for (const k of keys) {
        byDate[k] = {
          date: k,
          single: {
            valid: 0,
            invalid: 0,
            risky: 0,
            unknown: 0,
            requests: 0,
            emails: 0,
          },
          bulk: {
            valid: 0,
            invalid: 0,
            risky: 0,
            unknown: 0,
            requests: 0,
            emails: 0,
          },
        };
      }

      for (const d of docs) {
        const rec = byDate[d.date];
        if (!rec) continue;
        const s = d.single || {};
        const b = d.bulk || {};

        rec.single.valid = s.valid || 0;
        rec.single.invalid = s.invalid || 0;
        rec.single.risky = s.risky || 0;
        rec.single.unknown = s.unknown || 0;
        rec.single.requests = s.requests || 0;
        rec.single.emails =
          rec.single.valid +
          rec.single.invalid +
          rec.single.risky +
          rec.single.unknown;

        rec.bulk.valid = b.valid || 0;
        rec.bulk.invalid = b.invalid || 0;
        rec.bulk.risky = b.risky || 0;
        rec.bulk.unknown = b.unknown || 0;
        rec.bulk.requests = b.requests || 0;
        rec.bulk.emails =
          rec.bulk.valid + rec.bulk.invalid + rec.bulk.risky + rec.bulk.unknown;
      }

      const totals = {
        single: {
          emails: 0,
          deliverable: 0,
          risky: 0,
          undeliverable: 0,
          unknown: 0,
          requests: 0,
        },
        bulk: {
          emails: 0,
          deliverable: 0,
          risky: 0,
          undeliverable: 0,
          unknown: 0,
          requests: 0,
        },
      };

      for (const k of keys) {
        const r = byDate[k];
        totals.single.deliverable += r.single.valid;
        totals.single.undeliverable += r.single.invalid;
        totals.single.risky += r.single.risky;
        totals.single.unknown += r.single.unknown;
        totals.single.requests += r.single.requests;
        totals.single.emails += r.single.emails;

        totals.bulk.deliverable += r.bulk.valid;
        totals.bulk.undeliverable += r.bulk.invalid;
        totals.bulk.risky += r.bulk.risky;
        totals.bulk.unknown += r.bulk.unknown;
        totals.bulk.requests += r.bulk.requests;
        totals.bulk.emails += r.bulk.emails;
      }

      res.json({
        range: rn,
        totals,
        daily: keys.map((k) => byDate[k]),
      });
    } catch (e) {
      console.error("❌ /api/dashboard/summary:", e);
      res.status(500).json({ error: "Failed to build dashboard summary" });
    }
  });

  // ---------------------------------------
  // GET /api/dashboard/recent
  // ?username=&type=single|bulk&limit=5
  // ---------------------------------------
  router.get("/recent", async (req, res) => {
    try {
      const username =
        req.headers["x-user"] || req.query.username || req.body?.username;
      if (!username)
        return res.status(400).json({ error: "username is required" });

      const type = String(req.query.type || "bulk").toLowerCase();
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 5)));

      // Per-user models
      const userDb = getUserDb(
        mongoose,
        EmailLog,
        RegionStat,
        DomainReputation,
        username,
        BulkStat,
        DashStatModel
      );
      const { EmailLog: UserEmailLog, BulkStat: UserBulkStat } = userDb;

      // ---------- SINGLE RECENT (EmailLog) ----------
      if (type === "single") {
        // same timestamp logic as /single/history (optional)
        let query = {};
        if (User) {
          const user = await User.findOne({ username }).lean();
          if (user && user.singleTimestamp) {
            const ts = new Date(user.singleTimestamp);
            query = {
              $or: [
                { updatedAt: { $gt: ts } },
                {
                  $and: [
                    { updatedAt: { $exists: false } },
                    { createdAt: { $gt: ts } },
                  ],
                },
              ],
            };
          }
        }

        const docs = await UserEmailLog.find(query)
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(limit)
          .lean();

        const items = docs.map((v) => {
          // 🔹 confidence: convert 0–1 to 0–100, but keep 0–100 as-is
          let confidence = null;
          if (typeof v.confidence === "number") {
            confidence = v.confidence <= 1 ? v.confidence * 100 : v.confidence;
          }

          return {
            id: String(v._id),
            email: v.email,
            status: v.status || "❔ Unknown",
            score: v.score != null ? v.score : null,
            confidence, // 0–100 for the UI
            validatedAt: v.updatedAt || v.createdAt || v.timestamp || null,
          };
        });

        return res.json({ type: "single", items });
      }

      // ---------- BULK RECENT (BulkStat) ----------
      const states = (
        req.query.state || "preflight,running,done,failed,canceled"
      )
        .split(",")
        .map((s) => s.trim());

      const docs = await UserBulkStat.find({ state: { $in: states } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          // added valid / invalid / risky counts if they exist
          "bulkId originalName totalRows creditsRequired state " +
            "createdAt finishedAt valid invalid risky validCount invalidCount riskyCount"
        )
        .lean();

      const items = docs.map((d) => {
        const rawState = d.state || "unknown";
        const status =
          rawState === "done"
            ? "Completed"
            : rawState.charAt(0).toUpperCase() + rawState.slice(1);

        const emails = d.totalRows || d.creditsRequired || 0;

        // 🔹 credits utilized = valid + invalid + risky (when available)
        const valid =
          typeof d.validCount === "number"
            ? d.validCount
            : typeof d.valid === "number"
            ? d.valid
            : 0;
        const invalid =
          typeof d.invalidCount === "number"
            ? d.invalidCount
            : typeof d.invalid === "number"
            ? d.invalid
            : 0;
        const risky =
          typeof d.riskyCount === "number"
            ? d.riskyCount
            : typeof d.risky === "number"
            ? d.risky
            : 0;

        const usedFromCounts = valid + invalid + risky;
        const creditsUtilized =
          usedFromCounts > 0 ? usedFromCounts : d.creditsRequired || emails;

        return {
          id: String(d.bulkId || d._id),
          name: d.originalName || "EnteredManually",
          numberOfEmails: emails,
          creditsUtilized,
          status,
          validatedAt: d.finishedAt || d.createdAt || null,
        };
      });

      return res.json({ type: "bulk", items });
    } catch (e) {
      console.error("❌ /api/dashboard/recent:", e);
      res.status(500).json({ error: "Failed to load recent validations" });
    }
  });

  return router;
};
