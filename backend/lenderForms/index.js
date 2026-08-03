// Registry of per-lender field/screen guides for the live-assist agent.
//
// There is deliberately NO code-side "which lender is this call for" flag —
// the applicant learns which lender they're dealing with from an email/SMS
// UPSY or the lender sent them, not from anything UPSY's own UI records, so
// there's nothing reliable to select from on our side. Instead, all known
// lenders' guides are put in the prompt together, and the agent (which can
// already see the shared screen) identifies the lender itself from the URL
// bar or logo, the same way it already reads PAN/Aadhaar cards elsewhere in
// this repo.
//
// To add a new lender: create backend/lenderForms/<name>.js exporting the
// same shape as avanse.js (id, displayName, matchHints, screens,
// proactiveGuidance, openQuestions), then add it to LENDERS below.

import * as avanse from "./avanse.js";

export const LENDERS = [avanse];

function renderScreen(screen) {
  const lines = [`  Screen: ${screen.name}${screen.url ? ` (${screen.url})` : ""}`];
  for (const f of screen.fields || []) {
    lines.push(`    - ${f.field}${f.required ? " [required]" : " [optional]"}: ${f.notes}`);
  }
  if (screen.agentNote) lines.push(`    Note: ${screen.agentNote}`);
  return lines.join("\n");
}

function renderLender(lender) {
  const parts = [
    `### ${lender.displayName}`,
    `Recognise this lender from: ${lender.matchHints.join(", ")}.`,
    ...lender.screens.map(renderScreen),
  ];
  if (lender.proactiveGuidance?.length) {
    parts.push("  Say proactively, without being asked:");
    parts.push(...lender.proactiveGuidance.map((g) => `    - ${g}`));
  }
  if (lender.openQuestions?.length) {
    parts.push("  Not yet confirmed — do not state these as fact:");
    parts.push(...lender.openQuestions.map((q) => `    - ${q}`));
  }
  return parts.join("\n");
}

// Renders every known lender's guide into one block for the system prompt.
// Returns "" if no lenders are registered yet, so callers can splice it in
// unconditionally.
export function buildLenderGuidancePrompt() {
  if (!LENDERS.length) return "";
  return (
    "\n\nPartner-lender form guidance — you may be looking at any one of these lenders' real websites on the applicant's shared screen. " +
    "First work out which one (if any) is on screen right now from the URL bar, logo, or page text — never assume; look. Then use ONLY that " +
    "lender's guidance below. If the screen doesn't match any lender listed here, say plainly that you don't have specific guidance for that " +
    "site yet and fall back to general help.\n\n" +
    LENDERS.map(renderLender).join("\n\n")
  );
}
