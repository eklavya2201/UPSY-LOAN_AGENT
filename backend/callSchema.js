// What a call is supposed to establish — the team's branch schema, from the
// underwriting flowchart.
//
// This is the file the README's "🕳️ The one piece deliberately not built"
// section was waiting for. Everything downstream of it already accepted any
// shape: voiceAccounts.mergeProfile() is schema-agnostic, voicePrompt's
// renderFacts() walks nested objects generically, and team.js's factRows()
// renders whatever it is handed. So this module is the definition, and three
// consumers read it rather than restating it:
//
//   voicePrompt.js   — turns it into what the agent should ASK, and what is
//                      still missing for this particular caller.
//   callExtract.js   — turns it into the JSON contract the model must fill in,
//                      and validates what comes back against it.
//   team.js          — reads /api/voice/schema so an officer sees the same
//                      branches, in the same order, with the gaps named.
//
// ONE definition, because the failure mode otherwise is an agent that asks for
// something the dashboard has no row for, or a dashboard showing a blank field
// nobody was ever asked about.
//
// ── The five branches ───────────────────────────────────────────────────────
// Four are collected by talking; the fifth is arithmetic on the other four.
//
//              applicant ──► institute ──► loan ──► coApplicant
//                                  │
//                                  ▼
//                            underwriting (derived: FOIR, lender tier, flags)
//
// The order is the flowchart's and it is not arbitrary: "ask for institute,
// course and approx total fee — THEN SHIFTS TO INSTITUTE BRANCH". You cannot
// size a loan before you know the fee, and the co-applicant's income only means
// something once there is an amount to test it against.
//
// ── source: where a field is allowed to come from ───────────────────────────
//   "call"     — the agent asks, in conversation. The only kind that enters the
//                agenda in voicePrompt.js.
//   "document" — read off an upload by the existing vision chain. NEVER asked
//                aloud; PRIVACY_RULES in voicePrompt.js forbids a caller
//                reading an ID number down a phone line, and that rule wins.
//   "api"      — a bureau/KYC lookup (DIGITAP in the flowchart). Not wired yet.
//
// Non-call fields are kept here anyway, because the flag rules below need them
// and because the dashboard should show an officer that a field exists and is
// pending rather than silently omitting it.

// ── Field types ─────────────────────────────────────────────────────────────
// Small on purpose. Each one exists because coerce() has to do something
// specific with it — a type nobody coerces differently is just a comment.
//
//   text | enum | boolean | number | percent | money | years
//
// `money` is the one that earns its keep: callers say "fifteen lakh", the model
// is asked for digits, and something still has to catch "15 lakh" when it does
// not comply. See parseRupees().

