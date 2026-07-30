// Emails the completed document packet to your ops/underwriting inbox once an
// applicant has submitted everything. Uses SMTP via nodemailer; without SMTP
// credentials it safely logs what it *would* send (and lists the attachments)
// instead of failing, so demo mode keeps working.
//
// To go live, set these env vars before starting the server:
//   SMTP_HOST=smtp.yourprovider.com
//   SMTP_PORT=587
//   SMTP_USER=...
//   SMTP_PASS=...
//   MAIL_FROM="UPSY Loan Agent <noreply@yourdomain.com>"
//   OPS_EMAIL=loans@yourdomain.com          (where completed packets are sent)

import fs from "fs";
import nodemailer from "nodemailer";
import { DOCUMENTS } from "./documents.js";
import { filePath } from "./files.js";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, OPS_EMAIL } = process.env;

function configured() {
  return Boolean(SMTP_HOST && SMTP_PORT && OPS_EMAIL);
}

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }
  return transport;
}

// Free test transport (Ethereal). Sends to a throwaway inbox and returns a
// preview URL so you can SEE the real rendered email + attachments — no Gmail
// / SMTP credentials needed. Enabled with MAIL_TEST=1 when real SMTP is unset.
let testTransportPromise = null;
function getTestTransport() {
  if (!testTransportPromise) {
    testTransportPromise = nodemailer
      .createTestAccount()
      .then((acct) => nodemailer.createTransport({ host: "smtp.ethereal.email", port: 587, secure: false, auth: { user: acct.user, pass: acct.pass } }));
  }
  return testTransportPromise;
}

const rupees = (n) => {
  if (!n) return "—";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
};

function label(docId) {
  return (DOCUMENTS.find((d) => d.id === docId) || {}).label || docId;
}

// Build the attachments (every stored file) and a human-readable summary body.
function buildPacket(app) {
  const p = app.profile || {};
  // Skip records whose file has gone missing from storage (e.g. cloud-sync
  // removed it) — a dead path would make nodemailer fail the whole send.
  const attachments = Object.entries(app.verifiedDocs || {})
    .filter(([, v]) => v.storedName && fs.existsSync(filePath(v.storedName)))
    .map(([docId, v]) => ({ filename: v.filename || `${docId}.bin`, path: filePath(v.storedName) }));

  const docLines = Object.entries(app.verifiedDocs || {})
    .map(([docId, v]) => `  • ${label(docId)} — ${v.filename || "file"} (${v.score ?? "?"}% checks)`)
    .join("\n");
  const onFileLines = (app.onFile || []).map((id) => `  • ${label(id)} — already on record at lead source`).join("\n");

  const e = app.eligibility;
  const eligLine = e
    ? e.eligible
      ? `Eligible — est. ${rupees(e.estimatedAmount)} at ${e.ratePreview}`
      : `Needs review — ${e.reasons.join("; ")}`
    : "not assessed";

  const text =
    `Education loan application — documents complete\n\n` +
    `Applicant : ${p.name || "—"}\n` +
    `Phone     : ${p.phone || "—"}\n` +
    `Course    : ${p.course || "—"}${p.institute ? ` at ${p.institute}` : ""}\n` +
    `Loan type : ${p.loanType || "—"}\n` +
    `Lead source: ${p.source || "—"}\n` +
    `Eligibility: ${eligLine}\n\n` +
    `Uploaded documents (${attachments.length} attached):\n${docLines || "  (none)"}\n` +
    (onFileLines ? `\nAlready on record:\n${onFileLines}\n` : "") +
    `\n— Sent automatically by the UPSY Loan Agent once all documents were received.`;

  return {
    subject: `UPSY loan — ${p.name || app.leadId} — documents complete`,
    text,
    attachments,
  };
}

// Send the packet. Returns { ok, to, count, preview? } or logs a fallback.
export async function sendDocumentPacket(app) {
  const { subject, text, attachments } = buildPacket(app);

  // Free test mode: no real SMTP configured, but MAIL_TEST is set → send to an
  // Ethereal inbox and return a preview URL so the email can actually be viewed.
  if (!configured() && process.env.MAIL_TEST) {
    const info = await (await getTestTransport()).sendMail({
      from: MAIL_FROM || "UPSY Loan Agent <test@upsy.local>",
      to: OPS_EMAIL || "ops@example.com",
      subject,
      text,
      attachments,
    });
    const preview = nodemailer.getTestMessageUrl(info);
    console.log(`[mail:TEST] "${subject}" (${attachments.length} attachments) → Ethereal preview: ${preview}`);
    return { ok: true, to: OPS_EMAIL || "ops@example.com (test)", count: attachments.length, preview, test: true };
  }

  if (!configured()) {
    console.log(`[mail:NOT CONFIGURED — set SMTP_HOST/SMTP_PORT/OPS_EMAIL] would email "${subject}" with ${attachments.length} attachment(s) to <OPS_EMAIL>`);
    return { ok: false, to: OPS_EMAIL || "(unset)", count: attachments.length, simulated: true };
  }
  await getTransport().sendMail({ from: MAIL_FROM || SMTP_USER, to: OPS_EMAIL, subject, text, attachments });
  console.log(`[mail] sent "${subject}" (${attachments.length} attachments) to ${OPS_EMAIL}`);
  return { ok: true, to: OPS_EMAIL, count: attachments.length };
}

export function opsEmail() {
  return OPS_EMAIL || null;
}
