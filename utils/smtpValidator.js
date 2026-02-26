
// // smtpValidator.js
// // ============================================================================
// // TRUE SENDR – SMTP VALIDATOR ENGINE
// // Provider-aware structure: Gmail / Google Workspace, Outlook / M365, Yahoo,
// // Zoho, Other providers, and Enterprise Gateways (Proofpoint, Mimecast, etc.).
// // ============================================================================

// const net = require('net');
// const tls = require('tls');
// const dns = require('dns').promises;
// const https = require('https');
// const http = require('http');
// const { URL } = require('url');
// const TrainingSample = require('../models/TrainingSample'); // 👈 NEW: training data

// /* ────────────────────────────────────────────────────────────────────────────
//  *  GLOBAL RUNTIME / TIMEOUTS / RETRIES
//  *  (Not provider-specific)
//  * ──────────────────────────────────────────────────────────────────────────── */

// const CONNECT_TIMEOUT_MS = +process.env.SMTP_CONNECT_TIMEOUT_MS || 7000;
// const COMMAND_TIMEOUT_MS = +process.env.SMTP_COMMAND_TIMEOUT_MS || 6000;
// const MAX_RCPT_RETRIES   = +process.env.SMTP_RCPT_RETRIES || 1;
// const MX_TTL_MS          = +process.env.MX_TTL_MS || 60 * 60 * 1000;
// const CATCHALL_TTL_MS    = +process.env.CATCHALL_TTL_MS || 24 * 60 * 60 * 1000;

// const PROBE_HELO         = process.env.SMTP_HELO || 'truesendr.com';
// const PROBE_SENDER       = process.env.SMTP_PROBE_SENDER || 'probe@truesendr.com';
// const PROBE_SENDER_ALT   = process.env.SMTP_PROBE_SENDER_ALT || '';

// const OWNER_VERIFY_TIMEOUT_MS = +process.env.OWNER_VERIFY_TIMEOUT_MS || 2500;
// const OWNER_CACHE_TTL_MS      = +process.env.OWNER_CACHE_TTL_MS || 5 * 60 * 1000;

// // Greylisting/Retry knobs (generic)
// const RCPT_RETRY_DELAY_MS = +process.env.SMTP_RETRY_DELAY_MS || 700;
// const PER_MX_ATTEMPTS     = +process.env.SMTP_PER_MX_ATTEMPTS || 1;

// // Ambiguity “second socket” escalation (generic)
// const AMBIGUOUS_SECOND_SOCKET =
//   String(process.env.AMBIGUOUS_SECOND_SOCKET || 'true').toLowerCase() === 'true';

// // Stabilizer knobs (used by validateSMTPStable)
// const STABILIZE_ROUNDS     = +(process.env.STABILIZE_ROUNDS || 3);
// const STABILIZE_BUDGET_MS  = +(process.env.STABILIZE_BUDGET_MS || 9000);
// const STABILIZE_GAP_MS     = +(process.env.STABILIZE_GAP_MS || 800);

// // Enterprise / gateway general behaviour (shared by multiple providers)
// const GATEWAY_DOWNGRADE_5XX_TO_RISKY =
//   String(process.env.GATEWAY_DOWNGRADE_5XX_TO_RISKY || 'false').toLowerCase() === 'true';

// const STRICT_CATCHALL =
//   String(process.env.STRICT_CATCHALL || 'false').toLowerCase() === 'true';

// const ENTERPRISE_CATCHALL_PROMOTE =
//   String(process.env.ENTERPRISE_CATCHALL_PROMOTE || 'false').toLowerCase() === 'true';

// const ENTERPRISE_GATEWAY_AS_UNKNOWN =
//   String(process.env.ENTERPRISE_GATEWAY_AS_UNKNOWN || 'true').toLowerCase() === 'true';

// // NEW: Bias Barracuda-protected domains toward "risky" instead of "unknown"
// const BARRACUDA_RISKY_BIAS =
//   String(process.env.BARRACUDA_RISKY_BIAS || 'true').toLowerCase() === 'true';

// /* ────────────────────────────────────────────────────────────────────────────
//  *  MULTI-PROFILE PROBES (multiple HELO + MAIL FROM)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function parseListEnv(key, fallback) {
//   const raw = process.env[key];
//   if (!raw) return [fallback];
//   const arr = String(raw)
//     .split(',')
//     .map((s) => s.trim())
//     .filter(Boolean);
//   return arr.length ? arr : [fallback];
// }

// const PROBE_HELO_LIST = parseListEnv('SMTP_HELO_LIST', PROBE_HELO);
// const PROBE_SENDER_LIST = parseListEnv('SMTP_PROBE_SENDER_LIST', PROBE_SENDER);
// const PROBE_PROFILE_MAX = +(process.env.PROBE_PROFILE_MAX || 3);
// const PROBE_PROFILE_GAP_MS = +(process.env.PROBE_PROFILE_GAP_MS || 400);

// function buildProbeProfiles() {
//   const maxLen = Math.max(PROBE_HELO_LIST.length, PROBE_SENDER_LIST.length);
//   const profiles = [];
//   for (let i = 0; i < maxLen; i++) {
//     const helo = PROBE_HELO_LIST[i] || PROBE_HELO_LIST[0] || PROBE_HELO;
//     const sender = PROBE_SENDER_LIST[i] || PROBE_SENDER_LIST[0] || PROBE_SENDER;
//     profiles.push({ helo, sender });
//   }
//   return profiles;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  PROVIDER-SPECIFIC TOGGLES (wired from .env)
//  * ──────────────────────────────────────────────────────────────────────────── */

// // Gmail / Google Workspace strictness
// const GWORKSPACE_STRICT_MODE =
//   String(process.env.GWORKSPACE_STRICT_MODE || 'false').toLowerCase() === 'true';

// // For corporate Google Workspace catch-all handling (optional aggressive behaviour)
// const GWORKSPACE_CATCHALL_AS_INVALID =
//   String(process.env.GWORKSPACE_CATCHALL_AS_INVALID || 'false').toLowerCase() === 'true';

// // Microsoft 365 / Outlook strictness & heuristics
// const MS365_STRICT_INVALID =
//   String(process.env.MS365_STRICT_INVALID || 'true').toLowerCase() === 'true';

// const MS365_HEURISTIC_PAIRWISE =
//   String(process.env.MS365_HEURISTIC_PAIRWISE || 'true').toLowerCase() === 'true';

// const M365_STRICT_MODE =
//   String(process.env.M365_STRICT_MODE || 'true').toLowerCase() === 'true';

// // Yahoo strictness
// const YAHOO_STRICT_MODE =
//   String(process.env.YAHOO_STRICT_MODE || 'false').toLowerCase() === 'true';

// // Zoho strictness
// const ZOHO_STRICT_MODE =
//   String(process.env.ZOHO_STRICT_MODE || 'false').toLowerCase() === 'true';

// // Other / custom corporate providers strictness
// // true = be strict for non-free, non-disposable domains that are not Google/Microsoft/Yahoo/Zoho
// const OTHER_CORP_STRICT_MODE =
//   String(process.env.OTHER_CORP_STRICT_MODE || 'true').toLowerCase() === 'true';

// /* ────────────────────────────────────────────────────────────────────────────
//  *  POLICY LISTS: BANK & HIGH-RISK DOMAINS (from .env)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function parseDomainList(envVal) {
//   return new Set(
//     String(envVal || '')
//       .split(',')
//       .map((s) =>
//         s
//           .trim()
//           .toLowerCase()
//           .replace(/^@+/, '') // allow entries like "@example.com"
//       )
//       .filter(Boolean)
//   );
// }

// const BANK_DOMAIN_SET = parseDomainList(process.env.BANK_DOMAINS);
// const HIGH_RISK_DOMAIN_SET = parseDomainList(process.env.HIGH_RISK_DOMAINS);

// /* ────────────────────────────────────────────────────────────────────────────
//  *  OWNER VERIFIER (optional plugin) – used across ALL providers
//  * ──────────────────────────────────────────────────────────────────────────── */

// let OWNER_VERIFY_MAP = {};
// try {
//   OWNER_VERIFY_MAP = JSON.parse(process.env.OWNER_VERIFY_MAP || '{}');
// } catch {
//   OWNER_VERIFY_MAP = {};
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  DOMAIN FLAGS – used for all providers
//  * ──────────────────────────────────────────────────────────────────────────── */

// const disposableDomains = new Set(['mailinator.com', 'tempmail.com', '10minutemail.com']);
// const freeProviders     = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']);
// const rolePrefixes      = new Set([
  
//   "admin",
//   "administrator",
//   "support",
//   "help",
//   "helpdesk",
//   "sales",
//   "info",
//   "contact",
//   "hello",
//   "team",
//   "office",
//   "billing",
//   "accounts",
//   "accounting",
//   "finance",
//   "payments",
//   "orders",
//   "order",
//   "booking",
//   "bookings",
//   "customerservice",
//   "customercare",
//   "customer",
//   "service",
//   "services",
//   "newsletter",
//   "news",
//   "notifications",
//   "notification",
//   "alerts",
//   "alert",
//   "noreply",
//   "no-reply",
//   "donotreply",
//   "do-not-reply",
//   "system",
//   "jobs",
//   "careers",
//   "career",
//   "hr",
//   "recruiting",
//   "talent",
//   "press",
//   "pr",
//   "media",
//   "postmaster",
//   "webmaster",
//   "abuse",
//   "security",
//   "marketing",
//   "devops",
//   "it",
//   "legal",
//   "compliance",
//   "privacy",
// ]);

// /* ────────────────────────────────────────────────────────────────────────────
//  *  ENTERPRISE GATEWAYS – Proofpoint, Mimecast, Barracuda, etc.
//  * ──────────────────────────────────────────────────────────────────────────── */

// const GATEWAY_PATTERNS = {
//   mimecast:        /(^|\.)mimecast\.com$/i,
//   mimecast_alt:    /(^|\.)mcsv\.net$/i,
//   proofpoint:      /(^|\.)pphosted\.com$/i,
//   barracuda:       /(^|\.)barracudanetworks\.com$/i,
//   ironport:        /(^|\.)iphmx\.com$/i,
//   topsec:          /(^|\.)topsec\.com$/i,
//   symantec:        /(^|\.)messagelabs\.com$/i,
//   sophos:          /(^|\.)sophos\.com$/i,
//   ms_eop:          /(^|\.)protection\.outlook\.com$/i // Microsoft EOP gateway
// };

// function matchGateway(host) {
//   const h = (host || '').toLowerCase();
//   for (const [name, re] of Object.entries(GATEWAY_PATTERNS)) {
//     if (re.test(h)) return name;
//   }
//   return null;
// }

// // “Trusted enterprise gateway” flavour: Proofpoint, Mimecast etc.
// function detectTrustedGateway(mxHost, provider, gatewayName) {
//   const blob = `${mxHost || ''} ${provider || ''} ${gatewayName || ''}`.toLowerCase();
//   if (blob.includes('pphosted.com') || blob.includes('proofpoint')) return 'proofpoint';
//   if (blob.includes('mimecast')) return 'mimecast';
//   if (blob.includes('barracuda')) return 'barracuda';
//   return null;
// }

// // Helper: detect if provider string indicates enterprise security gateway
// function isEnterpriseProvider(name) {
//   const s = String(name || '').toLowerCase();
//   return /proofpoint|mimecast|barracuda|ironport|topsec|messagelabs|sophos|protection\.outlook\.com|outlook|microsoft|office365|exchange/i.test(
//     s
//   );
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  PROVIDER BUCKET HELPERS
//  * ──────────────────────────────────────────────────────────────────────────── */

// function isGoogleWorkspaceProvider(name) {
//   const s = String(name || '').toLowerCase();
//   return s.includes('gmail / google workspace') || s.includes('google');
// }

// function isMicrosoftProvider(name) {
//   const s = String(name || '').toLowerCase();
//   return (
//     s.includes('outlook / microsoft 365') ||
//     s.includes('protection.outlook.com') ||
//     s.includes('outlook') ||
//     s.includes('microsoft')
//   );
// }

// function isYahooProvider(name) {
//   const s = String(name || '').toLowerCase();
//   return s.includes('yahoo');
// }

// function isZohoProvider(name) {
//   const s = String(name || '').toLowerCase();
//   return s.includes('zoho');
// }

// function isBarracudaGateway(provider, gatewayName) {
//   const p = String(provider || '').toLowerCase();
//   const g = String(gatewayName || '').toLowerCase();
//   return g === 'barracuda' || /barracuda/.test(p);
// }


// /* ────────────────────────────────────────────────────────────────────────────
//  *  CACHES – shared across all providers
//  * ──────────────────────────────────────────────────────────────────────────── */

// const mxCache = new Map();       // domain -> { hosts, provider, gateway, expiresAt }
// const catchAllCache = new Map(); // domain -> { isCatchAll, until }
// const ownerCache = new Map();    // email -> { data, until }

// // NEW: training cache – domain -> { stats, until }
// const trainingDomainCache = new Map();
// const TRAINING_TTL_MS = +process.env.TRAINING_TTL_MS || 10 * 60 * 1000;

// /* ────────────────────────────────────────────────────────────────────────────
//  *  MX → PROVIDER LABEL MAPPING
//  * ──────────────────────────────────────────────────────────────────────────── */

// function mxToProvider(mxCsv) {
//   const s = (mxCsv || '').toLowerCase();
//   if (s.includes('mimecast.com')) return 'Mimecast Secure Email Gateway';
//   if (s.includes('pphosted.com') || s.includes('proofpoint.com'))
//     return 'Proofpoint Email Protection';
//   if (s.includes('barracudanetworks.com')) return 'Barracuda Email Security Gateway';
//   if (s.includes('google.com')) return 'Gmail / Google Workspace';
//   if (s.includes('protection.outlook.com') || s.includes('outlook.com'))
//     return 'Outlook / Microsoft 365';
//   if (s.includes('zoho.com')) return 'Zoho Mail';
//   if (s.includes('yahoodns.net')) return 'Yahoo Mail';
//   if (s.includes('protonmail')) return 'ProtonMail';
//   if (s.includes('amazonses.com') || s.includes('awsapps.com'))
//     return 'Amazon WorkMail / SES';
//   const first = (s.split(',')[0] || 'n/a').trim();
//   return `Custom / Unknown Provider [${first}]`;
// }

// async function resolveMxCached(domain) {
//   const now = Date.now();
//   const hit = mxCache.get(domain);
//   if (hit && hit.expiresAt > now) return hit;

//   let records = [];
//   try {
//     records = await dns.resolveMx(domain);
//   } catch {}
//   const sorted = (records || []).sort((a, b) => a.priority - b.priority);
//   const mxCsv = sorted.map((r) => r.exchange.toLowerCase()).join(',');
//   const gateway = sorted.map((r) => matchGateway(r.exchange)).find(Boolean) || null;
//   const provider = mxToProvider(mxCsv);

//   const val = { hosts: sorted, provider, gateway, expiresAt: now + MX_TTL_MS };
//   mxCache.set(domain, val);
//   return val;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  LOW-LEVEL SMTP SOCKET + COMMAND HELPERS
//  * ──────────────────────────────────────────────────────────────────────────── */

// async function connectSmtp(host) {
//   return await new Promise((resolve, reject) => {
//     const sock = new net.Socket({ allowHalfOpen: false });
//     let settled = false;

//     const finish = (err) => {
//       if (settled) return;
//       settled = true;
//       cleanup();
//       if (err) {
//         try {
//           sock.destroy();
//         } catch {}
//         reject(err);
//       } else {
//         sock.on('error', () => {});
//         resolve(sock);
//       }
//     };

//     const cleanup = () => {
//       clearTimeout(timer);
//       sock.removeListener('connect', onConnect);
//       sock.removeListener('error', onError);
//     };

//     const onConnect = () => finish(null);
//     const onError = (e) => finish(e || new Error('connect-error'));

//     const timer = setTimeout(() => finish(new Error('connect-timeout')), CONNECT_TIMEOUT_MS);

//     sock.once('connect', onConnect);
//     sock.once('error', onError);
//     try {
//       sock.connect(25, host);
//     } catch (e) {
//       onError(e);
//     }
//   });
// }

// // Multi-line aware read (handles 250- continuations)
// function readLine(sock) {
//   return new Promise((resolve, reject) => {
//     let buf = '';
//     let timer = null;

//     const fail = (err) => {
//       cleanup();
//       reject(err || new Error('socket-error'));
//     };

//     const resetTimer = () => {
//       if (timer) clearTimeout(timer);
//       timer = setTimeout(() => fail(new Error('command-timeout')), COMMAND_TIMEOUT_MS);
//     };

//     const onData = (chunk) => {
//       buf += chunk.toString('utf8');
//       if (/\r?\n$/.test(buf)) {
//         const lines = buf.split(/\r?\n/).filter(Boolean);
//         const last = lines[lines.length - 1] || '';
//         if (!/^\d{3}-/.test(last)) {
//           cleanup();
//           return resolve(buf);
//         }
//       }
//       resetTimer();
//     };

