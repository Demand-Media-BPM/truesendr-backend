// routes/ToxicityChecker.js
const express = require("express");
const { Readable } = require("stream");
const csvParse = require("csv-parse");
const XLSX = require("xlsx");
const path = require("path");
const { Types } = require("mongoose");

/* ─────────────────────────────────────────────────────────────
   DERIVE TOXICITY from validator response (robust to shapes)
────────────────────────────────────────────────────────────── */
function pluck(obj, paths, fallback = undefined) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, part)) {
        cur = cur[part];
      } else {
        ok = false;
        break;
      }
    }
    if (ok) return cur;
  }
  return fallback;
}

// Rules:
// spamtrap => +2 (always toxic)
// complainer/litigator => +2 (always toxic)
// breached/widely_circulated => +1
// category === "toxic" => +1
// toxic if score >= 2 OR any of spamtrap/complainer/litigator
// unknown ONLY if validator says unknown AND no toxic flags
function deriveToxicity(details = {}) {
  // Try multiple likely locations for flags/category/status from smtp validator
  const flagsRaw =
    pluck(details, ["flags", "toxicity.flags", "result.flags", "validation.flags"], []) ||
    [];
  const flags = new Set(
    (Array.isArray(flagsRaw) ? flagsRaw : [])
      .map((f) => String(f).toLowerCase().trim())
      .filter(Boolean)
  );

  const category = String(
    pluck(details, ["category", "toxicity.category", "result.category", "validation.category"], "")
  ).toLowerCase();

  const validatorStatus = String(
    pluck(details, ["status", "result.status", "validation.status"], "")
  ).toLowerCase();

  let score = 0;
  if (flags.has("spamtrap")) score += 2;
  if (flags.has("complainer") || flags.has("litigator")) score += 2;
  if (flags.has("breached") || flags.has("widely_circulated")) score += 1;
  if (category === "toxic") score += 1;
  if (score < 0) score = 0;
  if (score > 5) score = 5;

  const isToxic =
    score >= 2 || flags.has("spamtrap") || flags.has("complainer") || flags.has("litigator");

  let status = "clean";
  if (isToxic) status = "toxic";
  // Only call "unknown" if the validator itself reports unknown AND no toxic signal
  if (validatorStatus === "unknown" && !isToxic) status = "unknown";

  return {
    toxicityScore: score,
    toxicityFlags: Array.from(flags),
    isToxic,
    status,
    validatorStatus,
    // expose some other helpful fields if present
    subStatus: pluck(details, ["subStatus", "sub_status", "result.subStatus", "validation.subStatus"], "") || "",
    category,
    score: typeof details.score === "number" ? details.score : pluck(details, ["result.score"], null),
    confidence:
      typeof details.confidence === "number"
        ? details.confidence
        : pluck(details, ["result.confidence"], null),
    message: pluck(details, ["message", "result.message"], "") || "",
    reason: pluck(details, ["reason", "result.reason"], "") || "",
  };
}

/* ─────────────────────────────────────────────────────────────
   Normalize uploads → rows + CSV buffer (force store as .csv)
────────────────────────────────────────────────────────────── */
async function normalizeToRowsAndCSV(file) {
  const original = file.originalname || "toxicity.csv";
  const ext = path.extname(original || "").toLowerCase();

  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const csvString = XLSX.utils.sheet_to_csv(sheet);
    const csvBuffer = Buffer.from(csvString, "utf8");
    const csvFilename = path.basename(original, ext).replace(/\.+$/, "") + ".csv";
    return { rows, csvBuffer, csvFilename };
  }

  // CSV/TXT
  const rows = [];
  await new Promise((resolve, reject) => {
    const parser = csvParse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
    parser.on("readable", () => {
      let row;
      while ((row = parser.read())) rows.push(row);
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    Readable.from(file.buffer).pipe(parser);
  });

  let csvString = "";
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    csvString += headers.join(",") + "\n";
    for (const r of rows) {
      const line = headers.map((h) => {
        const s = String(r[h] ?? "");
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      });
      csvString += line.join(",") + "\n";
    }
  }
  const csvBuffer = Buffer.from(csvString, "utf8");
  const csvFilename =
    path.basename(original, ext || ".csv").replace(/\.+$/, "") + ".csv";
  return { rows, csvBuffer, csvFilename };
}

