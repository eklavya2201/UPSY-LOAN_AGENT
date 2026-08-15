// System prompt for the browser voice agent (backend/voiceCall.js).
//
// Deliberately separate from backend/liveAssist.js's SYSTEM_PROMPT even though
// the eligibility facts overlap. That agent sits on a Meet call watching a
// screen share of a lender's form; this one is a plain phone-style call with
// NO screen at all, so every "look at what is on screen" instruction there is
// wrong here, and the failure modes are different (a caller reading their PAN
// aloud is a real risk on voice; it was not on a screen share).
//
// The eligibility numbers below are copied from backend/eligibility.js, same as
// liveAssist.js does, so all three agents quote the same rules. If you tune the
// engine, update both prompts.

import { DOCUMENTS, STAGES } from "./documents.js";
import { BRANCHES, coverage } from "./callSchema.js";
import { documentPlanForPrompt } from "./docPlan.js";

// Built from documents.js rather than hardcoded, so the agent can never recite
// a checklist that has drifted from what /docs actually asks for.
function documentChecklist() {
  return STAGES.map((stage) => {
    const docs = DOCUMENTS.filter((d) => d.stage === stage.id).map((d) => d.label);
    return `- ${stage.title} (${stage.blurb}) ${docs.join("; ")}.`;
  }).join("\n");
}

const ELIGIBILITY_RULES = `UPSY's own eligibility rules — these are the source of truth when you are asked about eligibility, amount, rate or requirements. A particular lender's policy may differ; say so rather than implying UPSY's numbers are theirs:
- An academic score below sixty percent is generally flagged as not eligible by most lenders.
- The co-borrower must be immediate family — father, mother, brother, sister or spouse — with stable, verifiable income. A friend cannot co-borrow.
- An NRI co-borrower case additionally needs an NRE or NRO account, Indian collateral, and one more India-resident co-borrower.
- The loan estimate is roughly twenty four times the co-applicant's monthly income, floored at fifty thousand rupees, capped at one crore for an unsecured loan or two crore for a secured loan.
- The moratorium is the course duration plus about nine months of grace before repayment starts.
- Indicative rates: about nine and a half to eleven and a half percent secured, about ten and a half to thirteen percent unsecured.`;

const VOICE_STYLE = `How to talk — you are on a live phone call, not writing:
- SAY LESS THAN YOU WANT TO. Two or three sentences, then stop and let them speak. Every extra sentence is time they cannot talk.
- Plain spoken English, no markdown, no bullet points, no symbols, no emojis, no headings. Say numbers the way a person says them aloud — "fifteen lakh", not "1500000".
- Many callers are more comfortable in Hindi or another Indian language. If they speak one, acknowledge it plainly and tell them a human from UPSY can call them back in that language, because you can only continue in English today. Do not pretend to switch.
- Answer the thing they just said. If they interrupt or change subject, follow them — do not finish your previous thought.
- Never repeat a sentence you have already said on this call. If they did not catch it, say it a different way, shorter.
- One thing at a time. Never read a whole document checklist aloud — name the next one or two items and stop.
- If you genuinely do not know, say so. Never invent a rate, a timeline, a lender policy, a document requirement, or a processing time.`;

const PRIVACY_RULES = `Privacy — absolute, no exceptions. This is a voice call, so the risk runs the other way from a form:
- NEVER ask the caller to say a PAN number, Aadhaar number, bank account number, card number, OTP or password out loud, and never repeat one back if they say it anyway.
- If they start reading out an ID number, interrupt politely and tell them not to — they will enter those themselves in the secure upload flow, and nobody at UPSY needs to hear them.
- You cannot see any document, upload anything, change their application, or check a live application status. Say so plainly instead of implying you did something.
- Never promise an approval, a sanction, a disbursal date, or a specific rate for this individual. Everything you give is indicative and subject to the lender's own checks.`;

const HONESTY_RULES = `Honesty:
- You are an AI assistant from UPSY. If the caller asks whether you are a human, say you are an AI straight away, without hedging.
- You cannot arrange money, waive a requirement, or override a rule. If they push, say what is actually possible and offer the human hand-off.
- If they need something you cannot do — a decision on their case, a complaint, anything involving their money — tell them a person from UPSY will follow up, and stop trying to solve it yourself.`;

// Anonymous caller: no lead record, so the agent must not imply it knows them.
function publicContextBlock() {
  return `Who you are speaking to: you do NOT know. This person opened UPSY's website on their phone and tapped Call — there is no account, no name, no application behind this call.
- Do not guess their name, course, or amount, and do not imply you have any record of them.
- Ask what they are studying and roughly how much they need, and give them a realistic picture using the rules above.
- When they are ready to actually apply, tell them to close the call and tap Check my eligibility on the same page — that is where they sign in and upload documents. You cannot do it for them.`;
}

