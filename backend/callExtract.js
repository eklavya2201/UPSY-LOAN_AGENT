// Transcript → structured branch facts.
//
// This is the step the README called "the one piece deliberately not built",
// and the two decisions recorded there are implemented rather than revisited:
//
//   1. It runs OFF the voice critical path. Never inside a turn. The reply
//      latency budget is the thing the whole voice stack fights (~65% of it is
//      already the brain), and an extraction call inside the turn loop would
//      spend that budget on something the caller cannot hear. Callers are
//      served by voiceBrain.js; this is served by whatever is left over.
//
//   2. It stores what was SAID alongside every parsed value. The brain is
//      gpt-4o-mini today and this repo has already caught that model reading one
//      figure as ₹1,39,100 and ₹13,91,000 on separate runs. A loan amount pulled
//      out of speech and shown to an officer as fact, with no way to check it
//      against the sentence it came from, is the income-eval bug wearing a
//      different hat. So every value carries its quote, and the quote is checked
//      against the transcript — see verbatim below.
//
// Same provider chain as voiceBrain.js, assist.js and capture.js — Claude first,
// OpenRouter as fallback — so this repo has one pattern rather than five. Not
// streamed, because nobody is waiting to hear it.

import { BRANCHES, coerce, coverage, deriveAll, fieldApplies, getField } from "./callSchema.js";
import { getProfile, mergeProfile } from "./voiceAccounts.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// Haiku for the same reason voiceBrain.js picks it: this is structured reading
// of a short document, not reasoning. Overridable if a call needs more.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_EXTRACT_MODEL || "claude-haiku-4-5";

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL =
  process.env.OPENROUTER_EXTRACT_MODEL || process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini";

// Enough for every branch filled in with a quote each. Truncation here shows up
// as invalid JSON, which is caught, but it costs a whole extraction.
const MAX_TOKENS = 2000;

// A ten-minute call is ~120 turns. The cap is on characters rather than turns
// because one rambling answer can be longer than twenty short ones.
const MAX_TRANSCRIPT_CHARS = 24000;

export function extractorConfigured() {
  return Boolean(ANTHROPIC_KEY || OR_KEY);
}

export function extractorStatusLine() {
  if (ANTHROPIC_KEY) return `Claude (${ANTHROPIC_MODEL})`;
  if (OR_KEY) return `OpenRouter (${OR_MODEL})`;
  return "not configured";
}

// ── The contract handed to the model ────────────────────────────────────────

function fieldSpec(field) {
  const bits = [`"${field.id}"`, field.type];
  if (field.options) bits.push(`one of: ${field.options.join(" | ")}`);
  if (field.unit) bits.push(`in ${field.unit}`);
  return `    - ${bits.join(", ")} — ${field.label}. ${field.ask ? `Asked as: ${field.ask}.` : ""}`;
}

// Built from callSchema.js rather than written out here, for the same reason
// voicePrompt.js builds its checklist from documents.js: a schema the agent
// collects against and a contract the extractor fills must not be two lists
// that drift.
function schemaBlock() {
  return BRANCHES.map((branch) => {
    // Every call-sourced field, regardless of appliesWhen — the gate depends on
    // an answer we do not have yet at extraction time, and reading a Form 16
    // count out of a transcript that contains one costs nothing.
    const fields = branch.fields.filter((f) => f.source === "call");
    return `  "${branch.id}": (${branch.title} — ${branch.blurb})\n${fields.map(fieldSpec).join("\n")}`;
  }).join("\n\n");
}

