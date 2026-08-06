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
// Cartesia today. The client side is provider-agnostic by construction (it is
// just "PCM over a WebSocket"), so adding Sarvam/Deepgram later is a matter of
// writing a second builder below and switching VOICE_PROVIDER — the browser
// code does not change. Sarvam matters because it speaks Hindi and regional
// languages, which Cartesia's English-first voices do not cover well and which
// is a genuine product gap for Indian applicants.

import { getApplication } from "./store.js";
import { buildContextPayload } from "./liveAssistManager.js";
import { DOCUMENTS, STAGES } from "./documents.js";
import { buildVoiceSystemPrompt, buildIntroduction } from "./voicePrompt.js";

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
  if (PROVIDER === "cartesia") {
    return Boolean(process.env.CARTESIA_API_KEY && process.env.CARTESIA_AGENT_ID);
  }
  return false;
}

// What is missing, specifically — a bare "not configured" sends whoever hits
// this hunting through the README, which is the failure mode the startup
// reader-priority log was added to avoid elsewhere in this repo.
export function voiceConfigError() {
  if (PROVIDER !== "cartesia") {
    return `VOICE_PROVIDER is "${PROVIDER}", but only "cartesia" is implemented today.`;
  }
  const missing = [];
  if (!process.env.CARTESIA_API_KEY) missing.push("CARTESIA_API_KEY");
  if (!process.env.CARTESIA_AGENT_ID) missing.push("CARTESIA_AGENT_ID");
  if (!missing.length) return null;
  return `Voice calling isn't configured yet — set ${missing.join(" and ")} in .env (see the Voice calls section of the README).`;
}

export function voiceStatusLine() {
  if (!voiceConfigured()) return "Voice calls: not configured";
  return `Voice calls: ${PROVIDER} (agent ${String(process.env.CARTESIA_AGENT_ID).slice(0, 8)}…, ${INPUT_FORMAT})`;
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

/**
 * Start a voice session.
 *
 * @param {object} opts
 * @param {string|null} opts.leadId - a signed-in applicant's lead id, or null
 *   for an anonymous caller from the public mobile page. An unknown leadId is
 *   treated as anonymous rather than failing: a stale id in someone's tab
 *   should downgrade the call, never block it.
 * @returns {Promise<object>} everything the browser needs to open the socket.
 *   The system prompt is included so the whole agent definition lives in this
 *   repo and is reviewable in git, rather than on a vendor dashboard.
 */
export async function createVoiceSession({ leadId = null } = {}) {
  const err = voiceConfigError();
  if (err) throw Object.assign(new Error(err), { code: "NOT_CONFIGURED" });

  let context = null;
  if (leadId) {
    try {
      const app = await getApplication(leadId);
      // getApplication() creates an empty shell for an unknown id, so an
      // absent profile is the real "we don't know this person" signal.
      if (app?.profile?.name) {
        context = buildContextPayload(app);
        context.nextDocument = nextPendingDocument(app);
      }
    } catch (e) {
      console.error(`[voice] could not load lead ${leadId}, continuing anonymously:`, e.message);
    }
  }

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
