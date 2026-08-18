// Preflight for the Sarvam path: npm run voice:sarvam
//
// The sibling of voice-relay-check.js, which walks the English chain. This one
// answers the questions that path cannot: can we hear Hindi, can we speak it,
// and does automatic detection actually name the language a caller is using.
//
// It runs the same trick as voice:relay — SYNTHESISE THE CALLER. Sarvam's own
// voice speaks a Hindi sentence, that audio is streamed into Sarvam's recogniser
// at real-time pace, and the check asserts the words come back and the language
// is identified. No microphone, no browser, no human, and it names the broken
// link rather than making you find it.
//
// ⚠️ WHAT THIS CANNOT TELL YOU. It cannot tell you the voice sounds good, and
// picking a voice without listening is the mistake this repo has already made
// twice (Skylar, then Kiara, both chosen from a catalogue's prose, both wrong).
// It writes a wav file at the end for exactly that reason: listen to it before
// any of this reaches a caller.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  SarvamStt,
  SarvamTts,
  sarvamConfigured,
  sarvamConfigError,
  sarvamStatusLine,
  SARVAM_LANGUAGES,
} from "./voiceSarvam.js";
import { Resampler, resampleBuffer } from "./voiceResample.js";

const ok = (m) => console.log(`✅ ${m}`);
const bad = (m) => console.log(`❌ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const info = (m) => console.log(`   ${m}`);
const step = (m) => console.log(`\n── ${m} ${"─".repeat(Math.max(0, 58 - m.length))}`);

let failures = 0;
const fail = (m) => {
  failures++;
  bad(m);
};

const PIPELINE_RATE = 44100;

// What the synthetic caller says, per language. Each one is a real thing a
// caller says on this product — an amount, a course, a co-applicant — because a
// recogniser that handles "hello, testing" and mangles "pandrah lakh" is no use
// here. The `expect` terms are what the assertion looks for.
const SCRIPTS = {
  hi: {
    text: "मुझे एमबीए के लिए पंद्रह लाख रुपये का लोन चाहिए। क्या मैं eligible हूँ?",
    expect: ["लाख", "लोन", "एमबीए"],
    label: "Hindi",
  },
  mr: {
    text: "मला माझ्या मुलीच्या शिक्षणासाठी वीस लाख रुपयांचे कर्ज हवे आहे.",
    expect: ["लाख", "कर्ज"],
    label: "Marathi",
  },
  te: {
    text: "నాకు ఎంబీఏ చదవడానికి పదిహేను లక్షల రుణం కావాలి.",
    expect: ["లక్ష", "రుణం"],
    label: "Telugu",
  },
};

// ── 1. Configuration ────────────────────────────────────────────────────────
step("Configuration");
if (!sarvamConfigured()) {
  bad(sarvamConfigError());
  console.log("\nNothing else in this check can run without a key. Stopping.\n");
  process.exit(1);
}
ok(`SARVAM_API_KEY is set — ${sarvamStatusLine("auto")}`);
info(`languages this path can carry: ${Object.values(SARVAM_LANGUAGES).map((l) => l.label).join(", ")}`);

// ── 2. The resampler, offline ───────────────────────────────────────────────
//
// First because everything downstream sits on it, and because it is the only
// part that can be proven without spending a paisa. A resampler that clicks at
// every chunk boundary degrades recognition in a way that looks exactly like a
// bad microphone, so it gets asserted rather than assumed.
step("Sample-rate conversion (offline, free)");
{
  const tone = (freq, rate, secs, amp = 12000) => {
    const n = Math.round(rate * secs);
    const b = Buffer.allocUnsafe(n * 2);
    for (let i = 0; i < n; i++) {
      b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
    }
    return b;
  };
  // Goertzel — energy at one frequency, per sample, so lengths are comparable.
  const energyAt = (buf, rate, freq) => {
    const n = buf.length / 2;
    const coeff = 2 * Math.cos((2 * Math.PI * freq) / rate);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2) + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
  };

  const oneSec = tone(440, PIPELINE_RATE, 1.0);
  const whole = resampleBuffer(oneSec, PIPELINE_RATE, 16000);
  if (Math.abs(whole.length / 2 - 16000) <= 3) ok(`44.1k→16k: 1.0s becomes ${whole.length / 2} samples`);
  else fail(`44.1k→16k produced ${whole.length / 2} samples, expected ~16000`);

  // The chunk-boundary assertion. Streaming and whole-buffer must agree sample
  // for sample, or the converter is losing the interval across every seam.
  const rs = new Resampler({ from: PIPELINE_RATE, to: 16000 });
  const parts = [];
  for (let off = 0; off < oneSec.length; off += 4096) {
    parts.push(rs.process(oneSec.subarray(off, Math.min(off + 4096, oneSec.length))));
  }
  const streamed = Buffer.concat(parts);
  let maxDiff = 0;
  for (let i = 0; i < Math.min(streamed.length, whole.length) / 2; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(streamed.readInt16LE(i * 2) - whole.readInt16LE(i * 2)));
  }
  if (maxDiff <= 2 && Math.abs(streamed.length - whole.length) <= 4) {
    ok("streaming in chunks is sample-identical to converting the whole buffer");
  } else {
    fail(`chunked conversion drifts from whole-buffer (max sample diff ${maxDiff}) — every chunk boundary is a click`);
  }

  // Aliasing. 12kHz folds to 4kHz when decimated to 16k, landing on top of
  // speech. The 4-pole filter this started with left the image only 26.7dB
  // down, which is why it is 6-pole now.
  const image = energyAt(resampleBuffer(tone(12000, PIPELINE_RATE, 0.5), PIPELINE_RATE, 16000), 16000, 4000);
  const real = energyAt(resampleBuffer(tone(4000, PIPELINE_RATE, 0.5), PIPELINE_RATE, 16000), 16000, 4000);
  const dB = 20 * Math.log10(Math.max(image, 1e-9) / real);
  if (dB < -35) ok(`anti-alias filter holds a 12kHz tone ${dB.toFixed(1)}dB below a real 4kHz one`);
  else fail(`aliasing only ${dB.toFixed(1)}dB down — high frequencies are folding into the speech band`);

  let worst = 0;
  for (const f of [300, 1000, 3000]) {
    const t = tone(f, PIPELINE_RATE, 0.5);
    const loss = 20 * Math.log10(energyAt(resampleBuffer(t, PIPELINE_RATE, 16000), 16000, f) / energyAt(t, PIPELINE_RATE, f));
    worst = Math.min(worst, loss);
  }
  if (worst > -1.5) ok(`speech band passes untouched (worst loss ${worst.toFixed(2)}dB at 300/1k/3kHz)`);
  else fail(`the filter is eating speech: ${worst.toFixed(2)}dB lost in the 300-3000Hz band`);
}

// ── 3. Does it speak? ───────────────────────────────────────────────────────
step("Speaking (bulbul)");

// Speaks TWICE down one engine, because the first number is not the number that
// matters. A fresh websocket costs a few hundred ms to open, and the relay opens
// one per CALL rather than per sentence precisely so that cost lands during
// "Connecting…" where nobody notices it. Every sentence after the first gets the
// warm figure, so that is the one to compare against Aura's ~396ms.
async function synthesise(language, text) {
  const tts = new SarvamTts({ language, onError: (m) => warn(m) });
  const run = async () => {
    const chunks = [];
    const started = Date.now();
    let firstChunkMs = null;
    await tts.speak(
      text,
      (pcm) => {
        if (firstChunkMs === null) firstChunkMs = Date.now() - started;
        chunks.push(pcm);
      },
      null
    );
    return { pcm: Buffer.concat(chunks), firstChunkMs, totalMs: Date.now() - started, chunks: chunks.length };
  };
  try {
    const cold = await run();
    const warmRun = await run();
    return { ...warmRun, coldFirstChunkMs: cold.firstChunkMs };
  } finally {
    tts.close();
  }
}

const spoken = {};
for (const [lang, script] of Object.entries(SCRIPTS)) {
  try {
    const r = await synthesise(lang, script.text);
    const seconds = r.pcm.length / 2 / PIPELINE_RATE;
    if (!r.pcm.length) {
      fail(`${script.label}: bulbul returned no audio at all`);
      continue;
    }
    spoken[lang] = r.pcm;
    ok(
      `${script.label}: ${seconds.toFixed(2)}s of audio in ${r.chunks} chunks — first chunk ${r.firstChunkMs}ms warm (${r.coldFirstChunkMs}ms on a cold socket), done in ${r.totalMs}ms`
    );
    // The number that actually matters on a call is the warm first chunk: the
    // caller hears the front of the sentence then, not when it finishes, and the
    // socket is already open by their second sentence.
    if (r.firstChunkMs > 700) {
      warn(
        `  ${r.firstChunkMs}ms to first audio against Aura's ~396ms — that lands on the front of every reply, so weigh it before making this the English path too`
      );
    }
  } catch (e) {
    fail(`${script.label}: ${e.message}`);
  }
}

