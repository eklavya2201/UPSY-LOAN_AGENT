// Vision-based document capture. Sends a card image to a vision model and reads
// the number, name and DOB straight off it — including understanding *which*
// name is the cardholder's (not the father's name or the "Government of India"
// header).
//
// Read path priority:
//   1. Claude directly (Anthropic API) — best at reading ID numbers; set ANTHROPIC_API_KEY.
//   2. OpenRouter vision model — if ANTHROPIC_API_KEY is unset but OPENROUTER_API_KEY is.
//   3. Local tesseract OCR — always-available fallback, so the app never hard-breaks.

import { extractText, readIdentifier, extractName, extractDob } from "./ocr.js";
import { aadhaarChecksumValid } from "./validators.js";

// --- Claude (Anthropic API) ---
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Default to the most capable Opus model for best ID-number accuracy. Override
// with ANTHROPIC_VISION_MODEL=claude-sonnet-5 (cheaper) or claude-haiku-4-5 (cheapest).
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8";

// --- OpenRouter (fallback vision provider) ---
const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";

export function claudeConfigured() {
  return Boolean(ANTHROPIC_KEY);
}

export function visionConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

// True image mime from magic bytes (more reliable than the client's claim).
function imageMime(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  return null;
}

// PDF detection from magic bytes ("%PDF"). Claude reads PDFs natively (incl. scans).
function isPdf(buffer) {
  return Boolean(
    buffer && buffer.length >= 4 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46
  );
}

// POST to Anthropic with a short retry on transient 429 (rate limit) / 529 (overloaded),
// so a momentary blip doesn't needlessly drop us to OCR. Honours the Retry-After header.
async function anthropicPost(body, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1000;
      console.warn(`[vision:claude] HTTP ${res.status} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
}

function docKind(doc) {
  const n = doc.identifier?.name || "";
  if (/pan/i.test(n)) return "pan";
  if (/aadhaar/i.test(n)) return "aadhaar";
  return "other";
}

// Normalise + validate what the model returned, so we only trust a well-formed value.
// For Aadhaar we also enforce the real UIDAI Verhoeff checksum — a misread number
// (e.g. one wrong digit) fails the checksum, so we return null instead of showing a
// confident-but-wrong number, and the UI falls back to "please type it".
function cleanNumber(kind, raw) {
  if (!raw) return null;
  if (kind === "pan") {
    const v = String(raw).toUpperCase().replace(/\s/g, "");
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v) ? v : null;
  }
  if (kind === "aadhaar") {
    const v = String(raw).replace(/\D/g, "");
    return /^[2-9][0-9]{11}$/.test(v) && aadhaarChecksumValid(v) ? v : null;
  }
  return String(raw).trim() || null;
}

function promptFor(kind) {
  const numberRule =
    kind === "pan"
      ? 'the PAN number, exactly as printed (format: 5 letters, 4 digits, 1 letter, e.g. ABCDE1234F)'
      : kind === "aadhaar"
      ? 'the 12-digit Aadhaar number, digits only, no spaces'
      : "the main ID number on the document";
  return (
    `This image is an Indian ${kind === "pan" ? "PAN card" : kind === "aadhaar" ? "Aadhaar card" : "identity document"}. ` +
    `Read it and return ONLY a JSON object (no markdown, no commentary) with exactly these keys:\n` +
    `- "number": ${numberRule}. Read each character carefully, digit by digit — this is the most important field and must be exact. Use null if you cannot read it clearly.\n` +
    `- "name": the CARDHOLDER's full name exactly as printed. This is the person the card belongs to — NOT the father's/guardian's name, and NOT headers like "Government of India" or "Income Tax Department". Use null if unclear.\n` +
    `- "dob": the date of birth in DD/MM/YYYY format if shown, else null.\n` +
    (kind === "aadhaar" ? `- "address": the full address printed on the card, as one string, else null.\n` : "") +
    `Respond with the JSON object only.`
  );
}

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

