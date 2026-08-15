// What the conversation means the doc agent should actually ask for.
//
// The team's framing, verbatim in spirit: *"I have designed this in sync with
// our doc collection agent — from the conversation we identify certain params,
// and the loan doc agent then brings only those requests."*
//
// So this module is the join between the two halves of the product. The call
// establishes branch facts (backend/callSchema.js); those facts decide which
// documents are real for THIS person, and — just as importantly — which ones
// are not. A salaried co-applicant is never asked for three years of ITR, a
// student who is not doing a postgraduate course is never asked for a degree
// marksheet, and nobody on an unsecured loan is asked for property papers.
//
// ── Where the rules come from ───────────────────────────────────────────────
// The flowchart's own document notes, which are specific:
//
//   Self-employed → ITR 2-3 years, computation of income for the corresponding
//     years, current a/c 6 months, savings a/c 3 months, Aadhaar+PAN KYC, and a
//     light/gas bill to verify the current residence.
//   Salaried → salary slips 3 months, Form 16 for 3 years (2 minimum), salary
//     bank a/c 3 months, the joining/offer letter IF they have moved job, plus
//     the same KYC and address bill.
//   Student → "Marksheet 10th 12th UG whatever applicable (eg. if student is
//     going for PG course, ask 10,12,UG; if UG then 10th&12th)".
//
// ── The three outcomes, and why "pending" exists ────────────────────────────
// Every plan sorts documents into:
//
//   asked    — this person genuinely needs it, with the reason it applies.
//   skipped  — a document the catalogue contains that this person does NOT need,
//              kept visible WITH its reason. An officer who cannot see what was
//              dropped cannot tell "correctly narrowed" from "quietly missed".
//   pending  — the list cannot be decided yet, and the question that would
//              decide it. This is the one that makes the two agents worth
//              joining: "ask whether the co-applicant is salaried and this list
//              resolves by four documents" is an instruction, not a status.
//
// Nothing here invents a requirement. A document that is not on the flowchart
// and not in documents.js does not appear.

import { DOCUMENTS, getDocument } from "./documents.js";

// Plan ids that are not catalogue rows of their own but upload through an
// existing slot. This used to be a nine-document list marked "NOT IN UPLOAD
// FLOW"; the co-applicant income set now lives in documents.js proper (with
// `coApplicantCategory` gating which files see it), which was always the
// stated way to close that gap — a tester duly asked why a call was requesting
// documents the upload UI could not take.
const ALIASES = {
  student_marksheet_ug: {
    label: "Undergraduate degree marksheet",
    stage: "student",
    why: "The postgraduate course makes the UG result the relevant academic record, on top of 10th and 12th.",
    // The catalogue's "Latest degree marksheet" slot is where this lands.
    uploadsAs: "student_marksheet_degree",
  },
};

function describe(id) {
  const known = getDocument(id);
  if (known) return { id, label: known.label, why: known.why, stage: known.stage, inCollectionFlow: true };
  const alias = ALIASES[id];
  if (alias) return { id, ...alias, inCollectionFlow: Boolean(getDocument(alias.uploadsAs)) };
  return null;
}

/**
 * Turn branch facts into a document plan.
 *
 * @param {object} profile - the account profile written by callExtract.js.
 * @returns {{asked: object[], skipped: object[], pending: object[], counts: object}}
 */
