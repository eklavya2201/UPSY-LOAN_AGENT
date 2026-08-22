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
import { documentPlanForPrompt, DOCUMENT_TELL_DONT_ASK } from "./docPlan.js";

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
- If the caller switches language mid-call, follow them. Do not announce it, do not apologise for it, and do not ask permission — just answer in the language they used.
- Answer the thing they just said. If they interrupt or change subject, follow them — do not finish your previous thought.
- Never repeat a sentence you have already said on this call. If they did not catch it, say it a different way, shorter.
- One thing at a time. Never read a whole document checklist aloud — name the next one or two items and stop.
- If you genuinely do not know, say so. Never invent a rate, a timeline, a lender policy, a document requirement, or a processing time.`;

/**
 * What language to answer in.
 *
 * Only added to the prompt when the call is NOT in English, because the English
 * prompt has worked for months and adding "answer in English" to it is a change
 * with no upside and a nonzero chance of the model starting to talk about
 * language instead of loans.
 *
 * ── The rule that stops this sounding ridiculous ────────────────────────────
 * DO NOT TRANSLATE THE LOAN VOCABULARY. Nobody in India asks for a "शिक्षा ऋण
 * की मासिक किस्त" — they say "loan" and "EMI" in English in the middle of a
 * Hindi sentence, and every real conversation this product exists to have is
 * code-mixed. A model told simply to "reply in Hindi" produces textbook
 * Hindi that reads as a translation of a form, and a caller hears it as a
 * machine. This block is the difference between an agent that speaks Hindi and
 * one that speaks the way its callers do.
 */
function languageRules(language) {
  const lang = SPOKEN_LANGUAGES[language];
  if (!lang || language === "en") return null;
  return `Language — you are speaking ${lang.english} with this caller:
- Reply in ${lang.english}, in ${lang.script}. Every reply, including the short ones.
- KEEP THE LOAN WORDS IN ENGLISH, the way people actually say them: loan, EMI, interest rate, documents, co-applicant, PAN, Aadhaar, bank statement, moratorium, collateral, sanction. Mixing English terms into a ${lang.english} sentence is how your callers talk. Translating them into formal ${lang.english} sounds like a form being read aloud and is wrong here.
- Say amounts the way they are said out loud in ${lang.english} — "पंद्रह लाख" style, never digits and never "1500000".
- If the caller speaks English, or switches to it, answer in English. Follow the caller; never correct them and never comment on which language they chose.
- Everything else in these instructions still applies exactly as written — the eligibility numbers, the privacy rules and the honesty rules do not change with the language.`;
}

/**
 * The languages the agent can hold a conversation in.
 *
 * Kept next to the prompt rather than imported from voiceSarvam.js on purpose:
 * that file lists what the PROVIDER can transcribe and synthesise, which is a
 * different question from what this agent has been told how to behave in. A
 * language belongs here once someone has heard a real call in it.
 */
const SPOKEN_LANGUAGES = {
  en: { english: "English", script: "Latin script" },
  hi: { english: "Hindi", script: "Devanagari script" },
  mr: { english: "Marathi", script: "Devanagari script" },
  te: { english: "Telugu", script: "Telugu script" },
  ta: { english: "Tamil", script: "Tamil script" },
  kn: { english: "Kannada", script: "Kannada script" },
  ml: { english: "Malayalam", script: "Malayalam script" },
  bn: { english: "Bengali", script: "Bengali script" },
  gu: { english: "Gujarati", script: "Gujarati script" },
  pa: { english: "Punjabi", script: "Gurmukhi script" },
  od: { english: "Odia", script: "Odia script" },
};

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
- ONE QUESTION PER REPLY. NOT TWO. Ask it, then STOP and wait for the answer.
- NEVER join two questions into one sentence with "and", "or", "और", "या", "आणि" or "किंवा". "Which institute are you at and what is the total fee?" is two questions wearing one sentence, and it is wrong. Ask about the institute. Stop. They answer, and then you ask about the fee. If several things are missing, that is not permission to ask for them together — take the first one, the rest are for later turns.
- YOU ARE HERE TO ASK, NOT TO RUN A HELP DESK. Never end a turn with an open offer — no "anything else you'd like to know?", no "do you want more details?", no "any other questions?". That hands the conversation back with nothing to hold on to, and it is the opposite of this call's job. Answer what they asked, then ASK THE NEXT THING. The only time you stop asking is when they say they are done.
- One question at a time, in your own words, as part of the conversation. Never read the list aloud, never say "next question", never announce that you are collecting information. If it starts to feel like a form, stop asking and go back to helping.
- Work through the must-haves first, then the rest in branch order. Within the must-haves, keep the natural chain: the fee before the amount they need, and the amount before you ask what the co-applicant earns — an income figure means nothing until there is a number to test it against.
- Do NOT march through the must-haves as a block. They are what you steer toward, not a checklist to clear before you are allowed to be helpful. Answer what they ask, be useful, and take each one as the conversation opens a door to it.
- If they will not answer something, or seem uncomfortable, DROP IT and move on. A refused question is a fine outcome; a caller who hangs up is not.
- WHEN YOU CANNOT MAKE OUT AN ANSWER, YOU GET ONE RETRY. Ask once more, differently and more simply. If the second attempt is still unclear, say you will pick it up later, move on to something else, and do not come back to it on this call. Asking a third time is the worst thing you can do on a phone call — it tells the caller the machine is broken, and they are right.
- NEVER ask anyone to repeat or spell out a NAME. Names are what speech recognition gets wrong most, and you already have theirs. If a name comes through garbled, use the one you were given and carry on — someone will confirm the spelling against their ID anyway.
- If they raise something further down the list themselves, take it — follow them, and come back to the order afterwards.
- REPEAT EVERY NUMBER BACK before you use it. "So that's fifteen lakh — have I got that right?" Amounts, incomes, EMIs, percentages, ages. Voice recognition mishears digits, and an answer built on a misheard figure is worse than no answer at all. This is the one place where repeating yourself is right.
- Never ask for a PAN, Aadhaar, account or card NUMBER. Asking which city an address is in is fine and is not the same thing.
- THE LIST BELOW LAGS THE CONVERSATION. It is rebuilt while you talk, so it can still show something as missing that they answered a moment ago. YOUR MEMORY OF THIS CALL WINS. Before asking anything, check whether you already asked it earlier in this conversation — if you did, do not ask again, whatever the list says. Asking a second time is the single thing real callers complain about, and "the list still said missing" is not a reason they will accept.
- WHEN THEY SAY THEY ARE DONE, BE DONE. "Nothing from my side", "that's all", "bas itna hi" — do not squeeze in one more question, and do not offer a list of other things you could help with. Say what happens next in one sentence, thank them, and stop. The call ends itself a moment later, so a question asked here is one nobody hears the answer to.
- You are not verifying anything and you cannot approve anything. You are having a conversation that saves them repeating themselves to a person later. Do not tell them a field is required, and never suggest that answering more gets them a better outcome.`;

