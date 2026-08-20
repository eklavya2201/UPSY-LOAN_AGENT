// OCR layer: reads the text off an uploaded document image so the agent can
// auto-fill identifiers (PAN, Aadhaar) and cross-check the typed number against
// what is actually printed on the document.

import { createWorker } from "tesseract.js";
import { aadhaarChecksumValid } from "./validators.js";

let workerPromise = null;
function getWorker() {
  // One shared worker, created lazily on first use (first call downloads the
  // English model and caches it locally).
  if (!workerPromise) workerPromise = createWorker("eng");
  return workerPromise;
}

// Tear down the worker so the next call gets a fresh one. Used after a hard
// failure (e.g. a corrupt image), which can leave the worker unusable.
export function resetWorker() {
  const p = workerPromise;
  workerPromise = null;
  if (p) p.then((w) => w.terminate()).catch(() => {});
}

export async function extractText(buffer) {
  // Tesseract cannot read PDFs — handing one to worker.recognize() throws from the
  // worker thread on a later tick, which escapes this try/catch and crashes the process.
  // Bail out early: PDFs are handled by the vision path (Claude), and returning ""
  // here lets readCard degrade gracefully instead of taking the server down.
  if (buffer && buffer.length >= 4 &&
      buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "";
  }
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    return data.text || "";
  } catch {
    resetWorker();
    return "";
  }
}

// OCR routinely confuses these look-alikes. When we know a position must be a
// letter (or a digit), we can safely fix the common swaps.
const TO_LETTER = { "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B" };
const TO_DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };

// Coerce a 10-char token to the PAN shape AAAAA9999A, counting how many fixes
// it needed (fewer fixes = more likely a real read).
function coercePan(tok) {
  let out = "";
  let fixes = 0;
  for (let i = 0; i < 10; i++) {
    const ch = tok[i];
    const wantLetter = i < 5 || i === 9;
    if (wantLetter) {
      if (/[A-Z]/.test(ch)) out += ch;
      else if (TO_LETTER[ch]) { out += TO_LETTER[ch]; fixes++; }
      else return null;
    } else {
      if (/[0-9]/.test(ch)) out += ch;
      else if (TO_DIGIT[ch]) { out += TO_DIGIT[ch]; fixes++; }
      else return null;
    }
  }
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(out) ? { value: out, fixes } : null;
}

// Read the identifier out of raw OCR text.
// Returns { value, exact } — `exact` means a clean read (no fuzzy correction),
// which the caller can trust enough to hard-block a mismatch on.
export function readIdentifier(text, doc) {
  if (!doc.identifier || !text) return null;
  const flat = text.toUpperCase();

  if (/pan/i.test(doc.identifier.name)) {
    // 1) Clean exact match first.
    const exact = flat.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/);
    if (exact) return { value: exact[0], exact: true };
    // 2) Otherwise slide a 10-char window over the alphanumerics and pick the
    //    candidate needing the fewest OCR corrections.
    const clean = flat.replace(/[^A-Z0-9]/g, "");
    let best = null;
    for (let i = 0; i + 10 <= clean.length; i++) {
      const c = coercePan(clean.slice(i, i + 10));
      if (c && (!best || c.fixes < best.fixes)) best = c;
    }
    return best && best.fixes <= 3 ? { value: best.value, exact: false } : null;
  }

  if (/aadhaar/i.test(doc.identifier.name)) {
    // Strip any dates first (e.g. a DOB "22/01/2007"), so a DOB year can't be
    // mistaken for the first group of the Aadhaar number.
    const noDates = flat.replace(/\b\d{2}[\/\-.]\d{2}[\/\-.]\d{4}\b/g, " ");
    // Aadhaar is printed as three groups of four: "2345 6789 0123".
    const groups = [...noDates.matchAll(/\b([2-9]\d{3})[\s-]+(\d{4})[\s-]+(\d{4})\b/g)].map((m) => m[1] + m[2] + m[3]);
    for (const g of groups) if (aadhaarChecksumValid(g)) return { value: g, exact: true };
    if (groups.length) return { value: groups[0], exact: false };
    // Fallback: an unbroken 12-digit run. Turn every non-digit into a space
    // (never a digit) so the DOB and other numbers stay separate.
    const runs = noDates.replace(/[^0-9]/g, " ").match(/\b[2-9]\d{11}\b/g) || [];
    for (const c of runs) if (aadhaarChecksumValid(c)) return { value: c, exact: true };
    return runs.length ? { value: runs[0], exact: false } : null;
  }

  return null;
}

