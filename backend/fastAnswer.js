// Reading the answer to the question we just asked — in plain code, instantly.
//
// The extractor (callExtract.js) is a model call running behind the
// conversation. It is thorough: it reads the whole transcript, catches facts
// nobody asked for, spots corrections, and makes every value carry a verified
// quote. What it is not is immediate — and for a second or two after someone
// answers, their answer does not exist anywhere the agent or the dashboard can
// see it.
//
// But there is one case that needs no model at all: WE ASKED A SPECIFIC
// QUESTION, and the very next thing the caller said was the answer. The relay
// already knows which field it just asked about (matchAgendaField, which drives
// the call map), and callSchema already knows how to turn "1.5 lakhs" into
// 150000 (parseRupees/coerce). Wiring those two together files the answer in
// the same tick it is heard.
//
// ── What this deliberately does NOT do ──────────────────────────────────────
// It is not a second extractor and must never grow into one. It reads the
// answer to a question that was just asked, and nothing else:
//
//   · Only fields the agent actually asked for. No free-floating parsing of
//     whatever numbers drift past in a sentence.
//   · Only EMPTY fields. A correction ("no, I said fifteen") is exactly the
//     case a whole-transcript model handles well and a regex handles badly, so
//     overwriting is left to the audit layer. This module can only ever fill a
//     hole, never argue with a value.
//   · Only unambiguous values. Two numbers in a sentence means we do not know
//     which one was meant, and the honest answer is to let the model decide.
//   · Never `text` fields. A name, an institute or a course is the half of the
//     problem that actually needs a language model — "my father" is not a name,
//     and that guard already exists over there.
//
// The whole design rests on one asymmetry: a hole that stays empty for another
// two seconds costs nothing, because the extractor is right behind. A wrong
// value written confidently into a loan file costs an officer's trust in every
// other value on the screen.

import { coerce } from "./callSchema.js";

// Things people say instead of answering. These must never parse as values —
// "I don't know" contains no digits so money is safe by construction, but a
// boolean field would happily read the "no" in "no idea" as false.
const NON_ANSWER =
  /\b(?:i (?:don'?t|do not) know|no idea|not sure|can'?t say|cannot say|pata nahi|maloom nahi|nahi pata|let me check|i'?ll have to check|not right now|later)\b/i;

// A number with an Indian magnitude word attached — "1.5 lakhs", "20L", "3 cr".
// The unit is what makes it unambiguous: somebody saying a money figure out
// loud almost always says the scale with it, and one that carries a scale is
// the one they meant.
const SCALED_NUMBER = /\d+(?:\.\d+)?\s*(?:cr|crore|crores|l\b|lac|lakh|lakhs|k\b|thousand)/gi;

// Any bare number, used only to detect ambiguity.
const ANY_NUMBER = /\d+(?:\.\d+)?/g;

const AFFIRMATIVE = /^(?:yes|yeah|yep|yup|haan|ha|ji|correct|right|true|of course|sure)\b/i;
const NEGATIVE = /^(?:no|nope|nah|nahi|never|none|not really|negative)\b/i;

/**
 * The answer to `field`, read out of what the caller just said — or null.
 *
 * Null means "not confident", and every caller treats that as "wait for the
 * extractor". It is the expected outcome for most turns and is not a failure.
 *
 * @param {object} field  - the schema field the agent just asked about
 * @param {string} text   - the caller's reply, verbatim
 * @returns {{value: any, quote: string}|null}
 */
export function readAnswer(field, text) {
  const said = String(text || "").trim();
  if (!said || !field) return null;
  if (NON_ANSWER.test(said)) return null;

  switch (field.type) {
    case "money":
    case "number":
    case "percent":
      return readNumeric(field, said);
    case "boolean":
      // ⚠️ DELIBERATELY DISABLED. A bare "yes" or "no" fits every boolean field
      // in the schema equally well, so it carries no evidence of WHICH question
      // it answers — if the match is wrong, nothing in the answer itself can
      // catch it. That is exactly how a "Yes" to "you'll need your PAN and
      // Aadhaar, do you have it?" was filed as the applicant having a credit
      // history. A number at least has to be plausible for its field before
      // coerce() accepts it; a boolean has no such floor.
      //
      // Booleans are cheap for the extractor to get right, because it reads the
      // question and the answer together. Left to it on purpose.
      return null;
    case "enum":
      return readEnum(field, said);
    default:
      // text, and anything added later. Left to the model on purpose — see the
      // header. A new type arriving here silently defers rather than guessing.
      return null;
  }
}

function readNumeric(field, said) {
  // Indian digit grouping first: "1,50,000" is one number, not three. Speech
  // recognition rarely emits commas, but a typed or pasted figure would.
  const normalised = said.replace(/(\d),(?=\d)/g, "$1");

  // EXACTLY ONE number in the whole sentence, and no exceptions. The rule is
  // this blunt because the near-misses are the dangerous ones:
  //
  //   "between 20 and 25 lakhs"  → a range. Only "25 lakhs" carries the unit,
  //                                so a scaled-number check alone reads it as
  //                                unambiguous and files ₹25L against a caller
  //                                who never said that.
  //   "I have 2 brothers and he earns 95000" → would file ₹2 as an income.
  //
  // Both are one model call away from being read correctly, and the extractor
  // is already making that call. There is nothing to win by guessing here.
  const numbers = normalised.match(ANY_NUMBER) || [];
  if (numbers.length !== 1) return null;

  // Prefer the scaled form when there is one, so the unit reaches parseRupees:
  // "1.5 lakhs" must arrive intact or it parses as ₹1.50.
  const scaled = normalised.match(SCALED_NUMBER) || [];
  const candidate = scaled.length === 1 ? scaled[0] : numbers[0];

  const value = coerce(field, candidate);
  // coerce() rejects anything outside the field's sane range — a negative
  // amount, ₹100 Cr, a CGPA masquerading as a percentage. Undefined means it
  // already caught something we should not store.
  if (value === undefined) return null;
  return { value, quote: said };
}

function readBoolean(field, said) {
  // Must OPEN with the yes or no. "No, my father is salaried" is an answer;
  // "my brother has no loans" is a sentence that happens to contain one, and
  // the leading-token rule is what separates them.
  if (AFFIRMATIVE.test(said)) return { value: true, quote: said };
  if (NEGATIVE.test(said)) return { value: false, quote: said };
  return null;
}

function readEnum(field, said) {
  const lower = said.toLowerCase();
  const hits = (field.options || []).filter((o) => {
    // Word-boundary match so "farmer" does not fire on "farmhouse", and so
    // "self-employed" is found inside a normal sentence.
    const escaped = o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(lower);
  });
  if (hits.length !== 1) return null; // none, or "salaried or self-employed?"
  const value = coerce(field, hits[0]);
  return value === undefined ? null : { value, quote: said };
}
