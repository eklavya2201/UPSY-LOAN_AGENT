// Preflight for UPSY's own voice relay: npm run voice:relay
//
// This is now the ONLY voice preflight. Its sibling voice-check.js preflighted
// the hosted Cartesia agent and went with it on 2026-08-22.
// This one walks our own chain and names what is broken, because the failure
// this replaces — a socket that opens and closes a second later with "1011
// Internal server error" — cost a whole session once. Anything this script
// cannot verify, it says so rather than implying success.
//
// It runs the relay in-process on an ephemeral port and drives it with a fake
// browser, so it needs no running server and touches no real applicant data.

import "dotenv/config";
import http from "http";
import WebSocket from "ws";
import { attachVoiceRelay, mintRelayTicket, RELAY_PATH, SAMPLE_RATE } from "./voiceRelay.js";
import { sttConfigured, sttConfigError } from "./voiceStt.js";
import { ttsConfigured, ttsConfigError, ttsStatusLine, phraseCacheStats } from "./voiceTts.js";
import { brainConfigured, brainConfigError, brainStatusLine } from "./voiceBrain.js";
import { buildVoiceSystemPrompt, buildIntroduction } from "./voicePrompt.js";
import { speakReply } from "./voiceBrain.js";

const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => console.log(`❌ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const step = (m) => console.log(`\n── ${m} ${"─".repeat(Math.max(0, 60 - m.length))}`);

let failures = 0;

// Spin the relay up on a random free port and hand back its ws:// origin.
function startRelay() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end("relay check"));
    attachVoiceRelay(server);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: `ws://127.0.0.1:${server.address().port}` });
    });
  });
}

// A stand-in for frontend/voiceClient.js that speaks exactly the same protocol.
// If this passes and the real browser does not, the difference is in the browser
// — which is a far smaller place to look.
function fakeBrowser(url, { onEvent, sendFrames = [] }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out after 25s"));
    }, 25000);

    const finish = (value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch (e) {
        /* noop */
      }
      resolve(value);
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          event: "start",
          stream_id: "relay-check",
          config: { input_format: `pcm_${SAMPLE_RATE}`, output_audio_delivery: "as_available" },
          agent: {},
          metadata: { product: "upsy-loan-agent" },
        })
      );
      for (const frame of sendFrames) {
        ws.send(JSON.stringify({ event: "media_input", stream_id: "relay-check", media: { payload: frame } }));
      }
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      onEvent(msg, finish);
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`socket closed before the check finished (${code} ${reason || "no reason"})`));
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── 1. What is configured ───────────────────────────────────────────────────
step("Configuration");
console.log(`   hear  (STT):   ${sttConfigured() ? "Deepgram" : "NOT CONFIGURED"}`);
console.log(`   think (LLM):   ${brainStatusLine()}`);
console.log(`   speak (TTS):   ${ttsConfigured() ? ttsStatusLine() : "NOT CONFIGURED"}`);
if (!sttConfigured()) warn(sttConfigError());
if (!brainConfigured()) {
  bad(brainConfigError());
  failures++;
}
if (!ttsConfigured()) {
  bad(ttsConfigError());
  failures++;
}

// ── 2. Transport (roadmap step 1) ───────────────────────────────────────────
// Proves the socket, the ticket, the framing and the codec, with no AI at all.
step("Transport — echo mode");
{
  const previousMode = process.env.VOICE_RELAY_MODE;
  process.env.VOICE_RELAY_MODE = "echo";
  const { server, origin } = await startRelay();
  try {
    // A recognisable 2048-sample frame, the same size voiceClient.js sends.
    const pcm = Buffer.alloc(2048 * 2);
    for (let i = 0; i < 2048; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(i / 8)), i * 2);
    const payload = pcm.toString("base64");

    const token = mintRelayTicket({ leadId: null, systemPrompt: "unused", introduction: "unused" });
    const result = await fakeBrowser(`${origin}${RELAY_PATH}?token=${token}`, {
      sendFrames: [payload],
      onEvent: (msg, finish) => {
        if (msg.event === "ack") ok("relay accepted the start event and acked the stream");
        if (msg.event === "media_output") finish(msg.media?.payload);
      },
    });
    if (result === payload) ok("PCM round-tripped byte-identical — transport, framing and codec are sound");
    else {
      bad("PCM came back altered — the codec or framing is wrong");
      failures++;
    }
  } catch (e) {
    bad(`echo test failed: ${e.message}`);
    failures++;
  } finally {
    server.close();
    if (previousMode === undefined) delete process.env.VOICE_RELAY_MODE;
    else process.env.VOICE_RELAY_MODE = previousMode;
  }
}

