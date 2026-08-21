import "dotenv/config"; // loads .env (credentials for Exotel / SMTP) if present
import fs from "fs/promises";
import http from "http";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { DOCUMENTS, STAGES, getDocument, applicableDocuments } from "./documents.js";
import { openaiSide } from "./llmProviders.js";
import { validateUpload } from "./validators.js";
import { getActiveSource } from "./leadSources/index.js";
import { getApplication, markVerified, setStatus, saveProfile, listApplications, requestReupload, recordNudge, recordPacketEmailed, saveLenderDraft, recordLenderShared, saveExtractedIncome, removeVerified, saveCoApplicantContact } from "./store.js";
import { extractIncome } from "./income.js";
import { extractBankStatement } from "./bankStatement.js";
import { matchInstitute } from "./institutes.js";
import { getLender, matchLenders } from "./lenders.js";
import { generateLenderDraft, buildEml } from "./lenderDraft.js";
import { getActiveNotifier, nudgeMessage } from "./notifier.js";
import { parseInboundWebhook, buildReply, twiml } from "./whatsapp.js";
import { parseExotelInbound } from "./exotel.js";
import { sendDocumentPacket, opsEmail } from "./mailer.js";
import { extractText, findIdentifier, readIdentifier, isOcrable, resetWorker, extractName, extractDob, namesMatch, addressesMatch } from "./ocr.js";
import { readCard, visionConfigured } from "./capture.js";
import { structureIntent, intakeConfigured } from "./intake.js";
import { answerDocQuestion, assistConfigured } from "./assist.js";
import { saveFile, filePath } from "./files.js";
import { assessEligibility } from "./eligibility.js";
import { startCall as startLiveAssist, stopCall as stopLiveAssist, getStatus as getLiveAssistStatus } from "./liveAssistManager.js";
import { createVoiceSession, voiceConfigured, voiceConfigError, voiceStatusLine, checkAgentReady, voiceProvider } from "./voiceCall.js";
import { attachVoiceRelay, relayStatusLine, warmVoiceCache, activeCallCount } from "./voiceRelay.js";
import { flushAllStores, sweepTempFiles } from "./jsonFile.js";
// PII never reaches a log line in the first place — see backend/redact.js.
import * as redact from "./redact.js";

// How long a caller mid-sentence gets before the process goes. Long enough to
// finish a thought, short enough that a deploy is not held hostage by one
// forgotten open tab.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 8000);
import { normalizeLanguage } from "./voiceSarvam.js";
import {
  signIn, signOut, sessionFrom, tokenFromRequest, setSessionCookie, clearSessionCookie,
  requireTeamAuth, teamAuthConfigured, teamAuthStatusLine,
} from "./teamAuth.js";
import { recordCallback, listCallbacks, normalizePhone, callbackOpsMessage } from "./callbacks.js";
import { recordReview, listReviews, reviewSummary, parseRating, isPoorRating, reviewOpsMessage } from "./reviews.js";
import { createAccount, authenticate, resolveSession, endSession, publicAccount, listAccounts, getAccountDetail, mergeProfile } from "./voiceAccounts.js";
import { BRANCHES, DERIVED_BRANCH, coverage, accountIdentityFacts } from "./callSchema.js";
import { extractorStatusLine } from "./callExtract.js";
import { planDocuments } from "./docPlan.js";
import { createRateLimiter } from "./rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ⚠️ WITHOUT THIS, EVERY VISITOR SHARES ONE RATE-LIMIT BUCKET, and it only goes
// wrong once the app is behind a proxy — which is to say, only in production.
//
// Every limiter here keys on `req.ip`. Locally that is the caller. Behind
// Render (or nginx, or an ALB, or CloudFront) the socket's peer is the PROXY,
// so req.ip is the same value for all of them: POST /api/voice/session allows 5
// per 10 minutes, so the fifth call of the hour locks out everyone on the
// internet. Observed on the deployed instance within minutes of the first real
// testing session, presenting as "calls just stopped starting".
//
// `1`, not `true`. `true` trusts the whole X-Forwarded-For chain, which a
// client can prepend to at will and thereby forge an IP and bypass the limiter
// entirely. `1` means "trust exactly one hop", which is Render's proxy and
// nothing else. If another proxy is ever put in front, raise this to match the
// number of hops — do not set it to true.
app.set("trust proxy", 1);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const source = getActiveSource();
const notifier = getActiveNotifier();

// Drop-off detection: how long an in-progress application can go untouched
// before it counts as "stalled" and worth nudging, and how long before nudging
// the same person again.
//
// These were 3 and 5 MINUTES — demo values, so a sweep could be watched working
// inside one sitting. Harmless only because NOTIFY_CHANNEL was mock, which made
// them a loaded gun with the safety on: switching Exotel on without also
// changing these would have sent every paused applicant an SMS *and* a WhatsApp
// every five minutes, and DLT complaints are not a thing you undo.
//
// Now real values, and env-overridable so a demo does not need a code edit —
// which is what made the old arrangement dangerous in the first place.
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS || 24 * 60 * 60 * 1000);
const NUDGE_COOLDOWN_MS = Number(process.env.NUDGE_COOLDOWN_MS || 48 * 60 * 60 * 1000);

// ⚠️ LIVE MESSAGING AND DEMO TIMINGS MUST NOT COEXIST, and a comment saying so
// is what failed last time. Changing the defaults fixes today; this fixes the
// next person who sets STALE_AFTER_MS=180000 for a demo and forgets to put it
// back before switching Exotel on.
//
// Fatal rather than a warning, for the same reason EADDRINUSE is fatal here: a
// warning scrolls past, and the cost of getting this wrong is every paused
// applicant receiving an SMS and a WhatsApp every few minutes, from a DLT-
// registered sender, with no way to recall them.
if (process.env.NOTIFY_CHANNEL && process.env.NOTIFY_CHANNEL !== "mock") {
  const MIN_SAFE_MS = 60 * 60 * 1000; // an hour is already aggressive for a nudge
  if (STALE_AFTER_MS < MIN_SAFE_MS || NUDGE_COOLDOWN_MS < MIN_SAFE_MS) {
    console.error(
      `FATAL: NOTIFY_CHANNEL=${process.env.NOTIFY_CHANNEL} sends real messages, but the reminder ` +
        `timings are still demo-short (stale ${Math.round(STALE_AFTER_MS / 1000)}s, cooldown ` +
        `${Math.round(NUDGE_COOLDOWN_MS / 1000)}s). Every paused applicant would be messaged on that ` +
        `cycle. Raise STALE_AFTER_MS and NUDGE_COOLDOWN_MS to at least an hour, or set NOTIFY_CHANNEL=mock.`
    );
    process.exit(1);
  }
}

function isStale(a) {
  if (a.status !== "in_progress" || !a.updatedAt) return false;
  const idleMs = Date.now() - new Date(a.updatedAt).getTime();
  if (idleMs < STALE_AFTER_MS) return false;
  if (a.lastNudgeAt && Date.now() - new Date(a.lastNudgeAt).getTime() < NUDGE_COOLDOWN_MS) return false;
  return true;
}

async function sendNudge(a) {
  const done = new Set([...(a.onFile || []), ...Object.keys(a.verifiedDocs || {})]).size;
  const msg = nudgeMessage(a.profile, done, a.total || 0);
  await notifier.send(a.profile?.phone || a.leadId, msg);
  await recordNudge(a.leadId);
  await source.pushStatus(a.leadId, { event: "reminder_sent", label: msg });
}

// Background sweep: periodically check for applicants who started but went
// quiet, and nudge them automatically (respecting the cooldown above).
const sweepTimer = setInterval(async () => {
  const apps = await listApplications();
  for (const a of apps) {
    if (isStale(a)) await sendNudge(a);
  }
}, 60 * 1000);

// Safety net: the OCR worker can rethrow image-decode errors asynchronously
// (outside any try/catch). Never let one corrupt upload crash the server.
// EXCEPT a failed port bind — "recovering" that leaves a zombie process with no
// listener whose background sweep keeps rewriting applications.json from a stale
// in-memory copy (this silently resurrected deleted documents once). Fatal.
process.on("uncaughtException", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`FATAL: port already in use — another server instance is running. Exiting.`);
    process.exit(1);
  }
  console.error("[recovered] uncaught:", err.message);
  resetWorker();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded bodies