//     const onErr = (e) => fail(e);
//     const onClose = () => fail(new Error('socket-closed'));

//     const cleanup = () => {
//       if (timer) clearTimeout(timer);
//       sock.removeListener('data', onData);
//       sock.removeListener('error', onErr);
//       sock.removeListener('close', onClose);
//     };

//     resetTimer();
//     sock.on('data', onData);
//     sock.once('error', onErr);
//     sock.once('close', onClose);
//   });
// }

// async function sendCmd(sock, line) {
//   if (!sock || sock.destroyed) throw new Error('socket-destroyed');
//   try {
//     sock.write(line + '\r\n');
//   } catch (e) {
//     throw e;
//   }
//   return await readLine(sock);
// }

// function parseCode(resp) {
//   const m = (resp || '').match(/^(\d{3})/m);
//   return m ? +m[1] : 0;
// }
// function parseEnhanced(resp) {
//   const m = (resp || '').match(/^\d{3}\s+(\d\.\d\.\d)/m);
//   return m ? m[1] : null;
// }
// function betterThan(a, b) {
//   const rank = { '2.1.5': 5, '2.1.1': 4, '2.1.0': 3, '2.0.0': 2 };
//   return (rank[a] || 0) > (rank[b] || 0);
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  GENERIC SMTP CATEGORIZATION (before provider logic)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function categorize(code) {
//   if (code >= 200 && code < 300) return { status: 'deliverable', sub_status: 'accepted' };
//   if (code >= 500) return { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//   if (code >= 400) return { status: 'risky', sub_status: 'greylisted' };
//   return { status: 'unknown', sub_status: 'smtp_ambiguous' };
// }

// function analyzeEmail(email) {
//   const out = { domain: 'N/A', disposable: false, free: false, role: false };
//   if (!email || !email.includes('@')) return out;
//   const [local, domain] = email.split('@');
//   out.domain = (domain || '').toLowerCase();
//   out.disposable = disposableDomains.has(out.domain);
//   out.free = freeProviders.has(out.domain);
//   out.role = rolePrefixes.has((local || '').toLowerCase());
//   return out;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  POLICY vs MAILBOX DETECTION (shared across providers)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function isPolicyBlock(resp) {
//   const s = (resp || '').toLowerCase();
//   const policyHints = [
//     'spf ',
//     ' spf-',
//     ' dmarc',
//     ' dkim',
//     'authentication',
//     'auth failure',
//     'auth failed',
//     'relay access denied',
//     'relaying denied',
//     'not permitted',
//     'policy violation',
//     'blocked by policy',
//     'message blocked',
//     'rate limit',
//     'too many connections',
//     'throttl',
//     'tls required',
//     'requires tls',
//     'client host rejected',
//     'spamhaus',
//     'block list',
//     'blacklist'
//   ];
//   return policyHints.some((h) => s.includes(h));
// }

// function isAccessDeniedPolicy(resp, enh) {
//   const s = (resp || '').toLowerCase();
//   const e = String(enh || '').toLowerCase();
//   if (/^5\.1\./.test(e)) return false;
//   if (/^5\.7\./.test(e)) return true;
//   return /(access\s+denied|not\s+authorized|unauthorized|permission\s+denied)/.test(s);
// }

// function isMailboxUnknownEnhanced(enh) {
//   return (
//     /^5\.1\.1$/.test(enh || '') ||
//     /^5\.1\.0$/.test(enh || '') ||
//     /^5\.2\.1$/.test(enh || '') ||
//     /^5\.4\.1$/.test(enh || '')
//   );
// }
// function isMailboxUnknownText(resp) {
//   const s = (resp || '').toLowerCase();
//   const phrases = [
//     'user unknown',
//     'unknown user',
//     'no such user',
//     'no such recipient',
//     'recipient unknown',
//     'mailbox unavailable',
//     'mailbox not found',
//     'invalid recipient',
//     'not a known user',
//     'address does not exist',
//     'no mailbox here',
//     'account disabled',
//     'recipient not found',
//     'user not found',
//     'unknown recipient',
//     'undeliverable address',
//     'bad destination mailbox address',
//     'resolver.adr.recipientnotfound',
//     'resolver.adr.exrecipnotfound',
//     'recipient address rejected: access denied',
//     'recipient address rejected'
//   ];
//   return phrases.some((p) => s.includes(p));
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  MICROSOFT-SPECIFIC HELPERS
//  * ──────────────────────────────────────────────────────────────────────────── */

// function isMsTenant(hint) {
//   const s = String(hint || '').toLowerCase();
//   return /protection\.outlook\.com|mail\.protection\.outlook\.com|outlook\.com|microsoft/i.test(
//     s
//   );
// }

// function isMsRecipientNotFound(resp, enh) {
//   const s = String(resp || '').toLowerCase();
//   const e = String(enh || '').toLowerCase();
//   if (
//     /(^|[^0-9])5\.1\.1([^0-9]|$)/.test(e) ||
//     /(^|[^0-9])5\.1\.10([^0-9]|$)/.test(e) ||
//     /(^|[^0-9])5\.4\.1([^0-9]|$)/.test(e)
//   )
//     return true;
//   const phrases = [
//     'resolver.adr.recipientnotfound',
//     'resolver.adr.exrecipnotfound',
//     'smtp; 550 5.1.10',
//     'smtp; 550 5.1.1',
//     '550 5.1.10',
//     '550 5.1.1',
//     '550 5.4.1',
//     'recipient address rejected: access denied'
//   ];
//   return phrases.some((p) => s.includes(p));
// }

// function containsRecipientish(s) {
//   const x = String(s || '').toLowerCase();
//   return /(recipient|mailbox|user).*(unknown|not\s+found|reject|does\s+not\s+exist)/.test(x);
// }
// function mentionsInfraPolicy(s) {
//   const x = String(s || '').toLowerCase();
//   return /(spf|dmarc|dkim|ip|blacklist|block\s*list|spamhaus|tls|required|relay|banned|blocked|unauthorized|not\s+authorized)/.test(
//     x
//   );
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  SCORING & CONFIDENCE (applied after provider logic)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function scoreFrom(result, flags) {
//   let score = 80;
//   if (result.status === 'deliverable') score = 95;
//   if (result.status === 'undeliverable') score = 5;
//   if (result.status === 'risky') score = 45;
//   if (result.status === 'unknown') score = 35;
//   if (flags.disposable) score -= 30;
//   if (flags.free) score -= 10;
//   if (flags.role) score -= 10;
//   if (result.sub_status === 'catch_all' || result.sub_status === 'gworkspace_catchall_ambiguous')
//     score -= 20;
//   if (result.sub_status === 'mailbox_full') score -= 10;
//   return Math.max(0, Math.min(100, score));
// }

// function confidenceFrom(result, enhancedSignals) {
//   let c = 0.55;
//   if (result.status === 'deliverable') c = 0.85;
//   if (result.status === 'undeliverable') c = 0.95;
//   if (result.status === 'risky' && result.sub_status === 'catch_all') c = 0.75;
//   if (result.status === 'unknown') c = 0.4;
//   if (enhancedSignals.realBetterThanBogus) c += 0.08;
//   if (enhancedSignals.nullSenderAgreesDeliverable) c += 0.05;
//   if (enhancedSignals.nullSenderAgreesUndeliverable) c += 0.05;
//   return Math.max(0, Math.min(0.99, c));
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  OWNER VERIFIER PLUGIN (used by all providers)
//  * ──────────────────────────────────────────────────────────────────────────── */

// async function verifyOwner(email, domain) {
//   const url = OWNER_VERIFY_MAP[domain];
//   if (!url) return null;
//   const cached = ownerCache.get(email);
//   if (cached && cached.until > Date.now()) return cached.data;

//   try {
//     const u = new URL(url);
//     const lib = u.protocol === 'https:' ? https : http;
//     const payload = Buffer.from(JSON.stringify({ email }), 'utf8');
//     const opts = {
//       method: 'POST',
//       hostname: u.hostname,
//       port: u.port || (u.protocol === 'https:' ? 443 : 80),
//       path: u.pathname + (u.search || ''),
//       headers: {
//         'Content-Type': 'application/json',
//         'Content-Length': payload.length,
//         ...(process.env.OWNER_VERIFY_AUTH
//           ? { Authorization: process.env.OWNER_VERIFY_AUTH }
//           : {})
//       },
//       timeout: OWNER_VERIFY_TIMEOUT_MS
//     };
//     const data = await new Promise((resolve) => {
//       const req = lib.request(opts, (res) => {
//         let body = '';
//         res.on('data', (d) => (body += d));
//         res.on('end', () => {
//           try {
//             resolve(JSON.parse(body));
//           } catch {
//             resolve(null);
//           }
//         });
//       });
//       req.on('error', () => resolve(null));
//       req.on('timeout', () => {
//         try {
//           req.destroy();
//         } catch {}
//         resolve(null);
//       });
//       req.write(payload);
//       req.end();
//     });
//     ownerCache.set(email, { until: Date.now() + OWNER_CACHE_TTL_MS, data });
//     return data;
//   } catch {
//     return null;
//   }
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  TRAINING DATA HELPERS (domain-level aggregates)
//  * ──────────────────────────────────────────────────────────────────────────── */

// async function getDomainTrainingHint(domain) {
//   const key = String(domain || '').toLowerCase();
//   if (!key) return null;

//   const now = Date.now();
//   const cached = trainingDomainCache.get(key);
//   if (cached && cached.until > now) return cached.stats;

//   try {
//     const rows = await TrainingSample.aggregate([
//       { $match: { domain: key } },
//       {
//         $group: {
//           _id: '$domain',
//           total: { $sum: '$totalSamples' },
//           valid: { $sum: { $ifNull: ['$labelCounts.valid', 0] } },
//           invalid: { $sum: { $ifNull: ['$labelCounts.invalid', 0] } },
//           risky: { $sum: { $ifNull: ['$labelCounts.risky', 0] } },
//           unknown: { $sum: { $ifNull: ['$labelCounts.unknown', 0] } },
//         },
//       },
//     ]);

//     if (!rows.length || !rows[0].total) {
//       trainingDomainCache.set(key, { stats: null, until: now + TRAINING_TTL_MS });
//       return null;
//     }

//     const r = rows[0];
//     const total = r.total || 0;
//     const stats = {
//       total,
//       valid: r.valid || 0,
//       invalid: r.invalid || 0,
//       risky: r.risky || 0,
//       unknown: r.unknown || 0,
//       validRatio: (r.valid || 0) / total,
//       invalidRatio: (r.invalid || 0) / total,
//       riskyRatio: (r.risky || 0) / total,
//       unknownRatio: (r.unknown || 0) / total,
//     };

//     trainingDomainCache.set(key, { stats, until: now + TRAINING_TTL_MS });
//     return stats;
//   } catch (e) {
//     trainingDomainCache.set(key, { stats: null, until: now + TRAINING_TTL_MS });
//     return null;
//   }
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  CORE RCPT PROBE on a single MX (provider-agnostic base)
//  * ──────────────────────────────────────────────────────────────────────────── */

// async function checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride) {
//   const helo = heloOverride || PROBE_HELO;
//   let socket = null;
//   let signals = {
//     realEnh: null,
//     bogusEnh: null,
//     realNullEnh: null,
//     realBetterThanBogus: false,
//     nullSenderAgreesDeliverable: false,
//     nullSenderAgreesUndeliverable: false
//   };
//   const trustedGateway = detectTrustedGateway(mxHost, provider, gatewayName);

//   try {
//     socket = await connectSmtp(mxHost);
//     await readLine(socket);

//     // EHLO + opportunistic STARTTLS (all providers)
//     let ehlo = await sendCmd(socket, `EHLO ${helo}`);
//     if (/^250[ -].*STARTTLS/im.test(ehlo)) {
//       const startTlsResp = await sendCmd(socket, 'STARTTLS');
//       if (/^220/i.test(startTlsResp)) {
//         socket = await new Promise((resolve, reject) => {
//           const secure = tls.connect({ socket, servername: mxHost }, () => resolve(secure));
//           secure.once('error', reject);
//         });
//         ehlo = await sendCmd(socket, `EHLO ${helo}`);
//       }
//     }

//     // First pass MAIL/RCPT
//     await sendCmd(socket, `MAIL FROM:<${sender}>`);
//     let real1 = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
//     let codeReal = parseCode(real1);
//     signals.realEnh = parseEnhanced(real1);
//     let base = categorize(codeReal);

//     // ───────────────── 5xx REFINEMENT (all providers, but Microsoft-aware) ─────────────────
//     if (codeReal >= 500) {
//       const eh = signals.realEnh || '';
//       const msTenant = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);

//       if (/^5\.4\./.test(eh)) {
//         base = { status: 'risky', sub_status: 'policy_block_spf' };
//       } else if (MS365_STRICT_INVALID && msTenant && isMsRecipientNotFound(real1, signals.realEnh)) {
//         base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//       } else if (isMailboxUnknownEnhanced(signals.realEnh) || isMailboxUnknownText(real1)) {
//         base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//       } else if (isPolicyBlock(real1)) {
//         base = { status: 'risky', sub_status: 'policy_block_spf' };
//       } else {
//         base = { status: 'undeliverable', sub_status: '5xx_other' };
//       }
//     }

//     // ───────────────── 4xx RETRIES (greylisting / temporary) ─────────────────
//     if (codeReal >= 400 && codeReal < 500 && MAX_RCPT_RETRIES > 0) {
//       for (let i = 0; i < MAX_RCPT_RETRIES; i++) {
//         await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
//         real1 = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
//         codeReal = parseCode(real1);
//         const maybe = parseEnhanced(real1);
//         signals.realEnh = maybe || signals.realEnh;
//         base = categorize(codeReal);

//         if (codeReal >= 500) {
//           const msTenant = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);
//           if (MS365_STRICT_INVALID && msTenant && isMsRecipientNotFound(real1, signals.realEnh)) {
//             base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//           } else if (isMailboxUnknownEnhanced(signals.realEnh) || isMailboxUnknownText(real1)) {
//             base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//           } else if (isPolicyBlock(real1)) {
//             base = { status: 'risky', sub_status: 'policy_block_spf' };
//           } else {
//             base = { status: 'undeliverable', sub_status: '5xx_other' };
//           }
//           break;
//         }
//         if (codeReal >= 200 && codeReal < 300) break;
//       }
//     }

//     // FAST EXIT: clean deliverable and we don't insist on catch-all probing
//     if (base.status === 'deliverable' && base.sub_status !== 'catch_all' && !STRICT_CATCHALL) {
//       try {
//         socket.write('QUIT\r\n');
//       } catch {}
//       return { result: base, signals };
//     }

//     // ───────────────── NULL-SENDER RE-CHECK (all providers) ─────────────────
//     await sendCmd(socket, 'RSET');
//     await sendCmd(socket, 'MAIL FROM:<>');
//     const realNull = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
//     const codeNull = parseCode(realNull);
//     signals.realNullEnh = parseEnhanced(realNull);

//     if (codeReal >= 500 && codeNull >= 200 && codeNull < 300) {
//       const eh = signals.realEnh || '';
//       if (isAccessDeniedPolicy(real1, eh) || isPolicyBlock(real1) || /^5\.7\./.test(eh)) {
//         signals.nullSenderAgreesDeliverable = true;
//         base = { status: 'deliverable', sub_status: 'accepted' };
//       }
//     } else {
//       if (codeNull >= 200 && codeNull < 300 && codeReal >= 200 && codeReal < 300) {
//         if (betterThan(signals.realNullEnh, signals.realEnh)) signals.realEnh = signals.realNullEnh;
//         signals.nullSenderAgreesDeliverable = true;
//       }
//       if (codeNull >= 500 && codeReal >= 500) signals.nullSenderAgreesUndeliverable = true;
//     }

//     // ───────────────── ALT SENDER RETRY (policy / SPF issues) ─────────────────
//     if (base.status === 'risky' && base.sub_status === 'policy_block_spf' && PROBE_SENDER_ALT) {
//       await sendCmd(socket, 'RSET');
//       await sendCmd(socket, `MAIL FROM:<${PROBE_SENDER_ALT}>`);
//       const altResp = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
//       const altCode = parseCode(altResp);
//       const altEnh = parseEnhanced(altResp);

//       if (altCode >= 200 && altCode < 300) {
//         signals.realEnh = altEnh || signals.realEnh;
//         base = categorize(altCode);
//       } else if (
//         altCode >= 500 &&
//         (isMailboxUnknownEnhanced(altEnh) || isMailboxUnknownText(altResp))
//       ) {
//         base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//       } else if (altCode >= 500 && isPolicyBlock(altResp)) {
//         base = { status: 'risky', sub_status: 'policy_block_spf' };
//       } else if (altCode >= 400 && altCode < 500) {
//         base = { status: 'risky', sub_status: 'greylisted' };
//       }
//     }

//     // ───────────────── CATCH-ALL PROBES (bogus RCPTs) ─────────────────
//     const bogusProbe = async (fromLine) => {
//       await sendCmd(socket, 'RSET');
//       await sendCmd(socket, fromLine);
//       const bogus = `__probe_${Math.random().toString(36).slice(2, 10)}`;
//       const resp = await sendCmd(socket, `RCPT TO:<${bogus}@${domain}>`);
//       let code = parseCode(resp);
//       let enh = parseEnhanced(resp);
//       if (code >= 400 && code < 500) {
//         await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
//         const resp2 = await sendCmd(socket, `RCPT TO:<${bogus}@${domain}>`);
//         code = parseCode(resp2);
//         enh = parseEnhanced(resp2) || enh;
//       }
//       return { code, enh };
//     };

//     const b1 = await bogusProbe(`MAIL FROM:<${sender}>`);
//     const b2 = await bogusProbe('MAIL FROM:<>');
//     const isCatchAll = (b1.code >= 200 && b1.code < 300) || (b2.code >= 200 && b2.code < 300);
//     signals.bogusEnh = b1.enh || b2.enh || null;

//     const providerIsMimecast = /mimecast/i.test(provider || '');
//     const isBigProvider = /google|mail\.protection\.outlook\.com|protection\.outlook\.com|outlook|yahoodns|protonmail|amazonses|awsapps/i.test(
//       provider || ''
//     );
//     const isGoogleProvider = isGoogleWorkspaceProvider(provider);

//     if (isBigProvider && codeReal >= 200 && codeReal < 300 && isCatchAll) {
//       base = { status: 'risky', sub_status: 'catch_all' };
//     }

//     // IMPORTANT: do NOT "upgrade" catch-all to accepted for Google Workspace
//     if (
//       isCatchAll &&
//       betterThan(signals.realEnh, signals.bogusEnh) &&
//       !providerIsMimecast &&
//       !isGoogleProvider
//     ) {
//       signals.realBetterThanBogus = true;
//       base = { status: 'deliverable', sub_status: 'accepted' };
//     }

//     // ───────────────── ENTERPRISE GATEWAY ADJUSTMENTS ─────────────────
//     const isGateway =
//       !!gatewayName ||
//       /mimecast|pphosted|barracuda|topsec|messagelabs|iphmx|sophos|protection\.outlook\.com/i.test(
//         provider || ''
//       );

//     const gwNameLower = String(gatewayName || '').toLowerCase();
//     const isBarracudaGw =
//       gwNameLower === 'barracuda' ||
//       /barracuda/.test(String(provider || '').toLowerCase()) ||
//       /barracuda/.test(String(mxHost || '').toLowerCase());

//     if (GATEWAY_DOWNGRADE_5XX_TO_RISKY && isGateway) {
//       const sub = isBarracudaGw ? 'gateway_protected_barracuda' : 'gateway_protected';
//       if (base.status === 'undeliverable' && base.sub_status === '5xx_other') {
//         base = { status: 'risky', sub_status: sub };
//       } else if (base.status === 'risky' && base.sub_status === 'policy_block_spf') {
//         base = { status: 'risky', sub_status: sub };
//       }
//     }

//     const msTenantFinal = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);
//     if (MS365_HEURISTIC_PAIRWISE && msTenantFinal && codeReal >= 500 && !isCatchAll) {
//       if (containsRecipientish(real1) && !mentionsInfraPolicy(real1)) {
//         base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
//       }
//     }

//     try {
//       socket.write('QUIT\r\n');
//     } catch {}

//     // Trusted gateways (e.g. Proofpoint) with catch-all: keep 2xx as deliverable
//     if (isCatchAll && base.status === 'deliverable' && !signals.realBetterThanBogus) {
//       if (trustedGateway === 'proofpoint') {
//         const sub =
//           base.sub_status && base.sub_status !== 'catch_all'
//             ? base.sub_status
//             : 'gateway_accepted';
//         return { result: { ...base, status: 'deliverable', sub_status: sub }, signals };
//       }
//       return { result: { status: 'risky', sub_status: 'catch_all' }, signals };
//     }
//     return { result: base, signals };
//   } catch {
//     return { result: { status: 'unknown', sub_status: 'network' }, signals };
//   }
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  AMBIGUITY ESCALATION (second socket)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function isAmbiguous(res) {
//   if (!res) return true;
//   const st = res.status,
//     sub = res.sub_status || '';
//   if (st === 'undeliverable') return false;
//   if (st === 'deliverable' && sub !== 'catch_all') return false;
//   return true;
// }

// async function checkMailboxWithEscalation(
//   mxHost,
//   sender,
//   rcpt,
//   provider,
//   domain,
//   gatewayName,
//   heloOverride
// ) {
//   const one = await checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride);
//   if (!AMBIGUOUS_SECOND_SOCKET || !isAmbiguous(one.result)) return one;
//   const two = await checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride);
//   const rank = (v) =>
//     v.status === 'undeliverable'
//       ? 4
//       : v.status === 'deliverable' && v.sub_status !== 'catch_all'
//       ? 3
//       : v.status === 'risky'
//       ? 2
//       : 1;
//   return rank(two.result) >= rank(one.result) ? two : one;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  PROVIDER PROFILE LAYER (MAIN PER-PROVIDER SPLIT)
//  * ──────────────────────────────────────────────────────────────────────────── */

// function applyProviderProfile(result, signals, meta) {
//   const provider = result.provider || '';
//   const domain = (meta && meta.domain ? meta.domain : result.domain || '').toLowerCase();

//   const isGoogleFamily = isGoogleWorkspaceProvider(provider);
//   const isMicrosoftFam = isMicrosoftProvider(provider);
//   const isYahooFam     = isYahooProvider(provider);
//   const isZohoFam      = isZohoProvider(provider);

//   // meta flags from analyzeEmail(...)
//   const flags = {
//     free: !!(meta && meta.free),
//     disposable: !!(meta && meta.disposable),
//     role: !!(meta && meta.role),
//   };

//   const corporate = !flags.free && !flags.disposable;

//   // ────────────────────────────── 1) GOOGLE: GMAIL / GOOGLE WORKSPACE ─────────────────────
//   if (isGoogleFamily) {
//     const isCatchAllLike =
//       result.sub_status === 'catch_all' ||
//       result.sub_status === 'gworkspace_catchall_ambiguous';

//     // Catch-all handling for Google Workspace
//     if (isCatchAllLike) {
//       if (corporate) {
//         if (GWORKSPACE_CATCHALL_AS_INVALID) {
//           result.status = 'undeliverable';
//           result.sub_status = 'gworkspace_catchall_invalid';
//         } else {
//           result.status = 'risky';
//           result.sub_status = 'gworkspace_catchall_ambiguous';
//         }
//       } else {
//         result.status = 'risky';
//         result.sub_status = 'gworkspace_catchall_ambiguous';
//       }
//       return result;
//     }

//     // STRICT MODE for Workspace (non-gmail.com, non-free)
//     if (GWORKSPACE_STRICT_MODE && corporate) {
//       if (result.status === 'deliverable' && result.sub_status === 'accepted') {
//         const trustedSignals =
//           signals.realBetterThanBogus || signals.nullSenderAgreesDeliverable;
//         if (!trustedSignals) {
//           result.status = 'risky';
//           result.sub_status = 'gworkspace_deliverable_unconfirmed';
//         }
//       }
//     }

//     return result;
//   }

//   // ───────────────────────── 2) MICROSOFT: OUTLOOK / MICROSOFT 365 / EXCHANGE ─────────────
//   if (isMicrosoftFam && !M365_STRICT_MODE) {
//     if (result.status === 'undeliverable' && result.sub_status === '5xx_other') {
//       result.status = 'risky';
//       result.sub_status = 'm365_ambiguous_5xx';
//     }
//     return result;
//   }

//   // ────────────────────────────── 3) YAHOO MAIL ─────────────────────────────
//   if (isYahooFam && !YAHOO_STRICT_MODE) {
//     if (result.status === 'risky' && result.sub_status === 'greylisted') {
//       result.status = 'unknown';
//       result.sub_status = 'yahoo_greylist';
//     }
//     return result;
//   }

//   // ────────────────────────────── 4) ZOHO MAIL ──────────────────────────────
//   if (isZohoFam && !ZOHO_STRICT_MODE) {
//     if (result.status === 'risky' && String(result.sub_status).includes('policy_block')) {
//       result.status = 'unknown';
//       result.sub_status = 'zoho_policy_unknown';
//     }
//     return result;
//   }

//   // ────────────────────────────── 5) OTHER PROVIDERS / DEFAULT ──────────────
//   return result;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  MAIN VALIDATOR (validateSMTP)
//  * ──────────────────────────────────────────────────────────────────────────── */

// async function validateSMTP(email, opts = {}) {
//   const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
//   logger('start', `Begin SMTP validation for ${email}`);

//   const meta = analyzeEmail(email);
//   const result = {
//     input: email,
//     normalized: email,
//     domain: meta.domain,
//     provider: 'Unavailable',
//     status: 'unknown',
//     sub_status: 'init',
//     score: 0,
//     flags: { disposable: meta.disposable, free: meta.free, role: meta.role }
//   };

//   // Syntax-only fail (any provider)
//   const syntaxOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '');
//   if (!syntaxOk) {
//     result.status = 'undeliverable';
//     result.sub_status = 'syntax';
//     result.score = scoreFrom(result, result.flags);
//     logger('syntax', 'Syntax invalid');
//     return toServerShape(result, {});
//   }

//   const domainLower = (meta.domain || '').toLowerCase();
//   const isBankDomain = BANK_DOMAIN_SET.has(domainLower);
//   const isHighRiskDomain = HIGH_RISK_DOMAIN_SET.has(domainLower);

//   // ─────────────────────────────────────────
//   // POLICY SHORTCUT: BANK / HIGH-RISK DOMAINS
//   // (MX only → provider, no SMTP probing)
//   // ─────────────────────────────────────────
//   if (isBankDomain || isHighRiskDomain) {
//     let providerLabel = 'Unavailable';
//     try {
//       const mx = await resolveMxCached(domainLower);
//       providerLabel = mx.provider || 'Unavailable';
//     } catch {}

//     result.provider = providerLabel;
//     result.status = 'risky';
//     result.sub_status = isBankDomain
//       ? 'bank_domain_policy'
//       : 'high_risk_domain_policy';
//     result.score = scoreFrom(result, result.flags);

//     const extras = {
//       confidence: 0.7,
//       reason: isBankDomain
//         ? 'Domain is configured as a bank / financial organization. Validation marked as Risky by policy without SMTP probing.'
//         : 'Domain is configured as high-risk. Validation marked as Risky by policy without SMTP probing.'
//     };

//     const shaped = toServerShape(result, extras);
//     shaped._stabilized = {
//       rounds: [
//         {
//           category: shaped.category,
//           sub_status: shaped.sub_status,
//           confidence: shaped.confidence
//         }
//       ],
//       elapsed_ms: 0
//     };
//     logger(
//       'policy',
//       `Policy shortcut for ${domainLower}: ${shaped.sub_status} (provider=${providerLabel})`
//     );
//     return shaped;
//   }

//   // Owner verifier (if configured for specific domains)
//   let owner = null;
//   try {
//     owner = await verifyOwner(email, meta.domain);
//   } catch {}
//   if (owner && typeof owner.exists === 'boolean') {
//     logger('owner', `Owner API: exists=${owner.exists}`);
//   }

//   // MX lookup → provider bucket & gateway detection
//   let hosts = [];
//   let provider = 'Unavailable';
//   let gatewayName = null;
//   try {
//     const mx = await resolveMxCached(meta.domain);
//     hosts = mx.hosts || [];
//     provider = mx.provider || 'Unavailable';
//     gatewayName = mx.gateway || null;
//   } catch {}
//   result.provider = provider;
//   logger('mx', `Provider: ${provider}; MX count: ${hosts.length}`);

//   if (!hosts.length) {
//     let hasA = false;
//     try {
//       const a = await dns.lookup(meta.domain);
//       hasA = !!a?.address;
//     } catch {}
//     if (!hasA) {
//       result.status = 'undeliverable';
//       result.sub_status = 'no_mx_or_a';
//       result.score = scoreFrom(result, result.flags);
//       logger('mx', 'No MX or A record → undeliverable');
//       return toServerShape(result, { owner });
//     }
//   }

//   const probeProfiles = buildProbeProfiles();
//   const enterpriseProvider = isEnterpriseProvider(provider);

//   // PROBING across MX hosts with our core checkMailboxWithEscalation
//   let probe;
//   try {
//     const toTry = hosts.slice(0, 3).map((h) => h.exchange);
//     outerLoop: for (const mxHost of (toTry.length ? toTry : [meta.domain])) {
//       logger('mx_host', `Probing MX host ${mxHost}`);

//       const profilesToUse = probeProfiles.slice(0, PROBE_PROFILE_MAX);
//       for (let idx = 0; idx < profilesToUse.length; idx++) {
//         const profile = profilesToUse[idx];
//         logger(
//           'profile',
//           `Using HELO=${profile.helo} SENDER=${profile.sender} on MX=${mxHost}`
//         );

//         // First attempt for this profile on this MX
//         const pr1 = await checkMailboxWithEscalation(
//           mxHost,
//           profile.sender,
//           email,
//           provider,
//           meta.domain,
//           gatewayName,
//           profile.helo
//         );
//         probe = pr1;
//         result.status = pr1.result.status;
//         result.sub_status = pr1.result.sub_status;
//         logger(
//           'rcpt',
//           `Result on ${mxHost} (profile ${idx + 1}): ${pr1.result.status} (${pr1.result.sub_status})`
//         );

//         if (result.status === 'undeliverable') {
//           // hard invalid – no need to try more profiles or MXs
//           break outerLoop;
//         }

//         if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) {
//           // Clean valid on non-enterprise – stop early
//           break outerLoop;
//         }

//         // Additional attempts on same MX + same profile (new sockets)
//         for (let attempt = 2; attempt <= PER_MX_ATTEMPTS; attempt++) {
//           logger(
//             'retry',
//             `Retrying same MX/profile in ${RCPT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PER_MX_ATTEMPTS})`
//           );
//           await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
//           const prX = await checkMailboxWithEscalation(
//             mxHost,
//             profile.sender,
//             email,
//             provider,
//             meta.domain,
//             gatewayName,
//             profile.helo
//           );
//           probe = prX;
//           result.status = prX.result.status;
//           result.sub_status = prX.result.sub_status;
//           logger(
//             'rcpt',
//             `Result on ${mxHost} (profile ${idx + 1}, attempt ${attempt}): ${prX.result.status} (${prX.result.sub_status})`
//           );

//           if (result.status === 'undeliverable') {
//             break outerLoop;
//           }
//           if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) {
//             break outerLoop;
//           }
//         }

//         // Between different profiles on same MX, wait a bit to avoid hammering
//         if (PROBE_PROFILE_GAP_MS > 0 && idx < profilesToUse.length - 1) {
//           await new Promise((r) => setTimeout(r, PROBE_PROFILE_GAP_MS));
//         }
//       }

//       // If we reached here and got a clean deliverable (on enterprise) or risky/unknown,
//       // we move to next MX unless already hard invalid / clear valid on non-enterprise.
//       if (result.status === 'undeliverable') break;
//       if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) break;
//     }
//   } catch {
//     result.status = 'unknown';
//     result.sub_status = 'no_connect';
//     probe = { signals: {} };
//     logger('network', 'No connect / unknown');
//   }

//   // Owner override (all providers – domain-specific)
//   if (owner && typeof owner.exists === 'boolean') {
//     if (owner.exists) {
//       result.status = 'deliverable';
//       result.sub_status = 'owner_verified';
//       logger('owner', 'Overriding to deliverable (owner verified)');
//     } else {
//       if (result.status === 'deliverable') {
//         result.status = 'risky';
//         result.sub_status = 'catch_all_owner_says_missing';
//       } else {
//         result.status = 'undeliverable';
//         result.sub_status = 'owner_verified_missing';
//       }
//       logger('owner', `Owner contradicts → ${result.status} (${result.sub_status})`);
//     }
//   }

//   // Enterprise catch-all promotion (global gateway rule, optional)
//   if (
//     ENTERPRISE_CATCHALL_PROMOTE &&
//     result.status === 'risky' &&
//     result.sub_status === 'catch_all'
//   ) {
//     const corporate = !result.flags.free && !result.flags.disposable;
//     const enterpriseProviderFlag = /proofpoint|mimecast|barracuda|ironport|topsec|messagelabs|sophos/i.test(
//       result.provider || ''
//     );
//     if (corporate && enterpriseProviderFlag) {
//       result.status = 'deliverable';
//       result.sub_status = 'gateway_accepted';
//       logger('promo', 'Promoting corporate catch-all on enterprise gateway to deliverable');
//     }
//   }

//   // Barracuda: play as safe as Bouncer
//   // ------------------------------------------------------------
//   // For corporate domains behind Barracuda:
//   // - never treat them as "clean valid" based only on 2xx
//   // - ambiguous / policy / unknown => always RISKY
//   {
//     const corporate = !result.flags.free && !result.flags.disposable;
//     const barracudaGw = isBarracudaGateway(result.provider, gatewayName);

//     if (corporate && barracudaGw) {
//       if (result.status === 'deliverable') {
//         // Barracuda saying 250 doesn't guarantee no bounce later
//         result.status = 'risky';
//         result.sub_status = 'barracuda_deliverable_untrusted';
//         logger(
//           'barracuda',
//           `Downgrading deliverable to risky for Barracuda-protected domain (${meta.domain})`
//         );
//       } else if (result.status === 'unknown') {
//         // if we had unknown, treat it as risky instead of unknown
//         result.status = 'risky';
//         if (!String(result.sub_status || '').includes('barracuda')) {
//           result.sub_status = 'gateway_protected_barracuda';
//         }
//         logger(
//           'barracuda',
//           `Normalizing unknown to risky for Barracuda-protected domain (${meta.domain})`
//         );
//       }
//     }
//   }

//   // Enterprise-gateway risky → unknown (gateway_hidden) for corporate domains,
//   // EXCEPT for Barracuda when BARRACUDA_RISKY_BIAS=true (keep as risky)
//   if (ENTERPRISE_GATEWAY_AS_UNKNOWN) {
//     const corporate = !result.flags.free && !result.flags.disposable;
//     const enterpriseProviderFlag = isEnterpriseProvider(result.provider);
//     const isBarracuda = isBarracudaGateway(result.provider, gatewayName);

//     if (
//       corporate &&
//       enterpriseProviderFlag &&
//       result.status === 'risky' &&
//       (String(result.sub_status).includes('gateway_protected') ||
//         String(result.sub_status).includes('policy_block') ||
//         String(result.sub_status) === 'greylisted')
//     ) {
//       if (isBarracuda && BARRACUDA_RISKY_BIAS) {
//         // keep them as risky, normalize sub_status
//         if (!String(result.sub_status).includes('barracuda')) {
//           result.sub_status = 'gateway_protected_barracuda';
//         }
//         logger(
//           'gateway',
//           `Keeping risky for Barracuda-protected corporate domain (${result.sub_status})`
//         );
//       } else {
//         logger(
//           'gateway',
//           `Downgrading risky (${result.sub_status}) on enterprise corporate domain to unknown (gateway_hidden)`
//         );
//         result.status = 'unknown';
//         result.sub_status = 'gateway_hidden';
//       }
//     }
//   }

//   // PROVIDER-SPECIFIC TUNING (Google / Microsoft / Yahoo / Zoho / Other)
//   applyProviderProfile(result, probe?.signals || {}, meta);

//   // ─────────────────────────────────────────────────────────────
//   // TRAINING-BASED ADJUSTMENTS (domain-level heuristics)
//   // ─────────────────────────────────────────────────────────────
//   try {
//     const stats = await getDomainTrainingHint(domainLower);
//     if (stats && stats.total >= 20) {
//       const { validRatio, invalidRatio, riskyRatio } = stats;
//       const corporateDomain = !result.flags.free && !result.flags.disposable;

//       // 1) Domain is overwhelmingly invalid → risky → invalid
//       if (
//         invalidRatio >= 0.9 &&
//         result.status === 'risky'
//       ) {
//         logger(
//           'training',
//           `Domain ${domainLower} mostly invalid in training (invalidRatio=${invalidRatio.toFixed(
//             2
//           )}) → upgrading risky→invalid`
//         );
//         result.status = 'undeliverable';
//         result.sub_status = 'trained_domain_mostly_invalid';
//       }

//       // 2) Domain has strong risky/invalid history → downgrade "too clean" deliverable
//       if (
//         corporateDomain &&
//         (invalidRatio + riskyRatio) >= 0.7 &&
//         result.status === 'deliverable'
//       ) {
//         logger(
//           'training',
//           `Domain ${domainLower} has high risky/invalid history (=${(
//             invalidRatio + riskyRatio
//           ).toFixed(2)}) → downgrading deliverable→risky`
//         );
//         result.status = 'risky';
//         result.sub_status = 'trained_domain_high_risky_history';
//       }

//       // 3) Domain is very clean but SMTP ambiguous → keep risky, but mark ambiguous
//       if (
//         validRatio >= 0.95 &&
//         (result.status === 'unknown' ||
//           (result.status === 'risky' && String(result.sub_status || '').includes('greylist')))
//       ) {
//         logger(
//           'training',
//           `Domain ${domainLower} mostly valid in training (validRatio=${validRatio.toFixed(
//             2
//           )}) but SMTP ambiguous → marking as risky (ambiguous)`
//         );
//         result.status = 'risky';
//         result.sub_status = 'trained_domain_mostly_valid_but_smtp_ambiguous';
//       }
//     }
//   } catch (e) {
//     logger('training_err', `Error while applying training heuristics: ${e.message || e}`);
//   }

//   // FINAL SCORE + CONFIDENCE + HUMAN REASON
//   result.score = scoreFrom(result, result.flags);
//   const confidence = confidenceFrom(result, probe?.signals || {});
//   let reason = '';
//   if (result.status === 'undeliverable') {
//     if (result.sub_status === 'gworkspace_catchall_invalid') {
//       reason =
//         'Google Workspace catch-all domain; this mailbox is very likely not provisioned.';
//     } else if (result.sub_status === 'trained_domain_mostly_invalid') {
//       reason =
//         'Training data shows this domain’s mailboxes are almost always invalid. SMTP result was risky, treated as invalid by training.';
//     } else {
//       reason = 'Server rejected mailbox (5xx) or owner says missing.';
//     }
//   } else if (result.status === 'deliverable') {
//     if (result.sub_status === 'gateway_accepted') {
//       reason = 'Mailbox accepted by enterprise email security gateway.';
//     } else if (result.sub_status === 'owner_verified') {
//       reason = 'Owner verified mailbox exists.';
//     } else {
//       reason = 'Server accepted mailbox (2xx).';
//     }
//   } else if (result.status === 'risky' && result.sub_status === 'gworkspace_catchall_ambiguous') {
//     reason =
//       'Google Workspace catch-all domain; this mailbox cannot be reliably verified via SMTP and may not exist.';
//   } else if (
//     result.status === 'risky' &&
//     String(result.sub_status).includes('catch_all')
//   ) {
//     reason = 'Domain accepts any address at RCPT (catch-all).';
//   } else if (
//     result.status === 'risky' &&
//     String(result.sub_status).includes('policy_block')
//   ) {
//     reason = 'Gateway blocked by policy (e.g., SPF) before revealing mailbox.';
//   } else if (
//     result.status === 'risky' &&
//     String(result.sub_status).includes('gateway_protected')
//   ) {
//     reason = 'Enterprise email security gateway masks mailbox status on RCPT.';
//   } else if (
//     result.status === 'risky' &&
//     result.sub_status === 'gworkspace_deliverable_unconfirmed'
//   ) {
//     reason = 'Google Workspace accepted RCPT but mailbox not fully trusted (strict mode).';
//   } else if (result.status === 'risky' && result.sub_status === 'm365_ambiguous_5xx') {
//     reason = 'Microsoft 365 returned ambiguous 5xx; treated as risky rather than invalid.';
//   } else if (result.status === 'risky' && result.sub_status === 'bank_domain_policy') {
//     reason =
//       'Domain is configured as a bank / financial institution. Validation marked as Risky by policy.';
//   } else if (result.status === 'risky' && result.sub_status === 'high_risk_domain_policy') {
//     reason =
//       'Domain is configured as high-risk. Validation marked as Risky by policy.';
//   } else if (result.status === 'risky' && result.sub_status === 'trained_domain_high_risky_history') {
//     reason =
//       'Training data shows this domain has a high proportion of risky/invalid mailboxes; treated as risky even though this probe was accepted.';
//   } else if (
//     result.status === 'risky' &&
//     result.sub_status === 'trained_domain_mostly_valid_but_smtp_ambiguous'
//   ) {
//     reason =
//       'Training data shows this domain is mostly valid, but SMTP responses were ambiguous/greylisted; treated as risky but not invalid.';
//   } else if (result.status === 'unknown' && result.sub_status === 'gateway_hidden') {
//     reason =
//       'Enterprise email gateway/policy hides mailbox status; SMTP verification not possible.';
//   } else if (result.status === 'unknown' && result.sub_status === 'yahoo_greylist') {
//     reason = 'Repeated greylist/temporary responses from Yahoo; mailbox status not confirmed.';
//   } else if (result.status === 'unknown' && result.sub_status === 'zoho_policy_unknown') {
//     reason = 'Zoho policy response; mailbox status not confirmed.';
//   } else if (result.status === 'risky') {
//     reason = 'Temporary deferral (4xx / greylist).';
//   } else {
//     reason = 'Network/unknown response.';
//   }
//   if (owner?.exists) reason += ' Owner verification strengthened confidence';

//   const extras = { confidence, reason, owner };
//   if (
//     result.status === 'risky' &&
//     (result.sub_status === 'catch_all' ||
//       result.sub_status === 'gworkspace_catchall_ambiguous' ||
//       String(result.sub_status).startsWith('policy_block') ||
//       result.sub_status === 'gateway_protected' ||
//       result.sub_status === 'gateway_protected_barracuda' ||
//       result.sub_status === 'gworkspace_deliverable_unconfirmed' ||
//       result.sub_status === 'm365_ambiguous_5xx' ||
//       result.sub_status === 'bank_domain_policy' ||
//       result.sub_status === 'high_risk_domain_policy' ||
//       result.sub_status === 'trained_domain_high_risky_history' ||
//       result.sub_status === 'trained_domain_mostly_valid_but_smtp_ambiguous')
//   )
//     extras.provisional = true;
//   if (result.status === 'unknown') extras.provisional = true;

//   const shaped = toServerShape(result, extras);
//   logger('finish', `SMTP decision: ${shaped.category} (${shaped.sub_status})`);
//   return shaped;
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  SHAPE RESULT FOR API RESPONSE
//  * ──────────────────────────────────────────────────────────────────────────── */

// function toServerShape(r, extras) {
//   let category = 'unknown';
//   if (r.status === 'deliverable') category = 'valid';
//   else if (r.status === 'undeliverable') category = 'invalid';
//   else if (r.status === 'risky') category = 'risky';

//   const icon =
//     r.status === 'deliverable'
//       ? '✅'
//       : r.status === 'undeliverable'
//       ? '❌'
//       : r.status === 'risky'
//       ? '⚠️'
//       : '❔';

//   const text =
//     r.status === 'deliverable'
//       ? r.sub_status === 'owner_verified'
//         ? 'Valid (Owner verified)'
//         : r.sub_status === 'gateway_accepted'
//         ? 'Valid (Gateway accepted)'
//         : 'Valid Email'
//       : r.status === 'undeliverable'
//       ? 'Invalid Email'
//       : r.status === 'risky'
//       ? r.sub_status === 'gworkspace_catchall_ambiguous'
//         ? 'Risky (Google Workspace catch-all)'
//         : r.sub_status === 'gworkspace_deliverable_unconfirmed'
//         ? 'Risky (Google Workspace – unconfirmed)'
//         : r.sub_status === 'barracuda_deliverable_untrusted'
//         ? 'Risky (Barracuda – untrusted)'
//         : r.sub_status === 'm365_ambiguous_5xx'
//         ? 'Risky (Microsoft 365 – ambiguous)'
//         : String(r.sub_status).includes('catch_all')
//         ? 'Risky (Catch-all)'
//         : r.sub_status === 'gateway_protected_barracuda'
//         ? 'Risky (Barracuda gateway)'
//         : String(r.sub_status).includes('gateway_protected')
//         ? 'Risky'
//         : String(r.sub_status).includes('policy_block')
//         ? 'Risky (Policy block)'
//         : r.sub_status === 'bank_domain_policy'
//         ? 'Risky (Bank domain policy)'
//         : r.sub_status === 'high_risk_domain_policy'
//         ? 'Risky (High-risk domain policy)'
//         : r.sub_status === 'trained_domain_high_risky_history'
//         ? 'Risky (Domain history)'
//         : r.sub_status === 'trained_domain_mostly_valid_but_smtp_ambiguous'
//         ? 'Risky (Ambiguous, domain mostly valid)'
//         : 'Risky'
//       : r.sub_status === 'gateway_hidden'
//       ? 'Unknown (Gateway protected)'
//       : r.sub_status === 'yahoo_greylist'
//       ? 'Unknown (Yahoo greylist)'
//       : r.sub_status === 'zoho_policy_unknown'
//       ? 'Unknown (Policy / Zoho)'
//       : 'Unknown';

//   return {
//     status: `${icon} ${text}`,
//     category,
//     domain: r.domain,
//     provider: r.provider,
//     isDisposable: r.flags.disposable,
//     isFree: r.flags.free,
//     isRoleBased: r.flags.role,
//     score: r.score,
//     sub_status: r.sub_status,
//     confidence: typeof extras.confidence === 'number' ? extras.confidence : undefined,
//     reason: extras.reason || undefined,
//     owner: extras.owner || undefined,
//     provisional: extras.provisional || undefined,
//     _raw: { status: r.status, sub_status: r.sub_status, score: r.score, extras }
//   };
// }

// /* ────────────────────────────────────────────────────────────────────────────
//  *  STABILIZER WRAPPER (validateSMTPStable)
//  * ──────────────────────────────────────────────────────────────────────────── */

// const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// function agree(a, b) {
//   if (!a || !b) return false;
//   return a.category === b.category;
// }
// function pickStrongest(rounds, category) {
//   const candidates = rounds.filter((r) => r.category === category);
//   if (!candidates.length) return null;
//   return candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
// }
// function reconcileRounds(rounds) {
//   const counts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
//   let bestValid = null;

//   for (const r of rounds) {
//     counts[r.category] = (counts[r.category] || 0) + 1;
//     if (r.category === 'valid') {
//       const conf =
//         typeof r.confidence === 'number' ? r.confidence : r._raw?.extras?.confidence || 0;
//       if (!bestValid || conf > (bestValid.confidence || 0)) bestValid = r;
//     }
//   }

//   if (counts.invalid >= 1) return pickStrongest(rounds, 'invalid');

//   if (bestValid) {
//     const validConf = bestValid.confidence || 0;
//     const bestRisky = pickStrongest(rounds, 'risky');
//     const riskyConf = bestRisky ? bestRisky.confidence || 0 : 0;

//     if (bestRisky && counts.risky >= 2 && riskyConf > validConf + 0.15) {
//       return bestRisky;
//     }
//     return bestValid;
//   }

//   if (counts.risky) return pickStrongest(rounds, 'risky');
//   return pickStrongest(rounds, 'unknown') || rounds[rounds.length - 1];
// }

// async function validateSMTPStable(email, opts = {}) {
//   const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
//   const rounds = [];
//   const start = Date.now();

//   for (let i = 0; i < STABILIZE_ROUNDS; i++) {
//     const r = await validateSMTP(email, opts);
//     rounds.push(r);

//     // if policy already decided (bank/high-risk), no need for more rounds
//     if (
//       r.sub_status === 'bank_domain_policy' ||
//       r.sub_status === 'high_risk_domain_policy'
//     ) {
//       logger(
//         'policy_stable_loop',
//         `Stopping stabilizer loop early for ${email} due to policy sub_status=${r.sub_status}`
//       );
//       break;
//     }

//     if (i > 0 && agree(rounds[i - 1], rounds[i])) break;
//     if (r.category === 'invalid') break;

//     const elapsed = Date.now() - start;
//     if (elapsed + STABILIZE_GAP_MS > STABILIZE_BUDGET_MS) break;
//     await sleep(STABILIZE_GAP_MS);
//   }

//   const final = reconcileRounds(rounds);
//   final._stabilized = {
//     rounds: rounds.map((r) => ({
//       category: r.category,
//       sub_status: r.sub_status,
//       confidence: r.confidence
//     })),
//     elapsed_ms: Date.now() - start
//   };
//   logger(
//     'finish',
//     `Stabilized: ${final.category} (${final.sub_status}) after ${final._stabilized.rounds.length} rounds`
//   );
//   return final;
// }

// module.exports = { validateSMTP, validateSMTPStable };






// smtpValidator.js
// ============================================================================
// TRUE SENDR – SMTP VALIDATOR ENGINE
// Provider-aware structure: Gmail / Google Workspace, Outlook / M365, Yahoo,
// Zoho, Other providers, and Enterprise Gateways (Proofpoint, Mimecast, etc.).
// ============================================================================

const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const { URL } = require('url');
const TrainingSample = require('../models/TrainingSample'); // 👈 NEW: training data

/* ────────────────────────────────────────────────────────────────────────────
 *  GLOBAL RUNTIME / TIMEOUTS / RETRIES
 *  (Not provider-specific)
 * ──────────────────────────────────────────────────────────────────────────── */

const CONNECT_TIMEOUT_MS = +process.env.SMTP_CONNECT_TIMEOUT_MS || 7000;
const COMMAND_TIMEOUT_MS = +process.env.SMTP_COMMAND_TIMEOUT_MS || 6000;
const MAX_RCPT_RETRIES   = +process.env.SMTP_RCPT_RETRIES || 1;
const MX_TTL_MS          = +process.env.MX_TTL_MS || 60 * 60 * 1000;
const CATCHALL_TTL_MS    = +process.env.CATCHALL_TTL_MS || 24 * 60 * 60 * 1000;

const PROBE_HELO         = process.env.SMTP_HELO || 'truesendr.com';
const PROBE_SENDER       = process.env.SMTP_PROBE_SENDER || 'probe@truesendr.com';
const PROBE_SENDER_ALT   = process.env.SMTP_PROBE_SENDER_ALT || '';

const OWNER_VERIFY_TIMEOUT_MS = +process.env.OWNER_VERIFY_TIMEOUT_MS || 2500;
const OWNER_CACHE_TTL_MS      = +process.env.OWNER_CACHE_TTL_MS || 5 * 60 * 1000;

// Greylisting/Retry knobs (generic)
const RCPT_RETRY_DELAY_MS = +process.env.SMTP_RETRY_DELAY_MS || 700;
const PER_MX_ATTEMPTS     = +process.env.SMTP_PER_MX_ATTEMPTS || 1;

// Ambiguity “second socket” escalation (generic)
const AMBIGUOUS_SECOND_SOCKET =
  String(process.env.AMBIGUOUS_SECOND_SOCKET || 'true').toLowerCase() === 'true';

// Stabilizer knobs (used by validateSMTPStable)
const STABILIZE_ROUNDS     = +(process.env.STABILIZE_ROUNDS || 3);
const STABILIZE_BUDGET_MS  = +(process.env.STABILIZE_BUDGET_MS || 9000);
const STABILIZE_GAP_MS     = +(process.env.STABILIZE_GAP_MS || 800);

// Enterprise / gateway general behaviour (shared by multiple providers)
const GATEWAY_DOWNGRADE_5XX_TO_RISKY =
  String(process.env.GATEWAY_DOWNGRADE_5XX_TO_RISKY || 'false').toLowerCase() === 'true';

const STRICT_CATCHALL =
  String(process.env.STRICT_CATCHALL || 'false').toLowerCase() === 'true';

const ENTERPRISE_CATCHALL_PROMOTE =
  String(process.env.ENTERPRISE_CATCHALL_PROMOTE || 'false').toLowerCase() === 'true';

const ENTERPRISE_GATEWAY_AS_UNKNOWN =
  String(process.env.ENTERPRISE_GATEWAY_AS_UNKNOWN || 'true').toLowerCase() === 'true';

// NEW: Bias Barracuda-protected domains toward "risky" instead of "unknown"
const BARRACUDA_RISKY_BIAS =
  String(process.env.BARRACUDA_RISKY_BIAS || 'true').toLowerCase() === 'true';

/* ────────────────────────────────────────────────────────────────────────────
 *  MULTI-PROFILE PROBES (multiple HELO + MAIL FROM)
 * ──────────────────────────────────────────────────────────────────────────── */

function parseListEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw) return [fallback];
  const arr = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : [fallback];
}

const PROBE_HELO_LIST = parseListEnv('SMTP_HELO_LIST', PROBE_HELO);
const PROBE_SENDER_LIST = parseListEnv('SMTP_PROBE_SENDER_LIST', PROBE_SENDER);
const PROBE_PROFILE_MAX = +(process.env.PROBE_PROFILE_MAX || 3);
const PROBE_PROFILE_GAP_MS = +(process.env.PROBE_PROFILE_GAP_MS || 400);

function buildProbeProfiles() {
  const maxLen = Math.max(PROBE_HELO_LIST.length, PROBE_SENDER_LIST.length);
  const profiles = [];
  for (let i = 0; i < maxLen; i++) {
    const helo = PROBE_HELO_LIST[i] || PROBE_HELO_LIST[0] || PROBE_HELO;
    const sender = PROBE_SENDER_LIST[i] || PROBE_SENDER_LIST[0] || PROBE_SENDER;
    profiles.push({ helo, sender });
  }
  return profiles;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  PROVIDER-SPECIFIC TOGGLES (wired from .env)
 * ──────────────────────────────────────────────────────────────────────────── */

// Gmail / Google Workspace strictness
const GWORKSPACE_STRICT_MODE =
  String(process.env.GWORKSPACE_STRICT_MODE || 'false').toLowerCase() === 'true';

// For corporate Google Workspace catch-all handling (optional aggressive behaviour)
const GWORKSPACE_CATCHALL_AS_INVALID =
  String(process.env.GWORKSPACE_CATCHALL_AS_INVALID || 'false').toLowerCase() === 'true';

// Microsoft 365 / Outlook strictness & heuristics
const MS365_STRICT_INVALID =
  String(process.env.MS365_STRICT_INVALID || 'true').toLowerCase() === 'true';

const MS365_HEURISTIC_PAIRWISE =
  String(process.env.MS365_HEURISTIC_PAIRWISE || 'true').toLowerCase() === 'true';

const M365_STRICT_MODE =
  String(process.env.M365_STRICT_MODE || 'true').toLowerCase() === 'true';

// Yahoo strictness
const YAHOO_STRICT_MODE =
  String(process.env.YAHOO_STRICT_MODE || 'false').toLowerCase() === 'true';

// Zoho strictness
const ZOHO_STRICT_MODE =
  String(process.env.ZOHO_STRICT_MODE || 'false').toLowerCase() === 'true';

// Other / custom corporate providers strictness
// true = be strict for non-free, non-disposable domains that are not Google/Microsoft/Yahoo/Zoho
const OTHER_CORP_STRICT_MODE =
  String(process.env.OTHER_CORP_STRICT_MODE || 'true').toLowerCase() === 'true';

/* ────────────────────────────────────────────────────────────────────────────
 *  POLICY LISTS: BANK & HIGH-RISK DOMAINS (from .env)
 * ──────────────────────────────────────────────────────────────────────────── */

function parseDomainList(envVal) {
  return new Set(
    String(envVal || '')
      .split(',')
      .map((s) =>
        s
          .trim()
          .toLowerCase()
          .replace(/^@+/, '') // allow entries like "@example.com"
      )
      .filter(Boolean)
  );
}

const BANK_DOMAIN_SET = parseDomainList(process.env.BANK_DOMAINS);
const HIGH_RISK_DOMAIN_SET = parseDomainList(process.env.HIGH_RISK_DOMAINS);

// Government/official domain patterns (automatically treated as risky)
const GOVERNMENT_TLD_PATTERNS = [
  /\.gov$/i,           // US government (.gov)
  /\.gov\.[a-z]{2}$/i, // International government (.gov.uk, .gov.au, etc.)
  /\.mil$/i,           // US military (.mil)
  /\.edu$/i,           // Educational institutions (.edu)
  /\.ac\.[a-z]{2}$/i,  // Academic institutions (.ac.uk, .ac.jp, etc.)
  /\.gouv\.[a-z]{2}$/i // French government (.gouv.fr, etc.)
];

function isGovernmentDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return GOVERNMENT_TLD_PATTERNS.some(pattern => pattern.test(d));
}

/* ────────────────────────────────────────────────────────────────────────────
 *  OWNER VERIFIER (optional plugin) – used across ALL providers
 * ──────────────────────────────────────────────────────────────────────────── */

let OWNER_VERIFY_MAP = {};
try {
  OWNER_VERIFY_MAP = JSON.parse(process.env.OWNER_VERIFY_MAP || '{}');
} catch {
  OWNER_VERIFY_MAP = {};
}

/* ────────────────────────────────────────────────────────────────────────────
 *  DOMAIN FLAGS – used for all providers
 * ──────────────────────────────────────────────────────────────────────────── */

const disposableDomains = new Set(['mailinator.com', 'tempmail.com', '10minutemail.com']);
const freeProviders     = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']);
const rolePrefixes      = new Set([
  
  "admin",
  "administrator",
  "support",
  "help",
  "helpdesk",
  "sales",
  "info",
  "contact",
  "hello",
  "team",
  "office",
  "billing",
  "accounts",
  "accounting",
  "finance",
  "payments",
  "orders",
  "order",
  "booking",
  "bookings",
  "customerservice",
  "customercare",
  "customer",
  "service",
  "services",
  "newsletter",
  "news",
  "notifications",
  "notification",
  "alerts",
  "alert",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "system",
  "jobs",
  "careers",
  "career",
  "hr",
  "recruiting",
  "talent",
  "press",
  "pr",
  "media",
  "postmaster",
  "webmaster",
  "abuse",
  "security",
  "marketing",
  "devops",
  "it",
  "legal",
  "compliance",
  "privacy",
]);

/* ────────────────────────────────────────────────────────────────────────────
 *  ENTERPRISE GATEWAYS – Proofpoint, Mimecast, Barracuda, etc.
 * ──────────────────────────────────────────────────────────────────────────── */

const GATEWAY_PATTERNS = {
  mimecast:        /(^|\.)mimecast\.com$/i,
  mimecast_alt:    /(^|\.)mcsv\.net$/i,
  proofpoint:      /(^|\.)(pphosted\.com|ppe-hosted\.com|proofpoint\.com)$/i,
  barracuda:       /(^|\.)barracudanetworks\.com$/i,
  ironport:        /(^|\.)iphmx\.com$/i,
  topsec:          /(^|\.)topsec\.com$/i,
  symantec:        /(^|\.)messagelabs\.com$/i,
  sophos:          /(^|\.)sophos\.com$/i,
  ms_eop:          /(^|\.)protection\.outlook\.com$/i // Microsoft EOP gateway
};




function matchGateway(host) {
  const h = (host || '').toLowerCase();
  for (const [name, re] of Object.entries(GATEWAY_PATTERNS)) {
    if (re.test(h)) return name;
  }
  return null;
}

// “Trusted enterprise gateway” flavour: Proofpoint, Mimecast etc.
function detectTrustedGateway(mxHost, provider, gatewayName) {
  const blob = `${mxHost || ''} ${provider || ''} ${gatewayName || ''}`.toLowerCase();
  if (blob.includes('pphosted.com') || blob.includes('ppe-hosted.com') || blob.includes('proofpoint')) return 'proofpoint';
  if (blob.includes('mimecast')) return 'mimecast';
  if (blob.includes('barracuda')) return 'barracuda';
  return null;
}

// Helper: detect if provider string indicates enterprise security gateway
function isEnterpriseProvider(name) {
  const s = String(name || '').toLowerCase();
  return /proofpoint|mimecast|barracuda|ironport|topsec|messagelabs|sophos|protection\.outlook\.com|outlook|microsoft|office365|exchange/i.test(
    s
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 *  PROVIDER BUCKET HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

function isGoogleWorkspaceProvider(name) {
  const s = String(name || '').toLowerCase();
  return s.includes('gmail / google workspace') || s.includes('google');
}

function isMicrosoftProvider(name) {
  const s = String(name || '').toLowerCase();
  return (
    s.includes('outlook / microsoft 365') ||
    s.includes('protection.outlook.com') ||
    s.includes('outlook') ||
    s.includes('microsoft')
  );
}

function isYahooProvider(name) {
  const s = String(name || '').toLowerCase();
  return s.includes('yahoo');
}

function isZohoProvider(name) {
  const s = String(name || '').toLowerCase();
  return s.includes('zoho');
}

function isBarracudaGateway(provider, gatewayName) {
  const p = String(provider || '').toLowerCase();
  const g = String(gatewayName || '').toLowerCase();
  return g === 'barracuda' || /barracuda/.test(p);
}


/* ────────────────────────────────────────────────────────────────────────────
 *  CACHES – shared across all providers
 * ──────────────────────────────────────────────────────────────────────────── */

const mxCache = new Map();       // domain -> { hosts, provider, gateway, expiresAt }
const catchAllCache = new Map(); // domain -> { isCatchAll, until }
const ownerCache = new Map();    // email -> { data, until }

// NEW: training cache – domain -> { stats, until }
const trainingDomainCache = new Map();
const TRAINING_TTL_MS = +process.env.TRAINING_TTL_MS || 10 * 60 * 1000;

/* ────────────────────────────────────────────────────────────────────────────
 *  MX → PROVIDER LABEL MAPPING
 * ──────────────────────────────────────────────────────────────────────────── */

function mxToProvider(mxCsv) {
  const s = (mxCsv || '').toLowerCase();
  if (s.includes('mimecast.com')) return 'Mimecast Secure Email Gateway';
  if (s.includes('pphosted.com') || s.includes('ppe-hosted.com') || s.includes('proofpoint.com'))
    return 'Proofpoint Email Protection';
  if (s.includes('barracudanetworks.com')) return 'Barracuda Email Security Gateway';
  if (s.includes('google.com')) return 'Gmail / Google Workspace';
  if (s.includes('protection.outlook.com') || s.includes('outlook.com'))
    return 'Outlook / Microsoft 365';
  if (s.includes('zoho.com')) return 'Zoho Mail';
  if (s.includes('yahoodns.net')) return 'Yahoo Mail';
  if (s.includes('protonmail')) return 'ProtonMail';
  if (s.includes('amazonses.com') || s.includes('awsapps.com'))
    return 'Amazon WorkMail / SES';
  const first = (s.split(',')[0] || 'n/a').trim();
  return `Custom / Unknown Provider [${first}]`;
}

async function resolveMxCached(domain) {
  const now = Date.now();
  const hit = mxCache.get(domain);
  if (hit && hit.expiresAt > now) return hit;

  let records = [];
  try {
    records = await dns.resolveMx(domain);
  } catch {}
  const sorted = (records || []).sort((a, b) => a.priority - b.priority);
  const mxCsv = sorted.map((r) => r.exchange.toLowerCase()).join(',');
  const gateway = sorted.map((r) => matchGateway(r.exchange)).find(Boolean) || null;
  const provider = mxToProvider(mxCsv);

  const val = { hosts: sorted, provider, gateway, expiresAt: now + MX_TTL_MS };
  mxCache.set(domain, val);
  return val;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  LOW-LEVEL SMTP SOCKET + COMMAND HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

async function connectSmtp(host) {
  return await new Promise((resolve, reject) => {
    const sock = new net.Socket({ allowHalfOpen: false });
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        try {
          sock.destroy();
        } catch {}
        reject(err);
      } else {
        sock.on('error', () => {});
        resolve(sock);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('connect', onConnect);
      sock.removeListener('error', onError);
    };

    const onConnect = () => finish(null);
    const onError = (e) => finish(e || new Error('connect-error'));

    const timer = setTimeout(() => finish(new Error('connect-timeout')), CONNECT_TIMEOUT_MS);

    sock.once('connect', onConnect);
    sock.once('error', onError);
    try {
      sock.connect(25, host);
    } catch (e) {
      onError(e);
    }
  });
}

// Multi-line aware read (handles 250- continuations)
function readLine(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let timer = null;

    const fail = (err) => {
      cleanup();
      reject(err || new Error('socket-error'));
    };

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('command-timeout')), COMMAND_TIMEOUT_MS);
    };

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (/\r?\n$/.test(buf)) {
        const lines = buf.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || '';
        if (!/^\d{3}-/.test(last)) {
          cleanup();
          return resolve(buf);
        }
      }
      resetTimer();
    };

    const onErr = (e) => fail(e);
    const onClose = () => fail(new Error('socket-closed'));

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
    };

    resetTimer();
    sock.on('data', onData);
    sock.once('error', onErr);
    sock.once('close', onClose);
  });
}