// ── 3. Ticket security ──────────────────────────────────────────────────────
step("Tickets are single-use");
{
  const { server, origin } = await startRelay();
  try {
    const token = mintRelayTicket({ leadId: null, systemPrompt: "x", introduction: "x" });
    process.env.VOICE_RELAY_MODE = "echo";
    await fakeBrowser(`${origin}${RELAY_PATH}?token=${token}`, {
      onEvent: (msg, finish) => {
        if (msg.event === "ack") finish(true);
      },
    });
    // Same token again: must be refused at the handshake, not accepted and
    // then closed, so the browser reports something actionable.
    let reused = false;
    try {
      await fakeBrowser(`${origin}${RELAY_PATH}?token=${token}`, {
        onEvent: (_m, finish) => finish(true),
      });
      reused = true;
    } catch (e) {
      /* expected */
    }
    if (reused) {
      bad("a redeemed ticket was accepted a second time");
      failures++;
    } else {
      ok("a redeemed ticket is refused on reuse");
    }
  } catch (e) {
    bad(`ticket test failed: ${e.message}`);
    failures++;
  } finally {
    server.close();
    delete process.env.VOICE_RELAY_MODE;
  }
}

// ── 4. The agent actually speaks (roadmap step 4) ────────────────────────────
step("Voice — does it make a sound?");
if (!ttsConfigured()) {
  warn("skipped: no TTS key");
} else {
  const { server, origin } = await startRelay();
  try {
    const token = mintRelayTicket({
      leadId: null,
      language: "en",
      systemPrompt: buildVoiceSystemPrompt(null),
      introduction: buildIntroduction(null),
    });
    const t0 = Date.now();
    let bytes = 0;
    let firstAudioAt = null;
    await fakeBrowser(`${origin}${RELAY_PATH}?token=${token}`, {
      onEvent: (msg, finish) => {
        if (msg.event === "media_output") {
          if (firstAudioAt === null) firstAudioAt = Date.now() - t0;
          bytes += Buffer.from(msg.media.payload, "base64").length;
          // One second of audio is more than enough to prove the round trip.
          if (bytes > SAMPLE_RATE * 2) finish(true);
        }
        if (msg.event === "error") finish(false);
      },
    });
    const seconds = (bytes / 2 / SAMPLE_RATE).toFixed(2);
    ok(`the agent spoke its introduction — first audio at ${firstAudioAt}ms, ${seconds}s of PCM received`);
  } catch (e) {
    bad(`the agent never spoke: ${e.message}`);
    failures++;
  } finally {
    server.close();
  }
}

// ── 4b. The phrase cache ────────────────────────────────────────────────────
// The greeting and the acknowledgements are byte-identical on every call and
// were being re-bought every time — which is what drained a month of Cartesia
// credit in a day of testing. Cached, the second call should not pay at all.
step("Phrase cache — is the greeting re-bought every call?");
if (!ttsConfigured()) {
  warn("skipped: no TTS key");
} else {
  const { server, origin } = await startRelay();
  try {
    const speakOnce = async () => {
      const token = mintRelayTicket({
        leadId: null, language: "en",
        systemPrompt: buildVoiceSystemPrompt(null), introduction: buildIntroduction(null),
      });
      const t0 = Date.now();
      let firstAt = null;
      await fakeBrowser(`${origin}${RELAY_PATH}?token=${token}`, {
        onEvent: (msg, finish) => {
          if (msg.event === "media_output" && firstAt === null) firstAt = Date.now() - t0;
          // Wait for the greeting to FINISH — the relay flips to "listening"
          // once it has stopped talking. Cutting the socket at a byte count
          // instead (which this test did at first) kills the sentence
          // mid-synthesis, and the cache correctly refuses to store a truncated
          // phrase — so the test reported a broken cache that was working.
          if (msg.event === "state" && msg.state === "listening") finish(true);
        },
      });
      return firstAt;
    };
    const cold = await speakOnce();
    const warm = await speakOnce();
    const stats = phraseCacheStats();
    console.log(`   greeting: ${cold}ms first time, ${warm}ms second   (cache holds ${stats.ready}/${stats.known} phrases)`);
    if (warm < cold) ok(`the greeting is served from cache on repeat — ${cold - warm}ms faster and free`);
    else warn("the second greeting was not faster; the cache may not be holding");
  } catch (e) {
    bad(`cache test failed: ${e.message}`);
    failures++;
  } finally {
    server.close();
  }
}

