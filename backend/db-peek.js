// `npm run db:peek` — where did the data actually go?
//
// Written because "is it in Postgres or is it still in data/*.json?" is a
// question you ask on every deploy and after every migration, and the honest
// answer needs both halves shown side by side. dbStatusLine() names the live
// store, then every table gets a row count, then the JSON files get theirs —
// so a store that silently fell back to files is visible as "Postgres empty,
// files full" rather than as nothing at all.
//
// Read-only. Safe to run against production.
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { query, dbEnabled, dbStatusLine, closePool } from "./db.js";

const TABLES = [
  ["applications",     "lead records + verified docs"],
  ["voice_accounts",   "/upsy-voice-agent sign-ups + the five-branch loan file"],
  ["voice_sessions",   "live sign-in tokens"],
  ["voice_calls",      "one row per call"],
  ["voice_call_turns", "one row per spoken turn — the transcripts"],
  ["voice_reviews",    "call ratings"],
  ["voice_callbacks",  "the 'Schedule call' queue"],
];

const JSON_FILES = [
  ["applications.json",  (d) => Object.keys(d.applications || d || {}).length],
  ["voiceAccounts.json", (d) => Object.keys(d.accounts || {}).length],
  ["reviews.json",       (d) => (d.reviews || []).length],
  ["callbacks.json",     (d) => (d.callbacks || []).length],
];

console.log("\n" + (await dbStatusLine()));

if (dbEnabled()) {
  console.log("\nPOSTGRES");
  console.log("  " + "table".padEnd(18) + "rows   what it holds");
  console.log("  " + "─".repeat(72));
  for (const [table, what] of TABLES) {
    let n;
    try {
      n = String((await query(`select count(*)::int as n from ${table}`)).rows[0].n);
    } catch (e) {
      // A missing table is the interesting case: schema never applied.
      n = e.message.includes("does not exist") ? "—" : "ERR";
    }
    console.log("  " + table.padEnd(18) + n.padStart(4) + "   " + what);
  }

  // Counts alone cannot tell a live database from one holding only fixtures,
  // so show who is actually in it.
  try {
    const { rows } = await query(
      `select a.name, a.phone, a.last_call_at,
              (select count(*)::int from voice_calls c where c.account_id = a.account_id) as calls
         from voice_accounts a order by a.created_at desc limit 5`
    );
    if (rows.length) {
      console.log("\n  most recent accounts");
      for (const r of rows) {
        // Same partial-masking rule as redact.js: enough to recognise a row,
        // not enough to be a phone book.
        const phone = String(r.phone || "").replace(/^(\d{2})\d+(\d{2})$/, "$1••••••$2");
        const when = r.last_call_at ? new Date(r.last_call_at).toISOString().slice(0, 16).replace("T", " ") : "never";
        console.log(`    ${String(r.name).padEnd(20)} ${phone.padEnd(12)} ${String(r.calls).padStart(2)} calls   last: ${when}`);
      }
    }
  } catch { /* table may not exist yet */ }
}

console.log("\nJSON FILES in data/  (the fallback — these are what runs with no DATABASE_URL)");
for (const [file, count] of JSON_FILES) {
  const full = path.join(process.cwd(), "data", file);
  let line;
  try {
    line = String(count(JSON.parse(await fs.readFile(full, "utf8")))).padStart(4) + " records";
  } catch (e) {
    line = e.code === "ENOENT" ? "   — not present" : "   unreadable";
  }
  console.log("  " + file.padEnd(22) + line);
}

if (dbEnabled()) {
  console.log("\nPostgres is live, so the JSON files above are stale leftovers, not the source of truth.");
} else {
  console.log("\n⚠️  No DATABASE_URL — the JSON files ARE the store, and Render deletes them on deploy.");
}
console.log();

await closePool();
