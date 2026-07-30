// WhatsApp channel via Twilio's WhatsApp API. This is a REAL integration, but
// it needs your own Twilio account to actually send anything — without
// credentials it safely logs to the console instead of failing.
//
// To go live:
//   1. Get a Twilio account with WhatsApp enabled (sandbox for testing, a
//      registered WhatsApp Business sender for production).
//   2. Set these environment variables before starting the server:
//        TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//        TWILIO_AUTH_TOKEN=your_auth_token
//        TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   (Twilio's sandbox number, or your own)
//   3. Set NOTIFY_CHANNEL=whatsapp (see backend/notifier.js) so reminders go out over WhatsApp
//      instead of just the console.
//   4. Point Twilio's "when a message comes in" webhook at:
//        POST https://<your-public-url>/webhook/whatsapp
//      (needs a public URL — e.g. ngrok while developing, your real domain in production.)

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM;

function configured() {
  return Boolean(SID && TOKEN && FROM);
}

// Send a WhatsApp message. Falls back to a console log if Twilio isn't configured,
// so the rest of the app (nudges, etc.) keeps working in local/demo mode.
export const whatsappNotifier = {
  name: "WhatsApp (Twilio)",
  async send(phone, message) {
    const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:+91${phone.replace(/\D/g, "").slice(-10)}`;
    if (!configured()) {
      console.log(`[whatsapp:NOT CONFIGURED — set TWILIO_ACCOUNT_SID/TOKEN/FROM] would send to ${to}: ${message}`);
      return false;
    }
    const auth = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
    const body = new URLSearchParams({ From: FROM, To: to, Body: message });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      console.error(`[whatsapp] send failed (${res.status}):`, await res.text());
      return false;
    }
    return true;
  },
};

export function isWhatsAppConfigured() {
  return configured();
}

// Parse Twilio's inbound webhook payload (application/x-www-form-urlencoded)
// into the bits we care about: the sender's number and what they typed.
export function parseInboundWebhook(body) {
  const raw = body.From || ""; // e.g. "whatsapp:+919999999999"
  const phone = raw.replace("whatsapp:", "").replace(/\D/g, "").slice(-10);
  return { phone, text: (body.Body || "").trim() };
}

// A minimal reply for an inbound message — points the applicant back to the
// assistant with their live progress, rather than trying to run the whole
// document-collection conversation inside WhatsApp's text interface.
export function buildReply(applicantName, done, total, appUrl) {
  const hi = applicantName ? `Hi ${applicantName}! ` : "Hi! ";
  if (total == null) {
    return `${hi}I couldn't find an application for this number yet. Please start at ${appUrl}`;
  }
  return `${hi}You're at ${done}/${total} documents. Continue here: ${appUrl}`;
}

// Twilio expects a TwiML XML response to acknowledge the inbound message.
export function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
