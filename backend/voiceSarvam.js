// Sarvam — hearing and speaking in Indian languages.
//
// WHY THIS EXISTS AT ALL, since the stack already had both halves working:
// Deepgram Aura has no Indian-language voice. Not a bad one — none. English,
// Spanish, German, French, Dutch, Italian, Japanese. So the moment an institute
// asks for Marathi, no amount of tuning on the existing path gets there, and
// swapping the recogniser alone would produce an agent that understands Marathi
// and answers in an English voice.
//
// Deepgram's *recogniser* has moved on since this repo last looked: nova-3 now
// does Hindi, Marathi, Telugu, Tamil, Kannada, Gujarati and Punjabi as named
// languages. But its automatic detection (`language=multi`) spans ten languages
// of which Hindi is the only Indian one, so it cannot answer "which language is
// this caller speaking" for the set we actually care about. Sarvam can.
//
// ── What this file deliberately does NOT do ─────────────────────────────────
// It does not become the English path. Deepgram stays the default for `en`,
// because every measured decision in this repo — the 800ms endpointing, the
// two-word barge-in rule, the keyterm list, the idle-based stall detector — was
// tuned against Deepgram's behaviour, and re-validating all of it is a separate
// piece of work from adding four languages. `STT_PROVIDER=sarvam` forces this
// path for English if someone wants to measure the comparison.
//
// ── Two protocol facts that shape everything below ──────────────────────────
// 1. THE RECOGNISER TAKES 8kHz OR 16kHz, NOTHING ELSE, and closes the socket
//    with code 4000 on anything else. This pipeline is 44.1kHz end to end, so
//    this is the first thing in the project that resamples. See voiceResample.js
//    for why that is more than a one-liner.
// 2. AUDIO GOES UP AS BASE64 INSIDE JSON, not as binary frames the way Deepgram
//    takes it. Costs ~33% more bytes on the uplink; not enough to matter at
//    16kHz mono, which is already a third of what we were sending Deepgram.

import WebSocket from "ws";
import { Resampler } from "./voiceResample.js";

const HOST = "api.sarvam.ai";

// The rate Sarvam's recogniser is given. 16000 rather than 8000 — the docs
// recommend it and telephone-band audio measurably costs accuracy on exactly
// the words this agent lives on (digits, "lakh", institute names).
const STT_SAMPLE_RATE = 16000;

// saaras:v3-realtime is the streaming model. The batch models (saarika,
// saaras:v2.5) return a whole utterance after the fact and cannot drive a live
// call — no partials means no barge-in, which this relay treats as load-bearing.
const STT_MODEL = process.env.SARVAM_STT_MODEL || "saaras:v3-realtime";

// `fast` over the `balanced` default: this is a conversational agent, and the
// partials exist here to trigger barge-in rather than to be displayed. A partial
// that is 200ms late is worse for us than one that is slightly wrong, because
// the wrong one gets replaced by the final anyway.
const STT_STREAM_TYPE = process.env.SARVAM_STREAM_TYPE || "fast";

// The Sarvam equivalent of the Deepgram endpointing decision, and it carries the
// same hard-won number. Deepgram's 300ms default ended a turn at every sentence
// boundary, so "I need fifteen lakh for an MBA. Am I eligible?" was answered
// after the first sentence and the second then barged in on that answer. 800ms
// makes one thought one turn.
//
// It is a DIFFERENT MECHANISM here (Sarvam runs its own VAD rather than
// Deepgram's endpointing), so the number is a starting point carried across, not
// a measurement. Re-tune it against real callers in each language — people pause
// differently in Marathi than in English, and nothing about 800ms is universal.
const STT_SILENCE_MS = Number(process.env.SARVAM_SILENCE_MS || 800);
const STT_MIN_SPEECH_MS = Number(process.env.SARVAM_MIN_SPEECH_MS || 250);
const STT_VAD_THRESHOLD = Number(process.env.SARVAM_VAD_THRESHOLD || 0.3);