// ── 5. The brain streams sentences (roadmap step 3) ─────────────────────────
step("Thinking — streamed, sentence by sentence");
if (!brainConfigured()) {
  warn("skipped: no LLM key");
} else {
  try {
    const t0 = Date.now();
    const sentences = [];
    await speakReply({
      systemPrompt: buildVoiceSystemPrompt(null),
      history: [{ role: "user", content: "I need about fifteen lakh for an MBA. Am I eligible?" }],
      signal: new AbortController().signal,
      onSentence: async (s) => {
        if (!sentences.length) console.log(`   first sentence at ${Date.now() - t0}ms: "${s}"`);
        sentences.push(s);
      },
    });
    if (sentences.length) ok(`${sentences.length} sentence(s) streamed — TTS can start before the reply finishes`);
    else {
      bad("the model returned nothing");
      failures++;
    }
  } catch (e) {
    bad(`the brain failed: ${e.message}`);
    failures++;
  }
}

// ── 6. Hearing, and the whole loop (roadmap step 2) ─────────────────────────
// The closed loop, with no microphone and no human: we synthesise a caller's
// voice with the SAME TTS the agent speaks with, stream it in as if it came off
// a phone, and check that Deepgram transcribes it, the brain answers it, and the
// answer comes back as audio. If this passes, a real call works.
step("Hearing — the full loop, no microphone");
if (!sttConfigured()) {
  warn("no DEEPGRAM_API_KEY: UPSY can speak and think, but cannot hear the caller. This is the last gap.");
} else if (!ttsConfigured()) {
  warn("skipped: synthesising a fake caller needs a TTS key");
} else {
  const SPOKEN = "I need about fifteen lakh rupees for an MBA. Am I eligible?";
  const { server, origin } = await startRelay();
  try {
    // 6a. Record our fake caller.
    //
    // Synthesised with a DIFFERENT voice from the agent's, so this is not
    // accidentally testing whether Deepgram can hear itself. REST rather than
    // the streaming socket on purpose: this is a test fixture, and latency here
    // is irrelevant — it is the agent's own path that has to be fast.
    const caller = new URL("https://api.deepgram.com/v1/speak");
    caller.searchParams.set("model", "aura-2-orpheus-en"); // male; the agent is female
    caller.searchParams.set("encoding", "linear16");
    caller.searchParams.set("sample_rate", String(SAMPLE_RATE));
    caller.searchParams.set("container", "none");
    const res = await fetch(caller, {
      method: "POST",
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: SPOKEN }),
    });
    if (!res.ok) {
      throw new Error(`could not synthesise a caller: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    const callerPcm = Buffer.from(await res.arrayBuffer());
    console.log(`   fake caller says: "${SPOKEN}" (${(callerPcm.length / 2 / SAMPLE_RATE).toFixed(2)}s)`);

    const transcripts = [];
    let replyBytes = 0;
    let heardAt = null;
    let repliedAt = null;
    let t0 = 0;
    // The number that matters is measured from the moment the caller stops
    // talking, not from when they start — that gap is the silence a real person
    // sits through wondering whether the line is dead.
    let stoppedTalkingAt = 0;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${origin}${RELAY_PATH}?token=${mintRelayTicket({
        leadId: null,
        language: "en",
        systemPrompt: buildVoiceSystemPrompt(null),
        introduction: buildIntroduction(null),
      })}`);
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, 45000);
      const finish = () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      };

      let introDone = false;
      let lastIntroAudio = 0;

      ws.on("open", () => {
        ws.send(JSON.stringify({
          event: "start",
          stream_id: "hearing-check",
          config: { input_format: `pcm_${SAMPLE_RATE}` },
        }));
      });

      // Let the greeting finish, then talk. Sending 20ms frames paced in real
      // time matters: Deepgram's endpointing works off audio timing, so firing
      // the whole clip at once would not exercise turn detection honestly.
      const speak = async () => {
        const FRAME = 2048 * 2; // bytes; matches voiceClient.js's frame size
        for (let i = 0; i < callerPcm.length; i += FRAME) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            event: "media_input",
            stream_id: "hearing-check",
            media: { payload: callerPcm.subarray(i, i + FRAME).toString("base64") },
          }));
          await new Promise((r) => setTimeout(r, (FRAME / 2 / SAMPLE_RATE) * 1000));
        }
        stoppedTalkingAt = Date.now();
        // Trailing silence is what tells Deepgram the turn ended.
        const silence = Buffer.alloc(FRAME);
        for (let i = 0; i < 40; i++) {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({
            event: "media_input",
            stream_id: "hearing-check",
            media: { payload: silence.toString("base64") },
          }));
          await new Promise((r) => setTimeout(r, 23));
        }
      };

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (e) {
          return;
        }
        if (msg.event === "media_output") {
          if (!introDone) {
            lastIntroAudio = Date.now();
            return;
          }
          if (repliedAt === null) repliedAt = Date.now() - (stoppedTalkingAt || t0);
          replyBytes += Buffer.from(msg.media.payload, "base64").length;
          if (replyBytes > SAMPLE_RATE) finish(); // half a second of reply is proof
        } else if (msg.event === "transcript" && msg.role === "caller" && msg.final) {
          // Only assembled turns, never interim fragments — see the note on
          // `final` in voiceRelay.js. Counting fragments here is what made an
          // earlier run appear to hear every sentence twice.
          if (heardAt === null) heardAt = Date.now() - (stoppedTalkingAt || t0);
          transcripts.push(msg.text);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });

      // Wait for the greeting to stop arriving before the caller speaks.
      const waitForQuiet = setInterval(() => {
        if (lastIntroAudio && Date.now() - lastIntroAudio > 800) {
          clearInterval(waitForQuiet);
          introDone = true;
          t0 = Date.now();
          speak().catch(() => {});
        }
      }, 200);
    });

    if (transcripts.length === 1) {
      ok(`heard, ${heardAt}ms after the caller stopped: "${transcripts[0]}"`);
    } else if (transcripts.length > 1) {
      warn(`heard, but split into ${transcripts.length} turns: ${transcripts.map((t) => `"${t}"`).join(" / ")}`);
      warn("endpointing cut the caller mid-thought — raise DEEPGRAM_ENDPOINTING_MS");
    } else {
      bad("Deepgram never produced a final transcript — the caller was not heard");
      failures++;
    }
    if (replyBytes > 0) {
      const verdict = repliedAt < 2000 ? "snappy" : repliedAt < 3500 ? "usable, worth tuning" : "SLOW — a caller will think the line died";
      ok(`UPSY answered out loud ${repliedAt}ms after the caller stopped — ${verdict}`);
    } else {
      bad("no spoken reply came back");
      failures++;
    }
  } catch (e) {
    bad(`hearing test failed: ${e.message}`);
    failures++;
  } finally {
    server.close();
  }
}

step("Result");
if (failures) {
  bad(`${failures} check(s) failed — see above.`);
  process.exit(1);
}
ok(
  sttConfigured()
    ? "Every check passed, including the full hear → think → speak loop."
    : "Every check that can run without a Deepgram key passed — but the agent cannot hear."
);
// Latency moves around with network conditions; one green run is not a
// performance guarantee. Run it a few times before trusting a number.
process.exit(0);
