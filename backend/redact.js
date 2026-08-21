// Keep applicants' personal data out of the logs.
//
// The server logged full PAN and Aadhaar numbers, names, dates of birth,
// addresses and phone numbers in plaintext. Every log sink inherits a copy of
// that — the console, the file, CloudWatch, anything shipping logs off the box —
// and redacting later does not un-ship what already left. It is the one item in
// the pre-launch list where the damage is done before anyone notices.
//
// ── Why not simply drop the fields ──────────────────────────────────────────
// Because of what these lines are FOR. `[capture]` and `[identity]` exist to
// answer "did the vision model read this document correctly, and does the name
// on it match the name on the other one" — the question behind the whole fraud
// check. A log line reading `name="***"` cannot answer it, so it would be
// deleted within a week and the next person would add the plaintext back.
//
// So these masks are PARTIAL AND DETERMINISTIC: the same input always produces
// the same output, and enough shape survives to see that two values differ, or
// that the model returned garbage. What does not survive is enough to identify
// or impersonate anybody.
//
//     "ABCDE1234F"        → "••••••234F"
//     "Rahul Sharma"      → "R••••l S••••a"
//     "9876543210"        → "••••••3210"
//     "12 MG Road, Pune"  → "…d, Pune (16 chars)"
//
// ⚠️ MASK AT THE CALL SITE, NOT AT THE SINK. A log pipeline that strips PII
// downstream still had the plaintext in memory, in the process's stdout, and in
// whatever buffered it. The only place it is genuinely absent is a line that
// never contained it.

// Escape hatch for local debugging against a real document. Off unless asked
// for explicitly, and named so that finding it switched on in production is
// unambiguous rather than a shrug.
const SHOW_PII = process.env.LOG_PII === "1";

const DOT = "•";

/** An ID number — PAN, Aadhaar, account, card. Last four survive. */
export function idNumber(value) {
  const s = String(value ?? "").trim();
  if (!s) return "-";
  if (SHOW_PII) return s;
  if (s.length <= 4) return DOT.repeat(s.length);
  return DOT.repeat(Math.min(s.length - 4, 8)) + s.slice(-4);
}

/**
 * A person's name. First and last character of each word survive.
 *
 * Enough to see "these two documents disagree" at a glance, and enough to spot
 * the model returning something that is not a name at all — which is the
 * failure this log line was added to catch.
 */
export function personName(value) {
  const s = String(value ?? "").trim();
  if (!s) return "-";
  if (SHOW_PII) return s;
  return s
    .split(/\s+/)
    .map((w) => {
      if (w.length <= 1) return DOT;
      if (w.length === 2) return w[0] + DOT;
      return w[0] + DOT.repeat(Math.min(w.length - 2, 4)) + w[w.length - 1];
    })
    .join(" ");
}

/** A phone number. Last four survive, which is how people identify their own. */
export function phone(value) {
  const s = String(value ?? "").replace(/\s+/g, "");
  if (!s) return "-";
  if (SHOW_PII) return s;
  if (s.length <= 4) return DOT.repeat(s.length);
  return DOT.repeat(Math.min(s.length - 4, 6)) + s.slice(-4);
}

/**
 * A date of birth. The year survives.
 *
 * A year alone is weak identifying data and it is the part that actually gets
 * compared — a document read wrongly usually gets the year wrong too, and two
 * documents for the same person should agree on it.
 */
export function dob(value) {
  const s = String(value ?? "").trim();
  if (!s) return "-";
  if (SHOW_PII) return s;
  const year = s.match(/\b(19|20)\d{2}\b/);
  return year ? `${DOT}${DOT}-${DOT}${DOT}-${year[0]}` : DOT.repeat(Math.min(s.length, 8));
}

/**
 * A postal address. The tail survives, plus the length.
 *
 * The tail is usually the city and PIN, which is the part a mismatch check
 * turns on; the house number and street — the part that actually locates a
 * person — is what goes. Length is kept because "the model returned four
 * characters" is a real failure worth seeing.
 */
export function address(value) {
  const s = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "-";
  if (SHOW_PII) return s;
  const tail = s.length > 10 ? `…${s.slice(-10)}` : DOT.repeat(s.length);
  return `${tail} (${s.length} chars)`;
}

/**
 * Money is deliberately NOT masked, and that is a judgement worth stating.
 *
 * A rupee figure on its own identifies nobody, it is the value these pipelines
 * exist to compute, and it is the number that goes wrong — this repo has caught
 * the same payslip read as ₹1,39,100 and ₹13,91,000, and as an annual figure
 * reported as monthly. Masking it would remove the only evidence of the bug
 * class most likely to reach an applicant's file.
 *
 * It is still personal data in a lending context, so it stays paired with a
 * lead id rather than with a name, and it is worth revisiting if logs are ever
 * shipped somewhere with a wider audience than the team.
 */
export function money(value) {
  return value == null || value === "" ? "-" : String(value);
}