// ── 3b. Does an interrupted sentence leak into the next one? ────────────────
//
// THE MOST IMPORTANT CHECK IN THIS FILE, because it is the one that caught a
// real defect a caller reported as "the voice is breaking".
//
// Audio frames carry no request id, on this engine and on Aura alike, so a
// frame can only be handed to whatever request is current when it arrives. If
// an abandoned socket is still delivering — and `close()` keeps delivering for
// a full round trip — its audio lands inside the NEXT sentence.
//
// The give-away is that the DURATIONS SWAP PLACES, which is exactly how the
// same bug was found on the Aura path. So: measure a short sentence alone, then
// measure it again immediately after barging in on a long one. Intermittent by
// nature (it needs frames still in flight at the wrong moment), so it runs
// several times — one clean run proves nothing.
step("Interrupted speech (the 'voice is breaking' check)");
{
  const LONG =
    "आपके पिताजी की आमदनी ही यह तय करती है कि आपको कितना loan मिल सकता है, और उसके लिए हमें उनके तीन साल के ITR की ज़रूरत होगी।";
  const SHORT = "ठीक है।";
  const RUNS = 4;

  const say = async (tts, text, signal) => {
    const chunks = [];
    await tts.speak(text, (pcm) => chunks.push(pcm), signal);
    return Buffer.concat(chunks).length / 2 / PIPELINE_RATE;
  };

  try {
    let clean;
    {
      const tts = new SarvamTts({ language: "hi", onError: () => {} });
      await say(tts, LONG, null);
      clean = await say(tts, SHORT, null);
      tts.close();
    }
    info(`"${SHORT}" on its own is ${clean.toFixed(2)}s`);

    let contaminated = 0;
    for (let i = 0; i < RUNS; i++) {
      const tts = new SarvamTts({ language: "hi", onError: () => {} });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 700); // a caller talking over the agent
      await say(tts, LONG, ac.signal);
      const after = await say(tts, SHORT, null);
      tts.close();
      const drift = clean > 0 ? after / clean : 0;
      if (drift > 1.6 || drift < 0.4) {
        contaminated++;
        info(`  run ${i + 1}: ${after.toFixed(2)}s — ${drift.toFixed(2)}x, abandoned audio leaked in`);
      }
    }
    if (contaminated === 0) {
      ok(`${RUNS} interruptions, none of them leaked audio into the following sentence`);
    } else {
      fail(
        `${contaminated}/${RUNS} interruptions spliced abandoned audio into the next sentence — this is heard as the voice breaking up mid-word`
      );
    }
  } catch (e) {
    fail(`interruption check: ${e.message}`);
  }
}

