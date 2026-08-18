// Does the course the caller named actually exist? — the online cross-check.
//
// The team's ask (2026-08-11, WhatsApp): "agar koi false info de toh hume pata
// ho — waisa course identify nahi hora online". callSchema.js has been waiting
// for this since the branch schema landed: `institute.feeVerifiedOnline` is an
// api-sourced field whose note says the flag stays dormant until a scraper is
// wired up, and the `fee_deviation` threat rule already fires on it. This
// module is the missing piece.
//
// ── How it decides ──────────────────────────────────────────────────────────
// Web search for "<institute> <course> fees", then the same LLM chain as every
// other reader in this repo judges STRICTLY from the result snippets:
//
//   found     — the institute exists and offers something like this course
//   unclear   — search came back thin or ambiguous. Raises NOTHING: a failed
//               search must never flag a real institute, same principle as the
//               flag rules ("every rule fires only on evidence").
//   not_found — the results actively fail to support the claim
//
// A published total fee, when one is clearly visible in a snippet, lands in
// `institute.feeVerifiedOnline` — at which point the existing fee_deviation
// rule compares it against what the caller said, for free.
//
// ── Where the verdict goes, and who is allowed to see it ────────────────────
// `profile._verification` + `institute.feeVerifiedOnline`, then flags are
// recomputed. The underscore is load-bearing three times over: excluded from
// the agent's prompt (voicePrompt.renderFacts skips underscore keys), skipped
// by the dashboard's generic fact rows (team.js does the same), surfaced ONLY
// through the flags card. The agent must never tell a caller their course
// "doesn't seem to exist" — a search miss is our evidence problem, not their
// honesty problem, and that verdict belongs on an officer's screen.
//
// ── Search providers ────────────────────────────────────────────────────────
// SERPER_API_KEY (google.serper.dev, 2,500 free queries) when set — reliable,
// structured. Otherwise DuckDuckGo's plain-HTML endpoint, which needs no key
// but is scraped markup: fine for testing, occasionally rate-limited from a
// cloud IP. Every failure path returns null and raises nothing.

const SERPER_KEY = process.env.SERPER_API_KEY;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_EXTRACT_MODEL || "claude-haiku-4-5";
import { openaiSide } from "./llmProviders.js";

// The OpenAI-compatible side of the chain: OpenRouter, or OpenAI's own API
// when only OPENAI_API_KEY is set. Resolved once in llmProviders.js.
const OA = openaiSide();
const OR_KEY = OA?.key || null;
const OR_MODEL =
  process.env.OPENROUTER_EXTRACT_MODEL || process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";

const SEARCH_TIMEOUT_MS = Number(process.env.VERIFY_SEARCH_TIMEOUT_MS || 8000);
const JUDGE_TIMEOUT_MS = Number(process.env.VERIFY_JUDGE_TIMEOUT_MS || 20000);

// One verdict per claim per process. A caller repeating their institute on
// every turn must not buy a search every extraction pass.
const cache = new Map();

export function verifierConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

export function verifierStatusLine() {
  const search = SERPER_KEY ? "Serper" : "DuckDuckGo (keyless)";
  const judge = ANTHROPIC_KEY ? `Claude (${ANTHROPIC_MODEL})` : OR_KEY ? `${OA.name} (${OR_MODEL})` : "not configured";
  return `${search} → ${judge}`;
}

export function claimKey({ name, course }) {
  return `${String(name || "").trim().toLowerCase()}|${String(course || "").trim().toLowerCase()}`;
}

// ── Search ──────────────────────────────────────────────────────────────────

async function searchSerper(query) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "in", num: 8 }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const json = await res.json();
  return (json.organic || []).slice(0, 6).map((r) => ({
    title: r.title || "",
    snippet: r.snippet || "",
    url: r.link || "",
  }));
}

// DuckDuckGo's no-JS endpoint. Scraped markup, so parsed defensively: if their
// HTML changes this returns [] and the verdict is "unclear", never a crash.
async function searchDuckDuckGo(query) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  const strip = (s) =>
    s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

  const results = [];
  const blocks = html.split(/class="result\b/).slice(1, 9);
  for (const block of blocks) {
    const title = /class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const href = /class="result__a"[^>]*href="([^"]+)"/.exec(block);
    if (!title) continue;
    results.push({
      title: strip(title[1]),
      snippet: snippet ? strip(snippet[1]) : "",
      url: href ? href[1] : "",
    });
  }
  return results.slice(0, 6);
}

