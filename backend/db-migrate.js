// Move data/*.json into Postgres: npm run db:migrate
//
// Idempotent — every insert is an upsert on the primary key, so running it
// twice changes nothing and running it after a partial failure finishes the
// job. That matters more than it sounds: the alternative is a migration
// somebody is afraid to re-run, which is a migration that gets abandoned
// half-done.
//
// The JSON files are left exactly where they are. Nothing here deletes them,
// and every store falls back to them whenever DATABASE_URL is absent, so this
// is reversible by unsetting one environment variable.

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dbEnabled, ensureSchema, query, transaction, closePool } from "./db.js";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA, name), "utf8"));
  } catch (e) {
    return fallback;
  }
}

if (!dbEnabled()) {
  console.error("\nNo DATABASE_URL set. Put the Supabase session-pooler URI in .env first:\n");
  console.error("  DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres\n");
  process.exit(1);
}

console.log("\n-- Schema ---------------------------------------------------");
await ensureSchema();
ok("tables and indexes are in place");

// -- Applications -----------------------------------------------------------
console.log("\n-- Applications ---------------------------------------------");
{
  const db = await readJson("applications.json", {});
  const rows = Object.values(db).filter((a) => a && a.leadId);
  for (const app of rows) {
    await query(
      `insert into applications (lead_id, status, doc, updated_at)
       values ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()))
       on conflict (lead_id) do update
         set status = excluded.status, doc = excluded.doc, updated_at = excluded.updated_at`,
      [app.leadId, app.status || "in_progress", JSON.stringify(app), app.updatedAt || null]
    );
  }
  ok(`${rows.length} application(s)`);
}

// -- Voice accounts, their calls, and every turn -----------------------------
console.log("\n-- Voice accounts -------------------------------------------");
{
  const db = await readJson("voiceAccounts.json", { accounts: {}, sessions: {} });
  const accounts = Object.values(db.accounts || {});
  let calls = 0;
  let turns = 0;

  for (const a of accounts) {
    if (!a || !a.accountId) continue;
    // One transaction per account: an account and its calls arrive together or
    // not at all, so a failure halfway cannot leave calls pointing at an
    // account that was never written.
    await transaction(async (client) => {
      await client.query(
        `insert into voice_accounts (account_id, name, phone, password_hash, profile, created_at, last_call_at)
         values ($1,$2,$3,$4,$5::jsonb, coalesce($6::timestamptz, now()), $7::timestamptz)
         on conflict (account_id) do update
           set name = excluded.name, phone = excluded.phone,
               password_hash = excluded.password_hash, profile = excluded.profile,
               last_call_at = excluded.last_call_at`,
        [
          a.accountId,
          a.name || "",
          a.phone || "",
          a.passwordHash || "",
          JSON.stringify(a.profile || {}),
          a.createdAt || null,
          a.lastCallAt || null,
        ]
      );

      for (const c of a.calls || []) {
        const callId = c.callId || `${a.accountId}-${c.startedAt}`;
        await client.query(
          `insert into voice_calls (call_id, account_id, started_at, ended_at, seconds, ended_because, language)
           values ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7)
           on conflict (call_id) do update
             set ended_at = excluded.ended_at, seconds = excluded.seconds,
                 ended_because = excluded.ended_because`,
          [
            callId,
            a.accountId,
            c.startedAt || new Date().toISOString(),
            c.endedAt || null,
            c.seconds ?? null,
            c.endedBecause || null,
            c.language || null,
          ]
        );
        calls++;

        // Replaced wholesale rather than appended, so re-running cannot double
        // a transcript.
        await client.query("delete from voice_call_turns where call_id = $1", [callId]);
        const list = c.turns || [];
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (!t || !t.text) continue;
          await client.query(
            `insert into voice_call_turns (call_id, idx, role, text, said_at)
             values ($1,$2,$3,$4,$5::timestamptz)`,
            [callId, i, t.role === "caller" ? "caller" : "agent", String(t.text), t.at || null]
          );
          turns++;
        }
      }
    });
  }
  ok(`${accounts.length} account(s), ${calls} call(s), ${turns} transcript turn(s)`);

  // Sessions are deliberately NOT migrated. They are short-lived bearer tokens;
  // carrying them across a storage change buys nothing, and everyone signing in
  // once more is a fine outcome.
  const sessionCount = Object.keys(db.sessions || {}).length;
  if (sessionCount) warn(`${sessionCount} live session(s) not carried over - callers sign in again once`);
}

// -- Reviews and callbacks ---------------------------------------------------
console.log("\n-- Reviews & callbacks --------------------------------------");
{
  const list = await readJson("reviews.json", []);
  const reviews = Array.isArray(list) ? list : [];
  for (const r of reviews) {
    if (!r || !r.id) continue;
    await query(
      `insert into voice_reviews (id, rating, comment, account_id, lead_id, call_seconds, turns, created_at)
       values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
       on conflict (id) do nothing`,
      [r.id, r.rating, r.comment || null, r.accountId || null, r.leadId || null, r.callSeconds ?? null, r.turns ?? null, r.at || null]
    );
  }
  ok(`${reviews.length} review(s)`);

  const cbs = await readJson("callbacks.json", []);
  const callbacks = Array.isArray(cbs) ? cbs : [];
  for (const c of callbacks) {
    if (!c || !c.id) continue;
    await query(
      `insert into voice_callbacks (id, name, phone, when_text, lead_id, account_id, handled, created_at)
       values ($1,$2,$3,$4,$5,$6, coalesce($7,false), coalesce($8::timestamptz, now()))
       on conflict (id) do nothing`,
      [c.id, c.name || null, c.phone || "", c.when || c.whenText || null, c.leadId || null, c.accountId || null, c.handled ?? false, c.at || null]
    );
  }
  ok(`${callbacks.length} callback(s)`);
}

// -- What actually landed ----------------------------------------------------
console.log("\n-- In the database now --------------------------------------");
for (const t of ["applications", "voice_accounts", "voice_calls", "voice_call_turns", "voice_reviews", "voice_callbacks"]) {
  const { rows } = await query(`select count(*)::int as n from ${t}`);
  console.log(`  ${t.padEnd(18)} ${rows[0].n}`);
}

console.log("\nThe JSON files are untouched. Unset DATABASE_URL to go back to them.\n");
await closePool();
process.exit(0);
