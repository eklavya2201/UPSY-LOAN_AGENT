// Sample-rate conversion for the voice relay.
//
// Until Sarvam, this file did not need to exist, and that was a property worth
// protecting rather than an accident: the whole pipeline ran pcm_s16le @ 44.1kHz
// from the caller's microphone to their speaker with not one resample step in
// between, in either direction.
//
// Sarvam's realtime recogniser does not offer that choice. It accepts 8000 or
// 16000 Hz and **closes the socket with code 4000** on anything else, so
// speaking to it means converting down. Its voice comes back at 24kHz, so
// playing it means converting up. Deepgram's path is untouched and still does
// neither — nothing in here runs on an English call unless someone sets
// STT_PROVIDER=sarvam.
//
// ── Two things make this harder than "take every Nth sample" ────────────────
//
// 1. THE RATIO IS FRACTIONAL. 44100/16000 is 2.75625, so an output sample
//    almost never lands on an input sample. Snapping to the nearest one adds
//    timing jitter of up to half a sample on every single output — audible as
//    roughness, and it lands on exactly the consonant detail a recogniser uses
//    to tell "lakh" from "lack".
//
// 2. IT HAS TO SURVIVE CHUNK BOUNDARIES. Audio arrives in ~2048-sample frames.
//    Resampling each frame as if it were a whole file restarts the fractional
//    read position at zero every 46ms and loses the interval spanning the seam,
//    which puts a discontinuity into the stream 23 times a second. So the read
//    position AND the last input sample carry across calls to process(). This
//    is the bug this file exists to not have; it is silent, it sounds like a
//    slightly bad microphone, and it would be blamed on the caller's phone.
//
// And going DOWN in rate needs a low-pass FIRST. Everything above the output's
// Nyquist folds back into the audible band as a mirror image — 44.1k content at
// 10kHz reappears at 6kHz once you decimate to 16k, sitting on top of speech.
// Fricatives (s, sh, f) are exactly the energy up there, so the artefact is
// worst on the sounds already hardest to recognise.

// ── Anti-alias filter ───────────────────────────────────────────────────────

// One stage of a cascaded Butterworth low-pass (RBJ cookbook form). Three of
// these in series make a 6-pole, -36dB/octave response. The order was chosen by
// measuring the thing it exists to prevent rather than by taste — see the Q
// table below.
class Biquad {
  constructor(sampleRate, cutoffHz, q) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;

    this.b0 = ((1 - cos0) / 2) / a0;
    this.b1 = (1 - cos0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos0) / a0;
    this.a2 = (1 - alpha) / a0;

    // Direct Form I state. Carried across chunks for the same reason the read
    // position is: a filter reset every 46ms is an impulse every 46ms.
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  run(x) {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// The Q values that make a 6-pole Butterworth when cascaded, from
// Q = 1/(2·sin((2k+1)π/12)). Not arbitrary — any other set gives passband
// ripple or a droopy corner.
//
// 6 poles rather than 4 because the 4-pole version was measured and was not
// good enough: a 12kHz tone folded back to 4kHz only 26.7dB below a real 4kHz
// tone, which sits well inside the speech band the recogniser is reading. The
// third stage costs three multiply-adds per sample — nothing at 44.1kHz — and
// buys another ~13dB. The check in voice-sarvam-check.js holds this to -35dB so
// it cannot quietly regress.
const BUTTERWORTH_6_Q = [0.51763809, 0.70710678, 1.93185165];

/**
 * Streaming sample-rate converter for mono pcm_s16le.
 *
 * One instance per direction per call, because it carries state. Reusing one
 * across two streams silently mixes them.
 */
export class Resampler {
  constructor({ from, to }) {
    this.from = from;
    this.to = to;
    this.passthrough = from === to;
    this.step = from / to;

    // Fractional read position, in samples, relative to the start of the NEXT
    // chunk handed to process(). Can legitimately sit at -1, which reads the
    // carried tail sample below.
    this.pos = 0;
    // The final input sample of the previous chunk, so an output landing
    // between two chunks interpolates across the seam instead of over it.
    this.tail = 0;
    // A chunk with an odd byte count would split a sample down the middle and
    // desync every sample after it — from then on the stream is noise. Cheap to
    // carry, catastrophic to ignore.
    this.oddByte = null;

    // Only when going down. Upsampling produces images above the ORIGINAL
    // Nyquist, which are inaudible here and harmless to the recogniser, so the
    // filter would cost CPU for nothing.
    //
    // Cutoff at 0.45 of the output rate, not 0.5: a filter is not a brick wall,
    // and leaving no transition band means the corner is still passing energy
    // when it crosses Nyquist. 7200Hz for a 16k output, which is above every
    // frequency that carries speech information.
    this.filters =
      from > to ? BUTTERWORTH_6_Q.map((q) => new Biquad(from, to * 0.45, q)) : [];
  }

  /**
   * Convert one chunk. Returns a Buffer at the output rate.
   *
   * Output length varies chunk to chunk — 2048 input samples at 44.1k yield 743
   * or 744 at 16k depending on where the fractional position happens to be.
   * That is correct, not drift; a caller that assumes a fixed output size will
   * be wrong roughly half the time.
   */
  process(buf) {
    if (!buf || !buf.length) return Buffer.alloc(0);
    if (this.passthrough) return buf;

    // Rejoin a sample split across the previous chunk boundary.
    let input = buf;
    if (this.oddByte !== null) {
      input = Buffer.concat([this.oddByte, buf]);
      this.oddByte = null;
    }
    if (input.length % 2 === 1) {
      this.oddByte = input.subarray(input.length - 1);
      input = input.subarray(0, input.length - 1);
    }

    const n = input.length / 2;
    if (n === 0) return Buffer.alloc(0);

    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = input.readInt16LE(i * 2);
      for (const f of this.filters) v = f.run(v);
      samples[i] = v;
    }

    // Virtual index -1 is the previous chunk's last sample; 0..n-1 are this
    // chunk's. Stop as soon as the pair straddling `t` is not fully in hand and
    // let the rest of the interval carry over.
    const out = [];
    let t = this.pos;
    for (;;) {
      const i0 = Math.floor(t);
      if (i0 + 1 > n - 1) break;
      const s0 = i0 < 0 ? this.tail : samples[i0];
      const s1 = samples[i0 + 1];
      out.push(s0 + (s1 - s0) * (t - i0));
      t += this.step;
    }

    // Re-base the position onto the next chunk's coordinates and keep the seam
    // sample. `t - n` is always >= -1 by the loop's exit condition.
    this.pos = t - n;
    this.tail = samples[n - 1];

    const pcm = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      // Clamp rather than let writeInt16LE throw. The filter can overshoot by a
      // few percent on a transient that was already near full scale, and a
      // thrown error mid-call is a far worse outcome than one clipped sample.
      const v = Math.max(-32768, Math.min(32767, Math.round(out[i])));
      pcm.writeInt16LE(v, i * 2);
    }
    return pcm;
  }
}

/**
 * Convert a complete buffer in one call.
 *
 * For whole clips only — a phrase from the cache, a fixture in a test. Streams
 * must use a Resampler instance, or every chunk boundary clicks.
 */
export function resampleBuffer(buf, from, to) {
  return new Resampler({ from, to }).process(buf);
}
