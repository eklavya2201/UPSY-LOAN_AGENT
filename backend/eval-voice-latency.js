// Where does the silence on a voice call actually come from?
//
// `npm run eval:voice` — measures TIME TO FIRST SENTENCE, not total generation
// time, because that is the only number a caller feels: the relay speaks each
// sentence as it lands, so the whole reply's length is irrelevant to how long
// they sit in silence wondering whether the line is dead.
//
// Run this before changing a model, not after. Voice is latency-bound in a way
// document reading is not, so the ranking here has nothing to do with which
// model reads a PAN card best.

import "dotenv/config";
import { takeCompleteSentences } from "./sentences.js";
import { buildVoiceSystemPrompt } from "./voicePrompt.js";

const QUESTIONS = [
  "I need about fifteen lakh rupees for an MBA. Am I eligible?",
  "My father is the co-applicant and he earns ninety thousand a month. How much can I get?",
  "What documents do I need to give you?",
];

const SYSTEM = buildVoiceSystemPrompt(null);

// Every candidate speaks the OpenAI chat-completions dialect, so one streamer
// covers all of them and the comparison stays honest.
async function timeToFirstSentence({ url, key, model, extraHeaders = {} }) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 250,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);

  let buffer = "";
  let firstToken = null;
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of res.body) {
    partial += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, nl).trim();
      partial = partial.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        continue;
      }
      const delta = msg.choices?.[0]?.delta?.content;
      if (!delta) continue;
      if (firstToken === null) firstToken = Date.now() - t0;
      buffer += delta;
      const { sentences } = takeCompleteSentences(buffer);
      if (sentences.length) {
        return { firstToken, firstSentence: Date.now() - t0, text: sentences[0] };
      }
    }
  }
  // Never produced a sentence boundary — the whole reply is one utterance.
  return { firstToken, firstSentence: Date.now() - t0, text: buffer.trim().slice(0, 80) };
}

// Anthropic speaks its own dialect, so it needs its own reader. Worth the extra
// function: this harness is described as ranking whatever is configured, and
// until now it could not rank the one provider voiceBrain.js actually prefers —
// which made "Claude is faster" a claim nobody here had ever measured.
async function timeToFirstSentenceAnthropic({ key, model }) {
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 250,
      stream: true,
      temperature: 0.3,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);

  let buffer = "";
  let firstToken = null;
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of res.body) {
    partial += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, nl).trim();
      partial = partial.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let msg;
      try {
        msg = JSON.parse(line.slice(5).trim());
      } catch (e) {
        continue;
      }
      if (msg.type !== "content_block_delta" || msg.delta?.type !== "text_delta") continue;
      if (firstToken === null) firstToken = Date.now() - t0;
      buffer += msg.delta.text;
      const { sentences } = takeCompleteSentences(buffer);
      if (sentences.length) return { firstToken, firstSentence: Date.now() - t0, text: sentences[0] };
    }
  }
  return { firstToken, firstSentence: Date.now() - t0, text: buffer.trim().slice(0, 80) };
}

const CANDIDATES = [
  process.env.ANTHROPIC_API_KEY && {
    label: `Claude ${process.env.ANTHROPIC_VOICE_MODEL || "claude-haiku-4-5"}`,
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_VOICE_MODEL || "claude-haiku-4-5",
    anthropic: true,
  },
  process.env.GROQ_API_KEY && {
    label: "Groq llama-3.1-8b-instant",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: "llama-3.1-8b-instant",
  },
  process.env.GROQ_API_KEY && {
    label: "Groq llama-3.3-70b-versatile",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: "llama-3.3-70b-versatile",
  },
  process.env.OPENROUTER_API_KEY && {
    label: "OpenRouter gpt-4o-mini (current)",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY,
    model: "openai/gpt-4o-mini",
  },
  process.env.OPENAI_API_KEY && {
    label: "OpenAI gpt-4o-mini (direct)",
    url: "https://api.openai.com/v1/chat/completions",
    key: process.env.OPENAI_API_KEY,
    model: "gpt-4o-mini",
  },
].filter(Boolean);

const RUNS = Number(process.argv[2] || 3);
console.log(`Time to first SPOKEN SENTENCE — ${RUNS} runs each, ~${Math.round(SYSTEM.length / 4)}-token system prompt\n`);

for (const c of CANDIDATES) {
  const samples = [];
  let sample = "";
  let failed = null;
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = c.anthropic ? await timeToFirstSentenceAnthropic(c) : await timeToFirstSentence(c);
      samples.push(r.firstSentence);
      sample = r.text;
    } catch (e) {
      failed = e.message;
      break;
    }
  }
  if (failed) {
    console.log(`${c.label.padEnd(34)} FAILED — ${failed}`);
    continue;
  }
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const best = Math.min(...samples);
  const worst = Math.max(...samples);
  const verdict = avg < 700 ? "excellent" : avg < 1200 ? "good" : avg < 2000 ? "noticeable pause" : "TOO SLOW for voice";
  console.log(`${c.label.padEnd(34)} avg ${String(avg).padStart(5)}ms  (best ${best}, worst ${worst})  ${verdict}`);
  console.log(`${" ".repeat(34)} → "${sample}"`);
}

console.log(
  "\nBudget: endpointing (~800ms) + this + TTS first chunk (~360ms) is what the caller\n" +
    "sits through. Anything over ~1.2s here and the call feels broken."
);