async function searchWeb(query) {
  return SERPER_KEY ? searchSerper(query) : searchDuckDuckGo(query);
}

// ── The judge ───────────────────────────────────────────────────────────────

/**
 * Every rupee figure a snippet actually states, in rupees.
 *
 * Indian sources write the same number half a dozen ways — "₹24,42,000",
 * "24.42 Lakhs", "Rs 24.42L", "2442000" — so each is parsed rather than
 * string-matched. Both readings of a bare grouped number are kept (with and
 * without the commas) because "24,42,000" and "2,442,000" are the same amount
 * written for different audiences.
 */
function feesStatedIn(results) {
  const text = (results || []).map((r) => `${r.title || ""} ${r.snippet || ""}`).join(" ");
  const found = new Set();
  const re = /(?:₹|rs\.?|inr)?\s*([\d][\d,.]*)\s*(cr|crore|crores|lakhs?|lacs?|l|k|thousand)?/gi;
  for (const m of text.matchAll(re)) {
    const digits = m[1].replace(/,/g, "");
    const n = Number(digits);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = (m[2] || "").toLowerCase();
    if (/^(cr|crore|crores)$/.test(unit)) found.add(Math.round(n * 10000000));
    else if (/^(lakhs?|lacs?|l)$/.test(unit)) found.add(Math.round(n * 100000));
    else if (/^(k|thousand)$/.test(unit)) found.add(Math.round(n * 1000));
    else found.add(Math.round(n));
  }
  return found;
}

/**
 * Does a snippet actually state this figure?
 *
 * Tolerant by 1%, because a source may round ₹24,42,000 to "24.4 lakhs" and
 * refusing that would throw away a real published fee over a rounding step.
 * Wide enough to accept the same number written differently, far too narrow to
 * accept a different number.
 */
export function feeAppearsIn(value, results) {
  for (const stated of feesStatedIn(results)) {
    if (Math.abs(stated - value) <= Math.max(1, value * 0.01)) return true;
  }
  return false;
}

function judgePrompt({ name, course }, results) {
  // ⚠️ The caller's quoted fee is deliberately NOT shown to the judge.
  //
  // It used to be, as context. Observed on a real call: the caller quoted ₹30L
  // and the judge returned a "published" fee of exactly ₹30,00,000 — the same
  // number, handed back. An earlier call on the same institute had found
  // ₹24.42L, so this was not the institute's real published figure.
  //
  // That failure is silent and total: fee_deviation compares the two numbers,
  // so a judge that echoes the quote makes them agree every time and the check
  // can never fire. The judge's only job is to read snippets, and it cannot
  // parrot a number it was never told.
  const claim = [
    `Institute: "${name}"`,
    course ? `Course: "${course}"` : null,
  ].filter(Boolean).join("\n");

  const listing = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   (${r.url})`)
    .join("\n");

  return [
    `A caller on an education-loan enquiry named an institute and course. Below are web search results for that claim. Decide, STRICTLY from these snippets, whether the claim checks out. This feeds a loan officer's fraud flag, so the bar for "not_found" is that the results actively fail to support the claim — thin or ambiguous results are "unclear", which raises no flag.`,
    `The claim:\n${claim}`,
    `Search results:\n${listing || "(no results came back)"}`,
    `Rules:
- Judge ONLY from the snippets above. Do not use anything you know about institutes from training.
- THE CLAIM CAME THROUGH SPEECH RECOGNITION. The institute and course names are what a machine heard down a phone line, so spelling is evidence of nothing: "BTEC" is how a recogniser writes "B.Tech", "MSC" is "M.S.", and a name one or two syllables off is the same name. Match on what was plausibly SAID, never on how it was spelled.
- The verdict is about the INSTITUTE, and only the institute:
  - "found" — the institute clearly exists, and this course, a spelling/mishearing of it, or a closely related programme appears offered there.
  - "unclear" — the institute exists but these snippets do not show this course. That is the CEILING for a course-level mismatch: snippets are not a full course catalogue, and a missing listing is not evidence of a false claim.
  - "not_found" — reserved for the institute itself: it does not appear in the results, or the results actively contradict its existence.
- published_total_fee: ONLY if a snippet states a total programme fee in INR for this course, as plain digits (₹24,00,000 → 2400000). A per-semester, per-year or hostel figure does not count. When in doubt, null.

Return JSON only, no commentary:
{ "verdict": "found" | "unclear" | "not_found", "published_total_fee": <number or null>, "note": "<one sentence, for the officer>" }`,
  ].join("\n\n");
}