// The standing vocabulary this agent hears all day, as Sarvam's `prompt` hint.
//
// The Deepgram path has an equivalent list and it does not transfer: keyterms
// there are repeated query parameters, here it is one free-text hint, so the two
// cannot share a constant without one of them being wrong. Both exist for the
// same reason — a general model has no reason to expect "lakh", and an agent
// that mishears the loan amount is worse than one that cannot hear at all.
//
// The Latin acronyms are here because of a measured miss: "एमबीए" (MBA) came
// back from voice:sarvam as "एमबीआई" (MBI). Acronyms are the same class of
// problem as proper nouns — no language model behind them — and MBA is close to
// the single most common word a caller says on this product.
const STT_PROMPT_TERMS = [
  "lakh", "crore", "rupees", "EMI", "moratorium", "collateral",
  "co-applicant", "co-borrower", "Aadhaar", "PAN", "ITR", "NRI",
  "sanction", "disbursal", "marksheet", "admit letter", "secured", "unsecured",
  "MBA", "MS", "BTech", "MTech", "PhD", "GRE", "IELTS", "TOEFL",
  "लाख", "करोड़", "ऋण", "कर्ज", "ब्याज", "एमबीए",
];

// bulbul:v3 is the current voice model. v2 is cheaper (Rs 15 vs Rs 30 per 10k
// characters) and audibly worse; at ~400 characters of agent speech per call
// the difference is under a rupee a call, which is not a saving worth a voice.
const TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v3";

// ⚠️ THIS SPEAKER WAS NOT CHOSEN BY LISTENING, and that is a defect, not a
// decision. This repo has picked a voice from a catalogue's prose twice and been
// wrong twice — Skylar, then Kiara, then Jacqueline, before landing on athena by
// actually listening to five candidates. bulbul:v3 has 39 speakers.
//
// Before any real caller hears this: synthesise the same two or three sentences
// through several speakers in each language and pick with your ears. Watch the
// register trap too — the wrong tone for someone anxious about borrowing fifteen
// lakh is "cheerful", and that is exactly how the Kiara mistake happened.
const TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER || "priya";

// Sarvam has a speech-rate control that ACTUALLY WORKS, which Cartesia's sonic-2
// did not — that is worth knowing, because a whole gap-widening pacing module
// was written and then disabled (VOICE_PACE_EXTRA_MS=0) because it stuttered
// mid-word, and the reason it existed was that every voice ran 195-222 wpm
// against a conversational norm of 140-160.
//
// Left at 1.0 rather than pre-emptively slowed, because "slow it to 0.9" without
// listening is the same mistake in the other direction. MEASURE the words per
// minute of the chosen speaker first, then set this. Range is 0.5-2.0.
const TTS_PACE = Number(process.env.SARVAM_TTS_PACE || 1.0);

// What we ask Sarvam to synthesise at. The docs note that the higher rates
// (32000/44100/48000) are documented for bulbul:v3 "via the REST API", which
// leaves it genuinely unclear whether the websocket honours 44100 — so the
// default assumes it does not and resamples. If voice:sarvam reports 44100
// coming back clean, set this to 44100 and the resampler drops out of the
// playback path entirely.
const TTS_NATIVE_RATE = Number(process.env.SARVAM_TTS_SAMPLE_RATE || 24000);

// The rate the rest of the pipeline speaks. Must stay equal to SAMPLE_RATE in
// voiceRelay.js and frontend/voiceClient.js.
const PIPELINE_RATE = 44100;

const IDLE_TIMEOUT_MS = Number(process.env.TTS_IDLE_TIMEOUT_MS || 5000);
const SPEAK_TIMEOUT_MS = Number(process.env.TTS_SPEAK_TIMEOUT_MS || 30000);

/**
 * The languages this path can carry, as short codes to Sarvam's BCP-47 ones.
 *
 * All eleven Sarvam supports. `en` is here because a call in `auto` has to be
 * able to resolve to English like any other answer — an English caller detected
 * as English must not be a special case that falls off this path mid-call.
 */
export const SARVAM_LANGUAGES = {
  en: { code: "en-IN", label: "English" },
  hi: { code: "hi-IN", label: "Hindi" },
  mr: { code: "mr-IN", label: "Marathi" },
  te: { code: "te-IN", label: "Telugu" },
  ta: { code: "ta-IN", label: "Tamil" },
  kn: { code: "kn-IN", label: "Kannada" },
  ml: { code: "ml-IN", label: "Malayalam" },
  bn: { code: "bn-IN", label: "Bengali" },
  gu: { code: "gu-IN", label: "Gujarati" },
  pa: { code: "pa-IN", label: "Punjabi" },
  od: { code: "od-IN", label: "Odia" },
};

