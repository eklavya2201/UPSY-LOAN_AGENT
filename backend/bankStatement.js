// Reads the co-applicant's identity details off their bank statement
// (co_bank_statement — PDF only, per documents.js): account holder name,
// address, and the registered mobile number on the account. Requested by the
// team (2026-07-29): use the bank statement to fetch/verify the co-applicant's
// phone number, and to cross-check name/address against their other documents.
//
// Provider chain mirrors income.js: Claude (images + PDFs) → OpenRouter
// (PDFs via OpenRouter's file-parser) → null (never blocks the upload —
// the statement still verifies as a document even if we can't read these
// fields off it).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8";
import { openaiSide } from "./llmProviders.js";

// The OpenAI-compatible side of the chain: OpenRouter, or OpenAI's own API
// when only OPENAI_API_KEY is set. Resolved once in llmProviders.js.
const OA = openaiSide();
const OR_KEY = OA?.key || null;
const OR_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";

function imageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  return null;
}
function isPdf(buffer) {
  return Boolean(buffer && buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46);
}

const PROMPT =
  `This document is an Indian bank account statement. Read it and return ONLY a JSON object (no markdown, no commentary) with exactly these keys:\n` +
  `- "accountHolderName": the account holder's name as printed, else null\n` +
  `- "address": the account holder's address printed on the statement, as one string, else null\n` +
  `- "phoneNumber": the registered mobile number on the account, as a plain 10-digit Indian number (digits only, no country code/spaces), else null\n` +
  `Never guess a value — use null if a field isn't clearly shown.`;

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function shape(parsed, source) {
  if (!parsed) return null;
  const name = parsed.accountHolderName && String(parsed.accountHolderName).trim() ? String(parsed.accountHolderName).trim() : null;
  const address = parsed.address && String(parsed.address).trim() ? String(parsed.address).trim() : null;
  const digits = parsed.phoneNumber ? String(parsed.phoneNumber).replace(/\D/g, "").slice(-10) : "";
  // Indian mobile numbers: 10 digits, starting 6-9. A malformed read is dropped
  // rather than trusted — same "validate the shape, don't just trust the label"
  // approach as the income-figure guard.
  const phoneNumber = /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
  if (!name && !address && !phoneNumber) return null;
  return { accountHolderName: name, address, phoneNumber, source };
}

async function callClaude(buffer) {
  const mime = imageMime(buffer);
  const pdf = !mime && isPdf(buffer);
  if (!mime && !pdf) return null;
  const mediaBlock = pdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }
    : { type: "image", source: { type: "base64", media_type: mime, data: buffer.toString("base64") } };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, messages: [{ role: "user", content: [mediaBlock, { type: "text", text: PROMPT }] }] }),
  });
  if (!res.ok) {
    console.error(`[bankstatement:claude] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  return parseJson(block?.text || "");
}

async function callOpenRouter(buffer) {
  const mime = imageMime(buffer);
  const pdf = !mime && isPdf(buffer);
  if (!mime && !pdf) return null;
  const part = pdf
    ? { type: "file", file: { filename: "statement.pdf", file_data: `data:application/pdf;base64,${buffer.toString("base64")}` } }
    : { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}` } };
  const res = await fetch(OA.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OA.model(OR_MODEL),
      temperature: 0,
      max_tokens: 300,
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, part] }],
    }),
  });
  if (!res.ok) {
    console.error(`[bankstatement:openrouter] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "");
}

// Read identity details off the bank statement. Returns the shaped record or
// null (never throws — a failed read just means these fields stay unverified).
export async function extractBankStatement(buffer) {
  if (ANTHROPIC_KEY) {
    try {
      const r = shape(await callClaude(buffer), "claude");
      if (r) return r;
    } catch (e) { console.error("[bankstatement:claude] request failed:", e.message); }
  }
  if (OR_KEY) {
    try {
      const r = shape(await callOpenRouter(buffer), "openrouter");
      if (r) return r;
    } catch (e) { console.error("[bankstatement:openrouter] request failed:", e.message); }
  }
  return null;
}
