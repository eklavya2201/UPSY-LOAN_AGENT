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
import { buildLenderGuidancePrompt } from "./lenderForms/index.js";
import { takeCompleteSentences } from "./sentences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, "agentcall", "bridge.js");

const OR_KEY = process.env.OPENROUTER_API_KEY;
// Live-assist can be pointed at a different (stronger) vision model than the
// document readers, because OPENROUTER_VISION_MODEL is shared by capture.js,
// income.js and bankStatement.js — swapping that one to improve form guidance
// would silently change document reading too.
const OR_MODEL =
  process.env.OPENROUTER_LIVE_ASSIST_MODEL || process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";
// Background poll, so there is always *some* recent frame if a fresh grab
// fails. The frame actually used for an answer is requested on demand — see
// requestFreshScreenshot().
const SCREENSHOT_INTERVAL_MS = 3000;
// How long to wait for an on-demand frame before falling back to the polled
// one. Kept short: this sits directly in front of every reply, so it is spent
// on latency the applicant feels while waiting for the bot to answer.
const FRESH_SCREENSHOT_TIMEOUT_MS = 800;
// If the background poll already captured a frame this recently, use it as-is
// and skip the on-demand grab entirely. The screen rarely changes between the
// applicant asking and us answering, so paying a round-trip to re-capture a
// near-identical frame is latency for nothing.
const SCREENSHOT_FRESH_ENOUGH_MS = 1500;
// Guiding someone through a form means eight-plus fields across many turns; at
// the old cap of 8 messages (~4 exchanges) the agent forgot what it had said at
// the top of the form and repeated itself.
const MAX_HISTORY = 24;

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
  // The single most useful thing we can tell them that the lender's own site
  // cannot: how their name is actually spelled on the ID the lender will
  // check it against.
  if (c.kycName) {
    lines.push(
      `THEIR NAME AS IT READS ON THEIR VERIFIED ID DOCUMENT: "${c.kycName}". UPSY has already read this off their ID, so it is reliable. ` +
        `Whenever a name field comes up, tell them to type it exactly this way — same spelling, same initials, same order. A name that differs ` +
        `from their ID stalls verification later, and the lender's form cannot warn them about this.`
    );
  }
  if (c.coApplicantKycName) {
    lines.push(`The co-applicant's name as it reads on their verified ID document: "${c.coApplicantKycName}". Same rule applies to co-applicant name fields.`);
  }
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

How to talk:
- SAY LESS THAN YOU WANT TO. You are on a live call and every sentence is time the applicant cannot speak. Two or three sentences, then stop.
- Do not open the call with an explanation of the process, a checklist, or device, camera, microphone or audio checks. Do not describe what you are about to do. Greet them, then wait for them to talk.
- Only raise a problem that is actually happening. Warnings about mistakes, defaults or things that commonly go wrong belong at the moment the applicant reaches that screen — never in advance, never bundled together. If nothing is wrong, say nothing about it.
- Answer THE THING THEY JUST SAID. Read the last thing the applicant said and respond to that specifically, not to the general topic and not to what you were explaining before. If they interrupt you or change subject, follow them.
- Never repeat a sentence you have already said in this call. If they did not hear you, say it a different way, shorter.
- Keep it to two or three sentences, conversational, no markdown, no bullet points, no symbols, no emojis. Spell numbers the way you would say them aloud.
- One step at a time. Do not read out a whole screen's worth of fields at once — help with the field they are on, then stop and let them act.
- If you genuinely do not know something, say so. Never invent a dropdown option, an accepted value, a timeline, or a policy. Ask them to read the options on screen aloud instead.

Working from the screen:
- The screenshot is taken at the moment they speak, but it can still be slightly behind them. If what they describe does not match what you see, believe them, not the image, and ask them to confirm which field they are on.
- If you cannot tell what is on screen, say so plainly and ask them to describe it rather than guessing.
- Do not read numbers off the screen and present them as fact — your reading of digits is not reliable. Reason from what the applicant tells you.

Handling data the lender's site fills in automatically — this matters more than anything else here:
- Partner lenders auto-fill fields from uploaded documents, and this has been confirmed to produce WRONG values in real use, including getting the applicant's own name wrong.
- Whenever fields populate themselves after an upload, tell the applicant to check every one of them before continuing, and to correct anything wrong. Say why: these details are stored permanently and the site has no way to catch its own mistake.
- Treat a checkbox that was already ticked for them the same way — pre-ticked defaults get skipped past. Ask directly whether the default is actually right for them.