const RULES = `Rules, in order of importance:

1. ONLY record what was actually established in this conversation. If a field was
   never discussed, LEAVE IT OUT. An omitted field is correct and costs nothing —
   the agent asks again on the next call. A guessed field is a wrong number on a
   loan officer's screen that nobody can trace.
2. Do NOT infer, average, convert between people, or fill a gap with what is
   typical. If the caller said their father earns "around a lakh", that is the
   co-applicant's monthly income only if the conversation made it monthly.
3. Every value needs a "said": the caller's own words that establish it, copied
   from the transcript EXACTLY, not paraphrased. If you cannot quote it, do not
   record it.
4. Prefer what the CALLER said. A line from UPSY only counts when the caller
   confirmed it ("yes, fifteen lakh").
5. Numbers as plain digits, no words, no symbols, no separators: fifteen lakh is
   1500000, ninety-five thousand a month is 95000, seventy-six percent is 76.
6. If the caller corrected themselves, record the correction, not the first answer.
7. Never record a PAN, Aadhaar, bank account or card number even if one was said
   out loud. Those fields do not exist here.
8. A field needs the caller to have addressed THAT topic. Adjacent is not the
   same: "we have no property to offer as security" answers the loan type, and
   says nothing at all about whether anyone holds a credit card.
9. Do not use what you know about the world. If they named an institute you
   recognise, that still does not tell you which country it is in — only they can.

Return JSON only. No commentary, no markdown fence. Shape:

{
  "<branch>": { "<field>": { "value": <value>, "said": "<their exact words>" } }
}

An empty object is a valid, correct answer for a call where nothing was established.`;

function buildPrompt(turns) {
  const transcript = renderTranscript(turns);
  return [
    `You are reading the transcript of a phone call between UPSY (an AI education-loan assistant) and a caller, and pulling out the facts it established. This feeds a loan officer's file, so a missing field is a nuisance and a wrong field is a real problem.`,
    `The fields, grouped by branch:\n\n${schemaBlock()}`,
    RULES,
    `Transcript:\n\n${transcript}`,
  ].join("\n\n");
}

function renderTranscript(turns) {
  const lines = (turns || [])
    .filter((t) => t && t.text)
    .map((t) => `${t.role === "caller" ? "CALLER" : "UPSY"}: ${String(t.text).trim()}`);
  const joined = lines.join("\n");
  // Keep the END of a long call: the later turns are where the specifics land,
  // and the opening is greetings.
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined;
}

// ── Providers ───────────────────────────────────────────────────────────────

async function callClaude(prompt, signal) {
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
      temperature: 0,
      messages: [
        { role: "user", content: prompt },
        // Prefill: the reply is already inside a JSON object, so there is no
        // room for a preamble to appear before it.
        { role: "assistant", content: "{" },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return "{" + (json.content?.[0]?.text || "");
}

async function callOpenRouter(prompt, signal) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: OR_MODEL,
      max_tokens: MAX_TOKENS,
      // Zero, not the 0.3 the conversational path uses. Reading a figure off a
      // transcript should give the same answer twice.
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}

