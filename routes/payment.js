// routes/payment.js
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");

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

module.exports = function paymentRouter(_deps = {}) {
  const router = express.Router();

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

      // 🔧 PRICING in USD (cents)      
      const PRICE_PER_CREDIT = Number(
        process.env.CREDITS_PRICE_PER_CREDIT || 0.008,
      ); // USD per credit
      const GST_RATE = Number(process.env.CREDITS_GST_RATE || 0.18); // 18% => 0.18

      const subTotal = credits * PRICE_PER_CREDIT;
      const tax = subTotal * GST_RATE;
      const total = subTotal + tax;

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
