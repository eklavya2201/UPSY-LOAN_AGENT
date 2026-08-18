// UPSY's own voice agent: browser ⇄ this relay ⇄ STT + Claude + TTS.
//
// This is the thing a hosted voice vendor actually sells. Cartesia's own stack
// is Sonic (TTS) + Ink (STT) + Line (turn-taking) with *your* LLM key doing the
// thinking — so what we are replacing is speech and turn-taking, not
// intelligence, which was never theirs. See "Own the voice stack" in the README.
//
//     mic → AudioWorklet → PCM ──WS──►  voiceRelay.js (here)
//                                          ├─► voiceStt.js    Deepgram, turn detection
//                                          ├─► voiceBrain.js  Claude Haiku 4.5
//                                          └─► voiceTts.js    Cartesia Sonic
//     speaker ◄── PCM ◄──WS─────────────────┘
//
// ── The load-bearing constraint ─────────────────────────────────────────────
// frontend/voiceClient.js MUST NOT CHANGE. It only knows "PCM over a WebSocket",
// which is the whole reason the provider swap is cheap. So this file speaks the
// client's existing vocabulary exactly — start / ack / media_input /
// media_output / clear — rather than inventing a nicer protocol. If you find
// yourself editing the browser to accommodate the server, the abstraction was
// wrong and that is worth knowing early.
//
// One genuine upgrade falls out of owning this: we have the caller's words as
// text. `/m`'s constellation was built to spotlight the topic being discussed
// and had to settle for a timed rotation because Cartesia only ever sent audio.
// The `transcript` event below is what voice-agent.js's matchTopic() has been waiting for.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { makeStt, sttConfigured, sttConfigError } from "./voiceStt.js";
import { makeTts, ttsConfigured, ttsConfigError, ttsStatusLine, cacheablePhrases, prewarmPhrases, TTS_SAMPLE_RATE } from "./voiceTts.js";
import { speakReply, brainConfigured, brainConfigError, brainStatusLine, MAX_HISTORY } from "./voiceBrain.js";
import { pickAcknowledgement, allFixedPhrases } from "./voiceFillers.js";
import { stretchGaps } from "./voicePacing.js";
import { recordCall, mergeProfile } from "./voiceAccounts.js";
import { buildIntroduction, buildVoiceSystemPrompt } from "./voicePrompt.js";
import { fileCall, extractCallFacts, mergedProfile, fastAnswerPatch } from "./callExtract.js";
import { agendaSnapshot, matchAgendaField, isConfidentMatch, deriveAll, getField } from "./callSchema.js";
import { readAnswer } from "./fastAnswer.js";
import { verifyInstitute, claimKey } from "./instituteVerify.js";

// Register the lines the agent repeats across calls, so each is synthesised once
// and replayed thereafter. The anonymous opener qualifies because it is a fixed
// string; a personalised greeting ("Hi Aarav, this is UPSY again") is unique per
// caller and is deliberately left out. See the phrase cache in voiceTts.js.
// Every fixed line, in every language, registered as cacheable so that whichever
// ones actually get spoken are bought once rather than per call.
cacheablePhrases([buildIntroduction(null), ...allFixedPhrases()]);

/**
 * Buy the repeated English lines once, at boot, so no caller waits for them.
 *
 * English only, taken from the buckets by language rather than guessed from the
 * text: the Hindi acknowledgements cannot be spoken until Sarvam exists, and
 * synthesising them in an English voice is paying for audio that will never be
 * played. A first attempt filtered by regex, silently matched nothing, and
 * bought all twelve Hindi lines.
 */
export function warmVoiceCache() {
  return prewarmPhrases([buildIntroduction(null), ...allFixedPhrases("en")]);
}


export const RELAY_PATH = "/voice/stream";

// Must match SAMPLE_RATE in frontend/voiceClient.js. The client labels its
// frames pcm_44100 and resamples if the browser refuses that rate, so by the
// time audio reaches us it is always 44.1kHz — no resampling anywhere in the
// pipeline, in either direction.
export const SAMPLE_RATE = 44100;

// Echo mode is the roadmap's step 1 and stays in the file on purpose: it proves
// the transport independently of every AI provider, so when a call is broken you
// can answer "is it us or is it them?" in one env var.
//
// Read per call rather than captured at import, so the preflight can exercise
// both modes in one process without cache-busting the module.
function relayMode() {
  return (process.env.VOICE_RELAY_MODE || "agent").toLowerCase();
}

// A call that never hangs up bills forever. Ten minutes is well past a real
// enquiry and well short of a stuck socket costing real money overnight.
const MAX_CALL_MS = Number(process.env.VOICE_MAX_CALL_MS || 10 * 60 * 1000);

// Breathing room between sentences.
//
// Cartesia's voices run 195–209 words/min and its speed controls are inert on
// sonic-2 (measured — see voiceTts.js), against a conversational norm of
// 140–160. The agent genuinely does talk too fast, and a real listener noticed
// before anyone measured it. We cannot slow the synthesis, but we own the
// stream, so we insert the pause a person would leave at a full stop. It costs
// nothing, changes no pitch, and drops the effective rate into a normal range.
const SENTENCE_PAUSE_MS = Number(process.env.VOICE_SENTENCE_PAUSE_MS || 280);

// How many recognised words it takes to interrupt the agent. Two is enough to
// reject stray echo without making a real interruption feel unresponsive; one
// would let a leaked "yes" or "okay" from the agent's own speech cut it off.
const BARGE_IN_MIN_WORDS = Number(process.env.VOICE_BARGE_IN_MIN_WORDS || 2);

