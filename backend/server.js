import "dotenv/config"; // loads .env (credentials for Exotel / SMTP) if present
import fs from "fs/promises";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { DOCUMENTS, STAGES, getDocument } from "./documents.js";
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
import { createVoiceSession, voiceConfigured, voiceConfigError, voiceStatusLine, checkAgentReady } from "./voiceCall.js";
import { createRateLimiter } from "./rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const source = getActiveSource();
const notifier = getActiveNotifier();

// Drop-off detection: how long an in-progress application can go untouched
// before we consider it "stalled" and worth nudging, and how long to wait
// before nudging the same applicant again. Shortened for this demo — a real
// deployment would use hours/days (e.g. 24h stale, 48h cooldown), not minutes.
const STALE_AFTER_MS = 3 * 60 * 1000;
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

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
setInterval(async () => {
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
  // Drop collateral docs for an unsecured loan.
  const applicable = DOCUMENTS.filter(
    (d) => !(lead.loanType === "unsecured" && d.stage === "collateral")
  );
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
  const loanType = app.profile?.loanType;
  const applicable = DOCUMENTS.filter((d) => !(loanType === "unsecured" && d.stage === "collateral"));
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
  console.log(`[capture:${card.source}] ${doc.id}: number=${card.number || "-"} name="${card.name || "-"}" dob="${card.dob || "-"}"`);
  res.json({ found: !!card.number, value: card.number, name: doc.identifier.name, holderName: card.name, dob: card.dob, source: card.source });
});

// Smart intake box: structure a free-text loan request into a loan intent + follow-ups.
app.post("/api/intake", async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const leadId = req.body?.leadId;
  if (!text) return res.status(400).json({ error: "Please describe what you need." });
  if (!intakeConfigured()) return res.status(503).json({ error: "No language model is configured (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)." });
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
        console.log(`[bankstatement:${bank.source}] ${leadId}: name="${bank.accountHolderName || "-"}" phone="${bank.phoneNumber || "-"}"`);
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

      console.log(`[identity:${identity.source}] ${doc.id} (${group}): name="${nameOnDoc || "-"}" dob="${dobOnDoc || "-"}" address="${addressOnDoc || "-"}" match=${extra.nameMatch ?? "-"} conflicts=${conflicts.length}`);
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
  if (!assistConfigured()) return res.status(503).json({ error: "The helper isn't configured yet (set ANTHROPIC_API_KEY or OPENROUTER_API_KEY)." });
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

// ── Browser voice calls (mobile surface) ────────────────────────────────────
// Mints a short-lived credential so the caller's phone can open a voice socket
// directly to the provider. Unlike live-assist there is no meeting, no child
// process and no global one-call lock — see backend/voiceCall.js.

// Five calls per 10 minutes per device. A real caller starting over after a
// dropped connection stays well inside this; a script does not.
const voiceLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });

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
    const session = await createVoiceSession({ leadId });
    console.log(`[voice] session started (${session.caller.known ? `lead ${leadId}` : "anonymous"})`);
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
    // The agent exists but was never deployed. Worth its own branch: without
    // this the caller only ever sees an opaque 1011 close after the socket
    // opens, and the real cause never reaches anyone who could act on it.
    if (e.code === "AGENT_NOT_READY") {
      console.error(`[voice] ${e.message}`);
      return res.status(503).json({ error: "UPSY's voice line isn't switched on yet. Please try the chat, or check back shortly.", detail: e.message });
    }
    console.error("[voice] session failed:", e.message);
    res.status(502).json({ error: "Couldn't start the call right now. Please try again in a moment." });
  }
});

// The mobile surface. Its own page rather than a route of the applicant SPA —
// it is a different design (dark, voice-first, phone-only) and shares nothing
// with index.html but the API.
app.get(["/m", "/m/*"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "m.html"));
});

// SPA routing: serve the applicant app for its client-side routes
// (/login → /intake → /docs, plus per-document steps like /docs/3 and /docs/done).
app.get(["/login", "/intake", "/docs", "/docs/*"], (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// Team dashboard's clean URL. team.js reads/writes ?lead=&tab= via
// history.pushState against location.pathname, so this works unchanged for
// deep links like /team?lead=LD-1001&tab=lenders.
app.get("/team", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "team.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`UPSY loan agent running on http://localhost:${PORT} (lead source: ${source.name})`);
  // Show which document reader is active so it's obvious the moment Claude is wired in.
  const readers = [];
  if (process.env.ANTHROPIC_API_KEY) readers.push(`Claude (${process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8"})`);
  if (process.env.OPENROUTER_API_KEY) readers.push(`OpenRouter (${process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini"})`);
  readers.push("OCR (fallback)");
  console.log(`Document reader priority: ${readers.join(" → ")}`);
  // The agent can be configured (keys present) and still refuse every call
  // because it was never deployed. Say so at boot rather than letting a caller
  // find out — this is exactly the failure that looked like our bug on 2026-08-06.
  if (voiceConfigured()) {
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
  console.log(voiceStatusLine());
});
