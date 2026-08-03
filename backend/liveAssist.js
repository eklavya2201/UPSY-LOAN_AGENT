// Standalone low-latency live-call assistant. Joins a meeting via the vendored
// AgentCall bridge (backend/agentcall/bridge.js) and answers the applicant's
// questions about a partner lender's real application form (e.g. Avanse) by
// voice, grounded in periodic screenshots of their shared screen. Unlike the
// interactive-agent prototype this replaces, every event here is answered by
// a single direct LLM call — no human-in-the-loop coding session — to hit a
// real-time response budget instead of a multi-second-to-minute one.
//
// Usage: node backend/liveAssist.js <meet-url> [--name UPSY] [--voice am_adam] [--context <base64-json>]
// --context is how backend/liveAssistManager.js grounds this in one specific
// applicant's real UPSY data (name, course, eligibility) when started from the
// team dashboard, instead of running with only the generic rules below.

import "dotenv/config";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, "agentcall", "bridge.js");

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
const SCREENSHOT_INTERVAL_MS = 5000;
const MAX_HISTORY = 8;

function parseArgs(argv) {
  const meetUrl = argv[2];
  let name = "UPSY";
  let voice = "am_adam";
  let context = null;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--voice") voice = argv[++i];
    else if (argv[i] === "--context") context = argv[++i];
  }
  return { meetUrl, name, voice, context };
}

const { meetUrl, name: BOT_NAME, voice: BOT_VOICE, context: CONTEXT_B64 } = parseArgs(process.argv);
if (!meetUrl) {
  console.error("Usage: node backend/liveAssist.js <meet-url> [--name Nova] [--voice af_heart] [--context <base64-json>]");
  process.exit(1);
}
if (!OR_KEY) {
  console.error("OPENROUTER_API_KEY is not set — liveAssist needs it to answer questions.");
  process.exit(1);
}

// Only non-sensitive summary facts belong here — never PAN/Aadhaar/account
// numbers, matching the same boundary as the rest of this file.
function applicantContextBlock(b64) {
  if (!b64) return "";
  let c;
  try {
    c = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return "";
  }
  const lines = [];
  if (c.name) lines.push(`Applicant name: ${c.name}.`);
  if (c.course || c.institute) lines.push(`Course: ${c.course || "unspecified"}${c.institute ? " at " + c.institute : ""}.`);
  if (c.loanType) lines.push(`Loan type requested: ${c.loanType}.`);
  if (c.eligible != null) lines.push(`UPSY's own verdict for this applicant: ${c.eligible ? "eligible" : "needs review"}.`);
  if (c.estimatedAmount) lines.push(`UPSY's estimated facility for this applicant: ${c.estimatedAmount}.`);
  if (c.docsStatus) lines.push(`Documents so far: ${c.docsStatus}.`);
  if (!lines.length) return "";
  return `\n\nThis specific applicant's context (use it, but this is UPSY's own record — a partner lender's own form may ask for or show different things):\n${lines.map((l) => "- " + l).join("\n")}`;
}
const APPLICANT_CONTEXT = applicantContextBlock(CONTEXT_B64);

// Same "LLM never touches KYC field contents" boundary as backend/assist.js —
// this agent can additionally SEE the screen, so the rule has to be explicit
// about never reading back sensitive numbers it happens to see. Eligibility
// facts below are copied from backend/eligibility.js so the agent's numbers
// stay consistent with what UPSY itself would tell the same applicant.
const SYSTEM_PROMPT = `You are ${BOT_NAME}, the loan assistant from UPSY, helping an applicant fill out a loan application (their own, or a partner lender's real online form such as Avanse) while on a live call with them. You can see a recent screenshot of their shared screen and hear what they say.

UPSY's own eligibility rules — use these as the source of truth when asked about eligibility, amount, rate, or requirements. A specific lender's own form or policy may differ from UPSY's; say so if asked, rather than implying UPSY's numbers are that lender's numbers:
- Academic score below 60 percent is generally flagged as not eligible by most lenders.
- The co-borrower must be immediate family — father, mother, brother, sister, or spouse — with stable, verifiable income. Friends cannot co-borrow.
- NRI co-borrower cases additionally need an NRE or NRO account, Indian collateral, and one more India-resident co-borrower.
- Loan estimate is roughly twenty four times the co-applicant's monthly income, floored at fifty thousand rupees, capped at one crore rupees for an unsecured loan or two crore rupees for a secured loan.
- Moratorium is course duration plus about nine months of grace before repayment starts.
- Indicative rate: about nine and a half to eleven and a half percent for a secured loan, about ten and a half to thirteen percent for an unsecured loan.

Rules:
- Explain what a field is for and what kind of answer it wants, based on what you see on screen.
- NEVER read back, repeat, transcribe, or ask the applicant to confirm any PAN, Aadhaar, account number, or other sensitive ID number you see on screen, even if it is visible in the screenshot. Only describe the field's purpose. The applicant enters their own data — you only guide.
- Never tell the applicant what to type into a KYC field; only explain what the field is asking for.
- If you cannot tell what is currently on screen, say so honestly and ask them to describe it or give it a moment for a fresh screenshot.
- Keep responses short: two to three sentences, conversational, no markdown, no symbols, no emojis. Spell out numbers the way you would say them aloud.
- If asked about a specific lender's own process that you do not actually know, say so plainly rather than guessing — only state UPSY's own rules as UPSY's rules.${APPLICANT_CONTEXT}`;