// ⚠️ OFF (0). This shipped at 110ms and made the agent stutter mid-word on real
// calls, on a laptop and a phone alike — the per-chunk gap detector cannot tell
// a pause between words from a quiet moment inside one in a ~130ms window, so
// it spliced silence into the middle of speech. Full post-mortem at the top of
// backend/voicePacing.js. An agent that talks slightly fast is fine; an agent
// that sounds like a bad line is not.
//
// Pacing that IS on: the between-sentence pause below, which is safe because a
// sentence boundary is a place we actually know about rather than one we guess.
const PACE_EXTRA_MS = Number(process.env.VOICE_PACE_EXTRA_MS || 0);

// How often the call is read into the caller's file while it is still running.
//
// Every finished call is extracted at teardown regardless; this is about how
// often the dashboard AND the caller's own /m screen see the branches fill in.
// Every caller turn. Six was the original, three followed once the map became
// something a caller watches, and one is where real testing put it: the gap
// between "they answered" and "the agenda knows" is the window in which the
// agent asks the same question twice, and every turn of cadence is another
// turn of that window.
//
// The cost of this is close to nothing — an extra small-model call per turn,
// roughly a tenth of a US cent on a whole call — and it buys back the thing
// that made calls feel broken. `askedThisCall` in the relay covers the gap
// that remains, because even at every turn this is still a model call that
// lands after the next reply has started.
//
// It is safe to run inside a live call for one reason only: nothing awaits it.
// It is a separate request on a separate socket, started and abandoned — see
// captureFacts(). Set to 0 to extract at teardown and nowhere else.
const EXTRACT_EVERY_TURNS = Number(process.env.VOICE_EXTRACT_EVERY_TURNS ?? 1);

// ── Filing an answer with no model: OFF by default ──────────────────────────
// Built on the premise that matchAgendaField could tell us which field a
// question was about. It cannot, and two real calls proved it from both sides:
//
//   too loose — "You'll need your PAN card and Aadhaar card. Do you have it?"
//               shares the word "card" with "Has any card or loan already", so
//               a "Yes" about ID documents was filed as a credit history.
//   too tight — the agent is told to ask in its own words, so "What does your
//               father earn?" and "And his salary?" match nothing at all. The
//               question went unrecognised and was asked a second time.
//
// There is no threshold that fixes both: raising it loses the paraphrases,
// lowering it files wrong data. Attribution from free text is a language
// problem, and the extractor — which reads the question and the answer
// together — is the thing already good at it.
//
// The code stays because the mechanism is sound the moment attribution is:
// the reviewer's original suggestion was a FAST model classifying "which field
// was that?", which would make this safe. Until then it writes nothing.
//
// VOICE_FAST_ANSWER=1 turns it on for anyone measuring that work.
const FAST_ANSWER_ENABLED = process.env.VOICE_FAST_ANSWER === "1";

// ── "That's everything, thanks" ─────────────────────────────────────────────
// A caller who is finished should not have to hunt for the End button, and a
// call left open bills for silence. Only unmistakable sign-offs count: a bare
// "no" or "nahi" is an ANSWER to whatever was just asked, not the end of a
// call, and treating it as one would hang up on people mid-conversation.
// Everything here has to be a phrase somebody says when they are leaving.
const CLOSING_INTENT = new RegExp(
  [
    "\\bnothing (?:from my side|else|more)\\b",
    "\\bno (?:more|further|other) (?:questions?|doubts?)\\b",
    // Must END the sentence. "That's all the money we have saved" is a normal
    // thing to say about a down payment, and hanging up on it would be awful.
    "\\bthat(?:'?s| is) (?:all|it|everything)\\b(?=\\s*(?:$|[.,!?]|thanks?\\b|thank you\\b|bye\\b|for now\\b|then\\b))",
    "\\b(?:i am|i'?m|we(?:'?re| are)|all) done\\b",
    "\\b(?:good\\s?bye|bye bye|bye)\\b",
    "\\bthank(?:s| you)[, ]+(?:bye|that(?:'?s| is) all)\\b",
    // Hindi/Hinglish, as spoken: "bas itna hi", "ho gaya", "theek hai bye".
    "\\bbas (?:itna|itni) hi\\b",
    "\\bho gaya\\b",
    "\\bkuch nahi(?: chahiye)?\\b",
  ].join("|"),
  "i"
);

// How long to let the goodbye actually reach the caller before the socket goes.
// The speech chain settles when SYNTHESIS finishes, which is not when playback
// finishes — the browser is still draining its buffer. Closing on the former
// cuts the agent off mid-word, which is a worse ending than no ending. Generous
// on purpose: these seconds are the last thing the caller experiences.
const GOODBYE_GRACE_MS = 2500;

// Silent PCM at the pipeline's one and only sample rate. Int16 zeroes.
function silence(ms) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

// Tickets are minted by POST /api/voice/session and redeemed here. Short-lived
// and single-use for the same reason the Cartesia path minted scoped tokens: the
// URL reaches the browser, so it must be worthless the moment it is used.
const TICKET_TTL_MS = 5 * 60 * 1000;
const tickets = new Map();