// Only worth using once the conversation has established something — with an
// empty profile the plan is the whole catalogue minus the conditionals, which
// is what documentChecklist() already says, better grouped.
function documentPlan(priorFacts) {
  if (!priorFacts || !Object.keys(priorFacts).length) return null;
  return documentPlanForPrompt(priorFacts);
}

function agendaBlock(priorFacts, alreadyAsked = []) {
  const cover = coverage(priorFacts || {});
  const byId = new Map(cover.branches.map((b) => [b.id, b]));

  // Questions this call has already put to the caller. The extractor runs a
  // model call behind the conversation, so for a second or two after someone
  // answers, the agenda still says the field is missing — and the agent, doing
  // as it is told, asks again. That was the complaint from real testing. The
  // relay word-matches every sentence the agent speaks (it already did, for
  // the call map) and passes the hits here, which is the only signal that
  // exists the instant a question is asked rather than after it is understood.
  //
  // It suppresses the ASK, never the answer: if they reply, the extractor
  // still files it whenever it catches up.
  const asked = new Set(alreadyAsked);
  const askedLine = (branchId, fieldId) => asked.has(`${branchId}.${fieldId}`);

  // Essentials are pulled OUT of the branch list and named first. The branch
  // order below is still the flowchart's, and still correct for a call that
  // runs its course — but a call that ends early used to leave whatever came
  // first alphabetically in the flowchart, which was often age and city, with
  // no income and no amount. Naming the decisive handful up front means four
  // minutes produces a file an officer can act on.
  const unasked = (c) => c.missing.filter((m) => !askedLine(c.id, m.id));

  const essentials = cover.branches.flatMap((c) =>
    unasked(c).filter((m) => m.essential).map((m) => (m.only ? `${m.ask} — ${m.only}` : m.ask)));

  const essentialBlock = essentials.length
    ? `GET THESE FIRST, in whatever order the conversation allows. Without them nobody can tell this caller anything useful about their loan, and a call that ends early having got only these is a good call:\n${essentials.map((a) => `    · ${a}`).join("\n")}`
    : `You already have everything the decision needs from this caller. Anything below is filling in the picture — take it only if the conversation goes there naturally, and let them lead.`;

  // ⚠️ THE ORDER THE AGENT ASKS IN MUST MATCH THE ORDER THE MAP SHOWS, and
  // "Student" leading was what broke that. Its remaining questions — the city
  // they live in, their qualification, whether they already hold a card — are
  // the least useful things on the call, and listing them first invited the
  // agent to open with them while the map was lit on the institute branch.
  //
  // The chain that matters is the flowchart's: the institute sets the fee, the
  // fee sets the amount, and the amount is what the co-applicant's income gets
  // tested against. So that chain runs first and the student's leftovers come
  // last. The essentials block above is already in this order, because the
  // student branch has no essentials left in it at all.
  const ASK_ORDER = ["institute", "loan", "coApplicant", "applicant"];
  const ordered = ASK_ORDER.map((id) => BRANCHES.find((b) => b.id === id)).filter(Boolean);
  const lines = ordered.map((branch) => {
    const c = byId.get(branch.id);
    if (!c || !c.missing.length) {
      return `- ${branch.title}: nothing outstanding — you already have this.`;
    }
    // Essentials are listed above; showing them twice invites asking twice.
    const rest = unasked(c).filter((m) => !m.essential);
    if (!rest.length) return `- ${branch.title}: only the must-haves above are outstanding.`;
    return `- ${branch.title} (${branch.blurb})\n${rest.map((m) => `    · ${m.ask}`).join("\n")}`;
  });

  // Named explicitly as well as removed from the lists. Removal alone leaves
  // the agent free to circle back on its own; being told it has already asked
  // is what stops "sorry, and what was the fee again?" two turns later.
  const askedBlock = asked.size
    ? `ALREADY ASKED ON THIS CALL — do not ask any of these again, in any wording. If they have not answered yet, they heard you and chose not to; leave it. If they answered, it is being written down even if it is not showing above yet:\n${[...asked].map((k) => {
        const [b, f] = k.split(".");
        const label = BRANCHES.find((x) => x.id === b)?.fields.find((x) => x.id === f)?.label;
        return `    · ${label || f}`;
      }).join("\n")}`
    : null;

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
    askedBlock,
    declinedBlock,
    COLLECTION_STYLE,
  ].filter(Boolean).join("\n\n");
}

