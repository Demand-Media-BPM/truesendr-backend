// routes/deliverability.js
const express = require("express");
const mongoose = require("mongoose");
const { ImapFlow } = require("imapflow");
const nodemailer = require("nodemailer");
const User = require("../models/User");

const DELIV_CREDITS_PER_MAILBOX = Number(
  process.env.DELIV_CREDITS_PER_MAILBOX || 1
);

/** ---------------- Providers ---------------- */
const PROVIDERS = {
  gmail: {
    label: "Google",
    emailEnv: "DELIV_GMAIL_EMAIL",
    passEnv: "DELIV_GMAIL_APP_PW",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "[Gmail]/Spam",
    extraFolders: ["[Gmail]/All Mail"],
  },
  zoho: {
    label: "Zoho",
    emailEnv: "DELIV_ZOHO_EMAIL",
    passEnv: "DELIV_ZOHO_APP_PW",
    imap: { host: "imap.zoho.in", port: 993, secure: true },
    smtp: { host: "smtp.zoho.in", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "Spam",
  },
  google_business: {
    label: "Google Business",
    emailEnv: "DELIV_GBUSINESS_EMAIL",
    passEnv: "DELIV_GBUSINESS_APP_PW",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "[Gmail]/Spam",
    extraFolders: ["[Gmail]/All Mail"],
  },
  yahoo: {
    label: "Yahoo",
    emailEnv: "DELIV_YAHOO_EMAIL",
    passEnv: "DELIV_YAHOO_APP_PW",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "Bulk",
  },
  aol: {
    label: "AOL",
    emailEnv: "DELIV_AOL_EMAIL",
    passEnv: "DELIV_AOL_APP_PW",
    imap: { host: "imap.aol.com", port: 993, secure: true },
    smtp: { host: "smtp.aol.com", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "Bulk",
  },
  gmx: {
    label: "GMX",
    emailEnv: "DELIV_GMX_EMAIL",
    passEnv: "DELIV_GMX_APP_PW",
    imap: { host: "imap.gmx.com", port: 993, secure: true },
    smtp: { host: "mail.gmx.com", port: 587, secure: false },
    inboxFolder: "INBOX",
    spamFolder: "Spam",
  },
  seznam: {
    label: "Seznam",
    emailEnv: "DELIV_SEZNAM_EMAIL",
    passEnv: "DELIV_SEZNAM_APP_PW",
    imap: { host: "imap.seznam.cz", port: 993, secure: true },
    smtp: { host: "smtp.seznam.cz", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "spam",
  },
  yandex: {
    label: "Yandex",
    emailEnv: "DELIV_YANDEX_EMAIL",
    passEnv: "DELIV_YANDEX_APP_PW",
    imap: { host: "imap.yandex.com", port: 993, secure: true },
    smtp: { host: "smtp.yandex.com", port: 465, secure: true },
    inboxFolder: "INBOX",
    spamFolder: "Spam",
  },

  microsoft_business: {
    label: "Microsoft Business",
    emailEnv: "DELIV_MS_EMAIL",
    passEnv: null, // OAuth2, not password
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false }, // optional
    inboxFolder: "INBOX",

    // folder name varies in Exchange tenants
    spamFolder: "Junk Email",
    spamFolderAlternates: ["Junk", "Junk E-mail", "Spam"],
  },
};

const MS_48H = 48 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;

const CLEANUP_DAYS = 3;
const CLEANUP_INTERVAL_MIN = 360;
const CLEANUP_ENABLED = "true";

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * Delete messages older than N days from a folder using IMAP.
 * - Uses "BEFORE" search to find old messages.
 * - Deletes them (moves to Trash / marks deleted + expunge depending on provider).
 */
async function deleteOldMessagesFromFolder(client, folderName, olderThanDate) {
  const lock = await client.getMailboxLock(folderName);
  try {
    // Search messages BEFORE the date (IMAP supports BEFORE)
    // ImapFlow accepts Date objects for before:
    const uids = await client.search({ before: olderThanDate });
    if (!uids || uids.length === 0) return { folder: folderName, deleted: 0 };

    // Mark as deleted
    await client.messageFlagsAdd(uids, ["\\Deleted"]);

    // Expunge to actually remove
    // Some providers only expunge deleted messages at logout, but expunge helps.
    try {
      await client.expunge();
    } catch {}

    return { folder: folderName, deleted: uids.length };
  } finally {
    lock.release();
  }
}

/**
 * Cleanup one provider mailbox: deletes old mail from INBOX + Spam (+ extraFolders if you want).
 */
async function cleanupProviderMailbox(providerKey, days = CLEANUP_DAYS) {
  const cfg = getProviderConfig(providerKey);
  if (!cfg) {
    return {
      provider: providerKey,
      ok: false,
      error: "MISSING_ENV",
      deleted: 0,
      details: [],
    };
  }

  const olderThanDate = daysAgoDate(days);

  const auth = await buildImapAuth(providerKey, cfg);

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth,
    logger: false,
    socketTimeout: 60_000,
  });

  const details = [];
  let totalDeleted = 0;

  try {
    await client.connect();

    // Cleanup INBOX
    if (cfg.inboxFolder) {
      const r = await deleteOldMessagesFromFolder(
        client,
        cfg.inboxFolder,
        olderThanDate,
      );
      details.push(r);
      totalDeleted += r.deleted || 0;
    }

    // Cleanup Spam/Bulk folder
    if (cfg.spamFolder) {
      try {
        const r = await deleteOldMessagesFromFolder(
          client,
          cfg.spamFolder,
          olderThanDate,
        );
        details.push(r);
        totalDeleted += r.deleted || 0;
      } catch (e) {
        // Spam folder can be missing on some providers; ignore softly
        details.push({
          folder: cfg.spamFolder,
          deleted: 0,
          error: e?.message || String(e),
        });
      }
    }

    // (Optional) Cleanup extra folders (like Gmail All Mail) — be careful!
    // If you enable this for Gmail, it can delete a LOT.
    // if (Array.isArray(cfg.extraFolders)) {
    //   for (const f of cfg.extraFolders) {
    //     const r = await deleteOldMessagesFromFolder(client, f, olderThanDate);
    //     details.push(r);
    //     totalDeleted += r.deleted || 0;
    //   }
    // }

    return { provider: providerKey, ok: true, deleted: totalDeleted, details };
  } catch (err) {
    return {
      provider: providerKey,
      ok: false,
      error: err?.message || String(err),
      deleted: totalDeleted,
      details,
    };
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

/**
 * Cleanup ALL configured providers (those present in PROVIDERS and having env creds).
 */
async function cleanupAllProviders(days = CLEANUP_DAYS) {
  const keys = Object.keys(PROVIDERS || {});
  const results = [];

  for (const key of keys) {
    const r = await cleanupProviderMailbox(key, days);
    results.push(r);
  }

  const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
  return { ok: true, days, totalDeleted, results };
}

/** ---------------- Multi-tenant per user DB ---------------- */
const BASE_MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  "mongodb://127.0.0.1:27017/emailTool";

const userConnections = {};

function normalizeUsername(rawUsername) {
  const u = String(rawUsername || "")
    .trim()
    .toLowerCase();
  if (!u) return null;
  return u.replace(/[^a-z0-9_-]/gi, "_");
}

function getUsernameFromReq(req) {
  const u =
    (req.body && req.body.username) || (req.query && req.query.username) || "";
  return (u || "").toString().trim();
}

function getUserConnection(usernameRaw) {
  const normalized = normalizeUsername(usernameRaw);
  if (!normalized) return null;

  if (userConnections[normalized]) return userConnections[normalized];

  const dbName = `${normalized}-emailTool`;
  const conn = mongoose.createConnection(BASE_MONGO_URI, { dbName });

  userConnections[normalized] = conn;
  return conn;
}

/** ---------------- Schemas ---------------- */
const deliverabilityMailboxSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    email: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "inbox", "spam", "not_received", "error"],
      default: "pending",
    },
    folder: { type: String },
    lastCheckedAt: { type: Date },
    error: { type: String },
  },
  { _id: false },
);

const deliverabilityTestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    subject: { type: String, default: "" },

    status: {
      type: String,
      enum: ["NEW", "ACTIVE", "COMPLETED"],
      default: "NEW",
    },

    selectedProviders: { type: [String], default: [] },
    configuredProviders: { type: [String], default: [] },
    creditsCharged: { type: Boolean, default: false },
    skippedProviders: {
      type: [
        {
          provider: String,
          reason: String,
        },
      ],
      default: [],
    },
    providerMeta: {
      type: [
        {
          provider: String,
          label: String,
        },
      ],
      default: [],
    },

    creditsUsed: { type: Number, default: 0 },
    lastRunRequestedAt: { type: Date, default: null },

    mailboxes: { type: [deliverabilityMailboxSchema], default: [] },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  { timestamps: true },
);

function getDeliverabilityModel(usernameRaw) {
  const conn = getUserConnection(usernameRaw);
  if (!conn) return null;
  if (conn.models.DeliverabilityTest) return conn.models.DeliverabilityTest;

  return conn.model(
    "DeliverabilityTest",
    deliverabilityTestSchema,
    "deliverability-tests",
  );
}

// ─────────────────────────────────────────────
// Microsoft OAuth helpers (Deliverability)
// ─────────────────────────────────────────────
function isMicrosoftProvider(key) {
  return String(key || "") === "microsoft_business";
}

function requireMsSetupKey(req, res) {
  const need = process.env.DELIV_MS_SETUP_KEY || "";
  if (!need) return true; // allow if not set (not recommended)
  const got =
    (req.query && req.query.key) ||
    (req.headers && req.headers["x-ms-setup-key"]) ||
    "";
  if (String(got) !== String(need)) {
    res.status(403).send("Forbidden: invalid setup key");
    return false;
  }
  return true;
}

async function exchangeMsCodeForTokens(code) {
  const tenant = process.env.DELIV_MS_TENANT || "common";
  const clientId = process.env.DELIV_MS_CLIENT_ID;
  const clientSecret = process.env.DELIV_MS_CLIENT_SECRET;
  const redirectUri = process.env.DELIV_MS_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing DELIV_MS_CLIENT_ID / DELIV_MS_CLIENT_SECRET / DELIV_MS_REDIRECT_URI",
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "authorization_code");
  body.set("code", String(code));
  body.set("redirect_uri", redirectUri);
  body.set("scope", "offline_access IMAP.AccessAsUser.All");

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `MS code exchange failed (${resp.status}): ${json.error || ""} ${
        json.error_description || ""
      }`,
    );
  }
  return json;
}