export function mintRelayTicket(payload) {
  const token = randomUUID();
  tickets.set(token, { ...payload, expiresAt: Date.now() + TICKET_TTL_MS });

  // Opportunistic sweep. Tickets are tiny, but an endpoint anyone can hit should
  // never accumulate unbounded state just because nobody redeemed them.
  if (tickets.size > 200) {
    const now = Date.now();
    for (const [k, v] of tickets) if (v.expiresAt < now) tickets.delete(k);
  }
  return token;
}

function redeemTicket(token) {
  const ticket = tickets.get(token);
  if (!ticket) return null;
  tickets.delete(token); // single use
  if (ticket.expiresAt < Date.now()) return null;
  return ticket;
}

export function relayConfigured() {
  return brainConfigured() && ttsConfigured();
}

// What is missing, specifically — the same reasoning as voiceCall.js's
// voiceConfigError(): a bare "not configured" sends whoever hits this hunting
// through the README.
export function relayConfigError() {
  if (relayMode() === "echo") return null; // echo needs no provider at all
  return brainConfigError() || ttsConfigError();
}

export function relayStatusLine() {
  if (relayMode() === "echo") return "Voice relay: ECHO MODE (transport only, no AI)";
  const hear = sttConfigured() ? "Deepgram" : "DEAF (no DEEPGRAM_API_KEY)";
  const speak = ttsConfigured() ? ttsStatusLine() : "MUTE (no TTS key)";
  return `Voice relay: ${hear} → ${brainStatusLine()} → ${speak}`;
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (e) {
    /* socket died between the check and the write */
  }
}

/**
 * One live call. Owns the STT socket, the TTS socket, the conversation history
 * and the turn lifecycle, and tears all of it down exactly once.
 */
class RelayCall {
  constructor(ws, ticket) {
    this.ws = ws;
    this.ticket = ticket;
    this.streamId = null;
    this.stt = null;
    this.tts = null;
    this.history = [];
    // Turn serialisation, lifted from liveAssist.js's respondTo(): a caller who
    // speaks again mid-generation must abort the in-flight turn, not race it.
    // Two replies interleaving into one audio queue is unintelligible.
    this.turnSeq = 0;
    this.inFlight = null;
    this.speaking = false;
    this.closed = false;
    // A reply being generated before the turn is confirmed. See startSpeculation.
    this.spec = null;
    this.state = null;
    this.lastAck = null;
    // What is known about this caller so far, growing as extraction reads the
    // call. Starts from earlier calls (or empty for a stranger) and is what the
    // live agenda on /m is drawn from — for an account holder it tracks the
    // stored profile, for an anonymous caller it lives and dies with the call.
    this.profile = structuredClone(ticket.context?.priorFacts || {});
    // The call's transcript, kept so it can be filed against the caller's
    // account when they hang up. Only what was actually said — this is the same
    // text the browser already receives, not a recording: no audio is written
    // anywhere, on this path or any other.
    this.turns = [];
    // Caller turns only, and only for deciding when to read the call into the
    // file mid-way. The agent's own lines do not establish facts about anyone.
    this.callerTurns = 0;
    // "branch.field" for every question the agent has actually asked aloud on
    // this call. Per-call and never persisted: on the next call the extractor
    // has long since caught up, and a stale entry would silence a question
    // that genuinely still needs asking.
    this.askedThisCall = new Set();
    // Set when the caller signs off, cleared the moment they speak again —
    // "that's all" followed by one more question is a normal thing to do.
    this.callerSaidDone = false;
    // The field the agent's last sentence asked about, so the next thing the
    // caller says can be read as the answer to it. See fastAnswer.js.
    this.pendingAsk = null;
    this.extracting = false;
    this.queuedCapture = null;
    // Everything spoken goes through one chain. The TTS socket carries a single
    // context at a time, so two overlapping speak() calls would cut each other
    // off — and the acknowledgement is deliberately spoken WHILE the model is
    // still generating, which is exactly the overlap that would break it.
    this.speechChain = Promise.resolve();
    this.startedAt = Date.now();
    this.timeout = setTimeout(() => this.stop("call exceeded the maximum duration"), MAX_CALL_MS);
  }

  log(message) {
    const who = this.ticket.leadId ? `lead ${this.ticket.leadId}` : "anonymous";
    console.log(`[voice:relay] (${who}) ${message}`);
  }

