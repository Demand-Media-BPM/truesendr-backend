// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const axios = require("axios");

const User = require("../models/User");
const SignupToken = require("../models/SignupToken");
const PasswordResetToken = require("../models/PasswordResetToken"); // 👈 NEW
const {
  sendActivationEmail,
  sendPasswordResetEmail,
} = require("../mail/mailer"); // 👈 NEW

const router = express.Router();

const CODE_TTL_SEC = 5 * 60; // ✅ OTP valid for 5 minutes
const RESEND_MIN_INTERVAL_MS = 60 * 1000; // ✅ resend enabled after 1 minute
const MAX_RESENDS = 5;
const MAX_ATTEMPTS = 10;

// 👇 NEW: password reset link TTL
const PASSWORD_RESET_TTL_SEC = 15 * 60; // 15 minutes

/* ---------- helpers ---------- */
function normalizeNamePart(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      // non-alphanumeric → underscore
      .replace(/[^a-z0-9]+/g, "_")
      // collapse multiple underscores
      .replace(/_+/g, "_")
      // trim leading/trailing underscores
      .replace(/^_+|_+$/g, "")
  );
}

// ✅ Block free mail providers at signup (business email only)
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.in",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "gmx.com",
  "mail.com",
  "rediffmail.com",
]);

function getEmailDomain(email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  const at = e.lastIndexOf("@");
  if (at === -1) return "";
  return e.slice(at + 1);
}

function assertBusinessEmail(email) {
  const domain = getEmailDomain(email);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) {
    return {
      ok: false,
      code: "BUSINESS_EMAIL_REQUIRED",
      message: "Please use a business/company email (free emails not allowed).",
    };
  }
  return { ok: true };
}

function secondsLeftFrom(lastSentAt, msInterval) {
  const diff = Date.now() - new Date(lastSentAt).getTime();
  const leftMs = Math.max(0, msInterval - diff);
  return Math.ceil(leftMs / 1000);
}

async function generateUniqueUsername(firstName, lastName, maxTries = 50) {
  const baseFirst = normalizeNamePart(firstName);
  const baseLast = normalizeNamePart(lastName);

  // join with underscore instead of dot
  let base = [baseFirst, baseLast].filter(Boolean).join("_") || "user";

  // final cleanup on base (just in case)
  base = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  for (let i = 0; i < maxTries; i++) {
    const rand =
      i < 100
        ? String(Math.floor(Math.random() * 100)).padStart(2, "0")
        : String(Math.floor(Math.random() * 1000)).padStart(3, "0");

    // use underscore before number
    let candidate = `${base}_${rand}`;

    candidate = candidate
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    const exists = await User.findOne({ username: candidate });
    if (!exists) return candidate;
  }

  // last resort: timestamp suffix
  let fallback = `${base}_${Date.now().toString().slice(-4)}`;
  fallback = fallback
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return fallback || "user_" + Date.now().toString().slice(-4);
}

// random 6-digit code (signup)
function genCode() {
  return ("" + (crypto.randomInt(0, 1_000_000) + 1_000_000)).slice(-6);
}

// Google reCAPTCHA v2 verify (used by signup; optional for other routes)
async function verifyRecaptcha(token, ip) {
  if (!token) return false;
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    console.error("Missing RECAPTCHA_SECRET_KEY");
    return false;
  }
  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    if (ip) params.append("remoteip", ip);

    const { data } = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      params,
    );
    return !!data?.success;
  } catch (e) {
    console.error("reCAPTCHA verify error:", e?.response?.data || e.message);
    return false;
  }
}