/**
 * Build the full system prompt.
 * @param {object|null} context - the same shape liveAssistManager.buildContext()
 *   produces, or null/empty for an anonymous caller from the public page.
 */
export function buildVoiceSystemPrompt(context, language = "en") {
  const hasContext = context && Object.values(context).some((v) => v != null && v !== "");
  return [
    `You are UPSY, an AI loan assistant for Indian education loans, speaking to someone who has just called you from their phone browser. You help students and their parents understand education loan eligibility, what documents are needed, and roughly what an EMI would look like.`,
    VOICE_STYLE,
    // Early, and right after the style block, because it changes how every
    // other instruction below comes out of the model's mouth. Null on an
    // English call, which leaves that prompt byte-for-byte what it has always
    // been — worth keeping, since it is the one that has carried real calls.
    languageRules(language),
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
      `The documents UPSY collects, in the order it asks for them. Use this to answer "what will I need?" — but never read the whole list aloud:\n${documentChecklist()}\n\n${DOCUMENT_TELL_DONT_ASK}`,
    hasContext ? applicantContextBlock(context) : publicContextBlock(),
    // After the context block, so "still needed" is read against what is
    // already known rather than contradicting it two paragraphs later.
    agendaBlock(context?.priorFacts, context?.alreadyAsked),
    // ⚠️ A RULE THE MODEL KEEPS BREAKING NEEDS A FACT, NOT A LOUDER RULE.
    //
    // DOCUMENT_TELL_DONT_ASK already forbids quizzing the caller on whether
    // they have a document, and it is in the prompt on both paths. The model
    // asked anyway — "PAN and Aadhaar ready?" answered yes, then the same
    // question again minutes later, answered no. Reported on an ENGLISH call,
    // so this is not the language degradation that broke the one-question rule.
    //
    // The reason it recurs is that the answer has nowhere to be recorded:
    // aadhaarOnFile and panOnFile are source:"document", so they never enter
    // the agenda, nothing marks them covered, and every turn looks like the
    // first time. Restating the prohibition would not change that; stating
    // what has ALREADY HAPPENED does, because it is a fact about this call
    // rather than an instruction to be weighed against others.
    context?.documentsCovered
      ? `You have ALREADY told this caller which documents they will need, on this call. Do not raise documents again, and do not ask whether they have any of them ready. If they bring it up themselves, answer their question and stop. Their answers about documents cannot be recorded anywhere — only an upload settles it — so asking twice gains nothing and reads as though you were not listening the first time.`
      : null,
    PRIVACY_RULES,
    HONESTY_RULES,
    // languageRules() is null on an English call, and a null joined into this
    // list would leave a stray blank paragraph in the middle of the prompt.
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The first thing the agent says when the call connects. Kept to two short
 * sentences on purpose — backend/liveAssist.js learned the hard way that a
 * longer opening makes the caller sit through a speech before they can talk
 * (see the greeting.prompt comment there).
 */
/**
 * The greeting, per language.
 *
 * ⚠️ WRITTEN COPY, NOT MODEL OUTPUT, and that is why this table is short. Every
 * reply after the greeting is generated, so the model handles all eleven
 * languages the moment languageRules() tells it to. The greeting is fixed text
 * spoken before anyone has said a word, so it has to be WRITTEN, and writing
 * customer-facing copy in a language you cannot read back is the same mistake
 * as picking a voice from a catalogue description — which this repo has already
 * made twice.
 *
 * So: English, Hindi and Marathi are here. A caller in Telugu or Tamil gets the
 * `other` line — English, but naming that they may speak their own language —
 * and the agent then answers in Telugu from the very next turn, because that
 * part is the model's job. Degraded for one sentence, never wrong.
 *
 * ADDING A LANGUAGE IS ONE LINE, and it should be added by someone who speaks
 * it. `{name}` is substituted, or the sentence without it is used.
 */
const GREETINGS = {
  en: {
    new: "Hi, this is UPSY. Tell me what you are studying and what you need, and I will tell you where you stand.",
    named: "Hi {name}, this is UPSY. What would you like help with today?",
    back: "Hi {name}, this is UPSY again. Where would you like to pick up?",
  },
  hi: {
    new: "नमस्ते, मैं UPSY हूँ। बताइए आप क्या पढ़ना चाहते हैं और कितना loan चाहिए, मैं बताती हूँ कि आपको क्या मिल सकता है।",
    named: "नमस्ते {name} जी, मैं UPSY हूँ। बताइए, आज मैं आपकी क्या मदद कर सकती हूँ?",
    back: "नमस्ते {name} जी, मैं UPSY फिर से। हम कहाँ से आगे बढ़ें?",
  },
  mr: {
    new: "नमस्कार, मी UPSY. तुम्ही काय शिकणार आहात आणि किती loan हवं आहे ते सांगा, मी सांगते तुम्हाला काय मिळू शकतं.",
    named: "नमस्कार {name}, मी UPSY. आज मी तुमची काय मदत करू?",
    back: "नमस्कार {name}, मी पुन्हा UPSY. आपण कुठून पुढे सुरू करूया?",
  },
  // The caller asked for a language nobody here can write. Say hello in English,
  // tell them plainly that their language is fine, and let the model take over.
  other: {
    new: "Hi, this is UPSY. Tell me what you are studying and what you need — and please speak in whichever language is easiest for you.",
    named: "Hi {name}, this is UPSY. What would you like help with today? Please speak in whichever language is easiest for you.",
    back: "Hi {name}, this is UPSY again. Where would you like to pick up?",
  },
  // A caller who has not chosen a language and has not spoken yet. The invitation
  // is the whole point: detection cannot do anything until they say something,
  // and a caller who assumes the machine only speaks English will speak English.
  auto: {
    new: "Hi, this is UPSY. Tell me what you are studying and what you need — you can speak in Hindi, Marathi or any Indian language you prefer.",
    named: "Hi {name}, this is UPSY. What would you like help with today? Feel free to speak in Hindi, Marathi or whichever language suits you.",
    back: "Hi {name}, this is UPSY again. Where would you like to pick up?",
  },
};

/**
 * The first thing the agent says when the call connects. Kept to two short
 * sentences on purpose — backend/liveAssist.js learned the hard way that a
 * longer opening makes the caller sit through a speech before they can talk
 * (see the greeting.prompt comment there).
 */
/**
 * Every greeting that is the same on every call, so the phrase cache can buy
 * each one once instead of per caller.
 *
 * The `named` and `back` lines are excluded because they interpolate a name and
 * are therefore unique per caller — caching those would grow without bound and
 * never be read, which is the same reason a personalised greeting was left out
 * of the cache when it was built.
 */
export function fixedGreetings() {
  return Object.values(GREETINGS).map((g) => g.new);
}

export function buildIntroduction(context, language = "en") {
  const set = GREETINGS[language] || (SPOKEN_LANGUAGES[language] ? GREETINGS.other : GREETINGS.en);
  const name = context?.name ? context.name.split(/\s+/)[0] : null;
  if (!name) return set.new;
  // Someone who has called before should not be greeted as a new enquiry —
  // being asked your own name twice is the fastest way to make an agent feel
  // like a phone tree. Still two sentences: the opening is not the place to
  // recite what we remember.
  const line = context.callCount > 0 ? set.back : set.named;
  return line.replace("{name}", name);
}