// Models wrap JSON in prose or a fence often enough that a bare JSON.parse
// throws away work that is sitting right there.
function parseJsonLoose(text) {
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

// ── Validation ──────────────────────────────────────────────────────────────

// Punctuation and casing differ between what a model quotes and what Deepgram
// wrote down, and neither difference means the quote was invented.
//
// ALL punctuation goes, full stops included. An earlier version kept "." to
// protect decimals and marked six of sixteen good quotes as unmatched: a model
// ending its quote at "I am 24." cannot match a transcript that reads "I am 24,
// I live in Pune" once the comma has become a space. Both sides get the same
// treatment, so "1.5 lakh" becomes "1 5 lakh" on both and still matches — the
// only thing this function decides is whether one string contains the other.
function normalize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Shape the model's answer into something safe to store.
 *
 * Three things happen here and each has cost a bug somewhere in this repo:
 *   - unknown branches and fields are DROPPED, so a model that invents
 *     "applicant.salary" cannot write a field no dashboard will ever show;
 *   - every value goes through coerce(), so "15 lakh" becomes 1500000 and a
 *     CGPA in a percent field is rejected rather than stored as 8%;
 *   - the quote is checked against the transcript. A quote that is not in there
 *     is not proof of a wrong value, but it IS the signal that the model wrote
 *     the sentence rather than read it, so the value is kept and marked.
 */
export function validate(raw, turns) {
  const facts = {};
  const evidence = {};
  const dropped = [];
  const haystack = normalize((turns || []).map((t) => t.text).join(" "));

  for (const [branchId, branchValue] of Object.entries(raw || {})) {
    if (!BRANCHES.some((b) => b.id === branchId) || !branchValue || typeof branchValue !== "object") {
      dropped.push(`${branchId} (unknown branch)`);
      continue;
    }
    for (const [fieldId, entry] of Object.entries(branchValue)) {
      const field = getField(branchId, fieldId);
      if (!field || field.source !== "call") {
        dropped.push(`${branchId}.${fieldId} (not a field a call may fill)`);
        continue;
      }
      // Tolerate a bare value as well as {value, said}: models drop the wrapper
      // on simple fields, and refusing the answer over its packaging would lose
      // a fact the caller actually gave.
      const rawValue = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.value : entry;
      const said = entry && typeof entry === "object" ? String(entry.said || "").slice(0, 300) : "";

      const value = coerce(field, rawValue);
      if (value === undefined) {
        // An empty value is the model saying "not discussed" with a key instead
        // of by omission — the correct answer, just verbosely. Only report a
        // drop when something was actually there and could not be used, or the
        // log fills with non-events and nobody reads the real ones.
        const blank = rawValue === null || rawValue === undefined || rawValue === "";
        if (!blank) dropped.push(`${branchId}.${fieldId} (${JSON.stringify(rawValue)} is not a usable ${field.type})`);
        continue;
      }

      facts[branchId] = facts[branchId] || {};
      facts[branchId][fieldId] = value;
      evidence[`${branchId}.${fieldId}`] = {
        said,
        // false ⇒ the officer should read the transcript before acting on this
        // one. Shown in the dashboard rather than hidden in a log.
        verbatim: Boolean(said) && haystack.includes(normalize(said)),
        at: new Date().toISOString(),
      };
    }
  }

  // Second pass: drop fields the answers themselves rule out.
  //
  // "Three years of Form 16" has been observed landing in `itrYearsAvailable`
  // as well as `form16YearsAvailable` — the model hears "years of income proof"
  // and fills both. On a salaried file the ITR count is not merely unused, it
  // is a number an officer would read as real. This is the same gate coverage()
  // and the agenda already apply, so the three agree on what applies to whom.
  //
  // Only same-extraction facts gate it, deliberately: a category established on
  // an earlier call is in the stored profile, not here, and reaching into
  // storage to validate a parse would make this function depend on the account
  // it is being parsed for. The flag rules gate on category too, which is where
  // the consequence actually lands.
  for (const [branchId, values] of Object.entries(facts)) {
    for (const fieldId of Object.keys(values)) {
      const field = getField(branchId, fieldId);
      if (field && !fieldApplies(field, values)) {
        delete values[fieldId];
        delete evidence[`${branchId}.${fieldId}`];
        dropped.push(`${branchId}.${fieldId} (does not apply to a ${values.category || "caller"} of this kind)`);
      }
    }
  }

  return { facts, evidence, dropped };
}

// ── The entry point ─────────────────────────────────────────────────────────

/**
 * Read a finished (or in-progress) call.
 *
 * @param {object} opts
 * @param {Array<{role: string, text: string}>} opts.turns - the call transcript.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{facts: object, evidence: object, dropped: string[], model: string, ms: number}|null>}
 *   null when there is nothing to read or nothing to read it with. Never throws
 *   for a provider failure: the caller is a teardown path, and a call that
 *   cannot be summarised must still hang up cleanly.
 */
export async function extractCallFacts({ turns, signal } = {}) {
  const callerSaidSomething = (turns || []).some((t) => t.role === "caller" && t.text);
  if (!callerSaidSomething) return null;
  if (!extractorConfigured()) {
    console.warn("[voice:extract] no ANTHROPIC_API_KEY or OPENROUTER_API_KEY — the call cannot be read into the file.");
    return null;
  }

  const started = Date.now();
  const prompt = buildPrompt(turns);
  let text;
  let model;

  try {
    if (ANTHROPIC_KEY) {
      model = ANTHROPIC_MODEL;
      text = await callClaude(prompt, signal);
    } else {
      model = OR_MODEL;
      text = await callOpenRouter(prompt, signal);
    }
  } catch (e) {
    if (ANTHROPIC_KEY && OR_KEY) {
      console.error(`[voice:extract] Claude failed, falling back to OpenRouter: ${e.message}`);
      try {
        model = OR_MODEL;
        text = await callOpenRouter(prompt, signal);
      } catch (e2) {
        console.error(`[voice:extract] extraction failed: ${e2.message}`);
        return null;
      }
    } else {
      console.error(`[voice:extract] extraction failed: ${e.message}`);
      return null;
    }
  }

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    console.error(`[voice:extract] ${model} did not return usable JSON (${String(text).slice(0, 120)}…)`);
    return null;
  }

  const { facts, evidence, dropped } = validate(parsed, turns);
  return { facts, evidence, dropped, model, ms: Date.now() - started };
}

