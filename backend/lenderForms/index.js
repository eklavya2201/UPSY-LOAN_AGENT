// Registry of per-site screen/field guides for the live-assist agent.
//
// "lenderForms" is now a slight misnomer kept for continuity: entries are the
// PARTNER PORTALS an applicant passes through, which includes a marketplace
// (upsy.in) as well as actual lenders (Avanse). They are listed in journey
// order — the site the applicant sees first comes first.
//
// There is deliberately NO code-side "which site is this call for" flag. The
// applicant learns which lender they are dealing with from an email UPSY has
// no record of, and a single call crosses several domains anyway. So every
// known portal goes into the prompt together and the agent — which can already
// see the shared screen — works out which one is in front of it from the URL
// bar or logo, the same way it already reads ID cards elsewhere in this repo.
//
// To add a portal: create backend/lenderForms/<name>.js exporting the same
// shape as avanse.js (id, displayName, matchHints, crossCuttingRules, screens,
// proactiveGuidance, openQuestions), then add it to PORTALS below in the
// position the applicant reaches it.

import * as upsyIn from "./upsyIn.js";
import * as avanse from "./avanse.js";

export const PORTALS = [upsyIn, avanse];

// Kept as an alias so older imports/readers looking for LENDERS still work.
export const LENDERS = PORTALS;

function renderScreen(screen) {
  const lines = [`  SCREEN: ${screen.name}${screen.url ? ` (${screen.url})` : ""}`];
  for (const f of screen.fields || []) {
    lines.push(`    - ${f.field}${f.required ? " [required]" : " [optional]"}: ${f.notes}`);
  }
  if (screen.agentNote) lines.push(`    Guidance: ${screen.agentNote}`);
  return lines.join("\n");
}

function renderPortal(portal) {
  const parts = [`### ${portal.displayName}`, `Recognise it from: ${portal.matchHints.join(", ")}.`];
  if (portal.crossCuttingRules?.length) {
    parts.push("  Rules that apply on EVERY screen of this site:");
    parts.push(...portal.crossCuttingRules.map((r) => `    * ${r}`));
  }
  parts.push(...portal.screens.map(renderScreen));
  if (portal.proactiveGuidance?.length) {
    parts.push("  Say these without being asked, at the right moment:");
    parts.push(...portal.proactiveGuidance.map((g) => `    - ${g}`));
  }
  if (portal.openQuestions?.length) {
    parts.push("  NOT confirmed — say you do not know rather than stating these:");
    parts.push(...portal.openQuestions.map((q) => `    - ${q}`));
  }
  return parts.join("\n");
}

// Renders every registered portal's guide into one block for the system
// prompt. Returns "" when nothing is registered, so callers can splice it in
// unconditionally.
export function buildLenderGuidancePrompt() {
  if (!PORTALS.length) return "";
  return (
    "\n\nPARTNER PORTAL GUIDANCE — the applicant's shared screen may show any of the websites below, and a single call usually crosses more than " +
    "one of them, in the order listed. Work out which site is on screen RIGHT NOW by looking at the URL bar, logo and page text — never assume, and " +
    "re-check when they navigate. Then use only that site's guidance. If the screen matches none of them, say plainly that you do not have specific " +
    "guidance for that page and help from general knowledge instead.\n\n" +
    PORTALS.map(renderPortal).join("\n\n")
  );
}
