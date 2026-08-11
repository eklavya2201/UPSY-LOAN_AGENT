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

// ── Receipts, for when the caller ANSWERED rather than asked ────────────────
//
// The buckets above were all written for a caller asking a question, back when
// that was the only thing this agent did. It asks questions of its own now, so
// most turns are ANSWERS — and "okay, so you want to know how much you could
// borrow" is nonsense in reply to "my father earns ninety-five thousand".
// Everything that was not a question therefore fell through to a generic.
//
// And the generics were the wrong shape entirely: "let me think about that for
// a second" and "one moment" ANNOUNCE A WAIT. A person filling the same gap
// does not say they are about to think, they say "got it" — a receipt, not a
// stall. It buys the identical two seconds and it reads as the front of the
// answer rather than as an apology for the delay.
//
// Short on purpose. Long enough to cover the model's first sentence, short
// enough that the caller is never waiting on the filler itself.
const RECEIPTS = {
  en: ["Got it.", "Right.", "Okay.", "Sure.", "Understood.", "Okay, got it."],
  hi: ["Theek hai.", "Achha.", "Samajh gaya.", "Haan, theek hai."],
};

// Neither a question nor a real answer — "yes", "okay", "hmm". Says nothing at
// all: acknowledging an acknowledgement is how two people talk past each other.
const BACKCHANNEL = /^(yes|yeah|yep|no|nope|ok|okay|sure|hmm+|uh huh|right|thanks|thank you|correct|exactly)\b[.! ]*$/i;

// Does this read as a question? Cheap and wrong sometimes, which is fine —
// getting it wrong costs a receipt where a restatement would have been slightly
// better, never a claim about their case.
const LOOKS_LIKE_A_QUESTION =
  /\?|^(what|how|why|when|where|which|who|can|could|do|does|did|is|are|am|will|would|should|shall|any|tell me|explain)\b/i;

function pickFresh(options, lastUsed) {
  const fresh = options.filter((o) => o !== lastUsed);
  const pool = fresh.length ? fresh : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

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
  const text = String(question || "").trim();
  if (!text) return null;

  // "Yes." / "Okay." — nothing to acknowledge.
  if (BACKCHANNEL.test(text)) return null;

  // A QUESTION gets the topic restated, which both fills the gap and confirms
  // they were understood.
  if (LOOKS_LIKE_A_QUESTION.test(text)) {
    const bucket = BUCKETS.find((b) => b.match.test(text));
    if (bucket) return pickFresh(bucket[lang] || bucket.en, lastUsed);
  }

  // Everything else is an ANSWER to something the agent asked. Take the receipt.
  //
  // Deliberately allowed on consecutive turns — a person says "got it" twice
  // running without it being strange, and this is the whole reason a caller
  // never sits in silence while the model writes its first sentence. What must
  // not repeat is the exact same word, which pickFresh handles. The old code
  // said nothing at all on short turns, so precisely the turns with the least
  // to think about were the ones with the longest silence.
  return pickFresh(RECEIPTS[lang] || RECEIPTS.en, lastUsed);
}

// Exported for tests and for anyone tuning the matcher.
export const ACKNOWLEDGEMENT_BUCKETS = BUCKETS;

/**
 * Every acknowledgement this module can ever produce, in every language.
 *
 * These are the strings the agent repeats across calls, which makes them the
 * ones worth synthesising once and keeping — see the phrase cache in
 * voiceTts.js. Anything the model writes is unique and is not on this list.
 */
export function allFixedPhrases(language) {
  // Ask for a language explicitly. An earlier version returned every language at
  // once and left the caller to sort them out by regex — which quietly failed and
  // sent a dozen Hindi lines to an English voice to be synthesised and paid for.
  // The buckets already know which is which; guessing from the text was never
  // necessary.
  const langs = language ? [language] : ["en", "hi"];
  const out = [];
  for (const bucket of BUCKETS) for (const l of langs) out.push(...(bucket[l] || []));
  for (const l of langs) out.push(...(RECEIPTS[l] || []));
  return out;
}