export const BRANCHES = [
  {
    id: "applicant",
    title: "Student",
    blurb: "Who is studying, and whether their own profile holds up.",
    fields: [
      { id: "name", label: "Full name", type: "text", source: "call",
        ask: "their full name, as it reads on their ID" },
      { id: "age", label: "Age", type: "number", source: "call", unit: "years",
        ask: "how old they are" },
      { id: "city", label: "City they live in", type: "text", source: "call",
        ask: "which city they currently live in" },
      { id: "currentQualification", label: "Current qualification", type: "enum", source: "call",
        options: ["10th", "12th", "diploma", "undergraduate", "postgraduate"],
        ask: "what they have most recently completed or are completing — 12th, a diploma, a degree" },
      { id: "marksPercent", label: "Marks (average %)", type: "percent", source: "call",
        ask: "roughly what percentage they scored in that qualification",
        // The flowchart says to average this off the marksheets. What the caller
        // says is a starting point that the marksheet upload later overrides —
        // this repo has an existing precedent for a document beating a claim
        // (income.js overrides the lead source's stated income).
        note: "Provisional until the marksheets are read." },
      { id: "gapYears", label: "Gap years since that qualification", type: "number", source: "call", unit: "years",
        ask: "whether there has been any gap after that, and how long" },
      { id: "hasCreditHistory", label: "Has any card or loan already", type: "boolean", source: "call",
        // The proxy for the bureau pull that is not built. The flowchart's own
        // note — "NTC is good to go" — means a caller with no credit history is
        // not a problem, so the useful question is the yes/no, not the score.
        ask: "whether they already have a credit card or any loan in their own name" },
      { id: "aadhaarCity", label: "City on their Aadhaar", type: "text", source: "call",
        // Deliberately a spoken question, not a document read. The flowchart
        // says "Check if city of residence by student is same as aadhaar address
        // — else flag as threat (Ask in conversation)". The mismatch is the
        // signal; asking for the city is not asking for the number.
        ask: "which city the address on their Aadhaar is in, if it is different from where they live now" },
      { id: "aadhaarOnFile", label: "Aadhaar", type: "boolean", source: "document",
        note: "Read from the upload. Never spoken on a call." },
      { id: "panOnFile", label: "PAN", type: "boolean", source: "document",
        note: "Read from the upload. Never spoken on a call." },
      { id: "cibilScore", label: "CIBIL score", type: "number", source: "api",
        note: "DIGITAP bureau pull — not integrated yet. The flag rule below fires only when a score actually exists." },
    ],
  },

  {
    id: "institute",
    title: "Institute & course",
    blurb: "Where the money is going, and what the real number is.",
    fields: [
      { id: "name", label: "Institute", type: "text", source: "call",
        ask: "which institute or university" },
      { id: "course", label: "Course", type: "text", source: "call",
        ask: "which course, and at what level" },
      { id: "country", label: "Country", type: "text", source: "call",
        ask: "whether it is in India or abroad, and where" },
      { id: "courseDurationMonths", label: "Course length", type: "number", source: "call", unit: "months",
        // Not on the flowchart, and it is here because the moratorium cannot be
        // stated without it — eligibility.js has always computed course duration
        // + 9 months, and today it falls back to a guess of 24.
        ask: "how long the course runs" },
      { id: "totalFee", label: "Total fee quoted", type: "money", source: "call",
        ask: "roughly what the total fee comes to" },
      { id: "hostelFeeIncluded", label: "Hostel fee inside that figure", type: "boolean", source: "call",
        // Straight off the flowchart: inclusive → treat as tuition; exclusive →
        // it is a personal expense and is not part of what is being lent on.
        ask: "whether that figure includes hostel and living costs or is tuition only" },
      { id: "offerLetter", label: "Offer letter", type: "enum", source: "call",
        options: ["received", "applied", "not yet"],
        ask: "whether they already have the offer or admission letter" },
      { id: "feeVerifiedOnline", label: "Published fee found online", type: "money", source: "api",
        note: "Filled by instituteVerify.js when a search snippet states the programme fee. The fee_deviation flag below compares it against what the caller quoted." },
    ],
  },

  {
    id: "loan",
    title: "The loan itself",
    blurb: "What they actually need from us, as opposed to what the course costs.",
    fields: [
      { id: "amountNeeded", label: "Amount needed", type: "money", source: "call",
        ask: "how much of that fee they need to borrow, as opposed to what the family can put in" },
      { id: "type", label: "Secured or unsecured", type: "enum", source: "call",
        options: ["secured", "unsecured"],
        ask: "whether they have property or a deposit to offer as security, or want it without collateral" },
      { id: "collateral", label: "What the security is", type: "text", source: "call",
        ask: "what the security would be, if they mentioned having any" },
    ],
  },

  {
    id: "coApplicant",
    title: "Co-applicant",
    blurb: "The person whose income the loan is actually underwritten on.",
    fields: [
      { id: "name", label: "Name", type: "text", source: "call",
        // "their actual name" is doing work: asked without it, the extractor
        // fills this field with "father" from a caller who never gave one.
        ask: "who will co-apply with them — their actual name, not just the relationship",
        // And the prompt alone does not hold. Measured: gpt-4o-mini kept writing
        // "father" here across runs, with a quote to match, because the caller
        // genuinely said "my father" and never gave a name. The relationship is
        // already captured in the field below, so a name that IS a relationship
        // carries no information and is refused — it would otherwise reach a
        // lender referral draft as the co-borrower's name.
        reject: ["father", "mother", "brother", "sister", "spouse", "dad", "mum", "mom", "papa", "mummy", "uncle", "aunt", "husband", "wife", "parent", "guardian"] },
      { id: "relation", label: "Relationship to the student", type: "enum", source: "call",
        // The flowchart is specific and restrictive: directly related only —
        // "no cousin of student applicant etc." eligibility.js already encodes
        // the same list for the lead path, and the two must not drift.
        options: ["father", "mother", "brother", "sister", "spouse", "other"],
        ask: "how that person is related to them" },
      { id: "category", label: "Income category", type: "enum", source: "call",
        options: ["salaried", "self-employed", "pensioner", "farmer"],
        ask: "whether that person is salaried, self-employed, a pensioner or a farmer" },
      { id: "monthlyIncome", label: "Monthly income (net in-hand)", type: "money", source: "call",
        ask: "roughly what they take home in a month" },
      { id: "annualItr", label: "Latest ITR — annual income", type: "money", source: "call",
        appliesWhen: { category: ["self-employed", "farmer"] },
        ask: "what the latest ITR shows as annual income" },
      { id: "itrYearsAvailable", label: "Years of ITR available", type: "number", source: "call", unit: "years",
        appliesWhen: { category: ["self-employed", "farmer"] },
        ask: "how many years of ITR they can produce — three is ideal, two is the minimum" },
      { id: "form16YearsAvailable", label: "Years of Form 16 available", type: "number", source: "call", unit: "years",
        appliesWhen: { category: ["salaried"] },
        ask: "how many years of Form 16 they have — three is ideal, two is the minimum" },
      { id: "annualBonus", label: "Yearly bonus", type: "money", source: "call",
        appliesWhen: { category: ["salaried"] },
        // "soft conversation check" on the flowchart — worth asking, never worth
        // pressing, and it is not part of the income the FOIR is computed on.
        ask: "whether there is a yearly bonus on top of that, and roughly how much" },
      { id: "recentJobChange", label: "Changed job recently", type: "boolean", source: "call",
        appliesWhen: { category: ["salaried"] },
        ask: "whether they have changed jobs recently — that decides whether we need the joining letter too" },
      { id: "existingEmiMonthly", label: "Existing EMIs, per month", type: "money", source: "call",
        // The number the whole underwriting branch turns on, which is why it is
        // asked of every category rather than sitting under one of them.
        ask: "what they are already paying every month across all their existing loans" },
      { id: "guarantorElsewhere", label: "Guarantor on someone else's loan", type: "boolean", source: "call",
        ask: "whether they have stood guarantor on anyone else's loan" },
      { id: "livesAtKycAddress", label: "Lives at the KYC address", type: "boolean", source: "call",
        // The flowchart asks for a light/gas bill to prove current residence.
        // The bill is an upload; whether it will match is a spoken question.
        ask: "whether they still live at the address on their Aadhaar — we ask for a light or gas bill to confirm it" },
      { id: "cibilScore", label: "CIBIL score", type: "number", source: "api",
        note: "DIGITAP bureau pull — not integrated yet." },
    ],
  },
];

