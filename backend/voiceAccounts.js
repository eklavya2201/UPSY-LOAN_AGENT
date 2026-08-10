// Standalone accounts for the mobile voice surface (/m).
//
// Deliberately its own identity system rather than an extension of the phone
// lookup behind /login. The reasoning is the caller, not the code: /m is for
// someone on a phone who has never seen the desktop flow, and asking them to
// exist in the lead source first is a step they have no reason to take. So this
// is a plain create-an-account-and-come-back system, which is also what makes
// "the next call already knows you" possible at all — a lead id in
// sessionStorage dies with the tab; an account does not.
//
// The link to the rest of the product is the mobile number, kept here so an
// officer can match a voice caller to a lead by hand. Deliberately NOT joined
// automatically: guessing that two records are the same person and being wrong
// merges two applicants, which is worse than leaving them side by side.
//
// ── On passwords ────────────────────────────────────────────────────────────
// scrypt from node's own crypto, so this adds no dependency and nothing here
// rolls its own hashing. Per-account random salt, constant-time comparison, and
// the hash never leaves this module — publicAccount() is the only shape any
// route is allowed to return. Passwords are never logged, not even at debug.
//
// Same file-backed shape and the same ephemeral-storage caveat as store.js and
// callbacks.js: on Render's free tier data/ does not survive a respin.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "voiceAccounts.json");

// Long on purpose. The whole point of an account here is that someone who
// called in March is still known in June — a session that expires in a day
// would put a password prompt in front of the call button, which is the one
// place this product cannot afford friction.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// scrypt's defaults, named rather than implied so a future change is a visible
// decision. 64 bytes out, 16 bytes of salt.
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// A password long enough to be a paste-bomb is not a password. scrypt's cost is
// paid per call regardless of input length, but the cap keeps the request body
// honest and costs nothing.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// How much history one account keeps. Bounded because this file is read whole
// into memory on every request: a caller who rings twenty times should not make
// every later read slower, and an officer has never needed the twenty-first
// call. Oldest are dropped first.
const MAX_CALLS_KEPT = 20;
const MAX_TURNS_PER_CALL = 300;

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    cache = { accounts: {}, sessions: {} };
  }
  if (!cache.accounts) cache.accounts = {};
  if (!cache.sessions) cache.sessions = {};
  return cache;
}

async function save() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
}

// ── Passwords ───────────────────────────────────────────────────────────────

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt);
  // Self-describing, so a later change of algorithm can be detected rather than
  // silently mis-verified against the old format.
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scryptAsync(password, salt);
  // Lengths are equal by construction here, but timingSafeEqual throws on a
  // mismatch rather than returning false, so guard it.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ── Sessions ────────────────────────────────────────────────────────────────

function newSessionToken() {
  return randomBytes(32).toString("hex");
}

// Opportunistic, on the same reasoning as the ticket sweep in voiceRelay.js: an
// endpoint anyone can hit should not accumulate state forever just because
// nobody logged out.
function sweepSessions(db, now = Date.now()) {
  for (const [token, s] of Object.entries(db.sessions)) {
    if (!s || s.expiresAt < now) delete db.sessions[token];
  }
}

async function issueSession(db, accountId) {
  const token = newSessionToken();
  db.sessions[token] = { accountId, expiresAt: Date.now() + SESSION_TTL_MS };
  if (Object.keys(db.sessions).length > 500) sweepSessions(db);
  await save();
  return token;
}

/**
 * Resolve a session token to its account.
 * @returns {Promise<object|null>} the raw account record, or null. Callers that
 *   return this to a browser MUST shape it with publicAccount() first.
 */
export async function resolveSession(token) {
  if (!token) return null;
  const db = await load();
  const session = db.sessions[String(token)];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete db.sessions[String(token)];
    await save();
    return null;
  }
  return db.accounts[session.accountId] || null;
}