async function fetchMsAccessTokenByRefreshToken() {
  const tenant = process.env.DELIV_MS_TENANT || "common";
  const clientId = process.env.DELIV_MS_CLIENT_ID;
  const clientSecret = process.env.DELIV_MS_CLIENT_SECRET;
  const redirectUri = process.env.DELIV_MS_REDIRECT_URI;
  const refreshToken = process.env.DELIV_MS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
    throw new Error(
      "Microsoft OAuth env missing. Need DELIV_MS_CLIENT_ID, DELIV_MS_CLIENT_SECRET, DELIV_MS_REDIRECT_URI, DELIV_MS_REFRESH_TOKEN",
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("redirect_uri", redirectUri);
  body.set("scope", "offline_access IMAP.AccessAsUser.All");

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(
      `MS token refresh failed (${resp.status}): ${json.error || ""} ${
        json.error_description || ""
      }`,
    );
  }
  return json.access_token;
}

function msAuthorizeUrl() {
  const tenant = process.env.DELIV_MS_TENANT || "common";
  const clientId = process.env.DELIV_MS_CLIENT_ID;
  const redirectUri = process.env.DELIV_MS_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error("Missing DELIV_MS_CLIENT_ID or DELIV_MS_REDIRECT_URI");
  }

  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;

  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("scope", "offline_access IMAP.AccessAsUser.All");
  params.set("prompt", "consent");
  params.set("state", "truesendr_ms_deliv");

  return `${base}?${params.toString()}`;
}

async function buildImapAuth(providerKey, cfg) {
  if (isMicrosoftProvider(providerKey)) {
    const token = await fetchMsAccessTokenByRefreshToken();
    return { user: cfg.email, accessToken: token };
  }
  return { user: cfg.email, pass: cfg.pass };
}

/** ---------------- Helpers ---------------- */
function providerLabel(providerKey) {
  return PROVIDERS?.[providerKey]?.label || providerKey;
}

function getProviderConfig(key) {
  const cfg = PROVIDERS[key];
  if (!cfg) return null;

  // Microsoft Business uses OAuth (no password)
  if (isMicrosoftProvider(key)) {
    const email = process.env[cfg.emailEnv];
    if (!email) return null;
    return { ...cfg, email, pass: null };
  }

  // Other providers use app password
  const email = process.env[cfg.emailEnv];
  const pass = process.env[cfg.passEnv];

  if (!email || !pass) return null;
  return { ...cfg, email, pass };
}

function computeCounts(mailboxes) {
  const counts = { inbox: 0, spam: 0, not_received: 0, error: 0, waiting: 0 };
  (mailboxes || []).forEach((mb) => {
    switch (mb.status) {
      case "inbox":
        counts.inbox++;
        break;
      case "spam":
        counts.spam++;
        break;
      case "not_received":
        counts.not_received++;
        break;
      case "error":
        counts.error++;
        break;
      default:
        counts.waiting++;
    }
  });
  return counts;
}

function computeTestStatus(testDoc) {
  if (!testDoc) return "ACTIVE";

  const now = Date.now();
  const createdAt = testDoc.createdAt
    ? new Date(testDoc.createdAt).getTime()
    : now;
  const ageMs = now - createdAt;

  const mailboxes = Array.isArray(testDoc.mailboxes) ? testDoc.mailboxes : [];

  // ✅ IMPORTANT: do NOT upgrade NEW → ACTIVE until user actually starts run-check
  const started =
    !!testDoc.lastRunRequestedAt ||
    !!testDoc.creditsCharged ||
    (typeof testDoc.subject === "string" && testDoc.subject.trim().length > 0);

  const current = String(testDoc.status || "").toUpperCase();

  if (!started && current === "NEW") return "NEW";

  const allFinal =
    mailboxes.length > 0 &&
    mailboxes.every((m) => ["inbox", "spam", "error"].includes(m.status));

  if (ageMs >= MS_48H) return "COMPLETED";
  if (allFinal) return "COMPLETED";
  return "ACTIVE";
}

async function normalizeAndPersistStatus(DeliverabilityTest, testDoc) {
  if (!testDoc) return testDoc;

  const newStatus = computeTestStatus(testDoc);

  // ✅ don't persist NEW → NEW changes etc.
  if (testDoc.status !== newStatus) {
    await DeliverabilityTest.updateOne(
      { _id: testDoc._id },
      { $set: { status: newStatus, updatedAt: new Date() } },
    );
    return { ...testDoc, status: newStatus };
  }
  return testDoc;
}

async function searchSubjectInFolder(client, folderName, subject) {
  if (!folderName) return false;
  if (!subject || !subject.trim()) return false;

  const searchTerm = subject.trim().toLowerCase();
  const lock = await client.getMailboxLock(folderName);

  try {
    const uids = await client.search({ all: true });
    if (!uids || uids.length === 0) return false;

    const lastUids = uids.slice(-50);
    for await (const msg of client.fetch(lastUids, { envelope: true })) {
      const msgSubj = (msg.envelope && msg.envelope.subject) || "";
      if (
        typeof msgSubj === "string" &&
        msgSubj.toLowerCase().includes(searchTerm)
      ) {
        return true;
      }
    }
    return false;
  } finally {
    lock.release();
  }
}