const child = spawn("node", [BRIDGE_PATH, meetUrl, "--name", BOT_NAME, "--voice", BOT_VOICE], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
child.on("error", (e) => {
  console.error("[liveAssist] failed to start bridge process:", e.message);
  process.exit(1);
});
child.on("exit", (code) => {
  console.error(`[liveAssist] bridge process exited with code ${code}`);
  if (screenshotTimer) clearInterval(screenshotTimer);
  process.exit(code || 0);
});

function sendCommand(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

let latestScreenshot = null; // data URL, refreshed on a timer
let history = []; // [{role, content}], capped at MAX_HISTORY
let screenshotTimer = null;
const humanParticipants = new Set();
let everHadHuman = false;

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  handleEvent(event).catch((e) => console.error("[liveAssist] handler error:", e.message));
});

async function handleEvent(event) {
  switch (event.event) {
    case "call.bot_ready":
      console.error("[liveAssist] bot ready, waiting for a participant");
      break;

    case "participant.joined":
      if (event.name && event.name.toLowerCase() !== BOT_NAME.toLowerCase()) {
        humanParticipants.add(event.name);
        everHadHuman = true;
      }
      break;

    case "participant.left":
      if (event.name) humanParticipants.delete(event.name);
      if (everHadHuman && humanParticipants.size === 0) {
        sendCommand({ command: "leave" });
      }
      break;

    case "greeting.prompt":
      sendCommand({
        command: "tts.speak",
        text: `Hi ${event.participant || "there"}, I am ${BOT_NAME}. I can help you fill out your loan application on the lender's website. Go ahead and share your screen whenever you are ready.`,
      });
      if (!screenshotTimer) {
        screenshotTimer = setInterval(
          () => sendCommand({ command: "screenshot", request_id: `poll-${Date.now()}` }),
          SCREENSHOT_INTERVAL_MS
        );
      }
      break;

    case "user.message":
      await respondTo(event.text);
      break;

    case "screenshot.result":
      if (event.data) latestScreenshot = `data:image/jpeg;base64,${event.data}`;
      break;

    case "command.error":
      console.error("[liveAssist] command error:", event.message);
      break;

    case "call.ended":
      cleanup();
      break;

    default:
      break;
  }
}

// The model (gpt-4o-mini) occasionally degenerates into repeating a sentence
// back-to-back within the same reply, which bridge.js's sentence-splitter
// then speaks as two identical lines in a row. Collapse consecutive
// duplicate sentences before they ever reach tts.speak.
function dedupeRepeatedSentences(text) {
  const sentences = text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  const deduped = [];
  for (const s of sentences) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.toLowerCase() === s.toLowerCase()) continue;
    deduped.push(s);
  }
  return deduped.join(" ");
}

async function respondTo(text) {
  if (!text || !text.trim()) return;

  history.push({ role: "user", content: text });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  const latestUserContent = [{ type: "text", text }];
  if (latestScreenshot) {
    latestUserContent.push({ type: "image_url", image_url: { url: latestScreenshot } });
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(0, -1),
    { role: "user", content: latestUserContent },
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: OR_MODEL, temperature: 0.3, max_tokens: 200, messages }),
    });
    if (!res.ok) {
      console.error(`[liveAssist] OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      sendCommand({ command: "tts.speak", text: "Sorry, I had trouble just now. Could you say that again?" });
      return;
    }
    const data = await res.json();
    const reply = dedupeRepeatedSentences((data.choices?.[0]?.message?.content || "").trim());
    if (!reply) {
      sendCommand({ command: "tts.speak", text: "Sorry, I did not catch that. Could you repeat it?" });
      return;
    }
    history.push({ role: "assistant", content: reply });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    sendCommand({ command: "tts.speak", text: reply });
  } catch (e) {
    console.error("[liveAssist] request failed:", e.message);
    sendCommand({ command: "tts.speak", text: "Sorry, something went wrong on my end. Could you say that again?" });
  }
}

function cleanup() {
  if (screenshotTimer) clearInterval(screenshotTimer);
  console.error("[liveAssist] call ended, exiting");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => {
  sendCommand({ command: "leave" });
  setTimeout(() => process.exit(0), 500);
});