export function planDocuments(profile = {}) {
  const applicant = profile.applicant || {};
  const institute = profile.institute || {};
  const loan = profile.loan || {};
  const co = profile.coApplicant || {};

  const asked = [];
  const skipped = [];
  const pending = [];

  const ask = (id, because) => {
    const doc = describe(id);
    if (doc) asked.push({ ...doc, because });
  };
  const skip = (id, because) => {
    const doc = describe(id);
    if (doc) skipped.push({ id: doc.id, label: doc.label, stage: doc.stage, because });
  };
  // A question whose answer changes the list, named with what it would settle.
  const undecided = (branch, field, question, settles) => pending.push({ branch, field, question, settles });

  // ── Student ───────────────────────────────────────────────────────────────
  // KYC is unconditional: no answer on any call makes a borrower not need it.
  ask("student_pan", "Every applicant needs it — the credit pull runs on it.");
  ask("student_aadhaar", "Every applicant needs it — primary KYC and address proof.");
  ask("student_photo", "Required on the lender's application form.");
  ask("student_bank_statement", "Standard for every file, income or not — it shows banking conduct.");

  // "Marksheet 10th 12th UG whatever applicable" — the level decides it.
  const level = courseLevel(institute, applicant);
  ask("student_marksheet_10_12", "Always needed — 10th also doubles as the date-of-birth proof lenders cross-check.");
  if (level === "postgraduate") {
    ask("student_marksheet_ug", `They are going for a postgraduate course${institute.course ? ` (${institute.course})` : ""}, so the degree result applies too.`);
  } else if (level === "undergraduate") {
    skip("student_marksheet_ug", "Undergraduate course — 10th and 12th are the whole academic record.");
  } else {
    undecided("institute", "course", "which course, and at what level", "whether the UG marksheet is needed on top of 10th and 12th");
  }

  if (institute.offerLetter === "received") {
    ask("student_admit_letter", "They said the offer letter is already in hand.");
  } else if (institute.offerLetter) {
    skip("student_admit_letter", `Offer letter is "${institute.offerLetter}" — cannot be asked for yet, but the file cannot be sanctioned without it.`);
  } else {
    undecided("institute", "offerLetter", "whether they already have the offer or admission letter", "whether the admission letter can be asked for now or has to wait");
  }

  // Optional in the catalogue and left optional here: plenty of real courses
  // have no entrance test, and asking for a scorecard that does not exist is
  // exactly the noise this module exists to remove.
  skip("student_entrance_score", "Optional — only worth asking if their course had an entrance test.");

  // ── Co-applicant ──────────────────────────────────────────────────────────
  ask("co_pan", "Mandatory — the co-applicant's credit score largely drives the sanction and the rate.");
  ask("co_aadhaar", "Mandatory KYC for the co-borrower.");
  ask("co_cancelled_cheque", "Sets up the NACH mandate the EMIs are collected through.");
  ask("co_bank_statement", "Confirms repayment capacity — part of every file.");

  if (co.relation) {
    ask("co_relationship_proof", `Proves the stated relationship (${co.relation}). Lenders require immediate family.`);
  } else {
    ask("co_relationship_proof", "Proves the relationship to the student — required whoever it turns out to be.");
    undecided("coApplicant", "relation", "how that person is related to them", "nothing on this list, but a relation outside immediate family stops the file");
  }

  // The income branch — the biggest single narrowing on the flowchart.
  switch (co.category) {
    case "salaried":
      ask("co_income_proof", "Salaried co-applicant — three months of salary slips are the income proof.");
      ask("co_form16", form16Reason(co));
      ask("co_salary_bank_statement", "Salaried co-applicant — the account the salary lands in.");
      if (co.recentJobChange === true) {
        ask("co_joining_letter", "They said the co-applicant has changed jobs recently.");
      } else if (co.recentJobChange === false) {
        skip("co_joining_letter", "No recent job change — the existing slips and Form 16 already cover the period.");
      } else {
        undecided("coApplicant", "recentJobChange", "whether they have changed jobs recently", "whether the joining letter is needed");
      }
      skip("co_itr_multi", "Salaried — Form 16 and salary slips replace the ITR years.");
      skip("co_income_computation", "Salaried — there is no business income to compute.");
      skip("co_current_account_statement", "Salaried — no business account involved.");
      skip("co_savings_account_statement", "Salaried — the salary account statement covers this.");
      break;

    case "self-employed":
    case "farmer":
      ask("co_itr_multi", itrReason(co));
      ask("co_income_computation", "Self-employed — the computation behind each ITR year is what the lender underwrites on.");
      ask("co_current_account_statement", "Self-employed — six months of the business account.");
      ask("co_savings_account_statement", "Self-employed — three months of the personal account alongside it.");
      skip("co_income_proof", "Self-employed — the ITR set below replaces salary slips.");
      skip("co_form16", "Self-employed — no employer, so no Form 16.");
      skip("co_salary_bank_statement", "Self-employed — the current and savings accounts cover this.");
      skip("co_joining_letter", "Self-employed — no employer to join.");
      break;

    case "pensioner":
      // Said plainly rather than guessed. The flowchart names four categories
      // and details two; inventing a pensioner's document set here would be
      // this module doing exactly what it exists to prevent.
      ask("co_income_proof", "Pensioner co-applicant — the pension order or pension account statement stands in as the income proof.");
      pending.push({
        branch: "coApplicant",
        field: "category",
        question: "confirm with ops what a pensioner co-applicant must produce",
        settles: "the flowchart names pensioner and farmer as categories but only details salaried and self-employed",
      });
      break;

    default:
      undecided("coApplicant", "category", "whether that person is salaried, self-employed, a pensioner or a farmer", "which income documents apply — this is the single question that decides the most of this list");
  }

  if (co.livesAtKycAddress === false) {
    ask("co_address_proof", "They said the co-applicant does not live at their KYC address.");
  } else if (co.livesAtKycAddress === true) {
    skip("co_address_proof", "They live at the address on their KYC, so the Aadhaar covers it.");
  } else {
    undecided("coApplicant", "livesAtKycAddress", "whether they still live at the address on their Aadhaar", "whether a utility bill is needed as current-address proof");
  }

  // ── Collateral ────────────────────────────────────────────────────────────
  if (loan.type === "secured") {
    ask("collateral_property_papers", "Secured loan — the asset has to be valued and mortgaged.");
  } else if (loan.type === "unsecured") {
    skip("collateral_property_papers", "Unsecured loan — no collateral to document.");
  } else {
    undecided("loan", "type", "whether they have property or a deposit to offer as security", "whether any collateral papers are needed at all");
  }

  return {
    asked,
    skipped,
    pending,
    counts: {
      asked: asked.length,
      skipped: skipped.length,
      pending: pending.length,
      // How much of the catalogue this conversation has already removed. The
      // number the team framing is actually about.
      catalogue: DOCUMENTS.length,
    },
  };
}