export async function endSession(token) {
  if (!token) return;
  const db = await load();
  if (db.sessions[String(token)]) {
    delete db.sessions[String(token)];
    await save();
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────

// The only shape a route may send to a browser or the team dashboard. The hash
// is not merely omitted here — it is never copied out of the module at all.
export function publicAccount(account) {
  if (!account) return null;
  return {
    accountId: account.accountId,
    name: account.name,
    phone: account.phone,
    createdAt: account.createdAt,
    lastCallAt: account.lastCallAt || null,
    callCount: (account.calls || []).length,
    // Everything the calls have established about this person. Shape is owned
    // by whatever fills it, not by this module — see mergeProfile().
    profile: account.profile || {},
  };
}

function findByPhone(db, phone) {
  return Object.values(db.accounts).find((a) => a.phone === phone) || null;
}

/**
 * Create an account.
 * @returns {Promise<{token: string, account: object}>} the account is already
 *   shaped by publicAccount().
 * @throws {Error} with a `code` of INVALID or TAKEN, so the route can pick a
 *   status without matching on message text.
 */
export async function createAccount({ name, phone, password }) {
  const cleanName = String(name || "").trim().slice(0, 80);
  if (cleanName.length < 2) {
    throw Object.assign(new Error("Please tell us your name."), { code: "INVALID" });
  }
  if (!phone) {
    throw Object.assign(new Error("Enter a valid 10-digit Indian mobile number."), { code: "INVALID" });
  }
  const pw = String(password || "");
  if (pw.length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Your password needs at least ${MIN_PASSWORD} characters.`), { code: "INVALID" });
  }
  if (pw.length > MAX_PASSWORD) {
    throw Object.assign(new Error("That password is too long."), { code: "INVALID" });
  }

  const db = await load();
  if (findByPhone(db, phone)) {
    // Safe to be specific: the person typing already knows whether this number
    // is theirs, and "an account exists, log in instead" is the actual next
    // step. The login path below stays deliberately vague, which is where
    // enumeration would matter.
    throw Object.assign(new Error("There's already an account on this number. Log in instead."), { code: "TAKEN" });
  }

  const account = {
    accountId: `VA-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: cleanName,
    phone,
    passwordHash: await hashPassword(pw),
    createdAt: new Date().toISOString(),
    calls: [],
    profile: {},
  };
  db.accounts[account.accountId] = account;
  const token = await issueSession(db, account.accountId);
  return { token, account: publicAccount(account) };
}

/**
 * Log in. Wrong number and wrong password deliberately return the SAME error,
 * so this endpoint cannot be used to discover which mobile numbers have
 * accounts.
 */
export async function authenticate({ phone, password }) {
  const db = await load();
  const account = phone ? findByPhone(db, phone) : null;
  const pw = String(password || "");

  // Run the hash even when there is no account, so a missing number and a wrong
  // password take the same time. Without this the response time alone answers
  // "does this person have an account?".
  const stored = account?.passwordHash || `scrypt$${"00".repeat(SALT_BYTES)}$${"00".repeat(SCRYPT_KEYLEN)}`;
  const ok = await verifyPassword(pw, stored);

  if (!account || !ok) {
    throw Object.assign(new Error("That mobile number and password don't match."), { code: "BAD_CREDENTIALS" });
  }

  const token = await issueSession(db, account.accountId);
  return { token, account: publicAccount(account) };
}

// ── What the calls learn ────────────────────────────────────────────────────

/**
 * Merge facts established during a call into the account's standing profile.
 *
 * Deliberately schema-agnostic: this module does not know or care what the
 * fields are called. Later calls overwrite earlier ones key by key, because the
 * most recent thing the caller said about themselves is the thing to believe —
 * but a key that is absent or null in `facts` never erases what is already
 * known, so one call that failed to cover a topic cannot wipe it.
 *
 * The merge is RECURSIVE, and that is load-bearing now that the profile is a
 * set of branches rather than a flat bag: a call that establishes only the
 * co-applicant's name must not replace the whole coApplicant branch and take
 * their income with it. Arrays replace wholesale — a partial array is not a
 * fact, and merging two lists element by element means nothing here.
 *
 * @param {string[]} [opts.replace] - top-level keys to overwrite instead of
 *   merging. For values that are computed from the whole profile rather than
 *   accumulated: a FOIR left over from a call where the income was wrong is
 *   worse than no FOIR. The caller names them; this module still does not know
 *   what they mean.
 */
export async function mergeProfile(accountId, facts, { replace = [] } = {}) {
  if (!accountId || !facts || typeof facts !== "object") return null;
  const db = await load();
  const account = db.accounts[accountId];
  if (!account) return null;

  account.profile = account.profile || {};
  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === undefined || value === "") continue;
    if (replace.includes(key)) account.profile[key] = value;
    else mergeInto(account.profile, key, value);
  }
  account.updatedAt = new Date().toISOString();
  await save();
  return account.profile;
}

function mergeInto(target, key, value) {
  const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isPlainObject(value) || !isPlainObject(target[key])) {
    target[key] = value;
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === "") continue;
    mergeInto(target[key], k, v);
  }
}

/**
 * Record a finished call against an account.
 * @param {string} accountId
 * @param {object} call
 * @param {Array<{role: string, text: string, at: string}>} [call.turns]
 */
export async function recordCall(accountId, call) {
  if (!accountId) return null;
  const db = await load();
  const account = db.accounts[accountId];
  if (!account) return null;

  const turns = Array.isArray(call?.turns) ? call.turns.slice(-MAX_TURNS_PER_CALL) : [];
  const entry = {
    callId: `VC-${Date.now().toString(36).toUpperCase()}`,
    startedAt: call?.startedAt || new Date().toISOString(),
    endedAt: call?.endedAt || new Date().toISOString(),
    seconds: Number(call?.seconds) || 0,
    endedBecause: String(call?.endedBecause || "").slice(0, 120),
    turns,
  };

  account.calls = account.calls || [];
  account.calls.unshift(entry);
  if (account.calls.length > MAX_CALLS_KEPT) account.calls.length = MAX_CALLS_KEPT;
  account.lastCallAt = entry.endedAt;
  account.updatedAt = entry.endedAt;
  await save();
  return entry;
}

/**
 * Just the standing profile. Its own accessor because the extractor needs to
 * compute the derived branch against what the profile is about to BE — the
 * merge of old and new — and pulling the whole account with its call history to
 * read one key is the kind of thing that becomes a habit.
 */
export async function getProfile(accountId) {
  const db = await load();
  return db.accounts[accountId]?.profile || {};
}

/** Newest call first. */
export async function listCalls(accountId) {
  const db = await load();
  return (db.accounts[accountId]?.calls || []).slice();
}

/** Every account, for the team dashboard. Shaped, so no hash can escape. */
export async function listAccounts() {
  const db = await load();
  return Object.values(db.accounts)
    .map(publicAccount)
    .sort((a, b) => String(b.lastCallAt || b.createdAt).localeCompare(String(a.lastCallAt || a.createdAt)));
}

/** One account with its calls, for the team dashboard's detail view. */
export async function getAccountDetail(accountId) {
  const db = await load();
  const account = db.accounts[accountId];
  if (!account) return null;
  return { ...publicAccount(account), calls: (account.calls || []).slice() };
}