// The derived branch. Not in BRANCHES because nothing here is ever asked or
// extracted — computeUnderwriting() writes all of it, and letting the model
// return a FOIR would mean an LLM doing the arithmetic a lender will redo.
export const DERIVED_BRANCH = {
  id: "underwriting",
  title: "Underwriting",
  blurb: "Computed from the branches above. Nothing here is asked or extracted.",
};

// ── Underwriting constants, straight from the flowchart ─────────────────────

// "Total loan amount divided by 10 years avg tenure for monthly EMI". Note what
// this is NOT: an amortised EMI. It is principal ÷ 120, interest excluded,
// exactly as drawn. A real EMI at 11% over 10 years is ~38% higher, so this
// number is deliberately optimistic and is labelled as indicative everywhere it
// surfaces. Changing it to a real amortisation is a product decision, not a bug
// fix — the lender bands below were drawn against this definition.
export const AVG_TENURE_YEARS = 10;

// FOIR% → which lender the file goes to.
//
// ⚠️ Transcribed with a judgement call. The flowchart reads "<50% - Lender 1;
// <70% Lender 2; >75% Lender 3; >80% Lender 4", which leaves 70–75 belonging to
// nobody and 80+ matching two rules. Read here as four ordered bands with the
// stated boundaries, first match wins. If the team meant something else in the
// 70–75 window, this is the line to change — and it is the only line.
export const FOIR_BANDS = [
  { max: 50, lender: "Lender 1", note: "Comfortable — the strongest band." },
  { max: 70, lender: "Lender 2", note: "Workable." },
  { max: 80, lender: "Lender 3", note: "Stretched — expect a closer look at the co-applicant." },
  { max: Infinity, lender: "Lender 4", note: "Over 80% — only the most accommodating lender, and not certain." },
];

// Indicative only, and copied from voicePrompt.js's ELIGIBILITY_RULES rather
// than invented here, so all three agents and the dashboard quote one set of
// numbers. The flowchart asks for "standard rates for lenders mapped ...
// conveyed as approximate rates for non-collateral loans".
export const RATE_BANDS = { secured: "9.5% – 11.5%", unsecured: "10.5% – 13%" };

// The relations the flowchart allows. "no cousin of student applicant etc." is
// the explicit exclusion; "other" is what the extractor returns when a caller
// says cousin, uncle or friend, and it is what raises the flag.
export const PERMITTED_RELATIONS = ["father", "mother", "brother", "sister", "spouse"];