async function sendCmd(sock, line) {
  if (!sock || sock.destroyed) throw new Error('socket-destroyed');
  try {
    sock.write(line + '\r\n');
  } catch (e) {
    throw e;
  }
  return await readLine(sock);
}

function parseCode(resp) {
  const m = (resp || '').match(/^(\d{3})/m);
  return m ? +m[1] : 0;
}
function parseEnhanced(resp) {
  const m = (resp || '').match(/^\d{3}\s+(\d\.\d\.\d)/m);
  return m ? m[1] : null;
}
function betterThan(a, b) {
  const rank = { '2.1.5': 5, '2.1.1': 4, '2.1.0': 3, '2.0.0': 2 };
  return (rank[a] || 0) > (rank[b] || 0);
}

/* ────────────────────────────────────────────────────────────────────────────
 *  GENERIC SMTP CATEGORIZATION (before provider logic)
 * ──────────────────────────────────────────────────────────────────────────── */

function categorize(code) {
  if (code >= 200 && code < 300) return { status: 'deliverable', sub_status: 'accepted' };
  if (code >= 500) return { status: 'undeliverable', sub_status: 'mailbox_not_found' };
  if (code >= 400) return { status: 'risky', sub_status: 'greylisted' };
  return { status: 'unknown', sub_status: 'smtp_ambiguous' };
}

