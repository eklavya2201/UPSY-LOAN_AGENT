// `npm run voice:check` — a preflight for browser voice calls (/m).
//
// Written after a debugging session that should not have taken one: the agent
// had never been deployed, so Cartesia accepted the WebSocket handshake and
// then closed it with `1011 Internal server error`. Nothing in that message
// mentions deployment, and from the phone it is indistinguishable from a bug in
// our own audio code — so the whole client was searched before the account was.
//
// This walks the same chain a real call walks, in order, and stops at the first
// thing that is actually wrong:
//   env keys → agent exists → agent is deployed → token mints → socket accepts
//   the start event → the agent actually speaks.

import "dotenv/config";
import WebSocket from "ws";
import { checkAgentReady, INPUT_FORMAT, voiceConfigError } from "./voiceCall.js";
import { buildVoiceSystemPrompt, buildIntroduction } from "./voicePrompt.js";

const HOST = "api.cartesia.ai";
const VERSION = process.env.CARTESIA_VERSION || "2025-04-16";

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

function fail(message, fix) {
  bad(message);
  if (fix) {
    console.log("");
    console.log(`  Fix: ${fix}`);
  }
  console.log("");
  process.exit(1);
}

console.log("\nUPSY voice preflight\n");

// 1 — configuration
const configError = voiceConfigError();
if (configError) fail(configError, "Add the missing values to .env, then run this again.");
ok(`CARTESIA_API_KEY set (${process.env.CARTESIA_API_KEY.slice(0, 7)}…)`);
ok(`CARTESIA_AGENT_ID set (${process.env.CARTESIA_AGENT_ID})`);
info(`input format ${INPUT_FORMAT}, API version ${VERSION}`);

// 2 — the agent exists, and is deployed
let ready;
try {
  ready = await checkAgentReady({ force: true });
} catch (e) {
  fail(`Could not reach Cartesia: ${e.message}`, "Check your network, then run this again.");
}
if (!ready.ok) {
  fail(ready.reason, "Open the agent at play.cartesia.ai and press Publish/Deploy.");
}
if (ready.unverified) {
  bad(`Readiness unverified: ${ready.reason}`);
  info("Continuing anyway — the socket below is the real test.");
} else {
  const a = ready.agent || {};
  ok(`Agent "${a.name}" is deployed (is_live: ${a.is_live}, deployments: ${a.deployment_count})`);
  if (a.zdr === false) {
    info("Note: zero data retention is OFF on this agent — relevant to the Phase 2 DPDP work.");
  }
}

// 3 — the token our browser would actually be handed
let token;
try {
  const res = await fetch(`https://${HOST}/access-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
      "Cartesia-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grants: { agent: true }, expires_in: 600 }),
  });
  const body = await res.text();
  if (!res.ok) fail(`Token request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  token = JSON.parse(body).token;
  if (!token) fail("Cartesia returned no token.");
  ok(`Short-lived access token minted (${token.length} chars, expires in 600s)`);
} catch (e) {
  fail(`Token request threw: ${e.message}`);
}

// 4 — the socket, with the exact payload frontend/voiceClient.js sends
const prompt = buildVoiceSystemPrompt(null);
info(`System prompt built from voicePrompt.js (${prompt.length} chars)`);

const url =
  `wss://${HOST}/agents/stream/${encodeURIComponent(process.env.CARTESIA_AGENT_ID)}` +
  `?access_token=${token}&cartesia_version=${VERSION}`;

await new Promise((resolve) => {
  const ws = new WebSocket(url);
  let heardAck = false;
  let settled = false;

  const finish = (code) => {
    if (settled) return;
    settled = true;
    try { ws.close(); } catch { /* already closing */ }
    console.log("");
    resolve();
    process.exit(code);
  };

  // The agent's own greeting should arrive within a few seconds of `start`.
  // Longer than this and something is wrong even if the socket is still open.
  const timer = setTimeout(() => {
    bad("No audio within 12s.");
    info(heardAck ? "The start event was acknowledged but the agent never spoke." : "No ack either — the start event was not accepted.");
    finish(1);
  }, 12000);

  ws.on("open", () => {
    ok("WebSocket connected");
    ws.send(JSON.stringify({
      event: "start",
      stream_id: "voice-check",
      config: { input_format: INPUT_FORMAT, output_audio_delivery: "as_available" },
      agent: { system_prompt: prompt, introduction: buildIntroduction(null) },
      metadata: { product: "upsy-loan-agent", known_applicant: false },
    }));
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === "ack") {
      heardAck = true;
      ok("Start event accepted (ack received)");
      return;
    }
    if (msg.event === "media_output") {
      clearTimeout(timer);
      ok(`Agent is speaking — received audio (${(msg.media?.payload || "").length} base64 chars)`);
      console.log("\n  Everything a real call needs is working.\n");
      finish(0);
      return;
    }
    if (msg.event === "error") {
      clearTimeout(timer);
      bad(`Service error: ${JSON.stringify(msg).slice(0, 300)}`);
      finish(1);
    }
  });

  ws.on("error", (e) => info(`socket error: ${e.message}`));

  ws.on("close", (code, reasonBuf) => {
    clearTimeout(timer);
    if (settled) return;
    const reason = reasonBuf?.toString() || "(no reason given)";
    bad(`Socket closed: ${code} ${reason}`);
    if (code === 1011) {
      // The exact case this script exists for.
      info("1011 is Cartesia's catch-all. The cause we have actually hit is an");
      info("agent that was never deployed — but the check above says this one is,");
      info("so look at the agent's own config (voice, model, tools) next.");
    }
    finish(1);
  });
});
