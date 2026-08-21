// Who is allowed to see applicants' documents.
//
// `/team` and every `/api/applications/*` route were open to anyone with the
// URL. That was survivable while the only people testing were the team and the
// only records were demo leads. It stops being survivable the moment a real
// applicant's PAN sits behind it — and it gets worse, not better, on upsy.in,
// because the dashboard would then be on the company's own domain.
//
// ── Deliberately small ──────────────────────────────────────────────────────
// One shared account for the CEO and the loan officers, as agreed. Not a user
// system: no signup, no roles, no reset flow, no per-officer audit trail. Those
// are worth building when there is a reason to tell two officers apart, and
// inventing them now would be scaffolding nobody asked for.
//
// What it does have is the parts that are unsafe to skip: the password is
// scrypt-hashed rather than compared as text, the session cookie is HttpOnly
// and SameSite=Lax so a script on another page cannot read or replay it, and
// failed attempts are rate-limited per IP so the short password cannot simply
// be guessed at machine speed.
//
// ⚠️ THE CREDENTIALS LIVE IN .env, NEVER IN THIS FILE. The repository is
// public. A password committed to source is a password published, and rotating
// it afterwards does not remove it from the history.

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD_BYTES = 256;

// A working day plus a margin. Short enough that a laptop left open in a café
// is not an indefinite hole; long enough that an officer is not signing in
// between every applicant.
const SESSION_TTL_MS = Number(process.env.TEAM_SESSION_TTL_MS || 12 * 60 * 60 * 1000);

// In memory on purpose. Sessions are not worth persisting — a restart signing
// everyone out is a mild annoyance, while a sessions file is one more thing
// that has to be written atomically and kept out of git.
const sessions = new Map();

// Failed attempts per IP. The agreed password is eight digits, which is roughly
// 10^8 guesses — trivial online without this, and fine with it.
const attempts = new Map();
const MAX_ATTEMPTS = Number(process.env.TEAM_MAX_ATTEMPTS || 8);
const ATTEMPT_WINDOW_MS = Number(process.env.TEAM_ATTEMPT_WINDOW_MS || 15 * 60 * 1000);

export const TEAM_COOKIE = "upsy_team";

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

/** Hash a password for TEAM_PASSWORD_HASH. Used by `npm run team:hash`. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scryptAsync(password, salt);
  return timingSafeEqual(derived, expected);
}

/**
 * Is team auth switched on?
 *
 * Both values must be present. Half-configured is treated as OFF rather than as
 * an error, so a missing env var cannot lock the team out of their own
 * dashboard at the worst possible moment — but the boot log says so loudly, and
 * so does the sign-in page.
 */
export function teamAuthConfigured() {
  return Boolean(process.env.TEAM_EMAIL && process.env.TEAM_PASSWORD_HASH);
}

export function teamAuthStatusLine() {
  if (teamAuthConfigured()) return `Team dashboard: password-protected (${process.env.TEAM_EMAIL})`;
  return "Team dashboard: ⚠️ OPEN — anyone with the URL can read every applicant's documents. Set TEAM_EMAIL and TEAM_PASSWORD_HASH.";
}

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
    return;
  }
  rec.count++;
}

/**
 * Check an email and password, and mint a session on success.
 *
 * Returns `{ ok, token, error }`. The error text never distinguishes a wrong
 * email from a wrong password — that difference tells an attacker which half
 * they got right, and tells a legitimate officer nothing they cannot work out
 * by trying again.
 */
export async function signIn({ email, password, ip }) {
  if (!teamAuthConfigured()) return { ok: false, error: "Team sign-in is not configured on this server." };
  if (tooManyAttempts(ip)) {
    return { ok: false, error: "Too many attempts. Wait fifteen minutes and try again." };
  }

  const given = String(password || "");
  // scrypt's cost is per call, so an unbounded password is a free way to make
  // the server do arbitrary work. Same guard as voiceAccounts.js.
  if (Buffer.byteLength(given) > MAX_PASSWORD_BYTES) {
    recordFailure(ip);
    return { ok: false, error: "Email or password is not right." };
  }

  const emailOk =
    String(email || "").trim().toLowerCase() === String(process.env.TEAM_EMAIL).trim().toLowerCase();
  const passOk = await verifyPassword(given, process.env.TEAM_PASSWORD_HASH);

  // Both checks run before either is acted on, so the response time does not
  // reveal which one failed.
  if (!emailOk || !passOk) {
    recordFailure(ip);
    return { ok: false, error: "Email or password is not right." };
  }

  attempts.delete(ip);
  const token = randomUUID() + randomBytes(24).toString("hex");
  sessions.set(token, { email: process.env.TEAM_EMAIL, expiresAt: Date.now() + SESSION_TTL_MS });
  return { ok: true, token };
}

export function signOut(token) {
  if (token) sessions.delete(token);
}

/** The signed-in officer, or null. Expired sessions are swept as they are met. */
export function sessionFrom(token) {
  if (!token) return null;
  const rec = sessions.get(token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { email: rec.email };
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function tokenFromRequest(req) {
  return cookieValue(req.headers?.cookie, TEAM_COOKIE);
}

export function setSessionCookie(res, token, secure) {
  const bits = [
    `${TEAM_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  // Only over TLS in production. Setting Secure on plain http://localhost would
  // make the cookie silently never arrive, which is a miserable thing to debug.
  if (secure) bits.push("Secure");
  res.setHeader("Set-Cookie", bits.join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${TEAM_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Guard the dashboard and its API.
 *
 * ⚠️ FAILS OPEN WHEN UNCONFIGURED, and that is a decision rather than an
 * oversight. The alternative — refusing to serve `/team` without credentials —
 * would break every existing deployment and every local checkout the moment
 * this shipped, which is how a security feature gets reverted instead of
 * adopted. It is loud instead: the boot log warns, and the status line says so.
 * Once TEAM_EMAIL and TEAM_PASSWORD_HASH are set, it is closed.
 *
 * A browser navigating to a page is redirected to sign in; an API call gets a
 * 401 with JSON, because a redirect to HTML is not something fetch() can use.
 */
export function requireTeamAuth(req, res, next) {
  if (!teamAuthConfigured()) return next();
  if (sessionFrom(tokenFromRequest(req))) return next();

  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) {
    const back = encodeURIComponent(req.originalUrl || "/team");
    return res.redirect(`/team/login?next=${back}`);
  }
  return res.status(401).json({ error: "Sign in to view this." });
}
