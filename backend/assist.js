// Document Q&A assistant — answers applicant questions about the document they're
// currently uploading ("why do you need this?", "why was mine rejected?", "what
// format works?"). Grounded in the document definition + the applicant's own
// validation results, so answers are specific, not generic.
//
// Provider chain mirrors intake.js/capture.js: Claude first, OpenRouter fallback.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_ASSIST_MODEL || "claude-opus-4-8";
import { openaiSide } from "./llmProviders.js";

// The OpenAI-compatible side of the chain: OpenRouter, or OpenAI's own API
// when only OPENAI_API_KEY is set. Resolved once in llmProviders.js.
const OA = openaiSide();
const OR_KEY = OA?.key || null;
const OR_MODEL = process.env.OPENROUTER_ASSIST_MODEL || "openai/gpt-4o-mini";

export function assistConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

function systemPrompt(doc, failedChecks, intakeSummary) {
  return (
    `You are UPSY's friendly loan-document helper, answering an applicant's question while they upload documents for an Indian education loan.\n\n` +
    `Current document: ${doc.label}\n` +
    `Why it's required: ${doc.why || "-"}\n` +
    `Accepted formats: ${(doc.accept || []).join(", ")} · Max size: ${doc.maxSizeMB} MB\n` +
    (doc.identifier ? `It also carries an identifier we verify: ${doc.identifier.name} (example format: ${doc.identifier.example}).\n` : "") +
    (failedChecks && failedChecks.length
      ? `Their last upload FAILED these checks:\n${failedChecks.map((c) => `- ${c.name}: ${c.detail}`).join("\n")}\n`
      : "") +
    (intakeSummary ? `Their loan request: ${intakeSummary}\n` : "") +
    `\nRules: Answer in 2-4 short, plain-language sentences. Be specific to THIS document and their situation. ` +
    `If their upload failed, explain exactly what to fix in practical terms (e.g. "retake the photo with all four corners visible"). ` +
    `No financial advice, no eligibility or approval promises, no interest-rate claims. ` +
    `If asked something unrelated to the loan process, politely steer back.`
  );
}

async function callClaude(system, question) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 350, system, messages: [{ role: "user", content: question }] }),
  });
  if (!res.ok) {
    console.error(`[assist:claude] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  return block?.text?.trim() || null;
}

async function callOpenRouter(system, question) {
  const res = await fetch(OA.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OA.model(OR_MODEL),
      temperature: 0.3,
      max_tokens: 350,
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) {
    console.error(`[assist:openrouter] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// Answer a question about the given document. Returns { answer, source } or null.
export async function answerDocQuestion({ doc, question, failedChecks, intakeSummary }) {
  const system = systemPrompt(doc, failedChecks, intakeSummary);
  if (ANTHROPIC_KEY) {
    try {
      const answer = await callClaude(system, question);
      if (answer) return { answer, source: "claude" };
    } catch (e) {
      console.error("[assist:claude] request failed:", e.message);
    }
  }
  if (OR_KEY) {
    try {
      const answer = await callOpenRouter(system, question);
      if (answer) return { answer, source: "openrouter" };
    } catch (e) {
      console.error("[assist:openrouter] request failed:", e.message);
    }
  }
  return null;
}