// A 12th-standard student is 17–18. The flowchart wants an older one flagged as
// a possible undeclared gap year — "if student is having gap year and age is
// 19-20-21 flag as threat".
const SCHOOL_LEAVING_AGE_MAX = 18;

const MIN_ACADEMIC_PERCENT = 60; // matches eligibility.js
const MIN_CIBIL = 650; // "FLAG if exists and below 650 (NTC is good to go)"
const MIN_INCOME_PROOF_YEARS = 2; // "if not then 2 years are needed minimum"

// ── Lookups ─────────────────────────────────────────────────────────────────

/**
 * What we already know about a caller before they say a word.
 *
 * An /m account holds the name they typed at signup. Without this the branch
 * profile starts empty, the agenda lists "their full name" as missing, and the
 * agent asks for something it just used in the greeting — which is exactly what
 * happened on the first real call: *"Hi eklavya, this is UPSY again"* followed
 * by *"Can you tell me your full name?"*, then three failed attempts to hear a
 * name that was already on file.
 *
 * A name is also the single worst thing to put through speech recognition —
 * arbitrary proper nouns, no language model to fall back on — so the best
 * version of this question is the one never asked.
 */
export function accountIdentityFacts(account) {
  if (!account?.name) return {};
  return { applicant: { name: String(account.name).trim().slice(0, 200) } };
}

export function getBranch(branchId) {
  return BRANCHES.find((b) => b.id === branchId) || null;
}

export function getField(branchId, fieldId) {
  return getBranch(branchId)?.fields.find((f) => f.id === fieldId) || null;
}

/**
 * Does this field apply to this caller at all?
 *
 * Form 16 is meaningless for a self-employed co-applicant and an ITR count is
 * meaningless for a salaried one. Without this the agenda would ask everyone
 * everything and the dashboard would report a salaried file as permanently
 * incomplete because it has no ITR years.
 */
export function fieldApplies(field, branchValues) {
  if (!field.appliesWhen) return true;
  return Object.entries(field.appliesWhen).every(([key, allowed]) => {
    const actual = branchValues?.[key];
    // Unknown gate ⇒ applicable. Before the category is known, both income
    // branches are still live, and hiding them would mean the agent never asks
    // the question that resolves them.
    if (actual === null || actual === undefined || actual === "") return true;
    return allowed.includes(String(actual));
  });
}

/** Only the fields a conversation is allowed to fill. */
export function callFields(branch, branchValues) {
  return branch.fields.filter((f) => f.source === "call" && fieldApplies(f, branchValues));
}

// ── Coercion ────────────────────────────────────────────────────────────────

/**
 * "fifteen lakh" → 1500000.
 *
 * The model is asked for plain digits and mostly complies, so this is the net
 * under it rather than the primary path. It exists because the single most
 * dangerous number in this product is the loan amount, this repo has already
 * caught gpt-4o-mini reading ₹1,39,100 as ₹13,91,000, and a FOIR computed on a
 * misread income is a lending decision made on noise.
 *
 * Word-form numerals ("fifteen") are deliberately NOT parsed — that is a
 * dictionary of edge cases, and the value is better left null than guessed.
 * Deepgram already returns digits for spoken numerals.
 */
export function parseRupees(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;

  const text = String(raw).toLowerCase().replace(/[,₹\s]/g, "");
  const match = /(\d+(?:\.\d+)?)(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?/.exec(text);
  if (!match) return null;

  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2] || "";
  if (/^(cr|crore|crores)$/.test(unit)) return Math.round(n * 10000000);
  if (/^(l|lac|lakh|lakhs)$/.test(unit)) return Math.round(n * 100000);
  if (/^(k|thousand)$/.test(unit)) return Math.round(n * 1000);
  return Math.round(n);
}

/**
 * Force an extracted value into the field's declared type, or reject it.
 *
 * Returns `undefined` for anything that cannot be trusted, and every caller
 * treats undefined as "we did not learn this" — an absent field is a question
 * the agent asks again next time, which is a far better outcome than a wrong
 * figure sitting on an officer's screen looking established.
 */
