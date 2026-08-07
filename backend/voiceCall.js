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
// ── Providers ───────────────────────────────────────────────────────────────
// Two, selected by VOICE_PROVIDER:
//
//   "upsy"     — our own relay (backend/voiceRelay.js). The audio DOES pass
//                through this server, because we are the ones running STT, the
//                LLM and TTS. Speaks Hindi, keeps the prompt in git, and cannot
//                be switched off by someone else's free-tier policy.
//   "cartesia" — the hosted agent. Kept because it is proven up to the provider
//                boundary and costs nothing to leave in place, but it is
//                unusable today: Cartesia has paused agent deployments for free
//                accounts, so every call fails at checkAgentReady().
//
// The browser is identical either way. frontend/voiceClient.js only knows "PCM
// over a WebSocket", which is exactly why this swap is a server-side change.

import { getApplication } from "./store.js";
import { buildContextPayload } from "./liveAssistManager.js";
import { DOCUMENTS, STAGES } from "./documents.js";
import { buildVoiceSystemPrompt, buildIntroduction } from "./voicePrompt.js";
import { mintRelayTicket, relayConfigError, RELAY_PATH, SAMPLE_RATE as RELAY_SAMPLE_RATE } from "./voiceRelay.js";

const PROVIDER = (process.env.VOICE_PROVIDER || "cartesia").toLowerCase();

// Cartesia pins behaviour to a dated API version. Bump this only after
// re-reading their changelog — a newer date can change event shapes.
const CARTESIA_VERSION = process.env.CARTESIA_VERSION || "2025-04-16";
const CARTESIA_HOST = "api.cartesia.ai";

// 44.1kHz is what the browser AudioContext runs at natively on most phones, so
// sending pcm_44100 avoids a resample step on the client. Must match the
// SAMPLE_RATE constant in frontend/voiceClient.js.
export const INPUT_FORMAT = "pcm_44100";
export const SAMPLE_RATE = 44100;

// Short-lived on purpose: this token reaches the browser, so it is scoped to
// the agent grant only and expires quickly. The account API key never leaves
// this process. Ten minutes covers a normal call; a longer one reconnects.
const TOKEN_TTL_SECONDS = 600;

export function voiceConfigured() {
  if (PROVIDER === "upsy") return !relayConfigError();
  if (PROVIDER === "cartesia") {
    return Boolean(process.env.CARTESIA_API_KEY && process.env.CARTESIA_AGENT_ID);
  }
  return false;
}

// What is missing, specifically — a bare "not configured" sends whoever hits
// this hunting through the README, which is the failure mode the startup
// reader-priority log was added to avoid elsewhere in this repo.
export function voiceConfigError() {
  if (PROVIDER === "upsy") return relayConfigError();
  if (PROVIDER !== "cartesia") {
    return `VOICE_PROVIDER is "${PROVIDER}", but only "upsy" and "cartesia" are implemented.`;
  }
  const missing = [];
  if (!process.env.CARTESIA_API_KEY) missing.push("CARTESIA_API_KEY");
  if (!process.env.CARTESIA_AGENT_ID) missing.push("CARTESIA_AGENT_ID");
  if (!missing.length) return null;
  return `Voice calling isn't configured yet — set ${missing.join(" and ")} in .env (see the Voice calls section of the README).`;
}

export function voiceStatusLine() {
  if (!voiceConfigured()) return `Voice calls: not configured (${voiceConfigError()})`;
  if (PROVIDER === "upsy") return `Voice calls: upsy relay at ${RELAY_PATH} (${INPUT_FORMAT})`;
  return `Voice calls: ${PROVIDER} (agent ${String(process.env.CARTESIA_AGENT_ID).slice(0, 8)}…, ${INPUT_FORMAT})`;
}

export function voiceProvider() {
  return PROVIDER;
}

// ── Agent readiness ─────────────────────────────────────────────────────────
// A Cartesia agent that has been created but never deployed accepts the
// WebSocket handshake and then closes it with `1011 Internal server error` —
// no mention of deployment anywhere in the close reason. From the phone that is
// indistinguishable from a bug in our own code, and it cost a debugging session
// once already (the call sheet vanishing a second after "Connecting…").
//
// So check it here, where we can say what is actually wrong, instead of letting
// the browser discover it as an opaque close code.
const AGENT_READY_TTL_MS = 10 * 60 * 1000;
let agentReadyUntil = 0;

function notDeployedMessage() {
  return (
    "The Cartesia agent exists but has never been deployed, so calls are refused " +
    "with an unhelpful internal-server-error close. Open the agent at play.cartesia.ai " +
    "and press Publish/Deploy, then try again."
  );
}

/**
 * Ask Cartesia whether the configured agent can actually take a call.
 * @returns {Promise<{ok: boolean, reason?: string, agent?: object}>}
 */
