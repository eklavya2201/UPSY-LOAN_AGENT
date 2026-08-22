// Browser voice calls — the applicant taps a button on their phone and talks to
// UPSY, with no meeting platform involved at all.
//
// This is the README's "Step 2 — in-app voice widget", and it is deliberately a
// different thing from backend/liveAssist.js:
//
//   liveAssist.js  — AgentCall bot JOINS a Google Meet, watches a screen share
//                    of a lender's form, one call at a time server-wide.
//   voiceCall.js   — the caller's own browser IS the call. No meeting, no bot,
//                    no global lock; concurrency is whatever the provider allows.
//
// Division of labour: this server only mints a short-lived, scoped credential
// and hands the browser a URL plus the prompt. The audio itself never touches
// us — the browser streams microphone PCM straight to the provider and plays
// the reply back (see frontend/voiceClient.js). That also means no applicant
// audio is stored on our disk.
//
// ── Provider ────────────────────────────────────────────────────────────────
// One: "upsy", our own relay (backend/voiceRelay.js). The audio DOES pass
// through this server, because we are the ones running STT, the LLM and TTS.
// It speaks eleven languages, keeps the prompt in git, and cannot be switched
// off by someone else's free-tier policy.
//
// There used to be a second, "cartesia" — a HOSTED agent, where the browser
// streamed straight to the vendor and they ran the whole call. It was removed
// on 2026-08-22. It had been unusable since Cartesia paused agent deployments
// for free accounts (every call failed at the readiness check), and it was
// never a real fallback: it could only ever replace the WHOLE call, and this
// file's own default made "forgot to set VOICE_PROVIDER" route every caller to
// it. The backup that actually works is per-engine and lives a layer down —
// STT_PROVIDER=sarvam and TTS_PROVIDER=sarvam move hearing and speaking off
// Deepgram without touching this file. See voiceSarvam.js.
//
// VOICE_PROVIDER is still read, and still rejected loudly if it says anything
// else, so a stale value in someone's .env or on Render fails with a sentence
// naming the problem rather than silently doing something different.

import { getApplication } from "./store.js";
import { buildContextPayload } from "./liveAssistManager.js";
import { STAGES, applicableDocuments } from "./documents.js";
import { buildVoiceSystemPrompt, buildIntroduction } from "./voicePrompt.js";
import { accountIdentityFacts } from "./callSchema.js";
import { mintRelayTicket, relayConfigError, RELAY_PATH, SAMPLE_RATE as RELAY_SAMPLE_RATE } from "./voiceRelay.js";

// Defaults to the only implementation there is. It used to default to
// "cartesia", which meant a deploy that lost this variable sent every caller to
// a hosted agent that refused the call — the failure had nothing to do with
// voice and named nothing useful.
const PROVIDER = (process.env.VOICE_PROVIDER || "upsy").toLowerCase();

// 44.1kHz is what the browser AudioContext runs at natively on most phones, so
// sending pcm_44100 avoids a resample step on the client. Must match the
// SAMPLE_RATE constant in frontend/voiceClient.js.
export const INPUT_FORMAT = "pcm_44100";
export const SAMPLE_RATE = 44100;

export function voiceConfigured(language = "en") {
  if (PROVIDER === "upsy") return !relayConfigError(language);
  return false;
}

// What is missing, specifically — a bare "not configured" sends whoever hits
// this hunting through the README, which is the failure mode the startup
// reader-priority log was added to avoid elsewhere in this repo.
export function voiceConfigError(language = "en") {
  if (PROVIDER === "upsy") return relayConfigError(language);
  // Names the fix rather than the symptom. "cartesia" gets its own sentence
  // because it was a working value until 2026-08-22 and will still be sitting
  // in older .env files and in anyone's Render dashboard.
  if (PROVIDER === "cartesia") {
    return 'VOICE_PROVIDER is "cartesia", which was removed on 2026-08-22 — set VOICE_PROVIDER=upsy.';
  }
  return `VOICE_PROVIDER is "${PROVIDER}", but "upsy" is the only implementation.`;
}