// Clean URL for the team dashboard: /team instead of /team.html. Registered
// before express.static so it wins over the static file of the same name —
// old bookmarks/links to /team.html still work, just redirected once.
app.get("/team.html", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/team" + qs);
});

// ── Team sign-in ────────────────────────────────────────────────────────────
// Registered BEFORE express.static, so team-login.html is only ever reachable
// through the route below and the guard cannot be walked around by asking for
// the file by name.
app.get("/team/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "team-login.html"));
});
app.get("/team-login.html", (_req, res) => res.redirect(301, "/team/login"));

app.post("/api/team/login", async (req, res) => {
  const result = await signIn({
    email: req.body?.email,
    password: req.body?.password,
    ip: req.ip || req.socket?.remoteAddress || "unknown",
  });
  if (!result.ok) {
    // Logged without the email: a failed attempt is worth seeing, and the thing
    // someone typed into an email box on a failed login is very often a password.
    console.warn("[team] failed sign-in attempt");
    return res.status(401).json({ error: result.error });
  }
  // Secure only behind TLS — setting it on plain http://localhost would make
  // the cookie silently never arrive.
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  setSessionCookie(res, result.token, proto === "https");
  console.log(`[team] signed in (${process.env.TEAM_EMAIL})`);
  res.json({ ok: true });
});

app.post("/api/team/logout", (req, res) => {
  signOut(tokenFromRequest(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/team/me", (req, res) => {
  const session = sessionFrom(tokenFromRequest(req));
  res.json({ configured: teamAuthConfigured(), email: session?.email || null });
});

// Everything an officer can reach. `/api/applications` covers the list, every
// per-lead detail route, the lender drafts and the document files — 16 routes
// that all read or change applicant data, guarded in one place rather than one
// decorator per route, because the failure mode of that pattern is the route
// somebody forgets to decorate.
app.use("/api/applications", requireTeamAuth);
app.use("/api/voice/callbacks", requireTeamAuth);
app.use("/api/voice/accounts", requireTeamAuth);
app.use("/api/voice/reviews", requireTeamAuth);

app.use(express.static(path.join(__dirname, "..", "frontend")));

// Which real-world person a document's identity fields (name/DOB/address) belong
// to — the student, or the co-applicant. Cross-document consistency checks must
// stay within one group: the student's PAN and the co-applicant's Aadhaar belong
// to two DIFFERENT people, so their names are *supposed* to differ — comparing
// across groups would flag a false "mismatch" on every normal application.
function identityGroup(docId) {
  return docId.startsWith("co_") ? "coapplicant" : "student";
}

// There's no lead-source field for the co-applicant's name in this mock model
// (unlike the student's, which comes from the lead) — so for display purposes
// we take it from whichever of their verified documents named them first.
function deriveCoApplicantName(application) {
  for (const [docId, rec] of Object.entries(application.verifiedDocs || {})) {
    if (identityGroup(docId) === "coapplicant" && rec.nameOnDoc) return rec.nameOnDoc;
  }
  return null;
}

// Adjust a document to the specific applicant (e.g. co-applicant income proof).
function adjustForLead(doc, lead) {
  if (doc.id === "co_income_proof" && lead.coApplicantType) {
    if (lead.coApplicantType === "self-employed") {
      return { ...doc, label: "Co-applicant's latest ITR", why: "Your co-applicant is self-employed, so their Income Tax Return is the proof of income. It sets the maximum loan the lender will sanction." };
    }
    return { ...doc, label: "Co-applicant's 3 months' salary slips", why: "Your co-applicant is salaried, so recent salary slips prove their income. This sets the maximum loan the lender will sanction." };
  }
  return doc;
}

// Build this applicant's personalized to-do list from the lead + saved progress.
function buildAgenda(lead, application) {
  // Drop collateral docs for an unsecured loan, and the wrong income set for a
  // known co-applicant category — one rule with the voice agent's doc plan.
  const applicable = applicableDocuments({
    loanType: lead.loanType,
    coApplicantType: lead.coApplicantType,
  });
  // A doc counts as "done" if the lead platform already has it OR we verified it before.
  const onFile = new Set([
    ...(lead.documentsOnFile || []),
    ...Object.keys(application.verifiedDocs || {}),
  ]);

  const stageTitle = (id) => (STAGES.find((s) => s.id === id) || {}).title || "Your documents";
  // Full ordered list, each doc marked done or not — so the applicant can step
  // back to documents already uploaded (in this or a previous session).
  const documents = applicable.map((d) => ({
    ...adjustForLead(d, lead),
    prefill: lead.known?.[d.id] || null,
    stageTitle: stageTitle(d.stage),
    done: onFile.has(d.id),
  }));
  const agenda = documents.filter((d) => !d.done);
  const onFileDocs = applicable.filter((d) => onFile.has(d.id)).map((d) => ({ id: d.id, label: d.label }));

  return { agenda, documents, onFileDocs, total: applicable.length, verified: onFile.size };
}

// Has every *required* document been received (verified by us OR already on
// record at the lead source)? This is the "only when all docs are received" gate.
function applicationComplete(app) {
  const applicable = applicableDocuments({
    loanType: app.profile?.loanType,
    coApplicantType: app.profile?.coApplicantType,
  });
  const have = new Set([...(app.onFile || []), ...Object.keys(app.verifiedDocs || {})]);
  return applicable.filter((d) => d.required).every((d) => have.has(d.id));
}

// Email the completed packet to ops — but only once, and only when complete.
async function emailPacketIfComplete(leadId) {
  const app = await getApplication(leadId);
  if (!applicationComplete(app)) return { emailed: false, reason: "incomplete" };
  if (app.packetEmailedAt) return { emailed: false, reason: "already_sent", to: app.packetEmailedTo };
  const result = await sendDocumentPacket(app);
  await recordPacketEmailed(leadId, result);
  await source.pushStatus(leadId, { event: "packet_emailed", label: `${result.count} document(s) → ${result.to}` });
  return { emailed: true, ...result };
}

// The agent's static catalogue (kept for reference / tooling).
app.get("/api/config", (req, res) => {
  res.json({ stages: STAGES, documents: DOCUMENTS });
});

// Start a session: fetch the lead from the active source and return a personalized agenda.
app.post("/api/session/start", async (req, res) => {
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  if (phone.length < 10) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });

  const lead = await source.getLead(phone);
  const application = await getApplication(lead.leadId);
  const { agenda, documents, onFileDocs, total, verified } = buildAgenda(lead, application);
  // Income verified from an uploaded ITR/salary slip beats the lead source's claim.
  if (application.extractedIncome?.monthlyIncomeInr) {
    lead.coApplicantMonthlyIncome = application.extractedIncome.monthlyIncomeInr;
  }
  // Co-applicant phone read off their bank statement likewise overrides the
  // lead source's claim (there usually isn't one — this is often the first
  // time we actually have their number).
  if (application.coApplicantContact?.phoneNumber) {
    lead.coApplicantPhone = application.coApplicantContact.phoneNumber;
  }
  const eligibility = assessEligibility(lead);
  if (application.extractedIncome?.monthlyIncomeInr) {
    eligibility.incomeNote = `Co-applicant income ₹${application.extractedIncome.monthlyIncomeInr.toLocaleString("en-IN")}/month verified from uploaded ${application.extractedIncome.docType === "itr" ? "ITR" : "salary slip"} (${application.extractedIncome.basis}).`;
  }
  const partnerInstitute = matchInstitute(lead.institute);
  await source.pushStatus(lead.leadId, { event: "agent_session_started" });

  // Snapshot the applicant for the team dashboard.
  await saveProfile(lead.leadId, {
    profile: {
      name: lead.name,
      phone: lead.phone,
      source: lead.source,
      course: lead.course,
      institute: lead.institute,
      loanType: lead.loanType,
      coApplicantType: lead.coApplicantType,
      coApplicantPhone: lead.coApplicantPhone || null,
      coApplicantNameOnFile: deriveCoApplicantName(application),
      partnerInstitute: partnerInstitute ? partnerInstitute.name : null,
    },
    total,
    onFile: onFileDocs.map((d) => d.id),
    eligibility,
  });

  res.json({
    sourceName: source.name,
    lead: {
      leadId: lead.leadId,
      name: lead.name,
      source: lead.source,
      course: lead.course,
      institute: lead.institute,
      loanType: lead.loanType,
    },
    agenda,
    documents,
    onFileDocs,
    total,
    verified,
    eligibility,
    partnerInstitute,
  });
});

