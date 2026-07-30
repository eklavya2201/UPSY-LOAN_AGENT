// Exotel channel — SMS and/or WhatsApp via your Exotel account. Same pluggable
// `send(phone, message)` shape as the other notifiers, so nothing else changes.
//
// Exotel is India-focused and DLT-compliant, which is what you want for real
// applicant messaging here. Without credentials it safely logs instead of failing.
//
// To go live, set these env vars before starting the server:
//   EXOTEL_API_KEY=...
//   EXOTEL_API_TOKEN=...
//   EXOTEL_SID=your_account_sid
//   EXOTEL_SUBDOMAIN=api.in.exotel.com     (Mumbai; use api.exotel.com for Singapore)
//   EXOTEL_MODE=sms | whatsapp | both      (default: sms; "both" sends each reminder over SMS AND WhatsApp)
//   EXOTEL_FROM=your_ExoPhone_or_WA_number (Sender ID / ExoPhone for SMS, WA number for WhatsApp)
// Then set NOTIFY_CHANNEL=exotel (see backend/notifier.js).
//
// Docs: https://developer.exotel.com/api/sms  and  https://developer.exotel.com/docs/whatsapp-api

const KEY = process.env.EXOTEL_API_KEY;
const TOKEN = process.env.EXOTEL_API_TOKEN;
const SID = process.env.EXOTEL_SID;
const SUBDOMAIN = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
const FROM = process.env.EXOTEL_FROM;
const MODE = (process.env.EXOTEL_MODE || "sms").toLowerCase();

// Which channels a reminder goes out on. "both" (or "sms,whatsapp") sends each
// reminder over both; a single mode sends over just that one.
const CHANNELS = (MODE === "both" ? ["sms", "whatsapp"] : MODE.split(/[,+]/).map((s) => s.trim()))
  .filter((c) => c === "sms" || c === "whatsapp");
if (!CHANNELS.length) CHANNELS.push("sms");

function configured() {
  return Boolean(KEY && TOKEN && SID && FROM);
}

// Normalise an Indian mobile number to E.164 (+91XXXXXXXXXX).
function toE164(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  return `+91${digits.slice(-10)}`;
}

async function sendSms(phone, message) {
  // https://<key>:<token>@<subdomain>/v1/Accounts/<sid>/Sms/send.json
  const url = `https://${SUBDOMAIN}/v1/Accounts/${SID}/Sms/send.json`;
  const auth = Buffer.from(`${KEY}:${TOKEN}`).toString("base64");
  const body = new URLSearchParams({ From: FROM, To: toE164(phone), Body: message });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error(`[exotel:sms] failed (${res.status}):`, await res.text());
    return false;
  }
  return true;
}

async function sendWhatsApp(phone, message) {
  // https://<key>:<token>@<subdomain>/v2/accounts/<sid>/messages
  // Exotel wants the channel as a top-level `whatsapp` object with a messages[] array.
  const url = `https://${SUBDOMAIN}/v2/accounts/${SID}/messages`;
  const auth = Buffer.from(`${KEY}:${TOKEN}`).toString("base64");
  const payload = {
    whatsapp: {
      messages: [
        {
          from: FROM,
          to: toE164(phone),
          content: { recipient_type: "individual", type: "text", text: { preview_url: false, body: message } },
        },
      ],
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[exotel:whatsapp] failed (${res.status}):`, await res.text());
    return false;
  }
  return true;
}

export const exotelNotifier = {
  name: `Exotel (${CHANNELS.join(" + ")})`,
  async send(phone, message) {
    if (!configured()) {
      console.log(`[exotel:NOT CONFIGURED — set EXOTEL_API_KEY/TOKEN/SID/FROM] would send via ${CHANNELS.join(" + ")} to ${toE164(phone)}: ${message}`);
      return false;
    }
    // Send over every configured channel; report success if at least one lands.
    const results = [];
    for (const ch of CHANNELS) {
      results.push(ch === "whatsapp" ? await sendWhatsApp(phone, message) : await sendSms(phone, message));
    }
    return results.some(Boolean);
  },
};

export function isExotelConfigured() {
  return configured();
}

// Parse Exotel's inbound WhatsApp webhook (JSON with a nested `whatsapp.messages[]`).
// Returns { phone, text } — the same shape our webhook handler already expects.
export function parseExotelInbound(body) {
  const msg = body?.whatsapp?.messages?.[0];
  if (!msg) return { phone: "", text: "" };
  const phone = String(msg.from || "").replace(/\D/g, "").slice(-10);
  const text = msg.content?.text?.body || msg.content?.button?.text || "";
  return { phone, text: text.trim() };
}
