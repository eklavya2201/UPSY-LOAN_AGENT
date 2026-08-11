// Smart intake box — turns a free-text loan request into a structured loan intent.
// This is the "AI Autocomplete" concept built with our own LLM: the applicant types
// one sentence ("I need 8 lakh for an MS in the US this August, dad is co-applicant")
// and we structure it into fields the agent can act on, plus follow-up questions for
// whatever's missing.
//
// Provider chain mirrors capture.js: Claude first, OpenRouter fallback — so it runs
// today on the OpenRouter key and upgrades to Claude the moment ANTHROPIC_API_KEY is set.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Structuring is a light task; default to Opus for quality, override for speed/cost
// (ANTHROPIC_INTAKE_MODEL=claude-haiku-4-5 is a good fast/cheap choice here).
const ANTHROPIC_MODEL = process.env.ANTHROPIC_INTAKE_MODEL || "claude-opus-4-8";
import { openaiSide } from "./llmProviders.js";

// The OpenAI-compatible side of the chain: OpenRouter, or OpenAI's own API
// when only OPENAI_API_KEY is set. Resolved once in llmProviders.js.
const OA = openaiSide();
const OR_KEY = OA?.key || null;
const OR_MODEL = process.env.OPENROUTER_INTAKE_MODEL || "openai/gpt-4o-mini";

export function intakeConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

const INSTRUCTIONS =
  `You structure a prospective borrower's free-text message into JSON for an Indian education-loan assistant. ` +
  `Extract ONLY what the user actually stated — use null for anything not mentioned, never invent or assume. ` +
  `Do not give financial advice or make eligibility/approval promises.\n\n` +
  `Return ONLY this JSON object (no markdown, no commentary):\n` +
  `{\n` +
  `  "summary": "<one plain-language sentence confirming what they're asking for>",\n` +
  `  "intent": {\n` +
  `    "amountInr": <number in rupees, e.g. 800000 for 8 lakh, or null>,\n` +
  `    "purpose": <"education" or other short purpose, or null>,\n` +
  `    "studyLevel": <"Bachelors" | "Masters" | "MBA" | "PhD" | "Diploma" | null>,\n` +
  `    "fieldOfStudy": <string or null>,\n` +
  `    "institution": <college/university name, or null>,\n` +
  `    "country": <study destination country, or null>,\n` +
  `    "intake": <e.g. "Aug 2026", or null>,\n` +
  `    "coApplicant": <relationship e.g. "father" | "mother" | "spouse", or null>,\n` +
  `    "collateral": <"secured" | "unsecured" | null>,\n` +
  `    "tenureYears": <number or null>\n` +
  `  },\n` +
  `  "followUps": [ <short, friendly question for each IMPORTANT missing field: amount, country, institution, intake, co-applicant, collateral> ]\n` +
  `}`;

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function callClaude(userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) {
    console.error(`[intake:claude] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  return parseJson(block?.text || "");
}

async function callOpenRouter(userText) {
  const res = await fetch(OA.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OA.model(OR_MODEL),
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok) {
    console.error(`[intake:openrouter] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "");
}

// Normalise so the client always gets a predictable shape.
function shape(parsed, source) {
  const intent = parsed?.intent || {};
  return {
    summary: typeof parsed?.summary === "string" ? parsed.summary : null,
    intent: {
      amountInr: Number.isFinite(intent.amountInr) ? intent.amountInr : null,
      purpose: intent.purpose ?? null,
      studyLevel: intent.studyLevel ?? null,
      fieldOfStudy: intent.fieldOfStudy ?? null,
      institution: intent.institution ?? null,
      country: intent.country ?? null,
      intake: intent.intake ?? null,
      coApplicant: intent.coApplicant ?? null,
      collateral: intent.collateral ?? null,
      tenureYears: Number.isFinite(intent.tenureYears) ? intent.tenureYears : null,
    },
    followUps: Array.isArray(parsed?.followUps) ? parsed.followUps.filter((q) => typeof q === "string") : [],
    source,
  };
}

// Turn free text into a structured loan intent. Claude first, OpenRouter fallback.
export async function structureIntent(text) {
  if (ANTHROPIC_KEY) {
    try {
      const parsed = await callClaude(text);
      if (parsed) return shape(parsed, "claude");
    } catch (e) {
      console.error("[intake:claude] request failed:", e.message);
    }
  }
  if (OR_KEY) {
    try {
      const parsed = await callOpenRouter(text);
      if (parsed) return shape(parsed, "openrouter");
    } catch (e) {
      console.error("[intake:openrouter] request failed:", e.message);
    }
  }
  return null; // no provider configured or both failed
}