// Inbound messaging webhook — works with both Exotel (JSON with a nested
// `whatsapp.messages[]`) and Twilio (form-encoded `From`/`Body`). Point your
// provider's "when a message comes in" setting at POST /webhook/whatsapp.
// We don't run the full document-collection conversation over text — we look
// the applicant up by phone and reply with their live progress + a link back
// to the web assistant to continue there.
app.post("/webhook/whatsapp", async (req, res) => {
  // Exotel posts JSON with a `whatsapp` object; Twilio posts a form `From` field.
  const isExotel = Boolean(req.body?.whatsapp);
  const { phone } = isExotel ? parseExotelInbound(req.body) : parseInboundWebhook(req.body);
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  let reply;
  try {
    const lead = phone ? await source.getLead(phone) : null;
    if (lead) {
      const application = await getApplication(lead.leadId);
      const { total } = buildAgenda(lead, application);
      const done = doneCount(application);
      reply = buildReply(lead.name, done, total, appUrl);
    } else {
      reply = buildReply(null, null, null, appUrl);
    }
  } catch (e) {
    console.error("[whatsapp webhook] error:", e.message);
    reply = `Sorry, something went wrong. Please try ${appUrl} directly.`;
  }
  // Exotel just needs a 200 with the reply; Twilio needs TwiML XML.
  if (isExotel) res.json({ reply });
  else res.type("text/xml").send(twiml(reply));
});

