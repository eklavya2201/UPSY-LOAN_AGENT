// Streaming text-to-speech for the UPSY voice relay.
//
// One socket per call, not per sentence. Opening a fresh websocket costs ~600ms
// (measured against the live account), which would land on the front of every
// single reply the agent speaks. Opened once at call start and reused, that cost
// is paid during "Connecting…" where nobody notices it, and each sentence after
// that starts speaking ~360ms after we ask for it.
//
// Why streaming at all: /tts/bytes returns the whole clip in one response, so
// the caller hears nothing until the entire sentence has been synthesised. On a
// phone call that silence reads as "it didn't hear me". Streaming lets the first
// syllable land while the rest is still being generated.
//
// ── Provider ────────────────────────────────────────────────────────────────
// Cartesia Sonic. Verified working on the free tier 2026-08-07 — note that only
// *agent deployments* are paused for free accounts, the TTS API itself is fine,
// which is exactly why owning the stack unblocks /m today. Sarvam slots in here
// for Hindi behind the same interface; see makeTts() at the bottom.

import WebSocket from "ws";

const CARTESIA_HOST = "api.cartesia.ai";
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || "2025-04-16";

// Must match SAMPLE_RATE in frontend/voiceClient.js and the STT sample rate.
// Everything in this pipeline is 44.1kHz mono PCM end to end, so there is not a
// single resample step between the caller's microphone and their speaker.
export const TTS_SAMPLE_RATE = 44100;

// sonic-2 is the current model; sonic-english is sunsetted and returns HTTP 400
// (confirmed against the live account, so don't "fix" this back to it).
const CARTESIA_MODEL = process.env.CARTESIA_TTS_MODEL || "sonic-2";

// Kiara — Indian-accented English female, described by Cartesia as
// "enunciating". Not a cosmetic choice: almost every caller here is an Indian
// student or parent, and a US voice reading "lakh", "Aadhaar" and Indian
// institution names is measurably harder to follow. Was Skylar (US) until
// 2026-08-07, changed after a real listener could not tell whether the problem
// was the speed or the accent. It was both.
const CARTESIA_VOICE = process.env.CARTESIA_VOICE_ID || "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d";

// ⚠️ Cartesia's speech-rate controls do NOT work on sonic-2 — measured, not
// assumed. The same sentence came back at 4.32s baseline, 4.27s with
// `__experimental_controls.speed = "slow"`, 4.55s with "slowest", and 4.32s
// with a top-level `speed` field. That is noise, not a control. Every voice
// tested runs 195–209 words/min against a conversational norm of 140–160.
//
// So pacing is fixed where we actually have control: the relay inserts a real
// pause between sentences (VOICE_SENTENCE_PAUSE_MS in voiceRelay.js). Do not
// re-add a `speed` field here expecting it to do something.

export function ttsConfigured() {
  return Boolean(process.env.CARTESIA_API_KEY);
}

export function ttsConfigError() {
  if (process.env.CARTESIA_API_KEY) return null;
  return "CARTESIA_API_KEY is not set, so the agent has no voice — the relay can hear and think but cannot speak.";
}

class CartesiaTts {
  constructor({ language = "en", onError } = {}) {
    this.language = language;
    this.onError = onError || (() => {});
    this.ws = null;
    this.ready = null;
    // Cartesia multiplexes replies by context_id. Barge-in works by moving this
    // forward: chunks tagged with anything else are dropped on arrival, so audio
    // already in flight for an abandoned sentence can never reach the caller.
    this.contextId = null;
    this.pending = null;
    this.closed = false;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        api_key: process.env.CARTESIA_API_KEY,
        cartesia_version: CARTESIA_VERSION,
      });
      const ws = new WebSocket(`wss://${CARTESIA_HOST}/tts/websocket?${params}`);
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("message", (raw) => this.handleMessage(raw));
      ws.on("error", (e) => {
        this.onError(`TTS socket error: ${e.message}`);
        reject(e);
      });
      ws.on("close", (code) => {
        // A mid-call close would otherwise leave speak() hanging forever, and a
        // caller hearing nothing with no error is the worst version of this bug.
        this.ws = null;
        this.ready = null;
        if (!this.closed && this.pending) {
          this.pending.reject(new Error(`TTS socket closed mid-sentence (code ${code})`));
          this.pending = null;
        }
      });
    });
    return this.ready;
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    const pending = this.pending;
    // Late chunks from a sentence we abandoned during barge-in. Dropping them
    // here is what makes interruption feel instant rather than "it kept talking".
    if (!pending || msg.context_id !== this.contextId) return;

    if (msg.type === "chunk" && typeof msg.data === "string") {
      pending.onAudio(Buffer.from(msg.data, "base64"));
    } else if (msg.type === "done") {
      this.pending = null;
      pending.resolve();
    } else if (msg.type === "error") {
      this.pending = null;
      pending.reject(new Error(msg.error || "Cartesia reported a TTS error"));
    }
  }

  /**
   * Speak one sentence, delivering PCM as it is generated.
   *
   * @param {string} text
   * @param {(pcm: Buffer) => void} onAudio - raw pcm_s16le @ 44.1kHz, mono.
   * @param {AbortSignal} [signal] - abort to stop mid-sentence (barge-in).
   */
  async speak(text, onAudio, signal) {
    if (!text || !text.trim()) return;
    if (signal?.aborted) return;
    await this.connect();
    if (signal?.aborted) return;

    const contextId = `upsy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.contextId = contextId;

    return new Promise((resolve, reject) => {
      this.pending = { onAudio, resolve, reject, contextId };

      const onAbort = () => {
        // Advancing the context is the cancel: anything still arriving for the
        // old one is now ignored by handleMessage. We resolve rather than reject
        // because an interrupted sentence is a normal event on a phone call.
        if (this.pending?.contextId === contextId) {
          this.pending = null;
          this.contextId = null;
          resolve();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.ws.send(
          JSON.stringify({
            model_id: CARTESIA_MODEL,
            transcript: text,
            voice: { mode: "id", id: CARTESIA_VOICE },
            output_format: {
              container: "raw",
              encoding: "pcm_s16le",
              sample_rate: TTS_SAMPLE_RATE,
            },
            language: this.language,
            context_id: contextId,
            continue: false,
          })
        );
      } catch (e) {
        this.pending = null;
        reject(e);
      }
    });
  }

  close() {
    this.closed = true;
    this.pending = null;
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch (e) {
        /* already gone */
      }
    }
  }
}

/**
 * Build the TTS engine for a call.
 *
 * The language argument is the seam for Hindi: Sarvam speaks it well and
 * Cartesia's voices do not, and swapping here changes nothing above this
 * function — the relay only knows "give me PCM for this sentence".
 */
export function makeTts({ language = "en", onError } = {}) {
  if (language !== "en" && process.env.SARVAM_API_KEY) {
    // Deliberately not implemented rather than silently falling through to an
    // English voice reading Hindi text, which sounds worse than an honest error.
    throw new Error(
      "Sarvam TTS is not implemented yet — the relay accepts a language so this " +
        "swap is a one-file change, but nobody has written or tested it. Use language=en."
    );
  }
  return new CartesiaTts({ language: "en", onError });
}