// Mongo-safe DB name from username
function dbNameFromUsername(username) {
  const base = String(username || "")
    .trim()
    .toLowerCase();
  const cleaned = base.replace(/[^a-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = `${cleaned || "user"}-emailTool`;
  return name.slice(0, 63);
}

// create per-user DB (by username)
async function createPerUserDb(username) {
  const dbName = dbNameFromUsername(username);
  const userConn = mongoose.connection.useDb(dbName, { useCache: true });
  await Promise.allSettled([
    userConn.createCollection("domainreputations"),
    userConn.createCollection("emaillogs"),
    userConn.createCollection("regionstats"),
  ]);
}

/* ---------- signup routes (unchanged) ---------- */

router.post("/auth/request-code", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { firstName, lastName, email, password, captchaToken } = body || {};

    if (!firstName || !lastName || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: "All fields are required." });
    }

    // reCAPTCHA check
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const human = await verifyRecaptcha(captchaToken, clientIp);
    if (!human) {
      return res
        .status(400)
        .json({ ok: false, message: "Captcha failed. Please try again." });
    }

    const normEmail = String(email).toLowerCase().trim();

    // ✅ NEW: business email only
    const bizCheck = assertBusinessEmail(normEmail);
    if (!bizCheck.ok) {
      return res.status(400).json(bizCheck);
    }

    // Email must be unique
    const uByEmail = await User.findOne({ email: normEmail });
    if (uByEmail) {
      return res.status(400).json({
        ok: false,
        message: "An account with this email already exists.",
      });
    }

    // 👉 generate username here
    const genUsername = await generateUniqueUsername(firstName, lastName);

    const passwordHash = await bcrypt.hash(password, 10);
    const code = genCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_SEC * 1000);

    const existing = await SignupToken.findOne({ email: normEmail });
    if (!existing) {
      await SignupToken.create({
        email: normEmail,
        username: genUsername, // 👈 store generated username
        firstName,
        lastName,
        passwordHash,
        codeHash,
        attempts: 0,
        resendCount: 1,
        lastSentAt: new Date(),
        expiresAt,
      });
    } else {
      await SignupToken.updateOne(
        { _id: existing._id },
        {
          $set: {
            username: genUsername, // 👈 overwrite with a fresh generated username
            firstName,
            lastName,
            passwordHash,
            codeHash,
            lastSentAt: new Date(),
            expiresAt,
          },
          $inc: { resendCount: 1 },
        },
      );
    }

    try {
      await sendActivationEmail(normEmail, code);
      return res.json({
        ok: true,
        expiresInSec: CODE_TTL_SEC, // ✅ 300
        resendCooldownSec: Math.ceil(RESEND_MIN_INTERVAL_MS / 1000), // ✅ 60
      });
    } catch (err) {
      console.error("❌ Failed to send signup email:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Could not send activation email." });
    }
  } catch (err) {
    console.error("request-code error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error while sending code." });
  }
});

router.post("/auth/resend-code", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { email } = body || {};

    if (!email) {
      return res.status(400).json({ ok: false, message: "Email required." });
    }

    const normEmail = String(email).toLowerCase().trim();
    const token = await SignupToken.findOne({ email: normEmail });

    if (!token) {
      return res
        .status(404)
        .json({ ok: false, message: "Request a new signup first." });
    }
    // ✅ If OTP window is over (5 mins), token is invalid → force signup again
    if (new Date(token.expiresAt).getTime() < Date.now()) {
      await SignupToken.deleteOne({ _id: token._id }); // extra safe (TTL may delete later)
      return res.status(410).json({
        ok: false,
        code: "SIGNUP_EXPIRED",
        message: "OTP expired. Please go back and sign up again.",
      });
    }

    // ✅ protection still ON (no captcha needed)
    if (token.resendCount >= MAX_RESENDS) {
      return res
        .status(429)
        .json({ ok: false, message: "Too many resends. Try again later." });
    }

    const now = Date.now();
    const elapsed = now - new Date(token.lastSentAt).getTime();

    if (elapsed < RESEND_MIN_INTERVAL_MS) {
      const retryAfterSec = secondsLeftFrom(
        token.lastSentAt,
        RESEND_MIN_INTERVAL_MS,
      );
      return res.status(429).json({
        ok: false,
        message: "Please wait before resending.",
        retryAfterSec, // ✅ frontend timer uses this
      });
    }

    const code = genCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_SEC * 1000);

    await SignupToken.updateOne(
      { _id: token._id },
      {
        $set: { codeHash, expiresAt, lastSentAt: new Date() },
        $inc: { resendCount: 1 },
      },
    );

    try {
      await sendActivationEmail(normEmail, code);
      return res.json({
        ok: true,
        expiresInSec: CODE_TTL_SEC,
        resendCooldownSec: Math.ceil(RESEND_MIN_INTERVAL_MS / 1000), // ✅ 300
      });
    } catch (err) {
      console.error("❌ Failed to resend signup email:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Could not resend activation email." });
    }
  } catch (err) {
    console.error("resend-code error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error while resending code." });
  }
});

