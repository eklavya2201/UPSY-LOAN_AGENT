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
// ── Providers ───────────────────────────────────────────────────────────────
// Deepgram Aura by default, Cartesia Sonic behind TTS_PROVIDER=cartesia.
//
// Cartesia was first and works, but its free tier bills 1 credit per CHARACTER
// against 20,000 a month — which is about 21 four-turn calls, and ran dry inside
// a single day of building this. Deepgram bills the same speech at roughly
// $0.03 per thousand characters against a balance the team already has, which is
// ~7,000 calls on credit already paid for.
//
// Measured head to head on the same sentences before switching (see
// Desktop/testing-deepgram/FINDINGS.md):
//
//   first audio, warm socket   Cartesia ~360ms   Deepgram ~396ms
//   pace                       Jacqueline 218wpm  athena 195wpm
//   audio format               raw pcm_s16le 44.1kHz, identical on both
//   Indian-accented voices     Cartesia 3, Deepgram 0
//
// The 40ms latency difference is far below perception, and it is dwarfed by the
// 1.4-2s the language model takes to produce a first sentence. Cartesia stays as
// a fallback rather than being deleted: it is proven, and it costs nothing to
// leave a working second path in place.
//
// Sarvam still slots in here for Hindi behind the same interface — neither
// provider has an Indian-accented voice worth using.

import WebSocket from "ws";
import { forSpeech } from "./pronounce.js";
import {
  SarvamTts,
  sarvamConfigured,
  sarvamConfigError,
  sarvamStatusLine,
  normalizeLanguage,
} from "./voiceSarvam.js";

const PROVIDER = (process.env.TTS_PROVIDER || "deepgram").toLowerCase();

// Which engine speaks, given the language of the call.
//
// This is not a preference and it is not configurable away: Aura and Sonic do
// not have an Indian-language voice between them, so anything that is not
// English MUST be Sarvam or it cannot be spoken at all. English keeps whatever
// TTS_PROVIDER says, which is Aura by default.
//
// `auto` goes to Sarvam even though the call opens in English, and that is a
// deliberate trade. The greeting happens before the caller has said a word, so
// there is nothing to detect from yet — but if English were spoken by Aura,
// switching to Hindi on the first turn would mean swapping ENGINES mid-call
// rather than changing one config field. Paying for Sarvam's English voice on
// auto-detect calls buys a switch that is a reconnect instead of a rebuild.
function ttsProviderFor(language) {
  return normalizeLanguage(language) === "en" ? PROVIDER : "sarvam";
}

const DEEPGRAM_HOST = "api.deepgram.com";

// athena — "calm, smooth, professional", 195 wpm. Chosen by listening to five
// candidates rather than from the catalogue's prose, which had already produced
// two wrong picks on the Cartesia side.
//
// If "too fast" ever comes back, `aura-2-vesta-en` measured 137 wpm — the only
// voice tested inside the 140-160 conversational band — and switching is one
// env var. Avoid anything sold as "energetic", "cheerful" or "enthusiastic":
// that register is wrong for someone anxious about borrowing fifteen lakh, and
// it is exactly how the Cartesia pick went astray.
const DEEPGRAM_VOICE = process.env.DEEPGRAM_TTS_MODEL || "aura-2-athena-en";

// Two ceilings, because "stalled" and "slow" are different faults and only one
// of them is worth giving up on.
//
// IDLE is the real detector: a sentence that is still delivering audio is alive,
// however long it takes, while one that has sent nothing for five seconds is
// gone. The original single 10s TOTAL timeout could not tell those apart, so on
// a bad connection it aborted sentences that were still streaming perfectly well
// — measured on a real call: a four-second greeting delivered 3.16s of audio in
// 79 chunks and was then declared timed out.
//
// TOTAL still exists so a pathological stream that dribbles one chunk every four
// seconds cannot hold the speech queue forever.
const IDLE_TIMEOUT_MS = Number(process.env.TTS_IDLE_TIMEOUT_MS || 5000);
const SPEAK_TIMEOUT_MS = Number(process.env.TTS_SPEAK_TIMEOUT_MS || 30000);

