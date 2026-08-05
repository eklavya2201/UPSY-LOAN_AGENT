// Runs backend/liveAssist.js as a managed child process, scoped to one lead
// at a time, so the team dashboard can start/stop a live-call assistant from
// a button instead of the officer running the script by hand. Only one call
// runs at once across the whole server — matches AgentCall's free-plan
// concurrency limit and keeps this simple.

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { getApplication } from "./store.js";
import { getActiveSource } from "./leadSources/index.js";
import { getActiveNotifier, liveAssistInviteMessage } from "./notifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_ASSIST_PATH = path.join(__dirname, "liveAssist.js");
const source = getActiveSource();
const notifier = getActiveNotifier();

let active = null; // { leadId, meetUrl, startedAt, child, invite }

// Same student/co-applicant split as server.js's identityGroup() — kept as a
// local one-liner rather than an import, since that helper isn't exported.
const isCoApplicantDoc = (docId) => docId.startsWith("co_");

// The name as it actually reads on a verified ID document, which is the whole
// point of feeding this into a call: a partner lender's form wants the name to
// match KYC exactly, and their own site cannot tell the applicant that. Prefer
// PAN, then Aadhaar, then any other verified document for that person.
function verifiedNameFrom(app, wantCoApplicant) {
  const docs = app.verifiedDocs || {};
  const preferred = wantCoApplicant
    ? ["co_pan", "co_aadhaar"]
    : ["student_pan", "student_aadhaar", "pan", "aadhaar"];
  for (const id of preferred) {
    if (docs[id]?.nameOnDoc) return docs[id].nameOnDoc;
  }
  for (const [docId, rec] of Object.entries(docs)) {
    if (isCoApplicantDoc(docId) === wantCoApplicant && rec.nameOnDoc) return rec.nameOnDoc;
  }
  return null;
}

function buildContext(app) {
  const p = app.profile || {};
  const e = app.eligibility || {};
  const total = app.total ?? Object.keys(app.verifiedDocs || {}).length;
  const done = Object.keys(app.verifiedDocs || {}).length;
  const payload = {
    name: p.name || null,
    course: p.course || null,
    institute: p.institute || null,
    loanType: p.loanType || null,
    eligible: e.eligible ?? null,
    estimatedAmount: e.estimatedAmount ? `about ${Math.round(e.estimatedAmount / 100000)} lakh rupees` : null,
    docsStatus: total ? `${done} of ${total} documents verified so far` : null,
    // Names only — never the ID numbers those documents also contain.
    kycName: verifiedNameFrom(app, false),
    coApplicantKycName: verifiedNameFrom(app, true),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function getStatus(leadId) {
  if (active && active.leadId === leadId) {
    return { running: true, meetUrl: active.meetUrl, startedAt: active.startedAt, invite: active.invite };
  }
  return { running: false };
}

// When an officer starts the call from the team dashboard, the applicant has no
// other way to learn about it — send them the join link over the same channel
// the reminder nudges use. Applicant-initiated calls skip this: they created
// the meeting themselves and are already in it.
async function inviteApplicant(leadId, profile, meetUrl) {
  const phone = profile?.phone;
  if (!phone) {
    return { sent: false, reason: "No phone number on record for this applicant — send them the link yourself." };
  }
  const msg = liveAssistInviteMessage(profile, meetUrl);
  try {
    await notifier.send(phone, msg);
    await source.pushStatus(leadId, { event: "live_assist_invite_sent", label: `Join link sent to ${phone}` });
    return { sent: true, phone };
  } catch (e) {
    console.error(`[live-assist ${leadId}] invite failed:`, e.message);
    return { sent: false, reason: `Couldn't send the join link (${e.message}) — send it yourself.` };
  }
}

export async function startCall(leadId, meetUrl, { notifyApplicant = false } = {}) {
  if (!meetUrl || !/^https?:\/\//.test(meetUrl)) {
    throw new Error("A valid meeting URL is required.");
  }
  if (active) {
    if (active.leadId === leadId) throw new Error("A live-assist call is already running for this applicant.");
    throw new Error("Another live-assist call is already in progress (only one at a time on the current plan).");
  }

  const app = await getApplication(leadId);
  const contextB64 = buildContext(app);

  const child = spawn(
    "node",
    [LIVE_ASSIST_PATH, meetUrl, "--name", "UPSY", "--voice", "am_adam", "--context", contextB64],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const startedAt = new Date().toISOString();
  active = { leadId, meetUrl, startedAt, child, invite: null };

  child.stdout.on("data", (d) => process.stdout.write(`[live-assist ${leadId}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[live-assist ${leadId}] ${d}`));
  child.on("exit", (code) => {
    console.error(`[live-assist ${leadId}] process exited with code ${code}`);
    if (active && active.leadId === leadId) active = null;
    source.pushStatus(leadId, { event: "live_assist_ended", label: `Live-assist call ended (exit code ${code})` }).catch(() => {});
  });

  await source.pushStatus(leadId, { event: "live_assist_started", label: `Live-assist call started: ${meetUrl}` });

  // Never let a failed invite kill the call — the officer can always share the
  // link by hand, and the bot is already in the meeting by this point.
  const invite = notifyApplicant ? await inviteApplicant(leadId, app.profile, meetUrl) : null;
  if (active && active.leadId === leadId) active.invite = invite;

  return { started: true, startedAt, invite };
}

// How long to wait for the child to actually exit after SIGINT before forcing
// it. liveAssist.js's own handler sends `leave` then force-exits after 500ms,
// so this only bites if the process is genuinely wedged.
const STOP_TIMEOUT_MS = 3000;

export async function stopCall(leadId) {
  if (!active || active.leadId !== leadId) throw new Error("No live-assist call is running for this applicant.");
  const { child } = active;

  // Wait for the process to really be gone before answering. Returning as soon
  // as the signal was *sent* meant the frontend re-checked status while the
  // child was still alive, saw the call still active, and flickered back to
  // "in progress" before settling on idle.
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve("already-exited");
    let timer = null;
    const onExit = () => {
      clearTimeout(timer);
      resolve("exited");
    };
    child.once("exit", onExit);
    // Never leave a wedged child holding the single global call slot — this
    // repo has been bitten by orphaned processes before (see the ops notes).
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.kill("SIGKILL");
      console.error(`[live-assist ${leadId}] did not exit within ${STOP_TIMEOUT_MS}ms — sent SIGKILL`);
      resolve("killed");
    }, STOP_TIMEOUT_MS);
  });

  child.kill("SIGINT");
  const outcome = await exited;
  return { stopped: true, outcome };
}
