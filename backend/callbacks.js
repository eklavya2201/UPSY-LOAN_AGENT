// Callback requests from the mobile surface (/m).
//
// Exists because of a real hole in the voice funnel: an anonymous caller who
// has a good conversation with UPSY and then hangs up leaves nothing behind —
// no name, no number, no lead. "Schedule call" is the other half of the call
// button, for the person who would rather be phoned back than talk right now
// (or who tapped Call at midnight, or whose agent line is down).
//
// Deliberately the same file-backed shape as store.js rather than anything
// cleverer: this is a queue an officer reads, not a system of record. Note the
// same ephemeral-storage caveat as the rest of data/ on Render's free tier.

import fs from "fs/promises";
import { makeJsonWriter } from "./jsonFile.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "callbacks.json");

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    cache = [];
  }
  if (!Array.isArray(cache)) cache = [];
  return cache;
}

// Atomic (temp file + fsync + rename) and serialised against itself, so a
// crash cannot truncate the file and two concurrent callers cannot discard
// each other's change. See backend/jsonFile.js for why both matter.
const writer = makeJsonWriter(FILE, () => JSON.stringify(cache, null, 2));

function save() {
  return writer.save();
}

// Indian mobile numbers, tolerant of how people actually type them: spaces,
// dashes, a +91 or 0 prefix. Returns the bare 10 digits, or null.
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10) return null;
  // Indian mobile numbers start 6-9; anything else is a typo or a landline we
  // cannot text, and it is kinder to say so now than to fail silently later.
  if (!/^[6-9]/.test(local)) return null;
  return local;
}

/**
 * Record a callback request.
 * @param {object} req
 * @param {string} req.name
 * @param {string} req.phone   - already normalized by the caller
 * @param {string} [req.whenText] - free text, e.g. "tomorrow evening". Kept as
 *   text on purpose: a picker would force a precision nobody has, and an
 *   officer reads this anyway.
 * @param {string|null} [req.leadId]
 * @param {string} [req.topic]
 */
export async function recordCallback({ name, phone, whenText, leadId = null, topic = "" }) {
  const list = await load();
  const entry = {
    id: `CB-${Date.now().toString(36).toUpperCase()}`,
    name: String(name || "").trim().slice(0, 80),
    phone,
    whenText: String(whenText || "").trim().slice(0, 120),
    topic: String(topic || "").trim().slice(0, 200),
    leadId,
    status: "pending",
    at: new Date().toISOString(),
  };
  list.unshift(entry);
  await save();
  return entry;
}

export async function listCallbacks() {
  return (await load()).slice();
}

// What the ops channel sees. Console-only until NOTIFY_CHANNEL leaves mock —
// same caveat as every other outbound message in this repo.
export function callbackOpsMessage(entry) {
  const when = entry.whenText ? ` — asked for: ${entry.whenText}` : "";
  const who = entry.leadId ? ` (lead ${entry.leadId})` : " (new enquiry)";
  return `Callback requested: ${entry.name || "no name given"} on ${entry.phone}${when}${who}`;
}
