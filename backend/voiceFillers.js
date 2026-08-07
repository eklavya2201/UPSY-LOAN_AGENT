// Acknowledgements — the thing that actually hides model latency on a call.
//
// The brain needs ~1.4–2s to produce a first sentence. Speculative generation
// (voiceRelay.js) hides that only when Deepgram splits an utterance into
// fragments; on a short question it sends one final chunk and there is nothing
// to get a head start on. So instead of engineering the silence away, fill it
// the way a person does: say "okay, so you want to know which documents" while
// you think. The caller hears a response ~400ms after they stop instead of ~2s,
// and — unlike a beep or hold music — it also confirms they were understood.
//
// ── Two rules, and they are not style preferences ───────────────────────────
// 1. AN ACKNOWLEDGEMENT MUST NOT ANSWER ANYTHING. It is chosen by keyword match
//    before the model has decided a single thing, so any hint of a number, a
//    verdict, a rate or a yes/no would be this server inventing lending advice.
//    Every line below restates the QUESTION and stops.
// 2. It must survive being wrong. The matcher is a regex over a rough
//    transcript, so it will sometimes pick the wrong bucket — which is why even
//    a mis-picked line has to read as a harmless "let me look at that", never as
//    a claim about their case.
//
// Hindi lines are written and ready but unreachable until Sarvam lands (see
// voiceTts.js) — kept here so that swap is a data change, not a rewrite.

const BUCKETS = [
  {
    id: "documents",
    match: /document|paper|proof|upload|certificate|marksheet|statement|aadhaar|aadhar|pan\b|itr/i,
    en: [
      "Okay, so you want to know which documents you'll need.",
      "Right, let me go through the documents with you.",
    ],
    hi: [
      "Achha, to aap jaanna chahte hain ki kaun se documents lagenge.",
      "Theek hai, main aapko documents ke baare mein batata hoon.",
    ],
  },
  {
    id: "amount",
    match: /how much|amount|borrow|lakh|crore|eligib|qualify|loan size|maximum/i,
    en: [
      "Okay, so you want to know how much you could borrow.",
      "Right, let me think about what that would look like for you.",
    ],
    hi: [
      "Achha, to aap jaanna chahte hain ki kitna loan mil sakta hai.",
      "Theek hai, main dekhta hoon ki aapke case mein kya ho sakta hai.",
    ],
  },
  {
    id: "repayment",
    match: /emi|interest|rate|repay|instal|moratorium|monthly|pay back|tenure/i,
    en: [
      "Okay, so this is about the repayments.",
      "Right, let me walk you through how the repayment works.",
    ],
    hi: [
      "Achha, to baat repayment ki hai.",
      "Theek hai, main aapko batata hoon ki repayment kaise hota hai.",
    ],
  },
  {
    id: "coapplicant",
    match: /co.?applicant|co.?borrow|father|mother|parent|spouse|husband|wife|guarantor|brother|sister/i,
    en: [
      "Okay, so this is about your co-applicant.",
      "Right, let me think about the co-applicant side of it.",
    ],
    hi: [
      "Achha, to baat aapke co-applicant ki hai.",
      "Theek hai, main co-applicant ke baare mein sochta hoon.",
    ],
  },
  {
    id: "process",
    match: /how long|how do i|what happens|process|apply|next step|status|when will/i,
    en: [
      "Okay, so you want to know how this works.",
      "Right, let me take you through it.",
    ],
    hi: [
      "Achha, to aap jaanna chahte hain ki yeh kaise hota hai.",
      "Theek hai, main aapko poora process batata hoon.",
    ],
  },
];

// Nothing matched. Deliberately says almost nothing — a generic filler that
// tries to sound specific is how an agent ends up implying something it has not
// worked out yet.
const GENERIC = {
  en: ["Okay, let me think about that for a second.", "Right, one moment."],
  hi: ["Achha, ek second, main sochta hoon.", "Theek hai, ek minute."],
};

/**
 * Pick something to say while the model thinks.
 *
 * @param {string} question - the caller's transcript for this turn.
 * @param {string} language - "en" or "hi".
 * @param {string|null} lastUsed - the previous turn's acknowledgement, so the
 *   agent never says the same one twice running. Hearing "Right, one moment"
 *   on every single turn is worse than hearing nothing at all — it is the tell
 *   that turns a convincing agent back into a machine.
 * @returns {string|null}
 */
export function pickAcknowledgement(question, language = "en", lastUsed = null) {
  const lang = language === "hi" ? "hi" : "en";
  const text = String(question || "");

  // Very short utterances ("yes", "okay", "hmm") get nothing. Acknowledging an
  // acknowledgement is how two people end up talking past each other.
  if (text.trim().split(/\s+/).length < 3) return null;

  const bucket = BUCKETS.find((b) => b.match.test(text));
  const options = (bucket ? bucket[lang] : GENERIC[lang]) || GENERIC.en;
  const fresh = options.filter((o) => o !== lastUsed);
  const pool = fresh.length ? fresh : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Exported for tests and for anyone tuning the matcher.
export const ACKNOWLEDGEMENT_BUCKETS = BUCKETS;
