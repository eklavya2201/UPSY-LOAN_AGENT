// Streaming speech-to-text + turn detection for the UPSY voice relay.
//
// This is the hard part of the whole project, and it is not the transcription —
// it is knowing *when the caller has finished talking*. Answer too early and you
// interrupt someone drawing breath mid-sentence; answer too late and the call
// feels laggy and dead. That judgement is what a hosted voice agent actually
// sells you, and it is why this file leans on Deepgram's own endpointing rather
// than hand-rolling voice-activity detection off frame amplitude.
//
// Three signals come out of here, and the relay needs all three:
//   speechStarted  → the caller is talking. During playback this means barge-in.
//   transcript     → interim text, for the /m constellation. Never a turn.
//   turn           → the caller has finished a thought. Go think and reply.
//
// ⚠️ Unexercised: there is no DEEPGRAM_API_KEY in .env, so this file is written
// against Deepgram's documented streaming protocol but has never opened a real
// socket. Everything below the provider boundary (the relay's turn handling) is
// exercised by the fake engine at the bottom of this file.

import WebSocket from "ws";

const DEEPGRAM_HOST = "api.deepgram.com";

// nova-3 with explicit endpointing, rather than Deepgram's newer turn-detection
// model: this protocol is stable and well documented, and we cannot A/B them
// without a key. Once a key exists, that comparison is the first thing to run —
// see the roadmap note in the README.
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";

// en-IN, not en. Generic English models mangle exactly the vocabulary this
// product is made of — measured, not assumed: on plain "en" the sentence "I need
// about fifteen lakh rupees for an MBA" came back as "I need about 15 locker
// piece for an MBA", and on another run "fifteen" vanished entirely. An agent
// that mishears the loan amount is worse than one that cannot hear at all,
// because it will confidently answer the wrong question.
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "en-IN";

// Keyterm boosting for the words this agent hears all day and a general model
// has no reason to expect. "lakh" and "crore" are the load-bearing ones; the
// rest are cheap to include and each one is a term whose misrecognition would
// send a turn off the rails.
const KEYTERMS = (process.env.DEEPGRAM_KEYTERMS ||
  [
    "lakh", "lakhs", "crore", "crores", "rupees",
    "EMI", "moratorium", "collateral", "co-applicant", "co-borrower",
    "Aadhaar", "PAN", "ITR", "NRI", "sanction", "disbursal",
    "marksheet", "admit letter", "unsecured", "secured",
  ].join(",")
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// How much trailing silence ends a turn.
//
// NOT Deepgram's default of 300ms, and the difference is not cosmetic: at 300ms
// the recogniser ends a turn at every sentence boundary, so a caller who says
// "I need fifteen lakh for an MBA. Am I eligible?" gets answered after the first
// sentence and then interrupts the answer with the second. Measured, not
// guessed — see the hearing test in voice-relay-check.js, which reports how many
// turns one spoken thought was split into.
//
// The cost of raising it is latency, paid on every single turn, so it is worth
// re-tuning against real callers rather than one synthetic sentence. People who
// pause to think mid-sentence need more; clipped question-and-answer needs less.
const ENDPOINTING_MS = Number(process.env.DEEPGRAM_ENDPOINTING_MS || 800);
const UTTERANCE_END_MS = Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 1000);

export function sttConfigured() {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

export function sttConfigError() {
  if (process.env.DEEPGRAM_API_KEY) return null;
  return (
    "DEEPGRAM_API_KEY is not set, so the relay cannot hear the caller. " +
    "Deepgram ships $200 of free credit (~45,000 streaming minutes) — sign up and put the key in .env."
  );
}

class DeepgramStt {
  constructor({ sampleRate, language = "en", onSpeechStarted, onTranscript, onEagerTurn, onTurn, onError }) {
    this.sampleRate = sampleRate;
    this.language = language;
    this.onSpeechStarted = onSpeechStarted || (() => {});
    this.onTranscript = onTranscript || (() => {});
    // Fires on each settled fragment, ~800ms before onTurn confirms the turn.
    // The relay uses it to start thinking during the endpointing silence
    // instead of after it — see the speculation note in voiceRelay.js.
    this.onEagerTurn = onEagerTurn || (() => {});
    this.onTurn = onTurn || (() => {});
    this.onError = onError || (() => {});
    this.ws = null;
    this.closed = false;
    // Deepgram finalizes in fragments: a single spoken sentence can arrive as
    // two or three is_final results before the turn actually ends. Accumulate
    // them and only hand the relay a whole thought.
    this.pendingWords = [];
  }

  start() {
    const params = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      // Numbers matter more here than in most transcription: this agent talks
      // about lakhs, percentages and interest rates all day.
      numerals: "true",
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
      vad_events: "true",
    });
    // Repeated params, one per term — not a comma-joined single value.
    for (const term of KEYTERMS) params.append("keyterm", term);

    const ws = new WebSocket(`wss://${DEEPGRAM_HOST}/v1/listen?${params}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });
    this.ws = ws;

    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("error", (e) => {
      // A call that ends before the STT socket finished connecting is a normal
      // short call, not a fault — reporting it just trains people to ignore the
      // log line that matters.
      if (this.closed) return;
      this.onError(`STT socket error: ${e.message}`);
    });
    ws.on("close", (code, reason) => {
      this.ws = null;
      if (!this.closed) {
        this.onError(`STT socket closed unexpectedly (${code} ${reason || "no reason"})`);
      }
    });
    return this;
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === "SpeechStarted") {
      this.onSpeechStarted();
      return;
    }

    // The caller stopped talking but Deepgram never emitted speech_final —
    // typically someone trailing off. Whatever we have is the turn.
    if (msg.type === "UtteranceEnd") {
      this.flushTurn();
      return;
    }

    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;

    if (!msg.is_final) {
      this.onTranscript(text, false);
      return;
    }

    this.pendingWords.push(text);
    this.onTranscript(text, true);
    // speech_final is Deepgram saying "and they've stopped" — the end of a turn,
    // as opposed to is_final which only means "this fragment won't change".
    if (msg.speech_final) {
      this.flushTurn();
    } else {
      // Settled text, but the turn is not confirmed yet. Hand it over anyway so
      // the relay can get a head start; it is responsible for throwing the work
      // away if the caller keeps going.
      this.onEagerTurn(this.pendingWords.join(" ").trim());
    }
  }

  flushTurn() {
    const text = this.pendingWords.join(" ").trim();
    this.pendingWords = [];
    if (text) this.onTurn(text);
  }

  /** Feed raw pcm_s16le mono at this.sampleRate. */
  write(pcm) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm);
  }

  close() {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Tells Deepgram to flush and finalize rather than dropping the tail.
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch (e) {
        /* socket already going away */
      }
    }
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch (e) {
        /* noop */
      }
    }
  }
}

// Stand-in for when no STT key is configured. It never produces a turn, so the
// agent greets the caller and then listens politely forever — which is exactly
// what should happen: the caller can hear it, it genuinely cannot hear them, and
// the relay says so on connect rather than pretending.
class DeafStt {
  constructor() {
    this.deaf = true;
  }
  start() {
    return this;
  }
  write() {}
  close() {}
}

export function makeStt(options) {
  if (!sttConfigured()) return new DeafStt();
  return new DeepgramStt(options).start();
}

export { DeepgramStt, DeafStt };
