// Slowing the agent down, since the vendor will not.
//
// Measured against the live account: every Cartesia voice runs 195–222 words a
// minute, and their speech-rate control does nothing on sonic-2 — the same
// sentence came back at 4.60s baseline, 4.46s at speed -0.3, 4.64s at -0.6,
// 4.60s at -1, and 4.88s on a newer API version. That spread is noise. A real
// listener said "she's still speaking too fast" after the between-sentence
// pause was already in, which is the whole reason this file exists.
//
// ── Why not resample, and why not time-stretch ──────────────────────────────
// Resampling slows speech by dropping the pitch with it, which turns the agent
// into a different, deeper person. Proper pitch-preserving time-stretch (WSOLA)
// avoids that but costs real CPU per sentence and smears consonants when pushed.
//
// This does what a person actually does when asked to slow down: it does not
// draw out the words, it leaves longer gaps between them. Find the quiet
// moments the speaker already produced and lengthen them. No pitch change, no
// artifacts, and the speech itself is untouched — only the silence grows.
//
// Runs per streamed chunk rather than per sentence, so the first syllable still
// leaves as soon as Cartesia produces it. Gaps that straddle a chunk boundary
// are missed; that costs a little stretch, never correctness.

// Anything quieter than this is treated as a gap rather than speech (Int16
// scale, peak over a 5ms window). Tuned by sweeping against real Cartesia
// output: at 900 the detector found 8 gaps in a 16-word sentence and only got
// it to 188 wpm; at 2500 it finds 14 — about one per word — and reaches 166.
// 5000 finds slightly more but starts biting into quiet consonants, which is
// the one way this could sound broken, so it is not worth the extra 3 wpm.
const SILENCE_FLOOR = 2500;

// A gap has to be at least this long to be a real inter-word pause rather than
// the momentary dip inside a stop consonant ("p", "t", "k"), which is where
// naive silence detection destroys speech.
const MIN_GAP_MS = 25;

// Don't stretch a gap that is already a full stop — those are handled by the
// between-sentence pause in voiceRelay.js, and doubling up sounds hesitant.
const MAX_GAP_MS = 400;

/**
 * Lengthen the natural pauses in a chunk of PCM.
 *
 * @param {Buffer} pcm - raw pcm_s16le, mono.
 * @param {object} opts
 * @param {number} opts.sampleRate
 * @param {number} opts.extraMs - silence added per detected gap.
 * @returns {Buffer} the same speech, with roomier gaps.
 */
export function stretchGaps(
  pcm,
  { sampleRate = 44100, extraMs = 110, floor = SILENCE_FLOOR, minGapMs = MIN_GAP_MS } = {}
) {
  if (!pcm || pcm.length < 4 || extraMs <= 0) return pcm;

  const samples = pcm.length >> 1;
  const minGap = Math.round((minGapMs / 1000) * sampleRate);
  const maxGap = Math.round((MAX_GAP_MS / 1000) * sampleRate);
  const insert = Math.round((extraMs / 1000) * sampleRate);

  // One pass to find where the quiet stretches are. Amplitude is smoothed over
  // a short window rather than tested sample by sample: a single loud sample in
  // an otherwise quiet stretch is noise, not speech, and testing raw samples
  // makes the detector miss most real inter-word gaps.
  const win = Math.max(1, Math.round(sampleRate * 0.005)); // 5ms
  const gaps = [];
  let runStart = -1;
  for (let i = 0; i < samples; i += win) {
    let peak = 0;
    const end = Math.min(i + win, samples);
    for (let j = i; j < end; j++) {
      const v = Math.abs(pcm.readInt16LE(j << 1));
      if (v > peak) peak = v;
    }
    const quiet = peak < floor;
    if (quiet) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len >= minGap && len <= maxGap) gaps.push(runStart + (len >> 1)); // insert at the middle
      runStart = -1;
    }
  }
  // A gap running to the very end of the chunk counts too — with streamed audio
  // that is usually the pause before the next chunk's first word.
  if (runStart >= 0 && samples - runStart >= minGap) gaps.push(runStart + ((samples - runStart) >> 1));

  if (!gaps.length) return pcm;

  // Rebuild with silence spliced into each gap's midpoint. Splitting at the
  // middle rather than the edge keeps the natural decay and onset intact.
  const out = Buffer.alloc(pcm.length + gaps.length * insert * 2);
  let read = 0;
  let write = 0;
  for (const at of gaps) {
    const bytes = (at << 1) - read;
    pcm.copy(out, write, read, read + bytes);
    write += bytes;
    read += bytes;
    write += insert * 2; // Buffer.alloc already zeroed this — that is the silence
  }
  pcm.copy(out, write, read);
  return out;
}

/**
 * How much slower a chunk got. Only used for logging and the preflight, so the
 * effect of a tuning change is visible rather than argued about.
 */
export function stretchRatio(before, after) {
  if (!before?.length) return 1;
  return after.length / before.length;
}