export async function checkAgentReady({ force = false } = {}) {
  if (!force && Date.now() < agentReadyUntil) return { ok: true, cached: true };

  const res = await fetch(
    `https://${CARTESIA_HOST}/agents/${encodeURIComponent(process.env.CARTESIA_AGENT_ID)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
        "Cartesia-Version": CARTESIA_VERSION,
      },
    }
  );

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Cartesia rejected the API key. Check CARTESIA_API_KEY in .env." };
  }
  if (res.status === 404) {
    return { ok: false, reason: `No Cartesia agent with id ${process.env.CARTESIA_AGENT_ID}. Check CARTESIA_AGENT_ID in .env.` };
  }
  if (!res.ok) {
    // Cartesia itself is unhappy for some other reason. Don't block the call on
    // our own preflight — the socket is the authority, and a working call must
    // not be prevented by a flaky status endpoint.
    return { ok: true, unverified: true, reason: `agent status check returned HTTP ${res.status}` };
  }

  const agent = await res.json();
  if (agent.is_live === false || agent.deployment_count === 0) {
    return { ok: false, reason: notDeployedMessage(), agent };
  }

  agentReadyUntil = Date.now() + AGENT_READY_TTL_MS;
  return { ok: true, agent };
}

// Mint a browser-safe credential. Cartesia's account key (sk_car_…) grants full
// account access and must never be sent to a client; /access-token exchanges it
// for a scoped, expiring one.
async function mintCartesiaToken() {
  const res = await fetch(`https://${CARTESIA_HOST}/access-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
      "Cartesia-Version": CARTESIA_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grants: { agent: true }, expires_in: TOKEN_TTL_SECONDS }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cartesia rejected the token request (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.token) throw new Error("Cartesia returned no token.");
  return json.token;
}

// Browsers cannot set headers on a WebSocket handshake, so both the credential
// and the API version go in the query string — Cartesia documents
// ?access_token= for exactly this case, and ?cartesia_version= takes precedence
// over the header.
function cartesiaSignedUrl(token) {
  const agentId = encodeURIComponent(process.env.CARTESIA_AGENT_ID);
  const params = new URLSearchParams({ access_token: token, cartesia_version: CARTESIA_VERSION });
  return `wss://${CARTESIA_HOST}/agents/stream/${agentId}?${params}`;
}

// The next document this applicant still owes, so the agent can answer "what's
// pending?" with one item instead of reciting the checklist. Mirrors the
// done/applicable logic in server.js's buildAgenda().
function nextPendingDocument(app) {
  const loanType = app.profile?.loanType;
  const applicable = DOCUMENTS.filter((d) => !(loanType === "unsecured" && d.stage === "collateral"));
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

// Our own relay. The prompt is deliberately NOT returned to the browser here —
// it is stored server-side against the ticket and read back when the socket
// opens. On the Cartesia path the browser had to forward the prompt because the
// socket went straight to the vendor; now that the socket terminates on our own
// server, sending the agent's instructions to the client and trusting them back
// would be handing an anonymous caller an edit box for the loan rules.
function createRelaySession({ leadId, context, origin, language }) {
  const token = mintRelayTicket({
    leadId,
    language,
    systemPrompt: buildVoiceSystemPrompt(context),
    introduction: buildIntroduction(context),
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
 * @param {string|null} opts.origin - this server's own origin, used to build
 *   the relay URL on the "upsy" path. Ignored by the Cartesia path.
 * @param {string} opts.language - "en" today; the seam for Hindi via Sarvam.
 * @returns {Promise<object>} everything the browser needs to open the socket.
 */
export async function createVoiceSession({ leadId = null, origin = null, language = "en" } = {}) {
  const err = voiceConfigError();
  if (err) throw Object.assign(new Error(err), { code: "NOT_CONFIGURED" });

  const context = await loadCallerContext(leadId);

  if (PROVIDER === "upsy") {
    return createRelaySession({ leadId, context, origin, language });
  }

  // Cheap after the first success (cached for 10 minutes) and it converts the
  // single most confusing failure this feature has into a sentence that names
  // the fix. A network problem reaching the check is not a reason to block —
  // checkAgentReady() reports ok:true/unverified for that case.
  const ready = await checkAgentReady();
  if (!ready.ok) throw Object.assign(new Error(ready.reason), { code: "AGENT_NOT_READY" });
  if (ready.unverified) console.warn(`[voice] proceeding without a readiness check: ${ready.reason}`);

  const token = await mintCartesiaToken();

  return {
    provider: PROVIDER,
    signedUrl: cartesiaSignedUrl(token),
    expiresInSeconds: TOKEN_TTL_SECONDS,
    // Sent verbatim by the client as the WebSocket `start` event.
    config: { input_format: INPUT_FORMAT, output_audio_delivery: "as_available" },
    agent: {
      system_prompt: buildVoiceSystemPrompt(context),
      introduction: buildIntroduction(context),
    },
    // Non-sensitive routing/reporting facts only. Anything here is visible to
    // the provider, so it follows the same rule as the prompt: names yes,
    // ID numbers never.
    metadata: { product: "upsy-loan-agent", lead_id: leadId || null, known_applicant: Boolean(context) },
    // Purely so the UI can greet correctly without a second round trip.
    caller: context ? { name: context.name, known: true } : { name: null, known: false },
  };
}
