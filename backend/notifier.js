// Pluggable notification channel — sends reminder messages to applicants who
// started but didn't finish. Same adapter pattern as leadSources: swap the
// mock for a real SMS/WhatsApp provider (Twilio, Meta WhatsApp Business API,
// MSG91, etc.) without touching the code that decides *when* to nudge.
//
// A real provider needs its own account/API keys — wire it in here behind
// the same `send(phone, message)` signature and set NOTIFY_CHANNEL=<name>.

import { whatsappNotifier } from "./whatsapp.js";
import { exotelNotifier } from "./exotel.js";

const sentLog = [];

const mockNotifier = {
  name: "Console notifier (mock)",
  async send(phone, message) {
    console.log(`[notify] -> ${phone}: ${message}`);
    sentLog.push({ phone, message, at: new Date().toISOString() });
    return true;
  },
  getLog() {
    return sentLog;
  },
};

const CHANNELS = {
  mock: mockNotifier,
  whatsapp: whatsappNotifier, // see backend/whatsapp.js — needs Twilio credentials to actually send
  exotel: exotelNotifier, // see backend/exotel.js — SMS or WhatsApp via your Exotel account
};

export function getActiveNotifier() {
  const key = process.env.NOTIFY_CHANNEL || "mock";
  const ch = CHANNELS[key];
  if (!ch) throw new Error(`Unknown NOTIFY_CHANNEL "${key}". Available: ${Object.keys(CHANNELS).join(", ")}`);
  return ch;
}

// Craft the reminder text for a stalled applicant.
export function nudgeMessage(profile, done, total) {
  const name = profile?.name ? `${profile.name}, ` : "";
  return `Hi ${name}your education loan application is ${done}/${total} documents complete. ` +
    `A few more steps and you're done — reply to this message or reopen the UPSY assistant to continue.`;
}
