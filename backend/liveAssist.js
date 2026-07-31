// Standalone low-latency live-call assistant. Joins a meeting via the vendored
// AgentCall bridge (backend/agentcall/bridge.js) and answers the applicant's
// questions about a partner lender's real application form (e.g. Avanse) by
// voice, grounded in periodic screenshots of their shared screen. Unlike the
// interactive-agent prototype this replaces, every event here is answered by
// a single direct LLM call — no human-in-the-loop coding session — to hit a
// real-time response budget instead of a multi-second-to-minute one.
//
// Usage: node backend/liveAssist.js <meet-url> [--name Nova] [--voice af_heart]

import "dotenv/config";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, "agentcall", "bridge.js");

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
const SCREENSHOT_INTERVAL_MS = 8000;
const MAX_HISTORY = 8;

function parseArgs(argv) {
  const meetUrl = argv[2];
  let name = "Nova";
  let voice = "af_heart";
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--voice") voice = argv[++i];
  }
  return { meetUrl, name, voice };
}

const { meetUrl, name: BOT_NAME, voice: BOT_VOICE } = parseArgs(process.argv);
if (!meetUrl) {
  console.error("Usage: node backend/liveAssist.js <meet-url> [--name Nova] [--voice af_heart]");
  process.exit(1);
}
if (!OR_KEY) {
  console.error("OPENROUTER_API_KEY is not set — liveAssist needs it to answer questions.");
  process.exit(1);
}

// Same "LLM never touches KYC field contents" boundary as backend/assist.js —
// this agent can additionally SEE the screen, so the rule has to be explicit
// about never reading back sensitive numbers it happens to see.
const SYSTEM_PROMPT = `You are ${BOT_NAME}, a live voice assistant helping a loan applicant fill out a partner lender's real online application form (for example Avanse) while on a call with them. You can see a recent screenshot of their shared screen and hear what they say.

Rules:
- Explain what a field is for and what kind of answer it wants, based on what you see on screen and general education-loan knowledge (loan amount, co-applicant, KYC documents, income proof, etc).
- NEVER read back, repeat, transcribe, or ask the applicant to confirm any PAN, Aadhaar, account number, or other sensitive ID number you see on screen, even if it is visible in the screenshot. Only describe the field's purpose. The applicant enters their own data — you only guide.
- Never tell the applicant what to type into a KYC field; only explain what the field is asking for.
- If you cannot tell what is currently on screen, say so honestly and ask them to describe it or give it a moment for a fresh screenshot.
- Keep responses short: two to three sentences, conversational, no markdown, no symbols, no emojis. Spell out numbers the way you would say them aloud.
- If you do not know something about a specific lender's process, say so plainly rather than guessing.`;

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
      body: JSON.stringify({ model: OR_MODEL, temperature: 0.3, max_tokens: 150, messages }),
    });
    if (!res.ok) {
      console.error(`[liveAssist] OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      sendCommand({ command: "tts.speak", text: "Sorry, I had trouble just now. Could you say that again?" });
      return;
    }
    const data = await res.json();
    const reply = (data.choices?.[0]?.message?.content || "").trim();
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