export function voiceStatusLine() {
  if (!voiceConfigured()) return `Voice calls: not configured (${voiceConfigError()})`;
  return `Voice calls: upsy relay at ${RELAY_PATH} (${INPUT_FORMAT})`;
}

export function voiceProvider() {
  return PROVIDER;
}

// The next document this applicant still owes, so the agent can answer "what's
// pending?" with one item instead of reciting the checklist. Mirrors the
// done/applicable logic in server.js's buildAgenda().
function nextPendingDocument(app) {
  const applicable = applicableDocuments({
    loanType: app.profile?.loanType,
    coApplicantType: app.profile?.coApplicantType,
  });
  const have = new Set([...(app.onFile || []), ...Object.keys(app.verifiedDocs || {})]);
  const next = applicable.find((d) => !have.has(d.id));
  if (!next) return null;
  const stage = STAGES.find((s) => s.id === next.stage);
  return stage ? `${next.label} (${stage.title})` : next.label;
}

// The applicant's own facts, or null for an anonymous caller. Shared by both
// providers so the two paths can never drift on what the agent knows.
async function loadCallerContext(leadId) {
  if (!leadId) return null;
  try {
    const app = await getApplication(leadId);
    // getApplication() creates an empty shell for an unknown id, so an
    // absent profile is the real "we don't know this person" signal.
    if (!app?.profile?.name) return null;
    const context = buildContextPayload(app);
    context.nextDocument = nextPendingDocument(app);
    return context;
  } catch (e) {
    console.error(`[voice] could not load lead ${leadId}, continuing anonymously:`, e.message);
    return null;
  }
}

/**
 * Fold an /m account into the caller context.
 *
 * The two identities are independent and both optional — someone can have an
 * account and no lead, a lead and no account, or both — so this merges rather
 * than choosing. The lead record wins wherever they disagree: it is built from
 * verified documents and the eligibility engine, whereas the account's profile
 * is what a conversation established, which is weaker evidence.
 *
 * `priorFacts` is deliberately opaque here. Whatever the call captures gets
 * stored under it and rendered generically by voicePrompt.js, so adding a field
 * to what the agent collects needs no change in this file.
 */
function mergeCallerContext(leadContext, account) {
  if (!leadContext && !account) return null;
  const context = { ...(leadContext || {}) };
  if (account) {
    context.accountId = account.accountId;
    if (!context.name) context.name = account.name;
    context.callCount = account.callCount || 0;
    context.lastCallAt = account.lastCallAt || null;
    // What the calls established, on top of what signup already told us. The
    // stored profile wins: if a call corrected the name, that is the newer
    // fact. Merged here rather than only at signup so accounts created before
    // this existed also stop being asked for a name we have.
    const identity = accountIdentityFacts(account);
    const profile = account.profile || {};
    const merged = {
      ...identity,
      ...profile,
      applicant: { ...(identity.applicant || {}), ...(profile.applicant || {}) },
    };
    if (Object.keys(merged).length) context.priorFacts = merged;
  }
  return context;
}

// Our own relay. The prompt is deliberately NOT returned to the browser here —
// it is stored server-side against the ticket and read back when the socket
// opens. The removed hosted path had to forward the prompt through the browser
// because the socket went straight to the vendor; now that the socket terminates
// on our own server, sending the agent's instructions to the client and trusting
// them back would be handing an anonymous caller an edit box for the loan rules.
// Words this caller is more likely to say than a stranger would be: their own
// name, and their institute if an earlier call established one. Split into parts
// as well as the whole, because someone says "Eklavya" far more often than
// "Eklavya Pandey", and a boosted term only helps when it matches what was said.
function callerKeyterms(context) {
  const facts = context?.priorFacts || {};
  const terms = new Set();
  for (const value of [context?.name, facts.applicant?.name, facts.institute?.name]) {
    const text = String(value || "").trim();
    if (!text) continue;
    terms.add(text);
    for (const part of text.split(/\s+/)) if (part.length > 2) terms.add(part);
  }
  return [...terms];
}