/** "hi", "hi-IN", "HI" and "hindi" all mean the same thing to a caller. */
export function normalizeLanguage(language) {
  if (!language) return "en";
  const raw = String(language).trim().toLowerCase();
  if (raw === "auto") return "auto";
  const short = raw.split(/[-_]/)[0];
  return SARVAM_LANGUAGES[short] ? short : "en";
}

/** The BCP-47 code Sarvam wants, or "auto" for detection. */
function sarvamCode(language) {
  const lang = normalizeLanguage(language);
  return lang === "auto" ? "auto" : SARVAM_LANGUAGES[lang].code;
}

/** Sarvam's "hi-IN" back to our "hi", for a detection result. */
export function shortLanguage(code) {
  if (!code) return null;
  const short = String(code).trim().toLowerCase().split(/[-_]/)[0];
  return SARVAM_LANGUAGES[short] ? short : null;
}

/**
 * The key, with surrounding whitespace removed.
 *
 * ⚠️ NOT DEFENSIVE PROGRAMMING FOR ITS OWN SAKE — this cost a real debugging
 * session on the live Render instance. Render's environment editor is a
 * multi-line box, so a pasted key very easily carries a trailing space or
 * newline. That value is still truthy, so every "is Sarvam configured?" check
 * passed and the boot log said the Indian-language path was ready — and then
 * every actual request was rejected by Sarvam, because the header contained a
 * key with a space on the end.
 *
 * The symptom is the worst kind: English works (different provider), every
 * other language fails, the key is visibly present in the dashboard, and
 * nothing anywhere says why. Trimming costs nothing and removes the entire
 * class.
 *
 * The same trap applies to every other key in this project — DEEPGRAM_API_KEY
 * above all, since voice cannot run without it. Worth doing there too.
 */
function sarvamKey() {
  return (process.env.SARVAM_API_KEY || "").trim();
}

export function sarvamConfigured() {
  return Boolean(sarvamKey());
}

export function sarvamConfigError() {
  if (sarvamConfigured()) return null;
  return (
    "SARVAM_API_KEY is not set, so the relay cannot hear or speak any language " +
    "other than English. Sarvam gives new accounts Rs 100 of credit, which is " +
    "several hours of speech — enough to prove the whole path."
  );
}

// The voice half only — hearing has its own line in voiceStt.js, and one string
// covering both reads as a single provider doing one thing, which is exactly
// the confusion the boot log exists to prevent.
export function sarvamStatusLine(language) {
  const lang = normalizeLanguage(language);
  // "auto" opens in English because the greeting happens before anyone has
  // spoken; say so rather than printing "auto", which would imply the voice is
  // deciding something it cannot yet decide.
  const which = lang === "auto" ? "opens in English" : SARVAM_LANGUAGES[lang].label;
  return `Sarvam ${TTS_MODEL} (${TTS_SPEAKER}, ${which})`;
}

function authHeaders() {
  return { "api-subscription-key": sarvamKey() };
}

// ── Hearing ─────────────────────────────────────────────────────────────────

/**
 * Sarvam realtime STT, presenting the same surface as DeepgramStt.
 *
 * The relay must not be able to tell which recogniser is behind it, so the
 * callbacks are identical: speechStarted / transcript / eagerTurn / turn / error.
 *
 * ⚠️ ONE CALLBACK IS STRUCTURALLY WEAKER HERE. Deepgram distinguishes `is_final`
 * (this fragment will not change) from `speech_final` (and they have stopped),
 * which is what lets the relay start generating during the endpointing silence
 * and have an answer buffered before the turn confirms. Sarvam emits partials
 * and one final, with no settled-but-not-finished state in between, so
 * `onEagerTurn` NEVER FIRES on this path and speculative generation is off.
 *
 * That is a real latency cost but a small one, and it is measured rather than
 * guessed at: the README's own finding was that speculation is the *smaller*
 * win because a short question arrives as a single final chunk anyway, and the
 * spoken acknowledgement carries most of the perceived speed. It is worth
 * re-measuring per language with eval:voice rather than assuming it transfers.
 */
