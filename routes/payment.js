// routes/payment.js
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const axios = require("axios");
const nodemailer = require("nodemailer");
const RazorpayOrder = require("../models/RazorpayOrder");
const CreditsLedger = require("../models/CreditsLedger");
const User = require("../models/User");

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
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

// ---------------------------------------------------------------------------
// Geo + Tax (Phase-1)
// ---------------------------------------------------------------------------
const COUNTRY_TAX_MAP = {
  AF: { countryName: "Afghanistan", taxName: "No VAT", taxRate: 0.0 },

  AL: {
    countryName: "Albania",
    taxName: "VAT",
    taxRate: 0.2,
    note: "6% tourism services (reduced)",
  },
  DZ: {
    countryName: "Algeria",
    taxName: "VAT",
    taxRate: 0.19,
    note: "9% reduced",
  },
  AD: {
    countryName: "Andorra",
    taxName: "IGI",
    taxRate: 0.045,
    note: "Standard IGI 4.5%",
  },
  AO: { countryName: "Angola", taxName: "VAT", taxRate: 0.14 },

  AR: { countryName: "Argentina", taxName: "VAT", taxRate: 0.21 },
  AM: { countryName: "Armenia", taxName: "VAT", taxRate: 0.2 },
  AU: {
    countryName: "Australia",
    taxName: "GST",
    taxRate: 0.1,
    note: "0% on essential items",
  },
  AT: {
    countryName: "Austria",
    taxName: "VAT",
    taxRate: 0.2,
    note: "13% tourism, 10% basic items",
  },
  AZ: { countryName: "Azerbaijan", taxName: "VAT", taxRate: 0.18 },

  BH: {
    countryName: "Bahrain",
    taxName: "VAT",
    taxRate: 0.1,
    note: "0% essential goods",
  },
  BD: { countryName: "Bangladesh", taxName: "VAT", taxRate: 0.15 },
  BY: {
    countryName: "Belarus",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% reduced",
  },
  BE: {
    countryName: "Belgium",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12% restaurants, 6% reduced",
  },
  BZ: {
    countryName: "Belize",
    taxName: "Sales Tax",
    taxRate: 0.125,
    note: "12.5% (shown as Sales/GST style)",
  },
  BJ: { countryName: "Benin", taxName: "VAT", taxRate: 0.18 },
  BT: {
    countryName: "Bhutan",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  BO: { countryName: "Bolivia", taxName: "VAT", taxRate: 0.13 },
  BA: { countryName: "Bosnia & Herzegovina", taxName: "VAT", taxRate: 0.17 },
  BW: { countryName: "Botswana", taxName: "VAT", taxRate: 0.14 },
  BR: {
    countryName: "Brazil",
    taxName: "Sales Tax",
    taxRate: 0.2,
    note: "Shown as 20–30.7% (varies); using 20% baseline",
  },
  BG: {
    countryName: "Bulgaria",
    taxName: "VAT",
    taxRate: 0.2,
    note: "9% hotels/camping",
  },

  KH: { countryName: "Cambodia", taxName: "VAT", taxRate: 0.1 },
  CM: { countryName: "Cameroon", taxName: "VAT", taxRate: 0.1925 },
  CA: {
    countryName: "Canada",
    taxName: "GST",
    taxRate: 0.05,
    note: "Shown as 5% to 15% (varies by province); provincial tax not included",
  },
  CL: { countryName: "Chile", taxName: "VAT", taxRate: 0.19 },
  CN: {
    countryName: "China",
    taxName: "VAT",
    taxRate: 0.13,
    note: "9%/6% reduced; 0% exports",
  },
  CO: {
    countryName: "Colombia",
    taxName: "VAT",
    taxRate: 0.19,
    note: "5% or 0% reduced",
  },
  CR: {
    countryName: "Costa Rica",
    taxName: "VAT",
    taxRate: 0.13,
    note: "Reduced rates down to 1%",
  },
  HR: {
    countryName: "Croatia",
    taxName: "VAT",
    taxRate: 0.25,
    note: "13% reduced",
  },
  CU: {
    countryName: "Cuba",
    taxName: "Sales Tax",
    taxRate: 0.025,
    note: "Shown as 2.5–20% (varies); using 2.5% baseline",
  },
  CY: {
    countryName: "Cyprus",
    taxName: "VAT",
    taxRate: 0.19,
    note: "5% or 0% reduced",
  },
  CZ: {
    countryName: "Czech Republic",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12% reduced",
  },

  DK: { countryName: "Denmark", taxName: "VAT", taxRate: 0.25 },
  DO: { countryName: "Dominican Republic", taxName: "VAT", taxRate: 0.18 },

  EC: {
    countryName: "Ecuador",
    taxName: "VAT",
    taxRate: 0.12,
    note: "15% luxury; 0% exports",
  },
  EG: {
    countryName: "Egypt",
    taxName: "VAT",
    taxRate: 0.14,
    note: "10% professional services; 0% exports",
  },
  EE: {
    countryName: "Estonia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "9% reduced",
  },
  ET: {
    countryName: "Ethiopia",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },

  FI: {
    countryName: "Finland",
    taxName: "VAT",
    taxRate: 0.255,
    note: "14% food; 10% medicines/public transport",
  },
  FR: {
    countryName: "France",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10%/5.5%/2.1% reduced",
  },

  GE: { countryName: "Georgia", taxName: "VAT", taxRate: 0.18 },
  DE: {
    countryName: "Germany",
    taxName: "VAT",
    taxRate: 0.19,
    note: "7% reduced",
  },
  GH: {
    countryName: "Ghana",
    taxName: "VAT",
    taxRate: 0.03,
    note: "Shown as 3% in VAT/GST/Sales column in source",
  },
  GR: {
    countryName: "Greece",
    taxName: "VAT",
    taxRate: 0.24,
    note: "13%/6% reduced; island reductions apply",
  },
  GT: { countryName: "Guatemala", taxName: "VAT", taxRate: 0.12 },

  HN: {
    countryName: "Honduras",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  HK: { countryName: "Hong Kong", taxName: "No VAT", taxRate: 0.0 },
  HU: {
    countryName: "Hungary",
    taxName: "VAT",
    taxRate: 0.27,
    note: "18%/5% reduced",
  },

  IS: {
    countryName: "Iceland",
    taxName: "VAT",
    taxRate: 0.24,
    note: "11% reduced",
  },
  IN: {
    countryName: "India",
    taxName: "GST",
    taxRate: 0.18,
    note: "Multiple GST slabs exist; 18% standard",
  },
  ID: { countryName: "Indonesia", taxName: "VAT", taxRate: 0.11 },
  IR: {
    countryName: "Iran",
    taxName: "VAT",
    taxRate: 0.09,
    note: "Shown as 0–9% (varies); using 9% max/standard",
  },
  IQ: {
    countryName: "Iraq",
    taxName: "Sales Tax",
    taxRate: 0.1,
    note: "Various special rates listed; 10% restaurants/hotels",
  },
  IE: {
    countryName: "Ireland",
    taxName: "VAT",
    taxRate: 0.23,
    note: "Goods 23%; services 9–13.5%; some 0%",
  },
  IL: {
    countryName: "Israel",
    taxName: "VAT",
    taxRate: 0.18,
    note: "0% on fruits/vegetables",
  },
  IT: {
    countryName: "Italy",
    taxName: "VAT",
    taxRate: 0.22,
    note: "10%/4% reduced",
  },

  JM: {
    countryName: "Jamaica",
    taxName: "Sales Tax",
    taxRate: 0.165,
    note: "Goods 16.5%, services 20%",
  },
  JP: {
    countryName: "Japan",
    taxName: "Consumption Tax",
    taxRate: 0.1,
    note: "8% groceries/takeout/subscriptions (reduced)",
  },
  JO: { countryName: "Jordan", taxName: "Sales Tax", taxRate: 0.16 },

  KZ: { countryName: "Kazakhstan", taxName: "VAT", taxRate: 0.13 },
  KE: {
    countryName: "Kenya",
    taxName: "VAT",
    taxRate: 0.16,
    note: "12% electricity/fuel; 0% food",
  },
  KR: { countryName: "South Korea", taxName: "VAT", taxRate: 0.1 },
  KW: { countryName: "Kuwait", taxName: "No VAT", taxRate: 0.0 },

  LA: {
    countryName: "Laos",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  LV: {
    countryName: "Latvia",
    taxName: "VAT",
    taxRate: 0.21,
    note: "12%/5% reduced",
  },
  LB: { countryName: "Lebanon", taxName: "VAT", taxRate: 0.11 },
  LY: {
    countryName: "Libya",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  LI: {
    countryName: "Liechtenstein",
    taxName: "VAT",
    taxRate: 0.081,
    note: "3.8% lodging; 2.5% reduced",
  },
  LT: {
    countryName: "Lithuania",
    taxName: "VAT",
    taxRate: 0.21,
    note: "9%/5% reduced; some 0%",
  },
  LU: {
    countryName: "Luxembourg",
    taxName: "VAT",
    taxRate: 0.17,
    note: "3% reduced",
  },
  MO: { countryName: "Macau", taxName: "No VAT", taxRate: 0.0 },

  MY: {
    countryName: "Malaysia",
    taxName: "Sales Tax",
    taxRate: 0.1,
    note: "Goods 10%, services 7% (shown in source)",
  },
  MT: {
    countryName: "Malta",
    taxName: "VAT",
    taxRate: 0.18,
    note: "7%/5% reduced",
  },
  MU: { countryName: "Mauritius", taxName: "VAT", taxRate: 0.15 },
  MX: { countryName: "Mexico", taxName: "VAT", taxRate: 0.16 },
  MD: {
    countryName: "Moldova",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% HoReCa",
  },
  MC: {
    countryName: "Monaco",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% reduced; 5.5% basic products",
  },
  MN: { countryName: "Mongolia", taxName: "VAT", taxRate: 0.1 },
  ME: {
    countryName: "Montenegro",
    taxName: "VAT",
    taxRate: 0.21,
    note: "7% reduced; some 0%",
  },
  MA: {
    countryName: "Morocco",
    taxName: "VAT",
    taxRate: 0.2,
    note: "Reduced 14%/10%/7%",
  },
  MZ: {
    countryName: "Mozambique",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },
  MM: {
    countryName: "Myanmar",
    taxName: "No VAT",
    taxRate: 0.0,
    note: "VAT/GST shown as N/A in source",
  },

  NP: { countryName: "Nepal", taxName: "VAT", taxRate: 0.13 },

  NL: {
    countryName: "Netherlands",
    taxName: "VAT",
    taxRate: 0.21,
    note: "9% reduced",
  },
  NZ: { countryName: "New Zealand", taxName: "GST", taxRate: 0.15 },
  NG: { countryName: "Nigeria", taxName: "VAT", taxRate: 0.075 },
  NO: {
    countryName: "Norway",
    taxName: "VAT",
    taxRate: 0.25,
    note: "15% food; 12% transport/cinema/hotels",
  },

  OM: { countryName: "Oman", taxName: "VAT", taxRate: 0.05 },

  PK: {
    countryName: "Pakistan",
    taxName: "Sales Tax",
    taxRate: 0.18,
    note: "15% services; 0% basic food; +3% non-registered goods",
  },
  PA: {
    countryName: "Panama",
    taxName: "VAT",
    taxRate: 0.07,
    note: "Higher rates for tobacco/alcohol/hotels; reduced 5%",
  },
  PY: { countryName: "Paraguay", taxName: "VAT", taxRate: 0.1 },
  PE: {
    countryName: "Peru",
    taxName: "VAT",
    taxRate: 0.16,
    note: "+2% municipal promotional tax (shown in source)",
  },
  PH: {
    countryName: "Philippines",
    taxName: "VAT",
    taxRate: 0.12,
    note: "0% reduced",
  },
  PL: {
    countryName: "Poland",
    taxName: "VAT",
    taxRate: 0.23,
    note: "8%/5% reduced",
  },
  PT: {
    countryName: "Portugal",
    taxName: "VAT",
    taxRate: 0.23,
    note: "13% intermediate; 6% reduced",
  },

  QA: { countryName: "Qatar", taxName: "No VAT", taxRate: 0.0 },

  RO: {
    countryName: "Romania",
    taxName: "VAT",
    taxRate: 0.19,
    note: "9%/5% reduced",
  },
  RU: {
    countryName: "Russia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "10% reduced; 0% certain items",
  },

  SA: {
    countryName: "Saudi Arabia",
    taxName: "VAT",
    taxRate: 0.15,
    note: "5% real estate transactions rate mentioned",
  },
  RS: {
    countryName: "Serbia",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% or 0% reduced",
  },
  SG: { countryName: "Singapore", taxName: "GST", taxRate: 0.09 },
  SK: {
    countryName: "Slovakia",
    taxName: "VAT",
    taxRate: 0.23,
    note: "19%/5% reduced",
  },
  SI: {
    countryName: "Slovenia",
    taxName: "VAT",
    taxRate: 0.22,
    note: "9.5% reduced; 5% books/newspapers",
  },

  ZA: { countryName: "South Africa", taxName: "VAT", taxRate: 0.15 },
  ES: {
    countryName: "Spain",
    taxName: "VAT",
    taxRate: 0.21,
    note: "10%/4% reduced",
  },
  LK: {
    countryName: "Sri Lanka",
    taxName: "VAT",
    taxRate: 0.12,
    note: "8% or 0% reduced",
  },
  SE: {
    countryName: "Sweden",
    taxName: "VAT",
    taxRate: 0.25,
    note: "12% or 6% reduced",
  },
  CH: {
    countryName: "Switzerland",
    taxName: "VAT",
    taxRate: 0.081,
    note: "3.8%/2.5% reduced",
  },

  TW: { countryName: "Taiwan", taxName: "VAT", taxRate: 0.05 },
  TH: { countryName: "Thailand", taxName: "VAT", taxRate: 0.07 },
  TR: {
    countryName: "Turkey",
    taxName: "VAT",
    taxRate: 0.2,
    note: "10% clothing; 1% certain foods",
  },

  UA: {
    countryName: "Ukraine",
    taxName: "VAT",
    taxRate: 0.18,
    note: "2% turnover tax during martial law mentioned (separate)",
  },

  AE: { countryName: "United Arab Emirates", taxName: "VAT", taxRate: 0.05 },
  GB: {
    countryName: "United Kingdom",
    taxName: "VAT",
    taxRate: 0.2,
    note: "5% home energy; many 0% items",
  },
  US: {
    countryName: "United States",
    taxName: "Sales Tax",
    taxRate: 0.0,
    note: "State/local; shown as 0–11.5%",
  },

  UY: {
    countryName: "Uruguay",
    taxName: "VAT",
    taxRate: 0.22,
    note: "11% lowest; some 0%",
  },
  UZ: {
    countryName: "Uzbekistan",
    taxName: "VAT",
    taxRate: 0.15,
    note: "Shown as 0–15% (varies); using 15% max/standard",
  },

  VE: {
    countryName: "Venezuela",
    taxName: "VAT",
    taxRate: 0.16,
    note: "8% reduced",
  },
  VN: { countryName: "Vietnam", taxName: "VAT", taxRate: 0.1 },

  YE: { countryName: "Yemen", taxName: "Sales Tax", taxRate: 0.02 },

  ZM: { countryName: "Zambia", taxName: "VAT", taxRate: 0.16 },
  ZW: {
    countryName: "Zimbabwe",
    taxName: "VAT",
    taxRate: 0.15,
    note: "0% selected items",
  },
};

function getTaxInfo(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  return (
    COUNTRY_TAX_MAP[code] || {
      countryName: code || "Unknown",
      taxName: "Tax",
      taxRate: 0.0,
    }
  );
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

      const PRICE_PER_CREDIT = Number(
        process.env.CREDITS_PRICE_PER_CREDIT || 0.008,
      );

      // detect country + pick tax
      const geo = await geoFromIpInfo(req);
      const taxInfo = getTaxInfo(geo.countryCode);

      const { subTotal, tax, total } = computeAmounts({
        credits,
        pricePerCredit: PRICE_PER_CREDIT,
        taxRate: Number(taxInfo.taxRate || 0),
      });

      // Razorpay amount is always in the smallest currency unit
      // USD -> cents
      const amountMinor = Math.round(total * 100);
      if (amountMinor < 50) {
        return res.status(400).json({
          ok: false,
          message: "Amount too small. Check pricing config.",
        });
      }

      const user = await User.findOne({ username });
      if (!user)
        return res.status(404).json({ ok: false, message: "User not found" });

      const receipt = `ts_${username}_${Date.now()}`;

      const order = await rzp.orders.create({
        amount: amountMinor,
        currency: "USD",
        receipt,
        notes: {
          username,
          credits: String(credits),
          countryCode: geo.countryCode,
          countryName: taxInfo.countryName,
          taxName: taxInfo.taxName,
          taxRate: String(taxInfo.taxRate),
        },
      });

      await RazorpayOrder.create({
        userId: user._id,
        username,
        credits,

        amountMinor, // ✅ new
        amountPaise: amountMinor, // ✅ keep compatibility (optional but recommended)

        currency: "USD",
        razorpayOrderId: order.id,
        status: "created",
        notes: order.notes || {},
      });

      return res.json({
        ok: true,
        key_id,
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
        },
        pricing: {
          credits,
          country: { code: geo.countryCode, name: taxInfo.countryName },
          tax: { name: taxInfo.taxName, rate: taxInfo.taxRate, amount: tax },
          subTotal,
          total,
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
      if (rec.status === "credited")
        return res.json({ ok: true, message: "Already credited" });

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

          await rzp.payments.capture(razorpay_payment_id, captureAmount, "USD");
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
  // POST /api/payment   (Webhook URL)
  // Razorpay sends JSON + header: x-razorpay-signature
  // IMPORTANT: we need raw body for signature verification.
  // ---------------------------------------------------------------------------
  router.post("/", async (req, res) => {
    try {
      const sig = req.headers["x-razorpay-signature"];
      if (!sig) return res.status(400).send("Missing signature");

      const rawBody = req.body;
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
          const rec = await RazorpayOrder.findOne({ razorpayOrderId: orderId });
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
              $set: { status: "failed", razorpayPaymentId: paymentId || null },
            },
          );
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("❌ webhook error:", err);
      return res.status(500).send("Webhook error");
    }
  });

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
