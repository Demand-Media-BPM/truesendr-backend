// routes/training.js
const express = require("express");
const router = express.Router();
const XLSX = require("xlsx");
const TrainingSample = require("../models/TrainingSample");

module.exports = function trainingRouter(deps) {
  const { upload, extractDomain } = deps;

  // ───────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────
  function normalizeLabel(raw) {
    if (!raw) return "unknown";
    const s = String(raw).trim().toLowerCase();

    if (["valid", "deliverable", "ok", "good"].includes(s)) return "valid";
    if (["invalid", "undeliverable", "bad", "bounced"].includes(s))
      return "invalid";
    if (
      [
        "risky",
        "accept all",
        "accept-all",
        "catch all",
        "catch-all",
        "disposable",
      ].includes(s)
    )
      return "risky";
    if (["unknown", "timeout", "unknown mail system"].includes(s))
      return "unknown";

    return "unknown";
  }

  // ───────────────────────────────────────────────
  // POST /api/training/upload
  // Upload a Bouncer/ZeroBounce-style CSV/XLSX and
  // store samples into TrainingSample
  // ───────────────────────────────────────────────
  router.post("/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "file is required" });
      }

      // You can send "source" from frontend (bouncer / zerobounce / manual)
      const source =
        (req.body.source && String(req.body.source).toLowerCase()) ||
        "bouncer";

      // Column hints (optional). If not sent, we’ll fall back to common names.
      let emailCol =
        (req.body.emailColumn && req.body.emailColumn.trim()) || null;
      let statusCol =
        (req.body.statusColumn && req.body.statusColumn.trim()) || null;
      let providerCol =
        (req.body.providerColumn && req.body.providerColumn.trim()) || null;

      // Parse Excel/CSV using xlsx
      const buf = req.file.buffer;
      const wb = XLSX.read(buf, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

      if (!rows.length) {
        return res
          .status(400)
          .json({ error: "Uploaded file is empty or has no rows." });
      }

      // Auto-detect columns from first row if not given
      const firstRow = rows[0];
      const keys = Object.keys(firstRow || {}).map((k) => k.toLowerCase());

      function pickColumn(candidates) {
        for (const c of candidates) {
          const idx = keys.indexOf(c.toLowerCase());
          if (idx !== -1) return Object.keys(firstRow)[idx];
        }
        return null;
      }

      if (!emailCol) {
        emailCol = pickColumn(["email", "e-mail", "address", "email address"]);
      }
      if (!statusCol) {
        statusCol = pickColumn(["status", "result", "verification result"]);
      }
      if (!providerCol) {
        providerCol = pickColumn(["provider", "mail provider", "gateway"]);
      }

      if (!emailCol || !statusCol) {
        return res.status(400).json({
          error:
            "Could not auto-detect Email/Status columns. Please ensure headers like 'Email' and 'Status' exist or send emailColumn/statusColumn.",
        });
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let invalidFormat = 0;

      const bulkOps = [];

      for (const row of rows) {
        const emailRaw = row[emailCol];
        const statusRaw = row[statusCol];

        if (!emailRaw) {
          skipped++;
          continue;
        }

        const email = String(emailRaw).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          invalidFormat++;
          continue;
        }

        const label = normalizeLabel(statusRaw);
        const domain =
          (extractDomain && extractDomain(email)) || email.split("@")[1];
        const provider =
          (providerCol && row[providerCol]) ? String(row[providerCol]).trim() : null;

        bulkOps.push({
          updateOne: {
            filter: { email, source },
            update: {
              $setOnInsert: {
                firstSeenAt: new Date(),
              },
              $set: {
                email,
                domain: (domain || "").toLowerCase(),
                source,
                provider: provider || null,
                lastSeenAt: new Date(),
                lastLabel: label,
              },
              $inc: {
                totalSamples: 1,
                [`labelCounts.${label}`]: 1,
              },
            },
            upsert: true,
          },
        });
      }

      if (bulkOps.length) {
        const resBulk = await TrainingSample.bulkWrite(bulkOps, {
          ordered: false,
        });
        inserted = resBulk.upsertedCount || 0;
        updated = (resBulk.modifiedCount || 0) + (resBulk.matchedCount || 0);
      }

      return res.json({
        ok: true,
        source,
        processed: rows.length,
        inserted,
        updated,
        skipped,
        invalidFormat,
        emailColumn: emailCol,
        statusColumn: statusCol,
        providerColumn: providerCol,
      });
    } catch (err) {
      console.error("❌ /api/training/upload error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  });

  // ───────────────────────────────────────────────
  // GET /api/training/domains
  // Aggregate label counts per domain
  // Used by DataTraining.js for the domain stats table
  // ───────────────────────────────────────────────
  router.get("/domains", async (req, res) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit || "100", 10) || 100,
        500
      );

      const pipeline = [
        {
          $group: {
            _id: "$domain",
            total: { $sum: "$totalSamples" },
            valid: {
              $sum: { $ifNull: ["$labelCounts.valid", 0] },
            },
            invalid: {
              $sum: { $ifNull: ["$labelCounts.invalid", 0] },
            },
            risky: {
              $sum: { $ifNull: ["$labelCounts.risky", 0] },
            },
            unknown: {
              $sum: { $ifNull: ["$labelCounts.unknown", 0] },
            },
            updatedAt: { $max: "$lastSeenAt" },
          },
        },
        { $sort: { total: -1 } },
        { $limit: limit },
      ];

      const rows = await TrainingSample.aggregate(pipeline);

      const domains = rows.map((r) => ({
        domain: r._id || "(unknown)",
        total: r.total || 0,
        valid: r.valid || 0,
        invalid: r.invalid || 0,
        risky: r.risky || 0,
        unknown: r.unknown || 0,
        updatedAt: r.updatedAt || null,
      }));

      return res.json({ domains });
    } catch (err) {
      console.error("❌ /api/training/domains error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  });

  // ───────────────────────────────────────────────
  // GET /api/training/providers
  // Aggregate label counts per provider/gateway
  // Used by DataTraining.js for provider stats table
  // ───────────────────────────────────────────────
  router.get("/providers", async (req, res) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit || "100", 10) || 100,
        500
      );

      const pipeline = [
        {
          $group: {
            _id: { $ifNull: ["$provider", "(unknown)"] },
            total: { $sum: "$totalSamples" },
            valid: { $sum: { $ifNull: ["$labelCounts.valid", 0] } },
            invalid: { $sum: { $ifNull: ["$labelCounts.invalid", 0] } },
            risky: { $sum: { $ifNull: ["$labelCounts.risky", 0] } },
            unknown: { $sum: { $ifNull: ["$labelCounts.unknown", 0] } },
            updatedAt: { $max: "$lastSeenAt" },
          },
        },
        { $sort: { total: -1 } },
        { $limit: limit },
      ];

      const rows = await TrainingSample.aggregate(pipeline);

      const providers = rows.map((r) => ({
        provider: r._id || "(unknown)",
        total: r.total || 0,
        valid: r.valid || 0,
        invalid: r.invalid || 0,
        risky: r.risky || 0,
        unknown: r.unknown || 0,
        updatedAt: r.updatedAt || null,
      }));

      return res.json({ providers });
    } catch (err) {
      console.error("❌ /api/training/providers error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  });

  // ───────────────────────────────────────────────
  // Optional: keep helpers for debugging / inspection
  // GET /api/training/domain/:domain
  // GET /api/training/email/:email
  // ───────────────────────────────────────────────
  router.get("/domain/:domain", async (req, res) => {
    try {
      const domain = String(req.params.domain || "").toLowerCase().trim();
      if (!domain) {
        return res.status(400).json({ error: "domain is required" });
      }

      const docs = await TrainingSample.find({ domain }).lean();
      if (!docs.length) {
        return res.json({
          domain,
          samples: 0,
          labelCounts: {},
          providers: [],
        });
      }

      const agg = {
        domain,
        samples: 0,
        labelCounts: {},
        providers: new Set(),
        firstSeenAt: null,
        lastSeenAt: null,
      };

      for (const d of docs) {
        agg.samples += d.totalSamples || 1;
        const lc = d.labelCounts || {};
        for (const [k, v] of Object.entries(lc)) {
          agg.labelCounts[k] = (agg.labelCounts[k] || 0) + v;
        }
        if (d.provider) agg.providers.add(d.provider);
        const fs = d.firstSeenAt ? new Date(d.firstSeenAt) : null;
        const ls = d.lastSeenAt ? new Date(d.lastSeenAt) : null;
        if (!agg.firstSeenAt || (fs && fs < agg.firstSeenAt)) agg.firstSeenAt = fs;
        if (!agg.lastSeenAt || (ls && ls > agg.lastSeenAt)) agg.lastSeenAt = ls;
      }

      agg.providers = Array.from(agg.providers);

      return res.json(agg);
    } catch (err) {
      console.error("❌ /api/training/domain/:domain error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  });

  router.get("/email/:email", async (req, res) => {
    try {
      const email = String(req.params.email || "").toLowerCase().trim();
      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }

      const doc = await TrainingSample.findOne({ email }).lean();
      if (!doc) return res.json({ email, found: false });

      return res.json({ found: true, record: doc });
    } catch (err) {
      console.error("❌ /api/training/email/:email error:", err);
      return res.status(500).json({ error: err.message || "Server error" });
    }
  });

  return router;
};