async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      temperature: 0,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const json = await res.json();
  return "{" + (json.content?.[0]?.text || "");
}

async function askOpenRouter(prompt) {
  const res = await fetch(OA.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    body: JSON.stringify({
      model: OA.model(OR_MODEL),
      max_tokens: 300,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

function parseJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e2) {
      return null;
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Check one institute/course claim against the open web.
 *
 * @param {object} claim - { name, course } from profile.institute.
 *   `searchResults` may be supplied to skip the live search — the testing seam,
 *   so the judge can be exercised without a search provider on the network.
 *
 *   ⚠️ The caller's quoted fee is NOT a parameter, and must not become one
 *   again. It was passed in as context and the judge handed it straight back as
 *   the "published" figure, which makes fee_deviation compare a number with
 *   itself and never fire. This function's whole job is to produce a figure
 *   INDEPENDENT of what the caller claimed; the comparison happens in
 *   deriveFlags(), in code, where it cannot be talked out of a verdict.
 * @returns {Promise<null | {
 *   status: "found"|"unclear"|"not_found",
 *   note: string,
 *   feeVerifiedOnline: number|null,
 *   sources: string[],
 *   checkedAt: string,
 * }>} null when there is nothing to check, nothing to judge with, or the
 *   search/judge failed — every failure is silence, never a flag.
 */
export async function verifyInstitute({ name, course, searchResults } = {}) {
  if (!name || !verifierConfigured()) return null;
  const key = claimKey({ name, course });
  if (cache.has(key)) return cache.get(key);

  const work = (async () => {
    try {
      const query = `${name} ${course || ""} total fees`.replace(/\s+/g, " ").trim();
      const results = searchResults || (await searchWeb(query));
      // Nothing came back at all: that is a search problem (rate limit, network),
      // not evidence about the institute. Do not cache it — a later pass on a
      // healthier network deserves a fresh try.
      if (!results.length) {
        cache.delete(key);
        return null;
      }

      const text = ANTHROPIC_KEY
        ? await askClaude(judgePrompt({ name, course }, results)).catch(async (e) => {
            if (!OR_KEY) throw e;
            console.error(`[verify] Claude failed, falling back to OpenRouter: ${e.message}`);
            return askOpenRouter(judgePrompt({ name, course }, results));
          })
        : await askOpenRouter(judgePrompt({ name, course }, results));

      const parsed = parseJson(text);
      if (!parsed || !["found", "unclear", "not_found"].includes(parsed.verdict)) {
        cache.delete(key);
        return null;
      }

      const fee = Number(parsed.published_total_fee);
      // Same plausibility bounds as callSchema.coerce() for money.
      const plausible = Number.isFinite(fee) && fee > 1000 && fee <= 1000000000 ? Math.round(fee) : null;
      // ...and it must be traceable to a snippet, exactly as every value on the
      // dashboard must be traceable to something the caller said. Not showing
      // the judge the quoted fee stops the parroting we saw; this stops the
      // next version of it, where a number is produced from somewhere other
      // than the search results in front of it.
      const traceable = plausible !== null && feeAppearsIn(plausible, results);
      if (plausible !== null && !traceable) {
        console.warn(`[verify] discarded a published fee of ₹${plausible} for "${name}" — no snippet states it`);
      }
      return {
        status: parsed.verdict,
        note: String(parsed.note || "").slice(0, 300),
        feeVerifiedOnline: traceable ? plausible : null,
        sources: results.map((r) => r.url).filter(Boolean).slice(0, 3),
        checkedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error(`[verify] could not check "${name}": ${e.message}`);
      cache.delete(key);
      return null;
    }
  })();

  cache.set(key, work);
  work.then((v) => cache.set(key, v)).catch(() => cache.delete(key));
  return work;
}
