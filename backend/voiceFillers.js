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
// ── Which languages are here, and why not all eleven ────────────────────────
// English, Hindi and Marathi. The agent can CONVERSE in all eleven Sarvam
// carries, because those replies are written by the model — but these lines are
// written copy, and writing customer-facing copy in a language you cannot read
// back is how the voice got picked wrong twice.
//
// A language with no bucket here gets SILENCE rather than an English line. See
// pickAcknowledgement for why that is the safer failure.
//
// Note the deliberate English loan words inside the Hindi and Marathi lines
// ("documents", "loan", "repayment", "case"). That is not laziness — it is how
// these conversations are actually held, and it matches the instruction the
// system prompt gives the model in voicePrompt.js. Pure translated vocabulary
// reads as a form being recited.

const BUCKETS = [
  {
    id: "documents",
    match: /document|paper|proof|upload|certificate|marksheet|statement|aadhaar|aadhar|pan\b|itr/i,
    en: [
      "Okay, so you want to know which documents you'll need.",
      "Right, let me go through the documents with you.",
    ],
    hi: [
      "अच्छा, तो आप जानना चाहते हैं कि कौन से documents लगेंगे।",
      "ठीक है, मैं आपको documents के बारे में बताती हूँ।",
    ],
    mr: [
      "बरं, तुम्हाला कोणते documents लागतील हे जाणून घ्यायचं आहे.",
      "ठीक आहे, मी तुम्हाला documents बद्दल सांगते.",
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
      "अच्छा, तो आप जानना चाहते हैं कि कितना loan मिल सकता है।",
      "ठीक है, मैं देखती हूँ कि आपके case में क्या हो सकता है।",
    ],
    mr: [
      "बरं, तुम्हाला किती loan मिळू शकतं हे जाणून घ्यायचं आहे.",
      "ठीक आहे, मी बघते तुमच्या case मध्ये काय होऊ शकतं.",
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
      "अच्छा, तो बात repayment की है।",
      "ठीक है, मैं आपको बताती हूँ कि repayment कैसे होता है।",
    ],
    mr: [
      "बरं, हा प्रश्न repayment चा आहे.",
      "ठीक आहे, मी सांगते repayment कसं होतं ते.",
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
      "अच्छा, तो बात आपके co-applicant की है।",
      "ठीक है, मैं co-applicant के बारे में सोचती हूँ।",
    ],
    mr: [
      "बरं, हा प्रश्न तुमच्या co-applicant चा आहे.",
      "ठीक आहे, मी co-applicant बद्दल बघते.",
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
      "अच्छा, तो आप जानना चाहते हैं कि यह कैसे होता है।",
      "ठीक है, मैं आपको पूरा process बताती हूँ।",
    ],
    mr: [
      "बरं, तुम्हाला हे कसं होतं ते जाणून घ्यायचं आहे.",
      "ठीक आहे, मी तुम्हाला पूर्ण process सांगते.",
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
  // Devanagari, not the romanised "Theek hai" these started as. bulbul is given
  // target_language_code=hi-IN and expects the script that goes with it; Latin
  // Hindi is a different input and not the one it was built for.
  //
  // Feminine verb forms, because the voice is female. The line these replace was
  // "Samajh gaya" — masculine, and wrong out of the mouth it was always going to
  // come out of.
  hi: ["ठीक है।", "अच्छा।", "समझ गई।", "जी, ठीक है।", "हाँ जी।"],
  mr: ["ठीक आहे.", "बरं.", "समजलं.", "हो, ठीक आहे."],
};

// Neither a question nor a real answer — "yes", "okay", "hmm". Says nothing at
// all: acknowledging an acknowledgement is how two people talk past each other.
// ⚠️ `\b` DOES NOT WORK ON DEVANAGARI in JavaScript — it is defined against
// [A-Za-z0-9_], so it never fires between two Indic characters. Hence the
// separate alternation below rather than adding words to the list above: a bare
// "हाँ" would otherwise fall through and collect a receipt, which is the exact
// "acknowledging an acknowledgement" this constant exists to prevent.
const BACKCHANNEL =
  /^(?:(?:yes|yeah|yep|no|nope|ok|okay|sure|hmm+|uh huh|right|thanks|thank you|correct|exactly)\b|(?:हाँ|हां|हा|जी|नहीं|नही|अच्छा|ठीक|ओके|हो|नाही|बरं|बरोबर|होय))[.।!\s]*$/i;

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
  // ⚠️ SILENCE IS THE FALLBACK, NOT ENGLISH.
  //
  // This used to be `language === "hi" ? "hi" : "en"`, which was right when
  // those were the only two languages that could ever be asked for. Now that
  // eleven can be, that line would answer a Telugu caller's Telugu sentence
  // with "Got it." — the agent audibly dropping out of their language for one
  // beat, on most turns, which reads as broken rather than as a filler.
  //
  // The cost of returning null is a ~1.5s silence while the model writes, which
  // is the gap this module exists to hide and is the one the agent lived with
  // for months. That is a much smaller failure than sounding broken. Writing
  // these lines in a language nobody here can read back is the larger risk, so
  // a language earns its bucket when a speaker adds one.
  const lang = RECEIPTS[language] ? language : null;
  if (!lang) return null;
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
  const langs = language ? [language] : Object.keys(RECEIPTS);
  const out = [];
  for (const bucket of BUCKETS) for (const l of langs) out.push(...(bucket[l] || []));
  for (const l of langs) out.push(...(RECEIPTS[l] || []));
  return out;
}

/** Which languages have acknowledgements written, so callers can check rather than guess. */
export function fillerLanguages() {
  return Object.keys(RECEIPTS);
}