// How long to wait for Deepgram to confirm a Clear before giving up on the
// socket entirely. Short: this is on the path of the next thing the agent says.
const CLEAR_TIMEOUT_MS = Number(process.env.TTS_CLEAR_TIMEOUT_MS || 800);

const CARTESIA_HOST = "api.cartesia.ai";
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || "2025-04-16";

// Must match SAMPLE_RATE in frontend/voiceClient.js and the STT sample rate.
// Everything in this pipeline is 44.1kHz mono PCM end to end, so there is not a
// single resample step between the caller's microphone and their speaker.
export const TTS_SAMPLE_RATE = 44100;

// sonic-2 is the current model; sonic-english is sunsetted and returns HTTP 400
// (confirmed against the live account, so don't "fix" this back to it).
const CARTESIA_MODEL = process.env.CARTESIA_TTS_MODEL || "sonic-2";

// Jacqueline — "confident, young adult female for empathic customer support",
// which is the closest thing in the catalogue to what this agent actually does.
//
// Chosen by listening, after two picks made from written descriptions were both
// wrong. Skylar (US, "customer care") was the original; Kiara replaced her on
// the reasoning that an Indian-accented voice would be easier for Indian callers
// to follow — a sound argument that did not survive contact with the ear, since
// Cartesia's Indian-accented English is not good. Note the register trap too:
// Kiara is sold as "joyful… for happy conversations", which is the wrong tone
// for someone anxious about borrowing fifteen lakh.
//
// If this is changed again, LISTEN FIRST. The catalogue has 412 English voices
// and exactly three Indian-accented ones (Kiara, Devansh, Aarav), so there is
// not much to choose from on accent — pick on clarity and register instead.
const CARTESIA_VOICE = process.env.CARTESIA_VOICE_ID || "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";

// ⚠️ Cartesia's speech-rate controls do NOT work on sonic-2 — measured, not
// assumed. The same sentence came back at 4.32s baseline, 4.27s with
// `__experimental_controls.speed = "slow"`, 4.55s with "slowest", and 4.32s
// with a top-level `speed` field. That is noise, not a control. Every voice
// tested runs 195–209 words/min against a conversational norm of 140–160.
//
// So pacing is fixed where we actually have control: the relay inserts a real
// pause between sentences (VOICE_SENTENCE_PAUSE_MS in voiceRelay.js). Do not
// re-add a `speed` field here expecting it to do something.