// Read the document image and pull out its identifier (PAN / Aadhaar) for auto-fill.
app.post("/api/extract", upload.single("file"), async (req, res) => {
  const doc = getDocument(req.body.docId);
  if (!doc) return res.status(400).json({ error: "Unknown document id." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  if (!doc.identifier || !isOcrable(req.file.buffer)) return res.json({ found: false });

  // Vision-first read (falls back to OCR inside readCard).
  const card = await readCard(req.file.buffer, doc);
  console.log(`[capture:${card.source}] ${doc.id}: number=${redact.idNumber(card.number)} name="${redact.personName(card.name)}" dob="${redact.dob(card.dob)}"`);
  res.json({ found: !!card.number, value: card.number, name: doc.identifier.name, holderName: card.name, dob: card.dob, source: card.source });
});

// Smart intake box: structure a free-text loan request into a loan intent + follow-ups.
app.post("/api/intake", async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const leadId = req.body?.leadId;
  if (!text) return res.status(400).json({ error: "Please describe what you need." });
  if (!intakeConfigured()) return res.status(503).json({ error: "No language model is configured (set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY)." });
  try {
    const result = await structureIntent(text);
    if (!result) return res.status(502).json({ error: "Couldn't understand that just now — please try rephrasing." });
    console.log(`[intake:${result.source}] "${text.slice(0, 60)}" → amount=${result.intent.amountInr || "-"} country=${result.intent.country || "-"}`);
    // Record the captured context on the lead's timeline so the officer view sees it too.
    if (leadId && result.summary) {
      try { await source.pushStatus(leadId, { event: "intake_captured", label: result.summary }); } catch {}
    }
    res.json(result);
  } catch (e) {
    console.error("[intake] failed:", e.message);
    res.status(500).json({ error: "Something went wrong processing that." });
  }
});

// Upload a document -> cross-check format -> on success, persist + write status back.
app.post("/api/validate", upload.single("file"), async (req, res) => {
  const doc = getDocument(req.body.docId);
  if (!doc) return res.status(400).json({ error: "Unknown document id." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });

  const report = validateUpload(doc, req.file, req.body.identifier);
  const leadId = req.body.leadId;

  // Read the card once (vision-first, OCR fallback) — reused for the number
  // match, name and DOB.
  let card = null;

  // Content cross-check: confirm the typed number actually appears on the card.
  // Skipped for PDFs / unreadable images (no identifier to compare against).
  if (doc.identifier && report.accurate && isOcrable(req.file.buffer)) {
    card = await readCard(req.file.buffer, doc);
    const typed = (req.body.identifier || "").trim().toUpperCase().replace(/\s/g, "");
    if (card.number) {
      const match = card.number === typed;
      // Hard-block a mismatch only on a confident (exact) read — a fuzzy OCR
      // read might be wrong, so we trust the applicant who can see their card.
      if (match) {
        report.checks.push({
          name: "Number matches the document",
          passed: true,
          detail: `The ${doc.identifier.name} you entered is the same one printed on the document.`,
        });
        report.total += 1;
        report.passedCount += 1;
      } else if (card.exact) {
        report.checks.push({
          name: "Number matches the document",
          passed: false,
          detail: `The document clearly shows "${card.number}" but you entered "${typed}". Please check.`,
        });
        report.total += 1;
        report.accurate = false;
      }
      report.score = Math.round((report.passedCount / report.total) * 100);
    }
  }

  if (report.accurate && leadId) {
    const application = await getApplication(leadId);
    const extra = {};

    // Identity fields (name / DOB / address) for THIS document, gathered from
    // whichever reader ran on it — the card reader for PAN/Aadhaar, or one of
    // the content readers below for income proof / bank statement. Unified so
    // the same matching + cross-document logic (further down) applies no
    // matter which reader produced it.
    let identity = card ? { name: card.name, dob: card.dob, address: card.address, source: `capture:${card.source}` } : null;

    // Income proof: read the income off the ITR / salary slip (ITR annual ÷ 12,
    // salary slip monthly as-is) and re-run eligibility with the verified figure.
    if (doc.id === "co_income_proof") {
      const income = await extractIncome(req.file.buffer);
      if (income) {
        extra.incomeOnDoc = income;
        identity = { name: income.holderName, dob: null, address: income.address, source: `income:${income.source}` };
        report.checks.push({
          name: "Income read from document",
          passed: true,
          detail: `₹${income.monthlyIncomeInr.toLocaleString("en-IN")}/month (${income.basis})${income.period ? ` · ${income.period}` : ""}`,
        });
        report.total += 1;
        report.passedCount += 1;
        report.score = Math.round((report.passedCount / report.total) * 100);
        await saveExtractedIncome(leadId, income);
        if (application.profile?.phone) {
          const freshLead = await source.getLead(application.profile.phone);
          freshLead.coApplicantMonthlyIncome = income.monthlyIncomeInr;
          const elig = assessEligibility(freshLead);
          elig.incomeNote = `Co-applicant income ₹${income.monthlyIncomeInr.toLocaleString("en-IN")}/month verified from uploaded ${income.docType === "itr" ? "ITR" : "salary slip"} (${income.basis}).`;
          await saveProfile(leadId, { profile: application.profile, total: application.total, onFile: application.onFile, eligibility: elig });
        }
        await source.pushStatus(leadId, {
          event: "income_extracted",
          label: `₹${income.monthlyIncomeInr.toLocaleString("en-IN")}/month — ${income.basis}${income.holderName ? ` · name on document: ${income.holderName}` : ""}`,
        });
        console.log(`[income:${income.source}] ${leadId}: ₹${income.monthlyIncomeInr}/mo (${income.docType})`);
      } else {
        console.log(`[income] ${leadId}: couldn't read income off the document — keeping lead-source figure`);
      }
    }

    // Bank statement: read the co-applicant's name / address / registered phone
    // off it. The phone becomes the co-applicant's contact number (same
    // persist-and-override pattern as the income figure above); name/address
    // feed the same cross-document consistency check as every other document.
    if (doc.id === "co_bank_statement") {
      const bank = await extractBankStatement(req.file.buffer);
      if (bank) {
        extra.bankInfoOnDoc = bank;
        identity = { name: bank.accountHolderName, dob: null, address: bank.address, source: `bankstatement:${bank.source}` };
        if (bank.phoneNumber) {
          report.checks.push({
            name: "Contact details read from statement",
            passed: true,
            detail: `Registered mobile ${bank.phoneNumber}${bank.accountHolderName ? ` — account holder: ${bank.accountHolderName}` : ""}`,
          });
          report.total += 1;
          report.passedCount += 1;
          report.score = Math.round((report.passedCount / report.total) * 100);
          await saveCoApplicantContact(leadId, bank);
          await source.pushStatus(leadId, {
            event: "coapplicant_contact_extracted",
            label: `Co-applicant phone ${bank.phoneNumber} read from bank statement${bank.accountHolderName ? ` · name on document: ${bank.accountHolderName}` : ""}`,
          });
        }
        console.log(`[bankstatement:${bank.source}] ${leadId}: name="${redact.personName(bank.accountHolderName)}" phone="${redact.phone(bank.phoneNumber)}"`);
      } else {
        console.log(`[bankstatement] ${leadId}: couldn't read identity details off the statement`);
      }
    }

    // Apply whatever identity we gathered above: fill a blank student profile
    // from the first document that names them (no equivalent ground-truth name
    // exists for the co-applicant in this lead model, so that part only applies
    // to student docs), flag a mismatch, and cross-check name/DOB/address
    // against every OTHER document already verified for the SAME person —
    // scoped by identityGroup() so the student's docs are never compared
    // against the co-applicant's (they're different people; that's expected).
    if (identity && (identity.name || identity.dob || identity.address)) {
      const { name: nameOnDoc, dob: dobOnDoc, address: addressOnDoc } = identity;
      if (nameOnDoc) extra.nameOnDoc = nameOnDoc;
      if (dobOnDoc) extra.dobOnDoc = dobOnDoc;
      if (addressOnDoc) extra.addressOnDoc = addressOnDoc;

      const group = identityGroup(doc.id);
      if (group === "student") {
        const expectedName = application.profile?.name;
        if (nameOnDoc && expectedName) {
          extra.nameMatch = namesMatch(expectedName, nameOnDoc); // true / false / null
        } else if (nameOnDoc && !expectedName) {
          // No name from the lead source — take it from the document itself.
          await saveProfile(leadId, {
            profile: { ...(application.profile || {}), name: nameOnDoc, nameSource: "document" },
            total: application.total,
            onFile: application.onFile,
          });
        }
      }

      const conflicts = [];
      for (const [otherId, otherRec] of Object.entries(application.verifiedDocs || {})) {
        if (otherId === doc.id) continue;
        if (identityGroup(otherId) !== group) continue; // different person — not comparable
        if (nameOnDoc && otherRec.nameOnDoc && namesMatch(nameOnDoc, otherRec.nameOnDoc) === false) {
          conflicts.push({ withDocId: otherId, field: "name", thisValue: nameOnDoc, otherValue: otherRec.nameOnDoc });
        }
        if (dobOnDoc && otherRec.dobOnDoc && dobOnDoc !== otherRec.dobOnDoc) {
          conflicts.push({ withDocId: otherId, field: "date of birth", thisValue: dobOnDoc, otherValue: otherRec.dobOnDoc });
        }
        if (addressOnDoc && otherRec.addressOnDoc && addressesMatch(addressOnDoc, otherRec.addressOnDoc) === false) {
          conflicts.push({ withDocId: otherId, field: "address", thisValue: addressOnDoc, otherValue: otherRec.addressOnDoc });
        }
      }
      if (conflicts.length) extra.crossDocConflicts = conflicts;

      console.log(`[identity:${identity.source}] ${doc.id} (${group}): name="${redact.personName(nameOnDoc)}" dob="${redact.dob(dobOnDoc)}" address="${redact.address(addressOnDoc)}" match=${extra.nameMatch ?? "-"} conflicts=${conflicts.length}`);
    }

    const saved = await saveFile(leadId, doc.id, req.file);
    await markVerified(leadId, doc.id, {
      filename: saved.originalname,
      storedName: saved.storedName,
      mimetype: saved.mimetype,
      score: report.score,
      ...extra,
    });
    await source.pushStatus(leadId, { event: "document_verified", docId: doc.id, label: doc.label });
    if (extra.nameMatch === false) {
      await source.pushStatus(leadId, {
        event: "name_mismatch",
        docId: doc.id,
        label: `Card says "${extra.nameOnDoc}", lead says "${application.profile.name}"`,
      });
    }
    if (extra.crossDocConflicts?.length) {
      for (const c of extra.crossDocConflicts) {
        await source.pushStatus(leadId, {
          event: "cross_document_mismatch",
          docId: doc.id,
          label: `${doc.label} shows ${c.field} "${c.thisValue}" but ${(getDocument(c.withDocId) || {}).label || c.withDocId} shows "${c.otherValue}"`,
        });
      }
    }
  }

  res.json({ docId: doc.id, label: doc.label, filename: req.file.originalname, ...report });
});

// Mark the application complete (all documents collected).
app.post("/api/session/complete", async (req, res) => {
  const leadId = req.body.leadId;
  let mail = null;
  if (leadId) {
    await setStatus(leadId, "documents_complete");
    await source.pushStatus(leadId, { event: "all_documents_collected" });
    // Auto-email the full packet to ops now that everything is in.
    mail = await emailPacketIfComplete(leadId);
  }
  res.json({ ok: true, mail });
});

// Officer view: what has been written back to the lead source for this applicant.
app.get("/api/lead/:leadId/timeline", async (req, res) => {
  const timeline = source.getTimeline ? await source.getTimeline(req.params.leadId) : [];
  const application = await getApplication(req.params.leadId);
  res.json({ timeline, application });
});

// ---- UPSY team dashboard ----

function doneCount(a) {
  return new Set([...(a.onFile || []), ...Object.keys(a.verifiedDocs || {})]).size;
}

// For the dashboard: has this applicant gone quiet mid-application? (Doesn't
// factor in the nudge cooldown — that only throttles the auto-send, the
// officer should still see the "stalled" chip regardless.)
function isIdle(a) {
  return a.status === "in_progress" && a.updatedAt && Date.now() - new Date(a.updatedAt).getTime() >= STALE_AFTER_MS;
}

// List every application for the team dashboard.
app.get("/api/applications", async (req, res) => {
  const apps = await listApplications();
  const list = apps
    .map((a) => ({
      leadId: a.leadId,
      profile: a.profile || {},
      total: a.total ?? null,
      done: doneCount(a),
      status: a.status,
      eligible: a.eligibility?.eligible ?? null,
      stale: isIdle(a),
      nudgeCount: a.nudgeCount || 0,
      updatedAt: a.updatedAt || null,
    }))
    .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  res.json(list);
});

// Full detail for one applicant: per-document status + activity timeline.
app.get("/api/applications/:leadId", async (req, res) => {
  const app_ = await getApplication(req.params.leadId);
  const loanType = app_.profile?.loanType;
  const applicable = DOCUMENTS.filter((d) => !(loanType === "unsecured" && d.stage === "collateral"));
  const onFile = new Set(app_.onFile || []);

  const documents = applicable.map((d) => {
    const v = app_.verifiedDocs?.[d.id];
    const reupload = app_.reuploadRequested?.[d.id];
    let status = "pending";
    if (v) status = "verified";
    else if (reupload) status = "reupload";
    else if (onFile.has(d.id)) status = "on_file";
    return {
      id: d.id,
      label: d.label,
      stage: (STAGES.find((s) => s.id === d.stage) || {}).title || d.stage,
      required: d.required,
      status,
      filename: v?.filename || null,
      score: v?.score ?? null,
      at: v?.at || null,
      reuploadNote: reupload?.note || null,
      nameOnDoc: v?.nameOnDoc || null,
      dobOnDoc: v?.dobOnDoc || null,
      addressOnDoc: v?.addressOnDoc || null,
      incomeOnDoc: v?.incomeOnDoc || null,
      bankInfoOnDoc: v?.bankInfoOnDoc || null,
      nameMatch: v?.nameMatch ?? null,
      crossDocConflicts: v?.crossDocConflicts || null,
      fileUrl: v?.storedName ? `/api/applications/${app_.leadId}/documents/${d.id}/file` : null,
    };
  });

  // Surface any name that didn't match the lead record as a prominent flag.
  const flags = Object.entries(app_.verifiedDocs || {})
    .filter(([, v]) => v.nameMatch === false)
    .map(([docId, v]) => ({
      type: "lead_mismatch",
      docId,
      label: (getDocument(docId) || {}).label || docId,
      nameOnDoc: v.nameOnDoc,
      expected: app_.profile?.name || null,
    }));

  // Surface conflicts between two of the applicant's OWN documents (e.g. PAN
  // says one name/DOB, Aadhaar says another) — a stronger fraud/error signal
  // than a mismatch with the lead record alone.
  const seenPairs = new Set();
  for (const [docId, v] of Object.entries(app_.verifiedDocs || {})) {
    for (const c of v.crossDocConflicts || []) {
      const pairKey = [docId, c.withDocId, c.field].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      flags.push({
        type: "cross_document",
        docId,
        label: (getDocument(docId) || {}).label || docId,
        withDocId: c.withDocId,
        withLabel: (getDocument(c.withDocId) || {}).label || c.withDocId,
        field: c.field,
        thisValue: c.thisValue,
        otherValue: c.otherValue,
      });
    }
  }

  const timeline = source.getTimeline ? await source.getTimeline(req.params.leadId) : [];
  const lenderDrafts = Object.entries(app_.lenderDrafts || {}).map(([lenderId, v]) => ({
    lenderId, lenderName: v.lenderName, subject: v.subject, to: v.to,
    draftedAt: v.draftedAt, sharedAt: v.sharedAt || null, sharedVia: v.sharedVia || null,
  }));
  res.json({
    leadId: app_.leadId,
    partnerInstitute: matchInstitute(app_.profile?.institute),
    lenderDrafts,
    profile: app_.profile || {},
    status: app_.status,
    decisionNote: app_.decisionNote || null,
    total: applicable.length,
    done: doneCount(app_),
    documents,
    flags,
    coApplicantContact: app_.coApplicantContact || null,
    coApplicantNameOnFile: deriveCoApplicantName(app_),
    eligibility: app_.eligibility || null,
    stale: isIdle(app_),
    nudgeCount: app_.nudgeCount || 0,
    lastNudgeAt: app_.lastNudgeAt || null,
    complete: applicationComplete(app_),
    packetEmailedAt: app_.packetEmailedAt || null,
    packetEmailedTo: app_.packetEmailedTo || opsEmail(),
    timeline,
  });
});

// Officer manually sends a reminder right now (bypasses the auto-nudge cooldown).
app.post("/api/applications/:leadId/nudge", async (req, res) => {
  const a = await getApplication(req.params.leadId);
  await sendNudge(a);
  res.json({ ok: true, sentTo: a.profile?.phone || a.leadId });
});

// ---- Live-assist: an AI voice agent (Nova/UPSY, via AgentCall) joins a real
// meeting with the applicant and helps them fill out a lender's form live.
// See backend/liveAssistManager.js — one call at a time across the server.
app.get("/api/applications/:leadId/live-assist", (req, res) => {
  res.json(getLiveAssistStatus(req.params.leadId));
});

app.post("/api/applications/:leadId/live-assist", async (req, res) => {
  try {
    // notifyApplicant is set by the team dashboard (officer-initiated); the
    // applicant's own pages omit it — they already have the meeting open.
    const result = await startLiveAssist(req.params.leadId, req.body?.meetUrl, {
      notifyApplicant: Boolean(req.body?.notifyApplicant),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/applications/:leadId/live-assist/stop", async (req, res) => {
  try {
    const result = await stopLiveAssist(req.params.leadId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Officer manually (re)sends the completed document packet by email.
app.post("/api/applications/:leadId/email-packet", async (req, res) => {
  const app = await getApplication(req.params.leadId);
  if (!applicationComplete(app)) {
    return res.status(400).json({ error: "Not all required documents are in yet." });
  }
  const result = await sendDocumentPacket(app);
  await recordPacketEmailed(req.params.leadId, result);
  await source.pushStatus(req.params.leadId, { event: "packet_emailed", label: `${result.count} document(s) → ${result.to}` });
  res.json({ ok: true, ...result });
});

// ---- Partner lenders: match, draft a referral email, export to Outlook, share ----

// The freshest underwriting facts live at the lead source (academic %, income,
// citizenship) — re-fetch the lead so the matcher sees them, not just the
// dashboard snapshot.
async function lenderContext(leadId) {
  const app = await getApplication(leadId);
  const lead = app.profile?.phone ? await source.getLead(app.profile.phone) : null;
  const partner = matchInstitute(app.profile?.institute);
  return { app, lead, partner };
}

// Eligible lenders for one applicant, with any existing draft state merged in.
app.get("/api/applications/:leadId/lenders", async (req, res) => {
  const { app: app_, lead, partner } = await lenderContext(req.params.leadId);
  const lenders = matchLenders(lead, app_.eligibility).map((l) => {
    const d = app_.lenderDrafts?.[l.id];
    return {
      ...l,
      draft: d
        ? { subject: d.subject, body: d.body, to: d.to, draftedAt: d.draftedAt, sharedAt: d.sharedAt || null, sharedVia: d.sharedVia || null, attachmentsCount: d.attachmentsCount ?? 0 }
        : null,
    };
  });
  res.json({ partnerInstitute: partner, lenders });
});

// Generate (or regenerate) the lender-specific referral draft.
app.post("/api/applications/:leadId/lenders/:lenderId/draft", async (req, res) => {
  const lender = getLender(req.params.lenderId);
  if (!lender) return res.status(400).json({ error: "Unknown lender." });
  const { app: app_, lead, partner } = await lenderContext(req.params.leadId);

  const draft = await generateLenderDraft(lender, app_, lead, partner);
  const attachments = Object.values(app_.verifiedDocs || {}).filter((v) => v.storedName);
  const saved = await saveLenderDraft(req.params.leadId, lender.id, {
    lenderName: lender.name,
    to: lender.email,
    subject: draft.subject,
    body: draft.body,
    source: draft.source,
    draftedAt: new Date().toISOString(),
    attachmentsCount: attachments.length,
    sharedAt: null,
    sharedVia: null,
  });
  await source.pushStatus(req.params.leadId, {
    event: "lender_draft_created",
    lender: lender.name,
    label: `${lender.name} — "${draft.subject}" · ${attachments.length} document(s) to attach · drafted via ${draft.source}`,
  });
  console.log(`[lender-draft:${draft.source}] ${req.params.leadId} → ${lender.name}`);
  res.json({ ok: true, lenderId: lender.id, draft: saved });
});

// Officer edited the subject/body — persist so the .eml export matches the screen.
app.put("/api/applications/:leadId/lenders/:lenderId/draft", async (req, res) => {
  const lender = getLender(req.params.lenderId);
  if (!lender) return res.status(400).json({ error: "Unknown lender." });
  const app_ = await getApplication(req.params.leadId);
  if (!app_.lenderDrafts?.[lender.id]) return res.status(404).json({ error: "No draft yet — generate one first." });
  const subject = (req.body?.subject || "").toString().trim();
  const body = (req.body?.body || "").toString();
  if (!subject || !body.trim()) return res.status(400).json({ error: "Subject and body can't be empty." });
  const saved = await saveLenderDraft(req.params.leadId, lender.id, { subject, body, editedAt: new Date().toISOString() });
  res.json({ ok: true, draft: saved });
});

// Download the draft as a .eml — opens as an editable unsent message in Outlook,
// with every verified document attached.
app.get("/api/applications/:leadId/lenders/:lenderId/draft.eml", async (req, res) => {
  const lender = getLender(req.params.lenderId);
  if (!lender) return res.status(400).json({ error: "Unknown lender." });
  const app_ = await getApplication(req.params.leadId);
  const d = app_.lenderDrafts?.[lender.id];
  if (!d) return res.status(404).json({ error: "No draft yet — generate one first." });

  const attachments = Object.values(app_.verifiedDocs || {}).filter((v) => v.storedName);
  const eml = await buildEml({ to: d.to || lender.email, subject: d.subject, body: d.body, attachments });
  const fname = `UPSY - ${(app_.profile?.name || app_.leadId).replace(/[^a-zA-Z0-9 _-]/g, "")} - ${lender.name}.eml`;
  res.setHeader("Content-Type", "message/rfc822");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(eml);
});

// Officer confirms the email went out to the lender — logged with full detail
// (when, to whom, what was attached) on the activity timeline.
app.post("/api/applications/:leadId/lenders/:lenderId/share", async (req, res) => {
  const lender = getLender(req.params.lenderId);
  if (!lender) return res.status(400).json({ error: "Unknown lender." });
  const app_ = await getApplication(req.params.leadId);
  const d = app_.lenderDrafts?.[lender.id];
  if (!d) return res.status(404).json({ error: "No draft to share — generate one first." });

  const via = (req.body?.via || "outlook").toString();
  const shared = await recordLenderShared(req.params.leadId, lender.id, { via });
  const attachedDocs = Object.keys(app_.verifiedDocs || {}).map((id) => (getDocument(id) || {}).label || id);
  await source.pushStatus(req.params.leadId, {
    event: "lender_email_shared",
    lender: lender.name,
    label: `${lender.name} (${d.to || lender.email}) — "${d.subject}" · via ${via === "outlook" ? "Outlook" : via} · attached: ${attachedDocs.length ? attachedDocs.join(", ") : "no documents"}`,
  });
  res.json({ ok: true, draft: shared });
});

// Officer decision on the whole application: approve or reject.
app.post("/api/applications/:leadId/decision", async (req, res) => {
  const { action, note } = req.body;
  const map = { approve: "approved", reject: "rejected" };
  if (!map[action]) return res.status(400).json({ error: "Unknown decision." });
  await setStatus(req.params.leadId, map[action], note || "");
  await source.pushStatus(req.params.leadId, { event: action === "approve" ? "application_approved" : "application_rejected", label: note || undefined });
  res.json({ ok: true, status: map[action] });
});

// Officer asks the applicant to re-upload one document.
app.post("/api/applications/:leadId/documents/:docId/request-reupload", async (req, res) => {
  const doc = getDocument(req.params.docId);
  await requestReupload(req.params.leadId, req.params.docId, req.body.note || "");
  await source.pushStatus(req.params.leadId, { event: "reupload_requested", docId: req.params.docId, label: doc?.label });
  res.json({ ok: true });
});

// Applicant deletes their uploaded document (via the preview's delete icon).
// The stored file is removed and the document goes back into their to-do list.
app.delete("/api/applications/:leadId/documents/:docId", async (req, res) => {
  const doc = getDocument(req.params.docId);
  if (!doc) return res.status(400).json({ error: "Unknown document id." });
  const rec = await removeVerified(req.params.leadId, req.params.docId);
  if (!rec) return res.status(404).json({ error: "Nothing uploaded for this document." });
  if (rec.storedName) { try { await fs.unlink(filePath(rec.storedName)); } catch {} }
  await source.pushStatus(req.params.leadId, { event: "document_deleted", docId: doc.id, label: doc.label });
  res.json({ ok: true });
});

// Serve a stored document file to the team (opens inline in the browser).
app.get("/api/applications/:leadId/documents/:docId/file", async (req, res) => {
  const app_ = await getApplication(req.params.leadId);
  const rec = app_.verifiedDocs?.[req.params.docId];
  if (!rec || !rec.storedName) return res.status(404).json({ error: "File not found." });
  // The record can outlive the file (e.g. cloud-sync removed it from data/uploads)
  // — answer with a clean 404 instead of a 500 from sendFile.
  try { await fs.access(filePath(rec.storedName)); }
  catch {
    console.warn(`[files] missing on disk: ${rec.storedName} (record still marked verified)`);
    return res.status(404).json({ error: "The stored file is no longer available." });
  }
  res.type(rec.mimetype || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${rec.filename || rec.storedName}"`);
  res.sendFile(filePath(rec.storedName));
});

// Backstop: turn upload errors (e.g. a file over the hard cap) into a clean
// JSON message the UI can show, instead of a generic HTML 500.
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "That file is too large to upload. Please attach a smaller file." });
  }
  console.error("[error]", err?.message);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

// Document helper: answer applicant questions about the doc they're uploading
// ("why is this required?", "why was mine not accepted?").
app.post("/api/assist", async (req, res) => {
  const doc = getDocument(req.body?.docId);
  const question = (req.body?.question || "").toString().trim().slice(0, 500);
  if (!doc) return res.status(400).json({ error: "Unknown document id." });
  if (!question) return res.status(400).json({ error: "Ask a question first." });
  if (!assistConfigured()) return res.status(503).json({ error: "The helper isn't configured yet (set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY)." });
  try {
    const result = await answerDocQuestion({
      doc,
      question,
      failedChecks: Array.isArray(req.body?.failedChecks) ? req.body.failedChecks.slice(0, 8) : [],
      intakeSummary: (req.body?.intakeSummary || "").toString().slice(0, 300),
    });
    if (!result) return res.status(502).json({ error: "The helper is unavailable right now — please try again." });
    console.log(`[assist:${result.source}] ${doc.id}: "${question.slice(0, 60)}"`);
    res.json(result);
  } catch (e) {
    console.error("[assist] failed:", e.message);
    res.status(500).json({ error: "Something went wrong answering that." });
  }
});

// ── /m accounts ─────────────────────────────────────────────────────────────
// The mobile surface has its own sign-in, separate from the phone-number lookup
// behind /login — see the header of backend/voiceAccounts.js for why. This is
// the only place in the repo that handles a password, so the rules are narrow
// and worth stating: the plaintext never leaves the request handler, never
// reaches a log line, and never gets stored; only publicAccount() shapes ever
// go back out.

// Deliberately tighter than the voice limiter and shared between signup and
// login, so a script cannot walk mobile numbers against a password list. Ten
// attempts is generous for someone genuinely mistyping their own password.
const accountLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });

function bearerToken(req) {
  const header = String(req.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// Resolve the caller's account, or null. Never throws — an expired or forged
// token is an anonymous caller, not an error, because every /m surface has a
// working anonymous path already.
async function accountFromRequest(req) {
  try {
    return await resolveSession(bearerToken(req));
  } catch (e) {
    console.error("[m:auth] session lookup failed:", e.message);
    return null;
  }
}

app.post("/api/voice/signup", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (accountLimiter.check(ip)) {
    return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  }
  try {
    const { token, account } = await createAccount({
      name: req.body?.name,
      // Normalized here rather than in the store, so signup and login agree on
      // what "the same number" means and a +91 prefix cannot create a second
      // account for someone who already has one.
      phone: normalizePhone(req.body?.phone),
      password: req.body?.password,
    });
    // The name they just typed IS the applicant's name, so seed the branch
    // profile with it. Otherwise the first call greets them by name and then
    // asks what their name is — which is what happened on the first real call,
    // three times, because a name is also the hardest thing for speech
    // recognition to get right.
    await mergeProfile(account.accountId, accountIdentityFacts(account)).catch((e) =>
      console.error("[m:auth] could not seed the profile:", e.message)
    );
    // accountId only. The name and number are on the record already; putting
    // them in the log too would widen the plaintext-PII gap flagged in Phase 2
    // for no operational gain.
    console.log(`[m:auth] account created (${account.accountId})`);
    res.status(201).json({ token, account });
  } catch (e) {
    if (e.code === "INVALID") return res.status(400).json({ error: e.message });
    if (e.code === "TAKEN") return res.status(409).json({ error: e.message });
    console.error("[m:auth] signup failed:", e.message);
    res.status(500).json({ error: "We couldn't create your account just now. Please try again." });
  }
});

app.post("/api/voice/login", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (accountLimiter.check(ip)) {
    return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  }
  try {
    const { token, account } = await authenticate({
      phone: normalizePhone(req.body?.phone),
      password: req.body?.password,
    });
    console.log(`[m:auth] signed in (${account.accountId})`);
    res.json({ token, account });
  } catch (e) {
    // 401 for bad credentials, and the message is the store's deliberately
    // ambiguous one — see authenticate().
    if (e.code === "BAD_CREDENTIALS") return res.status(401).json({ error: e.message });
    console.error("[m:auth] login failed:", e.message);
    res.status(500).json({ error: "We couldn't sign you in just now. Please try again." });
  }
});

app.post("/api/voice/logout", async (req, res) => {
  await endSession(bearerToken(req));
  res.status(204).end();
});

// Who am I? The page calls this on load with whatever token it kept, so a
// returning caller lands on the brief rather than on a password prompt.
app.get("/api/voice/me", async (req, res) => {
  const account = await accountFromRequest(req);
  if (!account) return res.status(401).json({ error: "Not signed in." });
  res.json({ account: publicAccount(account) });
});

// The officer-facing side: every voice caller, and one caller's full history.
//
// `coverage` is computed here rather than in the browser so that the agenda the
// agent works from and the gaps the dashboard reports are the same computation
// over the same schema. A dashboard that invents its own idea of "complete"
// eventually shows a field as missing that nothing was ever going to ask for.
app.get("/api/voice/accounts", async (_req, res) => {
  const accounts = (await listAccounts()).map((a) => ({ ...a, coverage: coverage(a.profile || {}) }));
  res.json({ accounts });
});

app.get("/api/voice/accounts/:accountId", async (req, res) => {
  const detail = await getAccountDetail(req.params.accountId);
  if (!detail) return res.status(404).json({ error: "No such account." });
  res.json({
    account: {
      ...detail,
      coverage: coverage(detail.profile || {}),
      // The join with the doc collection agent: which requests this
      // conversation has actually narrowed the catalogue down to, which it has
      // ruled out, and which question would settle the rest.
      documentPlan: planDocuments(detail.profile || {}),
    },
  });
});

// The branch schema itself, so the dashboard renders a caller's file under the
// same field labels, in the same order, that the agent was told to collect in.
// Static and public: it describes the questions, never anybody's answers.
app.get("/api/voice/schema", (_req, res) => {
  res.json({
    branches: BRANCHES.map((b) => ({
      id: b.id,
      title: b.title,
      blurb: b.blurb,
      fields: b.fields.map((f) => ({
        id: f.id,
        label: f.label,
        type: f.type,
        unit: f.unit || null,
        source: f.source,
        options: f.options || null,
        note: f.note || null,
      })),
    })),
    derived: DERIVED_BRANCH,
  });
});

// ── Browser voice calls (mobile surface) ────────────────────────────────────
// Mints a short-lived credential so the caller's phone can open a voice socket
// directly to the provider. Unlike live-assist there is no meeting, no child
// process and no global one-call lock — see backend/voiceCall.js.

// Five calls per 10 minutes per device. A real caller starting over after a
// dropped connection stays well inside this; a script does not.
const voiceLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });

/**
 * What this deployment can actually do, per language.
 *
 * Added because answering "is Sarvam configured on Render?" otherwise meant
 * starting a real call — which costs money, and which the rate limiter refuses
 * once anyone has been testing, so the one moment you most need the answer is
 * the moment you cannot get it. The boot log has always said this; nobody
 * looking at a deployed instance from outside can read the boot log.
 *
 * ⚠️ BOOLEANS AND PROVIDER NAMES ONLY. No key, no prefix of a key, no length of
 * a key. "Which languages work" is not sensitive; anything that narrows a
 * credential is. Keep it that way if this grows.
 */
app.get("/api/voice/status", (_req, res) => {
  const languages = {};
  for (const lang of ["en", "hi", "mr", "te", "ta", "kn", "ml", "bn", "gu", "pa", "od", "auto"]) {
    const problem = voiceConfigError(lang);
    languages[lang] = problem ? { ready: false, reason: problem } : { ready: true };
  }
  res.json({
    // Which commit is actually serving this request. Render sets
    // RENDER_GIT_COMMIT on every build, and without it "is my fix live yet?" is
    // unanswerable from outside for any change that does not add a route —
    // which is most of them. That question came up on every single deploy of
    // the multilingual work, and each time the honest answer was "I cannot
    // tell", which is a poor way to debug a live call.
    build: (process.env.RENDER_GIT_COMMIT || "local").slice(0, 7),
    provider: voiceProvider(),
    relay: relayStatusLine("en"),
    relayNonEnglish: relayStatusLine("hi"),
    // The turn-taking number, because it is the one people tune by hand on the
    // dashboard and then cannot confirm took effect.
    endOfTurnSilenceMs: Number(process.env.SARVAM_SILENCE_MS || 800),
    languages,
  });
});

app.post("/api/voice/session", async (req, res) => {
  if (!voiceConfigured()) {
    return res.status(503).json({ error: voiceConfigError() });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (voiceLimiter.check(ip)) {
    return res.status(429).json({ error: "Too many calls started from this device. Please wait a few minutes and try again." });
  }
  try {
    const leadId = req.body?.leadId ? String(req.body.leadId).slice(0, 64) : null;
    // Two independent ways to be known on this call, and they do not conflict:
    // an /m account (a token in the Authorization header) and a lead id from a
    // /login session in the same tab. The account is read from the token rather
    // than the body on purpose — a caller must not be able to name someone
    // else's account and be told their facts.
    const account = await accountFromRequest(req);
    // Our own relay needs to hand the browser a URL back to this server, and
    // only the request knows what this server is reachable as — behind Render's
    // proxy the protocol is in x-forwarded-proto, not req.protocol.
    const proto = req.get("x-forwarded-proto") || req.protocol || "http";
    const session = await createVoiceSession({
      leadId,
      // Shaped, not raw. The prompt builder and the relay ticket have no use for
      // a password hash, and the surest way to keep one out of a system prompt
      // is for it never to be in the object that builds it.
      account: publicAccount(account),
      origin: `${proto}://${req.get("host")}`,
      // Anything Sarvam can carry, plus "auto" to let the recogniser decide from
      // the caller's first words. Normalised rather than compared, so "hi-IN",
      // "HI" and "hi" all land in the same place — the value arrives from a
      // browser and eventually from an institute's own link, and neither is
      // going to be careful about case.
      //
      // Unknown values fall back to English rather than erroring: a caller whose
      // page sent a typo should get a call in English, not no call.
      language: normalizeLanguage(req.body?.language),
    });
    const who = session.caller.known
      ? `lead ${leadId}`
      : account
        ? `account ${account.accountId}`
        : "anonymous";
    console.log(`[voice] session started (${who})`);
    // Best-effort timeline entry: a call that isn't recorded on the lead is
    // still a call worth having, so never fail the session over this.
    if (leadId && session.caller.known) {
      source
        .pushStatus(leadId, { event: "voice_call_started", label: "Applicant started a voice call with UPSY from their phone" })
        .catch((e) => console.error("[voice] timeline write failed:", e.message));
    }
    res.json(session);
  } catch (e) {
    if (e.code === "NOT_CONFIGURED") return res.status(503).json({ error: e.message });
    // The agent exists but was never deployed. Worth its own branch: the fix is
    // one button in the Cartesia dashboard, and without this the caller only
    // ever sees an opaque 1011 close after the socket opens.
    if (e.code === "AGENT_NOT_READY") {
      console.error(`[voice] ${e.message}`);
      return res.status(503).json({ error: "UPSY's voice line isn't switched on yet. Please try the chat, or check back shortly.", detail: e.message });
    }
    console.error("[voice] session failed:", e.message);
    res.status(502).json({ error: "Couldn't start the call right now. Please try again in a moment." });
  }
});

// "Schedule call" on /m — the other half of the call button, for someone who
// would rather be phoned back. Rate-limited like the session endpoint, but more
// generously: this one costs us nothing per hit, it just needs to not become a
// spam inbox.
const callbackLimiter = createRateLimiter({ limit: 5, windowMs: 30 * 60 * 1000 });

app.post("/api/voice/callback", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (callbackLimiter.check(ip)) {
    return res.status(429).json({ error: "That's a few requests already — we'll be in touch about the ones you've sent." });
  }

  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: "Please enter a 10-digit Indian mobile number we can call you on." });
  }
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Please tell us your name." });

  try {
    const leadId = req.body?.leadId ? String(req.body.leadId).slice(0, 64) : null;
    const entry = await recordCallback({
      name,
      phone,
      whenText: req.body?.whenText,
      topic: req.body?.topic,
      leadId,
    });

    // Best-effort, exactly like the voice_call_started write: a callback that
    // is recorded but not announced is still a callback we will honour, so
    // never fail the request because a notifier or the lead source is down.
    const opsPhone = process.env.OPS_PHONE;
    if (opsPhone) {
      notifier.send(opsPhone, callbackOpsMessage(entry)).catch((e) => console.error("[callback] notify failed:", e.message));
    } else {
      console.log(`[callback] ${callbackOpsMessage(entry)}`);
    }
    if (leadId) {
      source
        .pushStatus(leadId, { event: "callback_requested", label: `Applicant asked UPSY to call them back on ${phone}${entry.whenText ? ` (${entry.whenText})` : ""}` })
        .catch((e) => console.error("[callback] timeline write failed:", e.message));
    }

    // Echo the normalized number back: the caller may have typed it with +91,
    // spaces or dashes, and the confirmation should show the number we will
    // actually ring rather than the string they happened to type.
    res.json({ ok: true, id: entry.id, phone: entry.phone });
  } catch (e) {
    console.error("[callback] failed:", e.message);
    res.status(500).json({ error: "We couldn't save that request. Please try again." });
  }
});

