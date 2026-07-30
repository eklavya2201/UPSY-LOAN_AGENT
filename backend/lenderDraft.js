// Lender referral email drafts. Generates a lender-specific email (subject +
// body) grounded in the applicant's profile, eligibility memo and document
// status, via the usual Claude → OpenRouter chain with a deterministic template
// fallback — so drafting always works, even with no LLM key set.
//
// The draft is exported as an RFC-822 .eml file with the verified documents
// attached and an "X-Unsent: 1" header, so double-clicking it opens a ready-to-
// edit compose window in Outlook (and most desktop mail clients).

import fs from "fs/promises";
import { DOCUMENTS } from "./documents.js";
import { filePath } from "./files.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_DRAFT_MODEL || "claude-opus-4-8";
const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_DRAFT_MODEL || "openai/gpt-4o-mini";

const rupees = (n) => {
  if (!n) return "—";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
};

const docLabel = (id) => (DOCUMENTS.find((d) => d.id === id) || {}).label || id;

// The facts the email is allowed to state — built once, shared by both the LLM
// prompt and the fallback template so neither can invent anything.
function buildFacts(lender, app, lead, partner) {
  const p = app.profile || {};
  const e = app.eligibility;
  const verified = Object.entries(app.verifiedDocs || {}).map(([id, v]) => `${docLabel(id)} (${v.score ?? "?"}% checks passed)`);
  const onFile = (app.onFile || []).map(docLabel);
  return {
    applicant: p.name || app.leadId,
    phone: p.phone || "—",
    course: [p.course, p.institute].filter(Boolean).join(" at ") || "—",
    partnerInstitute: partner ? `${partner.name} is a UPSY partner institute` : null,
    loanType: p.loanType || "unsecured",
    eligibility: e
      ? e.eligible
        ? `Preliminary eligible — estimated ${rupees(e.estimatedAmount)}, indicative rate ${e.ratePreview}, moratorium ${e.moratoriumMonths} months`
        : `Needs review — ${(e.reasons || []).join("; ")}`
      : "Not assessed yet",
    academicPercent: lead?.academicPercent != null ? `${lead.academicPercent}%` : null,
    coApplicant: lead?.coApplicantRelation
      ? `${lead.coApplicantRelation} (${lead.coApplicantType || "—"}, monthly income ${
          app.extractedIncome?.monthlyIncomeInr
            ? `${rupees(app.extractedIncome.monthlyIncomeInr)} — verified from uploaded ${app.extractedIncome.docType === "itr" ? "ITR" : "salary slip"}`
            : rupees(lead.coApplicantMonthlyIncome)
        })`
      : p.coApplicantType || null,
    verifiedDocs: verified,
    onFileDocs: onFile,
    lenderName: lender.name,
    lenderType: lender.type,
  };
}

function factsText(f) {
  return (
    `Applicant: ${f.applicant} (${f.phone})\n` +
    `Course: ${f.course}\n` +
    (f.partnerInstitute ? `Institute: ${f.partnerInstitute}\n` : "") +
    `Loan type: ${f.loanType}\n` +
    `UPSY preliminary assessment: ${f.eligibility}\n` +
    (f.academicPercent ? `Academic score: ${f.academicPercent}\n` : "") +
    (f.coApplicant ? `Co-applicant: ${f.coApplicant}\n` : "") +
    `Verified documents (attached): ${f.verifiedDocs.length ? f.verifiedDocs.join("; ") : "none yet"}\n` +
    (f.onFileDocs.length ? `Already on record at lead source: ${f.onFileDocs.join("; ")}\n` : "")
  );
}

