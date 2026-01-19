// utils/fileCleaner.js
// -----------------------------------------------------------------------------
// Pure file cleaning logic for TrueSendr File Cleaner (no SMTP, no DB).
// -----------------------------------------------------------------------------

const { v4: uuidv4 } = require("uuid");

// role-based localparts
const ROLE_BASED_LOCALPARTS = [
  "admin",
  "administrator",
  "support",
  "help",
  "info",
  "contact",
  "sales",
  "marketing",
  "billing",
  "accounts",
  "hr",
  "jobs",
  "career",
  "careers",
  "office",
  "hello",
  "team",
  "no-reply",
  "noreply",
];

// default free domains (override with env FREE_DOMAINS if you want)
const DEFAULT_FREE_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "aol.com",
  "yandex.com",
  "zoho.com",
];

// helpers to load env lists
function parseListEnv(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

const FREE_DOMAINS = parseListEnv("FREE_DOMAINS", DEFAULT_FREE_DOMAINS);
const BANK_DOMAINS = parseListEnv("BANK_DOMAINS", []);
const HIGH_RISK_DOMAINS = parseListEnv("HIGH_RISK_DOMAINS", []);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function extractDomain(emailNorm) {
  const atIdx = emailNorm.indexOf("@");
  if (atIdx === -1) return "";
  return emailNorm.slice(atIdx + 1);
}

function extractLocalPart(emailNorm) {
  const atIdx = emailNorm.indexOf("@");
  if (atIdx === -1) return "";
  return emailNorm.slice(0, atIdx);
}

// very simple syntax validation (we are not doing RFC-level checks)
function looksLikeValidFormat(emailNorm) {
  if (!emailNorm) return false;
  if (emailNorm.includes(" ")) return false;
  if (!emailNorm.includes("@")) return false;
  const parts = emailNorm.split("@");
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  if (!local || !domain) return false;
  if (!domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;

  // basic characters check
  if (/[(),;:<>[\]]/.test(emailNorm)) return false;

  return true;
}

function isJunkEmptyValue(emailNormRaw) {
  const v = String(emailNormRaw || "").trim().toLowerCase();
  if (!v) return true;
  const junkSet = new Set([
    "null",
    "n/a",
    "na",
    "test",
    "testing",
    "sample",
    "-",
    "--",
  ]);
  return junkSet.has(v);
}

function isRoleBased(localPartNorm) {
  if (!localPartNorm) return false;
  const base = localPartNorm.toLowerCase();
  if (ROLE_BASED_LOCALPARTS.includes(base)) return true;

  // some startsWith patterns
  if (base.startsWith("hr-") || base.startsWith("info-")) return true;
  if (base.startsWith("support-") || base.startsWith("sales-")) return true;

  return false;
}

function isFreeDomain(domainNorm) {
  if (!domainNorm) return false;
  return FREE_DOMAINS.includes(domainNorm);
}

function isBankDomain(domainNorm) {
  if (!domainNorm) return false;
  return BANK_DOMAINS.includes(domainNorm);
}

function isHighRiskDomain(domainNorm) {
  if (!domainNorm) return false;
  if (HIGH_RISK_DOMAINS.includes(domainNorm)) return true;
  // also treat bank domains as high-security / high-risk for sending
  if (BANK_DOMAINS.includes(domainNorm)) return true;
  return false;
}

// extremely simple "fake-looking" detection
function isFakeLooking(localPartNorm) {
  const v = localPartNorm.toLowerCase();

  if (!v) return true; // empty local is invalid anyway

  // typical test words
  if (
    v.includes("test") ||
    v.includes("demo") ||
    v.includes("fake") ||
    v.includes("dummy") ||
    v.includes("temp")
  ) {
    return true;
  }

  // keyboard mash patterns
  const mash = ["asdf", "qwerty", "zxcv", "1234", "0000"];
  if (mash.some((m) => v.includes(m))) return true;

  // many repeated same char
  if (/^(.)\1{3,}@?/.test(v)) return true;

  return false;
}

// domain type tag, used only for output columns
function getDomainType(domainNorm) {
  if (!domainNorm) return "unknown";
  if (isBankDomain(domainNorm)) return "high_security";
  if (isHighRiskDomain(domainNorm)) return "high_risk";
  if (isFreeDomain(domainNorm)) return "free";
  return "b2b";
}

// -----------------------------------------------------------------------------
// Detect email column from rows (sheet_to_json result)
// -----------------------------------------------------------------------------

function detectEmailColumn(rows) {
  if (!rows || rows.length === 0) return null;
  const firstRow = rows[0];
  const keys = Object.keys(firstRow);

  if (keys.length === 0) return null;

  // try exact matches
  for (const k of keys) {
    const kk = k.trim().toLowerCase();
    if (kk === "email" || kk === "e-mail" || kk === "mail") return k;
  }

  // try partial matches containing "email"
  for (const k of keys) {
    if (k.toLowerCase().includes("email")) return k;
  }

  // fallback: first column
  return keys[0];
}

// -----------------------------------------------------------------------------
// Main cleaning function
// -----------------------------------------------------------------------------

/**
 * Clean rows using options.
 *
 * @param {Array<object>} rows - raw rows from XLSX.sheet_to_json
 * @param {object} options - cleaning options from frontend
 * @returns {{ jobId, stats, cleanRows, invalidRows, duplicateRows, emailColumn }}
 */
function cleanFileRows(rows, options = {}) {
  const {
    removeDuplicates = true,
    removeInvalidFormat = true,
    removeEmpty = true,
    removeRoleBased = false,
    removeFreeDomains = false,
    removeFakeLooking = false,
    removeHighRiskDomains = false,
    tagDomainType = true,
  } = options;

  const emailColumn = detectEmailColumn(rows);
  const totalRows = rows.length;

  const seenEmails = new Set();

  const cleanRows = [];
  const invalidRows = [];
  const duplicateRows = [];

  const stats = {
    totalRows,
    cleanRows: 0,
    removedDuplicates: 0,
    removedInvalidFormat: 0, // includes empties if removeEmpty true
    removedRoleBased: 0,
    removedFreeDomains: 0,
    removedFakeLooking: 0,
    removedHighRiskDomains: 0,
  };

  if (!emailColumn || totalRows === 0) {
    return {
      jobId: uuidv4(),
      stats,
      cleanRows,
      invalidRows,
      duplicateRows,
      emailColumn: emailColumn || null,
    };
  }

  for (const rawRow of rows) {
    const row = { ...rawRow };
    const emailRaw = row[emailColumn];
    const emailNorm = normEmail(emailRaw);

    let shouldDrop = false;
    let reasonInvalid = null;

    // mark domain & local
    const domainNorm = extractDomain(emailNorm);
    const localPartNorm = extractLocalPart(emailNorm);

    // 1) empty / junk
    if (removeEmpty && isJunkEmptyValue(emailNorm)) {
      shouldDrop = true;
      reasonInvalid = "empty_or_junk";
      stats.removedInvalidFormat += 1;
    }

    // 2) format
    if (!shouldDrop && removeInvalidFormat && !looksLikeValidFormat(emailNorm)) {
      shouldDrop = true;
      reasonInvalid = "invalid_format";
      stats.removedInvalidFormat += 1;
    }

    // 3) role-based
    if (!shouldDrop && removeRoleBased && isRoleBased(localPartNorm)) {
      shouldDrop = true;
      reasonInvalid = "role_based";
      stats.removedRoleBased += 1;
    }

    // 4) free domains
    if (!shouldDrop && removeFreeDomains && isFreeDomain(domainNorm)) {
      shouldDrop = true;
      reasonInvalid = "free_domain";
      stats.removedFreeDomains += 1;
    }

    // 5) fake-looking
    if (!shouldDrop && removeFakeLooking && isFakeLooking(localPartNorm)) {
      shouldDrop = true;
      reasonInvalid = "fake_looking";
      stats.removedFakeLooking += 1;
    }

    // 6) high-risk / bank domains
    if (!shouldDrop && removeHighRiskDomains && isHighRiskDomain(domainNorm)) {
      shouldDrop = true;
      reasonInvalid = "high_risk_domain";
      stats.removedHighRiskDomains += 1;
    }

    // duplicates (only after we have a syntactically valid email string)
    if (!shouldDrop && emailNorm) {
      if (seenEmails.has(emailNorm)) {
        if (removeDuplicates) {
          shouldDrop = true;
          reasonInvalid = "duplicate";
          stats.removedDuplicates += 1;
          duplicateRows.push({
            ...row,
            __cleaner_reason: "duplicate",
            __cleaner_email_norm: emailNorm,
          });
        }
      } else {
        seenEmails.add(emailNorm);
      }
    }

    // add domain type (tag only for rows that we keep)
    if (tagDomainType) {
      row.__cleaner_email = emailNorm || "";
      row.__cleaner_domain = domainNorm || "";
      row.__cleaner_domain_type = getDomainType(domainNorm);
    }

    if (shouldDrop) {
      invalidRows.push({
        ...row,
        __cleaner_reason: reasonInvalid || "dropped",
        __cleaner_email_norm: emailNorm,
      });
    } else {
      // fix email value in main column to normalized
      row[emailColumn] = emailNorm;
      cleanRows.push(row);
    }
  }

  stats.cleanRows = cleanRows.length;

  return {
    jobId: uuidv4(),
    stats,
    cleanRows,
    invalidRows,
    duplicateRows,
    emailColumn,
  };
}

module.exports = {
  cleanFileRows,
};
