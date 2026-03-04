// routes/payment.js
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const axios = require("axios");
const nodemailer = require("nodemailer");
const RazorpayOrder = require("../models/RazorpayOrder");
const CreditsLedger = require("../models/CreditsLedger");
const User = require("../models/User");
const { COUNTRY_TAX_MAP, getTaxInfo } = require("../utils/countryTaxMap");

// helper: parse Buffer body (because webhook uses raw body)
function parseMaybeBufferBody(req) {
  if (Buffer.isBuffer(req.body)) {
    const s = req.body.toString("utf8") || "{}";
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

// helper: signature verify for checkout success (order_id|payment_id)
function verifyCheckoutSignature({ order_id, payment_id, signature, secret }) {
  const body = `${order_id}|${payment_id}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return expected === signature;
}

// helper: webhook signature verify (raw body)
function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody) // ✅ raw buffer
    .digest("hex");

  // ✅ Razorpay sends hex signature
  return String(expected) === String(signature);
}

// ---------------------------------------------------------------------------
// FX (USD -> Local Currency) via ExchangeRate-API (cached daily)
// ---------------------------------------------------------------------------

// Minimal mapping (add more anytime)
const COUNTRY_CURRENCY_MAP = {
  US: "USD",
  IN: "INR",
  GB: "GBP",
  AE: "AED",
  AU: "AUD",
  CA: "CAD",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  CH: "CHF",
  SG: "SGD",
  JP: "JPY",
  KR: "KRW",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  NG: "NGN",
  SA: "SAR",
  TR: "TRY",
  RU: "RUB",
  CN: "CNY",
  HK: "HKD",
  TW: "TWD",
  TH: "THB",
  MY: "MYR",
  ID: "IDR",
  PH: "PHP",
  VN: "VND",
  PK: "PKR",
  BD: "BDT",
  LK: "LKR",
  NP: "NPR",
  IL: "ILS",
  EG: "EGP",
  AR: "ARS",
  CL: "CLP",
  CO: "COP",
  PE: "PEN",
};

function getCurrencyCode(countryCode) {
  const cc = String(countryCode || "").toUpperCase();
  return COUNTRY_CURRENCY_MAP[cc] || "USD";
}

// In-memory cache (per Node process; good enough for "cached per day")
const FX_CACHE = {
  dateUTC: null, // "YYYY-MM-DD"
  base: "USD",
  rates: null, // conversion_rates object from API
  lastUpdateUnix: null,
  nextUpdateUnix: null,
};

function utcDateKeyNow() {
  // YYYY-MM-DD in UTC
  return new Date().toISOString().slice(0, 10);
}

async function getUsdRatesCached() {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY || "";
  if (!apiKey) {
    // No key configured -> fallback (no conversion)
    return { ok: false, base: "USD", rates: { USD: 1 } };
  }

  const todayKey = utcDateKeyNow();

  // ✅ Cache hit for today
  if (FX_CACHE.dateUTC === todayKey && FX_CACHE.rates) {
    return {
      ok: true,
      base: FX_CACHE.base,
      rates: FX_CACHE.rates,
      lastUpdateUnix: FX_CACHE.lastUpdateUnix,
      nextUpdateUnix: FX_CACHE.nextUpdateUnix,
      cached: true,
      dateUTC: FX_CACHE.dateUTC,
    };
  }

  // ✅ Fetch fresh once/day
  const url = `https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKey)}/latest/USD`;
  try {
    const { data } = await axios.get(url, { timeout: 6000 });

    if (String(data?.result) !== "success" || !data?.conversion_rates) {
      return { ok: false, base: "USD", rates: { USD: 1 } };
    }

    FX_CACHE.dateUTC = todayKey;
    FX_CACHE.base = String(data?.base_code || "USD");
    FX_CACHE.rates = data.conversion_rates;
    FX_CACHE.lastUpdateUnix = Number(data?.time_last_update_unix || 0) || null;
    FX_CACHE.nextUpdateUnix = Number(data?.time_next_update_unix || 0) || null;

    return {
      ok: true,
      base: FX_CACHE.base,
      rates: FX_CACHE.rates,
      lastUpdateUnix: FX_CACHE.lastUpdateUnix,
      nextUpdateUnix: FX_CACHE.nextUpdateUnix,
      cached: false,
      dateUTC: FX_CACHE.dateUTC,
    };
  } catch (e) {
    return { ok: false, base: "USD", rates: { USD: 1 } };
  }
}

async function getUsdToCurrencyRate(currencyCode) {
  const cur = String(currencyCode || "USD").toUpperCase();
  if (cur === "USD") return { currency: "USD", rate: 1, meta: { ok: true } };

  const fx = await getUsdRatesCached();
  const r = Number(fx?.rates?.[cur] || 0);

  // If rate missing -> fallback to USD
  if (!Number.isFinite(r) || r <= 0) {
    return { currency: cur, rate: 1, meta: { ok: false, fallback: true, fx } };
  }

  return { currency: cur, rate: r, meta: { ok: true, fx } };
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const ip = req.ip || req.connection?.remoteAddress || "";
  return String(ip).replace("::ffff:", "").trim();
}

async function geoFromIpInfo(req) {
  const token = process.env.IPINFO_TOKEN || "";
  if (!token) return { countryCode: "US", countryName: "United States" };

  const ip = getClientIp(req);
  try {
    const url = `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`;
    const { data } = await axios.get(url, { timeout: 4000 });

    const countryCode = String(data?.country || "US").toUpperCase();
    const taxInfo = getTaxInfo(countryCode);

    return { countryCode, countryName: taxInfo.countryName };
  } catch {
    return { countryCode: "US", countryName: "United States" };
  }
}

function computeAmounts({ credits, pricePerCredit, taxRate }) {
  const subTotal = credits * pricePerCredit;
  const tax = subTotal * taxRate;
  const total = subTotal + tax;
  return { subTotal, tax, total };
}

// ---- Currency -> minor units helpers (Razorpay amount is always integer minor units) ----
// Default is 2 decimals for most currencies.
// Add more if needed.
const CURRENCY_MINOR_UNITS = {
  USD: 2,
  INR: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  ZAR: 2,
  SAR: 2,
  TRY: 2,
  BRL: 2,
  MXN: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
};

function toMinorUnits(amountMajor, currencyCode) {
  const cur = String(currencyCode || "USD").toUpperCase();
  const decimals = CURRENCY_MINOR_UNITS[cur] ?? 2;
  const factor = Math.pow(10, decimals);
  return Math.round((Number(amountMajor) || 0) * factor);
}

module.exports = function paymentRouter(_deps = {}) {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // SMTP transporter (Gmail SMTP from .env)
  // ---------------------------------------------------------------------------
  const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
  const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
  const SMTP_SECURE = String(process.env.SMTP_SECURE || "false") === "true";
  const SMTP_USER = process.env.SMTP_USER || "";
  const SMTP_PASS = process.env.SMTP_PASS || "";
  const MAIL_FROM = process.env.MAIL_FROM || `Truesendr <${SMTP_USER}>`;

  const ENTERPRISE_LEAD_TO = [
    "jenny.j@truesendr.com",
    "saurabh.s@demandmediabpm.com",
  ].join(",");

  const mailer =
    SMTP_USER && SMTP_PASS
      ? nodemailer.createTransport({
          host: SMTP_HOST,
          port: SMTP_PORT,
          secure: SMTP_SECURE,
          auth: { user: SMTP_USER, pass: SMTP_PASS },
        })
      : null;

  const key_id = process.env.RAZORPAY_KEY_ID || "";
  const key_secret = process.env.RAZORPAY_KEY_SECRET || "";
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

  if (!key_id || !key_secret) {
    console.warn(
      "⚠️ Razorpay keys missing: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET",
    );
  }
  if (!webhookSecret) {
    console.warn(
      "⚠️ Razorpay webhook secret missing: set RAZORPAY_WEBHOOK_SECRET",
    );
  }

  // ---------------------------------------------------------------------------
  // GET /api/payment/razorpay/tax-info
  // Returns: country + tax name + tax rate (server-side geo)
  // ---------------------------------------------------------------------------
  router.get("/razorpay/tax-info", async (req, res) => {
    try {
      const geo = await geoFromIpInfo(req);
      const taxInfo = getTaxInfo(geo.countryCode);
      const currencyCode = getCurrencyCode(geo.countryCode);
      const fx = await getUsdToCurrencyRate(currencyCode);

      return res.json({
        ok: true,
        country: {
          code: geo.countryCode,
          name: taxInfo.countryName,
        },
        tax: {
          name: taxInfo.taxName,
          rate: taxInfo.taxRate,
          note: taxInfo.note || "",
        },

        // ✅ NEW (display-only helpers)
        currency: {
          code: fx.currency, // e.g. INR
          base: "USD",
          usdToLocalRate: fx.rate, // 1 USD -> X INR
          cacheDateUTC: fx?.meta?.fx?.dateUTC || null,
          timeLastUpdateUnix: fx?.meta?.fx?.lastUpdateUnix || null,
          timeNextUpdateUnix: fx?.meta?.fx?.nextUpdateUnix || null,
        },
      });
    } catch (err) {
      console.error("❌ tax-info error:", err);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/payment/razorpay/enterprise-lead
  // Sends enterprise "Contact Us" details to internal emails
  // ---------------------------------------------------------------------------
  router.post("/razorpay/enterprise-lead", async (req, res) => {
    try {
      if (!mailer) {
        return res.status(500).json({
          ok: false,
          message:
            "SMTP not configured on server (missing SMTP_USER/SMTP_PASS).",
        });
      }

      const body = parseMaybeBufferBody(req);

      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim();
      const jobTitle = String(body.jobTitle || "").trim();
      const companyName = String(body.companyName || "").trim();
      const countryCode = String(body.countryCode || "").trim();
      const countryName = String(body.countryName || "").trim();
      const dialCode = String(body.dialCode || "").trim();
      const phone = String(body.phone || "").trim();
      const volume = String(body.volume || "").trim();
      const username = String(body.username || "").trim();
      const page = String(body.page || "Enterprise Lead").trim();

      if (!name || !email) {
        return res.status(400).json({
          ok: false,
          message: "Name and Company Email are required.",
        });
      }

      const subject = `TrueSendr Enterprise Request: ${name}${companyName ? " • " + companyName : ""}`;

      const text = [
        `Enterprise Plan Request`,
        `----------------------`,
        `Name: ${name}`,
        `Company Email: ${email}`,
        `Job Title: ${jobTitle || "-"}`,
        `Company Name: ${companyName || "-"}`,
        `Country: ${countryName || "-"} ${countryCode ? "(" + countryCode + ")" : ""}`,
        `Phone: ${[dialCode, phone].filter(Boolean).join(" ") || "-"}`,
        `Estimated Monthly Volume: ${volume || "-"}`,
        `Username (if logged in): ${username || "-"}`,
        `Source: ${page}`,
        `Time: ${new Date().toISOString()}`,
      ].join("\n");

      const html = `
  <div style="background:#f5f7fb;padding:24px;font-family:Segoe UI,Roboto,Arial,sans-serif;">
    <div style="max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      
      <!-- Header -->
      <div style="padding:18px 24px;border-bottom:1px solid #e5e7eb;">
        <div style="font-size:18px;font-weight:600;color:#111827;">
          Enterprise Plan Request
        </div>
        <div style="margin-top:4px;font-size:12px;color:#6b7280;">
          TrueSendr • ${escapeHtml(new Date().toISOString())} (UTC)
        </div>
      </div>

      <!-- Body -->
      <div style="padding:24px;">
        <p style="margin:0 0 16px 0;font-size:14px;color:#374151;">
          A new enterprise inquiry has been submitted via the <b>${escapeHtml(page)}</b>.
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
          ${row("Name", name)}
          ${row("Company Email", email, true)}
          ${row("Job Title", jobTitle || "-")}
          ${row("Company Name", companyName || "-")}
          ${row(
            "Country",
            (countryName || "-") + (countryCode ? ` (${countryCode})` : ""),
          )}
          ${row("Phone", [dialCode, phone].filter(Boolean).join(" ") || "-")}
          ${row("Estimated Monthly Volume", volume || "-")}
          ${row("Username (if logged in)", username || "-")}
        </table>
      </div>

      <!-- Footer -->
      <div style="padding:14px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;background:#fafafa;">
        This is an internal notification generated by TrueSendr.
      </div>
    </div>
  </div>
`;

      // helper for table rows (email-safe)
      function row(label, value, isEmail = false) {
        const v = escapeHtml(value ?? "-");
        const display = isEmail
          ? `<a href="mailto:${v}" style="color:#2563eb;text-decoration:none;">${v}</a>`
          : `<span style="color:#111827;">${v}</span>`;

        return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;width:34%;color:#6b7280;font-weight:600;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
        ${display}
      </td>
    </tr>
  `;
      }

      // -------------------------------------------------------------------
      // Auto-reply email to the user (confirmation)
      // -------------------------------------------------------------------
      const userSubject = `We received your TrueSendr Enterprise request`;

      const userText = [
        `Hi ${name},`,
        ``,
        `Thanks for contacting TrueSendr about an Enterprise Plan.`,
        `We’ve received your details and our team will reach out to you within 24 hours.`,
        ``,
        `Your submitted details:`,
        `- Name: ${name}`,
        `- Company Email: ${email}`,
        `- Job Title: ${jobTitle || "-"}`,
        `- Company Name: ${companyName || "-"}`,
        `- Country: ${countryName || "-"} ${countryCode ? "(" + countryCode + ")" : ""}`,
        `- Phone: ${[dialCode, phone].filter(Boolean).join(" ") || "-"}`,
        `- Estimated Monthly Volume: ${volume || "-"}`,
        ``,
        `Regards,`,
        `TrueSendr Team`,
      ].join("\n");

      const userHtml = `
  <div style="background:#f5f7fb;padding:24px;font-family:Segoe UI,Roboto,Arial,sans-serif;">
    <div style="max-width:700px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      
      <!-- Header -->
      <div style="padding:18px 24px;border-bottom:1px solid #e5e7eb;">
        <div style="font-size:18px;font-weight:600;color:#111827;">
          We received your request
        </div>
        <div style="margin-top:4px;font-size:12px;color:#6b7280;">
          TrueSendr • ${escapeHtml(new Date().toISOString())} (UTC)
        </div>
      </div>

      <!-- Body -->
      <div style="padding:24px;">
        <p style="margin:0 0 12px 0;font-size:14px;color:#374151;">
          Hi <b>${escapeHtml(name)}</b>,
        </p>

        <p style="margin:0 0 14px 0;font-size:14px;color:#374151;line-height:1.6;">
          Thanks for contacting TrueSendr about an <b>Enterprise Plan</b>.
          We’ve received your details and our team will reach out to you within <b>24 hours</b>.
        </p>

        <div style="margin-top:16px;font-size:14px;font-weight:600;color:#111827;">
          Your submitted details
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-collapse:collapse;font-size:14px;">
          ${userRow("Name", name)}
          ${userRow("Company Email", email, true)}
          ${userRow("Job Title", jobTitle || "-")}
          ${userRow("Company Name", companyName || "-")}
          ${userRow("Country", (countryName || "-") + (countryCode ? ` (${countryCode})` : ""))}
          ${userRow("Phone", [dialCode, phone].filter(Boolean).join(" ") || "-")}
          ${userRow("Estimated Monthly Volume", volume || "-")}
        </table>

        <div style="margin-top:18px;padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;color:#374151;line-height:1.55;">
          If you have any additional details to share, just reply to this email.
        </div>

        <p style="margin:18px 0 0 0;font-size:14px;color:#374151;">
          Regards,<br/>
          <b>TrueSendr Team</b>
        </p>
      </div>

      <!-- Footer -->
      <div style="padding:14px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;background:#fafafa;">
        This is an automated confirmation from TrueSendr.
      </div>
    </div>
  </div>
`;

      function userRow(label, value, isEmail = false) {
        const v = escapeHtml(value ?? "-");
        const display = isEmail
          ? `<a href="mailto:${v}" style="color:#2563eb;text-decoration:none;">${v}</a>`
          : `<span style="color:#111827;">${v}</span>`;

        return `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;width:34%;color:#6b7280;font-weight:600;">
              ${escapeHtml(label)}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
              ${display}
            </td>
          </tr>
        `;
      }

      await mailer.sendMail({
        from: MAIL_FROM,
        to: ENTERPRISE_LEAD_TO,
        replyTo: email, // so you can reply directly to the customer
        subject,
        text,
        html,
      });

      // ✅ Send confirmation email to the user
      await mailer.sendMail({
        from: MAIL_FROM,
        to: email,
        replyTo: "jenny.j@truesendr.com", // optional: lets user reply to your team
        subject: userSubject,
        text: userText,
        html: userHtml,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("❌ enterprise-lead error:", err);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  // tiny html escape helper
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  const rzp = new Razorpay({ key_id, key_secret });

  // ---------------------------------------------------------------------------
  // POST /api/payment/razorpay/create-order
  // Body: { username, credits }
  // ---------------------------------------------------------------------------
  router.post("/razorpay/create-order", async (req, res) => {
    try {
      const body = parseMaybeBufferBody(req);
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const credits = Number(body.credits || 0);

      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "username required" });
      if (!Number.isFinite(credits) || credits < 1000) {
        return res
          .status(400)
          .json({ ok: false, message: "Minimum purchase is 1000 credits" });
      }

      const PRICE_PER_CREDIT_USD = Number(
        process.env.CREDITS_PRICE_PER_CREDIT || 0.008,
      );

      // detect country + pick tax
      const geo = await geoFromIpInfo(req);
      const taxInfo = getTaxInfo(geo.countryCode);

      // decide currency for this country
      const currencyCode = getCurrencyCode(geo.countryCode); // e.g. INR
      const fx = await getUsdToCurrencyRate(currencyCode); // 1 USD -> X INR

      // ✅ compute everything in LOCAL currency (major units)
      const pricePerCreditLocal = PRICE_PER_CREDIT_USD * (fx.rate || 1);
      const subTotalLocal = credits * pricePerCreditLocal;
      const taxLocal = subTotalLocal * Number(taxInfo.taxRate || 0);
      const totalLocal = subTotalLocal + taxLocal;

      // ✅ Razorpay amount must be in MINOR units (paise/cents/etc)
      const amountMinor = toMinorUnits(totalLocal, currencyCode);

      if (!Number.isFinite(amountMinor) || amountMinor < 1) {
        return res.status(400).json({
          ok: false,
          message: "Amount too small. Check pricing config / FX rate.",
        });
      }

      const user = await User.findOne({ username });
      if (!user)
        return res.status(404).json({ ok: false, message: "User not found" });

      const receipt = `ts_${username}_${Date.now()}`;

      // ✅ Create Razorpay order in LOCAL currency
      const order = await rzp.orders.create({
        amount: amountMinor,
        currency: currencyCode,
        receipt,
        notes: {
          username,
          credits: String(credits),
          countryCode: geo.countryCode,
          countryName: taxInfo.countryName,
          taxName: taxInfo.taxName,
          taxRate: String(taxInfo.taxRate),
          currencyCode,
          usdToLocalRate: String(fx.rate),
          pricePerCreditUsd: String(PRICE_PER_CREDIT_USD),
          pricePerCreditLocal: String(pricePerCreditLocal),
          subTotalLocal: String(subTotalLocal),
          taxLocal: String(taxLocal),
          totalLocal: String(totalLocal),
        },
      });

      await RazorpayOrder.create({
        userId: user._id,
        username,
        credits,
        amountMinor,
        amountPaise: amountMinor, // optional compat
        currency: currencyCode,
        razorpayOrderId: order.id,
        status: "created",
        notes: order.notes || {},
      });

      return res.json({
        ok: true,
        key_id,
        order: { id: order.id, amount: order.amount, currency: order.currency },
        pricing: {
          credits,
          country: { code: geo.countryCode, name: taxInfo.countryName },
          tax: { name: taxInfo.taxName, rate: taxInfo.taxRate },
          currency: { code: currencyCode, usdToLocalRate: fx.rate },
          pricePerCreditUsd: PRICE_PER_CREDIT_USD,
          pricePerCreditLocal,
          subTotalLocal,
          taxLocal,
          totalLocal,
          amountMinor,
        },
      });
    } catch (err) {
      console.error("❌ create-order error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Server error creating order" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/payment/razorpay/verify
  // Body: { username, razorpay_order_id, razorpay_payment_id, razorpay_signature }
  // ---------------------------------------------------------------------------
  router.post("/razorpay/verify", async (req, res) => {
    try {
      const body = parseMaybeBufferBody(req);

      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const razorpay_order_id = String(body.razorpay_order_id || "");
      const razorpay_payment_id = String(body.razorpay_payment_id || "");
      const razorpay_signature = String(body.razorpay_signature || "");

      if (
        !username ||
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        return res
          .status(400)
          .json({ ok: false, message: "Missing required fields" });
      }

      const rec = await RazorpayOrder.findOne({
        razorpayOrderId: razorpay_order_id,
      });
      if (!rec)
        return res.status(404).json({ ok: false, message: "Order not found" });

      // ✅ Idempotent crediting (avoid double credit from verify + webhook)
      // ✅ Idempotent
      if (rec.status === "credited") {
        return res.json({
          ok: true,
          credited: true,
          orderId: rec.razorpayOrderId,
          creditsAdded: rec.credits,
          status: rec.status,
          message: "Already credited",
        });
      }

      // ✅ Verify checkout signature (order_id|payment_id)
      const sigOk = verifyCheckoutSignature({
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id,
        signature: razorpay_signature,
        secret: key_secret,
      });

      if (!sigOk) {
        await RazorpayOrder.updateOne(
          { _id: rec._id },
          {
            $set: {
              signatureVerified: false,
              status: "failed",
              razorpayPaymentId: razorpay_payment_id,
            },
          },
        );
        return res
          .status(400)
          .json({ ok: false, message: "Signature verification failed" });
      }

      // Fetch payment status from Razorpay
      const payment = await rzp.payments.fetch(razorpay_payment_id);
      const status = String(payment.status || "");

      // Accept captured OR authorized (if your account uses manual capture)
      const paidOk = status === "captured" || status === "authorized";

      // Save order link
      rec.razorpayPaymentId = razorpay_payment_id;
      rec.signatureVerified = true;
      rec.status = paidOk
        ? status === "captured"
          ? "captured"
          : "paid_pending"
        : "failed";
      await rec.save();

      if (!paidOk) {
        return res
          .status(400)
          .json({ ok: false, message: `Payment not successful: ${status}` });
      }

      // If authorized and you want to capture programmatically:
      if (
        status === "authorized" &&
        process.env.RAZORPAY_AUTO_CAPTURE === "true"
      ) {
        try {
          const captureAmount = Number(rec.amountMinor ?? rec.amountPaise ?? 0);
          if (!captureAmount) {
            return res.status(500).json({
              ok: false,
              message:
                "Order amount missing (amountMinor/amountPaise). Check DB schema.",
            });
          }

          await rzp.payments.capture(
            razorpay_payment_id,
            captureAmount,
            rec.currency || "USD",
          );
          rec.status = "captured";
          await rec.save();
        } catch (e) {
          console.warn(
            "⚠️ capture failed (will rely on webhook / later capture):",
            e?.message || e,
          );
        }
      }

      // Credit now if captured (or if you prefer: credit on webhook only)
      // We'll credit immediately if captured.
      const freshPayment = await rzp.payments.fetch(razorpay_payment_id);
      if (String(freshPayment.status) !== "captured") {
        // not captured yet → wait for webhook
        return res.json({
          ok: true,
          pending: true,
          message: "Payment verified; awaiting capture",
          status: freshPayment.status,
        });
      }

      // ✅ Do NOT credit here. Credit happens via webhook payment.captured (single source of truth)
      return res.json({
        ok: true,
        credited: false,
        orderId: rec.razorpayOrderId,
        creditsAdded: rec.credits,
        message:
          "Payment verified. Credits will be added shortly after capture (webhook).",
        status: String(freshPayment.status || status),
      });
    } catch (err) {
      console.error("❌ verify error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Server error verifying payment" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/payment/razorpay/order-status?orderId=...&username=...
  // Used by frontend to show "Credits added" screen once webhook credits the user
  // ---------------------------------------------------------------------------
  router.get("/razorpay/order-status", async (req, res) => {
    try {
      const orderId = String(req.query.orderId || "").trim();
      const username = String(req.query.username || "")
        .trim()
        .toLowerCase();

      if (!orderId) {
        return res.status(400).json({ ok: false, message: "orderId required" });
      }

      const rec = await RazorpayOrder.findOne({
        razorpayOrderId: orderId,
        ...(username ? { username } : {}),
      });

      if (!rec) {
        return res.status(404).json({ ok: false, message: "Order not found" });
      }

      return res.json({
        ok: true,
        orderId: rec.razorpayOrderId,
        status: rec.status, // created | paid_pending | captured | credited | failed | cancelled
        credits: rec.credits,
        currency: rec.currency || "USD",
        amountMinor: Number(rec.amountMinor ?? rec.amountPaise ?? 0) || 0,
        creditedAt: rec.creditedAt || null,
        razorpayPaymentId: rec.razorpayPaymentId || null,
      });
    } catch (err) {
      console.error("❌ order-status error:", err);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/payment   (Webhook URL)
  // Razorpay sends JSON + header: x-razorpay-signature
  // IMPORTANT: we need raw body for signature verification.
  // ---------------------------------------------------------------------------
  router.post(
    "/",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        const sig = req.headers["x-razorpay-signature"];
        if (!sig) return res.status(400).send("Missing signature");

        const rawBody = req.body; // Buffer
        const ok = verifyWebhookSignature({
          rawBody,
          signature: sig,
          webhookSecret,
        });

        if (!ok) {
          console.warn("⚠️ webhook signature failed");
          return res.status(400).send("Invalid signature");
        }

        const payload = JSON.parse(rawBody.toString("utf8"));
        const event = String(payload.event || "");

        // We care mainly about payment.captured / payment.failed / refund.processed etc.
        if (event === "payment.captured") {
          const payment = payload.payload?.payment?.entity;
          const orderId = payment?.order_id;
          const paymentId = payment?.id;

          if (orderId && paymentId) {
            const rec = await RazorpayOrder.findOne({
              razorpayOrderId: orderId,
            });
            if (rec && rec.status !== "credited") {
              const user = await User.findOne({ _id: rec.userId });
              if (user) {
                const opening = user.credits ?? 0;
                const closing = opening + rec.credits;

                user.credits = closing;
                await user.save();

                await CreditsLedger.create({
                  userId: user._id,
                  username: rec.username,
                  type: "purchase",
                  creditsDelta: rec.credits,
                  refType: "razorpay",
                  refId: paymentId,
                  openingBalance: opening,
                  closingBalance: closing,
                  meta: { razorpayOrderId: orderId, via: "webhook" },
                });

                rec.razorpayPaymentId = paymentId;
                rec.signatureVerified = true;
                rec.status = "credited";
                rec.creditedAt = new Date();
                await rec.save();
              }
            }
          }
        } else if (event === "payment.failed") {
          const payment = payload.payload?.payment?.entity;
          const orderId = payment?.order_id;
          const paymentId = payment?.id;
          if (orderId) {
            await RazorpayOrder.updateOne(
              { razorpayOrderId: orderId },
              {
                $set: {
                  status: "failed",
                  razorpayPaymentId: paymentId || null,
                },
              },
            );
          }
        }

        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error("❌ webhook error:", err);
        return res.status(500).send("Webhook error");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/payment/razorpay/cancel
  // Body: { username, razorpay_order_id? }
  // Marks latest pending order as cancelled
  // ---------------------------------------------------------------------------
  router.post("/razorpay/cancel", async (req, res) => {
    try {
      const body = parseMaybeBufferBody(req);
      const username = String(body.username || "")
        .trim()
        .toLowerCase();
      const razorpay_order_id = String(body.razorpay_order_id || "").trim();

      if (!username) {
        return res
          .status(400)
          .json({ ok: false, message: "username required" });
      }

      // If order_id is provided, cancel that specific order (best)
      if (razorpay_order_id) {
        const updated = await RazorpayOrder.findOneAndUpdate(
          {
            razorpayOrderId: razorpay_order_id,
            username,
            status: { $in: ["created", "paid_pending"] },
          },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
            },
          },
          { new: true },
        );

        return res.json({
          ok: true,
          cancelled: !!updated,
          message: updated
            ? "Order cancelled"
            : "No pending order found to cancel",
        });
      }

      // Otherwise cancel the latest created/paid_pending order for that user
      const latest = await RazorpayOrder.findOne({
        username,
        status: { $in: ["created", "paid_pending"] },
      }).sort({ createdAt: -1 });

      if (!latest) {
        return res.json({
          ok: true,
          cancelled: false,
          message: "No pending order found",
        });
      }

      latest.status = "cancelled";
      latest.cancelledAt = new Date();
      await latest.save();

      return res.json({
        ok: true,
        cancelled: true,
        message: "Order cancelled",
        orderId: latest.razorpayOrderId,
      });
    } catch (err) {
      console.error("❌ cancel error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Server error cancelling order" });
    }
  });

  return router;
};
