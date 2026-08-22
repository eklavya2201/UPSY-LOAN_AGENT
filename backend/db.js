// Postgres, when there is one. The JSON files otherwise.
//
// ⚠️ THE FALLBACK IS THE POINT OF THIS FILE. Without DATABASE_URL every store
// keeps using backend/jsonFile.js exactly as before, so a checkout with no
// database still runs, `npm start` still works, and the evals do not need a
// server. A migration that breaks everyone who has not migrated yet is a
// migration nobody applies.
//
// ── Why plain Postgres and not the Supabase client ──────────────────────────
// The anon/service_role split exists so a BROWSER can talk to Supabase directly
// under row-level security. Nothing here does that — this Node process is the
// only client, and it is trusted. Connecting as ordinary Postgres gives real
// transactions, no HTTP hop per query, and no dependency on a vendor SDK for
// what is a standard database. It also means moving off Supabase later is a
// connection-string change rather than a rewrite.
//
// ── Pooling ─────────────────────────────────────────────────────────────────
// Use Supabase's SESSION pooler (port 6543). The transaction pooler cannot hold
// a session across statements, which breaks anything using a transaction — and
// the whole reason for moving off JSON was to get those.

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Placeholder values count as absent, the same rule llmProviders.js applies to
// API keys — a half-filled .env should behave like an empty one rather than
// failing at the first query with something cryptic.
function connectionString() {
  const raw = (process.env.DATABASE_URL || "").trim();
  if (!raw || raw.includes("your_") || raw.includes("_here") || raw.includes("[PASSWORD]")) return null;
  return raw;
}

export function dbEnabled() {
  return Boolean(connectionString());
}

let pool = null;

export function getPool() {
  if (!dbEnabled()) return null;
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: connectionString(),
    // Supabase terminates TLS with its own chain; verifying it needs their CA
    // bundle shipped alongside. The connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    // Small on purpose. One instance serves ~100 users, and the session pooler
    // charges for held connections — ten is generous headroom, not a limit
    // anything here will reach.
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A pool error with no listener is an uncaught exception, and this process
  // treats those as fatal — so a dropped idle connection would take the server
  // down rather than being retried on the next query.
  pool.on("error", (e) => console.error("[db] idle client error:", e.message));
  return pool;
}

export async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error("No DATABASE_URL — the JSON store should have been used instead.");
  return p.query(text, params);
}

/** Run several statements as one unit. The thing JSON files could never do. */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Create the tables if they are not there.
 *
 * Safe to run on every boot — every statement in schema.sql is `if not exists`.
 * Doing it automatically means a fresh Supabase project needs no manual step,
 * which is one fewer thing to get wrong on a deploy at 11pm.
 */
export async function ensureSchema() {
  if (!dbEnabled()) return { ok: false, reason: "no DATABASE_URL" };
  const sql = await fs.readFile(path.join(__dirname, "sql", "schema.sql"), "utf8");
  await query(sql);
  return { ok: true };
}

/** One line for the boot log, so which store is live is never a guess. */
export async function dbStatusLine() {
  if (!dbEnabled()) return "Storage: JSON files in data/ (set DATABASE_URL for Postgres)";
  try {
    const { rows } = await query("select current_database() as db, version() as v");
    const version = String(rows[0]?.v || "").split(" ").slice(0, 2).join(" ");
    return `Storage: Postgres — ${rows[0]?.db} (${version})`;
  } catch (e) {
    // Loud, and NOT fatal: a database that is briefly unreachable must not stop
    // the server booting, because the stores fall back on their own.
    return `Storage: ⚠️ DATABASE_URL is set but unreachable (${e.message}) — falling back to JSON files`;
  }
}

export async function closePool() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
