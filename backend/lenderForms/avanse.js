// Avanse Financial Services (online.avanse.com) — field/screen guide for the
// live-assist agent. Built from two sources: the walkthrough recorded in
// README.md's "Avanse" section (2026-07-30/08-02), and a real logged-in
// dashboard screenshot (2026-08-03) that surfaced NEW information — see the
// "openQuestions" note below before treating the old "submit dead-end"
// finding as still fully accurate.
//
// This file is data, not code that runs live logic: liveAssist.js never
// executes anything here, it only serializes it into the system prompt so
// the agent can match what it sees on screen against what we know.

export const id = "avanse";
export const displayName = "Avanse Financial Services";

// Strings the agent can look for on screen (URL bar, logo, page text) to
// recognise this lender. Kept short and literal — the agent reads pixels via
// vision, it does not need regex-perfect hints.
export const matchHints = [
  "avanse.com",
  "AVANSE FINANCIAL SERVICES",
  "ASPIRE WITHOUT BOUNDARIES",
  "My Loan Applications",
];

export const supportPhone = "1800-266-9722";

export const screens = [
  {
    name: "Sign-in",
    url: "online.avanse.com",
    fields: [
      {
        field: "Phone Number / Email ID",
        required: true,
        notes: "Single field, then a Get OTP button. No password, no separate signup step for existing users.",
      },
    ],
    agentNote: "No password screen. If they say they can't find where to log in, this single combined field is it.",
  },
  {
    name: "Dashboard (/my-loans)",
    fields: [],
    agentNote:
      "Greeting 'Hi <name>', then 'My Loan Applications' with Apply Now / My Offers buttons and All | Pending | Disbursed tabs. " +
      "CORRECTION to an earlier observation: this dashboard can show existing applications as real cards — each with an Application Number " +
      "(e.g. AVUPSKL020826176243), a status chip like 'In-Progress' with a parenthetical stage such as '(Applicant Details)' or '(Course Details)', " +
      "the Institute, Course Name, Loan Amount, and both 'View Details' and 'Continue Application' buttons. So a submitted application is NOT " +
      "always a dead end — it can persist as an in-progress, resumable, multi-stage application. If the applicant already has a card here, tell " +
      "them to use Continue Application to pick up where they left off, and read the stage name back to them so they know what's next.",
  },
  {
    name: "Apply Now — quick form (modal)",
    fields: [
      {
        field: "Select Type",
        required: true,
        notes:
          "Dropdown; only 'Executive Education' has actually been observed selected. Other options are unknown — read the open dropdown off " +
          "the screenshot rather than reciting a list we don't have. Choosing the wrong product type could mis-route the whole application.",
      },
      {
        field: "Name",
        required: true,
        notes:
          "Free text. Should match the applicant's KYC documents (PAN/Aadhaar) exactly — this is where UPSY has an edge: if we've already " +
          "verified their name off an ID document, tell them to type it exactly that way (initials, married name, spelling all matter).",
      },
      { field: "Email Id", required: true, notes: "Free text." },
      { field: "Phone Number", required: true, notes: "Free text, 10 digits." },
      {
        field: "Loan Amount",
        required: true,
        notes:
          "Raw number only — e.g. 500000. No commas, no rupee symbol, no lakh/crore selector. This is the highest-risk field: Indian applicants " +
          "think in lakhs, the field wants plain rupees, and one missing/extra zero is a 10x error. Have them say the amount aloud in words and " +
          "count the zeros together before they type it. Do not read a number back off a screenshot as confirmation of correctness — reason from " +
          "what they say they want, since digit-reading off screenshots is not reliable yet.",
      },
      {
        field: "Time of Study",
        required: false,
        notes:
          "Format looks like MM/YYYY (e.g. 07/2026). Not labelled as start, end, or intake month — genuinely ambiguous. Suggest course start " +
          "month as the safest reading, but say plainly that it's your best guess, not a confirmed rule.",
      },
      {
        field: "Place of Study",
        required: false,
        notes:
          "Free text (e.g. 'mumbai'). Not labelled as city, country, or institute. Suggest city plus country as the unambiguous form, especially " +
          "for a study-abroad applicant.",
      },
      {
        field: "Admission Status",
        required: false,
        notes:
          "Free text, no dropdown, no validation, no example values shown anywhere on the form. Help them phrase it plainly and correctly " +
          "spelled ('admitted', 'applied, awaiting decision'). Never invent an official list of accepted values — none is known.",
      },
    ],
    agentNote:
      "Ends with a single Submit button. Warn before they press it that the next screen may look empty or unclear — see the dashboard note above " +
      "for what actually seems to happen next.",
  },
];

// Things the agent should proactively say without being asked, because the
// form itself won't tell the applicant.
export const proactiveGuidance = [
  "Before Submit on the quick form: the next screen may not clearly confirm success — that's normal, not a sign something broke.",
  "After Submit: check the main dashboard/My Loan Applications list for a new card with an Application Number and a stage like '(Applicant Details)' " +
    "— that is the confirmation, more reliable than anything on the submit screen itself.",
  "If a phone OTP is needed mid-call and they're screen-sharing from that same phone, expect a short gap — don't fill the silence, wait for them to come back.",
  `If something is genuinely Avanse's problem (not something UPSY can help with), the support number is ${supportPhone}.`,
];

export const openQuestions = [
  "Whether the quick-form Submit reliably creates a resumable dashboard card every time, or only sometimes — the 2026-08-02 walkthrough saw " +
    "'No Application Found' after submit, but a 2026-08-03 screenshot showed real in-progress cards with application numbers. Treat the dashboard-card " +
    "behaviour as the more likely outcome, but don't assert either as universal until this is walked end-to-end again.",
  "What 'Continue Application' actually asks for at each stage (Applicant Details, Course Details, ...) — not yet observed screen-by-screen.",
  "The full 'Select Type' dropdown list beyond 'Executive Education'.",
  "What 'My Offers' and 'View Details' show — not yet opened.",
];
