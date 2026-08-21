// What the caller thought of the call.
//
// Until now every judgement of the voice agent came from someone on the team
// relaying it by hand — the three fixes on 2026-08-11 came from one person
// saying "she said yes, then stopped" and "it asked me three times". That is
// real feedback and it found real bugs, but it only reaches us when somebody
// happens to mention it, and it never comes from the applicant we did not
// already know. This is the same signal with a path of its own.
//
// Asked only after a call ends, because that is the one moment the caller has
// an opinion and nothing left to do. Deliberately NOT on the document flow:
// the README's UI-polish batch is waiting on feedback from multiple people,
// and mixing "how was the upload form" into the same number would make the
// score mean nothing in particular.
//
// Same file-backed shape as callbacks.js rather than anything cleverer — this
// is a list an officer reads, not a system of record. Same ephemeral-storage
// caveat as the rest of data/ on Render's free tier: a respin loses these, so
// do not treat the average as a metric anyone is accountable to until this
// lives on a real disk.

import fs from "fs/promises";
import { makeJsonWriter } from "./jsonFile.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "reviews.json");

// A rating below this is worth telling an officer about while the caller might
// still be reachable, rather than at the end of the week.
const POOR_RATING = 2;

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

/**
 * A rating is 1-5 and nothing else. Returns null for anything that is not,
 * including "4" as a string with whitespace, 4.5, NaN and 0 — the route turns
 * that null into a 400 rather than storing a rating nobody can compare.
 */
export function parseRating(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

/**
 * Record what a caller thought of their call.
 *
 * @param {object} r
 * @param {number} r.rating          - 1-5, already validated by parseRating
 * @param {string} [r.comment]       - optional free text; the useful half
 * @param {string|null} [r.accountId] - /m account, when they signed in
 * @param {string|null} [r.leadId]   - their loan file, when the call was grounded
 * @param {number} [r.callSeconds]   - how long they were actually on the call
 * @param {number} [r.turns]         - how many times they spoke
 *
 * callSeconds and turns are stored because a 1-star after fifteen seconds and
 * a 1-star after eight minutes are different complaints: the first is usually
 * "it could not hear me", the second is about the conversation itself. Without
 * them every low score looks the same in the list.
 */
export async function recordReview({ rating, comment = "", accountId = null, leadId = null, callSeconds = 0, turns = 0 }) {
  const list = await load();
  const entry = {
    id: `RV-${Date.now().toString(36).toUpperCase()}`,
    rating,
    comment: String(comment || "").trim().slice(0, 1000),
    accountId: accountId ? String(accountId).slice(0, 64) : null,
    leadId: leadId ? String(leadId).slice(0, 64) : null,
    callSeconds: Number.isFinite(callSeconds) ? Math.max(0, Math.round(callSeconds)) : 0,
    turns: Number.isFinite(turns) ? Math.max(0, Math.round(turns)) : 0,
    at: new Date().toISOString(),
  };
  list.unshift(entry);
  await save();
  return entry;
}

export async function listReviews() {
  return (await load()).slice();
}

/**
 * The numbers the dashboard shows above the list.
 *
 * `withComment` is here because it is the one worth watching: the average
 * moves slowly and tells you little, while the count of people who bothered to
 * type something is what actually feeds a fix.
 */
export async function reviewSummary() {
  const list = await load();
  const count = list.length;
  if (!count) return { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, withComment: 0, poor: 0 };

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let withComment = 0;
  for (const r of list) {
    distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    total += r.rating;
    if (r.comment) withComment += 1;
  }
  return {
    count,
    average: Math.round((total / count) * 10) / 10,
    distribution,
    withComment,
    poor: distribution[1] + distribution[2],
  };
}

export function isPoorRating(rating) {
  return rating <= POOR_RATING;
}

// What the ops channel sees, and only for a poor rating — a five-star review
// does not need to wake anybody. Console-only until NOTIFY_CHANNEL leaves
// mock, same caveat as every other outbound message in this repo.
export function reviewOpsMessage(entry) {
  const who = entry.leadId ? `lead ${entry.leadId}` : entry.accountId ? "a signed-in caller" : "an anonymous caller";
  const said = entry.comment ? ` — "${entry.comment.slice(0, 140)}"` : " (no comment left)";
  const len = entry.callSeconds ? ` after ${Math.round(entry.callSeconds / 60) || 1} min on the call` : "";
  return `Voice call rated ${entry.rating}/5 by ${who}${len}${said}`;
}
