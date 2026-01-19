// This module centralizes all environment variable handling.
// It reads values from process.env (loaded via dotenv),
// applies defaults, normalizes formats, and exposes a single
// source of truth (ENV) for the entire backend.
// The application must never read process.env directly elsewhere.




// truesendr/backend/config/env.js
function csvToArray(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeUrl(v) {
  const s = String(v || "").trim();
  return s.replace(/\/+$/, "");
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  return String(v).toLowerCase() === "true";
}

const APP_ENV =
  (process.env.APP_ENV || "").trim() ||
  (process.env.NODE_ENV === "production" ? "production" : "local");

const IS_PROD = APP_ENV === "production";
const IS_TESTING = APP_ENV === "testing";
const IS_LOCAL = APP_ENV === "local";

const PORTSERVER = Number(process.env.PORTSERVER || 5000);

const FRONTEND_URL = normalizeUrl(process.env.FRONTEND_URL || "");
const PUBLIC_BASE_URL = normalizeUrl(process.env.PUBLIC_BASE_URL || "");

const ALLOWED_ORIGINS = Array.from(
  new Set(
    [
      ...csvToArray(process.env.ALLOWED_ORIGINS),
      FRONTEND_URL, // include frontend URL if provided
    ].filter(Boolean)
  )
);

const REQUIRE_AUTH = bool(process.env.REQUIRE_AUTH, false);
const BULK_REQUIRE_AUTH = bool(process.env.BULK_REQUIRE_AUTH, false);

function assertProdRequired() {
  if (!IS_PROD) return;

  const required = [
    ["MONGO_URI", process.env.MONGO_URI],
    ["FRONTEND_URL", FRONTEND_URL],
    ["ALLOWED_ORIGINS", ALLOWED_ORIGINS.length ? "ok" : ""],
  ];

  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Missing required env vars for production: ${missing.join(", ")}`
    );
  }
}

module.exports = {
  APP_ENV,
  IS_PROD,
  IS_TESTING,
  IS_LOCAL,

  PORTSERVER,
  FRONTEND_URL,
  PUBLIC_BASE_URL,

  ALLOWED_ORIGINS,

  REQUIRE_AUTH,
  BULK_REQUIRE_AUTH,

  csvToArray,
  normalizeUrl,
  assertProdRequired,
};