// Normalise a raw {number, name, dob, address} object from any vision model.
// (address is only requested for Aadhaar — see promptFor — so it's null elsewhere.)
function shape(kind, parsed) {
  if (!parsed) return null;
  const number = cleanNumber(kind, parsed.number);
  const name = parsed.name && String(parsed.name).trim() ? String(parsed.name).trim() : null;
  const dob = parsed.dob && /\d{2}[\/\-.]\d{2}[\/\-.]\d{4}/.test(parsed.dob) ? String(parsed.dob).replace(/[-.]/g, "/") : null;
  const address = parsed.address && String(parsed.address).trim() ? String(parsed.address).trim() : null;
  return { number, name, dob, address };
}

// --- Claude (Anthropic Messages API) ---
// Reads the card via Claude's vision. Handles both images and PDFs (incl. scans).
// Returns { number, name, dob } or null.
export async function captureCardClaude(buffer, doc) {
  const mime = imageMime(buffer);
  const pdf = !mime && isPdf(buffer);
  if (!mime && !pdf) return null; // unknown type — nothing to send
  const kind = docKind(doc);
  // Image → image block; PDF → document block. Media block goes before the text prompt.
  const mediaBlock = pdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }
    : { type: "image", source: { type: "base64", media_type: mime, data: buffer.toString("base64") } };
  try {
    const res = await anthropicPost({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [mediaBlock, { type: "text", text: promptFor(kind) }],
        },
      ],
    });
    if (!res.ok) {
      console.error(`[vision:claude] ${ANTHROPIC_MODEL} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    // Anthropic returns content as an array of blocks; grab the first text block.
    const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
    return shape(kind, parseJson(textBlock?.text || ""));
  } catch (e) {
    console.error("[vision:claude] request failed:", e.message);
    return null;
  }
}

// --- OpenRouter (fallback vision provider) ---
// Ask the OpenRouter vision model to read the card. Returns { number, name, dob } or null.
export async function captureCardVision(buffer, doc) {
  const mime = imageMime(buffer);
  if (!mime) return null; // PDFs / unknown — vision path is for images
  const kind = docKind(doc);
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OR_MODEL,
        temperature: 0,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptFor(kind) },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[vision:openrouter] ${OR_MODEL} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return shape(kind, parseJson(content));
  } catch (e) {
    console.error("[vision:openrouter] request failed:", e.message);
    return null;
  }
}

// Unified read: Claude first, then OpenRouter, then OCR fallback.
// Returns { number, name, dob, address, source, exact }. address is only ever
// populated for Aadhaar (PAN cards don't print one) and only via an AI reader.
export async function readCard(buffer, doc) {
  const isImage = imageMime(buffer);
  const pdf = !isImage && isPdf(buffer);

  // 1. Claude directly (best at reading ID numbers; handles images AND PDFs)
  if (claudeConfigured() && (isImage || pdf)) {
    const v = await captureCardClaude(buffer, doc);
    if (v && (v.number || v.name || v.dob)) {
      return { number: v.number, name: v.name, dob: v.dob, address: v.address || null, source: "claude", exact: Boolean(v.number) };
    }
    console.log("[vision:claude] no result — trying next reader");
  }

  // 2. OpenRouter vision model
  if (OR_KEY && isImage) {
    const v = await captureCardVision(buffer, doc);
    if (v && (v.number || v.name || v.dob)) {
      return { number: v.number, name: v.name, dob: v.dob, address: v.address || null, source: "vision", exact: Boolean(v.number) };
    }
    console.log("[vision:openrouter] no result — falling back to OCR");
  }

  // 3. Local OCR fallback (address not extracted here — OCR-only text parsing
  // doesn't reliably segment a free-text address block from the rest of the card)
  const text = await extractText(buffer);
  const r = readIdentifier(text, doc);
  return { number: r?.value || null, name: extractName(text), dob: extractDob(text), address: null, source: "ocr", exact: r?.exact || false };
}