export function coerce(field, raw) {
  if (raw === null || raw === undefined || raw === "") return undefined;

  switch (field.type) {
    case "money": {
      const n = parseRupees(raw);
      // A loan or income figure of zero is real (no existing EMIs), a negative
      // one is not, and anything past ₹100 Cr is a parse gone wrong.
      return n === null || n < 0 || n > 1000000000 ? undefined : n;
    }
    case "number": {
      const n = Number(String(raw).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) && n >= 0 && n < 10000 ? Math.round(n * 100) / 100 : undefined;
    }
    case "percent": {
      // A CGPA slips through here as a small number and would be stored as 8%,
      // which then trips the "below 60%" flag and puts a wrong threat on an
      // officer's screen. So the floor is 10, not 0: an education-loan applicant
      // does not score under 10 percent, and a genuine 10% refused is one more
      // question on the next call, which is the direction this repo errs in
      // everywhere else too.
      const n = Number(String(raw).replace(/[^\d.]/g, ""));
      return Number.isFinite(n) && n > 10 && n <= 100 ? Math.round(n * 10) / 10 : undefined;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const t = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(t)) return true;
      if (["false", "no", "n", "0"].includes(t)) return false;
      return undefined;
    }
    case "enum": {
      const t = String(raw).trim().toLowerCase();
      const hit = (field.options || []).find((o) => o.toLowerCase() === t);
      if (hit) return hit;
      // One deliberate normalisation, because it is the one the flowchart cares
      // about: any relation outside the permitted list must land on "other" so
      // the flag fires, rather than being dropped as unrecognised and looking
      // like the question was never answered.
      if (field.id === "relation" && (field.options || []).includes("other")) return "other";
      return undefined;
    }
    default: {
      const t = String(raw).trim();
      if (!t) return undefined;
      // Values a field must never hold, however confidently they arrive. The
      // one live case is a co-applicant "name" that is really a relationship —
      // see the note on that field.
      if ((field.reject || []).includes(t.toLowerCase().replace(/^my\s+/, ""))) return undefined;
      return t.slice(0, 200);
    }
  }
}

// ── Coverage ────────────────────────────────────────────────────────────────

/**
 * What is still unanswered, branch by branch.
 *
 * Used twice and that is the point: the agent reads it to know what to ask
 * next, and the officer reads the same list to know what the call did not get
 * to. One computation, so the dashboard can never claim a field is missing that
 * the agent was never going to ask for.
 */
export function coverage(profile = {}) {
  // Fields the caller was asked and could not answer. Off the agenda — asking
  // a third time is the failure a real call already demonstrated — and out of
  // the denominator, because "8 of 9, one they didn't know" reads as a
  // finished branch, which it is.
  const declinedSet = new Set(Array.isArray(profile._declined) ? profile._declined : []);

  const branches = BRANCHES.map((branch) => {
    const values = profile[branch.id] || {};
    const applicable = callFields(branch, values);
    const isEmpty = (f) => {
      const v = values[f.id];
      return v === null || v === undefined || v === "";
    };
    const declined = applicable.filter((f) => isEmpty(f) && declinedSet.has(`${branch.id}.${f.id}`));
    const askable = applicable.filter((f) => !declined.includes(f));
    const missing = askable.filter(isEmpty);
    return {
      id: branch.id,
      title: branch.title,
      blurb: branch.blurb,
      total: askable.length,
      captured: askable.length - missing.length,
      missing: missing.map((f) => ({ id: f.id, label: f.label, ask: f.ask })),
      declined: declined.map((f) => ({ id: f.id, label: f.label })),
    };
  });
  const total = branches.reduce((s, b) => s + b.total, 0);
  const captured = branches.reduce((s, b) => s + b.captured, 0);
  return { branches, total, captured, percent: total ? Math.round((captured / total) * 100) : 0 };
}

// ── The live agenda, for the /m call screen ─────────────────────────────────

/**
 * The same information as coverage(), shaped for the constellation on /m:
 * every call-askable field with a status, so the page can draw the loan file
 * filling in while the call happens instead of a hardcoded topic ring.
 *
 *   done    — answered (on this call or an earlier one)
 *   pending — still to ask
 *   skipped — ruled out by an answer (a salaried co-applicant's ITR fields)
 *
 * Labels and statuses only — no values. The caller knows what they said, and
 * the page does not need a second copy of the profile to light a dot.
 *
 * `next` is the first pending field in flow order, which is what the agent will
 * ask next by construction: COLLECTION_STYLE tells it to ask in branch order.
 */