Privacy — absolute, no exceptions:
- NEVER read back, repeat, transcribe, or ask them to confirm a PAN number, Aadhaar number, bank account number, or date of birth, even when it is plainly visible on screen. Describe which field to check and let them compare against their own document.
- Never tell the applicant what to type into a KYC field. Explain what the field is asking for; they enter their own data.

Honesty about progress:
- Never tell them something succeeded unless the screen clearly says so. Some screens look celebratory while the application is actually paused or waiting on someone else — read the words, not the illustration.
- When a step depends on another person or on something happening later, say that plainly so they know the application is not finished.${APPLICANT_CONTEXT}${buildLenderGuidancePrompt()}`;

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
  // process.stdout is a PIPE here, and writes to a pipe are asynchronous —
  // process.exit() throws away anything still queued. The failure phase is
  // written microseconds before this fires, so exiting immediately silently
  // discarded the very reason the call failed. Let the queue drain first.
  flushThenExit(code || 0);
});

function sendCommand(cmd) {
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

// Report what the bot is doing to whoever launched us (liveAssistManager),
// which surfaces it in the UI. Without this the dashboard could only say
// "in progress" from the moment the process spawned, so an applicant watching
// an empty meeting had no way to tell joining-in-progress from nothing-working.
// Logs stay on stderr; stdout carries only these machine-readable lines.
function emitPhase(phase, detail) {
  process.stdout.write(JSON.stringify({ type: "phase", phase, detail: detail || null }) + "\n");
}

// Exit only once queued stdout has actually reached the parent. write()'s
// callback fires on flush; the timer is a backstop so a stuck pipe can never
// keep this process alive.
function flushThenExit(code) {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    process.exit(code);
  };
  setTimeout(go, 300).unref?.();
  process.stdout.write("", go);
}

// Turn the bridge's raw API error into something the person staring at the
// screen can act on. The credits case is the one that actually bites: the
// free tier is a one-time pool, so it runs out mid-project and every call
// then fails instantly for a reason no one can guess from the UI.
function friendlyStartError(message) {
  const m = String(message || "");
  if (/insufficient credits|402/i.test(m)) {
    return "AgentCall is out of credits, so the bot cannot join any meeting. Top up at app.agentcall.dev/add-credits.";
  }
  if (/401|403|unauthor|invalid.*key/i.test(m)) {
    return "AgentCall rejected the API key. Check AGENTCALL_API_KEY or ~/.agentcall/config.json.";
  }
  if (/concurren|already.*active|limit/i.test(m)) {
    return "AgentCall refused a second simultaneous call — the plan allows only one at a time.";
  }
  return m.slice(0, 200) || "The call could not be started.";
}

let latestScreenshot = null; // data URL, refreshed on a timer
let latestScreenshotAt = 0; // ms epoch of that frame, so we can judge staleness
let history = []; // [{role, content}], capped at MAX_HISTORY
let screenshotTimer = null;
const humanParticipants = new Set();
let everHadHuman = false;
// Set when the applicant talks over the bot; consumed by the next reply.
let lastReplyWasInterrupted = false;
// Monotonic turn counter. Generating a reply takes seconds (a fresh screenshot
// grab, then the model call), and nothing stops the applicant speaking again
// inside that window — so two replies could be in flight at once, both get
// spoken, and the stale one lands first. Each turn records its number; a reply
// is only spoken if its turn is still the newest. `inFlight` lets a new turn
// abort the superseded request instead of paying for a reply nobody will hear.
let currentTurn = 0;
let inFlight = null; // AbortController for the reply currently being generated
// request_id -> { resolve, timer }, for screenshots grabbed on demand rather
// than picked up from the background poll.
const pendingScreenshots = new Map();

// Ask for a screenshot NOW and wait briefly for it. Form guidance is only as
// good as the frame it is based on: with the 5s background poll alone, an
// applicant who moves to the next field while asking "what goes here?" gets an
// answer about the *previous* field. Falls back to the polled frame on timeout
// so a slow grab degrades instead of blocking.
function requestFreshScreenshot() {
  // Cheap path first: the poll may have just captured this exact screen.
  if (latestScreenshot && Date.now() - latestScreenshotAt < SCREENSHOT_FRESH_ENOUGH_MS) {
    return Promise.resolve(latestScreenshot);
  }
  return new Promise((resolve) => {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      pendingScreenshots.delete(id);
      resolve(null);
    }, FRESH_SCREENSHOT_TIMEOUT_MS);
    pendingScreenshots.set(id, { resolve, timer });
    sendCommand({ command: "screenshot", request_id: id });
  });
}

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
    case "call.bot_waiting_room":
      emitPhase("waiting_room");
      break;

    case "call.bot_ready":
      console.error("[liveAssist] bot ready, waiting for a participant");
      emitPhase(humanParticipants.size ? "connected" : "in_meeting");
      break;

    case "participant.joined":
      if (event.name && event.name.toLowerCase() !== BOT_NAME.toLowerCase()) {
        humanParticipants.add(event.name);
        everHadHuman = true;
        emitPhase("connected", event.name);
      }
      break;

    case "participant.left":
      if (event.name) humanParticipants.delete(event.name);
      if (everHadHuman && humanParticipants.size === 0) {
        emitPhase("ending");
        sendCommand({ command: "leave" });
      }
      break;

    case "greeting.prompt":
      sendCommand({
        command: "tts.speak",
        // Says out loud that we can see the shared screen. Not full DPDP
        // consent (that's a Phase 2 item), but the applicant should not be
        // surprised that a screenshot is being looked at.
        // Deliberately two short sentences. A longer opening meant the
        // applicant sat through a speech before they could say what they
        // needed, and TTS plays each sentence separately so length is felt.
        // Screen visibility is still disclosed — that part is not optional.
        text:
          `Hi ${event.participant || "there"}, I am ${BOT_NAME}. ` +
          `Share your screen when you are ready — I can see it — and tell me what you are stuck on.`,
      });
      if (!screenshotTimer) {
        screenshotTimer = setInterval(
          () => sendCommand({ command: "screenshot", request_id: `poll-${Date.now()}` }),
          SCREENSHOT_INTERVAL_MS
        );
      }
      break;

    case "tts.done":
      emitPhase("listening");
      break;

    case "user.message":
      emitPhase("thinking");
      await respondTo(event.text);
      break;

    case "screenshot.result": {
      const dataUrl = event.data ? `data:image/jpeg;base64,${event.data}` : null;
      if (dataUrl) {
        latestScreenshot = dataUrl;
        latestScreenshotAt = Date.now();
      }
      const pending = event.request_id && pendingScreenshots.get(event.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingScreenshots.delete(event.request_id);
        pending.resolve(dataUrl);
      }
      break;
    }

    // The applicant started talking over us. Record it so the next reply can
    // acknowledge that they cut in rather than ploughing on as if the whole
    // sentence had landed.
    case "tts.interrupted":
      lastReplyWasInterrupted = true;
      console.error("[liveAssist] speech interrupted by the applicant");
      break;

    // Fires ~5 minutes before the plan's hard call limit. Left unhandled, the
    // call simply dies mid-sentence with no explanation to the applicant.
    case "call.max_duration_warning":
      console.error("[liveAssist] max duration warning — call will end soon");
      sendCommand({
        command: "tts.speak",
        text:
          "Quick heads up, this call will end automatically in about five minutes because of a time limit on my end. " +
          "If we are mid-way through something, finish the field you are on and we can start a fresh call to carry on.",
      });
      break;

    // Server-side problem, not the applicant's. Log loudly; do not alarm them
    // mid-call about our billing.
    case "call.credits_low":
      console.error("[liveAssist] ⚠️ AgentCall credits are low — live-assist calls will start failing soon");
      break;

    // The bridge reports a failed call creation here and then exits. Without
    // this case the event fell through to default and was swallowed, so an
    // out-of-credits or bad-key failure looked identical to "nothing
    // happened" — the UI just snapped back to idle with no reason given.
    case "error":
      console.error("[liveAssist] bridge error:", event.message);
      emitPhase("failed", friendlyStartError(event.message));
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
// duplicate sentences before they ever reach tts.speak. Both helpers live in
// backend/sentences.js so they can be unit-tested — this file spawns the
// AgentCall bridge on import and cannot be loaded from a test.

async function respondTo(text) {
  if (!text || !text.trim()) return;

  // Claim this turn and cancel whatever was still being generated for the
  // previous one — the applicant has moved on, so that answer is now stale.
  const myTurn = ++currentTurn;
  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;

  // Push the user's words even if this turn gets superseded: the next turn's
  // context should still show everything they said, in the order they said it.
  history.push({ role: "user", content: text });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  // Grab the screen as it is at the moment they asked, not up to five seconds
  // ago — on a form, that gap is often a whole field.
  const fresh = await requestFreshScreenshot();
  if (myTurn !== currentTurn) return; // they spoke again while we waited
  const shot = fresh || latestScreenshot;

  const latestUserContent = [{ type: "text", text }];
  if (shot) {
    latestUserContent.push({ type: "image_url", image_url: { url: shot } });
  }

  // Tell the model it was cut off, so it answers what they actually said
  // instead of finishing its previous thought.
  const turnNotes = [];
  if (lastReplyWasInterrupted) {
    turnNotes.push(
      "(The applicant spoke over your last reply, so they may not have heard all of it. Answer what they just said. " +
        "Do not repeat your previous answer unless they ask you to.)"
    );
  }
  if (!shot) {
    turnNotes.push("(No screenshot is available this turn — do not describe the screen; ask them what they can see.)");
  }
  lastReplyWasInterrupted = false;
  if (turnNotes.length) latestUserContent.push({ type: "text", text: turnNotes.join(" ") });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(0, -1),
    { role: "user", content: latestUserContent },
  ];

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      // Low temperature on purpose: explaining what a form field wants should
      // be near-deterministic. Creative variation is not a feature here.
      // Streamed so the first sentence can be spoken while the rest is still
      // being written. Waiting for the whole reply meant several seconds of
      // silence on every turn, which reads as the bot having not heard them.
      body: JSON.stringify({ model: OR_MODEL, temperature: 0.1, max_tokens: 220, messages, stream: true }),
      signal: controller.signal,
    });
    if (myTurn !== currentTurn) return;
    if (!res.ok) {
      console.error(`[liveAssist] OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      sendCommand({ command: "tts.speak", text: "Sorry, I had trouble just now. Could you say that again?" });
      return;
    }

    let buffer = ""; // not-yet-complete sentence
    let sseTail = ""; // partial SSE line across chunks
    let spokenSoFar = []; // sentences already sent to TTS, in order
    let lastSpoken = "";

    // Speak one sentence, unless it repeats the previous one. The whole-reply
    // dedupe cannot run here because sentences leave one at a time, so the
    // same "don't say it twice" rule is applied incrementally instead.
    const speak = (sentence) => {
      if (!sentence || sentence.toLowerCase() === lastSpoken.toLowerCase()) return;
      if (!spokenSoFar.length) emitPhase("speaking");
      lastSpoken = sentence;
      spokenSoFar.push(sentence);
      sendCommand({ command: "tts.speak", text: sentence });
    };

    for await (const chunk of res.body) {
      // Stop mid-stream the moment this turn is superseded, so a stale answer
      // is never half-spoken over the applicant's new question.
      if (myTurn !== currentTurn) return;
      sseTail += Buffer.from(chunk).toString("utf8");
      const lines = sseTail.split("\n");
      sseTail = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        } catch {
          continue; // keep-alive or a fragment we cannot use yet
        }
        if (!delta) continue;
        buffer += delta;
        const { sentences, rest } = takeCompleteSentences(buffer);
        buffer = rest;
        for (const s of sentences) speak(s);
      }
    }

    if (myTurn !== currentTurn) return;
    // Stream is done, so anything still buffered is the final sentence — this
    // is the only point at which end-of-buffer may be treated as a full stop.
    for (const s of takeCompleteSentences(buffer, { flush: true }).sentences) speak(s);

    const reply = spokenSoFar.join(" ").trim();
    if (!reply) {
      sendCommand({ command: "tts.speak", text: "Sorry, I did not catch that. Could you repeat it?" });
      return;
    }
    history.push({ role: "assistant", content: reply });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  } catch (e) {
    // An abort is us superseding ourselves, not a failure — stay quiet.
    if (e.name === "AbortError" || myTurn !== currentTurn) return;
    console.error("[liveAssist] request failed:", e.message);
    sendCommand({ command: "tts.speak", text: "Sorry, something went wrong on my end. Could you say that again?" });
  } finally {
    if (inFlight === controller) inFlight = null;
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