async function checkSingleMailbox(providerKey, email, subject) {
  const cfg = getProviderConfig(providerKey);

  const result = {
    provider: providerKey,
    email,
    status: "not_received",
    folder: undefined,
    error: undefined,
    lastCheckedAt: new Date(),
  };

  if (!cfg) {
    result.status = "error";
    result.error =
      "Provider not configured. Please check .env email & app password.";
    return result;
  }

  const auth = await buildImapAuth(providerKey, cfg);

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth,
    logger: false,
    socketTimeout: 60_000,
  });

  client.on("error", () => {});

  try {
    await client.connect();

    const inboxFolder = cfg.inboxFolder || "INBOX";
    let foundInbox = false;
    let folderUsed = inboxFolder;

    try {
      foundInbox = await searchSubjectInFolder(client, inboxFolder, subject);
    } catch {}

    if (!foundInbox && Array.isArray(cfg.extraFolders)) {
      for (const folder of cfg.extraFolders) {
        try {
          const f = await searchSubjectInFolder(client, folder, subject);
          if (f) {
            foundInbox = true;
            folderUsed = folder;
            break;
          }
        } catch {}
      }
    }

    if (foundInbox) {
      result.status = "inbox";
      result.folder = folderUsed;
      result.error = undefined;
    } else {
      let foundSpam = false;
      let spamError = null;

      // if (cfg.spamFolder) {
      //   try {
      //     foundSpam = await searchSubjectInFolder(
      //       client,
      //       cfg.spamFolder,
      //       subject,
      //     );
      //   } catch (e) {
      //     spamError = e;
      //   }
      // }
      const spamFoldersToTry = [];
      if (cfg.spamFolder) spamFoldersToTry.push(cfg.spamFolder);
      if (Array.isArray(cfg.spamFolderAlternates)) {
        spamFoldersToTry.push(...cfg.spamFolderAlternates);
      }

      for (const sf of spamFoldersToTry) {
        if (!sf) continue;
        try {
          const ok = await searchSubjectInFolder(client, sf, subject);
          if (ok) {
            foundSpam = true;
            result.folder = sf;
            break;
          }
        } catch (e) {
          spamError = e;
        }
      }

      if (foundSpam) {
        result.status = "spam";
        result.error = undefined;
      } else if (spamError && spamError.mailboxMissing) {
        result.status = "error";
        result.error = "Spam folder not found on this provider.";
      } else {
        result.status = "not_received";
      }
    }

    result.lastCheckedAt = new Date();
  } catch (err) {
    result.status = "error";
    result.error = err?.message || String(err);
    result.lastCheckedAt = new Date();
  } finally {
    try {
      client.logout().catch(() => {});
    } catch {}
  }

  return result;
}

/** ---------------- Realtime push helpers ---------------- */
function makePusher(deps) {
  const push = deps?.sendDeliverabilityUpdateToFrontend;
  if (typeof push !== "function") return () => {};
  return (username, payload) => {
    try {
      push(username, payload);
    } catch {}
  };
}

function buildRealtimePayload(testDoc, extra = {}) {
  const mailboxes = Array.isArray(testDoc?.mailboxes) ? testDoc.mailboxes : [];
  const counts = computeCounts(mailboxes);

  return {
    type: "deliverability:update",
    test: testDoc,
    mailboxes: testDoc.mailboxes,
    testId: String(testDoc?._id || ""),
    status: testDoc?.status || "ACTIVE",
    subject: testDoc?.subject || "",
    name: testDoc?.name || "",
    updatedAt: testDoc?.updatedAt || new Date(),
    createdAt: testDoc?.createdAt || null,
    totalMailboxes: mailboxes.length,
    providersCount: Array.isArray(testDoc?.configuredProviders)
      ? testDoc.configuredProviders.length
      : mailboxes.length,
    creditsUsed:
      typeof testDoc?.creditsUsed === "number"
        ? testDoc.creditsUsed
        : mailboxes.length * DELIV_CREDITS_PER_MAILBOX,
    counts,
    ...extra,
  };
}

/** ---------------- background retry ---------------- */
function scheduleUnreceivedRetry(
  DeliverabilityTest,
  testId,
  mbEmail,
  provider,
  subject,
  username,
  push,
) {
  setTimeout(async () => {
    try {
      const test = await DeliverabilityTest.findById(testId).lean();
      if (!test) return;

      const ageMs = Date.now() - new Date(test.createdAt).getTime();
      if (ageMs >= MS_48H) {
        await DeliverabilityTest.updateOne(
          { _id: testId },
          { $set: { status: "COMPLETED", updatedAt: new Date() } },
        );
        const freshDone = await DeliverabilityTest.findById(testId).lean();
        if (freshDone)
          push(
            username,
            buildRealtimePayload(freshDone, { event: "completed" }),
          );
        return;
      }

      const mb = (test.mailboxes || []).find((m) => m.email === mbEmail);
      if (!mb) return;
      if (["inbox", "spam", "error"].includes(mb.status)) return;

      const retry = await checkSingleMailbox(provider, mbEmail, subject);

      await DeliverabilityTest.updateOne(
        { _id: testId, "mailboxes.email": mbEmail },
        {
          $set: {
            "mailboxes.$.status": retry.status,
            "mailboxes.$.folder": retry.folder,
            "mailboxes.$.error": retry.error,
            "mailboxes.$.lastCheckedAt": retry.lastCheckedAt,
            updatedAt: new Date(),
          },
        },
      );

      const fresh = await DeliverabilityTest.findById(testId).lean();
      if (fresh) {
        const newStatus = computeTestStatus(fresh);
        if (fresh.status !== newStatus) {
          await DeliverabilityTest.updateOne(
            { _id: testId },
            { $set: { status: newStatus, updatedAt: new Date() } },
          );
        }

        // ✅ push realtime update for this mailbox
        const pushed = await DeliverabilityTest.findById(testId).lean();
        if (pushed) {
          push(
            username,
            buildRealtimePayload(pushed, {
              event: "mailbox_update",
              mailbox: {
                provider,
                email: mbEmail,
                status: retry.status,
                folder: retry.folder,
                error: retry.error,
                lastCheckedAt: retry.lastCheckedAt,
              },
            }),
          );
        }
      }

      if (retry.status === "not_received") {
        scheduleUnreceivedRetry(
          DeliverabilityTest,
          testId,
          mbEmail,
          provider,
          subject,
          username,
          push,
        );
      }
    } catch {
      scheduleUnreceivedRetry(
        DeliverabilityTest,
        testId,
        mbEmail,
        provider,
        subject,
        username,
        push,
      );
    }
  }, RETRY_INTERVAL_MS);
}