export function agendaSnapshot(profile = {}) {
  const declinedSet = new Set(Array.isArray(profile._declined) ? profile._declined : []);
  const branches = BRANCHES.map((branch) => {
    const values = profile[branch.id] || {};
    const fields = branch.fields
      .filter((f) => f.source === "call")
      .map((f) => {
        const v = values[f.id];
        const filled = !(v === null || v === undefined || v === "");
        const status = !fieldApplies(f, values)
          ? "skipped"
          : filled
            ? "done"
            : declinedSet.has(`${branch.id}.${f.id}`)
              ? "declined" // asked — they did not know. Off the agenda, out of the counts.
              : "pending";
        return { id: f.id, label: f.label, status };
      });
    return { id: branch.id, title: branch.title, blurb: branch.blurb, fields };
  });

  let next = null;
  for (const b of branches) {
    const f = b.fields.find((x) => x.status === "pending");
    if (f) {
      next = { branch: b.id, field: f.id };
      break;
    }
  }

  const all = branches.flatMap((b) => b.fields);
  const done = all.filter((f) => f.status === "done").length;
  const total = all.filter((f) => f.status === "done" || f.status === "pending").length;
  const uw = computeUnderwriting(profile);
  return { branches, next, done, total, underwriting: { ready: Boolean(uw.ready) } };
}

// Words too common to identify a field. Everything else in a field's label and
// ask phrasing is fair game for the spotlight matcher below.
const MATCH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "from",
  "that", "this", "is", "are", "was", "be", "been", "it", "its", "they", "their",
  "them", "you", "your", "we", "our", "his", "her", "she", "he", "what", "which",
  "who", "whether", "how", "do", "does", "did", "have", "has", "had", "not", "no",
  "yes", "if", "else", "than", "then", "as", "by", "any", "one", "two", "three",
  "some", "roughly", "about", "already", "still", "would", "will", "can", "could",
  "should", "just", "also", "etc", "most", "there", "out", "per", "all", "who",
]);

function matchTokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
    if (w.length > 2 && !MATCH_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Which field is this spoken sentence about? Word overlap against each field's
 * label + ask phrasing, preferring fields still pending. Purely cosmetic — it
 * drives the spotlight on /m, never a lending decision — so a miss returns null
 * and a near-tie landing on the neighbouring dot is acceptable.
 */
export function matchAgendaField(text, profile = {}) {
  const said = matchTokens(text);
  if (!said.size) return null;

  let best = null;
  for (const branch of BRANCHES) {
    const values = profile[branch.id] || {};
    for (const field of callFields(branch, values)) {
      let score = 0;
      for (const w of matchTokens(`${field.label} ${field.ask || ""}`)) {
        if (said.has(w)) score++;
      }
      if (!score) continue;
      const v = values[field.id];
      const pending = v === null || v === undefined || v === "";
      const rank = score + (pending ? 0.5 : 0);
      if (!best || rank > best.rank) best = { branch: branch.id, field: field.id, rank };
    }
  }
  return best ? { branch: best.branch, field: best.field } : null;
}

// ── The derived branch ──────────────────────────────────────────────────────

function bandFor(foir) {
  return FOIR_BANDS.find((b) => foir < b.max) || FOIR_BANDS[FOIR_BANDS.length - 1];
}

/**
 * The flowchart's lender box, in code.
 *
 *   existing EMIs ÷ monthly income                    = FOIR now
 *   loan ÷ (10 years × 12)                            = the new EMI
 *   (existing EMI + new EMI) ÷ monthly income         = FOIR after this loan
 *   that number picks the lender band
 *
 * Returns `ready: false` with the reason named when an input is missing, rather
 * than computing a ratio out of a zero. A confident 0% FOIR on an unknown income
 * is precisely the kind of number an officer would act on.
 */
export function computeUnderwriting(profile = {}) {
  const co = profile.coApplicant || {};
  const loan = profile.loan || {};
  const institute = profile.institute || {};

  // Salaried callers give a monthly figure; self-employed give an annual ITR and
  // the flowchart's own rule is annual ÷ 12 — the same rule income.js applies to
  // an uploaded ITR, kept identical on purpose.
  let monthlyIncome = null;
  let incomeBasis = null;
  if (co.monthlyIncome > 0) {
    monthlyIncome = co.monthlyIncome;
    incomeBasis = "stated monthly income";
  } else if (co.annualItr > 0) {
    monthlyIncome = Math.round(co.annualItr / 12);
    incomeBasis = "latest ITR ÷ 12";
  }

  // What is being borrowed: what they asked for, else the fee as a stand-in.
  const loanAmount = loan.amountNeeded > 0 ? loan.amountNeeded : institute.totalFee > 0 ? institute.totalFee : null;
  const amountBasis = loan.amountNeeded > 0 ? "amount they asked for" : loanAmount ? "total fee, as a stand-in" : null;

  const missing = [];
  if (!monthlyIncome) missing.push("the co-applicant's income");
  if (!loanAmount) missing.push("the loan amount");

  const existingEmi = Number(co.existingEmiMonthly) > 0 ? Number(co.existingEmiMonthly) : 0;
  // Not in `missing`: a caller with no loans is a real, common answer, and
  // treating it as a gap would leave clean files permanently "incomplete".
  const existingEmiKnown = co.existingEmiMonthly !== null && co.existingEmiMonthly !== undefined && co.existingEmiMonthly !== "";

  if (missing.length) {
    return { ready: false, missing, monthlyIncome, incomeBasis, loanAmount, existingEmi, existingEmiKnown };
  }

  const proposedEmi = Math.round(loanAmount / (AVG_TENURE_YEARS * 12));
  const foirExisting = Math.round((existingEmi / monthlyIncome) * 1000) / 10;
  const foirUpdated = Math.round(((existingEmi + proposedEmi) / monthlyIncome) * 1000) / 10;
  const band = bandFor(foirUpdated);

  return {
    ready: true,
    missing: [],
    monthlyIncome,
    incomeBasis,
    loanAmount,
    amountBasis,
    existingEmi,
    existingEmiKnown,
    tenureYears: AVG_TENURE_YEARS,
    proposedEmi,
    foirExisting,
    foirUpdated,
    lender: band.lender,
    lenderNote: band.note,
    rateBand: RATE_BANDS[loan.type === "secured" ? "secured" : "unsecured"],
    // Said out loud wherever this is shown. principal ÷ 120 with no interest is
    // not an EMI anyone will actually pay, and the gap grows with the amount.
    basis: `Indicative only: ${AVG_TENURE_YEARS}-year average tenure, principal ÷ ${AVG_TENURE_YEARS * 12}, interest not included.`,
  };
}

// ── Flags ───────────────────────────────────────────────────────────────────
// The flowchart's "flag as threat" boxes. Every rule fires only on evidence:
// an unknown field raises nothing, because a screen full of warnings generated
// by absent data is a screen an officer learns to ignore.
//
// severity: "threat" — the flowchart's own word, needs a human decision.
//           "watch"  — worth knowing, not disqualifying.

export function deriveFlags(profile = {}, underwriting = null) {
  const flags = [];
  const a = profile.applicant || {};
  const co = profile.coApplicant || {};
  const inst = profile.institute || {};
  const uw = underwriting || computeUnderwriting(profile);

  const add = (code, severity, branch, message) => flags.push({ code, severity, branch, message });

  // "Fetch age from aadhaar - 12th std age 17-18y/o - if student is having gap
  // year and age is 19-20-21 flag as threat"
  if (a.age > SCHOOL_LEAVING_AGE_MAX && a.currentQualification === "12th") {
    add("age_vs_qualification", "threat", "applicant",
      `Age ${a.age} against a 12th-standard qualification — expected 17–18. Ask what the years since school were spent on.`);
  }
  if (a.gapYears > 0) {
    add("gap_year", "watch", "applicant",
      `${a.gapYears} year${a.gapYears === 1 ? "" : "s"} of gap declared. Lenders ask what it was spent on.`);
  }

  // "Check if city of residence by student is same as aadhaar address - else
  // flag as threat (Ask in conversation) - flag if does not match"
  if (a.city && a.aadhaarCity && a.city.trim().toLowerCase() !== a.aadhaarCity.trim().toLowerCase()) {
    add("address_mismatch", "threat", "applicant",
      `Lives in ${a.city} but the Aadhaar address is in ${a.aadhaarCity}. Current-address proof will be needed.`);
  }

  if (a.marksPercent !== null && a.marksPercent !== undefined && a.marksPercent < MIN_ACADEMIC_PERCENT) {
    add("marks_below_minimum", "threat", "applicant",
      `${a.marksPercent}% is below the ${MIN_ACADEMIC_PERCENT}% most lenders treat as a floor.`);
  }

  // "Check CIBIL with DIGITAP API if exists - FLAG if exists and below 650 (NTC
  // is good to go)". Absence is explicitly fine, so only a real low score flags.
  for (const [who, score] of [["applicant", a.cibilScore], ["coApplicant", co.cibilScore]]) {
    if (score > 0 && score < MIN_CIBIL) {
      add("cibil_below_650", "threat", who, `CIBIL ${score} — below ${MIN_CIBIL}.`);
    }
  }

  // "should be directly related to student ... no cousin of student applicant etc."
  if (co.relation && !PERMITTED_RELATIONS.includes(co.relation)) {
    add("relation_not_permitted", "threat", "coApplicant",
      `Co-applicant is "${co.relation}". Lenders require immediate family — father, mother, brother, sister or spouse.`);
  }

  // "check for ITR availability of last 3 years - if not then 2 years are needed minimum"
  //
  // Gated on the category, and that gate is not cosmetic. A caller saying "three
  // years of Form 16" has been observed landing in BOTH year fields, and an ITR
  // count that leaks onto a salaried file would raise a threat about a document
  // that file is never going to be asked for. A flag nobody can act on is worse
  // than no flag: it is the one that teaches an officer to skim the list.
  const itrApplies = !co.category || ["self-employed", "farmer"].includes(co.category);
  const form16Applies = !co.category || co.category === "salaried";
  if (itrApplies && co.itrYearsAvailable !== null && co.itrYearsAvailable !== undefined && co.itrYearsAvailable < MIN_INCOME_PROOF_YEARS) {
    add("itr_years_short", "threat", "coApplicant",
      `Only ${co.itrYearsAvailable} year(s) of ITR — ${MIN_INCOME_PROOF_YEARS} is the minimum, 3 is what is asked for.`);
  }
  if (form16Applies && co.form16YearsAvailable !== null && co.form16YearsAvailable !== undefined && co.form16YearsAvailable < MIN_INCOME_PROOF_YEARS) {
    add("form16_years_short", "threat", "coApplicant",
      `Only ${co.form16YearsAvailable} year(s) of Form 16 — ${MIN_INCOME_PROOF_YEARS} is the minimum.`);
  }

  // "ask if they are gurantor etc on any other loan" — a guarantee is a
  // contingent liability the FOIR above does not see.
  if (co.guarantorElsewhere === true) {
    add("guarantor_elsewhere", "watch", "coApplicant",
      "Stands guarantor on another loan. That liability is not in the FOIR above.");
  }

  if (co.livesAtKycAddress === false) {
    add("coapplicant_address_mismatch", "watch", "coApplicant",
      "Does not live at their KYC address — a light or gas bill for the current address will be needed.");
  }

  // "Hostel fee inclusive or exclusive in the fee structure (inclusive consider
  // as tuition fee, exclusive consider as personal expense)"
  if (inst.hostelFeeIncluded === false) {
    add("hostel_fee_excluded", "watch", "institute",
      "Hostel and living costs sit outside the quoted fee — a personal expense, not part of what is lent on.");
  }
  if (inst.offerLetter && inst.offerLetter !== "received") {
    add("no_offer_letter", "watch", "institute",
      `Offer letter: ${inst.offerLetter}. Most lenders will not sanction without it.`);
  }
  // The online cross-check (instituteVerify.js). "not_found" is the only
  // status that flags: the results actively failed to support the claim.
  // "unclear" — a thin search, a rate limit, a niche course — raises nothing,
  // because a failed search is our evidence problem, not the caller's honesty
  // problem. The verdict lives under an underscore key so the agent's prompt
  // never sees it: this flag is for the officer, never for accusing a caller.
  const ver = profile._verification || {};
  if (ver.status === "not_found") {
    add("course_not_found", "threat", "institute",
      `"${inst.name || "the institute"}${inst.course ? ` — ${inst.course}` : ""}" could not be identified online${ver.note ? `: ${ver.note}` : "."} Ask for the offer letter and verify before proceeding.`);
  }

  // "check for fee online on institute or trusted website (Major deviation to
  // be flagged)". Live now: instituteVerify.js fills feeVerifiedOnline when a
  // search snippet publishes the programme fee.
  if (inst.totalFee > 0 && inst.feeVerifiedOnline > 0) {
    const deviation = Math.abs(inst.totalFee - inst.feeVerifiedOnline) / inst.feeVerifiedOnline;
    if (deviation > 0.25) {
      add("fee_deviation", "threat", "institute",
        `Quoted ₹${inst.totalFee.toLocaleString("en-IN")} against ₹${inst.feeVerifiedOnline.toLocaleString("en-IN")} published — ${Math.round(deviation * 100)}% apart.`);
    }
  }

  if (uw.ready && uw.foirUpdated >= 80) {
    add("foir_high", "threat", "underwriting",
      `FOIR lands at ${uw.foirUpdated}% with this loan. Above 80% only the most accommodating lender will look at it.`);
  }

  return flags;
}

/** Everything derived, in one call — what the relay stores and the dashboard shows. */
export function deriveAll(profile = {}) {
  const underwriting = computeUnderwriting(profile);
  return { underwriting, flags: deriveFlags(profile, underwriting) };
}
