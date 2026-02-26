// routes/bulkValidator.js
const express = require("express");
const xlsx = require("xlsx");
const xlsxStyle = require("xlsx-js-style");
const { Readable } = require("stream");
const crypto = require("crypto");
const router = express.Router();

// ⬇️ import mergeSMTPWithHistory from utils
const { mergeSMTPWithHistory } = require("../utils/validator");

// ✅ Yash imports (you said you already brought these utils/models into your codebase)
const TrainingSample = require("../models/TrainingSample");

const {
  verifySendGrid,
  isProofpointDomain,
  isMimecastDomain,
  toTrueSendrFormat,
} = require("../utils/sendgridVerifier");

// Catch-all domain probe (used before Proofpoint/Mimecast SendGrid path)
const { checkDomainCatchAll } = require("../utils/smtpValidator");

const SendGridLog = require("../models/SendGridLog");

const {
  classifyDomain,
  getDomainCategory,
  hasBankWordInDomain,
  isOrgEduGovDomain,
  isTwDomain,
  isCcTLDDomain,
  // isHighRiskDomain, // (optional) not required, Yash also doesn't actually use it in worker
} = require("../utils/domainClassifier");

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
    metadata = {},
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
          }),
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
      cleanedRows.length ? cleanedRows : [{ [emailCol]: "" }],
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
      fixRows.length ? fixRows : [{ [emailCol]: "" }],
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
  // Domain/provider + training history helper (MERGED)
  // ───────────────────────────────────────────────────────────
  async function buildHistoryForEmail(emailNorm) {
    const E = normEmail(emailNorm);
    const domain = extractDomain(E);
    if (!domain || domain === "N/A") return {};

    // only READING training samples here
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

        // mirror to provider for now
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
      history.trainingLabel = ts.lastLabel || null; // alias used by merge helper
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
      { username, kind: "original", bulkId },
    );

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat,
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
      { upsert: true },
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
    },
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
      BulkStat,
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
        },
      );

      // read original
      const origBuffer = await readGridFSToBuffer(
        username,
        meta.originalFileId,
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
        { username, kind: "cleaned", bulkId },
      );

      const fixSaved = await saveBufferToGridFS(
        username,
        built.fixBuf,
        `fix_invalid_${bulkId}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        { username, kind: "fix_invalid", bulkId },
      );

      // re-analyze using same logic (optional but consistent)
      const analysis = analyzeRows(rows, emailCol);

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
        },
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
      });
    } catch (err) {
      console.error("❌ /api/bulk/cleanup:", err);
      await UserBulkStat.updateOne(
        { bulkId },
        {
          $set: { state: "failed", phase: "failed", error: err.message },
          $currentDate: { updatedAt: true },
        },
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
      BulkStat,
    );
    const doc = await UserBulkStat.findOne({ bulkId });
    if (!doc || !doc.fixFileId)
      return res.status(404).send("Fix file not found");

    res.setHeader("Content-Type", doc.fixMime || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fix_invalid_format_${doc.originalName || bulkId}.xlsx"`,
    );

    const dl = bucket(username).openDownloadStream(doc.fixFileId);
    dl.on("error", () => res.status(404).end());
    dl.pipe(res);
  });

  // ───────────────────────────────────────────────────────────
  // Billing category normalizer (credits computed at END only)
  // ───────────────────────────────────────────────────────────
  function normalizeOutcomeCategory(input) {
    const s = String(input || "")
      .trim()
      .toLowerCase()
      .replace(/^[^a-z0-9]+/g, ""); // remove emojis/symbols

    if (s === "valid" || s.startsWith("valid")) return "valid";
    if (s === "invalid" || s.startsWith("invalid")) return "invalid";
    if (s === "risky" || s.startsWith("risky")) return "risky";
    if (s === "unknown" || s.startsWith("unknown")) return "unknown";

    if (s.includes("valid")) return "valid";
    if (s.includes("invalid") || s.includes("undeliverable")) return "invalid";
    if (s.includes("risky") || s.includes("risk")) return "risky";

    return "unknown";
  }

  function getOutcomeCategory(final) {
    // prefer explicit category if you already store it
    return normalizeOutcomeCategory(final?.category || final?.status || "");
  }

  // ───────────────────────────────────────────────────────────
  // helper: bump live counters + WS
  // ───────────────────────────────────────────────────────────
  async function bumpLiveCounts(
    UserBulkStat,
    bulkId,
    username,
    sessionId,
    cat,
  ) {
    const inc = {};
    if (cat === "valid") inc.valid = 1;
    else if (cat === "invalid") inc.invalid = 1;
    else if (cat === "risky") inc.risky = 1;
    else inc.unknown = 1;

    const doc = await UserBulkStat.findOneAndUpdate(
      { bulkId },
      { $inc: inc },
      { new: true },
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
  // ✅ NEW: Wait for SendGrid webhooks before completing bulk job
  // ───────────────────────────────────────────────────────────
  async function waitForSendGridWebhooks(
    bulkId,
    username,
    sessionId,
    UserBulkStat,
  ) {
    const MAX_WAIT_TIME = 20000; // 20 seconds
    const CHECK_INTERVAL = 1000; // Check every 1 second
    const startTime = Date.now();

    console.log(
      `⏳ [BULK][${bulkId}] Starting webhook wait loop (max ${MAX_WAIT_TIME / 1000}s)...`,
    );

    while (Date.now() - startTime < MAX_WAIT_TIME) {
      // Check current status
      const bulkStat = await UserBulkStat.findOne({ bulkId }).lean();

      if (!bulkStat) {
        console.warn(
          `⚠️  [BULK][${bulkId}] BulkStat not found, exiting wait loop`,
        );
        break;
      }

      const pending = bulkStat.sendgridPendingCount || 0;
      const total = bulkStat.sendgridEmailCount || 0;
      const received = total - pending;

      console.log(
        `📬 [BULK][${bulkId}] Webhooks: ${received}/${total} received (${pending} pending)`,
      );

      // Check if all webhooks received
      if (pending === 0) {
        console.log(`✅ [BULK][${bulkId}] All webhooks received!`);
        break;
      }

      // Send progress update to frontend
      if (sendBulkStatsToFrontend && sessionId) {
        try {
          sendBulkStatsToFrontend(sessionId, username, {
            bulkId,
            state: "waiting_for_webhooks",
            phase: "waiting_for_webhooks",
            message: `Waiting for ${pending} delivery confirmations...`,
            sendgridPending: pending,
            sendgridTotal: total,
            sendgridReceived: received,
            progressPercent: Math.round((received / total) * 100),
          });
        } catch (err) {
          console.warn(
            `⚠️  [BULK][${bulkId}] Failed to send progress update:`,
            err.message,
          );
        }
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
    }

    // Check if we timed out
    const finalStat = await UserBulkStat.findOne({ bulkId }).lean();
    const finalPending = finalStat?.sendgridPendingCount || 0;

    if (finalPending > 0) {
      console.warn(
        `⚠️  [BULK][${bulkId}] Timeout: ${finalPending} webhooks still pending after ${MAX_WAIT_TIME / 1000}s`,
      );
    } else {
      console.log(
        `✅ [BULK][${bulkId}] Webhook wait complete: All ${finalStat?.sendgridEmailCount || 0} webhooks received`,
      );
    }

    // Reset webhook tracking fields
    await UserBulkStat.findOneAndUpdate(
      { bulkId },
      {
        $set: {
          sendgridPendingCount: 0,
          webhookTimeoutAt: null,
        },
      },
    );
  }

  // ───────────────────────────────────────────────────────────
  // ✅ NEW: Regenerate result file with updated EmailLog data
  // ───────────────────────────────────────────────────────────
  async function regenerateResultFile(
    bulkId,
    username,
    UserEmailLog,
    UserBulkStat,
    toValidate,
  ) {
    console.log(
      `🔄 [BULK][${bulkId}] Regenerating result file with updated statuses...`,
    );

    // Fetch updated EmailLog entries for all emails
    const emails = toValidate.map((item) => item.email);
    const updatedLogs = await UserEmailLog.find({
      email: { $in: emails },
    }).lean();

    // Create a map for quick lookup
    const logMap = new Map();
    updatedLogs.forEach((log) => {
      logMap.set(log.email, log);
    });

    // Build result rows with updated data
    const printable = toValidate.map((item) => {
      const E = item.email;
      const log = logMap.get(E);

      if (!log) {
        return {
          Email: E,
          Status: "Unknown",
          Timestamp: "N/A",
          Domain: extractDomain(E),
          Provider: "Unavailable",
          Disposable: "No",
          Free: "No",
          RoleBased: "No",
          Score: 0,
          SubStatus: "",
          Confidence: "",
          Category: "unknown",
          Message: "",
          Reason: "",
          Source: "Unknown",
        };
      }

      return {
        Email: E,
        Status: log.status
          ? log.status.replace(/^[^a-zA-Z0-9]+/, "")
          : "Unknown",
        Timestamp: log.timestamp
          ? new Date(log.timestamp).toLocaleString()
          : "N/A",
        Domain: log.domain || extractDomain(E),
        Provider: log.domainProvider || log.provider || "Unavailable",
        Disposable: log.isDisposable ? "Yes" : "No",
        Free: log.isFree ? "Yes" : "No",
        RoleBased: log.isRoleBased ? "Yes" : "No",
        Score: typeof log.score === "number" ? log.score : 0,
        SubStatus: log.subStatus || "",
        Confidence: typeof log.confidence === "number" ? log.confidence : "",
        Category: log.category || categoryFromStatus(log.status || ""),
        Message: log.message || "",
        Reason: log.reason || "",
        Source: "Live",
      };
    });

    // Recalculate category counts
    const catCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
    for (const row of printable) {
      const k = String(row.Category || "unknown").toLowerCase();
      if (catCounts[k] !== undefined) catCounts[k] += 1;
      else catCounts.unknown += 1;
    }

    // Generate new Excel file
    const sheet = xlsx.utils.json_to_sheet(printable);
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(book, sheet, "Results");

    const outBuffer = xlsx.write(book, {
      type: "buffer",
      bookType: "xlsx",
    });

    // Save to GridFS
    const saved = await saveBufferToGridFS(
      username,
      outBuffer,
      `result_${bulkId}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      { username, kind: "result", bulkId },
    );

    console.log(`✅ [BULK][${bulkId}] Result file regenerated successfully`);

    return { saved, catCounts };
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
      BulkStat,
    );

    const meta = await UserBulkStat.findOne({ bulkId });
    if (!meta) return res.status(404).send("Bulk session not found");

    // enforce flow:
    if (meta.state === "needs_fix" && !skipInvalidFormat) {
      return res
        .status(400)
        .send(
          "Invalid format emails exist. Download & fix or Skip & Continue.",
        );
    }

    // Choose input file for validation:
    const inputFileId = meta.cleanedFileId || meta.originalFileId;
    if (!inputFileId) return res.status(400).send("Input file missing");

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

          progressCurrent: 0,
          progressTotal: initialTotal,

          valid: 0,
          invalid: 0,
          risky: 0,
          unknown: 0,
        },
        $currentDate: { updatedAt: true },
      },
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
            },
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
          },
        );

        if (streamToRes) res.status(500).send("Unable to read input file");
        return;
      }

      // Build validation list:
      const seen = new Set();
      const toValidate = [];
      for (const r of rows) {
        if (isEmptyOrJunkRow(r, emailCol)) continue;

        const raw = String(r[emailCol] ?? "").trim();
        if (!raw) continue;

        const e = normEmail(raw);
        if (!EMAIL_RE.test(e)) continue;
        if (seen.has(e)) continue;

        seen.add(e);
        toValidate.push({ row: r, email: e });
      }

      const total = toValidate.length;

      // ---- init progress (WS + DB) ----
      sendProgressToFrontend(0, total, sessionId, username, bulkId);

      try {
        await UserBulkStat.updateOne(
          { bulkId },
          { $set: { progressCurrent: 0, progressTotal: total } },
        );
      } catch {}

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
            { $set: { progressCurrent: current, progressTotal: total0 } },
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
            runner,
          ),
        );

        return results;
      };

      // ───────────────────────────────────────────────────────────
      // ✅ UPDATED: YASH-LIKE VALIDATION LOGIC (impacts result)
      // ───────────────────────────────────────────────────────────
      const worker = async (item) => {
        if (deps.cancelMap?.get(bulkId)) throw new Error("CANCELED");

        const E = item.email;

        // Yash-like logger + extra console blocks
        const logger = (step, message, level = "info") => {
          console.log(
            `[BULK][${username}][${bulkId}][${E}] ${step} (${level}): ${message}`,
          );
        };

        let final = null;
        let usedCache = false;

        // remember SMTP-only result categories (for "trust SMTP valid")
        let smtpPrimaryCat = null;
        let smtpStableCat = null;

        const domain = extractDomain(E);

        // ─────────────────────────────────────────────────────────
        // 🇹🇼 .tw domain direct Risky: skip all validation entirely.
        //    SMTP cannot probe .tw domains reliably — return Risky immediately.
        // ─────────────────────────────────────────────────────────
        if (isTwDomain(domain)) {
          console.log(`[BULK][tw_direct_risky] ${E} → domain "${domain}" ends with .tw, returning Risky directly (no SMTP/SendGrid)`);
          const twFinal = {
            email: E, status: "Risky", subStatus: "tw_domain", confidence: 0.9,
            category: "risky", reason: "Restricted Country TLD",
            message: "This address belongs to a Taiwanese domain (.tw). SMTP probing is unreliable for .tw domains and sending cold emails is risky.",
            domain, domainProvider: "Taiwan (.tw)", isDisposable: false,
            isFree: false, isRoleBased: false, score: 30, timestamp: new Date(), section: "bulk",
          };
          await replaceLatest(EmailLog, E, { email: E, ...twFinal });
          await replaceLatest(UserEmailLog, E, { email: E, ...twFinal });
          const twCat = getOutcomeCategory(twFinal);
          await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, twCat);
          try {
            sendStatusToFrontend(E, twFinal.status, twFinal.timestamp, {
              domain: twFinal.domain, provider: twFinal.domainProvider,
              isDisposable: false, isFree: false, isRoleBased: false, score: twFinal.score,
              subStatus: twFinal.subStatus, confidence: twFinal.confidence,
              category: twFinal.category, message: twFinal.message, reason: twFinal.reason,
            }, sessionId, true, username);
          } catch {}
          return {
            Email: E, Status: "Risky", Timestamp: new Date(twFinal.timestamp).toLocaleString(),
            Domain: domain, Provider: "Taiwan (.tw)", Disposable: "No", Free: "No",
            RoleBased: "No", Score: 30, SubStatus: "tw_domain", Confidence: 0.9,
            Category: "risky", Message: twFinal.message, Reason: twFinal.reason, Source: "Live",
          };
        }
        const domainClassification = classifyDomain(domain) || {};
        const isBankOrHealthcare =
          !!domainClassification &&
          (domainClassification.isBank || domainClassification.isHealthcare);

        // ── EARLY EXIT: .edu/.org/.gov, bank, healthcare → Risky directly ──────
        // These domains are high-risk for cold email sending regardless of whether
        // they use Proofpoint/Mimecast. Skip all validation and return Risky.
        if (isOrgEduGovDomain(domain) || isBankOrHealthcare || isCcTLDDomain(domain)) {
          const subStatus = isOrgEduGovDomain(domain) ? 'org_edu_gov_domain'
            : isCcTLDDomain(domain) ? 'cctld_domain'
            : 'bank_healthcare_domain';
          const message = isOrgEduGovDomain(domain)
            ? 'This address belongs to an organizational, educational, or government domain (.org/.edu/.gov). Sending cold emails to these domains is risky.'
            : isCcTLDDomain(domain)
            ? 'This address belongs to a country-specific domain (ccTLD). Sending cold emails to country-specific domains is risky and may result in blocks or bounces.'
            : 'This address belongs to a banking or healthcare domain. Sending cold emails to these domains is risky.';

          console.log(`[BULK][early_risky] ${E} → domain "${domain}" is ${subStatus} → returning Risky directly`);

          const earlyRiskyFinal = {
            email: E,
            status: 'Risky',
            subStatus,
            confidence: 0.9,
            category: 'risky',
            reason: 'High-Risk Domain',
            message,
            domain,
            domainProvider: 'N/A',
            isDisposable: false,
            isFree: false,
            isRoleBased: false,
            score: 30,
            timestamp: new Date(),
            section: 'bulk',
          };

          await replaceLatest(EmailLog, E, { email: E, ...earlyRiskyFinal });
          await replaceLatest(UserEmailLog, E, { email: E, ...earlyRiskyFinal });
          const earlyRiskyCat = getOutcomeCategory(earlyRiskyFinal);
          await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, earlyRiskyCat);
          try {
            sendStatusToFrontend(E, earlyRiskyFinal.status, earlyRiskyFinal.timestamp, {
              domain: earlyRiskyFinal.domain, provider: earlyRiskyFinal.domainProvider,
              isDisposable: false, isFree: false, isRoleBased: false, score: earlyRiskyFinal.score,
              subStatus: earlyRiskyFinal.subStatus, confidence: earlyRiskyFinal.confidence,
              category: earlyRiskyFinal.category, message: earlyRiskyFinal.message, reason: earlyRiskyFinal.reason,
            }, sessionId, true, username);
          } catch {}
          return {
            Email: E, Status: 'Risky', Timestamp: new Date(earlyRiskyFinal.timestamp).toLocaleString(),
            Domain: domain, Provider: 'N/A', Disposable: 'No', Free: 'No',
            RoleBased: 'No', Score: 30, SubStatus: subStatus, Confidence: 0.9,
            Category: 'risky', Message: message, Reason: 'High-Risk Domain', Source: 'Live',
          };
        }

        let isProofpoint = false;
        try {
          isProofpoint = await isProofpointDomain(domain);
        } catch (e) {
          isProofpoint = false;
          logger("proofpoint_check_error", e.message || "failed", "warn");
        }

        let isMimecast = false;
        try {
          isMimecast = await isMimecastDomain(domain);
        } catch (e) {
          isMimecast = false;
          logger("mimecast_check_error", e.message || "failed", "warn");
        }

        // Yash-style domain logs
        console.log(`🔵 [BULK][${E}] Extracted domain: ${domain}`);
        console.log(
          `🔵 [BULK][${E}] Bank/Healthcare: ${isBankOrHealthcare ? "YES" : "NO"}`,
        );
        console.log(
          `🔵 [BULK][${E}] Proofpoint: ${isProofpoint ? "YES" : "NO"}`,
        );
        console.log(
          `🔵 [BULK][${E}] Mimecast: ${isMimecast ? "YES" : "NO"}`,
        );

        // Cache read (GLOBAL EmailLog)
        const cached = await EmailLog.findOne({ email: E }).sort({
          updatedAt: -1,
          createdAt: -1,
        });

        const fresh = cached
          ? Date.now() -
              new Date(
                cached.updatedAt || cached.createdAt || cached.timestamp || 0,
              ).getTime() <=
            FRESH_DB_MS
          : false;

        // If cached is UNKNOWN & bank/healthcare, proofpoint, or mimecast → force live
        const cachedCatForDecision = cached
          ? String(
              cached.category ||
                categoryFromStatus(cached.status || "") ||
                "unknown",
            ).toLowerCase()
          : null;

        // Never serve unknown results from cache — always re-validate
        const forceLiveBecauseCachedUnknown =
          !!cached &&
          fresh &&
          cachedCatForDecision === "unknown";

        if (cached && fresh && !forceLiveBecauseCachedUnknown) {
          usedCache = true;

          const builtCached = buildReasonAndMessage(
            cached.status,
            cached.subStatus || null,
            {
              isDisposable: !!cached.isDisposable,
              isRoleBased: !!cached.isRoleBased,
              isFree: !!cached.isFree,
            },
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
            { upsert: true, new: true },
          );

          final = {
            email: E,
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
          // ───────────────────────────────────────────────────────
          // 1) BANK/HEALTHCARE OR PROOFPOINT OR MIMECAST → SENDGRID FIRST (Yash)
          // ───────────────────────────────────────────────────────
          if (isBankOrHealthcare || isProofpoint || isMimecast) {
            const domainCategory = isBankOrHealthcare
              ? getDomainCategory(domain)
              : isMimecast
                ? "Mimecast Email Security"
                : "Proofpoint Email Protection";

            console.log(`\n${"=".repeat(60)}`);
            if (isBankOrHealthcare && (isProofpoint || isMimecast)) {
              const gatewayLabel = isProofpoint ? "PROOFPOINT" : "MIMECAST";
              console.log(`[BULK] BANK/HEALTHCARE + ${gatewayLabel}`);
            } else if (isBankOrHealthcare) {
              console.log(`🏦 [BULK] BANK/HEALTHCARE DOMAIN`);
            } else if (isMimecast) {
              console.log(`🛡️  [BULK] MIMECAST DOMAIN`);
            } else {
              console.log(`🛡️  [BULK] PROOFPOINT DOMAIN`);
            }
            console.log(`${"=".repeat(60)}`);
            console.log(`📧 Email: ${E}`);
            console.log(`🌐 Domain: ${domain}`);
            console.log(`🏷️  Category: ${domainCategory}`);
            console.log(`${"=".repeat(60)}\n`);

            logger(
              isBankOrHealthcare && isProofpoint
                ? "bank_healthcare_proofpoint"
                : isBankOrHealthcare
                  ? "bank_healthcare"
                  : "proofpoint",
              `${domainCategory} detected → using SendGrid verification`,
              "info",
            );

            // Domain reputation gate (for bank/healthcare) — Yash behavior
            if (isBankOrHealthcare) {
              try {
                const domainStats = await DomainReputation.findOne({ domain });

                if (domainStats && domainStats.sent >= 5) {
                  const bounceRate = domainStats.invalid / domainStats.sent;

                  console.log(`📊 [BULK][${E}] Domain Reputation:`);
                  console.log(`   Sent: ${domainStats.sent}`);
                  console.log(`   Invalid: ${domainStats.invalid}`);
                  console.log(
                    `   Bounce Rate: ${(bounceRate * 100).toFixed(1)}%`,
                  );

                  logger(
                    "domain_reputation",
                    `Sent=${domainStats.sent} Invalid=${domainStats.invalid} BounceRate=${(bounceRate * 100).toFixed(1)}%`,
                    "info",
                  );

                  if (bounceRate >= 0.6) {
                    console.log(
                      `⚠️  [BULK][${E}] HIGH BOUNCE RATE - Marking as risky\n`,
                    );

                    final = {
                      email: E,
                      status: "⚠️ Risky",
                      subStatus: "high_bounce_bank_healthcare",
                      confidence: 0.85,
                      category: "risky",
                      reason: "High Bounce Domain",
                      message: `This ${domainCategory} domain has a high bounce rate (${(bounceRate * 100).toFixed(1)}%). Sending to this address is risky.`,
                      domain,
                      domainProvider: domainCategory,
                      isDisposable: false,
                      isFree: false,
                      isRoleBased: false,
                      score: 20,
                      timestamp: new Date(),
                      section: "bulk",
                    };

                    await replaceLatest(EmailLog, E, { email: E, ...final });
                    await replaceLatest(UserEmailLog, E, {
                      email: E,
                      ...final,
                    });

                    // ✅ EARLY RETURN like Yash (this impacts correctness safety)
                    const cat = getOutcomeCategory(final);
                    await bumpLiveCounts(
                      UserBulkStat,
                      bulkId,
                      username,
                      sessionId,
                      cat,
                    );

                    // WS per item
                    try {
                      sendStatusToFrontend(
                        E,
                        final.status,
                        final.timestamp,
                        {
                          domain: final.domain,
                          provider: final.domainProvider,
                          isDisposable: false,
                          isFree: false,
                          isRoleBased: false,
                          score: final.score,
                          subStatus: final.subStatus,
                          confidence: final.confidence,
                          category: final.category,
                          message: final.message,
                          reason: final.reason,
                        },
                        sessionId,
                        true,
                        username,
                      );
                    } catch {}

                    return {
                      Email: E,
                      Status: final.status.replace(/^[^a-zA-Z0-9]+/, ""),
                      Timestamp: new Date(final.timestamp).toLocaleString(),
                      Domain: final.domain,
                      Provider: final.domainProvider,
                      Disposable: "No",
                      Free: "No",
                      RoleBased: "No",
                      Score: final.score,
                      SubStatus: final.subStatus,
                      Confidence: final.confidence,
                      Category: final.category,
                      Message: final.message,
                      Reason: final.reason,
                      Source: "Domain Reputation",
                    };
                  }
                } else {
                  console.log(
                    `📊 [BULK][${E}] Domain Reputation: No data or insufficient samples (< 5)`,
                  );
                }
              } catch (e) {
                logger("domain_reputation_error", e.message, "warn");
              }
            }

            // ── CATCH-ALL CHECK for Proofpoint/Mimecast domains ──────────────────
            // Before sending via SendGrid, probe a random address on the domain.
            // If the domain is catch-all → return Risky immediately (skip SendGrid).
            logger('catchall_check', `Checking if ${domain} is catch-all before SendGrid`, 'info');
            try {
              // probeIfNotCached: false — Proofpoint/Mimecast gateways always accept
              // emails at SMTP level, so an SMTP probe is meaningless AND very slow
              // (60-90s across multiple MX hosts). Only check the in-memory cache here.
              const isCatchAll = await checkDomainCatchAll(domain, { logger, probeIfNotCached: false });
              if (isCatchAll) {
                logger('catchall_check', `Domain ${domain} is catch-all → returning Risky directly`, 'warn');
                const catchAllFinal = {
                  email: E,
                  status: 'Risky',
                  subStatus: 'catch_all',
                  confidence: 0.75,
                  category: 'risky',
                  reason: 'Catch-All Domain',
                  message: 'Domain accepts any randomly generated address at SMTP (catch-all). All emails on this domain are marked risky.',
                  domain,
                  domainProvider: domainCategory,
                  isDisposable: false,
                  isFree: false,
                  isRoleBased: false,
                  score: 30,
                  timestamp: new Date(),
                  section: 'bulk',
                };
                await replaceLatest(EmailLog, E, { email: E, ...catchAllFinal });
                await replaceLatest(UserEmailLog, E, { email: E, ...catchAllFinal });
                const catchAllCat = getOutcomeCategory(catchAllFinal);
                await bumpLiveCounts(UserBulkStat, bulkId, username, sessionId, catchAllCat);
                try {
                  sendStatusToFrontend(E, catchAllFinal.status, catchAllFinal.timestamp, {
                    domain: catchAllFinal.domain, provider: catchAllFinal.domainProvider,
                    isDisposable: false, isFree: false, isRoleBased: false, score: catchAllFinal.score,
                    subStatus: catchAllFinal.subStatus, confidence: catchAllFinal.confidence,
                    category: catchAllFinal.category, message: catchAllFinal.message, reason: catchAllFinal.reason,
                  }, sessionId, true, username);
                } catch {}
                return {
                  Email: E, Status: 'Risky', Timestamp: new Date(catchAllFinal.timestamp).toLocaleString(),
                  Domain: domain, Provider: domainCategory, Disposable: 'No', Free: 'No',
                  RoleBased: 'No', Score: 30, SubStatus: 'catch_all', Confidence: 0.75,
                  Category: 'risky', Message: catchAllFinal.message, Reason: catchAllFinal.reason, Source: 'Live',
                };
              }
            } catch (catchAllErr) {
              logger('catchall_check_error', `Catch-all check failed: ${catchAllErr.message} → proceeding with SendGrid`, 'warn');
            }

            // Proofpoint / Mimecast: skip SMTP (they greylist/block probes) → go directly to SendGrid
            logger("smtp_existence_check", `Skipping SMTP check for ${domainCategory} (gateway blocks SMTP probes) → going directly to SendGrid`, "info");

            console.log(`✅ [BULK][${E}] Proceeding to SendGrid\n`);

            try {
              console.log(`🚀 [BULK][${E}] Starting SendGrid verification...`);
              const t0 = Date.now();
              const sgResult = await verifySendGrid(E, {
                logger,
                trainingTag: "bulk",
              });
              const elapsed = Date.now() - t0;

              console.log(
                `\n✅ [BULK][${E}] SendGrid Response (${elapsed}ms):`,
              );
              console.log(`   Status: ${sgResult.status}`);
              console.log(`   Category: ${sgResult.category}`);
              console.log(`   Sub-Status: ${sgResult.sub_status || "N/A"}`);

              // Convert to TrueSendr format
              const metaSg = {
                domain,
                flags: { disposable: false, free: false, role: false },
              };
              const result = toTrueSendrFormat(sgResult, metaSg);

              console.log(`\n📊 [BULK][${E}] TrueSendr Format:`);
              console.log(`   Status: ${result.status}`);
              console.log(`   Category: ${result.category}`);
              console.log(`   Score: ${result.score}`);

              // Log SendGrid raw
              try {
                await SendGridLog.create({
                  email: E,
                  domain,
                  status: sgResult.status,
                  sub_status: sgResult.sub_status,
                  category: sgResult.category,
                  confidence: sgResult.confidence || 0.5,
                  score: result.score || 50,
                  reason: sgResult.reason,
                  messageId: sgResult.messageId,
                  statusCode: sgResult.statusCode,
                  method: sgResult.method || "web_api",
                  isProofpoint: !!isProofpoint,
                  isFallback: false,
                  provider: `${domainCategory} (via SendGrid)`,
                  elapsed_ms: sgResult.elapsed_ms,
                  error: sgResult.error,
                  username,
                  sessionId,
                  bulkId,
                  isDisposable: result.isDisposable,
                  isFree: result.isFree,
                  isRoleBased: result.isRoleBased,
                  rawResponse: sgResult,
                  elapsed_client_ms: elapsed,
                });
                console.log(`✅ [BULK][${E}] SendGridLog saved`);
              } catch (logErr) {
                logger("sendgrid_log_error", logErr.message, "warn");
              }

              console.log(`\n📚 [BULK][${E}] Building email history...`);
              const history = await buildHistoryForEmail(E);
              console.log(`   Domain samples: ${history.domainSamples || 0}`);
              console.log(
                `   Training samples: ${history.trainingSamples || 0}`,
              );

              const merged = mergeSMTPWithHistory(result, history, {
                domain: result.domain || domain,
                provider: result.provider || domainCategory,
              });

              const subStatus = merged.sub_status || merged.subStatus || null;
              const status = merged.status || result.status || "❔ Unknown";
              const cat = merged.category || categoryFromStatus(status || "");

              const confidence =
                typeof merged.confidence === "number"
                  ? merged.confidence
                  : typeof result.confidence === "number"
                    ? result.confidence
                    : null;

              const built = buildReasonAndMessage(status, subStatus, {
                isDisposable: !!merged.isDisposable,
                isRoleBased: !!merged.isRoleBased,
                isFree: !!merged.isFree,
              });

              final = {
                email: E,
                status,
                subStatus,
                confidence,
                category: cat,
                reason: merged.reason || built.reasonLabel,
                message: merged.message || built.message,
                domain: merged.domain || domain,
                domainProvider: merged.provider || domainCategory,
                isDisposable: !!merged.isDisposable,
                isFree: !!merged.isFree,
                isRoleBased: !!merged.isRoleBased,
                score:
                  typeof merged.score === "number"
                    ? merged.score
                    : (result.score ?? 50),
                timestamp: new Date(),
                section: "bulk",
              };

              await replaceLatest(EmailLog, E, { email: E, ...final });
              await replaceLatest(UserEmailLog, E, { email: E, ...final });

              console.log(`\n✅ [BULK][${E}] SENDGRID VALIDATION COMPLETE`);
              console.log(`${"=".repeat(60)}\n`);
            } catch (sgErr) {
              logger("sendgrid_error", sgErr.message, "warn");
              // fall through to SMTP path
            }
          }

          // ───────────────────────────────────────────────────────
          // 2) SMTP PRELIM (Yash) → if unknown → SendGrid fallback
          // ───────────────────────────────────────────────────────
          if (!final) {
            console.log(`\n🔍 [BULK][${E}] Starting SMTP validation...`);
            const prelimRaw = await validateSMTP(E, {
              logger,
              trainingTag: "bulk",
            });

            console.log(`\n✅ [BULK][${E}] SMTP Preliminary Result:`);
            console.log(`   Status: ${prelimRaw.status}`);
            console.log(`   Category: ${prelimRaw.category}`);
            console.log(`   Sub-Status: ${prelimRaw.sub_status || "N/A"}`);

            smtpPrimaryCat =
              prelimRaw.category || categoryFromStatus(prelimRaw.status);

            // Yash uses strict check: prelimRaw.category === "unknown"
            if (prelimRaw.category === "unknown") {
              console.log(
                `\n⚠️  [BULK][${E}] SMTP returned UNKNOWN → Attempting SendGrid fallback...`,
              );

              try {
                console.log(`🚀 [BULK][${E}] Starting SendGrid fallback...`);
                const t0 = Date.now();
                const sgResult = await verifySendGrid(E, {
                  logger,
                  trainingTag: "bulk",
                });
                const elapsed = Date.now() - t0;

                console.log(
                  `\n✅ [BULK][${E}] SendGrid Fallback (${elapsed}ms):`,
                );
                console.log(`   Status: ${sgResult.status}`);
                console.log(`   Category: ${sgResult.category}`);

                const metaSg = {
                  domain,
                  flags: { disposable: false, free: false, role: false },
                };
                const sgTrueSendrResult = toTrueSendrFormat(sgResult, metaSg);

                try {
                  await SendGridLog.create({
                    email: E,
                    domain,
                    status: sgResult.status,
                    sub_status: sgResult.sub_status,
                    category: sgResult.category,
                    confidence: sgResult.confidence || 0.5,
                    score: sgTrueSendrResult.score || 50,
                    reason: sgResult.reason,
                    messageId: sgResult.messageId,
                    statusCode: sgResult.statusCode,
                    method: sgResult.method || "web_api",
                    isProofpoint: false,
                    isFallback: true,
                    smtpCategory: prelimRaw.category,
                    smtpSubStatus: prelimRaw.sub_status,
                    provider: prelimRaw.provider || "Unknown (SMTP fallback)",
                    elapsed_ms: sgResult.elapsed_ms,
                    error: sgResult.error,
                    username,
                    sessionId,
                    bulkId,
                    isDisposable: sgTrueSendrResult.isDisposable,
                    isFree: sgTrueSendrResult.isFree,
                    isRoleBased: sgTrueSendrResult.isRoleBased,
                    rawResponse: sgResult,
                    elapsed_client_ms: elapsed,
                  });
                  console.log(`✅ [BULK][${E}] SendGridLog saved (fallback)`);
                } catch (logErr) {
                  logger("sendgrid_log_error", logErr.message, "warn");
                }

                console.log(`\n📚 [BULK][${E}] Building email history...`);
                const history = await buildHistoryForEmail(E);

                const merged = mergeSMTPWithHistory(
                  sgTrueSendrResult,
                  history,
                  {
                    domain: sgTrueSendrResult.domain || domain,
                    provider:
                      sgTrueSendrResult.provider || "SendGrid (fallback)",
                  },
                );

                const subStatus = merged.sub_status || merged.subStatus || null;
                const status =
                  merged.status || sgTrueSendrResult.status || "❔ Unknown";
                const cat = merged.category || categoryFromStatus(status || "");

                const confidence =
                  typeof merged.confidence === "number"
                    ? merged.confidence
                    : typeof sgTrueSendrResult.confidence === "number"
                      ? sgTrueSendrResult.confidence
                      : null;

                const built = buildReasonAndMessage(status, subStatus, {
                  isDisposable: !!merged.isDisposable,
                  isRoleBased: !!merged.isRoleBased,
                  isFree: !!merged.isFree,
                });

                final = {
                  email: E,
                  status,
                  subStatus,
                  confidence,
                  category: cat,
                  reason: merged.reason || built.reasonLabel,
                  message: merged.message || built.message,
                  domain: merged.domain || domain,
                  domainProvider: merged.provider || "SendGrid (fallback)",
                  isDisposable: !!merged.isDisposable,
                  isFree: !!merged.isFree,
                  isRoleBased: !!merged.isRoleBased,
                  score:
                    typeof merged.score === "number"
                      ? merged.score
                      : (sgTrueSendrResult.score ?? 50),
                  timestamp: new Date(),
                  section: "bulk",
                };

                await replaceLatest(EmailLog, E, { email: E, ...final });
                await replaceLatest(UserEmailLog, E, { email: E, ...final });

                console.log(`\n✅ [BULK][${E}] SENDGRID FALLBACK COMPLETE`);
                console.log(`   Original SMTP: ${prelimRaw.category}`);
                console.log(`   SendGrid Result: ${sgResult.category}\n`);
              } catch (sgError) {
                logger("sendgrid_fallback_error", sgError.message, "warn");
                console.log(
                  `⚠️  [BULK][${E}] SendGrid fallback failed → continue SMTP merge\n`,
                );
              }
            }

            // If still not final: merge SMTP prelim with history
            if (!final) {
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
                  },
                );

                final = {
                  email: E,
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
                      : (prelimRaw.score ?? 0),
                  section: "bulk",
                };

                await replaceLatest(EmailLog, E, { email: E, ...final });
                await replaceLatest(UserEmailLog, E, { email: E, ...final });
              } else {
                // ───────────────────────────────────────────────
                // 3) SMTP STABLE (Yash) → if unknown → SendGrid fallback
                // ───────────────────────────────────────────────
                try {
                  console.log(
                    `\n🔍 [BULK][${E}] Starting SMTP stable validation...`,
                  );
                  const stableRaw = await validateSMTPStable(E, {
                    logger,
                    trainingTag: "bulk",
                  });

                  console.log(`\n✅ [BULK][${E}] SMTP Stable Result:`);
                  console.log(`   Status: ${stableRaw.status}`);
                  console.log(`   Category: ${stableRaw.category}`);
                  console.log(
                    `   Sub-Status: ${stableRaw.sub_status || "N/A"}`,
                  );

                  smtpStableCat =
                    stableRaw.category || categoryFromStatus(stableRaw.status);

                  // Yash strict: stableRaw.category === "unknown"
                  if (stableRaw.category === "unknown") {
                    console.log(
                      `\n⚠️  [BULK][${E}] SMTP Stable returned UNKNOWN → Attempting SendGrid fallback...`,
                    );

                    try {
                      console.log(
                        `🚀 [BULK][${E}] Starting SendGrid fallback (stable)...`,
                      );
                      const t0 = Date.now();
                      const sgResult = await verifySendGrid(E, {
                        logger,
                        trainingTag: "bulk",
                      });
                      const elapsed = Date.now() - t0;

                      console.log(
                        `\n✅ [BULK][${E}] SendGrid Fallback (${elapsed}ms):`,
                      );
                      console.log(`   Status: ${sgResult.status}`);
                      console.log(`   Category: ${sgResult.category}`);

                      const metaSg = {
                        domain,
                        flags: { disposable: false, free: false, role: false },
                      };
                      const sgTrueSendrResult = toTrueSendrFormat(
                        sgResult,
                        metaSg,
                      );

                      try {
                        await SendGridLog.create({
                          email: E,
                          domain,
                          status: sgResult.status,
                          sub_status: sgResult.sub_status,
                          category: sgResult.category,
                          confidence: sgResult.confidence || 0.5,
                          score: sgTrueSendrResult.score || 50,
                          reason: sgResult.reason,
                          messageId: sgResult.messageId,
                          statusCode: sgResult.statusCode,
                          method: sgResult.method || "web_api",
                          isProofpoint: false,
                          isFallback: true,
                          smtpCategory: stableRaw.category,
                          smtpSubStatus: stableRaw.sub_status,
                          provider:
                            stableRaw.provider ||
                            "Unknown (SMTP stable fallback)",
                          elapsed_ms: sgResult.elapsed_ms,
                          error: sgResult.error,
                          username,
                          sessionId,
                          bulkId,
                          isDisposable: sgTrueSendrResult.isDisposable,
                          isFree: sgTrueSendrResult.isFree,
                          isRoleBased: sgTrueSendrResult.isRoleBased,
                          rawResponse: sgResult,
                          elapsed_client_ms: elapsed,
                        });
                        console.log(
                          `✅ [BULK][${E}] SendGridLog saved (stable fallback)`,
                        );
                      } catch (logErr) {
                        logger("sendgrid_log_error", logErr.message, "warn");
                      }

                      console.log(
                        `\n📚 [BULK][${E}] Building email history...`,
                      );
                      const history = await buildHistoryForEmail(E);

                      const merged = mergeSMTPWithHistory(
                        sgTrueSendrResult,
                        history,
                        {
                          domain: sgTrueSendrResult.domain || domain,
                          provider:
                            sgTrueSendrResult.provider ||
                            "SendGrid (stable fallback)",
                        },
                      );

                      const subStatus =
                        merged.sub_status || merged.subStatus || null;
                      const status =
                        merged.status ||
                        sgTrueSendrResult.status ||
                        "❔ Unknown";
                      const cat =
                        merged.category || categoryFromStatus(status || "");

                      const confidence =
                        typeof merged.confidence === "number"
                          ? merged.confidence
                          : typeof sgTrueSendrResult.confidence === "number"
                            ? sgTrueSendrResult.confidence
                            : null;

                      const built = buildReasonAndMessage(status, subStatus, {
                        isDisposable: !!merged.isDisposable,
                        isRoleBased: !!merged.isRoleBased,
                        isFree: !!merged.isFree,
                      });

                      final = {
                        email: E,
                        status,
                        subStatus,
                        confidence,
                        category: cat,
                        reason: merged.reason || built.reasonLabel,
                        message: merged.message || built.message,
                        domain: merged.domain || domain,
                        domainProvider:
                          merged.provider || "SendGrid (stable fallback)",
                        isDisposable: !!merged.isDisposable,
                        isFree: !!merged.isFree,
                        isRoleBased: !!merged.isRoleBased,
                        score:
                          typeof merged.score === "number"
                            ? merged.score
                            : (sgTrueSendrResult.score ?? 50),
                        timestamp: new Date(),
                        section: "bulk",
                      };

                      await replaceLatest(EmailLog, E, { email: E, ...final });
                      await replaceLatest(UserEmailLog, E, {
                        email: E,
                        ...final,
                      });

                      console.log(
                        `\n✅ [BULK][${E}] SENDGRID STABLE FALLBACK COMPLETE`,
                      );
                      console.log(
                        `   Original SMTP Stable: ${stableRaw.category}`,
                      );
                      console.log(`   SendGrid Result: ${sgResult.category}\n`);
                    } catch (sgError) {
                      logger(
                        "sendgrid_stable_fallback_error",
                        sgError.message,
                        "warn",
                      );
                      console.log(
                        `⚠️  [BULK][${E}] SendGrid stable fallback failed → continue SMTP stable merge\n`,
                      );
                    }
                  }

                  // If still not final: merge stable SMTP with history
                  if (!final) {
                    const historyStable = await buildHistoryForEmail(E);

                    const stable = mergeSMTPWithHistory(
                      stableRaw,
                      historyStable,
                      {
                        domain: stableRaw.domain || extractDomain(E),
                        provider: stableRaw.provider || "Unavailable",
                      },
                    );

                    const subStatusS =
                      stable.sub_status || stable.subStatus || null;
                    const catS =
                      stable.category || categoryFromStatus(stable.status);

                    const builtStable = buildReasonAndMessage(
                      stable.status,
                      subStatusS,
                      {
                        isDisposable: !!stable.isDisposable,
                        isRoleBased: !!stable.isRoleBased,
                        isFree: !!stable.isFree,
                      },
                    );

                    final = {
                      email: E,
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
                        typeof stable.score === "number" ? stable.score : 0,
                      section: "bulk",
                    };

                    await replaceLatest(EmailLog, E, { email: E, ...final });
                    await replaceLatest(UserEmailLog, E, {
                      email: E,
                      ...final,
                    });
                  }
                } catch {
                  const builtUnknown = buildReasonAndMessage(
                    "❔ Unknown",
                    null,
                    {},
                  );
                  final = {
                    email: E,
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
          }
        }

        // ✅ Yash rule: always trust SMTP Valid over history downgrade to Risky
        if (final) {
          const smtpCat = smtpStableCat || smtpPrimaryCat || null;
          const finalCat = categoryFromStatus(final.status || "");
          if (smtpCat === "valid" && finalCat === "risky") {
            final.category = "valid";
            final.status = "✅ Valid";
          }
        }

        // ─────────────────────────────────────────────────────────
        // 🏦 Bank domain override: if validation returned Valid AND
        //    the domain contains "bank" → downgrade to Risky.
        //    (Domain is good and mailbox exists, but banking domains
        //     are high-risk for cold email sending.)
        // ─────────────────────────────────────────────────────────
        if (final && (final.category === "valid" || categoryFromStatus(final.status || "") === "valid") && hasBankWordInDomain(domain)) {
          console.log(`[BULK][bank_override] ${E} → domain "${domain}" contains "bank", overriding Valid → Risky`);
          final.status = "Risky";
          final.category = "risky";
          final.subStatus = "bank_domain";
          final.score = Math.min(typeof final.score === "number" ? final.score : 50, 45);
          final.reason = "Banking Domain";
          final.message = "This address belongs to a banking/financial domain. Sending cold emails to banking domains is risky and may result in blocks or bounces.";
          // Persist the overridden result
          await replaceLatest(EmailLog, E, { email: E, ...final });
          await replaceLatest(UserEmailLog, E, { email: E, ...final });
        }

        // ─────────────────────────────────────────────────────────
        // 🏛️ .org / .edu / .gov domain override: if validation returned
        //    Valid AND domain ends with .org, .edu, or .gov → downgrade
        //    to Risky. These are organizational, educational, and
        //    government domains that are high-risk for cold email sending.
        // ─────────────────────────────────────────────────────────
        if (final && final.category !== "invalid" && categoryFromStatus(final.status || "") !== "invalid" && isOrgEduGovDomain(domain)) {
          console.log(`[BULK][org_edu_gov_override] ${E} → domain "${domain}" ends with .org/.edu/.gov/.mx, overriding ${final.category} → Risky`);
          final.status = "Risky";
          final.category = "risky";
          final.subStatus = "org_edu_gov_domain";
          final.score = Math.min(typeof final.score === "number" ? final.score : 50, 45);
          final.reason = "Restricted Domain TLD";
          final.message = "This address belongs to an organizational, educational, government, or country-specific domain (.org/.edu/.gov/.mx). Sending cold emails to these domains is risky and may result in blocks or bounces.";
          // Persist the overridden result
          await replaceLatest(EmailLog, E, { email: E, ...final });
          await replaceLatest(UserEmailLog, E, { email: E, ...final });
        }

        // ─────────────────────────────────────────────────────────
        // 🌍 ccTLD domain override: any 2-letter country code TLD
        // ─────────────────────────────────────────────────────────
        if (final && final.category !== "invalid" && categoryFromStatus(final.status || "") !== "invalid" && isCcTLDDomain(domain)) {
          console.log(`[BULK][cctld_override] ${E} → domain "${domain}" has 2-letter ccTLD, overriding ${final.category} → Risky`);
          final.status = "Risky";
          final.category = "risky";
          final.subStatus = "cctld_domain";
          final.score = Math.min(typeof final.score === "number" ? final.score : 50, 45);
          final.reason = "Country-Specific Domain";
          final.message = "This address belongs to a country-specific domain (ccTLD). Sending cold emails to country-specific domains is risky and may result in blocks or bounces.";
          // Persist the overridden result
          await replaceLatest(EmailLog, E, { email: E, ...final });
          await replaceLatest(UserEmailLog, E, { email: E, ...final });
        }

        try {
          const d0 = final.domain || extractDomain(E);
          const provider =
            final.domainProvider || final.provider || "Unavailable";

          sendStatusToFrontend(
            E,
            final.status || "❔ Unknown",
            final.timestamp || null,
            {
              domain: d0,
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
            username,
          );
        } catch {}

        const cat = getOutcomeCategory(final);
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
            sendProgressToFrontend(done, total0, sessionId, username, bulkId),
        );

        console.log(
          `\n✅ [BULK][${bulkId}] All emails processed. Checking for SendGrid emails...`,
        );

        // ============================================================
        // ✅ STEP 1: Track SendGrid emails that need webhook confirmation
        // ============================================================
        const sendgridMessageIds = [];
        const sendGridLogs = await SendGridLog.find({
          bulkId,
          messageId: { $exists: true, $ne: null },
        })
          .select("messageId email")
          .lean();

        sendGridLogs.forEach((log) => {
          if (log.messageId) {
            sendgridMessageIds.push(log.messageId);
          }
        });

        console.log(
          `📊 [BULK][${bulkId}] Found ${sendgridMessageIds.length} SendGrid emails awaiting webhooks`,
        );

        // ============================================================
        // ✅ STEP 2: If SendGrid emails exist, wait for webhooks
        // ============================================================
        if (sendgridMessageIds.length > 0) {
          console.log(`⏸️  [BULK][${bulkId}] Entering webhook wait state...`);

          // Update state to waiting_for_webhooks
          await UserBulkStat.findOneAndUpdate(
            { bulkId },
            {
              $set: {
                state: "waiting_for_webhooks",
                phase: "waiting_for_webhooks",
                sendgridEmailCount: sendgridMessageIds.length,
                sendgridPendingCount: sendgridMessageIds.length,
                sendgridMessageIds: sendgridMessageIds,
                webhookTimeoutAt: new Date(Date.now() + 20000), // 20 second timeout
              },
            },
          );

          // Send progress update to frontend
          if (sendBulkStatsToFrontend && sessionId) {
            sendBulkStatsToFrontend(sessionId, username, {
              bulkId,
              state: "waiting_for_webhooks",
              phase: "waiting_for_webhooks",
              message: `Waiting for ${sendgridMessageIds.length} delivery confirmations...`,
              sendgridPending: sendgridMessageIds.length,
              sendgridTotal: sendgridMessageIds.length,
              progressCurrent: total,
              progressTotal: total,
            });
          }

          // Wait for webhooks
          await waitForSendGridWebhooks(
            bulkId,
            username,
            sessionId,
            UserBulkStat,
          );

          console.log(
            `✅ [BULK][${bulkId}] Webhook wait complete. Regenerating result file...`,
          );

          // ============================================================
          // ✅ STEP 3: Regenerate result file with updated statuses
          // ============================================================
          const { saved: regeneratedSaved, catCounts: regeneratedCounts } =
            await regenerateResultFile(
              bulkId,
              username,
              UserEmailLog,
              UserBulkStat,
              toValidate,
            );

          const finalCreditsUsed =
            (regeneratedCounts.valid || 0) +
            (regeneratedCounts.invalid || 0) +
            (regeneratedCounts.risky || 0);

          if (finalCreditsUsed > 0) {
            await User.updateOne(
              { username },
              { $inc: { credits: -finalCreditsUsed } },
            );
          }

          // Update BulkStat with regenerated file and final counts
          await UserBulkStat.updateOne(
            { bulkId },
            {
              $set: {
                state: "done",
                phase: "done",
                finishedAt: new Date(),
                resultFileId: regeneratedSaved.id,
                resultMime: regeneratedSaved.contentType,
                resultSize: regeneratedSaved.length,
                creditsUsed: finalCreditsUsed,

                valid: regeneratedCounts.valid,
                invalid: regeneratedCounts.invalid,
                risky: regeneratedCounts.risky,
                unknown: regeneratedCounts.unknown,

                progressCurrent: total,
                progressTotal: total,
              },
              $currentDate: { updatedAt: true },
            },
          );

          if (sessionId) {
            sendBulkStatsToFrontend(sessionId, username, {
              type: "bulk:done",
              bulkId,
              state: "done",
              phase: "done",
              finishedAt: new Date().toISOString(),
              creditsUsed: finalCreditsUsed,
              counts: { ...regeneratedCounts },
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
              { mode: "bulk", counts: { ...regeneratedCounts, requests: 1 } },
            );
          } catch (e) {
            console.warn("dashstat (bulk) inc failed:", e.message);
          }

          if (sessionId)
            setTimeout(
              () =>
                deps.progressStore.delete(`${username}:${sessionId}:${bulkId}`),
              60_000,
            );

          if (streamToRes) {
            res.setHeader("Content-Type", regeneratedSaved.contentType);
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="validated_emails.xlsx"`,
            );
            bucket(username).openDownloadStream(regeneratedSaved.id).pipe(res);
          }
        } else {
          // ============================================================
          // ✅ NO SendGrid emails - complete immediately (original flow)
          // ============================================================
          console.log(
            `✅ [BULK][${bulkId}] No SendGrid emails - completing immediately`,
          );

          const printable = processed.filter(Boolean);
          const catCounts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
          for (const row of printable) {
            const k = String(row.Category || "unknown").toLowerCase();
            if (catCounts[k] !== undefined) catCounts[k] += 1;
            else catCounts.unknown += 1;
          }

          const finalCreditsUsed =
            (catCounts.valid || 0) +
            (catCounts.invalid || 0) +
            (catCounts.risky || 0);

          if (finalCreditsUsed > 0) {
            await User.updateOne(
              { username },
              { $inc: { credits: -finalCreditsUsed } },
            );
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
            { username, kind: "result", bulkId },
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
                creditsUsed: finalCreditsUsed,

                valid: catCounts.valid,
                invalid: catCounts.invalid,
                risky: catCounts.risky,
                unknown: catCounts.unknown,

                progressCurrent: total,
                progressTotal: total,
              },
              $currentDate: { updatedAt: true },
            },
          );

          if (sessionId) {
            sendBulkStatsToFrontend(sessionId, username, {
              type: "bulk:done",
              bulkId,
              state: "done",
              phase: "done",
              finishedAt: new Date().toISOString(),
              creditsUsed: finalCreditsUsed,
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
              { mode: "bulk", counts: { ...catCounts, requests: 1 } },
            );
          } catch (e) {
            console.warn("dashstat (bulk) inc failed:", e.message);
          }

          if (sessionId)
            setTimeout(
              () =>
                deps.progressStore.delete(`${username}:${sessionId}:${bulkId}`),
              60_000,
            );

          if (streamToRes) {
            res.setHeader("Content-Type", saved.contentType);
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="validated_emails.xlsx"`,
            );
            bucket(username).openDownloadStream(saved.id).pipe(res);
          }
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
            },
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
          },
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
              },
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
      BulkStat,
    );

    const doc = await UserBulkStat.findOneAndUpdate(
      { bulkId },
      { $set: { sessionId }, $currentDate: { updatedAt: true } },
      { new: true },
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
      BulkStat,
    );

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
        ].join(" "),
      );

    const items = docs.map((d) => {
      const processedCounts =
        (d.valid || 0) + (d.invalid || 0) + (d.risky || 0) + (d.unknown || 0);

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
      BulkStat,
    );

    await UserBulkStat.updateOne(
      { bulkId },
      {
        $set: { state: "canceled", phase: "canceled", finishedAt: new Date() },
        $currentDate: { updatedAt: true },
      },
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
        BulkStat,
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
      BulkStat,
    );

    const doc = await UserBulkStat.findOne({ bulkId });
    if (!doc || !doc.originalFileId)
      return res.status(404).send("Original not found");

    res.setHeader(
      "Content-Type",
      doc.originalMime || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${doc.originalName || "uploaded.xlsx"}"`,
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
      BulkStat,
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
      }"`,
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
      "attachment; filename=email_template.xlsx",
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
        BulkStat,
      );

      const docs = await UserBulkStat.find({ state: { $in: states } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(
          "bulkId originalName uniqueValid creditsRequired state createdAt startedAt finishedAt resultFileId valid invalid risky unknown",
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
  // meta (single job state) - lightweight status fetch
  // ───────────────────────────────────────────────────────────
  router.get("/meta", async (req, res) => {
    const username = req.headers["x-user"] || req.query.username;
    const bulkId = req.query.bulkId;

    if (!username || !bulkId)
      return res.status(400).json({ error: "username and bulkId required" });

    const { BulkStat: UserBulkStat } = deps.getUserDb(
      mongoose,
      EmailLog,
      RegionStat,
      DomainReputation,
      username,
      BulkStat,
    );

    try {
      const d = await UserBulkStat.findOne({ bulkId })
        .select(
          "bulkId state phase progressCurrent progressTotal valid invalid risky unknown creditsUsed creditsRequired finishedAt resultFileId updatedAt",
        )
        .lean();

      if (!d) return res.status(404).json({ error: "Bulk not found" });

      return res.json({
        bulkId: d.bulkId,
        state: d.state,
        phase: d.phase,
        progress: {
          current: d.progressCurrent || 0,
          total: d.progressTotal || 0,
        },
        counts: {
          valid: d.valid || 0,
          invalid: d.invalid || 0,
          risky: d.risky || 0,
          unknown: d.unknown || 0,
        },
        creditsUsed: d.creditsUsed || 0,
        creditsRequired: d.creditsRequired || 0,
        finishedAt: d.finishedAt || null,
        canDownload: !!d.resultFileId,
        updatedAt: d.updatedAt || null,
      });
    } catch (e) {
      return res.status(500).json({ error: "Meta fetch failed" });
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
      BulkStat,
    );

    if (bid) {
      let storeCurrent = 0;
      let storeTotal = 0;

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

      let dbCurrent = 0;
      let dbTotal = 0;

      try {
        const doc = await UserBulkStat.findOne({ bulkId: bid })
          .select("progressCurrent progressTotal")
          .lean();

        dbCurrent = doc?.progressCurrent || 0;
        dbTotal = doc?.progressTotal || 0;
      } catch {}

      const total = Math.max(storeTotal, dbTotal, 0);
      const current = Math.min(total, Math.max(storeCurrent, dbCurrent, 0));

      return res.json({ bulkId: bid, current, total });
    }

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