// The officer-facing side of the same queue.
app.get("/api/voice/callbacks", async (_req, res) => {
  res.json({ callbacks: await listCallbacks() });
});

// ── What the caller thought of the call ───────────────────────────────────
// Public and unauthenticated, like the session and callback routes, because an
// anonymous caller's opinion is worth exactly as much as a signed-in one's —
// arguably more, since they are the ones we otherwise never hear from. Rate
// limited on the same principle, more generously: this writes a small row
// rather than minting a billable credential.
const reviewLimiter = createRateLimiter({ limit: 10, windowMs: 30 * 60 * 1000 });

app.post("/api/voice/review", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (reviewLimiter.check(ip)) {
    return res.status(429).json({ error: "Thanks — we've got your feedback already." });
  }

  const rating = parseRating(req.body?.rating);
  if (rating === null) {
    return res.status(400).json({ error: "Please pick a rating from 1 to 5." });
  }

  try {
    const entry = await recordReview({
      rating,
      comment: req.body?.comment,
      accountId: req.body?.accountId || null,
      leadId: req.body?.leadId || null,
      callSeconds: Number(req.body?.callSeconds) || 0,
      turns: Number(req.body?.turns) || 0,
    });

    // Best-effort on both, exactly like the callback route: feedback that is
    // recorded but not announced is still recorded, so never fail the request
    // because a notifier or the lead source is down. A happy caller does not
    // page anyone — only a poor rating goes out, and only once.
    if (isPoorRating(entry.rating)) {
      const opsPhone = process.env.OPS_PHONE;
      if (opsPhone) {
        notifier.send(opsPhone, reviewOpsMessage(entry)).catch((e) => console.error("[review] notify failed:", e.message));
      } else {
        console.log(`[review] ${reviewOpsMessage(entry)}`);
      }
    } else {
      console.log(`[review] ${entry.rating}/5${entry.comment ? ` — "${entry.comment.slice(0, 80)}"` : ""}`);
    }

    if (entry.leadId) {
      source
        .pushStatus(entry.leadId, { event: "call_rated", label: `Rated their call with UPSY ${entry.rating}/5${entry.comment ? `: "${entry.comment.slice(0, 160)}"` : ""}` })
        .catch((e) => console.error("[review] timeline write failed:", e.message));
    }

    res.json({ ok: true, id: entry.id });
  } catch (e) {
    console.error("[review] failed:", e.message);
    res.status(500).json({ error: "We couldn't save that. Please try again." });
  }
});

