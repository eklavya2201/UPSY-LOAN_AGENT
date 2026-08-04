// upsy.in — the course-financing marketplace a referred applicant passes
// through BEFORE reaching a lender's own site. Documented from a live
// walkthrough on 2026-08-04.
//
// ⚠️ NAME COLLISION, READ THIS FIRST: `upsy.in` is a REAL THIRD-PARTY PLATFORM
// (the financing partner behind course providers such as Airtribe). It is NOT
// this product. The fact that it shares a name with UPSY, the loan agent in
// this repo, is a coincidence. The agent must never claim upsy.in is "us", and
// must never claim UPSY built or controls it.
//
// It lives here rather than in a separate registry because the agent picks
// guidance by looking at what is on screen: upsy.in is a different domain with
// different screens, so it needs its own entry or the agent will land there,
// match nothing, and say it has no guidance for the very first step of the
// journey.

export const id = "upsy-in";
export const displayName = "upsy.in (course financing marketplace — a third party, not UPSY itself)";

export const matchHints = [
  "upsy.in",
  "upsy.in/dashboard",
  "COURSE APPLICATION INVITE",
  "Claim this Application",
  "My Applications",
  "Select Financing Option",
];

export const crossCuttingRules = [
  "upsy.in is a separate company that happens to share our name. If the applicant asks, be straight with them: this website is the financing " +
    "platform their course provider uses, and UPSY — you — is a different service helping them get through it. Do not take credit for their site " +
    "and do not claim to control anything on it.",
  "This site is only the doorway. Nothing here is the loan itself; the actual application, credit checks and paperwork all happen on the lender's " +
    "own site after the hand-off.",
];

export const screens = [
  {
    name: "Course application invite email",
    fields: [],
    agentNote:
      "Arrives from an address such as updates@upsy.in and reads 'You have been invited by <course provider> to enroll in a course through Upsy'. " +
      "It names the course and the course fee, shows an expiry date for the link, and carries a 'Claim this Application' button. If the applicant " +
      "cannot find it, have them search their inbox for the course provider's name and check spam. THE LINK EXPIRES — if the shown expiry date has " +
      "passed, they need a fresh invite from the course provider, and no amount of clicking will fix it.",
  },

  {
    name: "Claim this Application",
    fields: [],
    agentNote:
      "A single card confirming the course, the loan amount and the link expiry, with one 'Claim this Application' button. Have the applicant check " +
      "the course name and amount match what they actually signed up for BEFORE claiming — this is the cheapest moment to catch a wrong course or a " +
      "wrong fee, long before any lender sees it.",
  },

  {
    name: "My Applications dashboard",
    url: "upsy.in/dashboard?section=applications",
    fields: [],
    agentNote:
      "Lists every application the applicant has, each as a card showing the course, the provider, the amount, and — once a lender is attached — " +
      "that lender's name (e.g. 'Avanse Financial Services Ltd'). Filter chips across the top: All, Pending, In Review, Approved, Disbursed, " +
      "Rejected, Cancelled. The button on each card changes with its state: 'Apply' for one not yet started, 'Continue with lender' for one already " +
      "handed off. THIS IS THE APPLICANT'S REAL PROGRESS VIEW — if they are unsure whether something went through, bring them back here rather than " +
      "guessing. A card sitting on 'In Review' means it is with the lender and there is nothing for them to do on this site.",
  },

  {
    name: "Select Financing Option",
    fields: [
      {
        field: "Tenure options (radio list)",
        required: true,
        notes:
          "Options observed at 3, 6, 9 and 12 months, each labelled 'No Cost EMI' and showing a Monthly EMI and a Total Payable. In the observed " +
          "case every option's Total Payable equalled the course fee exactly — that is what 'no cost' means here: the tenure changes the monthly " +
          "figure, not the total. Shorter tenure means a bigger monthly payment.",
      },
    ],
    agentNote:
      "There is also a 'View All Lenders' link, then Cancel and Apply Now buttons. HELP THEM CHOOSE ON AFFORDABILITY: the only real trade-off on " +
      "this screen is how much they can comfortably pay each month, since the total is the same across options. WARN THEM BEFORE THEY PRESS APPLY " +
      "NOW: the lender's own site will show its own plan screen afterwards, and its numbers may NOT match these — a lender can add interest that " +
      "this no-cost-EMI view does not show. That difference is expected, not a bug and not a trick, but they should read the lender's figures as " +
      "the real ones. Pressing Apply Now hands them to the lender's site, which is where the actual application begins.",
  },
];

export const proactiveGuidance = [
  "Check the course name and fee on the invite match what the applicant actually enrolled in, before they claim the application.",
  "Invite links carry an expiry date — if it has passed, the course provider has to issue a new one.",
  "Choose the EMI tenure on what they can afford monthly, since the total payable is identical across the no-cost options.",
  "Warn them that the lender's own EMI screen may show different numbers than upsy.in's, and that the lender's figures are the binding ones.",
];

export const openQuestions = [
  "What 'View All Lenders' shows, and whether the applicant can actually choose a different lender there — never suggest they can until this is confirmed.",
  "How a lender gets attached to an application (automatically matched, or chosen by the applicant).",
  "What the My Profile, My Enrollments, Settings, Support and Feedback sections of the dashboard contain.",
  "What each status — Pending, In Review, Approved, Disbursed, Rejected, Cancelled — means in practice, and what if anything the applicant is expected to do in each.",
];
