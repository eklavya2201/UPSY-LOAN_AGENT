// Sentence helpers for the live-assist voice agent. Pure functions, kept out
// of liveAssist.js so they can be tested directly — that file spawns the
// AgentCall bridge on import and cannot be loaded from a test.

// Note on the repeat bug: replies used to be deduped whole, after generation.
// Now that sentences are spoken as they stream, liveAssist.js applies the same
// "never say the same line twice in a row" rule incrementally, comparing each
// sentence against the previous one before sending it to TTS.

// Pull complete sentences off the front of a streaming buffer, leaving any
// half-written tail behind for the next chunk.
//
// A sentence is only complete once we have seen WHITESPACE after the .?! —
// never merely the end of the buffer. That distinction is the whole trick for
// decimals while streaming: mid-stream the buffer legitimately ends at
// "the fee is 1." with "25 lakh" still in flight, and treating that trailing
// dot as a sentence ending would make the bot say "the fee is one" and then
// "two five lakh" as separate utterances. Waiting for the following space
// costs nothing and removes the whole class of bug.
const SENTENCE_RE = /^([\s\S]*?[.?!])\s+/;

// `flush` is for when the stream has ended and no more characters are coming,
// so whatever remains is by definition the last sentence.
export function takeCompleteSentences(buffer, { flush = false } = {}) {
  const sentences = [];
  let rest = String(buffer);
  let m;
  while ((m = SENTENCE_RE.exec(rest))) {
    const s = m[1].trim();
    if (s) sentences.push(s);
    rest = rest.slice(m[0].length);
  }
  if (flush) {
    const tail = rest.trim();
    if (tail) sentences.push(tail);
    rest = "";
  }
  return { sentences, rest };
}