app.get("/api/voice/reviews", async (_req, res) => {
  res.json({ reviews: await listReviews(), summary: await reviewSummary() });
});

// The voice surface. Its own page rather than a route of the applicant SPA —
// it is a different design (dark, voice-first, phone-first) and shares nothing
// with index.html but the API.
app.get(["/upsy-voice-agent", "/upsy-voice-agent/*"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "voice-agent.html"));
});

// This lived at /m until 2026-08-12. The old path is kept as a permanent
// redirect rather than deleted: it has been handed out in call sheets and
// printed links, and a 404 on the voice line is a caller who never gets
// through. The query string comes along so /m?debug still lands on ?debug.
app.get(["/m", "/m/*"], (req, res) => {
  const qs = req.originalUrl.indexOf("?");
  res.redirect(301, "/upsy-voice-agent" + (qs === -1 ? "" : req.originalUrl.slice(qs)));
});

// SPA routing: serve the applicant app for its client-side routes
// (/login → /intake → /docs, plus per-document steps like /docs/3 and /docs/done).
app.get(["/login", "/intake", "/docs", "/docs/*"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// Team dashboard's clean URL. team.js reads/writes ?lead=&tab= via
// history.pushState against location.pathname, so this works unchanged for
// deep links like /team?lead=LD-1001&tab=lenders.
app.get("/team", requireTeamAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "team.html"));
});