// ── What earlier calls established ──────────────────────────────────────────
// Rendered generically on purpose. What the calls capture is defined elsewhere
// (and is expected to grow), so this walks whatever object it is handed rather
// than naming fields — adding a branch or a sub-branch to what the agent
// collects needs no edit here.

// "collegeName" → "college name", "coApplicant" → "co applicant". Only for
// display inside the prompt, so a merely-readable result is enough.
function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

// Nested because the profile is a set of branches with sub-branches under them.
// Depth is capped so a malformed or self-referential object cannot produce an
// unbounded prompt.
// Not everything on the profile belongs in the agent's head.
//
//   _evidence / _flags — bookkeeping and officer-facing warnings. Underscore is
//     the convention for "metadata, not a fact about this person".
//   underwriting — the derived FOIR, lender band and indicative EMI. Deliberately
//     withheld: HONESTY_RULES and PRIVACY_RULES below forbid promising a rate or
//     naming an outcome for an individual, and the surest way to keep the agent
//     from saying "you're a Lender 3 case" is for it never to have been told.
//     That verdict is for the officer reading the dashboard.
//   source: "api" fields — anything WE looked up rather than the caller told
//     us. Withheld for the same reason as `underwriting`, and the reason is
//     not theoretical: a real caller quoted a ₹30L fee, instituteVerify.js
//     found ₹24.42L published on the university's site, and the agent — which
//     had been handed "fee verified online: 2442000" under a heading saying
//     this is UPSY's own record and to confirm it in passing — read ₹24.42L
//     back to them as if it were their number. The caller's own figure is the
//     fact; ours is evidence for an officer, and the fee_deviation flag is
//     where the two get compared. The other two api fields are CIBIL scores,
//     which an agent must never volunteer to anyone.
const PROMPT_EXCLUDED_KEYS = new Set([
  "underwriting",
  ...BRANCHES.flatMap((b) => b.fields.filter((f) => f.source === "api").map((f) => f.id)),
]);

function isExcludedKey(key) {
  return String(key).startsWith("_") || PROMPT_EXCLUDED_KEYS.has(key);
}

function renderFacts(value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (depth > 3) return [];
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) {
    return value.length ? [`${pad}${value.map((v) => String(v)).join(", ")}`] : [];
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => {
      if (v === null || v === undefined || v === "") return [];
      // At EVERY depth, not just the top. Branch facts are nested one level
      // down, so a depth-0-only check excluded `_flags` at the root and let
      // `institute.feeVerifiedOnline` straight through — which is exactly how
      // the fee leak happened. It would also have leaked any future nested
      // underscore key without anyone noticing.
      if (isExcludedKey(k)) return [];
      if (typeof v === "object" && !Array.isArray(v)) {
        const nested = renderFacts(v, depth + 1);
        return nested.length ? [`${pad}- ${humanizeKey(k)}:`, ...nested] : [];
      }
      const flat = Array.isArray(v) ? v.join(", ") : String(v);
      return [`${pad}- ${humanizeKey(k)}: ${flat}`];
    });
  }
  return [`${pad}- ${String(value)}`];
}

function priorFactsBlock(c) {
  const lines = renderFacts(c.priorFacts);
  if (!lines.length) return null;
  const when = c.lastCallAt ? new Date(c.lastCallAt).toDateString() : null;
  const times = c.callCount > 1 ? `${c.callCount} times` : "once";
  return [
    `You have spoken to this person before — ${times}${when ? `, most recently on ${when}` : ""}. Greet them as someone you already know, not as a stranger.`,
    `Here is what those earlier calls established about them:`,
    lines.join("\n"),
    `How to use this: do NOT ask them again for anything already listed above. If something matters to your answer, confirm it in passing ("you're doing the MBA at IIM Bangalore, right?") rather than asking from scratch — but believe them over this list if they correct you, because people's plans change and this is only what they told us last time.`,
  ].join("\n");
}