// Convenience wrapper for callers that only need the value (e.g. auto-fill).
export function findIdentifier(text, doc) {
  const r = readIdentifier(text, doc);
  return r ? r.value : null;
}

// Words that appear on ID cards but are never part of a person's name.
const NAME_STOPWORDS = new Set([
  "INCOME", "TAX", "DEPARTMENT", "DEPT", "GOVT", "GOVERNMENT", "OF", "INDIA", "PERMANENT",
  "ACCOUNT", "NUMBER", "SIGNATURE", "FATHER", "FATHERS", "DATE", "BIRTH", "MALE", "FEMALE",
  "AADHAAR", "UNIQUE", "IDENTIFICATION", "AUTHORITY", "DOB", "YEAR", "NAME", "ENROLLMENT", "VID", "CARD",
]);

function looksLikeName(line) {
  const words = line.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z.]+$/.test(w) && !NAME_STOPWORDS.has(w.toUpperCase()));
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, " ").trim();

// Pull the person's name off the card. Prefers the line after a "Name" label,
// then falls back to the first line that looks like a name.
export function extractName(text) {
  if (!text) return null;
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (/^name\b/i.test(lines[i]) && !/father/i.test(lines[i])) {
      const sameLine = lines[i].replace(/^name[:\s]*/i, "").trim();
      if (looksLikeName(sameLine)) return titleCase(sameLine);
      if (lines[i + 1] && looksLikeName(lines[i + 1])) return titleCase(lines[i + 1]);
    }
  }
  const guess = lines.find(looksLikeName);
  return guess ? titleCase(guess) : null;
}

// Pull a date of birth (DD/MM/YYYY and similar separators).
export function extractDob(text) {
  if (!text) return null;
  const m = text.match(/\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

// Do two names refer to the same person, tolerant of OCR noise / word order?
// Returns true/false, or null if we can't tell.
export function namesMatch(a, b) {
  // ⚠️ NOT [^A-Z\s] — Aadhaar and PAN cards are BILINGUAL, and a vision model
  // reading the Devanagari side returns a Devanagari name. The Latin-only class
  // deleted it entirely, so the comparison degraded to "can't tell" on exactly
  // the documents this product is built for.
  //
  // The half-and-half case was worse than the empty one. "राहुल SHARMA" reduced
  // to the single token "SHARMA", and one shared surname clears the 0.5
  // threshold — so two different people could be reported as the same person on
  // the strength of a surname the comparison never should have been left alone
  // with. \p{M} is included for the same reason as everywhere else: Devanagari
  // vowel signs are marks, and dropping them mangles the word into a different
  // one. toUpperCase() is a harmless no-op on scripts without case.
  const norm = (s) => s.toUpperCase().replace(/[^\p{L}\p{M}\s]/gu, "").replace(/\s+/g, " ").trim();
  const ta = new Set(norm(a).split(" ").filter(Boolean));
  const tb = new Set(norm(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return null;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size) >= 0.5;
}

// Do two addresses look like the same place, tolerant of free-text formatting
// (line order, abbreviations, punctuation)? Returns true/false, or null if too
// short to judge either way. Deliberately lenient (Jaccard over token union,
// low threshold) — addresses vary in how they're written far more than names,
// so we'd rather miss a real mismatch than spam false conflicts.
export function addressesMatch(a, b) {
  // Same reasoning as namesMatch above: an Aadhaar address is very often in the
  // regional script, and the Latin-only class threw all of it away. Digits stay
  // in, because a house or PIN number is often the most distinguishing token an
  // address has.
  const norm = (s) => s.toUpperCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const ta = new Set(norm(a).split(" ").filter(Boolean));
  const tb = new Set(norm(b).split(" ").filter(Boolean));
  if (ta.size < 2 || tb.size < 2) return null;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const union = ta.size + tb.size - common;
  return union > 0 && common / union >= 0.3;
}

// Is this buffer an image we can OCR? (PDF text extraction is out of scope here.)
export function isOcrable(buffer) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  return (
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) // PNG
  );
}
