// routes/fileCleaner.js
// -----------------------------------------------------------------------------
// TrueSendr File Cleaner routes
// -----------------------------------------------------------------------------

const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { cleanFileRows } = require("../utils/fileCleaner");

const router = express.Router();

const EXCEL_CELL_CHAR_LIMIT = 32767;

// convert any value into something safe for xlsx export
function toExcelSafeValue(value) {
  if (value === null || value === undefined) return "";

  // keep numbers / booleans / dates as-is where possible
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value;

  let str = String(value);

  // remove null chars which may break xml/xlsx writing
  str = str.replace(/\u0000/g, "");

  // Excel cell text limit
  if (str.length > EXCEL_CELL_CHAR_LIMIT) {
    str = str.slice(0, EXCEL_CELL_CHAR_LIMIT);
  }

  return str;
}

// sanitize every row before creating worksheet
function makeRowsExcelSafe(rows = []) {
  return rows.map((row) => {
    const safeRow = {};
    for (const [key, value] of Object.entries(row || {})) {
      safeRow[key] = toExcelSafeValue(value);
    }
    return safeRow;
  });
}

// in-memory job store (TTL-based)
const jobStore = new Map();

// default TTL: 30 minutes
const TTL_MS =
  Number(process.env.FILE_CLEANER_TTL_MS || 30 * 60 * 1000) || 30 * 60 * 1000;

// memory storage (no temp files on disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB, same style as your other routes
  },
});

// small helper to schedule cleanup
function saveJob(jobId, payload) {
  jobStore.set(jobId, {
    ...payload,
    createdAt: Date.now(),
  });

  setTimeout(() => {
    jobStore.delete(jobId);
  }, TTL_MS);
}

// -----------------------------------------------------------------------------
// POST /api/file-cleaner/clean
// -----------------------------------------------------------------------------

router.post("/clean", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ ok: false, message: "No file uploaded for cleaning." });
    }

    let options = {};
    if (req.body && req.body.options) {
      try {
        options = JSON.parse(req.body.options);
      } catch (e) {
        return res
          .status(400)
          .json({ ok: false, message: "Invalid options JSON." });
      }
    }

    // read workbook from buffer
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });

    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      return res
        .status(400)
        .json({ ok: false, message: "Uploaded file has no sheets." });
    }

    const sheet = wb.Sheets[sheetName];

    // convert to json rows
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "", // keep empty cells as empty strings
    });

    const {
      jobId,
      stats,
      cleanRows,
      invalidRows,
      duplicateRows,
      emailColumn,
    } = cleanFileRows(rows, options);

    // store in memory
    saveJob(jobId, {
      stats,
      cleanRows,
      invalidRows,
      duplicateRows,
      emailColumn,
      originalFilename: req.file.originalname || "file",
    });

    // limit preview to first 20 cleaned rows
    const preview = cleanRows.slice(0, 20);

    return res.json({
      ok: true,
      message: "File cleaned successfully.",
      stats,
      preview,
      jobId,
    });
  } catch (err) {
    console.error("FileCleaner /clean error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to clean file." });
  }
});

// -----------------------------------------------------------------------------
// GET /api/file-cleaner/download/:jobId?type=clean|invalid|duplicates
// -----------------------------------------------------------------------------

router.get("/download/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const type = String(req.query.type || "clean").toLowerCase();

    const job = jobStore.get(jobId);
    if (!job) {
      return res
        .status(404)
        .json({ ok: false, message: "Job not found or expired." });
    }

    let rowsToExport;
    let defaultNameSuffix;

    if (type === "invalid") {
      rowsToExport = job.invalidRows || [];
      defaultNameSuffix = "invalid";
    } else if (type === "duplicates") {
      rowsToExport = job.duplicateRows || [];
      defaultNameSuffix = "duplicates";
    } else {
      rowsToExport = job.cleanRows || [];
      defaultNameSuffix = "cleaned";
    }

    if (!rowsToExport || rowsToExport.length === 0) {
      const ws = XLSX.utils.json_to_sheet([]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

      const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="file-cleaner-${defaultNameSuffix}.xlsx"`
      );

      return res.send(buf);
    }

    const safeRowsToExport = makeRowsExcelSafe(rowsToExport);

    const ws = XLSX.utils.json_to_sheet(safeRowsToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

    const baseName = (job.originalFilename || "file")
      .replace(/\.(xlsx|xls|csv)$/i, "")
      .replace(/[^a-zA-Z0-9_\-]+/g, "_");

    const filename = `${baseName}_${defaultNameSuffix}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    return res.send(buf);
  } catch (err) {
    console.error("FileCleaner /download error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to download file." });
  }
});

module.exports = router;