function analyzeEmail(email) {
  const out = { domain: 'N/A', disposable: false, free: false, role: false };
  if (!email || !email.includes('@')) return out;
  const [local, domain] = email.split('@');
  out.domain = (domain || '').toLowerCase();
  out.disposable = disposableDomains.has(out.domain);
  out.free = freeProviders.has(out.domain);
  out.role = rolePrefixes.has((local || '').toLowerCase());
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  POLICY vs MAILBOX DETECTION (shared across providers)
 * ──────────────────────────────────────────────────────────────────────────── */

function isPolicyBlock(resp) {
  const s = (resp || '').toLowerCase();
  const policyHints = [
    'spf ',
    ' spf-',
    ' dmarc',
    ' dkim',
    'authentication',
    'auth failure',
    'auth failed',
    'relay access denied',
    'relaying denied',
    'not permitted',
    'policy violation',
    'blocked by policy',
    'message blocked',
    'rate limit',
    'too many connections',
    'throttl',
    'tls required',
    'requires tls',
    'client host rejected',
    'spamhaus',
    'block list',
    'blacklist'
  ];
  return policyHints.some((h) => s.includes(h));
}

function isAccessDeniedPolicy(resp, enh) {
  const s = (resp || '').toLowerCase();
  const e = String(enh || '').toLowerCase();
  if (/^5\.1\./.test(e)) return false;
  if (/^5\.7\./.test(e)) return true;
  return /(access\s+denied|not\s+authorized|unauthorized|permission\s+denied)/.test(s);
}

function isMailboxUnknownEnhanced(enh) {
  return (
    /^5\.1\.1$/.test(enh || '') ||
    /^5\.1\.0$/.test(enh || '') ||
    /^5\.2\.1$/.test(enh || '') ||
    /^5\.4\.1$/.test(enh || '')
  );
}
function isMailboxUnknownText(resp) {
  const s = (resp || '').toLowerCase();
  const phrases = [
    'user unknown',
    'unknown user',
    'no such user',
    'no such recipient',
    'recipient unknown',
    'mailbox unavailable',
    'mailbox not found',
    'invalid recipient',
    'not a known user',
    'address does not exist',
    'no mailbox here',
    'account disabled',
    'recipient not found',
    'user not found',
    'unknown recipient',
    'undeliverable address',
    'bad destination mailbox address',
    'resolver.adr.recipientnotfound',
    'resolver.adr.exrecipnotfound',
    'recipient address rejected: access denied',
    'recipient address rejected'
  ];
  return phrases.some((p) => s.includes(p));
}

/* ────────────────────────────────────────────────────────────────────────────
 *  MICROSOFT-SPECIFIC HELPERS
 * ──────────────────────────────────────────────────────────────────────────── */

function isMsTenant(hint) {
  const s = String(hint || '').toLowerCase();
  return /protection\.outlook\.com|mail\.protection\.outlook\.com|outlook\.com|microsoft/i.test(
    s
  );
}

function isMsRecipientNotFound(resp, enh) {
  const s = String(resp || '').toLowerCase();
  const e = String(enh || '').toLowerCase();
  if (
    /(^|[^0-9])5\.1\.1([^0-9]|$)/.test(e) ||
    /(^|[^0-9])5\.1\.10([^0-9]|$)/.test(e) ||
    /(^|[^0-9])5\.4\.1([^0-9]|$)/.test(e)
  )
    return true;
  const phrases = [
    'resolver.adr.recipientnotfound',
    'resolver.adr.exrecipnotfound',
    'smtp; 550 5.1.10',
    'smtp; 550 5.1.1',
    '550 5.1.10',
    '550 5.1.1',
    '550 5.4.1',
    'recipient address rejected: access denied'
  ];
  return phrases.some((p) => s.includes(p));
}

function containsRecipientish(s) {
  const x = String(s || '').toLowerCase();
  return /(recipient|mailbox|user).*(unknown|not\s+found|reject|does\s+not\s+exist)/.test(x);
}
function mentionsInfraPolicy(s) {
  const x = String(s || '').toLowerCase();
  return /(spf|dmarc|dkim|ip|blacklist|block\s*list|spamhaus|tls|required|relay|banned|blocked|unauthorized|not\s+authorized)/.test(
    x
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 *  SCORING & CONFIDENCE (applied after provider logic)
 * ──────────────────────────────────────────────────────────────────────────── */

function scoreFrom(result, flags) {
  let score = 80;
  if (result.status === 'deliverable') score = 95;
  if (result.status === 'undeliverable') score = 5;
  if (result.status === 'risky') score = 45;
  if (result.status === 'unknown') score = 35;
  if (flags.disposable) score -= 30;
  if (flags.free) score -= 10;
  if (flags.role) score -= 10;
  if (result.sub_status === 'catch_all' || result.sub_status === 'gworkspace_catchall_ambiguous')
    score -= 20;
  if (result.sub_status === 'mailbox_full') score -= 10;
  return Math.max(0, Math.min(100, score));
}

function confidenceFrom(result, enhancedSignals) {
  let c = 0.55;
  if (result.status === 'deliverable') c = 0.85;
  if (result.status === 'undeliverable') c = 0.95;
  if (result.status === 'risky' && result.sub_status === 'catch_all') c = 0.75;
  if (result.status === 'unknown') c = 0.4;
  if (enhancedSignals.realBetterThanBogus) c += 0.08;
  if (enhancedSignals.nullSenderAgreesDeliverable) c += 0.05;
  if (enhancedSignals.nullSenderAgreesUndeliverable) c += 0.05;
  return Math.max(0, Math.min(0.99, c));
}

/* ────────────────────────────────────────────────────────────────────────────
 *  OWNER VERIFIER PLUGIN (used by all providers)
 * ──────────────────────────────────────────────────────────────────────────── */

async function verifyOwner(email, domain) {
  const url = OWNER_VERIFY_MAP[domain];
  if (!url) return null;
  const cached = ownerCache.get(email);
  if (cached && cached.until > Date.now()) return cached.data;

  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify({ email }), 'utf8');
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...(process.env.OWNER_VERIFY_AUTH
          ? { Authorization: process.env.OWNER_VERIFY_AUTH }
          : {})
      },
      timeout: OWNER_VERIFY_TIMEOUT_MS
    };
    const data = await new Promise((resolve) => {
      const req = lib.request(opts, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
    ownerCache.set(email, { until: Date.now() + OWNER_CACHE_TTL_MS, data });
    return data;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  TRAINING DATA HELPERS (domain-level aggregates)
 * ──────────────────────────────────────────────────────────────────────────── */

async function getDomainTrainingHint(domain) {
  const key = String(domain || '').toLowerCase();
  if (!key) return null;

  const now = Date.now();
  const cached = trainingDomainCache.get(key);
  if (cached && cached.until > now) return cached.stats;

  try {
    const rows = await TrainingSample.aggregate([
      { $match: { domain: key } },
      {
        $group: {
          _id: '$domain',
          total: { $sum: '$totalSamples' },
          valid: { $sum: { $ifNull: ['$labelCounts.valid', 0] } },
          invalid: { $sum: { $ifNull: ['$labelCounts.invalid', 0] } },
          risky: { $sum: { $ifNull: ['$labelCounts.risky', 0] } },
          unknown: { $sum: { $ifNull: ['$labelCounts.unknown', 0] } },
        },
      },
    ]);

    if (!rows.length || !rows[0].total) {
      trainingDomainCache.set(key, { stats: null, until: now + TRAINING_TTL_MS });
      return null;
    }

    const r = rows[0];
    const total = r.total || 0;
    const stats = {
      total,
      valid: r.valid || 0,
      invalid: r.invalid || 0,
      risky: r.risky || 0,
      unknown: r.unknown || 0,
      validRatio: (r.valid || 0) / total,
      invalidRatio: (r.invalid || 0) / total,
      riskyRatio: (r.risky || 0) / total,
      unknownRatio: (r.unknown || 0) / total,
    };

    trainingDomainCache.set(key, { stats, until: now + TRAINING_TTL_MS });
    return stats;
  } catch (e) {
    trainingDomainCache.set(key, { stats: null, until: now + TRAINING_TTL_MS });
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  CORE RCPT PROBE on a single MX (provider-agnostic base)
 * ──────────────────────────────────────────────────────────────────────────── */

async function checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride) {
  const helo = heloOverride || PROBE_HELO;
  let socket = null;
  let signals = {
    realEnh: null,
    bogusEnh: null,
    realNullEnh: null,
    realBetterThanBogus: false,
    nullSenderAgreesDeliverable: false,
    nullSenderAgreesUndeliverable: false
  };
  const trustedGateway = detectTrustedGateway(mxHost, provider, gatewayName);

  try {
    socket = await connectSmtp(mxHost);
    await readLine(socket);

    // EHLO + opportunistic STARTTLS (all providers)
    let ehlo = await sendCmd(socket, `EHLO ${helo}`);
    if (/^250[ -].*STARTTLS/im.test(ehlo)) {
      const startTlsResp = await sendCmd(socket, 'STARTTLS');
      if (/^220/i.test(startTlsResp)) {
        socket = await new Promise((resolve, reject) => {
          const secure = tls.connect({ socket, servername: mxHost }, () => resolve(secure));
          secure.once('error', reject);
        });
        ehlo = await sendCmd(socket, `EHLO ${helo}`);
      }
    }

    // First pass MAIL/RCPT
    await sendCmd(socket, `MAIL FROM:<${sender}>`);
    let real1 = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
    let codeReal = parseCode(real1);
    signals.realEnh = parseEnhanced(real1);
    let base = categorize(codeReal);

    // ───────────────── 5xx REFINEMENT (all providers, but Microsoft-aware) ─────────────────
    if (codeReal >= 500) {
      const eh = signals.realEnh || '';
      const msTenant = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);

      if (/^5\.4\./.test(eh)) {
        base = { status: 'risky', sub_status: 'policy_block_spf' };
      } else if (MS365_STRICT_INVALID && msTenant && isMsRecipientNotFound(real1, signals.realEnh)) {
        base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
      } else if (isMailboxUnknownEnhanced(signals.realEnh) || isMailboxUnknownText(real1)) {
        base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
      } else if (isPolicyBlock(real1)) {
        base = { status: 'risky', sub_status: 'policy_block_spf' };
      } else {
        base = { status: 'undeliverable', sub_status: '5xx_other' };
      }
    }

    // ───────────────── 4xx RETRIES (greylisting / temporary) ─────────────────
    if (codeReal >= 400 && codeReal < 500 && MAX_RCPT_RETRIES > 0) {
      for (let i = 0; i < MAX_RCPT_RETRIES; i++) {
        await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
        real1 = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
        codeReal = parseCode(real1);
        const maybe = parseEnhanced(real1);
        signals.realEnh = maybe || signals.realEnh;
        base = categorize(codeReal);

        if (codeReal >= 500) {
          const msTenant = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);
          if (MS365_STRICT_INVALID && msTenant && isMsRecipientNotFound(real1, signals.realEnh)) {
            base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
          } else if (isMailboxUnknownEnhanced(signals.realEnh) || isMailboxUnknownText(real1)) {
            base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
          } else if (isPolicyBlock(real1)) {
            base = { status: 'risky', sub_status: 'policy_block_spf' };
          } else {
            base = { status: 'undeliverable', sub_status: '5xx_other' };
          }
          break;
        }
        if (codeReal >= 200 && codeReal < 300) break;
      }
    }

    // NOTE: FAST EXIT removed — we always probe a random address on the domain
    // to detect catch-all behaviour. If a bogus address is also accepted (2xx),
    // the domain is catch-all and the email must be marked risky.

    // ───────────────── NULL-SENDER RE-CHECK (non-deliverable only) ──────────
    // OPTIMIZATION: Skip null-sender re-check when real email is already
    // deliverable (2xx). The null-sender re-check is only useful for:
    //   - 5xx responses: detecting policy blocks (SPF/DMARC rejecting our sender)
    //   - 4xx responses: greylisting confirmation
    // For a 2xx deliverable result, it adds no value for catch-all detection
    // and wastes ~500-1500ms per validation.
    if (base.status !== 'deliverable') {
      await sendCmd(socket, 'RSET');
      await sendCmd(socket, 'MAIL FROM:<>');
      const realNull = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
      const codeNull = parseCode(realNull);
      signals.realNullEnh = parseEnhanced(realNull);

      if (codeReal >= 500 && codeNull >= 200 && codeNull < 300) {
        const eh = signals.realEnh || '';
        if (isAccessDeniedPolicy(real1, eh) || isPolicyBlock(real1) || /^5\.7\./.test(eh)) {
          signals.nullSenderAgreesDeliverable = true;
          base = { status: 'deliverable', sub_status: 'accepted' };
        }
      } else {
        if (codeNull >= 200 && codeNull < 300 && codeReal >= 200 && codeReal < 300) {
          if (betterThan(signals.realNullEnh, signals.realEnh)) signals.realEnh = signals.realNullEnh;
          signals.nullSenderAgreesDeliverable = true;
        }
        if (codeNull >= 500 && codeReal >= 500) signals.nullSenderAgreesUndeliverable = true;
      }
    }

    // ───────────────── ALT SENDER RETRY (policy / SPF issues) ─────────────────
    if (base.status === 'risky' && base.sub_status === 'policy_block_spf' && PROBE_SENDER_ALT) {
      await sendCmd(socket, 'RSET');
      await sendCmd(socket, `MAIL FROM:<${PROBE_SENDER_ALT}>`);
      const altResp = await sendCmd(socket, `RCPT TO:<${rcpt}>`);
      const altCode = parseCode(altResp);
      const altEnh = parseEnhanced(altResp);

      if (altCode >= 200 && altCode < 300) {
        signals.realEnh = altEnh || signals.realEnh;
        base = categorize(altCode);
      } else if (
        altCode >= 500 &&
        (isMailboxUnknownEnhanced(altEnh) || isMailboxUnknownText(altResp))
      ) {
        base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
      } else if (altCode >= 500 && isPolicyBlock(altResp)) {
        base = { status: 'risky', sub_status: 'policy_block_spf' };
      } else if (altCode >= 400 && altCode < 500) {
        base = { status: 'risky', sub_status: 'greylisted' };
      }
    }

    // ───────────────── CATCH-ALL PROBES (bogus RCPTs) ─────────────────
    const bogusProbe = async (fromLine) => {
      await sendCmd(socket, 'RSET');
      await sendCmd(socket, fromLine);
      const bogus = `__probe_${Math.random().toString(36).slice(2, 10)}`;
      const resp = await sendCmd(socket, `RCPT TO:<${bogus}@${domain}>`);
      let code = parseCode(resp);
      let enh = parseEnhanced(resp);
      if (code >= 400 && code < 500) {
        await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
        const resp2 = await sendCmd(socket, `RCPT TO:<${bogus}@${domain}>`);
        code = parseCode(resp2);
        enh = parseEnhanced(resp2) || enh;
      }
      return { code, enh };
    };

    const b1 = await bogusProbe(`MAIL FROM:<${sender}>`);
    // OPTIMIZATION: Short-circuit — if b1 already confirms catch-all (2xx),
    // skip b2 entirely. Running b2 would be redundant and wastes ~500-1000ms.
    const b1IsCatchAll = b1.code >= 200 && b1.code < 300;
    const b2 = b1IsCatchAll ? { code: b1.code, enh: b1.enh } : await bogusProbe('MAIL FROM:<>');
    const isCatchAll = b1IsCatchAll || (b2.code >= 200 && b2.code < 300);
    signals.bogusEnh = b1.enh || b2.enh || null;

    // ── CACHE catch-all result for this domain ──────────────────────────────
    // Subsequent emails on the same domain will be served from cache instantly.
    catchAllCache.set(domain, { isCatchAll, until: Date.now() + CATCHALL_TTL_MS });

    const providerIsMimecast = /mimecast/i.test(provider || '');
    const isBigProvider = /google|mail\.protection\.outlook\.com|protection\.outlook\.com|outlook|yahoodns|protonmail|amazonses|awsapps/i.test(
      provider || ''
    );
    const isGoogleProvider = isGoogleWorkspaceProvider(provider);

    if (isBigProvider && codeReal >= 200 && codeReal < 300 && isCatchAll) {
      base = { status: 'risky', sub_status: 'catch_all' };
    }

    // IMPORTANT: do NOT "upgrade" catch-all to accepted for Google Workspace
    if (
      isCatchAll &&
      betterThan(signals.realEnh, signals.bogusEnh) &&
      !providerIsMimecast &&
      !isGoogleProvider
    ) {
      signals.realBetterThanBogus = true;
      base = { status: 'deliverable', sub_status: 'accepted' };
    }

    // ───────────────── ENTERPRISE GATEWAY ADJUSTMENTS ─────────────────
    const isGateway =
      !!gatewayName ||
      /mimecast|pphosted|barracuda|topsec|messagelabs|iphmx|sophos|protection\.outlook\.com/i.test(
        provider || ''
      );

    const gwNameLower = String(gatewayName || '').toLowerCase();
    const isBarracudaGw =
      gwNameLower === 'barracuda' ||
      /barracuda/.test(String(provider || '').toLowerCase()) ||
      /barracuda/.test(String(mxHost || '').toLowerCase());

    if (GATEWAY_DOWNGRADE_5XX_TO_RISKY && isGateway) {
      const sub = isBarracudaGw ? 'gateway_protected_barracuda' : 'gateway_protected';
      if (base.status === 'undeliverable' && base.sub_status === '5xx_other') {
        base = { status: 'risky', sub_status: sub };
      } else if (base.status === 'risky' && base.sub_status === 'policy_block_spf') {
        base = { status: 'risky', sub_status: sub };
      }
    }

    const msTenantFinal = isMsTenant(provider) || isMsTenant(gatewayName) || isMsTenant(mxHost);
    if (MS365_HEURISTIC_PAIRWISE && msTenantFinal && codeReal >= 500 && !isCatchAll) {
      if (containsRecipientish(real1) && !mentionsInfraPolicy(real1)) {
        base = { status: 'undeliverable', sub_status: 'mailbox_not_found' };
      }
    }

    try {
      socket.write('QUIT\r\n');
    } catch {}

    // Trusted gateways (e.g. Proofpoint) with catch-all: keep 2xx as deliverable
    if (isCatchAll && base.status === 'deliverable' && !signals.realBetterThanBogus) {
      if (trustedGateway === 'proofpoint') {
        const sub =
          base.sub_status && base.sub_status !== 'catch_all'
            ? base.sub_status
            : 'gateway_accepted';
        return { result: { ...base, status: 'deliverable', sub_status: sub }, signals };
      }
      return { result: { status: 'risky', sub_status: 'catch_all' }, signals };
    }
    return { result: base, signals };
  } catch {
    return { result: { status: 'unknown', sub_status: 'network' }, signals };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  AMBIGUITY ESCALATION (second socket)
 * ──────────────────────────────────────────────────────────────────────────── */

function isAmbiguous(res) {
  if (!res) return true;
  const st = res.status,
    sub = res.sub_status || '';
  if (st === 'undeliverable') return false;
  if (st === 'deliverable' && sub !== 'catch_all') return false;
  return true;
}

async function checkMailboxWithEscalation(
  mxHost,
  sender,
  rcpt,
  provider,
  domain,
  gatewayName,
  heloOverride
) {
  const one = await checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride);
  if (!AMBIGUOUS_SECOND_SOCKET || !isAmbiguous(one.result)) return one;
  const two = await checkMailbox(mxHost, sender, rcpt, provider, domain, gatewayName, heloOverride);
  const rank = (v) =>
    v.status === 'undeliverable'
      ? 4
      : v.status === 'deliverable' && v.sub_status !== 'catch_all'
      ? 3
      : v.status === 'risky'
      ? 2
      : 1;
  return rank(two.result) >= rank(one.result) ? two : one;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  PROVIDER PROFILE LAYER (MAIN PER-PROVIDER SPLIT)
 * ──────────────────────────────────────────────────────────────────────────── */

function applyProviderProfile(result, signals, meta) {
  const provider = result.provider || '';
  const domain = (meta && meta.domain ? meta.domain : result.domain || '').toLowerCase();

  const isGoogleFamily = isGoogleWorkspaceProvider(provider);
  const isMicrosoftFam = isMicrosoftProvider(provider);
  const isYahooFam     = isYahooProvider(provider);
  const isZohoFam      = isZohoProvider(provider);

  // meta flags from analyzeEmail(...)
  const flags = {
    free: !!(meta && meta.free),
    disposable: !!(meta && meta.disposable),
    role: !!(meta && meta.role),
  };

  const corporate = !flags.free && !flags.disposable;

  // ────────────────────────────── 1) GOOGLE: GMAIL / GOOGLE WORKSPACE ─────────────────────
  if (isGoogleFamily) {
    const isCatchAllLike =
      result.sub_status === 'catch_all' ||
      result.sub_status === 'gworkspace_catchall_ambiguous';

    // Catch-all handling for Google Workspace
    if (isCatchAllLike) {
      if (corporate) {
        if (GWORKSPACE_CATCHALL_AS_INVALID) {
          result.status = 'undeliverable';
          result.sub_status = 'gworkspace_catchall_invalid';
        } else {
          result.status = 'risky';
          result.sub_status = 'gworkspace_catchall_ambiguous';
        }
      } else {
        result.status = 'risky';
        result.sub_status = 'gworkspace_catchall_ambiguous';
      }
      return result;
    }

    // STRICT MODE for Workspace (non-gmail.com, non-free)
    // Changed: gworkspace_deliverable_unconfirmed now treated as valid
    if (GWORKSPACE_STRICT_MODE && corporate) {
      if (result.status === 'deliverable' && result.sub_status === 'accepted') {
        const trustedSignals =
          signals.realBetterThanBogus || signals.nullSenderAgreesDeliverable;
        if (!trustedSignals) {
          // Keep as deliverable but mark as unconfirmed
          result.sub_status = 'gworkspace_deliverable_unconfirmed';
        }
      }
    }

    return result;
  }

  // ───────────────────────── 2) MICROSOFT: OUTLOOK / MICROSOFT 365 / EXCHANGE ─────────────
  if (isMicrosoftFam && !M365_STRICT_MODE) {
    if (result.status === 'undeliverable' && result.sub_status === '5xx_other') {
      result.status = 'risky';
      result.sub_status = 'm365_ambiguous_5xx';
    }
    return result;
  }

  // ────────────────────────────── 3) YAHOO MAIL ─────────────────────────────
  if (isYahooFam && !YAHOO_STRICT_MODE) {
    if (result.status === 'risky' && result.sub_status === 'greylisted') {
      result.status = 'unknown';
      result.sub_status = 'yahoo_greylist';
    }
    return result;
  }

  // ────────────────────────────── 4) ZOHO MAIL ──────────────────────────────
  if (isZohoFam && !ZOHO_STRICT_MODE) {
    if (result.status === 'risky' && String(result.sub_status).includes('policy_block')) {
      result.status = 'unknown';
      result.sub_status = 'zoho_policy_unknown';
    }
    return result;
  }

  // ────────────────────────────── 5) OTHER PROVIDERS / DEFAULT ──────────────
  return result;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  MAIN VALIDATOR (validateSMTP)
 * ──────────────────────────────────────────────────────────────────────────── */

async function validateSMTP(email, opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  logger('start', `Begin SMTP validation for ${email}`);

  const meta = analyzeEmail(email);
  const result = {
    input: email,
    normalized: email,
    domain: meta.domain,
    provider: 'Unavailable',
    status: 'unknown',
    sub_status: 'init',
    score: 0,
    flags: { disposable: meta.disposable, free: meta.free, role: meta.role }
  };

  // Syntax-only fail (any provider)
  const syntaxOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '');
  if (!syntaxOk) {
    result.status = 'undeliverable';
    result.sub_status = 'syntax';
    result.score = scoreFrom(result, result.flags);
    logger('syntax', 'Syntax invalid');
    return toServerShape(result, {});
  }

  const domainLower = (meta.domain || '').toLowerCase();
  const isBankDomain = BANK_DOMAIN_SET.has(domainLower);
  const isHighRiskDomain = HIGH_RISK_DOMAIN_SET.has(domainLower);
  const isGovDomain = isGovernmentDomain(domainLower);

  // ──────────────────────────────────────────────────────────
  // POLICY SHORTCUT: BANK / HIGH-RISK / GOVERNMENT DOMAINS
  // (MX only → provider, no SMTP probing)
  // ──────────────────────────────────────────────────────────
  if (isBankDomain || isHighRiskDomain || isGovDomain) {
    let providerLabel = 'Unavailable';
    try {
      const mx = await resolveMxCached(domainLower);
      providerLabel = mx.provider || 'Unavailable';
    } catch {}

    result.provider = providerLabel;
    result.status = 'risky';
    result.sub_status = isBankDomain
      ? 'bank_domain_policy'
      : isGovDomain
      ? 'government_domain_policy'
      : 'high_risk_domain_policy';
    result.score = scoreFrom(result, result.flags);

    const extras = {
      confidence: 0.7,
      reason: isBankDomain
        ? 'Domain is configured as a bank / financial organization. Validation marked as Risky by policy without SMTP probing.'
        : isGovDomain
        ? 'Domain is a government or official institution (.gov, .mil, .edu, etc.). Validation marked as Risky by policy without SMTP probing.'
        : 'Domain is configured as high-risk. Validation marked as Risky by policy without SMTP probing.'
    };

    const shaped = toServerShape(result, extras);
    shaped._stabilized = {
      rounds: [
        {
          category: shaped.category,
          sub_status: shaped.sub_status,
          confidence: shaped.confidence
        }
      ],
      elapsed_ms: 0
    };
    logger(
      'policy',
      `Policy shortcut for ${domainLower}: ${shaped.sub_status} (provider=${providerLabel})`
    );
    return shaped;
  }

  // Owner verifier (if configured for specific domains)
  let owner = null;
  try {
    owner = await verifyOwner(email, meta.domain);
  } catch {}
  if (owner && typeof owner.exists === 'boolean') {
    logger('owner', `Owner API: exists=${owner.exists}`);
  }

  // MX lookup → provider bucket & gateway detection
  let hosts = [];
  let provider = 'Unavailable';
  let gatewayName = null;
  try {
    const mx = await resolveMxCached(meta.domain);
    hosts = mx.hosts || [];
    provider = mx.provider || 'Unavailable';
    gatewayName = mx.gateway || null;
  } catch {}
  result.provider = provider;
  logger('mx', `Provider: ${provider}; MX count: ${hosts.length}`);

  if (!hosts.length) {
    let hasA = false;
    try {
      const a = await dns.lookup(meta.domain);
      hasA = !!a?.address;
    } catch {}
    if (!hasA) {
      result.status = 'undeliverable';
      result.sub_status = 'no_mx_or_a';
      result.score = scoreFrom(result, result.flags);
      logger('mx', 'No MX or A record → undeliverable');
      return toServerShape(result, { owner });
    }
  }

  const probeProfiles = buildProbeProfiles();
  const enterpriseProvider = isEnterpriseProvider(provider);

  // ─────────────────────────────────────────────────────────────────────────
  // CATCH-ALL DOMAIN CACHE CHECK
  // If this domain was already probed and confirmed as catch-all, skip SMTP
  // entirely and return risky immediately. This avoids redundant SMTP probing
  // for every email on a known catch-all domain.
  // ─────────────────────────────────────────────────────────────────────────
  const cachedCatchAll = catchAllCache.get(domainLower);
  if (cachedCatchAll && cachedCatchAll.until > Date.now() && cachedCatchAll.isCatchAll) {
    result.status = 'risky';
    result.sub_status = 'catch_all';
    result.score = scoreFrom(result, result.flags);
    logger('catchall_cache', `Domain ${domainLower} is a known catch-all (cached) → risky`);
    const catchAllExtras = {
      confidence: 0.75,
      reason: 'Domain accepts any randomly generated address at SMTP (catch-all). All emails on this domain are marked risky.',
      provisional: true
    };
    const catchAllShaped = toServerShape(result, catchAllExtras);
    catchAllShaped._stabilized = {
      rounds: [{ category: catchAllShaped.category, sub_status: catchAllShaped.sub_status, confidence: catchAllShaped.confidence }],
      elapsed_ms: 0
    };
    return catchAllShaped;
  }

  // PROBING across MX hosts with our core checkMailboxWithEscalation
  let probe;
  try {
    const toTry = hosts.slice(0, 3).map((h) => h.exchange);
    outerLoop: for (const mxHost of (toTry.length ? toTry : [meta.domain])) {
      logger('mx_host', `Probing MX host ${mxHost}`);

      const profilesToUse = probeProfiles.slice(0, PROBE_PROFILE_MAX);
      for (let idx = 0; idx < profilesToUse.length; idx++) {
        const profile = profilesToUse[idx];
        logger(
          'profile',
          `Using HELO=${profile.helo} SENDER=${profile.sender} on MX=${mxHost}`
        );

        // First attempt for this profile on this MX
        const pr1 = await checkMailboxWithEscalation(
          mxHost,
          profile.sender,
          email,
          provider,
          meta.domain,
          gatewayName,
          profile.helo
        );
        probe = pr1;
        result.status = pr1.result.status;
        result.sub_status = pr1.result.sub_status;
        logger(
          'rcpt',
          `Result on ${mxHost} (profile ${idx + 1}): ${pr1.result.status} (${pr1.result.sub_status})`
        );

        if (result.status === 'undeliverable') {
          // hard invalid – no need to try more profiles or MXs
          break outerLoop;
        }

        if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) {
          // Clean valid on non-enterprise – stop early
          break outerLoop;
        }

        // Additional attempts on same MX + same profile (new sockets)
        for (let attempt = 2; attempt <= PER_MX_ATTEMPTS; attempt++) {
          logger(
            'retry',
            `Retrying same MX/profile in ${RCPT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PER_MX_ATTEMPTS})`
          );
          await new Promise((r) => setTimeout(r, RCPT_RETRY_DELAY_MS));
          const prX = await checkMailboxWithEscalation(
            mxHost,
            profile.sender,
            email,
            provider,
            meta.domain,
            gatewayName,
            profile.helo
          );
          probe = prX;
          result.status = prX.result.status;
          result.sub_status = prX.result.sub_status;
          logger(
            'rcpt',
            `Result on ${mxHost} (profile ${idx + 1}, attempt ${attempt}): ${prX.result.status} (${prX.result.sub_status})`
          );

          if (result.status === 'undeliverable') {
            break outerLoop;
          }
          if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) {
            break outerLoop;
          }
        }

        // Between different profiles on same MX, wait a bit to avoid hammering
        if (PROBE_PROFILE_GAP_MS > 0 && idx < profilesToUse.length - 1) {
          await new Promise((r) => setTimeout(r, PROBE_PROFILE_GAP_MS));
        }
      }

      // If we reached here and got a clean deliverable (on enterprise) or risky/unknown,
      // we move to next MX unless already hard invalid / clear valid on non-enterprise.
      if (result.status === 'undeliverable') break;
      if (result.status === 'deliverable' && result.sub_status !== 'catch_all' && !enterpriseProvider) break;
    }
  } catch {
    result.status = 'unknown';
    result.sub_status = 'no_connect';
    probe = { signals: {} };
    logger('network', 'No connect / unknown');
  }

  // Owner override (all providers – domain-specific)
  if (owner && typeof owner.exists === 'boolean') {
    if (owner.exists) {
      result.status = 'deliverable';
      result.sub_status = 'owner_verified';
      logger('owner', 'Overriding to deliverable (owner verified)');
    } else {
      if (result.status === 'deliverable') {
        result.status = 'risky';
        result.sub_status = 'catch_all_owner_says_missing';
      } else {
        result.status = 'undeliverable';
        result.sub_status = 'owner_verified_missing';
      }
      logger('owner', `Owner contradicts → ${result.status} (${result.sub_status})`);
    }
  }

  // Enterprise catch-all promotion (global gateway rule, optional)
  if (
    ENTERPRISE_CATCHALL_PROMOTE &&
    result.status === 'risky' &&
    result.sub_status === 'catch_all'
  ) {
    const corporate = !result.flags.free && !result.flags.disposable;
    const enterpriseProviderFlag = /proofpoint|mimecast|barracuda|ironport|topsec|messagelabs|sophos/i.test(
      result.provider || ''
    );
    if (corporate && enterpriseProviderFlag) {
      result.status = 'deliverable';
      result.sub_status = 'gateway_accepted';
      logger('promo', 'Promoting corporate catch-all on enterprise gateway to deliverable');
    }
  }

  // Barracuda: play as safe as Bouncer
  // ------------------------------------------------------------
  // For corporate domains behind Barracuda:
  // - never treat them as "clean valid" based only on 2xx
  // - ambiguous / policy / unknown => always RISKY
  {
    const corporate = !result.flags.free && !result.flags.disposable;
    const barracudaGw = isBarracudaGateway(result.provider, gatewayName);

    if (corporate && barracudaGw) {
      if (result.status === 'deliverable') {
        // Barracuda saying 250 doesn't guarantee no bounce later
        result.status = 'risky';
        result.sub_status = 'barracuda_deliverable_untrusted';
        logger(
          'barracuda',
          `Downgrading deliverable to risky for Barracuda-protected domain (${meta.domain})`
        );
      } else if (result.status === 'unknown') {
        // if we had unknown, treat it as risky instead of unknown
        result.status = 'risky';
        if (!String(result.sub_status || '').includes('barracuda')) {
          result.sub_status = 'gateway_protected_barracuda';
        }
        logger(
          'barracuda',
          `Normalizing unknown to risky for Barracuda-protected domain (${meta.domain})`
        );
      }
    }
  }

  // Enterprise-gateway risky → unknown (gateway_hidden) for corporate domains,
  // EXCEPT for Barracuda when BARRACUDA_RISKY_BIAS=true (keep as risky)
  if (ENTERPRISE_GATEWAY_AS_UNKNOWN) {
    const corporate = !result.flags.free && !result.flags.disposable;
    const enterpriseProviderFlag = isEnterpriseProvider(result.provider);
    const isBarracuda = isBarracudaGateway(result.provider, gatewayName);

    if (
      corporate &&
      enterpriseProviderFlag &&
      result.status === 'risky' &&
      (String(result.sub_status).includes('gateway_protected') ||
        String(result.sub_status).includes('policy_block') ||
        String(result.sub_status) === 'greylisted')
    ) {
      if (isBarracuda && BARRACUDA_RISKY_BIAS) {
        // keep them as risky, normalize sub_status
        if (!String(result.sub_status).includes('barracuda')) {
          result.sub_status = 'gateway_protected_barracuda';
        }
        logger(
          'gateway',
          `Keeping risky for Barracuda-protected corporate domain (${result.sub_status})`
        );
      } else {
        logger(
          'gateway',
          `Downgrading risky (${result.sub_status}) on enterprise corporate domain to unknown (gateway_hidden)`
        );
        result.status = 'unknown';
        result.sub_status = 'gateway_hidden';
      }
    }
  }

  // PROVIDER-SPECIFIC TUNING (Google / Microsoft / Yahoo / Zoho / Other)
  applyProviderProfile(result, probe?.signals || {}, meta);

  // ─────────────────────────────────────────────────────────────
  // TRAINING-BASED ADJUSTMENTS (domain-level heuristics)
  // ─────────────────────────────────────────────────────────────
  try {
    const stats = await getDomainTrainingHint(domainLower);
    if (stats && stats.total >= 20) {
      const { validRatio, invalidRatio, riskyRatio } = stats;
      const corporateDomain = !result.flags.free && !result.flags.disposable;

      // 1) Domain is overwhelmingly invalid → risky → invalid
      if (
        invalidRatio >= 0.9 &&
        result.status === 'risky'
      ) {
        logger(
          'training',
          `Domain ${domainLower} mostly invalid in training (invalidRatio=${invalidRatio.toFixed(
            2
          )}) → upgrading risky→invalid`
        );
        result.status = 'undeliverable';
        result.sub_status = 'trained_domain_mostly_invalid';
      }

      // 2) Domain has strong risky/invalid history → downgrade "too clean" deliverable
      if (
        corporateDomain &&
        (invalidRatio + riskyRatio) >= 0.7 &&
        result.status === 'deliverable'
      ) {
        logger(
          'training',
          `Domain ${domainLower} has high risky/invalid history (=${(
            invalidRatio + riskyRatio
          ).toFixed(2)}) → downgrading deliverable→risky`
        );
        result.status = 'risky';
        result.sub_status = 'trained_domain_high_risky_history';
      }

      // 3) Domain is very clean but SMTP ambiguous → upgrade to valid based on training
      if (
        validRatio >= 0.95 &&
        (result.status === 'unknown' ||
          (result.status === 'risky' && String(result.sub_status || '').includes('greylist')))
      ) {
        logger(
          'training',
          `Domain ${domainLower} mostly valid in training (validRatio=${validRatio.toFixed(
            2
          )}) and SMTP ambiguous → upgrading to deliverable based on training data`
        );
        result.status = 'deliverable';
        result.sub_status = 'trained_domain_mostly_valid';
      }
    }
  } catch (e) {
    logger('training_err', `Error while applying training heuristics: ${e.message || e}`);
  }

  // FINAL SCORE + CONFIDENCE + HUMAN REASON
  result.score = scoreFrom(result, result.flags);
  const confidence = confidenceFrom(result, probe?.signals || {});
  let reason = '';
  if (result.status === 'undeliverable') {
    if (result.sub_status === 'gworkspace_catchall_invalid') {
      reason =
        'Google Workspace catch-all domain; this mailbox is very likely not provisioned.';
    } else if (result.sub_status === 'trained_domain_mostly_invalid') {
      reason =
        'Training data shows this domain’s mailboxes are almost always invalid. SMTP result was risky, treated as invalid by training.';
    } else {
      reason = 'Server rejected mailbox (5xx) or owner says missing.';
    }
  } else if (result.status === 'deliverable') {
    if (result.sub_status === 'gateway_accepted') {
      reason = 'Mailbox accepted by enterprise email security gateway.';
    } else if (result.sub_status === 'owner_verified') {
      reason = 'Owner verified mailbox exists.';
    } else {
      reason = 'Server accepted mailbox (2xx).';
    }
  } else if (result.status === 'risky' && result.sub_status === 'gworkspace_catchall_ambiguous') {
    reason =
      'Google Workspace catch-all domain; this mailbox cannot be reliably verified via SMTP and may not exist.';
  } else if (
    result.status === 'risky' &&
    String(result.sub_status).includes('catch_all')
  ) {
    reason = 'Domain accepts any address at RCPT (catch-all).';
  } else if (
    result.status === 'risky' &&
    String(result.sub_status).includes('policy_block')
  ) {
    reason = 'Gateway blocked by policy (e.g., SPF) before revealing mailbox.';
  } else if (
    result.status === 'risky' &&
    String(result.sub_status).includes('gateway_protected')
  ) {
    reason = 'Enterprise email security gateway masks mailbox status on RCPT.';
  } else if (
    result.status === 'deliverable' &&
    result.sub_status === 'gworkspace_deliverable_unconfirmed'
  ) {
    reason = 'Google Workspace accepted RCPT. Email validated successfully.';
  } else if (result.status === 'risky' && result.sub_status === 'm365_ambiguous_5xx') {
    reason = 'Microsoft 365 returned ambiguous 5xx; treated as risky rather than invalid.';
  } else if (result.status === 'risky' && result.sub_status === 'bank_domain_policy') {
    reason =
      'Domain is configured as a bank / financial institution. Validation marked as Risky by policy.';
  } else if (result.status === 'risky' && result.sub_status === 'high_risk_domain_policy') {
    reason =
      'Domain is configured as high-risk. Validation marked as Risky by policy.';
  } else if (result.status === 'risky' && result.sub_status === 'government_domain_policy') {
    reason =
      'Domain is a government or official institution (.gov, .mil, .edu, etc.). Validation marked as Risky by policy.';
  } else if (result.status === 'risky' && result.sub_status === 'trained_domain_high_risky_history') {
    reason =
      'Training data shows this domain has a high proportion of risky/invalid mailboxes; treated as risky even though this probe was accepted.';
  } else if (
    result.status === 'deliverable' &&
    result.sub_status === 'trained_domain_mostly_valid'
  ) {
    reason =
      'Training data shows this domain is mostly valid (95%+ success rate). Email validated based on historical data.';
  } else if (result.status === 'unknown' && result.sub_status === 'gateway_hidden') {
    reason =
      'Enterprise email gateway/policy hides mailbox status; SMTP verification not possible.';
  } else if (result.status === 'unknown' && result.sub_status === 'yahoo_greylist') {
    reason = 'Repeated greylist/temporary responses from Yahoo; mailbox status not confirmed.';
  } else if (result.status === 'unknown' && result.sub_status === 'zoho_policy_unknown') {
    reason = 'Zoho policy response; mailbox status not confirmed.';
  } else if (result.status === 'risky') {
    reason = 'Temporary deferral (4xx / greylist).';
  } else {
    reason = 'Network/unknown response.';
  }
  if (owner?.exists) reason += ' Owner verification strengthened confidence';

  const extras = { confidence, reason, owner };
  if (
    result.status === 'risky' &&
    (result.sub_status === 'catch_all' ||
      result.sub_status === 'gworkspace_catchall_ambiguous' ||
      String(result.sub_status).startsWith('policy_block') ||
      result.sub_status === 'gateway_protected' ||
      result.sub_status === 'gateway_protected_barracuda' ||
      result.sub_status === 'm365_ambiguous_5xx' ||
      result.sub_status === 'bank_domain_policy' ||
      result.sub_status === 'high_risk_domain_policy' ||
      result.sub_status === 'government_domain_policy' ||
      result.sub_status === 'trained_domain_high_risky_history')
  )
    extras.provisional = true;
  if (result.status === 'unknown') extras.provisional = true;

  const shaped = toServerShape(result, extras);
  logger('finish', `SMTP decision: ${shaped.category} (${shaped.sub_status})`);
  return shaped;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  SHAPE RESULT FOR API RESPONSE
 * ──────────────────────────────────────────────────────────────────────────── */

function toServerShape(r, extras) {
  let category = 'unknown';
  if (r.status === 'deliverable') category = 'valid';
  else if (r.status === 'undeliverable') category = 'invalid';
  else if (r.status === 'risky') category = 'risky';

  const text =
    r.status === 'deliverable'
      ? 'Valid'
      : r.status === 'undeliverable'
      ? 'Invalid'
      : r.status === 'risky'
      ? 'Risky'
      : 'Unknown';

  return {
    status: text,
    category,
    domain: r.domain,
    provider: r.provider,
    isDisposable: r.flags.disposable,
    isFree: r.flags.free,
    isRoleBased: r.flags.role,
    score: r.score,
    sub_status: r.sub_status,
    confidence: typeof extras.confidence === 'number' ? extras.confidence : undefined,
    reason: extras.reason || undefined,
    owner: extras.owner || undefined,
    provisional: extras.provisional || undefined,
    _raw: { status: r.status, sub_status: r.sub_status, score: r.score, extras }
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 *  STABILIZER WRAPPER (validateSMTPStable)
 * ──────────────────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agree(a, b) {
  if (!a || !b) return false;
  return a.category === b.category;
}
function pickStrongest(rounds, category) {
  const candidates = rounds.filter((r) => r.category === category);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
}
function reconcileRounds(rounds) {
  const counts = { valid: 0, invalid: 0, risky: 0, unknown: 0 };
  let bestValid = null;

  for (const r of rounds) {
    counts[r.category] = (counts[r.category] || 0) + 1;
    if (r.category === 'valid') {
      const conf =
        typeof r.confidence === 'number' ? r.confidence : r._raw?.extras?.confidence || 0;
      if (!bestValid || conf > (bestValid.confidence || 0)) bestValid = r;
    }
  }

  if (counts.invalid >= 1) return pickStrongest(rounds, 'invalid');

  if (bestValid) {
    const validConf = bestValid.confidence || 0;
    const bestRisky = pickStrongest(rounds, 'risky');
    const riskyConf = bestRisky ? bestRisky.confidence || 0 : 0;

    if (bestRisky && counts.risky >= 2 && riskyConf > validConf + 0.15) {
      return bestRisky;
    }
    return bestValid;
  }

  if (counts.risky) return pickStrongest(rounds, 'risky');
  return pickStrongest(rounds, 'unknown') || rounds[rounds.length - 1];
}

async function validateSMTPStable(email, opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  const rounds = [];
  const start = Date.now();

  for (let i = 0; i < STABILIZE_ROUNDS; i++) {
    const r = await validateSMTP(email, opts);
    rounds.push(r);

    // if policy already decided (bank/high-risk/government/catch-all), no need for more rounds
    if (
      r.sub_status === 'bank_domain_policy' ||
      r.sub_status === 'high_risk_domain_policy' ||
      r.sub_status === 'government_domain_policy' ||
      r.sub_status === 'catch_all'
    ) {
      logger(
        'policy_stable_loop',
        `Stopping stabilizer loop early for ${email} due to policy sub_status=${r.sub_status}`
      );
      break;
    }

    if (i > 0 && agree(rounds[i - 1], rounds[i])) break;
    if (r.category === 'invalid') break;

    const elapsed = Date.now() - start;
    if (elapsed + STABILIZE_GAP_MS > STABILIZE_BUDGET_MS) break;
    await sleep(STABILIZE_GAP_MS);
  }

  const final = reconcileRounds(rounds);
  final._stabilized = {
    rounds: rounds.map((r) => ({
      category: r.category,
      sub_status: r.sub_status,
      confidence: r.confidence
    })),
    elapsed_ms: Date.now() - start
  };
  logger(
    'finish',
    `Stabilized: ${final.category} (${final.sub_status}) after ${final._stabilized.rounds.length} rounds`
  );
  return final;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  CATCH-ALL DOMAIN PROBE (exported utility)
 *
 *  Checks whether a domain accepts any randomly generated email address.
 *  Uses the in-memory catchAllCache for efficiency — no extra SMTP connection
 *  if the domain was already probed during a previous validation.
 *
 *  If the domain is NOT in the cache, a quick SMTP probe is performed using a
 *  randomly generated local-part. The result is cached for CATCHALL_TTL_MS.
 *
 *  @param {string} domain  - e.g. "changeagents.in"
 *  @param {object} opts    - { logger }
 *  @returns {Promise<boolean>} true if catch-all, false otherwise
 * ──────────────────────────────────────────────────────────────────────────── */
/**
 * Check if a domain is a catch-all (accepts any randomly generated address).
 *
 * @param {string} domain
 * @param {object} opts
 *   - logger: function
 *   - probeIfNotCached: boolean (default true)
 *       When false, only the in-memory cache is checked. No SMTP probe is
 *       performed if the domain is not cached. Use this for Proofpoint/Mimecast
 *       domains where SMTP probes are meaningless (gateway accepts all) and
 *       extremely slow (multiple MX hosts × profiles × retries = 60-90s).
 * @returns {Promise<boolean>} true if catch-all, false otherwise
 */
async function checkDomainCatchAll(domain, opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  const probeIfNotCached = opts.probeIfNotCached !== false; // default: true
  const domainLower = String(domain || '').toLowerCase().trim();

  // ── 1. Cache hit ──────────────────────────────────────────────────────────
  const cached = catchAllCache.get(domainLower);
  if (cached && cached.until > Date.now()) {
    logger('catchall_cache', `Domain ${domainLower} catch-all (cached): ${cached.isCatchAll}`);
    return cached.isCatchAll;
  }

  // ── 2. Skip probe if caller opted out ────────────────────────────────────
  // Proofpoint/Mimecast gateways always accept emails at SMTP level regardless
  // of whether the mailbox exists. An SMTP probe is therefore meaningless AND
  // very slow (60-90s across multiple MX hosts). Skip it and return false so
  // the caller can proceed to SendGrid for the real verification.
  if (!probeIfNotCached) {
    logger('catchall_cache', `Domain ${domainLower} not in cache; skipping SMTP probe (probeIfNotCached=false)`);
    return false;
  }

  // ── 3. Probe a random address on the domain ───────────────────────────────
  const randomLocal = `probe_${Math.random().toString(36).slice(2, 10)}`;
  const randomEmail = `${randomLocal}@${domainLower}`;

  logger('catchall_probe', `Probing random address ${randomEmail} to detect catch-all on ${domainLower}`);

  try {
    const result = await validateSMTP(randomEmail, { logger });

    // validateSMTP populates catchAllCache inside checkMailbox with the correct
    // isCatchAll value. Read it back so we get the right answer even for
    // gateway domains where the shaped result may say 'gateway_accepted'
    // instead of 'catch_all' (e.g. Proofpoint trusted-gateway path).
    const cachedAfterProbe = catchAllCache.get(domainLower);
    const isCatchAll = (cachedAfterProbe && cachedAfterProbe.until > Date.now())
      ? cachedAfterProbe.isCatchAll
      : result.sub_status === 'catch_all';

    // Write to cache if not already written (e.g. early-return paths)
    if (!catchAllCache.has(domainLower)) {
      catchAllCache.set(domainLower, { isCatchAll, until: Date.now() + CATCHALL_TTL_MS });
    }

    logger('catchall_probe', `Domain ${domainLower} is${isCatchAll ? '' : ' NOT'} catch-all`);
    return isCatchAll;
  } catch (e) {
    logger('catchall_probe_error', `Catch-all probe failed for ${domainLower}: ${e.message}`);
    return false; // assume not catch-all on error → proceed normally
  }
}

module.exports = { validateSMTP, validateSMTPStable, checkDomainCatchAll };






