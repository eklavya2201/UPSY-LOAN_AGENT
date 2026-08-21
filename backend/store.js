// Tiny file-based application store. Remembers which documents each lead has already
// had verified, so the agent can resume and so status survives a restart.
// (For production this would be a real database; the interface stays the same.)

import fs from "fs/promises";
import { makeJsonWriter } from "./jsonFile.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "applications.json");

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

// Atomic (temp file + fsync + rename) and serialised against itself, so a
// crash cannot truncate the file and two concurrent callers cannot discard
// each other's change. See backend/jsonFile.js for why both matter.
const writer = makeJsonWriter(FILE, () => JSON.stringify(cache, null, 2));

function save() {
  return writer.save();
}

export async function getApplication(leadId) {
  const db = await load();
  if (!db[leadId]) db[leadId] = { leadId, verifiedDocs: {}, status: "in_progress" };
  return db[leadId];
}

export async function markVerified(leadId, docId, info) {
  const app = await getApplication(leadId);
  app.verifiedDocs[docId] = { ...info, at: new Date().toISOString() };
  if (app.reuploadRequested) delete app.reuploadRequested[docId]; // fresh upload clears the flag
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

export async function setStatus(leadId, status, note) {
  const app = await getApplication(leadId);
  app.status = status;
  if (note !== undefined) app.decisionNote = note;
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

// Officer flags a specific document to be redone: drop the verified record so the
// applicant is asked for it again on their next visit, and remember it was flagged.
export async function requestReupload(leadId, docId, note) {
  const app = await getApplication(leadId);
  if (app.verifiedDocs?.[docId]) delete app.verifiedDocs[docId];
  app.reuploadRequested = app.reuploadRequested || {};
  app.reuploadRequested[docId] = { note: note || "", at: new Date().toISOString() };
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

// Snapshot the applicant profile + document totals so the team dashboard can
// list applications without re-querying the lead source each time.
export async function saveProfile(leadId, { profile, total, onFile, eligibility }) {
  const app = await getApplication(leadId);
  app.profile = profile;
  app.total = total;
  app.onFile = onFile;
  if (eligibility !== undefined) app.eligibility = eligibility;
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

export async function listApplications() {
  const db = await load();
  return Object.values(db);
}

// Record that a reminder was sent, and when, so we don't spam the applicant.
export async function recordNudge(leadId) {
  const app = await getApplication(leadId);
  app.nudgeCount = (app.nudgeCount || 0) + 1;
  app.lastNudgeAt = new Date().toISOString();
  await save();
  return app;
}

// Applicant deletes an uploaded document — it goes back to "pending".
// Returns the removed record (so the caller can delete the stored file) or null.
export async function removeVerified(leadId, docId) {
  const app = await getApplication(leadId);
  const rec = app.verifiedDocs?.[docId] || null;
  if (rec) delete app.verifiedDocs[docId];
  app.updatedAt = new Date().toISOString();
  await save();
  return rec;
}

// Save the income figure verified from an uploaded ITR / salary slip. It
// overrides the lead source's claimed income in every later eligibility run.
export async function saveExtractedIncome(leadId, info) {
  const app = await getApplication(leadId);
  app.extractedIncome = { ...info, at: new Date().toISOString() };
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

// Save the co-applicant's contact details read off their bank statement (name,
// address, phone). Mirrors saveExtractedIncome: persists across sessions, and
// the phone number overrides whatever the lead source has on file.
export async function saveCoApplicantContact(leadId, info) {
  const app = await getApplication(leadId);
  app.coApplicantContact = { ...info, at: new Date().toISOString() };
  app.updatedAt = new Date().toISOString();
  await save();
  return app;
}

// Save (or update) a lender referral draft for this application.
export async function saveLenderDraft(leadId, lenderId, draft) {
  const app = await getApplication(leadId);
  app.lenderDrafts = app.lenderDrafts || {};
  const existing = app.lenderDrafts[lenderId] || {};
  app.lenderDrafts[lenderId] = { ...existing, ...draft };
  app.updatedAt = new Date().toISOString();
  await save();
  return app.lenderDrafts[lenderId];
}

// Record that the drafted email was shared with the lender (when + how).
export async function recordLenderShared(leadId, lenderId, info) {
  const app = await getApplication(leadId);
  const draft = app.lenderDrafts?.[lenderId];
  if (!draft) return null;
  draft.sharedAt = new Date().toISOString();
  draft.sharedVia = info?.via || "outlook";
  await save();
  return draft;
}

// Record that the completed document packet was emailed to ops.
export async function recordPacketEmailed(leadId, info) {
  const app = await getApplication(leadId);
  app.packetEmailedAt = new Date().toISOString();
  app.packetEmailedTo = info?.to || null;
  await save();
  return app;
}
