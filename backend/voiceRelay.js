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
// The `transcript` event below is what m.js's matchTopic() has been waiting for.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { makeStt, sttConfigured, sttConfigError } from "./voiceStt.js";
import { makeTts, ttsConfigured, ttsConfigError, TTS_SAMPLE_RATE } from "./voiceTts.js";
import { speakReply, brainConfigured, brainConfigError, brainStatusLine, MAX_HISTORY } from "./voiceBrain.js";
import { pickAcknowledgement } from "./voiceFillers.js";
import { stretchGaps } from "./voicePacing.js";

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
  const speak = ttsConfigured() ? "Cartesia Sonic" : "MUTE (no CARTESIA_API_KEY)";
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

    // Speak first. Beyond being the right conversational move, this is what
    // proves the audio round trip: voiceClient.js treats a socket that closes
    // before any audio arrived as a failed call rather than a hang-up.
    this.setState("speaking");
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
          send(this.ws, { event: "transcript", role: "agent", text: sentence, final: true });
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
        send(this.ws, { event: "transcript", role: "agent", text: ack, final: true });
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
          send(this.ws, { event: "transcript", role: "agent", text: sentence, final: true });
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
          send(this.ws, { event: "transcript", role: "agent", text: sentence, final: true });
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
      }
    }
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