const PORT = process.env.PORT || 3000;

// An explicit http.Server rather than app.listen(), because the voice relay is a
// WebSocket endpoint on this same origin and needs the `upgrade` event. Render
// gives us exactly one port, so a second listener would not survive deployment.
const server = http.createServer(app);
attachVoiceRelay(server);

server.listen(PORT, () => {
  console.log(`UPSY loan agent running on http://localhost:${PORT} (lead source: ${source.name})`);
  // Show which document reader is active so it's obvious the moment Claude is wired in.
  const readers = [];
  if (process.env.ANTHROPIC_API_KEY) readers.push(`Claude (${process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8"})`);
  if (openaiSide()) readers.push(`${openaiSide().name} (${process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini"})`);
  readers.push("OCR (fallback)");
  console.log(`Document reader priority: ${readers.join(" → ")}`);
  // The agent can be configured (keys present) and still refuse every call
  // because it was never deployed. Say so at boot rather than letting a caller
  // find out — this is exactly the failure that looked like our bug on 2026-08-06.
  // Only the hosted path has a deployment that can be un-published. Our own
  // relay is live whenever this process is, which is most of the point of it.
  if (voiceProvider() === "cartesia" && voiceConfigured()) {
    checkAgentReady({ force: true })
      .then((r) => {
        if (!r.ok) console.warn(`⚠️  Voice calls will fail: ${r.reason}`);
        else if (r.unverified) console.warn(`⚠️  Voice agent readiness unverified: ${r.reason}`);
        else console.log("Voice agent is deployed and accepting calls.");
      })
      .catch((e) => console.warn(`⚠️  Could not check the voice agent: ${e.message}`));
  }
  // Same reasoning as the reader-priority line: make it obvious at a glance
  // whether the phone-call agent is live, instead of finding out on a 503.
  // Temp files from a process that died mid-write. Harmless - the rename
  // never happened, so the real file is intact - but they pile up on a box
  // that crashes repeatedly. Best-effort, never blocks the boot.
  sweepTempFiles(path.join(__dirname, "..", "data"));
  console.log(teamAuthStatusLine());
  console.log(voiceStatusLine());
  if (voiceProvider() === "upsy") {
    console.log(relayStatusLine());
    // Same reasoning again: a call that is heard, answered and remembered but
    // never read into the caller's file looks fine from the phone and shows an
    // officer an empty branch list. Say which reader is doing it, or that none is.
    console.log(`Call reader: ${extractorStatusLine()} → ${BRANCHES.length} branches + underwriting`);
    // Buy the greeting and the acknowledgements once, now, rather than making
    // the first caller wait ~1.2s for each. On a free instance that sleeps after
    // 15 minutes, "the first caller after a wake-up" is very often the only
    // caller — usually the person being shown a demo.
    //
    // Deliberately not awaited: a TTS provider having a slow minute must not
    // hold up the server accepting requests.
    warmVoiceCache()
      .then((r) => r.warmed && console.log(`Voice: pre-synthesised ${r.warmed} repeated phrases (greeting + acknowledgements).`))
      .catch((e) => console.warn(`⚠️  Could not pre-warm the voice cache: ${e.message}`));
  }
});