/**
 * Fold an extraction into a stored profile, and recompute everything derived.
 *
 * Kept here rather than in voiceAccounts.js because that module is deliberately
 * schema-agnostic — it merges whatever object it is handed and knows nothing
 * about branches. This is the schema-aware half: it decides that `_evidence`
 * accumulates, and that `underwriting` and `_flags` are RECOMPUTED wholesale
 * from the merged result rather than merged into. A FOIR left over from a call
 * where the income was wrong is worse than no FOIR at all.
 *
 * @param {object} existing - the account's current profile.
 * @param {object} extraction - what extractCallFacts() returned.
 * @returns {object} the patch to hand to mergeProfile().
 */
export function profilePatch(existing, extraction) {
  const merged = deepMerge(structuredClone(existing || {}), extraction?.facts || {});
  const { underwriting, flags } = deriveAll(merged);
  return {
    ...(extraction?.facts || {}),
    underwriting,
    _flags: flags,
    _evidence: extraction?.evidence || {},
  };
}

/**
 * Read a call and write it into the caller's file. Extract → merge → derive.
 *
 * Lives here rather than in voiceRelay.js so that the relay owns only the
 * question of WHEN a call gets read (mid-call, at teardown, and the queueing
 * between them) while this module owns what reading it means. It also makes the
 * write path testable without a WebSocket, a microphone or a provider —
 * `npm run eval:extract` and the relay reach storage through the same function
 * rather than through two that resemble each other.
 *
 * Resolves to a short summary for logging, or null when nothing was learned.
 * Never rejects: every caller is a teardown or a fire-and-forget path.
 */
export async function fileCall({ accountId, turns, reason = "call ended" }) {
  if (!accountId) return null;
  try {
    const extraction = await extractCallFacts({ turns });
    if (!extraction) return null;

    const branches = Object.keys(extraction.facts || {});
    if (!branches.length) {
      return { branches, summary: `${reason}: nothing new established (${extraction.model}, ${extraction.ms}ms)` };
    }

    const existing = await getProfile(accountId);
    const patch = profilePatch(existing, extraction);
    // `underwriting` and `_flags` are computed from the whole profile, so they
    // are overwritten rather than merged — a FOIR left over from a call where
    // the income was wrong is worse than no FOIR. See mergeProfile().
    const profile = await mergeProfile(accountId, patch, { replace: ["underwriting", "_flags"] });
    const cover = coverage(profile || {});

    if (extraction.dropped?.length) {
      // Visible on purpose. A field the model keeps inventing, or a figure it
      // keeps returning in an unusable shape, is a prompt problem — and the only
      // way anyone finds out is if it is said out loud.
      console.warn(`[voice:extract] dropped: ${extraction.dropped.join("; ")}`);
    }

    return {
      branches,
      profile,
      coverage: cover,
      summary: `${reason}: read ${branches.join(", ")} — ${cover.captured}/${cover.total} on file (${extraction.model}, ${extraction.ms}ms)`,
    };
  } catch (e) {
    console.error("[voice:extract] could not file the call:", e.message);
    return null;
  }
}

/**
 * Fold new facts into a profile without touching storage.
 *
 * The relay uses this for callers with no account: their call still fills the
 * live agenda on /m and narrows the prompt mid-call, it just is not written
 * anywhere — same rule as the transcript.
 */
export function mergedProfile(existing, facts) {
  return deepMerge(structuredClone(existing || {}), facts || {});
}

// Local to this module: the same shape-preserving merge mergeProfile() applies
// to storage, used here only to compute the derived branch against what the
// profile is ABOUT to be rather than what it currently is.
function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}