export class SarvamStt {
  constructor({
    sampleRate = PIPELINE_RATE,
    language = "en",
    keyterms = [],
    onSpeechStarted,
    onTranscript,
    onEagerTurn,
    onTurn,
    onLanguage,
    onError,
  }) {
    this.language = normalizeLanguage(language);
    this.keyterms = (keyterms || []).filter(Boolean).slice(0, 20);
    this.onSpeechStarted = onSpeechStarted || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.onEagerTurn = onEagerTurn || (() => {});
    this.onTurn = onTurn || (() => {});
    // Not part of the Deepgram surface: fires when detection reports which
    // language the caller is actually speaking. Optional on purpose, so the
    // relay can adopt it without every other caller of makeStt changing.
    this.onLanguage = onLanguage || (() => {});
    this.onError = onError || (() => {});

    this.ws = null;
    this.closed = false;
    this.ready = false;
    // Frames that arrive before the socket finishes opening. Dropping them
    // clips the first word of a caller who starts talking immediately, which is
    // most callers, since the greeting invites them to.
    this.backlog = [];
    this.resampler = new Resampler({ from: sampleRate, to: STT_SAMPLE_RATE });
    this.pingTimer = null;
    this.audioSeconds = 0;
  }

  start() {
    const params = new URLSearchParams({
      model: STT_MODEL,
      language_code: sarvamCode(this.language),
      stream_type: STT_STREAM_TYPE,
      // Sarvam runs the turn detection, the same division of labour as
      // Deepgram's endpointing. `manual` would mean hand-rolling voice-activity
      // detection off frame amplitude, which is the thing a hosted recogniser is
      // actually worth paying for.
      endpointing: "vad",
      encoding: "linear16",
      sample_rate: String(STT_SAMPLE_RATE),
      threshold: String(STT_VAD_THRESHOLD),
      silence_duration_ms: String(STT_SILENCE_MS),
      min_speech_duration_ms: String(STT_MIN_SPEECH_MS),
      // Plain transcription. NOT `translate`, which would hand back English for
      // a Hindi caller — the extractor stores the caller's own words as evidence
      // under every value it files, and a translation is not their words.
      mode: "transcribe",
    });
    // Sarvam's equivalent of Deepgram keyterm boosting: a free-text terminology
    // hint rather than a repeated parameter.
    //
    // The caller's OWN terms go first because the hint is length-capped and
    // truncation should eat the standing vocabulary rather than this caller's
    // name — a name is the hardest thing for any recogniser (arbitrary proper
    // noun, no language model behind it) and the one term we actually know in
    // advance for this specific call.
    const prompt = [...this.keyterms, ...STT_PROMPT_TERMS].join(", ");
    if (prompt) params.set("prompt", prompt.slice(0, 500));

    const ws = new WebSocket(`wss://${HOST}/speech-to-text-realtime/ws?${params}`, {
      headers: authHeaders(),
    });
    this.ws = ws;

    ws.on("open", () => {
      this.ready = true;
      for (const chunk of this.backlog) this.send(chunk);
      this.backlog = [];
      // Sarvam documents a ping/pong. Audio flows continuously on a live call so
      // this should never be needed, but a muted caller on a long hold is
      // exactly the case nobody tests and "the call died after four minutes" is
      // expensive to diagnose after the fact.
      this.pingTimer = setInterval(() => this.send({ event: "ping" }), 20000);
    });
    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("error", (e) => {
      if (this.closed) return;
      this.onError(`Sarvam STT socket error: ${e.message}`);
    });
    ws.on("close", (code, reason) => {
      this.ws = null;
      this.ready = false;
      clearInterval(this.pingTimer);
      if (this.closed) return;
      // 4000 is Sarvam's "your audio format is wrong" and it is worth naming,
      // because the symptom is a call where the agent simply never responds and
      // the cause is a number in a query string.
      if (code === 4000) {
        this.onError(
          `Sarvam STT rejected the audio format (code 4000) — it accepts 8000 or 16000 Hz only, and was sent ${STT_SAMPLE_RATE}`
        );
        return;
      }
      this.onError(`Sarvam STT socket closed unexpectedly (${code} ${reason || "no reason"})`);
    });
    return this;
  }

