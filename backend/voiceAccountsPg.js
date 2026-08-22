// The Postgres implementation of voiceAccounts.js.
//
// Same function names, same arguments, same return shapes — voiceAccounts.js
// picks between this and the JSON one at call time, so nothing upstream knows
// which is live. That is what makes the switch a single environment variable
// and the rollback the same.
//
// ── What this actually buys ─────────────────────────────────────────────────
// The continuity was never the missing part: mergeProfile() has always written
// what a call established and buildVoiceSystemPrompt() has always read it back,
// so a second call genuinely resumes. What failed was that those facts lived in
// a file Render deletes on every deploy — a caller who rang on Monday was a
// stranger on Wednesday because the FILE went, not because the agent forgot.
//
// The other half is that the JSON store held everything in one in-process
// cache, so two processes could not share it. That is what blocked running the
// voice agent beside the upsy.in app.
//
// ── Turns are rows, not a nested array ──────────────────────────────────────
// The single most important shape change. A transcript is ~6KB and the old
// store rewrote the entire file — every account, every call, every word — on
// each mid-call extraction pass. Here a turn is a row, so appending one touches
// one row, and reading an account no longer drags every word anyone ever said.

import { randomUUID } from "node:crypto";
import { query, transaction } from "./db.js";

// Same ceilings as the JSON store, for the same reason: a caller who talks for
// ten minutes should not make every later read of their account expensive.
const MAX_CALLS_KEPT = 20;
const MAX_TURNS_PER_CALL = 400;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(accountId) {
  const token = randomUUID() + randomUUID().replace(/-/g, "");
  await query(
    `insert into voice_sessions (token, account_id, expires_at)
     values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
    [token, accountId, String(SESSION_TTL_MS)]
  );
  return token;
}

export async function resolveSession(token) {
  if (!token) return null;
  // Expiry is checked in SQL rather than in JavaScript, so a clock difference
  // between processes cannot let one of them honour a session another has
  // already retired.
  const { rows } = await query(
    `select a.* from voice_sessions s
       join voice_accounts a on a.account_id = s.account_id
      where s.token = $1 and s.expires_at > now()`,
    [token]
  );
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function endSession(token) {
  if (!token) return;
  await query("delete from voice_sessions where token = $1", [token]);
}

/** Housekeeping the JSON store did by rewriting the whole file. */
export async function sweepExpiredSessions() {
  const { rowCount } = await query("delete from voice_sessions where expires_at <= now()");
  return rowCount;
}

// ── Accounts ────────────────────────────────────────────────────────────────

function rowToAccount(r) {
  return {
    accountId: r.account_id,
    name: r.name,
    phone: r.phone,
    passwordHash: r.password_hash,
    profile: r.profile || {},
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    lastCallAt: r.last_call_at instanceof Date ? r.last_call_at.toISOString() : r.last_call_at,
  };
}

export async function findByPhone(phone) {
  const { rows } = await query("select * from voice_accounts where phone = $1", [phone]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function findById(accountId) {
  const { rows } = await query("select * from voice_accounts where account_id = $1", [accountId]);
  return rows[0] ? rowToAccount(rows[0]) : null;
}

export async function insertAccount({ accountId, name, phone, passwordHash }) {
  // ON CONFLICT DO NOTHING plus a rowCount check, rather than "look then
  // insert": two people signing up on the same number at the same moment is
  // exactly the race the JSON store could not see, and the unique index is the
  // only thing that can actually settle it.
  const { rows } = await query(
    `insert into voice_accounts (account_id, name, phone, password_hash, profile)
     values ($1, $2, $3, $4, '{}'::jsonb)
     on conflict (phone) do nothing
     returning *`,
    [accountId, name, phone, passwordHash]
  );
  return rows[0] ? rowToAccount(rows[0]) : null;
}

// ── The loan file ───────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// Byte-for-byte the JSON store's merge, so a profile written by one and read by
// the other cannot disagree about what "merge" means.
function mergeInto(target, key, value) {
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
 * Fold new facts into the standing profile.
 *
 * Read and write inside ONE transaction with a row lock. The JSON version read
 * the whole file, merged in memory and wrote it back — so two extraction passes
 * finishing together silently discarded one set of facts. `for update` makes
 * the second caller wait for the first, which is the behaviour that was assumed
 * all along and never actually held.
 */
export async function mergeProfile(accountId, facts, { replace = [] } = {}) {
  if (!accountId || !facts || typeof facts !== "object") return null;
  return transaction(async (client) => {
    const { rows } = await client.query(
      "select profile from voice_accounts where account_id = $1 for update",
      [accountId]
    );
    if (!rows[0]) return null;

    const profile = rows[0].profile || {};
    for (const [key, value] of Object.entries(facts)) {
      if (value === null || value === undefined || value === "") continue;
      if (replace.includes(key)) profile[key] = value;
      else mergeInto(profile, key, value);
    }
    await client.query("update voice_accounts set profile = $2::jsonb where account_id = $1", [
      accountId,
      JSON.stringify(profile),
    ]);
    return profile;
  });
}

export async function getProfile(accountId) {
  const { rows } = await query("select profile from voice_accounts where account_id = $1", [accountId]);
  return rows[0]?.profile || {};
}

// ── Calls ───────────────────────────────────────────────────────────────────

export async function recordCall(accountId, call) {
  if (!accountId) return null;
  const turns = Array.isArray(call?.turns) ? call.turns.slice(-MAX_TURNS_PER_CALL) : [];
  const entry = {
    callId: `VC-${Date.now().toString(36).toUpperCase()}`,
    startedAt: call?.startedAt || new Date().toISOString(),
    endedAt: call?.endedAt || new Date().toISOString(),
    seconds: Number(call?.seconds) || 0,
    endedBecause: String(call?.endedBecause || "").slice(0, 120),
    turns,
  };

  return transaction(async (client) => {
    const exists = await client.query("select 1 from voice_accounts where account_id = $1", [accountId]);
    if (!exists.rows[0]) return null;

    await client.query(
      `insert into voice_calls (call_id, account_id, started_at, ended_at, seconds, ended_because, language)
       values ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7)`,
      [entry.callId, accountId, entry.startedAt, entry.endedAt, entry.seconds, entry.endedBecause, call?.language || null]
    );

    // One statement for the whole transcript rather than one per turn. A
    // 300-turn call as 300 round trips would add seconds to teardown, which is
    // the moment the caller is still on the line.
    if (turns.length) {
      const values = [];
      const params = [];
      turns.forEach((t, i) => {
        const base = i * 5;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::timestamptz)`);
        params.push(entry.callId, i, t.role === "caller" ? "caller" : "agent", String(t.text || ""), t.at || null);
      });
      await client.query(
        `insert into voice_call_turns (call_id, idx, role, text, said_at) values ${values.join(",")}`,
        params
      );
    }

    await client.query("update voice_accounts set last_call_at = $2::timestamptz where account_id = $1", [
      accountId,
      entry.endedAt,
    ]);

    // Trim to the most recent N. ON DELETE CASCADE takes the turns with them,
    // so there is no orphan transcript left behind — something the JSON store
    // got for free by nesting and which has to be stated here.
    await client.query(
      `delete from voice_calls
        where account_id = $1
          and call_id not in (
            select call_id from voice_calls where account_id = $1
            order by started_at desc limit $2
          )`,
      [accountId, MAX_CALLS_KEPT]
    );

    return entry;
  });
}