router.post("/auth/verify-code", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { email, code } = body || {};
    if (!email || !code)
      return res
        .status(400)
        .json({ ok: false, message: "Email and code required." });

    const normEmail = String(email).toLowerCase().trim();
    const token = await SignupToken.findOne({ email: normEmail });
    if (!token)
      return res
        .status(400)
        .json({ ok: false, message: "No pending signup for this email." });

    if (new Date(token.expiresAt).getTime() < Date.now()) {
      await SignupToken.deleteOne({ _id: token._id }); // remove now (TTL may delete slightly later)
      return res.status(410).json({
        ok: false,
        code: "SIGNUP_EXPIRED",
        message: "OTP expired. Please go back and sign up again.",
      });
    }

    if (token.attempts >= MAX_ATTEMPTS) {
      await SignupToken.deleteOne({ _id: token._id });
      return res.status(429).json({
        ok: false,
        message: "Too many attempts. Please request a new code.",
      });
    }

    const ok = await bcrypt.compare(String(code), token.codeHash);
    if (!ok) {
      await SignupToken.updateOne(
        { _id: token._id },
        { $inc: { attempts: 1 } },
      );
      return res.status(400).json({ ok: false, message: "Invalid code." });
    }

    const [uByName, uByEmail] = await Promise.all([
      User.findOne({ username: token.username }),
      User.findOne({ email: token.email }),
    ]);
    if (uByName || uByEmail) {
      await SignupToken.deleteOne({ _id: token._id });
      return res.json({
        ok: true,
        message: "Account already exists. You can log in.",
      });
    }

    const newUser = await User.create({
      username: token.username,
      email: token.email,
      password: token.passwordHash,
      firstName: token.firstName,
      lastName: token.lastName,
      permissions: ["single", "bulk"],
      credits: 100,
    });
    console.log(
      `[users] saved _id=${newUser._id} into db=${mongoose.connection.name}.collection=users`,
    );

    await createPerUserDb(token.username);

    await SignupToken.deleteOne({ _id: token._id });
    return res.json({ ok: true, message: "Account created." });
  } catch (err) {
    console.error("verify-code error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error while verifying code." });
  }
});

/* ---------- login route (as before) ---------- */

router.post("/auth/login", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { email, password } = body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password required." });
    }

    const normEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normEmail });

    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(String(password), user.password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    return res.json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id,
        username: user.username, // internal use
        email: user.email, // tray email
        firstName: user.firstName, // 👈 add
        lastName: user.lastName, // 👈 add
        permissions: user.permissions || [],
        credits: user.credits ?? 0,
      },
    });
  } catch (err) {
    console.error("❌ /auth/login error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error during login" });
  }
});

// Request reset link (by email only). Always responds OK (no user enumeration).
router.post("/auth/forgot-password", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { email } = body || {};
    if (!email) {
      return res.status(400).json({ ok: false, message: "Email required." });
    }

    const normEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normEmail });

    // Always pretend success to avoid email enumeration
    if (!user) {
      return res.status(404).json({
        ok: false,
        code: "USER_NOT_FOUND",
        message: "This email is not registered. Please sign up.",
      });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SEC * 1000);

    await PasswordResetToken.deleteMany({ email: user.email });
    await PasswordResetToken.create({
      email: user.email,
      tokenHash,
      expiresAt,
    });

    const base = process.env.FRONTEND_URL || "https://localhost:3000";
    const resetLink = `${base.replace(
      /\/+$/,
      "",
    )}/reset-password?email=${encodeURIComponent(
      user.email,
    )}&token=${rawToken}`;

    try {
      await sendPasswordResetEmail(user.email, resetLink);
      return res.json({
        ok: true,
        message: "If an account exists, a reset link was sent.",
      });
    } catch (err) {
      console.error("❌ Failed to send password reset email:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Could not send password reset email." });
    }
  } catch (err) {
    console.error("forgot-password error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error while sending reset link." });
  }
});

// Complete reset (set new password)
router.post("/auth/reset-password", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { email, token, newPassword, confirmPassword } = body || {};

    if (!email || !token || !newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ ok: false, message: "All fields are required." });
    }
    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ ok: false, message: "Passwords do not match." });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 6 characters.",
      });
    }

    const normEmail = String(email).toLowerCase().trim();
    const prt = await PasswordResetToken.findOne({ email: normEmail });
    if (!prt) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired token." });
    }
    if (prt.used || new Date(prt.expiresAt).getTime() < Date.now()) {
      await PasswordResetToken.deleteOne({ _id: prt._id });
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired token." });
    }

    const tokenOk = await bcrypt.compare(String(token), prt.tokenHash);
    if (!tokenOk) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired token." });
    }

    const user = await User.findOne({ email: normEmail });
    if (!user) {
      await PasswordResetToken.deleteOne({ _id: prt._id });
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired token." });
    }

    const newHash = await bcrypt.hash(String(newPassword), 10);
    user.password = newHash;
    user.lastPasswordUpdate = new Date(); // 👈 update timestamp
    await user.save();

    // Invalidate token
    await PasswordResetToken.deleteOne({ _id: prt._id });

    return res.json({ ok: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("reset-password error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Server error while resetting password." });
  }
});

module.exports = router;
