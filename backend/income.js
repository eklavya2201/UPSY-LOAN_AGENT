// Income extraction from the co-applicant's income proof (ITR or salary slips).
// Rule from the product spec: an ITR shows ANNUAL income → monthly = annual ÷ 12;
// a salary slip shows MONTHLY income directly. The verified figure feeds the
// eligibility engine (loan estimate ≈ 24 × monthly income) instead of whatever
// the lead source claimed.
//
// Provider chain mirrors capture.js: Claude (images + PDFs) → OpenRouter
// (images natively; PDFs via OpenRouter's file-parser) → null (income simply
// stays unverified — never blocks the upload).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8";
const OR_KEY = process.env.OPENROUTER_API_KEY;
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
  `This document is an Indian income proof — either an ITR (Income Tax Return: ITR-V acknowledgement, computation of income, Form 16 Part A, or Form 16 Part B) or a salary slip. ` +
  `Form 16 Part B specifically lists ANNUAL gross salary/income for a tax year — classify it as "itr" and use annualIncomeInr, never "salary_slip". ` +
  `Only classify as "salary_slip" if the document is a single month's pay slip showing that month's earnings directly. ` +
  `Read it and return ONLY a JSON object (no markdown, no commentary) with exactly these keys:\n` +
  `- "docType": "itr" | "salary_slip" | "other"\n` +
  `- "annualIncomeInr": for an ITR/Form 16 — the gross total income (or total income) figure in rupees as a plain number (e.g. 1140000), else null\n` +
  `- "monthlyIncomeInr": for a salary slip — the gross monthly earnings in rupees as a plain number, else null\n` +
  `- "holderName": the employee/assessee name on the document, else null\n` +
  `- "address": the employee/assessee's address printed on the document, as one string, else null\n` +
  `- "period": the assessment year / salary month shown (e.g. "AY 2025-26" or "May 2026"), else null\n` +
  `Read the figures digit by digit — they must be exact. Never guess a number; use null if unclear.`;

function parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Sanity-bound and derive the monthly figure per the ÷12 rule.
function shape(parsed, source) {
  if (!parsed) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const docType = ["itr", "salary_slip"].includes(parsed.docType) ? parsed.docType : null;
  const annual = num(parsed.annualIncomeInr);
  const slipMonthly = num(parsed.monthlyIncomeInr);
  let monthly = null, basis = null;
  if (docType === "itr" && annual) {
    monthly = Math.round(annual / 12);
    basis = `ITR annual income ₹${annual.toLocaleString("en-IN")} ÷ 12`;
  } else if (docType === "salary_slip" && slipMonthly) {
    monthly = Math.round(slipMonthly);
    basis = `gross monthly earnings on salary slip`;
  }
  // Plausibility band: ₹5k–₹1Cr a month; outside that we treat it as a misread.
  if (!monthly || monthly < 5000 || monthly > 10000000) return null;
  // A "salary_slip" claiming a monthly figure above a realistic ceiling is almost
  // certainly an ITR/Form-16 annual figure the model mislabeled as monthly (e.g. Form
  // 16 Part B misread as a salary slip) — that would otherwise silently 24x eligibility
  // math into the tens of crores off a single mislabel, with no checksum to catch it.
  if (docType === "salary_slip" && monthly > 500000) return null;
  return {
    docType,
    annualIncomeInr: annual,
    monthlyIncomeInr: monthly,
    basis,
    holderName: parsed.holderName ? String(parsed.holderName).trim() : null,
    address: parsed.address ? String(parsed.address).trim() : null,
    period: parsed.period ? String(parsed.period).trim() : null,
    source,
  };
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
    console.error(`[income:claude] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  // Images go as image_url; PDFs use OpenRouter's file part (their parser
  // extracts the text server-side — works for text-native PDFs like ITRs).
  const part = pdf
    ? { type: "file", file: { filename: "income.pdf", file_data: `data:application/pdf;base64,${buffer.toString("base64")}` } }
    : { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}` } };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OR_MODEL,
      temperature: 0,
      max_tokens: 300,
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, part] }],
    }),
  });
  if (!res.ok) {
    console.error(`[income:openrouter] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content || "");
}

// Read income off the document. Returns the shaped record or null (never throws).
export async function extractIncome(buffer) {
  if (ANTHROPIC_KEY) {
    try {
      const r = shape(await callClaude(buffer), "claude");
      if (r) return r;
    } catch (e) { console.error("[income:claude] request failed:", e.message); }
  }
  if (OR_KEY) {
    try {
      const r = shape(await callOpenRouter(buffer), "openrouter");
      if (r) return r;
    } catch (e) { console.error("[income:openrouter] request failed:", e.message); }
  }
  return null;
}