// "if student is going for PG course, ask 10,12,UG; if UG then 10th&12th".
// Read from what they are about to study, falling back to what they have just
// finished — someone who has completed a degree is starting a postgraduate one.
function courseLevel(institute, applicant) {
  const course = String(institute.course || "").toLowerCase();
  if (/\b(mba|m\.?tech|m\.?sc|m\.?a|m\.?com|masters?|pg|post.?grad|phd|doctorate|ms)\b/.test(course)) return "postgraduate";
  if (/\b(b\.?tech|b\.?sc|b\.?a|b\.?com|bba|bca|bachelors?|ug|under.?grad)\b/.test(course)) return "undergraduate";
  // No course level stated: what they have finished still settles it.
  if (["undergraduate", "postgraduate"].includes(applicant.currentQualification)) return "postgraduate";
  if (["12th", "diploma"].includes(applicant.currentQualification)) return "undergraduate";
  return null;
}

function form16Reason(co) {
  const years = co.form16YearsAvailable;
  if (years >= 3) return "Salaried — they said three years of Form 16 are available, which is what lenders ask for.";
  if (years === 2) return "Salaried — they have two years, which is the minimum most lenders accept. Worth asking if a third exists.";
  if (years > 0) return `Salaried — only ${years} year of Form 16 was mentioned, below the two-year minimum. Flagged on the file.`;
  return "Salaried — three years where possible, two at minimum.";
}

function itrReason(co) {
  const years = co.itrYearsAvailable;
  if (years >= 3) return "Self-employed — they said three years of ITR are available, which is the full ask.";
  if (years === 2) return "Self-employed — two years available, which is the stated minimum.";
  if (years > 0) return `Self-employed — only ${years} year of ITR was mentioned, below the two-year minimum. Flagged on the file.`;
  return "Self-employed — three years where possible, two at minimum.";
}

/**
 * The plan as a line the voice agent can read from.
 *
 * Deliberately short and deliberately NOT the whole list: VOICE_STYLE in
 * voicePrompt.js forbids reading a checklist aloud, and the point of narrowing
 * the list is that the caller hears a shorter one, not a longer explanation of
 * a shorter one.
 */
/**
 * The one rule about documents that is not about the list: TELL, do not ASK.
 *
 * Reported from a real call — the agent was quizzing callers on whether they
 * had a given document, and a yes or a no went nowhere. There is no field for
 * it: `aadhaarOnFile` and `panOnFile` are source:"document" and are filled by
 * an actual upload, never by an answer. So the question spent the caller's
 * time, taught us nothing, and made a helpful moment feel like an audit. What
 * the caller wants at that point is the list; what we want is the upload.
 *
 * Exported because the voice prompt falls back to the full catalogue for a
 * caller nothing is known about yet, and the rule has to hold on that path too.
 */
export const DOCUMENT_TELL_DONT_ASK = `Do NOT quiz them on whether they already have a document. "Do you have your Aadhaar?" records nothing — the answer has nowhere to go, and only an upload can settle it. If documents come up, TELL them what they will need and where to upload it, then move on. The exceptions are the three questions that DO have a field behind them and change the list: whether the offer letter has arrived, and how many years of ITR or Form 16 the co-applicant can produce.`;

export function documentPlanForPrompt(profile = {}) {
  const plan = planDocuments(profile);
  if (!plan.asked.length) return null;
  const lines = plan.asked.map((d) => `- ${d.label}`).join("\n");
  const dropped = plan.skipped.length
    ? `\n\nWhat this person does NOT need, because of what they have already told you — never ask for any of these: ${plan.skipped.map((d) => d.label).join("; ")}.`
    : "";
  const unknown = plan.pending.length
    ? `\n\nThis list is not settled yet. Answering these would narrow it further: ${plan.pending.map((p) => p.question).join("; ")}.`
    : "";
  return `The documents THIS person actually needs, worked out from what they have told you. If they ask what they will need, name the next one or two from here — never read the list out:\n${lines}${dropped}${unknown}\n\n${DOCUMENT_TELL_DONT_ASK}`;
}
