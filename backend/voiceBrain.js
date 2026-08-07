// The thinking half of the UPSY voice relay.
//
// Claude first, OpenRouter as fallback — the same provider chain as assist.js,
// intake.js and capture.js, so there is one pattern in this repo rather than
// four. What is different here is that the reply is *streamed and split into
// sentences as it arrives*, because the sentence is the unit of speech: waiting
// for a whole reply before synthesising any of it adds a second or more of dead
// air to every single turn, which is the difference between a call that feels
// alive and one that feels like a form.
//
// The prompt itself is not defined here. buildVoiceSystemPrompt() in
// voicePrompt.js is used unchanged, so the browser agent, the Meet agent and
// this relay all quote the same eligibility rules.

import { takeCompleteSentences } from "./sentences.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Haiku on purpose: this is a latency-bound conversational turn, not document
// reading. It is also ~5x cheaper than the Opus this repo uses for vision, and
// on a per-minute voice budget the model is the line item that scales with talk
// time. Override if a call needs more reasoning than it needs speed.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VOICE_MODEL || "claude-haiku-4-5";

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL =
  process.env.OPENROUTER_VOICE_MODEL || process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";

// Two or three spoken sentences. The prompt already says to say less than it
// wants to; this is the hard stop for when it doesn't listen. A voice reply that
// runs long is not just costly, it is un-interruptible dead air.
const MAX_TOKENS = 250;

// Turns of context. Voice calls are short and the system prompt carries the
// facts, so a long window buys little and costs on every turn.
export const MAX_HISTORY = 12;

export function brainConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

export function brainConfigError() {
  if (brainConfigured()) return null;
  return "Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set, so the relay has nothing to think with.";
}

export function brainStatusLine() {
  const chain = [];
  if (ANTHROPIC_KEY) chain.push(`Claude (${ANTHROPIC_MODEL})`);
  if (OR_KEY) chain.push(`OpenRouter (${OR_MODEL})`);
  return chain.length ? chain.join(" → ") : "not configured";
}

// Read an SSE body line by line. Shared by both providers because they both
// speak text/event-stream, just with different payload shapes inside `data:`.
async function* sseLines(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

async function* streamClaude(systemPrompt, history, signal) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      // cache_control is set even though it will not bite at today's prompt
      // size — see the caching note in the README. It costs nothing, and it
      // starts working the moment the prompt grows past the model's minimum
      // cacheable prefix or the model changes. usage is logged below so the
      // question "is it actually caching?" is answered by evidence, not hope.
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: history,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  for await (const data of sseLines(res)) {
    if (data === "[DONE]") break;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      continue;
    }
    if (msg.type === "content_block_delta" && msg.delta?.type === "text_delta") {
      yield msg.delta.text;
    } else if (msg.type === "message_start" && msg.message?.usage) {
      const u = msg.message.usage;
      // Deliberately visible: if cache_read_input_tokens is always 0, the
      // per-minute cost estimate in the README is wrong and someone should know.
      console.log(
        `[voice:brain] claude usage in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`
      );
    } else if (msg.type === "error") {
      throw new Error(`Claude stream error: ${msg.error?.message || "unknown"}`);
    }
  }
}

async function* streamOpenRouter(systemPrompt, history, signal) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: OR_MODEL,
      stream: true,
      max_tokens: MAX_TOKENS,
      // Low temperature for the same reason liveAssist.js uses it: quoting an
      // eligibility rule should be near-deterministic, not creative.
      temperature: 0.3,
      messages: [{ role: "system", content: systemPrompt }, ...history],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  for await (const data of sseLines(res)) {
    if (data === "[DONE]") break;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      continue;
    }
    const delta = msg.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/**
 * Generate one spoken turn, delivering it a sentence at a time.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - from buildVoiceSystemPrompt(), unchanged.
 * @param {Array<{role:string, content:string}>} opts.history
 * @param {AbortSignal} opts.signal - aborted when the caller talks over the reply.
 * @param {(sentence: string) => Promise<void>} opts.onSentence - awaited, so the
 *   relay can apply backpressure while a sentence is still being spoken.
 * @returns {Promise<string>} everything that was actually said.
 */
export async function speakReply({ systemPrompt, history, signal, onSentence }) {
  const err = brainConfigError();
  if (err) throw new Error(err);

  const source = ANTHROPIC_KEY
    ? streamClaude(systemPrompt, history, signal)
    : streamOpenRouter(systemPrompt, history, signal);

  let buffer = "";
  let spoken = "";
  let lastSentence = null;

  const emit = async (sentences) => {
    for (const sentence of sentences) {
      if (signal?.aborted) return;
      // The repeat guard liveAssist.js learned the hard way: small models
      // occasionally emit the same sentence twice in a row, and hearing it
      // spoken back-to-back is far more jarring than reading it twice.
      if (sentence === lastSentence) continue;
      lastSentence = sentence;
      spoken += (spoken ? " " : "") + sentence;
      await onSentence(sentence);
    }
  };

  try {
    for await (const delta of source) {
      if (signal?.aborted) break;
      buffer += delta;
      const { sentences, rest } = takeCompleteSentences(buffer);
      buffer = rest;
      await emit(sentences);
    }
    if (!signal?.aborted) {
      const { sentences } = takeCompleteSentences(buffer, { flush: true });
      await emit(sentences);
    }
  } catch (e) {
    // An abort is us superseding ourselves because the caller spoke again — a
    // normal event on a phone call, not a failure. Stay quiet about it.
    if (e.name === "AbortError" || signal?.aborted) return spoken;

    // Claude fell over mid-call and OpenRouter is available: rather than leave
    // the caller in silence, finish the turn on the fallback. Only worth doing
    // if nothing has been spoken yet — half a reply in one voice followed by a
    // different answer is worse than a clean retry.
    if (ANTHROPIC_KEY && OR_KEY && !spoken) {
      console.error(`[voice:brain] claude failed, falling back to OpenRouter: ${e.message}`);
      buffer = "";
      for await (const delta of streamOpenRouter(systemPrompt, history, signal)) {
        if (signal?.aborted) break;
        buffer += delta;
        const { sentences, rest } = takeCompleteSentences(buffer);
        buffer = rest;
        await emit(sentences);
      }
      if (!signal?.aborted) {
        const { sentences } = takeCompleteSentences(buffer, { flush: true });
        await emit(sentences);
      }
      return spoken;
    }
    throw e;
  }

  return spoken;
}