// app.listen() used to surface this as an uncaught exception, which the handler
// at the top of this file turned into a fatal exit. http.Server emits it as an
// 'error' event instead, so keep the "never run two instances" rule explicit
// here rather than depending on an unhandled event throwing — see the ops notes.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("FATAL: port already in use — another server instance is running. Exiting.");
    process.exit(1);
  }
  throw err;
});

// ── Shutdown ────────────────────────────────────────────────────────────────
//
// Nothing stopped this process cleanly, so every deploy and every restart could
// cut a write in half. Paired with the whole-file writes the stores used to do,
// that was a corruption path on a schedule — it fired on deploys, which is
// exactly when nobody is watching the data. The stores are atomic now; this is
// the other half, and neither is much use without the other.
//
// Order matters. Stop taking new work first, so nothing new is queued while we
// are draining; then let what is already in flight finish; then go.
let shuttingDown = false;

async function shutdown(signal) {
  // Container runtimes often send SIGTERM more than once, and a second pass
  // through here would race the first.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — shutting down.`);

  // Stops accepting new connections. Existing ones, including live voice
  // sockets, are left to finish on their own.
  server.close();

  // The reminder sweep writes to the application store on a timer. Letting it
  // fire mid-drain would queue a write after we stopped waiting for writes.
  if (sweepTimer) clearInterval(sweepTimer);

  // A caller mid-sentence gets a moment to finish rather than the line simply
  // dying on them. Skipped entirely when no call is up, so an idle deploy is
  // not slowed down by a timer nobody needs.
  const live = activeCallCount();
  if (live > 0) {
    console.log(`  waiting up to ${SHUTDOWN_GRACE_MS / 1000}s for ${live} live call(s)…`);
    await new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS));
  }

  try {
    await flushAllStores();
    console.log("  all stores flushed to disk.");
  } catch (e) {
    console.error("  could not flush every store:", e.message);
  }

  process.exit(0);
}

// SIGTERM is what a container runtime and systemd send. SIGINT is Ctrl-C, and
// it goes through the same path so local development exercises the code that
// production depends on rather than a second, untested one.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
