// How the brand name is SAID, as opposed to how it is written.
//
// Every engine read "UPSY" as four letters — "U. P. S. Y." — in every language.
// All-caps is how acronyms are written, so a speech engine treating it as one is
// correct behaviour on the wrong word, and no amount of prompting fixes it
// because the model is writing the name correctly. The fix belongs at the point
// where text becomes audio.
//
// ── Measured, not guessed ───────────────────────────────────────────────────
// Spelling a name out takes far longer than saying it, so the fault is visible
// in the audio duration without needing to hear it. Same carrier sentence, only
// the name changed, cost measured against the sentence with no name at all:
//
//   English                        Hindi
//     UPSY     +1.28s  spelled       UPSY    +0.85s  spelled
//     Upsy     -0.09s                Upsee   -0.26s
//     Upsee    -0.34s  ← best        अप्सी    -0.09s  ← best
//     up-see   +0.43s  spelled       अप्सि    -0.26s
//     UPSEE    +0.17s  spelled
//
// Two things worth keeping from that table. A hyphen makes it WORSE — "up-see"
// is read as two pieces — which is the obvious thing to reach for and is wrong.
// And Latin "Upsee" works inside a Devanagari sentence too, so it is a sound
// fallback for the languages nobody here can spell confidently.
//
// ── Duration was not enough for Hindi, so it was heard instead ──────────────
// In Hindi the same sentence varies by ±0.5s between identical requests, which
// swamps the effect being measured — a single before/after comparison there
// says nothing, and reading one as proof would be the same mistake this repo
// has made twice already with noisy metrics.
//
// So the synthesis was played back through the recogniser, which settles it
// without ambiguity:
//
//   hi  "मैं UPSY हूँ।"   → heard as "मैं यूपीएसवाई हूँ।"   ← yoo-pee-ess-vai
//       "मैं अप्सी हूँ।"   → heard as "मैं अप्सी हूँ।"       ← one word
//   mr  "मी UPSY आहे."   → heard as "मी यूपीएसवाय आहे."
//       "मी अप्सी आहे."   → heard as "मी आपसी आहे."         ← one word
//
// The Marathi playback comes back as "आपसी" rather than "अप्सी", so the vowel
// leans longer than the intended "up". It is being SAID rather than spelled,
// which was the defect — but if a Marathi speaker says it sounds like "aap-see"
// rather than "up-see", that is the thing to change, and this is the line to
// change it on.
//
// ⚠️ THIS CHANGES WHAT IS SPOKEN, NEVER WHAT IS WRITTEN. The transcript on the
// page, the turns stored against the account, and everything an officer reads on
// /team all keep "UPSY". Substituting there would put a misspelling of the
// company's own name into its records, which is a worse bug than the one this
// fixes.

// Devanagari serves Hindi and Marathi. Everything else falls back to the Latin
// spelling, which measured as a word rather than an acronym.
const SPOKEN_AS = {
  hi: "अप्सी",
  mr: "अप्सी",
};

const FALLBACK = "Upsee";

// Whole word only, any case. `\b` is safe on both sides here because the name is
// Latin: a Devanagari sentence with "UPSY" in it still has word boundaries
// around the Latin run. Matching case-insensitively covers "Upsy" and "upsy"
// too — they are less badly spoken than the all-caps form, but not as well as
// the phonetic one, and the model writes whichever it feels like.
const BRAND = /\bupsy\b/gi;

/**
 * Rewrite text for synthesis. Call this ONLY on the way to a TTS engine.
 *
 * @param {string} text     what the agent is going to say
 * @param {string} language short code, e.g. "en", "hi", "mr"
 */
export function forSpeech(text, language = "en") {
  const s = String(text ?? "");
  if (!s) return s;
  const say = SPOKEN_AS[String(language || "en").toLowerCase()] || FALLBACK;
  return s.replace(BRAND, say);
}