/* ─────────────────────────────────────────────────────────────
   Router
────────────────────────────────────────────────────────────── */
module.exports = function ToxicityCheckerRouter(routeDeps) {
  const {
    mongoose,
    upload,
    progressStore,
    sendProgressToFrontend,
    sendBulkStatsToFrontend,
    validateSMTPStable,
    cancelMap,
    User, // must be passed in from server.js routeDeps
  } = routeDeps;

  const router = express.Router();

  // Use a dedicated GridFS bucket: bulktoxicfiles
  function getToxicFSBucket(username) {
    if (!username) throw new Error("getToxicFSBucket: username is required");
    const { dbNameFromUsername } = require("../utils/validator");
    const dbName = dbNameFromUsername(username);
    const conn = mongoose.connection.useDb(dbName, { useCache: true });
    const bucketName = "bulktoxicfiles"; // => bulktoxicfiles.files + .chunks
    return new mongoose.mongo.GridFSBucket(conn.db, { bucketName });
  }

  // Per-user: only the bulk summary (no per-row logs)
  function getUserCollections(username) {
    const { dbNameFromUsername } = require("../utils/validator");
    const dbName = dbNameFromUsername(username);
    const db = mongoose.connection.useDb(dbName, { useCache: true });

    const ToxicityBulk =
      db.models.ToxicityBulk ||
      db.model(
        "ToxicityBulk",
        new mongoose.Schema(
          {
            username: { type: String, index: true },
            originalFilename: String,          // stored CSV filename
            fileId: mongoose.Schema.Types.ObjectId,      // input CSV GridFS _id (in bulktoxicfiles)
            resultFileId: mongoose.Schema.Types.ObjectId, // results CSV GridFS _id (in bulktoxicfiles)
            total: Number,
            processed: Number,
            toxicCount: Number,
            cleanCount: Number,
            unknownCount: Number,
            createdAt: { type: Date, default: Date.now, index: true },
            completedAt: { type: Date, default: null },
            canceledAt: { type: Date, default: null },
          },
          { collection: "toxicitybulks" }
        )
      );

    return { ToxicityBulk };
  }

  // Upload and process a file
  router.post("/bulk/upload", upload.single("file"), async (req, res) => {
    try {
      const username =
        req.body.username || req.headers["x-user"] || req.query.username;
      const sessionId = req.body.sessionId || req.query.sessionId;

      if (!username) return res.status(400).json({ ok: false, error: "username required" });
      if (!req.file) return res.status(400).json({ ok: false, error: "file required" });

      const { rows, csvBuffer, csvFilename } = await normalizeToRowsAndCSV(req.file);

      // Save input CSV into bulktoxicfiles bucket
      const bucket = getToxicFSBucket(username);
      const inputStream = bucket.openUploadStream(csvFilename, {
        metadata: { kind: "toxicity:input", username, storedAs: "csv" },
      });
      inputStream.end(csvBuffer);
      const fileId = inputStream.id;

      const { ToxicityBulk } = getUserCollections(username);
      const bulkDoc = await ToxicityBulk.create({
        username,
        originalFilename: csvFilename,
        fileId,
        resultFileId: null,
        total: 0,
        processed: 0,
        toxicCount: 0,
        cleanCount: 0,
        unknownCount: 0,
      });
      const bulkId = bulkDoc._id;

      const cancelKey = `toxicity:${username}:${String(bulkId)}`;
      cancelMap.set(cancelKey, { canceled: false });

      // Extract emails
      let emails = [];
      if (rows.length && typeof rows[0] === "object") {
        const headers = Object.keys(rows[0]);
        const emailKey =
          headers.find((h) => String(h).toLowerCase() === "email") || headers[0];
        emails = rows.map((r) => String(r[emailKey] || "").trim()).filter(Boolean);
      }

      await ToxicityBulk.updateOne({ _id: bulkId }, { $set: { total: emails.length } });

      // initial progress push
      sendProgressToFrontend(0, emails.length, sessionId, username, String(bulkId));
      sendBulkStatsToFrontend(sessionId, username, {
        kind: "toxicity",
        bulkId,
        processed: 0,
        total: emails.length,
        toxicCount: 0,
        cleanCount: 0,
        unknownCount: 0,
      });

      // Prepare result CSV lines
      const outHeaders = [
        "email",
        "domain",
        "toxicityScore",
        "toxicityFlags",
        "status",
        "validatorStatus",
        "subStatus",
        "category",
        "score",
        "confidence",
        "message",
        "reason",
      ];
      const outLines = [outHeaders.join(",")];

      let processed = 0,
        toxicCount = 0,
        cleanCount = 0,
        unknownCount = 0;

      for (const email of emails) {
        const flag = cancelMap.get(cancelKey);
        if (flag?.canceled) {
          await ToxicityBulk.updateOne(
            { _id: bulkId },
            {
              $set: {
                processed,
                toxicCount,
                cleanCount,
                unknownCount,
                canceledAt: new Date(),
              },
            }
          );
          sendProgressToFrontend(processed, emails.length, sessionId, username, String(bulkId));
          sendBulkStatsToFrontend(sessionId, username, {
            kind: "toxicity",
            bulkId,
            processed,
            total: emails.length,
            toxicCount,
            cleanCount,
            unknownCount,
          });
          return res.json({ ok: true, bulkId, total: emails.length, canceled: true });
        }

        let details = {};
        try {
          // Support validators that expect either (email) or ({ email })
          const resp = await validateSMTPStable.length >= 1
            ? await validateSMTPStable(email)
            : await validateSMTPStable({ email });
          details = resp || {};
        } catch (e) {
          details = { status: "unknown", message: String(e.message || e) };
        }

        const mapped = deriveToxicity(details);
        const domain = String(email.split("@")[1] || "").toLowerCase();

        processed += 1;
        if (mapped.status === "toxic") toxicCount += 1;
        else if (mapped.status === "clean") cleanCount += 1;
        else unknownCount += 1;

        const record = {
          email,
          domain,
          toxicityScore: mapped.toxicityScore,
          toxicityFlags: (mapped.toxicityFlags || []).join(";"),
          status: mapped.status,
          validatorStatus: mapped.validatorStatus || "",
          subStatus: mapped.subStatus || "",
          category: mapped.category || "",
          score: mapped.score ?? "",
          confidence: mapped.confidence ?? "",
          message: (mapped.message || "").replace(/[\r\n]+/g, " "),
          reason: (mapped.reason || "").replace(/[\r\n]+/g, " "),
        };

        const line = outHeaders.map((h) => {
          const s = String(record[h] ?? "");
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        });
        outLines.push(line.join(","));

        // live updates
        sendProgressToFrontend(processed, emails.length, sessionId, username, String(bulkId));
        sendBulkStatsToFrontend(sessionId, username, {
          kind: "toxicity",
          bulkId,
          processed,
          total: emails.length,
          toxicCount,
          cleanCount,
          unknownCount,
        });
      }

      // Save RESULTS CSV to bulktoxicfiles
      const resultsCsv = outLines.join("\n");
      const resultStream = bucket.openUploadStream(`toxicity_${String(bulkId)}.csv`, {
        metadata: { kind: "toxicity:result", username },
      });
      resultStream.end(Buffer.from(resultsCsv, "utf8"));
      const resultFileId = resultStream.id;

      // Debit credits once (bill only clean + toxic, not unknown)
      try {
        const billable = cleanCount + toxicCount;
        if (billable > 0) {
          const user = await User.findOne({ username });
          if (user) {
            const newCredits = Math.max(0, (user.credits || 0) - billable);
            await User.updateOne({ _id: user._id }, { $set: { credits: newCredits } });
          }
        }
      } catch (e) {
        console.warn("[toxicity.credit] failed to debit:", e.message);
      }

      await ToxicityBulk.updateOne(
        { _id: bulkId },
        {
          $set: {
            processed,
            toxicCount,
            cleanCount,
            unknownCount,
            resultFileId,
            completedAt: new Date(),
          },
        }
      );

      cancelMap.delete(cancelKey);
      return res.json({ ok: true, bulkId, total: emails.length });
    } catch (err) {
      console.error("[toxicity.upload] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Cancel job
  router.post("/bulk/cancel/:bulkId", async (req, res) => {
    try {
      const username = req.body.username || req.query.username || req.headers["x-user"];
      if (!username) return res.status(400).json({ ok: false, error: "username required" });
      const bulkId = String(req.params.bulkId);
      const key = `toxicity:${username}:${bulkId}`;
      const f = cancelMap.get(key) || {};
      f.canceled = true;
      cancelMap.set(key, f);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Poll progress (fallback)
  router.get("/bulk/progress", async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      const username = req.query.username || req.headers["x-user"];
      if (!sessionId || !username) return res.json({ current: 0, total: 0 });

      const sessKey = `${username}:${sessionId}`;
      const rec = progressStore.get(sessKey);
      if (!rec) return res.json({ current: 0, total: 0 });
      return res.json({ current: rec.current || 0, total: rec.total || 0 });
    } catch {
      return res.json({ current: 0, total: 0 });
    }
  });

  // History
  router.get("/bulk/history", async (req, res) => {
    try {
      const username = req.query.username || req.headers["x-user"];
      const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
      if (!username) return res.status(400).json({ ok: false, error: "username required" });

      const { ToxicityBulk } = getUserCollections(username);
      const items = await ToxicityBulk.find({ username })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return res.json({ ok: true, items });
    } catch (err) {
      console.error("[toxicity.history] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // Download results (streams from bulktoxicfiles)
  router.get("/bulk/download/:bulkId", async (req, res) => {
    try {
      const username = req.query.username || req.headers["x-user"];
      const onlyToxic = !!req.query.onlyToxic;
      if (!username) return res.status(400).json({ ok: false, error: "username required" });

      const { ToxicityBulk } = getUserCollections(username);
      const bulk = await ToxicityBulk.findOne({
        _id: new Types.ObjectId(req.params.bulkId),
        username,
      }).lean();

      if (!bulk || !bulk.resultFileId) {
        return res.status(404).json({ ok: false, error: "file not found" });
      }

      const bucket = getToxicFSBucket(username);

      if (!onlyToxic) {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="toxicity_${req.params.bulkId}.csv"`
        );
        return bucket.openDownloadStream(bulk.resultFileId).pipe(res);
      }

      // filter-onlyToxic by streaming parse (keeps memory low)
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="toxicity_${req.params.bulkId}_toxic.csv"`
      );

      const dl = bucket.openDownloadStream(bulk.resultFileId);
      let leftover = "";
      let isHeader = true;
      let headerLine = "";

      dl.on("data", (chunk) => {
        const text = leftover + chunk.toString("utf8");
        const lines = text.split(/\r?\n/);
        leftover = lines.pop() || "";

        lines.forEach((line) => {
          if (isHeader) {
            headerLine = line;
            res.write(headerLine + "\n");
            isHeader = false;
            return;
          }
          if (!line.trim()) return;

          // lightweight CSV splitter that respects quotes
          const cols = [];
          let cur = "";
          let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"' && line[i + 1] === '"') {
              cur += '"';
              i++;
            } else if (c === '"') {
              inQ = !inQ;
            } else if (c === "," && !inQ) {
              cols.push(cur);
              cur = "";
            } else {
              cur += c;
            }
          }
          cols.push(cur);

          const headers = headerLine.split(",");
          const statusIdx = headers.indexOf("status");
          const statusVal = (cols[statusIdx] || "").replace(/^"|"$/g, "");
          if (String(statusVal).toLowerCase() === "toxic") {
            res.write(line + "\n");
          }
        });
      });
      dl.on("end", () => {
        // ignore leftover; our generator doesn't produce partials usually
        res.end();
      });
      dl.on("error", (e) => {
        console.error("[toxicity.download] stream error:", e);
        if (!res.headersSent)
          res.status(500).json({ ok: false, error: "download error" });
      });
    } catch (err) {
      console.error("[toxicity.download] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  return router;
};