// Language-aware for the same reason the STT ones are: a deployment can be
// perfectly able to speak English and unable to speak Marathi, and one boolean
// cannot say that. No argument means English, which is what every existing call
// site meant.
export function ttsConfigured(language = "en") {
  const provider = ttsProviderFor(language);
  if (provider === "sarvam") return sarvamConfigured();
  if (provider === "cartesia") return Boolean(process.env.CARTESIA_API_KEY);
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

export function ttsConfigError(language = "en") {
  if (ttsConfigured(language)) return null;
  const provider = ttsProviderFor(language);
  if (provider === "sarvam") return sarvamConfigError();
  if (provider === "cartesia") {
    return "CARTESIA_API_KEY is not set, so the agent has no voice — the relay can hear and think but cannot speak.";
  }
  return "DEEPGRAM_API_KEY is not set, so the agent has no voice — the relay can hear and think but cannot speak. (The same key does the hearing.)";
}

// For the boot line, so which voice is live is visible at a glance rather than
// discovered on a call.
export function ttsStatusLine(language = "en") {
  const provider = ttsProviderFor(language);
  if (provider === "sarvam") return sarvamStatusLine(language);
  if (provider === "cartesia") return `Cartesia Sonic (${CARTESIA_MODEL})`;
  return `Deepgram Aura (${DEEPGRAM_VOICE})`;
}

/**
 * Deepgram Aura over their streaming WebSocket.
 *
 * Same three methods as CartesiaTts — connect / speak / close — because the
 * relay only knows "give me PCM for this sentence" and must not learn which
 * vendor is behind that.
 *
 * ⚠️ Do NOT swap this for the REST endpoint (`POST /v1/speak`). It returns the
 * whole clip in one response, measured at 3.3 SECONDS before any audio exists at
 * all, against 396ms for the first chunk here. On a phone call that gap reads as
 * a dead line.
 */
class AuraTts {
  constructor({ onError } = {}) {
    this.onError = onError || (() => {});
    this.ws = null;
    this.ready = null;
    this.pending = null;
    this.closed = false;
    this.seq = 0;

    // ⚠️ THE THING THAT MAKES THIS CLASS HARD, stated plainly because a previous
    // version got it wrong and the bug reached a real caller as the agent's
    // voice breaking up mid-word.
    //
    // Aura's audio arrives as bare binary frames with NO request id — unlike
    // Cartesia's context_id, there is nothing in a frame that says which
    // sentence it belongs to. An earlier comment here claimed a monotonic
    // counter "does the same job" and that late audio from an abandoned request
    // "is dropped because pending has already moved on". Both halves were false:
    // handleMessage handed every binary frame to whatever `pending` happened to
    // be current, so when one request was abandoned — a barge-in, a timeout —
    // its remaining audio was delivered into the NEXT sentence, and its late
    // `Flushed` then resolved that sentence early. From there the socket stayed
    // one request out of step for the rest of the call.
    //
    // Measured, with the sentence lengths swapping places:
    //   "Right."                        → 3.60s of audio, 90 chunks
    //   "Your father's income is the…"   → 0.52s of audio, 13 chunks
    //
    // Since a frame cannot be attributed, the only correct move is to make sure
    // nothing is ever in flight when a new request starts. `dirty` marks the
    // socket as possibly still generating for a request nobody is listening to,
    // and settleSocket() below drains it before the next Speak.
    this.dirty = false;
    this.clearedWaiter = null;
  }

  // Identifies the voice, not the engine: two engines that happen to produce
  // identical audio could share a cache entry, and two voices from one provider
  // must never share one. See the phrase cache below.
  get voiceId() {
    return `deepgram:${DEEPGRAM_VOICE}`;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: DEEPGRAM_VOICE,
        encoding: "linear16",
        sample_rate: String(TTS_SAMPLE_RATE),
      });
      const ws = new WebSocket(`wss://${DEEPGRAM_HOST}/v1/speak?${params}`, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
      });
      this.ws = ws;

      ws.on("open", () => resolve());
      ws.on("message", (raw, isBinary) => this.handleMessage(raw, isBinary));
      ws.on("error", (e) => {
        this.onError(`TTS socket error: ${e.message}`);
        reject(e);
      });
      ws.on("close", (code) => {
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

  handleMessage(raw, isBinary) {
    const pending = this.pending;
    // Audio frames arrive as binary; everything else is a JSON control message.
    // The `ws` package hands us Buffers directly — note that Node's *built-in*
    // WebSocket would give Blobs instead, whose length is `.size` not
    // `.byteLength`, which silently measures every frame as empty.
    if (isBinary) {
      // No pending request means these frames belong to something abandoned.
      // Dropping them is the point — this is where the mis-splicing happened.
      if (pending && raw.length) {
        pending.touch();
        pending.onAudio(Buffer.from(raw));
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    // Confirmation that Deepgram has thrown away whatever it was generating, so
    // the socket is safe to reuse. Handled before the `pending` guard because a
    // Clear is sent precisely when there is no pending request left.
    if (msg.type === "Cleared") {
      const waiter = this.clearedWaiter;
      this.clearedWaiter = null;
      if (waiter) waiter();
      return;
    }
    if (msg.type === "Warning") {
      this.onError(`TTS warning: ${msg.description || msg.message || "unspecified"}`);
      return;
    }
    if (!pending) return;

    if (msg.type === "Flushed") {
      this.pending = null;
      pending.resolve();
    } else if (msg.type === "Error" || msg.type === "Fatal") {
      this.pending = null;
      pending.reject(new Error(msg.description || msg.message || "Deepgram reported a TTS error"));
    }
  }

  /**
   * Make sure nothing is still being generated for a request nobody owns.
   *
   * Called before a Speak whenever the previous request ended in any way other
   * than its own Flushed — an interruption or a stall. Asks Deepgram to Clear
   * and waits for it to confirm; if it does not confirm quickly, the socket
   * cannot be trusted and is replaced. A reconnect costs ~600ms and only ever
   * happens after a fault, which is a price worth paying to never again splice
   * one sentence's audio into another's.
   */
  async settleSocket() {
    this.dirty = false;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return this.reconnect();

    const cleared = new Promise((resolve) => {
      this.clearedWaiter = resolve;
    });
    try {
      ws.send(JSON.stringify({ type: "Clear" }));
    } catch (e) {
      return this.reconnect();
    }

    let timer;
    const confirmed = await Promise.race([
      cleared.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), CLEAR_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    this.clearedWaiter = null;
    if (!confirmed) {
      this.onError("TTS did not confirm a Clear — replacing the socket rather than risking crossed audio");
      await this.reconnect();
    }
  }

  /**
   * Cut a socket loose so nothing it says afterwards can be heard.
   *
   * ⚠️ DETACH THE LISTENERS, and close() alone does not do it. `close()` starts
   * a closing HANDSHAKE: the socket stays open for a round trip and keeps
   * delivering frames that were already generated. Those frames still reach
   * handleMessage(), which — because Aura's audio carries no request id — hands
   * them to whatever `pending` is current by then, i.e. the NEXT sentence.
   *
   * That is the same defect this class already documents at the top, arriving by
   * a second route. The Clear/Cleared handshake protects the socket we KEEP;
   * this protects against the socket we THROW AWAY. Reproduced on the Sarvam
   * engine, which has identical framing: interrupt a long sentence, say a short
   * one, and one run in three came back at 2.6x its length. The check in
   * voice-sarvam-check.js holds both engines to it now.
   */
  discard(ws) {
    if (!ws) return;
    ws.removeAllListeners("message");
    ws.removeAllListeners("close");
    ws.removeAllListeners("error");
    ws.removeAllListeners("open");
    try {
      ws.terminate();
    } catch (e) {
      /* already gone */
    }
  }

  // Drop the current socket and open a fresh one. Distinct from close(), which
  // ends the engine for good.
  async reconnect() {
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    this.clearedWaiter = null;
    this.discard(ws);
    if (!this.closed) await this.connect();
  }

  async speak(text, onAudio, signal) {
    if (!text || !text.trim()) return;
    if (signal?.aborted) return;
    await this.connect();
    if (signal?.aborted) return;

    // Anything still in flight from an abandoned request has to be gone before
    // a new one starts, or its audio arrives inside this sentence.
    if (this.dirty) await this.settleSocket();
    if (signal?.aborted) return;

    const mine = ++this.seq;

    return new Promise((resolve, reject) => {
      // A sentence must never be able to hang the speech chain.
      //
      // speak() only settles when Deepgram sends `Flushed`, and if that never
      // arrives — a stalled socket, a dropped frame, a provider hiccup — the
      // await above blocks forever. Because every spoken line goes through one
      // serial queue (see this.speechChain in voiceRelay.js), a single hang
      // silences the agent for the rest of the call while the caller hears
      // nothing and no error is raised anywhere. This was not theoretical: it
      // deadlocked the boot-time prewarm on the very first run.
      //
      // Resolve rather than reject: whatever audio did arrive has already been
      // played, and the next sentence should still get its turn. But mark the
      // socket dirty first — Deepgram has not stopped generating just because we
      // stopped waiting, and the next request must not inherit that audio.
      let idle;
      const giveUp = (why) => {
        if (this.pending?.seq !== mine) return;
        this.pending = null;
        this.dirty = true;
        this.onError(`TTS ${why} — abandoning this sentence and resetting the stream`);
        resolve();
      };
      const total = setTimeout(() => giveUp(`ran past its ceiling (${SPEAK_TIMEOUT_MS}ms)`), SPEAK_TIMEOUT_MS);
      // Re-armed by every audio frame: a sentence that is still arriving is
      // healthy no matter how long it has been going.
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => giveUp(`went silent mid-sentence (no audio for ${IDLE_TIMEOUT_MS}ms)`), IDLE_TIMEOUT_MS);
      };
      arm();

      const settle = (fn) => (v) => {
        clearTimeout(total);
        clearTimeout(idle);
        fn(v);
      };
      resolve = settle(resolve);
      reject = settle(reject);

      this.pending = { onAudio, resolve, reject, seq: mine, touch: arm };

      const onAbort = () => {
        if (this.pending?.seq !== mine) return;
        this.pending = null;
        // Deepgram keeps generating until told otherwise, so the socket is
        // untrustworthy until a Clear is confirmed. settleSocket() does that
        // before the next Speak rather than here, so barge-in stays instant.
        this.dirty = true;
        // Resolve, not reject: an interrupted sentence is a normal event on a
        // phone call, not a failure.
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.ws.send(JSON.stringify({ type: "Speak", text }));
        // Without an explicit Flush, Aura waits for more text before it starts
        // synthesising — which is right for a token stream and wrong for us,
        // because the relay already hands it one complete sentence at a time.
        this.ws.send(JSON.stringify({ type: "Flush" }));
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
    this.discard(ws);
  }
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

  get voiceId() {
    return `cartesia:${CARTESIA_VOICE}`;
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

// ── The phrase cache ────────────────────────────────────────────────────────
// Some of what this agent says is byte-identical on every single call: the
// anonymous greeting, and the ten acknowledgements in voiceFillers.js. They were
// being re-synthesised every time, and paid for every time.
//
// That is not a rounding error. An acknowledgement fires on most turns, so a
// four-turn call spends roughly a third of its characters on strings we have
// already bought. It is also what drained a month of Cartesia credit in a day of
// testing: every preflight run re-bought the same greeting.
//
// Caching them makes the agent faster as well as cheaper — a cached phrase skips
// the ~400ms round trip entirely, and the acknowledgement is precisely the thing
// whose job is to land fast.
//
// Deliberately NOT a general-purpose cache. Only exact strings from a known
// fixed set are stored, because a model's replies never repeat and caching them
// would grow without bound while never being read.
// Which texts are worth keeping, independent of who says them.
const cacheableText = new Set();

// ⚠️ KEYED BY VOICE, NOT BY TEXT, and that stopped being optional the day a
// second engine could speak English.
//
// This map used to be `text -> Buffer[]`. That was correct while exactly one
// engine existed: the same words always came back in the same voice. With
// Sarvam on the same process — and `auto` calls deliberately routing English
// through it so a mid-call switch is a reconnect rather than an engine swap —
// a bare text key means the first call to synthesise "Got it." decides which
// voice EVERY later call hears it in. The agent would answer in athena and
// acknowledge in priya, on alternating turns, for the rest of the process's
// life. Cheap to prevent, and near-impossible to diagnose from a bug report
// that can only say "the voice keeps changing".
const phraseCache = new Map(); // `${voiceId} ${text}` -> Buffer[]

// NUL as the separator because it is the one character that cannot appear in
// either half — not in a provider's voice id, and not in a sentence anyone says
// out loud. A space or a colon works until the day a voice id contains one, and
// then two different voices silently share an entry, which is the exact bug this
// key exists to prevent.
//
// ⚠️ Written as an ESCAPE, never as a literal NUL byte in this file. One raw NUL
// makes git classify the whole source as binary, and every later diff of this
// file then shows as an unreviewable whole-file replacement. That happened once
// while this very line was being written, and it is invisible in an editor.

const cacheKey = (voiceId, text) => `${voiceId}\u0000${text}`;

// A personalised greeting ("Hi Aarav, this is UPSY again") is unique per caller
// and per call count, so it is not cacheable and is not worth trying to be.
// Only the anonymous opener and the acknowledgements qualify.
export function cacheablePhrases(phrases) {
  for (const p of phrases) if (p) cacheableText.add(p);
}

export function phraseCacheStats() {
  return { known: cacheableText.size, ready: phraseCache.size };
}

/**
 * Synthesise the fixed phrases once at boot, so no caller pays for them.
 *
 * Without this the cache still works, but the FIRST caller after every deploy
 * waits ~1.2s for the greeting and again for their first acknowledgement — and
 * on a free-tier host that sleeps after 15 minutes, "the first caller after a
 * deploy" is very often the only caller, which is exactly the person a demo is
 * being shown to.
 *
 * English only: the Hindi lines cannot be spoken until Sarvam exists, and
 * buying them from an English voice would be wasted spend on audio we would
 * never play.
 *
 * Failures are swallowed on purpose. A cold cache costs latency; a server that
 * refuses to boot because a TTS provider was briefly unreachable costs the
 * whole product.
 */
export async function prewarmPhrases(phrases) {
  if (!ttsConfigured()) return { warmed: 0, skipped: "no TTS key" };

  // Built before the filter, because what is already warm now depends on WHICH
  // VOICE is going to say it — a cache full of athena's acknowledgements warms
  // nothing for a Sarvam call.
  const engine = makeTts({ language: "en", onError: () => {} });
  const wanted = phrases.filter((p) => p && !phraseCache.has(cacheKey(engine.voiceId, p)));
  if (!wanted.length) {
    engine.close();
    return { warmed: 0 };
  }

  let warmed = 0;
  try {
    for (const phrase of wanted) {
      try {
        await engine.speak(phrase, () => {}, null);
        warmed++;
      } catch (e) {
        /* one phrase failing is not worth abandoning the rest */
      }
    }
  } finally {
    engine.close();
  }
  return { warmed };
}

/**
 * Wraps any engine and serves the fixed phrases from memory after their first
 * synthesis. Transparent: same speak() signature, so the relay cannot tell.
 */
class CachedTts {
  constructor(engine) {
    this.engine = engine;
  }

  // Passed through so callers (and the prewarm) can ask what voice they are
  // about to get without reaching inside the wrapper.
  get voiceId() {
    return this.engine.voiceId;
  }

  /** Only Sarvam can do this; the English-only engines simply have nothing to do. */
  async setLanguage(language) {
    if (typeof this.engine.setLanguage === "function") await this.engine.setLanguage(language);
  }

  async speak(text, onAudio, signal) {
    const phrase = text?.trim();
    // Read the voice id per sentence rather than once per engine: Sarvam's
    // changes under setLanguage(), and a stale id would serve Hindi audio for
    // an English line after a switch.
    const key = phrase && cacheableText.has(phrase) ? cacheKey(this.engine.voiceId, phrase) : null;
    const cached = key ? phraseCache.get(key) : undefined;

    if (cached) {
      // Replay. Handing back the same chunk boundaries the provider produced
      // keeps playback identical to a live synthesis rather than arriving as
      // one large block.
      for (const chunk of cached) {
        if (signal?.aborted) return;
        onAudio(chunk);
      }
      return;
    }

    // Not cached, but worth keeping? Capture on the way past.
    const collecting = key ? [] : null;
    // ⚠️ THE ONE PLACE THE BRAND NAME IS RESPELLED, and it is deliberately below
    // the cache key. The key is computed from the real text above, so a phrase
    // has one cache entry regardless of how it ends up being pronounced — and
    // nothing outside this call ever sees the substitution. The transcript, the
    // stored turns and /team all keep "UPSY".
    await this.engine.speak(
      forSpeech(text, this.engine.speechLanguage || "en"),
      (pcm) => {
        if (collecting) collecting.push(pcm);
        onAudio(pcm);
      },
      signal
    );
    // Only store a complete phrase. A sentence cut short by barge-in would
    // otherwise be cached truncated and replayed truncated for the rest of time.
    if (collecting && collecting.length && !signal?.aborted) {
      phraseCache.set(key, collecting);
    }
  }

  close() {
    this.engine.close();
  }
}

/**
 * Build the TTS engine for a call.
 *
 * This function used to throw for every language but English, on the reasoning
 * that an honest error beats an English voice reading Hindi text — which was
 * right, and stayed right for as long as there was nothing behind the seam.
 * There is now: voiceSarvam.js. Swapping here still changes nothing above this
 * function, because the relay only knows "give me PCM for this sentence".
 *
 * The seam held, which was the thing actually being tested when it was written.
 */
export function makeTts({ language = "en", onError } = {}) {
  const lang = normalizeLanguage(language);
  const provider = ttsProviderFor(lang);

  if (provider === "sarvam") {
    if (!sarvamConfigured()) {
      // Still a throw, and for the original reason: falling back to an English
      // voice would produce a call that sounds like it is working and is not.
      throw new Error(sarvamConfigError());
    }
    return new CachedTts(new SarvamTts({ language: lang, onError }));
  }

  const engine =
    provider === "cartesia"
      ? new CartesiaTts({ language: "en", onError })
      : new AuraTts({ onError });
  return new CachedTts(engine);
}