// ── 4. Does it hear, and does it know which language? ───────────────────────
step("Hearing + automatic language detection (saaras realtime)");

// Stream audio in at real-time pace, the way a caller's browser does. Firing it
// all at once would test something nobody experiences: the recogniser's VAD
// decides turns from timing, so timing has to be real.
function streamToStt(stt, pcm, { frameMs = 40 } = {}) {
  return new Promise((resolve) => {
    const bytesPerFrame = Math.round((PIPELINE_RATE * frameMs) / 1000) * 2;
    let off = 0;
    const tick = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(tick);
        resolve();
        return;
      }
      stt.write(pcm.subarray(off, Math.min(off + bytesPerFrame, pcm.length)));
      off += bytesPerFrame;
    }, frameMs);
  });
}

async function hear(pcm, { language, label }) {
  return new Promise(async (resolve) => {
    const result = { transcript: "", detected: null, confidence: 0, sawPartial: false, error: null };
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      stt.close();
      resolve(result);
    };

    const stt = new SarvamStt({
      sampleRate: PIPELINE_RATE,
      language,
      // The standing lending vocabulary, same intent as the Deepgram keyterms.
      keyterms: ["lakh", "crore", "EMI", "moratorium", "co-applicant", "Aadhaar"],
      onTranscript: (_t, isFinal) => {
        if (!isFinal) result.sawPartial = true;
      },
      onLanguage: (short, confidence) => {
        result.detected = short;
        result.confidence = confidence;
      },
      onTurn: (text) => {
        result.transcript = text;
        // Give detection a moment to land alongside the final, then stop.
        setTimeout(done, 250);
      },
      onError: (m) => {
        result.error = m;
      },
    }).start();

    // Generous: the audio itself is ~5s, plus the endpointing silence.
    const guard = setTimeout(done, 30000);

    await streamToStt(stt, pcm);
    // Trailing silence, so the VAD sees the caller stop rather than the stream
    // simply ending. Without this a turn may never be emitted.
    await streamToStt(stt, Buffer.alloc(PIPELINE_RATE * 2 * 1.2), { frameMs: 40 });
  });
}