  send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      /* socket going away; the close handler reports it */
    }
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    switch (msg.event) {
      case "session.begin":
        return;

      case "vad.speech_start":
        // The relay decides barge-in on recognised WORDS rather than on this,
        // because a caller on speakerphone leaks the agent's own voice back into
        // the mic and this event fires on that leak. Passed through unchanged so
        // that rule keeps living in one place.
        this.onSpeechStarted();
        return;

      case "vad.speech_end":
        // No action: the final transcript follows and carries the turn. Acting
        // here would end the turn before its text existed.
        return;

      case "transcript.partial": {
        const text = (msg.text || "").trim();
        if (text) this.onTranscript(text, false);
        return;
      }

      case "transcript.final": {
        const text = (msg.text || "").trim();
        // Detection reports on the final, and it reports even when the text is
        // empty. Surface it either way — a language signal costs nothing to
        // carry and a turn with no words still tells you who is on the phone.
        if (msg.language) {
          const short = shortLanguage(msg.language);
          if (short) this.onLanguage(short, Number(msg.language_confidence ?? 0), text);
        }
        if (!text) return;
        this.onTranscript(text, true);
        this.onTurn(text);
        return;
      }

      case "session.end":
        // Sarvam calls this the billing authority, so it is the honest number to
        // log rather than our own wall-clock guess.
        if (msg.audio_duration_s) {
          this.audioSeconds = msg.audio_duration_s;
          console.log(`[voice:sarvam] billed ${msg.audio_duration_s}s of audio`);
        }
        return;

      case "error":
        this.onError(`Sarvam STT: ${msg.message || msg.code || "unspecified error"}`);
        // Non-fatal errors are a warning about one utterance; a fatal one means
        // the socket will not recover and pretending otherwise leaves the agent
        // silently deaf for the rest of the call.
        if (msg.is_fatal) this.close();
        return;

      default:
        return;
    }
  }

  /** Feed raw pcm_s16le mono at the pipeline rate. Resampled and framed here. */
  write(pcm) {
    if (this.closed || !pcm || !pcm.length) return;
    const down = this.resampler.process(pcm);
    if (!down.length) return;
    const msg = { event: "audio_input", audio: down.toString("base64") };
    // Before the socket is open, hold rather than drop — this is the caller's
    // first word.
    if (!this.ready) {
      // Bounded, so a socket that never opens cannot grow this without limit.
      // ~4s of audio is far longer than a handshake and far shorter than a
      // memory problem.
      if (this.backlog.length < 100) this.backlog.push(msg);
      return;
    }
    this.send(msg);
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.backlog = [];
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Flush the tail rather than dropping it — the last thing said on a call
      // is often the most useful thing said on a call.
      try {
        ws.send(JSON.stringify({ event: "end" }));
      } catch (e) {
        /* already going */
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

// ── Speaking ────────────────────────────────────────────────────────────────

/**
 * Sarvam bulbul over their streaming TTS websocket.
 *
 * Same three methods as AuraTts and CartesiaTts — connect / speak / close —
 * plus setLanguage(), which the English-only engines have no use for.
 *
 * ⚠️ THE SAME TRAP AS AURA, AND IT ALREADY REACHED A REAL CALLER ONCE. Audio
 * frames carry no request id, so there is nothing in a frame that says which
 * sentence it belongs to. When a request is abandoned mid-flight — a barge-in, a
 * stall — its remaining audio arrives while the NEXT sentence is playing and is
 * spliced into it, and the socket stays one request out of step for the rest of
 * the call. That was reported from a real call as the agent's voice breaking up
 * mid-word ("immm u...p..syyy").
 *
 * Aura solves it with an explicit Clear that Deepgram confirms. Sarvam does not
 * document a cancel of any kind, so the only sound move is heavier: an abnormal
 * end marks the socket dirty and the next speak() REPLACES it. That costs a
 * reconnect on every barge-in, which is a real latency cost on a real event —
 * so if Sarvam ever documents a cancel, this is the first thing to revisit.
 * Crossed audio is much worse than a slow recovery.
 */
export class SarvamTts {
  constructor({ language = "en", onError } = {}) {
    // A call in `auto` has to start speaking before anyone has said a word, so
    // there is nothing to detect from yet. English is the opening language and
    // setLanguage() moves it once the caller has actually spoken.
    const lang = normalizeLanguage(language);
    this.language = lang === "auto" ? "en" : lang;
    this.onError = onError || (() => {});
    this.ws = null;
    this.ready = null;
    this.pending = null;
    this.closed = false;
    this.dirty = false;
    this.seq = 0;
  }

  // Includes the language, not just the speaker, and that is the point: the same
  // speaker saying the same words in Hindi and in English is two different
  // recordings, so the phrase cache must not treat them as one. Read per
  // sentence, so a setLanguage() mid-call moves the key with it.
  get voiceId() {
    return `sarvam:${TTS_SPEAKER}:${this.language}`;
  }

  /**
   * Switch the voice's language mid-call.
   *
   * Sarvam takes the language in the config message, which is sent once per
   * socket, so this reconnects. Only ever called between sentences (the relay
   * speaks through one serial queue), so nothing is in flight when it happens.
   */
  async setLanguage(language) {
    const lang = normalizeLanguage(language);
    const next = lang === "auto" ? "en" : lang;
    if (next === this.language) return;
    this.language = next;
    await this.reconnect();
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: TTS_MODEL,
        // Without this there is no signal that a sentence is complete, and
        // speak() would have to guess from a silence gap — which is the same
        // class of mistake as the per-chunk pacing detector that shipped and
        // stuttered.
        send_completion_event: "true",
      });
      const ws = new WebSocket(`wss://${HOST}/text-to-speech/ws?${params}`, {
        headers: authHeaders(),
      });
      this.ws = ws;

      ws.on("open", () => {
        try {
          ws.send(
            JSON.stringify({
              type: "config",
              data: {
                target_language_code: SARVAM_LANGUAGES[this.language].code,
                speaker: TTS_SPEAKER,
                model: TTS_MODEL,
                // Raw PCM, so nothing has to be decoded before it reaches the
                // caller's speaker. mp3 would be smaller and would put a decoder
                // on the latency path for no benefit — this socket is
                // server-side and bandwidth is not the constraint.
                output_audio_codec: "linear16",
                speech_sample_rate: TTS_NATIVE_RATE,
                pace: TTS_PACE,
              },
            })
          );
        } catch (e) {
          reject(e);
          return;
        }
        resolve();
      });
      ws.on("message", (raw) => this.handleMessage(raw));
      ws.on("error", (e) => {
        this.onError(`Sarvam TTS socket error: ${e.message}`);
        reject(e);
      });
      ws.on("close", (code) => {
        this.ws = null;
        this.ready = null;
        if (!this.closed && this.pending) {
          this.pending.reject(new Error(`Sarvam TTS socket closed mid-sentence (code ${code})`));
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

    if (msg.type === "audio") {
      const b64 = msg.data?.audio;
      // No pending request means this belongs to something abandoned. Dropping
      // it is the whole point — see the class comment.
      if (!pending || !b64) return;
      const pcm = Buffer.from(b64, "base64");
      if (!pcm.length) return;
      pending.touch();
      pending.onAudio(pending.resampler.process(pcm));
      return;
    }

    if (msg.type === "event") {
      if (msg.data?.event_type === "final" && pending) {
        this.pending = null;
        pending.resolve();
      }
      return;
    }

    if (msg.type === "error") {
      const detail = msg.data?.message || "Sarvam reported a TTS error";
      if (pending) {
        this.pending = null;
        pending.reject(new Error(detail));
      } else {
        this.onError(`Sarvam TTS: ${detail}`);
      }
      return;
    }
  }

  /**
   * Cut a socket loose so that nothing it says afterwards can be heard.
   *
   * ⚠️ THE LISTENERS MUST COME OFF, AND close() IS NOT ENOUGH. This is the bug
   * that reached a real caller on the Aura path as the agent's voice breaking up
   * mid-word ("immm u...p..syyy"), and the first version of this file
   * reintroduced it in a new place.
   *
   * The mechanism: audio frames carry no request id, so handleMessage() can only
   * hand a frame to whatever `pending` happens to be current. `close()` starts a
   * closing HANDSHAKE — the socket stays open for a round trip and keeps
   * delivering frames that were already generated. Those frames arrive after
   * reconnect() has moved on, land on the NEXT sentence's `pending`, and get
   * spliced into the middle of it. Worse, a late `final` from the dead request
   * resolves the new sentence early, so the engine stays one request out of step
   * for the rest of the call.
   *
   * So: detach first, then terminate() rather than close(). Nothing graceful is
   * needed — this is a synthesis socket, there is no state on the far side worth
   * shutting down politely, and the entire point is that it must go quiet NOW.
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

  // Drop this socket and open a fresh one. Distinct from close(), which ends the
  // engine for good.
  async reconnect() {
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    this.dirty = false;
    this.discard(ws);
    if (!this.closed) await this.connect();
  }

  async speak(text, onAudio, signal) {
    if (!text || !text.trim()) return;
    if (signal?.aborted) return;
    await this.connect();
    if (signal?.aborted) return;

    // Nothing may still be generating for a request nobody owns.
    if (this.dirty) await this.reconnect();
    if (signal?.aborted) return;

    // Every line above this one can await, and the socket can be replaced under
    // us while they do — setLanguage() does exactly that. The relay orders its
    // own calls so this should not happen, but "should not" is what the last
    // version of that reasoning said before a switch landed on top of an
    // in-flight sentence. Re-open rather than throw: this is a recoverable
    // state, and throwing here surfaces to the caller as the agent going silent.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.reconnect();
      if (signal?.aborted) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("Sarvam TTS socket could not be reopened");
      }
    }

    const mine = ++this.seq;

    return new Promise((resolve, reject) => {
      // A sentence must never be able to hang the speech chain. Every spoken
      // line goes through one serial queue in voiceRelay.js, so a single hang
      // silences the agent for the rest of the call with no error raised
      // anywhere. Two ceilings, because "stalled" and "slow" are different
      // faults: a sentence still delivering audio is alive however long it
      // takes, while one that has sent nothing for five seconds is gone.
      let idle;
      const giveUp = (why) => {
        if (this.pending?.seq !== mine) return;
        this.pending = null;
        this.dirty = true;
        this.onError(`Sarvam TTS ${why} — abandoning this sentence and replacing the socket`);
        resolve();
      };
      const total = setTimeout(
        () => giveUp(`ran past its ceiling (${SPEAK_TIMEOUT_MS}ms)`),
        SPEAK_TIMEOUT_MS
      );
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => giveUp(`went silent mid-sentence (no audio for ${IDLE_TIMEOUT_MS}ms)`),
          IDLE_TIMEOUT_MS
        );
      };
      arm();

      const settle = (fn) => (v) => {
        clearTimeout(total);
        clearTimeout(idle);
        fn(v);
      };
      resolve = settle(resolve);
      reject = settle(reject);

      this.pending = {
        onAudio,
        resolve,
        reject,
        seq: mine,
        touch: arm,
        // One per sentence, not one per socket: the converter carries a sample
        // across chunk boundaries, and that carried sample belongs to this
        // sentence. Sharing it would leak a few samples of the previous
        // sentence into the front of this one.
        resampler: new Resampler({ from: TTS_NATIVE_RATE, to: PIPELINE_RATE }),
      };

      const onAbort = () => {
        if (this.pending?.seq !== mine) return;
        this.pending = null;
        // Sarvam keeps generating until the socket goes away, so it cannot be
        // trusted until it has been replaced. Done before the NEXT speak rather
        // than here, so barge-in stays instant.
        this.dirty = true;
        // Resolve, not reject: an interrupted sentence is a normal event on a
        // phone call, not a failure.
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.ws.send(JSON.stringify({ type: "text", data: { text } }));
        // Without an explicit flush, bulbul waits for more text before it starts
        // — right for a token stream, wrong for us, because the relay already
        // hands it one complete sentence at a time.
        this.ws.send(JSON.stringify({ type: "flush" }));
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
