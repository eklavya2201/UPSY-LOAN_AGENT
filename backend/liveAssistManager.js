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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_ASSIST_PATH = path.join(__dirname, "liveAssist.js");
const source = getActiveSource();

let active = null; // { leadId, meetUrl, startedAt, child }

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
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function getStatus(leadId) {
  if (active && active.leadId === leadId) {
    return { running: true, meetUrl: active.meetUrl, startedAt: active.startedAt };
  }
  return { running: false };
}

export async function startCall(leadId, meetUrl) {
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
  active = { leadId, meetUrl, startedAt, child };

  child.stdout.on("data", (d) => process.stdout.write(`[live-assist ${leadId}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[live-assist ${leadId}] ${d}`));
  child.on("exit", (code) => {
    console.error(`[live-assist ${leadId}] process exited with code ${code}`);
    if (active && active.leadId === leadId) active = null;
    source.pushStatus(leadId, { event: "live_assist_ended", label: `Live-assist call ended (exit code ${code})` }).catch(() => {});
  });

  await source.pushStatus(leadId, { event: "live_assist_started", label: `Live-assist call started: ${meetUrl}` });
  return { started: true, startedAt };
}

export async function stopCall(leadId) {
  if (!active || active.leadId !== leadId) throw new Error("No live-assist call is running for this applicant.");
  active.child.kill("SIGINT");
  return { stopping: true };
}