for (const [lang, script] of Object.entries(SCRIPTS)) {
  const pcm = spoken[lang];
  if (!pcm) {
    warn(`${script.label}: skipped — nothing was synthesised to play back`);
    continue;
  }
  try {
    const heard = await hear(pcm, { language: "auto", label: script.label });
    if (heard.error) warn(`${script.label}: ${heard.error}`);

    if (!heard.transcript) {
      fail(`${script.label}: nothing came back — the recogniser heard silence`);
      continue;
    }
    info(`${script.label} heard as: "${heard.transcript}"`);

    // The detection assertion — the whole reason this path exists over Deepgram.
    if (heard.detected === lang) {
      ok(`${script.label}: detected correctly as ${heard.detected} (confidence ${heard.confidence.toFixed(2)})`);
    } else if (heard.detected) {
      fail(`${script.label}: DETECTED AS ${heard.detected.toUpperCase()} — a call would open in the wrong language`);
    } else {
      fail(`${script.label}: no language reported — language_code=auto is not returning a detection`);
    }

    const hit = script.expect.filter((w) => heard.transcript.includes(w));
    if (hit.length === script.expect.length) {
      ok(`${script.label}: every load-bearing word survived (${script.expect.join(", ")})`);
    } else {
      const missed = script.expect.filter((w) => !heard.transcript.includes(w));
      // Not a hard failure: the caller here is a synthetic voice reading a
      // written sentence, which is not what a person on a phone sounds like.
      warn(`${script.label}: missed ${missed.join(", ")} — re-check with a real speaker before reading anything into it`);
    }
    if (!heard.sawPartial) {
      warn(`${script.label}: no partial transcripts arrived — barge-in depends on these, so check stream_type`);
    }
  } catch (e) {
    fail(`${script.label}: ${e.message}`);
  }
}

// ── 5. Leave something to listen to ─────────────────────────────────────────
step("Something to listen to");
{
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "voice-samples");
  try {
    fs.mkdirSync(dir, { recursive: true });
    let written = 0;
    for (const [lang, pcm] of Object.entries(spoken)) {
      // Minimal 44-byte RIFF header so the file opens in anything.
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + pcm.length, 4);
      header.write("WAVE", 8);
      header.write("fmt ", 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(PIPELINE_RATE, 24);
      header.writeUInt32LE(PIPELINE_RATE * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(pcm.length, 40);
      fs.writeFileSync(path.join(dir, `sarvam-${lang}.wav`), Buffer.concat([header, pcm]));
      written++;
    }
    if (written) {
      ok(`wrote ${written} sample${written === 1 ? "" : "s"} to data/voice-samples/`);
      warn("LISTEN TO THESE before a caller does. The speaker was picked from a name, which is exactly how this repo picked wrong twice.");
    }
  } catch (e) {
    warn(`could not write samples: ${e.message}`);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
step("Verdict");
if (failures === 0) {
  ok("the Sarvam path hears, speaks, and identifies the language it is hearing");
  console.log("\nStill unproven by this check, and only a person can prove it:");
  console.log("  · whether the voice is any good, or the right register for someone anxious about a loan");
  console.log("  · whether the pace is right — bulbul has a real speed control, unlike sonic-2");
  console.log("  · whether detection holds up on a code-mixed caller, which is most real callers\n");
} else {
  bad(`${failures} check${failures === 1 ? "" : "s"} failed — see above`);
  console.log();
}
process.exit(failures === 0 ? 0 : 1);