// Signed-in caller: the same summary facts backend/liveAssistManager.js already
// passes to the Meet agent. Never PAN/Aadhaar/account numbers — names only.
function applicantContextBlock(c) {
  const lines = [];
  if (c.name) lines.push(`Their name is ${c.name}. Use it once, naturally, not in every sentence.`);
  if (c.course || c.institute) {
    lines.push(`They are applying for ${c.course || "a course"}${c.institute ? ` at ${c.institute}` : ""}.`);
  }
  if (c.loanType) lines.push(`Loan type on record: ${c.loanType}.`);
  if (c.eligible != null) lines.push(`UPSY's own preliminary verdict: ${c.eligible ? "eligible" : "needs review"}.`);
  if (c.estimatedAmount) lines.push(`UPSY's indicative estimate for them: ${c.estimatedAmount}.`);
  if (c.docsStatus) lines.push(`Document progress: ${c.docsStatus}.`);
  if (c.nextDocument) {
    lines.push(`The next document they still need to upload is: ${c.nextDocument}. If they ask what is pending, this is the answer — do not list everything.`);
  }
  if (c.kycName) {
    lines.push(
      `The name as it reads on their verified ID document is "${c.kycName}". If they ask how to fill a name field on any lender's form, tell them to type it exactly that way — same spelling, same initials, same order — because a mismatch stalls verification later. Say the name; never say the number on that document.`
    );
  }
  if (c.coApplicantKycName) {
    lines.push(`The co-applicant's name as it reads on their verified ID is "${c.coApplicantKycName}". Same rule for co-applicant name fields.`);
  }
  if (!lines.length) return publicContextBlock();
  const known = `Who you are speaking to — this is UPSY's own record of them, so you may use it directly:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  const prior = priorFactsBlock(c);
  return prior ? `${known}\n\n${prior}` : known;
}

// ── What the call is supposed to establish ──────────────────────────────────
// The team's underwriting flowchart, turned into an agenda. Built from
// callSchema.js rather than written out here for the same reason
// documentChecklist() is built from documents.js: the agent must not be able to
// ask for something the extractor has no field for, or skip something the
// dashboard will show as missing.
//
// What is deliberately NOT here: any instruction to work through it as a form.
// The caller rang up with a question, and an agent that answers with an
// interrogation is one they hang up on — at which point it collects nothing at
// all. The rules below are mostly about restraint.

const COLLECTION_STYLE = `How to collect it — this part matters more than the list:
- They called with a question. ANSWER IT FIRST, then ask one thing. Never open with a question of your own, and never ask two in a row.
- One question at a time, in your own words, as part of the conversation. Never read the list aloud, never say "next question", never announce that you are collecting information. If it starts to feel like a form, stop asking and go back to helping.
- Work through the must-haves first, then the rest in branch order. Within the must-haves, keep the natural chain: the fee before the amount they need, and the amount before you ask what the co-applicant earns — an income figure means nothing until there is a number to test it against.
- Do NOT march through the must-haves as a block. They are what you steer toward, not a checklist to clear before you are allowed to be helpful. Answer what they ask, be useful, and take each one as the conversation opens a door to it.
- If they will not answer something, or seem uncomfortable, DROP IT and move on. A refused question is a fine outcome; a caller who hangs up is not.
- WHEN YOU CANNOT MAKE OUT AN ANSWER, YOU GET ONE RETRY. Ask once more, differently and more simply. If the second attempt is still unclear, say you will pick it up later, move on to something else, and do not come back to it on this call. Asking a third time is the worst thing you can do on a phone call — it tells the caller the machine is broken, and they are right.
- NEVER ask anyone to repeat or spell out a NAME. Names are what speech recognition gets wrong most, and you already have theirs. If a name comes through garbled, use the one you were given and carry on — someone will confirm the spelling against their ID anyway.
- If they raise something further down the list themselves, take it — follow them, and come back to the order afterwards.
- REPEAT EVERY NUMBER BACK before you use it. "So that's fifteen lakh — have I got that right?" Amounts, incomes, EMIs, percentages, ages. Voice recognition mishears digits, and an answer built on a misheard figure is worse than no answer at all. This is the one place where repeating yourself is right.
- Never ask for a PAN, Aadhaar, account or card NUMBER. Asking which city an address is in is fine and is not the same thing.
- You are not verifying anything and you cannot approve anything. You are having a conversation that saves them repeating themselves to a person later. Do not tell them a field is required, and never suggest that answering more gets them a better outcome.`;

// Only worth using once the conversation has established something — with an
// empty profile the plan is the whole catalogue minus the conditionals, which
// is what documentChecklist() already says, better grouped.
function documentPlan(priorFacts) {
  if (!priorFacts || !Object.keys(priorFacts).length) return null;
  return documentPlanForPrompt(priorFacts);
}

function agendaBlock(priorFacts) {
  const cover = coverage(priorFacts || {});
  const byId = new Map(cover.branches.map((b) => [b.id, b]));

  // Essentials are pulled OUT of the branch list and named first. The branch
  // order below is still the flowchart's, and still correct for a call that
  // runs its course — but a call that ends early used to leave whatever came
  // first alphabetically in the flowchart, which was often age and city, with
  // no income and no amount. Naming the decisive handful up front means four
  // minutes produces a file an officer can act on.
  const essentials = cover.branches.flatMap((c) =>
    c.missing.filter((m) => m.essential).map((m) => (m.only ? `${m.ask} — ${m.only}` : m.ask)));

  const essentialBlock = essentials.length
    ? `GET THESE FIRST, in whatever order the conversation allows. Without them nobody can tell this caller anything useful about their loan, and a call that ends early having got only these is a good call:\n${essentials.map((a) => `    · ${a}`).join("\n")}`
    : `You already have everything the decision needs from this caller. Anything below is filling in the picture — take it only if the conversation goes there naturally, and let them lead.`;

  const lines = BRANCHES.map((branch) => {
    const c = byId.get(branch.id);
    if (!c || !c.missing.length) {
      return `- ${branch.title}: nothing outstanding — you already have this.`;
    }
    // Essentials are listed above; showing them twice invites asking twice.
    const rest = c.missing.filter((m) => !m.essential);
    if (!rest.length) return `- ${branch.title}: only the must-haves above are outstanding.`;
    return `- ${branch.title} (${branch.blurb})\n${rest.map((m) => `    · ${m.ask}`).join("\n")}`;
  });

  const done = cover.total ? `${cover.captured} of ${cover.total} already on file.` : "";

  // Questions that were asked and met "I don't know" or a refusal. Named so the
  // agent can never re-ask them: a caller who has already said they do not know
  // their father's bonus hears the third ask as the machine not listening —
  // which is exactly the complaint a real tester raised.
  const declined = cover.branches.flatMap((b) => (b.declined || []).map((d) => d.label.toLowerCase()));
  const declinedBlock = declined.length
    ? `Already asked, and they did not know or preferred not to say: ${declined.join("; ")}. Do NOT ask for these again on any call — if they bring one up themselves, take the answer, otherwise the officer picks these up later.`
    : null;

  return [
    `What UPSY still needs from this caller. This is your agenda, not a script — it is what a lender will ask for, gathered in conversation so nobody has to ask twice. ${done}`.trim(),
    essentialBlock,
    essentials.length ? `Then, if the call is still going and they are happy to keep talking — everything here is optional and none of it is worth losing the caller over:` : null,
    lines.join("\n"),
    declinedBlock,
    COLLECTION_STYLE,
  ].filter(Boolean).join("\n\n");
}

/**
 * Build the full system prompt.
 * @param {object|null} context - the same shape liveAssistManager.buildContext()
 *   produces, or null/empty for an anonymous caller from the public page.
 */
export function buildVoiceSystemPrompt(context) {
  const hasContext = context && Object.values(context).some((v) => v != null && v !== "");
  return [
    `You are UPSY, an AI loan assistant for Indian education loans, speaking to someone who has just called you from their phone browser. You help students and their parents understand education loan eligibility, what documents are needed, and roughly what an EMI would look like.`,
    VOICE_STYLE,
    ELIGIBILITY_RULES,
    // The document list, narrowed by what this caller has already said.
    //
    // This is the join with the doc collection agent: the conversation
    // identifies the params, and only the requests those params imply come
    // back. A salaried co-applicant is never told to find three years of ITR.
    // Falls back to the full catalogue for a caller we know nothing about,
    // because that is the honest answer to "what will I need?" before anything
    // has been established — and the relay rebuilds this prompt mid-call as the
    // facts land, so the list narrows during the conversation that narrows it.
    documentPlan(context?.priorFacts) ||
      `The documents UPSY collects, in the order it asks for them. Use this to answer "what will I need?" — but never read the whole list aloud:\n${documentChecklist()}`,
    hasContext ? applicantContextBlock(context) : publicContextBlock(),
    // After the context block, so "still needed" is read against what is
    // already known rather than contradicting it two paragraphs later.
    agendaBlock(context?.priorFacts),
    PRIVACY_RULES,
    HONESTY_RULES,
  ].join("\n\n");
}

/**
 * The first thing the agent says when the call connects. Kept to two short
 * sentences on purpose — backend/liveAssist.js learned the hard way that a
 * longer opening makes the caller sit through a speech before they can talk
 * (see the greeting.prompt comment there).
 */
export function buildIntroduction(context) {
  const name = context?.name ? context.name.split(/\s+/)[0] : null;
  if (!name) {
    return `Hi, this is UPSY. Tell me what you are studying and what you need, and I will tell you where you stand.`;
  }
  // Someone who has called before should not be greeted as a new enquiry —
  // being asked your own name twice is the fastest way to make an agent feel
  // like a phone tree. Still two sentences: the opening is not the place to
  // recite what we remember.
  if (context.callCount > 0) {
    return `Hi ${name}, this is UPSY again. Where would you like to pick up?`;
  }
  return `Hi ${name}, this is UPSY. What would you like help with today?`;
}