function runChecksInBackground(
  DeliverabilityTest,
  testId,
  finalSubject,
  username,
  push,
) {
  (async () => {
    try {
      const initial = await DeliverabilityTest.findById(testId).lean();
      if (!initial) return;

      const ageMs = Date.now() - new Date(initial.createdAt).getTime();
      if (ageMs >= MS_48H) {
        await DeliverabilityTest.updateOne(
          { _id: testId },
          { $set: { status: "COMPLETED", updatedAt: new Date() } },
        );
        const done = await DeliverabilityTest.findById(testId).lean();
        if (done)
          push(username, buildRealtimePayload(done, { event: "completed" }));
        return;
      }

      const mailboxes = initial.mailboxes || [];

      const tasks = mailboxes
        .filter((mb) => !["inbox", "spam", "error"].includes(mb.status))
        .map(async (mb) => {
          const result = await checkSingleMailbox(
            mb.provider,
            mb.email,
            finalSubject,
          );

          await DeliverabilityTest.updateOne(
            { _id: testId, "mailboxes.email": mb.email },
            {
              $set: {
                "mailboxes.$.status": result.status,
                "mailboxes.$.folder": result.folder,
                "mailboxes.$.error": result.error,
                "mailboxes.$.lastCheckedAt": result.lastCheckedAt,
                subject: finalSubject,
                updatedAt: new Date(),
              },
            },
          );

          const pushed = await DeliverabilityTest.findById(testId).lean();
          if (pushed) {
            push(
              username,
              buildRealtimePayload(pushed, {
                event: "mailbox_update",
                mailbox: {
                  provider: mb.provider,
                  email: mb.email,
                  status: result.status,
                  folder: result.folder,
                  error: result.error,
                  lastCheckedAt: result.lastCheckedAt,
                },
              }),
            );
          }

          if (result.status === "not_received") {
            scheduleUnreceivedRetry(
              DeliverabilityTest,
              testId,
              mb.email,
              mb.provider,
              finalSubject,
              username,
              push,
            );
          }
        });

      await Promise.all(tasks);

      const fresh = await DeliverabilityTest.findById(testId).lean();
      if (!fresh) return;

      const newStatus = computeTestStatus(fresh);
      if (fresh.status !== newStatus) {
        await DeliverabilityTest.updateOne(
          { _id: testId },
          { $set: { status: newStatus, updatedAt: new Date() } },
        );
      }

      const pushedFinal = await DeliverabilityTest.findById(testId).lean();
      if (pushedFinal) {
        push(
          username,
          buildRealtimePayload(pushedFinal, {
            event:
              pushedFinal.status === "COMPLETED" ? "completed" : "batch_done",
          }),
        );
      }
    } catch {}
  })();
}