/** Newest first, transcripts included — the shape the JSON store returned. */
export async function listCalls(accountId) {
  const { rows } = await query(
    `select c.call_id, c.started_at, c.ended_at, c.seconds, c.ended_because,
            coalesce(
              json_agg(json_build_object('role', t.role, 'text', t.text, 'at', t.said_at)
                       order by t.idx) filter (where t.idx is not null),
              '[]'
            ) as turns
       from voice_calls c
       left join voice_call_turns t on t.call_id = c.call_id
      where c.account_id = $1
      group by c.call_id
      order by c.started_at desc`,
    [accountId]
  );
  return rows.map((r) => ({
    callId: r.call_id,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    endedAt: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at,
    seconds: r.seconds,
    endedBecause: r.ended_because,
    turns: r.turns || [],
  }));
}

/**
 * Every account for the dashboard — WITHOUT the transcripts.
 *
 * The list view shows a name, a phone and a call count. Under the JSON store
 * that meant loading every word of every call into memory to render a table
 * that displays none of it; here the counts are aggregates and the text is
 * never read.
 */
export async function listAccounts() {
  const { rows } = await query(
    `select a.account_id, a.name, a.phone, a.created_at, a.last_call_at, a.profile,
            count(c.call_id)::int as call_count
       from voice_accounts a
       left join voice_calls c on c.account_id = a.account_id
      group by a.account_id
      order by coalesce(a.last_call_at, a.created_at) desc`
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    name: r.name,
    phone: r.phone,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    lastCallAt: r.last_call_at instanceof Date ? r.last_call_at.toISOString() : r.last_call_at,
    callCount: r.call_count,
    profile: r.profile || {},
  }));
}