function createRelaySession({ leadId, accountId, context, origin, language }) {
  const token = mintRelayTicket({
    leadId,
    // The relay writes the finished call against this. On the ticket rather
    // than sent by the browser, for the same reason the prompt is: the client
    // must not be able to name the account a transcript gets filed under.
    accountId,
    language,
    // "auto" is not a language anything can be written in, so both of these are
    // built for what the call actually OPENS in — English — and the relay
    // rebuilds them the moment detection names something else. The greeting for
    // auto is not plain English though: it invites the caller to use their own
    // language, because detection cannot do anything until they say something,
    // and someone who assumes the machine only speaks English will speak English.
    systemPrompt: buildVoiceSystemPrompt(context, language === "auto" ? "en" : language),
    introduction: buildIntroduction(context, language),
    // Kept so the relay can REBUILD the prompt mid-call once it has read new
    // facts out of the conversation. Without it the document list and the
    // agenda would be frozen at whatever was known when the phone rang, and a
    // caller who says "my father is salaried" in minute two would still be
    // hearing about three years of ITR in minute five. Server-side only — this
    // is the same object the prompt is built from, and it never goes to the
    // browser for the reason stated above.
    context,
    // Proper nouns this caller is likely to say, handed to the recogniser as
    // boosted terms. The standing keyterm list in voiceStt.js covers the
    // vocabulary of lending; this covers the vocabulary of one person.
    keyterms: callerKeyterms(context),
  });

  const wsOrigin = String(origin || "").replace(/^http/, "ws");
  return {
    provider: "upsy",
    signedUrl: `${wsOrigin}${RELAY_PATH}?token=${encodeURIComponent(token)}`,
    expiresInSeconds: 300,
    config: { input_format: `pcm_${RELAY_SAMPLE_RATE}`, output_audio_delivery: "as_available" },
    // Sent by the client in its `start` event and ignored by the relay, for the
    // reason above. Kept in the response only so the two providers return the
    // same shape and voiceClient.js needs no branch.
    agent: {},
    metadata: { product: "upsy-loan-agent", lead_id: leadId || null, known_applicant: Boolean(context) },
    caller: context ? { name: context.name, known: true } : { name: null, known: false },
  };
}

/**
 * Start a voice session.
 *
 * @param {object} opts
 * @param {string|null} opts.leadId - a signed-in applicant's lead id, or null
 *   for an anonymous caller from the public mobile page. An unknown leadId is
 *   treated as anonymous rather than failing: a stale id in someone's tab
 *   should downgrade the call, never block it.
 * @param {object|null} opts.account - an /m account in publicAccount() shape,
 *   already resolved from the request's bearer token, or null. Never the raw
 *   record — see the note at the call site. Independent of leadId; both, either
 *   or neither may be present. See mergeCallerContext().
 * @param {string|null} opts.origin - this server's own origin, used to build
 *   the relay URL.
 * @param {string} opts.language - "en", any language voiceSarvam.js carries, or
 *   "auto" to let the recogniser name it from the caller's first words.
 * @returns {Promise<object>} everything the browser needs to open the socket.
 */
export async function createVoiceSession({ leadId = null, account = null, origin = null, language = "en" } = {}) {
  // Checked for THIS call's language, not in general. A deployment with a
  // Deepgram key and no Sarvam key can run English calls perfectly well, and
  // the Marathi request is the only one that should be refused — refused HERE,
  // with a sentence naming the missing key, rather than by makeTts throwing
  // after the caller's socket has already opened and they are listening to it.
  const err = voiceConfigError(language);
  if (err) throw Object.assign(new Error(err), { code: "NOT_CONFIGURED" });

  const context = mergeCallerContext(await loadCallerContext(leadId), account);

  return createRelaySession({ leadId, accountId: account?.accountId || null, context, origin, language });
}