// Deterministic fallback — always available, states only the facts above.
function templateDraft(lender, facts) {
  const subject = `Education loan referral — ${facts.applicant} — ${facts.course}`;
  const body =
    `Dear ${lender.name} partnerships team,\n\n` +
    `Please find below a pre-screened education-loan referral from UPSY, with the applicant's verified documents attached.\n\n` +
    factsText(facts) +
    `\nWe request you to consider this file for sanction. Happy to share anything further you need.\n\n` +
    `Best regards,\nUPSY Loan Operations\n(This referral was prepared with the UPSY Loan Agent)`;
  return { subject, body, source: "template" };
}

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function draftInstructions(lender) {
  return (
    `You draft a professional referral email from UPSY (an education-loan facilitator) to the partner lender "${lender.name}" (${lender.type}). ` +
    `${lender.blurb} ` +
    `Use ONLY the facts provided — never invent numbers, documents, names or approvals. ` +
    `Refer to the applicant by name or as "the applicant" — never assume their gender (no he/she unless stated in the facts). ` +
    `Tone: concise, professional, Indian lending-industry appropriate. Mention that verified documents are attached. ` +
    `Do not promise sanction; this is a referral for the lender's own underwriting. ` +
    `Return ONLY this JSON (no markdown): {"subject": "<email subject>", "body": "<plain-text email body with \\n line breaks, signed 'UPSY Loan Operations'>"}`
  );
}

async function callClaude(lender, facts) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 900,
      system: draftInstructions(lender),
      messages: [{ role: "user", content: `Facts for the referral email:\n${factsText(facts)}` }],
    }),
  });
  if (!res.ok) {
    console.error(`[draft:claude] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  return parseJson(block?.text || "");
}

async function callOpenRouter(lender, facts) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OR_MODEL,
      temperature: 0.3,
      max_tokens: 900,
      messages: [
        { role: "system", content: draftInstructions(lender) },
        { role: "user", content: `Facts for the referral email:\n${factsText(facts)}` },
      ],
    }),
  });
  if (!res.ok) {
    console.error(`[draft:openrouter] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "");
}

// Generate the draft: Claude → OpenRouter → template. Never fails.
export async function generateLenderDraft(lender, app, lead, partner) {
  const facts = buildFacts(lender, app, lead, partner);
  if (ANTHROPIC_KEY) {
    try {
      const d = await callClaude(lender, facts);
      if (d?.subject && d?.body) return { subject: d.subject, body: d.body, source: "claude" };
    } catch (e) { console.error("[draft:claude] request failed:", e.message); }
  }
  if (OR_KEY) {
    try {
      const d = await callOpenRouter(lender, facts);
      if (d?.subject && d?.body) return { subject: d.subject, body: d.body, source: "openrouter" };
    } catch (e) { console.error("[draft:openrouter] request failed:", e.message); }
  }
  return templateDraft(lender, facts);
}

// ---- .eml export (opens as an editable draft in Outlook thanks to X-Unsent) ----

const CRLF = "\r\n";

function encodeQuotedHeader(value) {
  // Keep it simple: subjects here are ASCII; strip anything that would break the header.
  return String(value).replace(/[\r\n]+/g, " ");
}

export async function buildEml({ to, subject, body, attachments }) {
  const boundary = "----upsy-" + Math.random().toString(36).slice(2);
  let out =
    `To: ${to}${CRLF}` +
    `Subject: ${encodeQuotedHeader(subject)}${CRLF}` +
    `X-Unsent: 1${CRLF}` +
    `MIME-Version: 1.0${CRLF}` +
    `Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Type: text/plain; charset=utf-8${CRLF}` +
    `Content-Transfer-Encoding: 8bit${CRLF}${CRLF}` +
    body.replace(/\r?\n/g, CRLF) + CRLF;

  for (const a of attachments || []) {
    try {
      const data = await fs.readFile(filePath(a.storedName));
      const b64 = data.toString("base64").replace(/(.{76})/g, `$1${CRLF}`);
      const safeName = (a.filename || a.storedName).replace(/["\r\n]/g, "");
      out +=
        `--${boundary}${CRLF}` +
        `Content-Type: ${a.mimetype || "application/octet-stream"}; name="${safeName}"${CRLF}` +
        `Content-Disposition: attachment; filename="${safeName}"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        b64 + CRLF;
    } catch (e) {
      console.error(`[draft:eml] couldn't attach ${a.storedName}:`, e.message);
    }
  }
  out += `--${boundary}--${CRLF}`;
  return out;
}