  // ── Protocol ──────────────────────────────────────────────────────────────

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // the client only ever sends JSON; anything else is not ours
    }

    switch (msg.event) {
      case "start":
        this.handleStart(msg);
        break;
      case "media_input":
        this.handleAudio(msg);
        break;
      case "stop":
        this.stop("client asked to stop");
        break;
      default:
        break;
    }
  }

  handleStart(msg) {
    if (this.streamId) return; // already started; ignore a duplicate
    this.streamId = msg.stream_id || randomUUID();

    const format = msg.config?.input_format;
    if (format && format !== `pcm_${SAMPLE_RATE}`) {
      // Not fatal — but mislabelled audio makes the caller sound slow and deep
      // to the recogniser, which is a miserable thing to debug from a live call.
      this.log(`⚠️ client announced input_format=${format}, expected pcm_${SAMPLE_RATE}`);
    }

    send(this.ws, { event: "ack", stream_id: this.streamId });
    this.log(`call started (${relayMode()} mode)`);

    if (relayMode() === "echo") return; // nothing else to set up

    this.startAgent().catch((e) => {
      console.error("[voice:relay] could not start the agent:", e.message);
      send(this.ws, { event: "error", message: "UPSY could not start the call. Please try again." });
      this.stop("agent failed to start");
    });
  }

  async startAgent() {
    this.tts = makeTts({
      language: this.ticket.language || "en",
      onError: (m) => console.error(`[voice:relay] ${m}`),
    });

    this.stt = makeStt({
      sampleRate: SAMPLE_RATE,
      language: this.ticket.language || "en",
      // Names and institutes this particular caller is likely to say. Cheap, and
      // proper nouns are where the recogniser is weakest.
      keyterms: this.ticket.keyterms || [],
      onSpeechStarted: () => this.handleSpeechStarted(),
      onTranscript: (text) => {
        // Barge-in is decided HERE, on real recognised words — not on the raw
        // voice-activity event below.
        //
        // A caller on speakerphone leaks the agent's own voice back into the
        // mic. That leak fires VAD constantly, so barging in on VAD alone made
        // the agent interrupt *itself*: it would say two or three words, cut
        // its own reply, flush the queue, and go silent. From the caller's side
        // that is "she said yes and then stopped" — reported from a real call,
        // and the reason this check is not simply `if (speaking) barge`.
        //
        // Requiring several recognised words is a cheap, robust filter: echo
        // suppression in the browser mangles the leaked audio enough that it
        // rarely survives as clean multi-word text, while a person actually
        // interrupting always does.
        if (this.speaking && text && text.trim().split(/\s+/).length >= BARGE_IN_MIN_WORDS) {
          this.handleBargeIn(text);
        }
        // Always final:false, even for a Deepgram result marked is_final.
        // Deepgram's "final" means "this fragment will not change"; a turn is
        // usually several such fragments. Forwarding them as final made a
        // listener that concatenates finals see every sentence twice — once as
        // a fragment, once in the assembled turn below. `final` on this wire
        // means "the caller finished a thought", and only handleTurn says that.
        send(this.ws, { event: "transcript", role: "caller", text, final: false });
      },
      onEagerTurn: (text) => this.startSpeculation(text),
      onTurn: (text) => this.handleTurn(text),
      onError: (m) => console.error(`[voice:relay] ${m}`),
    });

    // Tell the page what this call is here to establish, before a word is
    // spoken: the branch map with what is already on file lit up. This is what
    // turns /m's constellation from a hardcoded topic ring into the loan file.
    this.sendAgenda();

    // Speak first. Beyond being the right conversational move, this is what
    // proves the audio round trip: voiceClient.js treats a socket that closes
    // before any audio arrived as a failed call rather than a hang-up.
    this.setState("speaking");
    this.turns.push({ role: "agent", text: this.ticket.introduction, at: new Date().toISOString() });
    await this.speak(this.ticket.introduction, null);
    this.setState("listening");

    if (this.stt?.deaf) {
      // Say it out loud rather than letting the caller talk into silence. A
      // greeting followed by nothing is indistinguishable from a broken line,
      // and someone tested this by hand and reasonably concluded it was broken.
      // The prompt's own honesty rule applies to the agent's own limitations:
      // never imply it is doing something it cannot do.
      this.log("⚠️ no STT configured — telling the caller UPSY cannot hear them");
      await this.speakSentence(
        "I should be honest with you though. My hearing is not switched on yet, so I cannot listen to you on this call. " +
          "Tap Schedule call and someone from UPSY will ring you back.",
        null
      );
      send(this.ws, {
        event: "notice",
        text: "UPSY can speak but cannot hear yet — DEEPGRAM_API_KEY is not set on the server.",
      });
    }
  }

  handleAudio(msg) {
    const payload = msg.media?.payload;
    if (typeof payload !== "string") return;

    if (relayMode() === "echo") {
      // Straight back out. If the caller hears themselves, the transport,
      // the codec, the framing and the playback queue are all proven, and
      // anything still broken is above this line.
      send(this.ws, { event: "media_output", media: { payload } });
      return;
    }

    const pcm = Buffer.from(payload, "base64");
    this.stt?.write(pcm);
  }

  // ── Turn taking ───────────────────────────────────────────────────────────

  // Tell the page what the agent is doing, so it can show it. Cheap, and it is
  // the difference between "thinking" and "this call has frozen" — which, on a
  // brain that needs 1.4–2s to produce a first sentence, is the entire
  // difference in how the wait feels.
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    send(this.ws, { event: "state", state });
  }

  // Send a finished line to the page AND keep it. One helper rather than a
  // `send` next to a `push` at each of the four places the agent speaks: those
  // two had already drifted apart once (the acknowledgement was emitted to the
  // page but never entered the history), and a transcript missing the lines the
  // caller actually heard is worse than no transcript at all.
  sendAgentText(text) {
    if (!text) return;
    send(this.ws, { event: "transcript", role: "agent", text, final: true });
    this.turns.push({ role: "agent", text, at: new Date().toISOString() });

    // Spotlight the field this sentence is about, so the page lights the dot
    // for the question actually being asked. Cosmetic — a miss just leaves the
    // spotlight where it was, which is why a cheap word match is enough.
    const hit = matchAgendaField(text, this.profile);
    if (hit) {
      // The spotlight takes ANY match: a wrongly lit dot costs nothing, and a
      // dark map costs the caller their sense of the call going somewhere.
      send(this.ws, { event: "focus", branch: hit.branch, field: hit.field });

      // Everything below acts on the match rather than decorating with it, so
      // it needs a real one. One shared word is a coincidence in a domain where
      // "card", "loan", "income" and "year" are in half the questions — that is
      // how "You'll need your PAN card and Aadhaar card" came to be filed as
      // the applicant having a credit history.
      if (!isConfidentMatch(hit)) return;
      // ...and remember that we asked, which is NOT cosmetic. The extractor
      // runs behind the conversation, so between passes the agenda still lists
      // a field the caller just answered and the agent asks a second time —
      // the single complaint from real testing. This costs no model call and
      // no latency: the match already happened for the spotlight, and it is
      // the only signal available the instant a question leaves the agent's
      // mouth. A miss here is survivable in the same way it is for the
      // spotlight: worst case we are back to today's behaviour.
      this.askedThisCall.add(`${hit.branch}.${hit.field}`);
      // The question the caller is about to answer. Only the LAST match counts:
      // if the agent said two things, the one it finished on is the one they
      // are replying to.
      this.pendingAsk = { branch: hit.branch, field: hit.field };
    }
  }

  // The branch map with statuses — what is answered, pending, or ruled out —
  // plus the next question in flow order. Sent at call start and again after
  // every extraction pass, so the page draws the file filling in live.
  sendAgenda() {
    send(this.ws, { event: "agenda", agenda: agendaSnapshot(this.profile) });
  }

  // ── Speculative thinking ──────────────────────────────────────────────────
  // Deepgram will not confirm a turn until it has heard ~800ms of silence, and
  // the model then needs another 1.4–2s to produce a first sentence. Run those
  // in parallel instead of in series: the moment a fragment settles, start
  // generating a reply for it, but hold the sentences in a buffer rather than
  // speaking them. If the turn confirms with the same text, release the buffer
  // instantly — the model's latency has been spent inside the silence the
  // caller was going to sit through anyway. If they keep talking, throw it away.
  //
  // The cost is an occasional discarded generation, which on a cheap model is
  // worth far less than the second of dead air it removes.
  startSpeculation(text) {
    if (!text || this.closed) return;
    if (this.spec?.text === text) return; // already thinking about exactly this
    this.spec?.controller.abort();

    const controller = new AbortController();
    const spec = { text, controller, buffered: [], live: false, failed: false };
    this.spec = spec;
    this.setState("thinking");

    spec.promise = speakReply({
      systemPrompt: this.ticket.systemPrompt,
      history: [...this.history, { role: "user", content: text }],
      signal: controller.signal,
      onSentence: async (sentence) => {
        if (spec.live) {
          this.sendAgentText(sentence);
          await this.speak(sentence, controller.signal);
        } else {
          spec.buffered.push(sentence);
        }
      },
    }).catch((e) => {
      // Remember the failure rather than throwing into an un-awaited promise;
      // handleTurn falls back to a normal, non-speculative turn.
      if (e.name !== "AbortError" && !controller.signal.aborted) spec.failed = true;
      return "";
    });
  }

  discardSpeculation() {
    if (!this.spec) return;
    this.spec.controller.abort();
    this.spec = null;
  }

  // Raw voice activity. Deliberately does NOT cut the reply — see the note in
  // onTranscript. Kept because it is still the earliest signal that someone is
  // there, which is worth having for future tuning.
  handleSpeechStarted() {}

  handleBargeIn(heardText) {
    if (!this.speaking) return;
    // Two things have to happen and neither is sufficient alone: stop
    // generating and synthesising on our side, and tell the browser to throw
    // away what it has already buffered — otherwise the agent keeps talking
    // over the caller for as long as its playback queue is deep.
    this.log(`caller interrupted ("${heardText.slice(0, 40)}") — cutting the reply`);
    this.abortTurn();
    this.discardSpeculation();
    send(this.ws, { event: "clear" });
    this.setState("listening");
  }

  abortTurn() {
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
    this.speaking = false;
  }

  async handleTurn(text) {
    if (!text || this.closed) return;
    send(this.ws, { event: "transcript", role: "caller", text, final: true });
    // Recorded here and not in onTranscript: a turn is one finished thought,
    // whereas Deepgram's interim fragments are the same words several times
    // over, and a transcript full of half-sentences is not worth keeping.
    this.turns.push({ role: "caller", text, at: new Date().toISOString() });
    this.callerTurns++;
    if (EXTRACT_EVERY_TURNS > 0 && this.callerTurns % EXTRACT_EVERY_TURNS === 0) {
      // Not awaited, and deliberately fired here rather than after the reply:
      // the model is about to spend 1.5s writing a sentence, which is dead time
      // this can run inside. See captureFacts() for why it cannot block a turn.
      this.captureFacts("mid-call");
    }

    // Read the answer to the question we just asked, before anything else and
    // without a model. See fastAnswer.js for why this is narrow on purpose.
    this.fileFastAnswer(text);

    // They are talking, so whatever they said last turn was not the end of the
    // call after all. Cleared before the test below, never after.
    this.callerSaidDone = false;

    // Heard as they say it, acted on after the reply has been spoken — so the
    // agent still gets to answer and sign off rather than the line simply
    // dying on them. The flag is checked in the turn's `finally`.
    if (CLOSING_INTENT.test(text)) {
      this.callerSaidDone = true;
      this.log("caller signalled they were finished — will end the call after this reply");
    }

    // Fold in what we have already asked BEFORE generating this reply, rather
    // than waiting for the extraction above to come back. That pass is a model
    // call and lands a second or more later — which is the whole reason the
    // agent re-asks a question the caller has just answered. This rebuild is
    // string work against state we already have, so it costs nothing and is
    // always current at the moment the reply is written.
    if (this.askedThisCall.size) this.refreshPrompt(this.profile);

    // Did we already start thinking about exactly this during the silence?
    const spec = this.spec;
    const adopt = Boolean(spec && spec.text === text && !spec.failed && !spec.controller.signal.aborted);
    this.spec = null;
    if (!adopt) this.discardSpeculation();

    const myTurn = ++this.turnSeq;
    this.abortTurn();
    const controller = adopt ? spec.controller : new AbortController();
    this.inFlight = controller;

    // Push what they said even if this turn is later superseded: the next turn's
    // context should still show everything they said, in the order they said it.
    this.history.push({ role: "user", content: text });
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);

    this.speaking = true;
    this.setState("speaking");

    // Say something NOW, while the model is still thinking. Skipped when a
    // speculative reply is already written, because the real answer beats an
    // acknowledgement of it. Deliberately not awaited: the point is that this
    // plays while generation runs, and the speech queue keeps the ordering.
    if (!(adopt && spec.buffered.length)) {
      const ack = pickAcknowledgement(text, this.ticket.language, this.lastAck);
      if (ack) {
        this.lastAck = ack;
        this.sendAgentText(ack);
        this.speak(ack, controller.signal);
      }
    }

    try {
      if (adopt) {
        this.log(`adopted a speculative reply (${spec.buffered.length} sentence(s) ready before the turn confirmed)`);
        // Drain what is already written BEFORE going live, or a sentence
        // arriving mid-drain would be spoken ahead of one still queued. There is
        // no await between the loop exiting and `live = true`, so nothing can
        // slip in between.
        while (spec.buffered.length) {
          const sentence = spec.buffered.shift();
          if (myTurn !== this.turnSeq) break;
          this.sendAgentText(sentence);
          await this.speak(sentence, controller.signal);
        }
        spec.live = true;
        const spoken = await spec.promise;
        if (spoken && myTurn === this.turnSeq) this.history.push({ role: "assistant", content: spoken });
        return;
      }

      const spoken = await speakReply({
        systemPrompt: this.ticket.systemPrompt,
        history: this.history,
        signal: controller.signal,
        onSentence: async (sentence) => {
          if (myTurn !== this.turnSeq) return;
          this.sendAgentText(sentence);
          await this.speak(sentence, controller.signal);
        },
      });
      if (spoken && myTurn === this.turnSeq) {
        this.history.push({ role: "assistant", content: spoken });
      }
    } catch (e) {
      if (e.name !== "AbortError" && !controller.signal.aborted) {
        console.error("[voice:relay] turn failed:", e.message);
        // Say something rather than going silent — silence on a phone call is
        // indistinguishable from the line being dead.
        await this.speakSentence("Sorry, I lost that for a moment. Could you say it again?", null).catch(
          () => {}
        );
      }
    } finally {
      if (myTurn === this.turnSeq) {
        this.speaking = false;
        this.inFlight = null;
        this.setState("listening");
        if (this.callerSaidDone) this.endAfterGoodbye();
      }
    }
  }

  /**
   * Close the call once the sign-off has actually been heard.
   *
   * Waits on the speech chain rather than a timer alone, because the goodbye
   * may still be synthesising when the turn's `finally` runs. Then holds for
   * GOODBYE_GRACE_MS so the browser can drain what it has buffered.
   *
   * If the caller speaks again in the meantime they were not finished after
   * all — `callerSaidDone` is cleared by the next turn, and this bails. That
   * matters more than it looks: the alternative is hanging up on somebody who
   * said "that's all" and then thought of one more thing, which is exactly
   * when people remember the question that made them call.
   */
  endAfterGoodbye() {
    const turnAtRequest = this.turnSeq;
    this.speechChain
      .catch(() => {})
      .then(() => new Promise((r) => setTimeout(r, GOODBYE_GRACE_MS)))
      .then(() => {
        if (this.closed) return;
        if (!this.callerSaidDone || this.turnSeq !== turnAtRequest) return;
        this.stop("caller said they were finished");
      });
  }

  // Queue something to say. Returns a promise that settles when it has finished
  // being synthesised, so callers can apply backpressure — but callers that do
  // NOT await it (the acknowledgement) still get correct ordering.
  speak(text, signal) {
    this.speechChain = this.speechChain
      .then(() => this.speakSentence(text, signal))
      .catch((e) => {
        if (e?.name !== "AbortError") console.error("[voice:relay] speech failed:", e.message);
      });
    return this.speechChain;
  }

  async speakSentence(text, signal) {
    if (!text || !this.tts || this.closed) return;
    await this.tts.speak(
      text,
      (pcm) => {
        if (signal?.aborted || this.closed) return;
        // Slow her down. Cartesia runs 195-222 wpm and its own speed control is
        // inert on sonic-2, so the pacing is fixed here by lengthening the gaps
        // she already leaves between words — no pitch change, speech untouched.
        const paced = PACE_EXTRA_MS > 0 ? stretchGaps(pcm, { sampleRate: SAMPLE_RATE, extraMs: PACE_EXTRA_MS }) : pcm;
        send(this.ws, { event: "media_output", media: { payload: paced.toString("base64") } });
      },
      signal
    );
    // The pause goes into the audio stream rather than being a timer, so the
    // client's playback queue schedules it exactly like speech — a setTimeout
    // here would race the queue and land in the wrong place.
    if (SENTENCE_PAUSE_MS > 0 && !signal?.aborted && !this.closed) {
      send(this.ws, { event: "media_output", media: { payload: silence(SENTENCE_PAUSE_MS).toString("base64") } });
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * File the finished call against the caller's /m account.
   *
   * Fire-and-forget by design. stop() is synchronous and runs on socket close,
   * where there is nothing left to await into — and a disk write that fails must
   * never keep a call from tearing down, because a call that will not end holds
   * an STT socket, a TTS socket and a timer open.
   *
   * An anonymous caller has no account, so nothing is written at all. That is
   * the intended outcome, not a gap: with no account there is no one to show it
   * to and no next call to inform.
   */
  persist(seconds, reason) {
    if (!this.ticket.accountId || !this.turns.length) return;
    recordCall(this.ticket.accountId, {
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      seconds,
      endedBecause: reason,
      turns: this.turns,
    })
      .then((entry) => {
        if (entry) this.log(`saved ${this.turns.length} turns to account ${this.ticket.accountId}`);
      })
      .catch((e) => console.error("[voice:relay] could not save the call:", e.message));

    // Read the conversation into the caller's file. After recordCall rather
    // than inside it: the transcript is the record, and it must land even if
    // the extractor is unconfigured, rate-limited or wrong.
    this.captureFacts("call ended");
  }

  /**
   * Write the answer to the question we just asked, immediately and with no
   * model call.
   *
   * The extractor still runs and still sees this turn — this does not replace
   * it, it front-runs it for the one case that needs no intelligence: we asked
   * for a number, they said a number. Everything harder (facts nobody asked
   * for, corrections, conflicts, names) stays with the model, which is why
   * fastAnswer.js returns null far more often than it returns a value.
   *
   * Synchronous up to the point of persisting, so the agenda and the prompt
   * are correct for the reply being generated a few lines later. The store
   * write is fire-and-forget for the same reason every other write on this
   * path is: a live call must never wait on a disk.
   */
  fileFastAnswer(text) {
    if (!FAST_ANSWER_ENABLED) return;
    const ask = this.pendingAsk;
    if (!ask) return;
    // One shot per question. If they answer, we have it; if they said
    // something unparseable, a second sentence from the same person is more
    // likely to be a follow-on thought than a retry of the answer.
    this.pendingAsk = null;

    const field = getField(ask.branch, ask.field);
    if (!field) return;

    const read = readAnswer(field, text);
    if (!read) return; // the normal outcome — the extractor will handle it

    const result = fastAnswerPatch(this.profile, ask.branch, ask.field, read.value, read.quote);
    if (!result) return; // already answered; a correction is the model's job

    this.profile = result.profile;
    this.log(`filed "${field.label}" the moment it was said (no model): ${JSON.stringify(read.value)}`);

    // The caller is watching this map fill in, so it must not wait for a
    // round trip that may not even happen on an anonymous call.
    this.sendAgenda();
    send(this.ws, { event: "focus", branch: ask.branch, field: ask.field });

    if (this.ticket.accountId) {
      mergeProfile(this.ticket.accountId, result.patch, { replace: ["underwriting", "_flags"] }).catch((e) =>
        console.error("[voice:relay] could not persist a fast answer:", e.message)
      );
    }
  }

  /**
   * Rebuild the standing instructions against what is now known.
   *
   * Only the system prompt changes; `this.history` is left exactly as it is,
   * because rewriting what was already said would be rewriting the call. The
   * next turn is generated against the new prompt and the old conversation,
   * which is precisely the intended effect: same conversation, better-informed
   * agent. A rebuild that throws must never take the call down, so the old
   * prompt simply stays in place.
   */
  refreshPrompt(profile) {
    if (this.closed) return;
    try {
      const before = this.ticket.systemPrompt;
      // An anonymous caller has no context object, but what this call has
      // established still narrows the agenda and the document list mid-call.
      const rebuilt = buildVoiceSystemPrompt({
        ...(this.ticket.context || {}),
        priorFacts: profile,
        alreadyAsked: [...this.askedThisCall],
      });
      if (rebuilt && rebuilt !== before) {
        this.ticket.systemPrompt = rebuilt;
        this.log("re-aimed: the agenda and the document list now match what this call has established");
      }
    } catch (e) {
      console.error("[voice:relay] could not rebuild the prompt mid-call:", e.message);
    }
  }

  /**
   * Turn what has been said so far into branch facts on the caller's account.
   *
   * ── Why this can run during a live call ───────────────────────────────────
   * Nothing awaits it. It is started and abandoned, on its own socket, and the
   * only thing it touches on the way back is the account file. The relay's
   * latency budget is spent on hearing → thinking → speaking; this sits beside
   * that chain, never in it. Only one pass runs at a time, because the model can
   * take longer than six more caller turns on a slow day and two passes over the
   * same transcript would race each other into the same record for no benefit.
   *
   * A request arriving while one is in flight is QUEUED, not dropped — the
   * teardown pass is the important one and it is precisely the one that would
   * collide with a mid-call pass that has not come back yet. Only the latest is
   * kept: they all read the same growing transcript, so the newest request
   * covers everything the ones behind it would have.
   *
   * Anonymous callers write nothing, same as the transcript: no account, nobody
   * to show it to, and no next call to inform.
   */
  captureFacts(reason) {
    const accountId = this.ticket.accountId;
    // For an anonymous caller a teardown pass has no store to write to and no
    // page left to light up — mid-call passes are the only ones worth running.
    if (!accountId && this.closed) return;
    if (this.extracting) {
      this.queuedCapture = reason;
      return;
    }
    // Snapshot: the array keeps growing while the model reads it, and an
    // extraction should describe a fixed transcript rather than a moving one.
    const turns = this.turns.slice();
    if (!turns.some((t) => t.role === "caller")) return;

    this.extracting = true;
    const read = accountId
      ? fileCall({ accountId, turns, reason }).then((result) => {
          if (result?.summary) this.log(result.summary);
          return result?.profile || null;
        })
      : // No account: extract without persisting, so the live agenda and the
        // mid-call narrowing still work. Nothing is stored — same rule as the
        // transcript: no account, no record.
        extractCallFacts({ turns }).then((extraction) => {
          if (!extraction) return null;
          const gotFacts = Object.keys(extraction.facts || {}).length > 0;
          const gotDeclined = (extraction.declined || []).length > 0;
          if (!gotFacts && !gotDeclined) return null;
          const merged = mergedProfile(this.profile, extraction.facts);
          if (gotDeclined) {
            merged._declined = [...new Set([...(this.profile._declined || []), ...extraction.declined])];
          }
          return merged;
        });

    read
      .then((profile) => {
        if (!profile) return;
        this.profile = mergedProfile(this.profile, profile);
        // Re-aim the agent at what is still missing, and at the shorter
        // document list the new facts imply. Cheap (a pure rebuild, no
        // network) and it is what makes the narrowing happen inside the call
        // rather than only on the next one. The conversation history is
        // untouched — only the standing instructions change.
        this.refreshPrompt(this.profile);
        if (!this.closed) this.sendAgenda();
        this.checkInstitute();
      })
      .catch((e) => console.error("[voice:relay] extraction pass failed:", e.message))
      .finally(() => {
        this.extracting = false;
        const queued = this.queuedCapture;
        this.queuedCapture = null;
        if (queued) this.captureFacts(queued);
      });
  }

  /**
   * The false-info check: is the institute/course the caller named real?
   *
   * Fires after an extraction pass, once per distinct claim per call, and —
   * like the extraction itself — nothing awaits it. The verdict goes to the
   * officer as a flag (`course_not_found`, and `fee_deviation` when a
   * published fee is found); it is deliberately NOT put in front of the agent,
   * which must never accuse a caller of naming a course that does not exist.
   * See instituteVerify.js for the full reasoning.
   */
  checkInstitute() {
    const inst = this.profile?.institute;
    if (!inst?.name) return;
    const key = claimKey(inst);
    if (this.checkedClaim === key) return;
    this.checkedClaim = key;

    // The quoted fee is deliberately not passed: the judge used to be shown it
    // and handed it straight back as the "published" figure, which makes
    // fee_deviation compare a number with itself. See instituteVerify.js.
    verifyInstitute({ name: inst.name, course: inst.course })
      .then((verdict) => {
        if (!verdict) return;
        this.log(`online check: "${inst.name}" → ${verdict.status}${verdict.feeVerifiedOnline ? ` (published fee ₹${verdict.feeVerifiedOnline.toLocaleString("en-IN")})` : ""}`);

        const patch = { _verification: verdict };
        if (verdict.feeVerifiedOnline) patch.institute = { feeVerifiedOnline: verdict.feeVerifiedOnline };
        this.profile = mergedProfile(this.profile, patch);

        // Flags are recomputed wholesale from the merged profile — the same
        // replace-not-merge rule fileCall applies, for the same reason.
        const { underwriting, flags } = deriveAll(this.profile);
        this.profile.underwriting = underwriting;
        this.profile._flags = flags;

        if (this.ticket.accountId) {
          mergeProfile(this.ticket.accountId, { ...patch, underwriting, _flags: flags }, { replace: ["underwriting", "_flags", "_verification"] })
            .catch((e) => console.error("[voice:relay] could not store the online check:", e.message));
        }
      })
      .catch((e) => console.error("[voice:relay] online check failed:", e.message));
  }

  stop(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timeout);
    this.abortTurn();
    this.discardSpeculation();
    try {
      this.stt?.close();
    } catch (e) {
      /* noop */
    }
    try {
      this.tts?.close();
    } catch (e) {
      /* noop */
    }
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    this.log(`call ended after ${seconds}s (${reason})`);
    this.persist(seconds, reason);
    if (this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch (e) {
        /* noop */
      }
    }
  }
}

/**
 * Mount the relay on the existing HTTP server.
 *
 * `noServer` rather than letting ws own a port: the relay has to be reachable on
 * the same origin as the page, because Render gives us exactly one port and a
 * second listener would not survive deployment.
 */
export function attachVoiceRelay(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch (e) {
      socket.destroy();
      return;
    }
    // Leave every other upgrade alone — this server may grow another one, and
    // silently swallowing them would be a bad afternoon for whoever adds it.
    if (url.pathname !== RELAY_PATH) return;

    const ticket = redeemTicket(url.searchParams.get("token") || "");
    if (!ticket) {
      // 401 before the handshake completes, so the browser reports a clean
      // failure instead of a socket that opens and then dies for no stated
      // reason — the exact failure shape that cost a session on the Cartesia path.
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const call = new RelayCall(ws, ticket);
      ws.on("message", (raw) => call.handleMessage(raw));
      ws.on("close", () => call.stop("socket closed"));
      ws.on("error", (e) => {
        console.error("[voice:relay] socket error:", e.message);
        call.stop("socket error");
      });
    });
  });

  return wss;
}