/** ---------------- Router Factory ---------------- */
module.exports = function deliverabilityRouter(deps = {}) {
  const router = express.Router();
  const push = makePusher(deps);

  // ─────────────────────────────────────────────
  // Microsoft OAuth one-time setup endpoints
  // ─────────────────────────────────────────────

  // GET /api/deliverability/ms/start?key=DELIV_MS_SETUP_KEY
  router.get("/ms/start", async (req, res) => {
    try {
      if (!requireMsSetupKey(req, res)) return;
      const url = msAuthorizeUrl();
      return res.redirect(url);
    } catch (e) {
      return res
        .status(500)
        .send(e?.message || "Failed to start Microsoft OAuth");
    }
  });

  // GET /api/deliverability/ms/callback?code=...
  router.get("/ms/callback", async (req, res) => {
    try {
      if (!requireMsSetupKey(req, res)) return;

      const code = req.query && req.query.code;
      if (!code) return res.status(400).send("Missing code");

      const tokenJson = await exchangeMsCodeForTokens(String(code));
      const refresh = tokenJson.refresh_token;

      if (!refresh) {
        return res
          .status(500)
          .send(
            "No refresh_token received. Check API permissions + Admin consent. Then retry.",
          );
      }

      // show once so you paste into .env
      return res
        .status(200)
        .send(
          `✅ Microsoft connected.\n\nPaste this into EC2 .env:\n\nDELIV_MS_REFRESH_TOKEN=${refresh}\n\nThen restart backend.\n`,
        );
    } catch (e) {
      return res
        .status(500)
        .send(e?.message || "Microsoft OAuth callback failed");
    }
  });

  // Auto cleanup runner (runs in same node process)
  if (CLEANUP_ENABLED && !global.__DELIV_CLEANUP_STARTED__) {
    global.__DELIV_CLEANUP_STARTED__ = true;

    const intervalMs = Math.max(10, CLEANUP_INTERVAL_MIN) * 60 * 1000;

    // 🔥 run once immediately on server start
    (async () => {
      try {
        await cleanupAllProviders(CLEANUP_DAYS);
      } catch {}
    })();

    // ⏱ then keep running on interval
    setInterval(async () => {
      try {
        await cleanupAllProviders(CLEANUP_DAYS);
      } catch {}
    }, intervalMs);
  }

  // POST /api/deliverability/tests
  router.post("/tests", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const { name, providers } = req.body;
      if (!name || !name.trim())
        return res
          .status(400)
          .json({ ok: false, message: "Test name is required." });

      if (!Array.isArray(providers) || providers.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "At least one provider must be selected.",
        });
      }

      const selectedProviders = [
        ...new Set(
          providers.map((p) => String(p || "").trim()).filter(Boolean),
        ),
      ];

      const mailboxes = [];
      const configuredProviders = [];
      const skippedProviders = [];
      const providerMeta = [];

      selectedProviders.forEach((pKey) => {
        const cfg = getProviderConfig(pKey);
        providerMeta.push({ provider: pKey, label: providerLabel(pKey) });

        if (cfg) {
          mailboxes.push({
            provider: pKey,
            email: cfg.email,
            status: "pending",
          });
          configuredProviders.push(pKey);
        } else {
          skippedProviders.push({ provider: pKey, reason: "MISSING_ENV" });
        }
      });

      if (mailboxes.length === 0) {
        return res.status(400).json({
          ok: false,
          message:
            "No valid providers found. Please check your .env configuration.",
          skippedProviders,
        });
      }

      const requiredCredits = mailboxes.length * DELIV_CREDITS_PER_MAILBOX;

      const user = await User.findOne({ username }).lean(false);
      if (!user)
        return res
          .status(404)
          .json({ ok: false, message: "User not found for credits check." });

      const availableCredits =
        typeof user.credits === "number" ? user.credits : 0;

      if (availableCredits < requiredCredits) {
        return res.status(400).json({
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          message: "You have insufficient credit balance for this test.",
          requiredCredits,
          availableCredits,
          mailboxesCount: mailboxes.length,
          skippedProviders,
        });
      }

      // ✅ Do NOT deduct credits here. Only check availability.
      const test = await DeliverabilityTest.create({
        name: name.trim(),
        mailboxes,
        status: "NEW",
        selectedProviders,
        configuredProviders,
        skippedProviders,
        providerMeta,
        creditsUsed: 0,
        creditsCharged: false,
        lastRunRequestedAt: null,
      });

      // ✅ push realtime "created"
      push(username, buildRealtimePayload(test, { event: "created" }));

      return res.json({
        ok: true,
        test,
        addresses: mailboxes.map((m) => m.email),
        requiredCredits,
        remainingCredits: user.credits,
        skippedProviders,
      });
    } catch (err) {
      console.error("Create deliverability test error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // GET /api/deliverability/history
  router.get("/history", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const testsRaw = await DeliverabilityTest.find({})
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

      const tests = [];
      for (const t of testsRaw) {
        const normalized = await normalizeAndPersistStatus(
          DeliverabilityTest,
          t,
        );
        const mailboxes = normalized.mailboxes || [];
        const counts = computeCounts(mailboxes);

        tests.push({
          ...normalized,
          totalMailboxes: mailboxes.length,
          providersCount: Array.isArray(normalized.configuredProviders)
            ? normalized.configuredProviders.length
            : mailboxes.length,
          creditsUsed:
            typeof normalized.creditsUsed === "number"
              ? normalized.creditsUsed
              : mailboxes.length * DELIV_CREDITS_PER_MAILBOX,
          counts,
        });
      }

      return res.json({ ok: true, tests });
    } catch (err) {
      console.error("History deliverability tests error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // GET /api/deliverability/active
  router.get("/active", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const t =
        (await DeliverabilityTest.findOne({ status: "ACTIVE" })
          .sort({ createdAt: -1 })
          .lean()) ||
        (await DeliverabilityTest.findOne({ status: "NEW" })
          .sort({ createdAt: -1 })
          .lean());

      if (!t) return res.json({ ok: true, test: null, counts: null });

      const normalized = await normalizeAndPersistStatus(DeliverabilityTest, t);

      if (normalized.status === "COMPLETED") {
        return res.json({ ok: true, test: null, counts: null });
      }

      const counts = computeCounts(normalized.mailboxes || []);
      return res.json({ ok: true, test: normalized, counts });
    } catch (err) {
      console.error("Active deliverability test error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // DELETE /api/deliverability/history
  router.delete("/history", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const out = await DeliverabilityTest.deleteMany({});

      // ✅ push realtime "cleared"
      push(username, {
        type: "deliverability:update",
        event: "cleared",
        deletedCount: out?.deletedCount || 0,
      });

      return res.json({ ok: true, deletedCount: out?.deletedCount || 0 });
    } catch (err) {
      console.error("Clear deliverability history error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // GET /api/deliverability/tests/:id
  router.get("/tests/:id", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const { id } = req.params;

      let test = await DeliverabilityTest.findById(id).lean();
      if (!test)
        return res.status(404).json({ ok: false, message: "Test not found." });

      test = await normalizeAndPersistStatus(DeliverabilityTest, test);

      const mailboxes = test.mailboxes || [];
      const counts = computeCounts(mailboxes);

      const creditsUsed =
        typeof test.creditsUsed === "number" && test.creditsUsed > 0
          ? test.creditsUsed
          : mailboxes.length * DELIV_CREDITS_PER_MAILBOX;

      return res.json({
        ok: true,
        test,
        counts,
        creditsUsed,
        providersCount: Array.isArray(test.configuredProviders)
          ? test.configuredProviders.length
          : mailboxes.length,
        skippedProviders: test.skippedProviders || [],
      });
    } catch (err) {
      console.error("Get deliverability test error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // POST /api/deliverability/tests/:id/run-check
  router.post("/tests/:id/run-check", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const { id } = req.params;
      let { subject } = req.body || {};
      if (typeof subject === "string") subject = subject.trim();

      const test = await DeliverabilityTest.findById(id).lean();
      if (!test)
        return res.status(404).json({ ok: false, message: "Test not found." });

      // ✅ Charge credits ONLY when user starts the test (run-check)
      const mailboxesCount = Array.isArray(test.mailboxes)
        ? test.mailboxes.length
        : 0;
      const requiredCredits = mailboxesCount * DELIV_CREDITS_PER_MAILBOX;

      if (!test.creditsCharged) {
        const user = await User.findOne({ username }).lean(false);
        if (!user) {
          return res
            .status(404)
            .json({ ok: false, message: "User not found for credits check." });
        }

        const availableCredits =
          typeof user.credits === "number" ? user.credits : 0;

        if (availableCredits < requiredCredits) {
          return res.status(400).json({
            ok: false,
            code: "INSUFFICIENT_CREDITS",
            message: "You have insufficient credit balance to start this test.",
            requiredCredits,
            availableCredits,
          });
        }

        user.credits = availableCredits - requiredCredits;
        await user.save();

        await DeliverabilityTest.updateOne(
          { _id: id },
          {
            $set: {
              creditsUsed: requiredCredits,
              creditsCharged: true,
              updatedAt: new Date(),
            },
          },
        );
      }

      const finalSubject = subject || test.subject;
      if (!finalSubject) {
        return res.status(400).json({
          ok: false,
          message:
            "Subject is required. Provide it in body or save it on the test.",
        });
      }

      const ageMs = Date.now() - new Date(test.createdAt).getTime();
      if (ageMs >= MS_48H) {
        await DeliverabilityTest.updateOne(
          { _id: id },
          {
            $set: {
              status: "COMPLETED",
              subject: finalSubject,
              updatedAt: new Date(),
            },
          },
        );
        const fresh = await DeliverabilityTest.findById(id).lean();
        if (fresh)
          push(username, buildRealtimePayload(fresh, { event: "completed" }));
        return res.json({ ok: true, test: fresh });
      }

      await DeliverabilityTest.updateOne(
        { _id: id },
        {
          $set: {
            subject: finalSubject,
            status: "ACTIVE",
            lastRunRequestedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      const startedDoc = await DeliverabilityTest.findById(id).lean();
      if (startedDoc)
        push(username, buildRealtimePayload(startedDoc, { event: "started" }));

      runChecksInBackground(
        DeliverabilityTest,
        id,
        finalSubject,
        username,
        push,
      );

      const fresh = await DeliverabilityTest.findById(id).lean();
      const counts = computeCounts(fresh?.mailboxes || []);
      return res.json({ ok: true, started: true, test: fresh, counts });
    } catch (err) {
      console.error("run-check error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // DELETE /api/deliverability/tests/:id/cancel
  router.delete("/tests/:id/cancel", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username) {
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });
      }

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest) {
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });
      }

      const { id } = req.params;

      // ✅ Only allow cancel if test is not started yet
      const test = await DeliverabilityTest.findById(id).lean();
      if (!test) return res.json({ ok: true, deleted: false });

      if (String(test.status || "").toUpperCase() !== "NEW") {
        return res.status(400).json({
          ok: false,
          message: "Test already started. Cannot cancel.",
        });
      }

      // ✅ If it was never charged (expected case), just delete
      await DeliverabilityTest.deleteOne({ _id: id });

      push(username, {
        type: "deliverability:update",
        event: "cancelled",
        testId: String(id),
      });

      return res.json({ ok: true, deleted: true });
    } catch (err) {
      console.error("Cancel deliverability test error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // GET /api/deliverability/tests/:id/report (CSV)
  router.get("/tests/:id/report", async (req, res) => {
    try {
      const username = getUsernameFromReq(req);
      if (!username)
        return res
          .status(400)
          .json({ ok: false, message: "Username is required." });

      const DeliverabilityTest = getDeliverabilityModel(username);
      if (!DeliverabilityTest)
        return res
          .status(500)
          .json({ ok: false, message: "Could not resolve DB for username." });

      const { id } = req.params;
      const test = await DeliverabilityTest.findById(id).lean();
      if (!test)
        return res.status(404).json({ ok: false, message: "Test not found." });

      const mailboxes = Array.isArray(test.mailboxes) ? test.mailboxes : [];
      const counts = computeCounts(mailboxes);

      const creditsUsed =
        typeof test.creditsUsed === "number" && test.creditsUsed > 0
          ? test.creditsUsed
          : mailboxes.length * DELIV_CREDITS_PER_MAILBOX;

      const esc = (v) => (v == null ? "" : String(v).replace(/"/g, '""'));
      const rows = [];

      rows.push(["Test name", esc(test.name || "")]);
      rows.push(["Subject", esc(test.subject || "")]);
      rows.push(["Status", esc(test.status || "")]);
      rows.push([
        "Providers selected",
        esc((test.selectedProviders || []).join("|")),
      ]);
      rows.push([
        "Providers configured",
        esc((test.configuredProviders || []).join("|")),
      ]);
      rows.push(["Credits utilized", String(creditsUsed)]);
      rows.push(["Inbox count", String(counts.inbox)]);
      rows.push(["Spam count", String(counts.spam)]);
      rows.push(["Not received", String(counts.not_received)]);
      rows.push(["Errors", String(counts.error)]);
      rows.push(["Waiting", String(counts.waiting)]);
      rows.push([
        "Last run requested at",
        test.lastRunRequestedAt
          ? new Date(test.lastRunRequestedAt).toISOString()
          : "",
      ]);
      rows.push([
        "Created at",
        test.createdAt ? new Date(test.createdAt).toISOString() : "",
      ]);
      rows.push([
        "Updated at",
        test.updatedAt ? new Date(test.updatedAt).toISOString() : "",
      ]);
      rows.push([]);

      rows.push([
        "Provider",
        "Email",
        "Status",
        "Folder",
        "Last checked",
        "Error",
      ]);

      mailboxes.forEach((mb) => {
        rows.push([
          esc(mb.provider || ""),
          esc(mb.email || ""),
          esc(mb.status || ""),
          esc(mb.folder || ""),
          mb.lastCheckedAt ? new Date(mb.lastCheckedAt).toISOString() : "",
          esc(mb.error || ""),
        ]);
      });

      const csv = rows
        .map((r) => r.map((v) => `"${v}"`).join(","))
        .join("\r\n");
      const baseName =
        (test.name || `test-${id}`).replace(/[^\w.-]+/g, "_") || "report";
      const filename = `deliverability_${baseName}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.status(200).send(csv);
    } catch (err) {
      console.error("Download deliverability report error:", err);
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  // POST /api/deliverability/mailbox/cleanup
  router.post("/mailbox/cleanup", async (req, res) => {
    try {
      const { days, provider } = req.body || {};
      const nDays = Number(days || CLEANUP_DAYS);

      // If you want: restrict this to admin users only (recommended)
      // const username = getUsernameFromReq(req);
      // ... check role in User model ...

      if (provider) {
        const r = await cleanupProviderMailbox(String(provider), nDays);
        return res.json({ ok: true, mode: "single", ...r });
      }

      const all = await cleanupAllProviders(nDays);
      return res.json({ ok: true, mode: "all", ...all });
    } catch (err) {
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Cleanup failed." });
    }
  });

  // Debug route (optional)
  router.post("/test-connection", async (req, res) => {
    const { provider, mode = "imap", to } = req.body;

    try {
      if (!provider)
        return res
          .status(400)
          .json({ ok: false, message: "Provider is required." });

      const cfg = getProviderConfig(provider);
      if (!cfg) {
        return res.status(400).json({
          ok: false,
          message:
            "Provider not configured. Please check .env email & app password.",
        });
      }

      if (provider === "microsoft_business" && mode === "smtp") {
        return res
          .status(400)
          .json({
            ok: false,
            message: "SMTP debug not supported for Microsoft OAuth mailbox.",
          });
      }

      if (mode === "smtp") {
        const transporter = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.secure,
          auth: { user: cfg.email, pass: cfg.pass },
        });

        const recipient = to || cfg.email;
        const info = await transporter.sendMail({
          from: `"Deliverability Debug" <${cfg.email}>`,
          to: recipient,
          subject: `Deliverability debug ${new Date().toISOString()}`,
          text: "This is a test email from /test-connection SMTP.",
        });

        return res.json({
          ok: true,
          mode: "smtp",
          provider,
          from: cfg.email,
          to: recipient,
          messageId: info.messageId,
        });
      }

      const auth = await buildImapAuth(provider, cfg);

      const client = new ImapFlow({
        host: cfg.imap.host,
        port: cfg.imap.port,
        secure: cfg.imap.secure,
        auth,
        logger: false,
        socketTimeout: 60_000,
      });

      try {
        await client.connect();
        const lock = await client.getMailboxLock(cfg.inboxFolder || "INBOX");
        lock.release();
        await client.logout();
        return res.json({
          ok: true,
          mode: "imap",
          provider,
          email: cfg.email,
          note: "IMAP login successful.",
        });
      } catch (imapErr) {
        try {
          await client.logout();
        } catch {}
        return res.status(500).json({
          ok: false,
          message: "IMAP connection failed.",
          error: imapErr.message || String(imapErr),
        });
      }
    } catch {
      return res
        .status(500)
        .json({ ok: false, message: "Internal server error." });
    }
  });

  return router;
};
