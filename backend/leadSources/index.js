// Registry of lead sources. The agent talks to ONE active source through this
// interface, so swapping the mock for a real platform is a config change, not a rewrite.
//
// To add a real source (Zoho / Salesforce / LeadSquared / Meta lead ads / your own API):
//   1. Create ./zohoSource.js exporting { name, getLead(phone), pushStatus(leadId, payload) }.
//   2. Register it in SOURCES below.
//   3. Set LEAD_SOURCE=zoho in the environment.
//
// Interface every source must implement:
//   getLead(phone)            -> lead object (see mockSource for the shape)
//   pushStatus(leadId, payload) -> writes an update back to the platform
//   getTimeline(leadId)       -> (optional) past write-backs, for the officer view

import { mockSource } from "./mockSource.js";

const SOURCES = {
  mock: mockSource,
  // zoho: zohoSource,
  // salesforce: salesforceSource,
  // leadsquared: leadSquaredSource,
};

export function getActiveSource() {
  const key = process.env.LEAD_SOURCE || "mock";
  const source = SOURCES[key];
  if (!source) throw new Error(`Unknown LEAD_SOURCE "${key}". Available: ${Object.keys(SOURCES).join(", ")}`);
  return source;
}
