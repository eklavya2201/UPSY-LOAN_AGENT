// Avanse Financial Services (online.avanse.com) — screen/field guide for the
// live-assist agent, built from a full live walkthrough of the journey a
// REFERRED applicant actually takes (2026-08-04), plus the earlier self-serve
// "Apply Now" walkthrough (2026-07-30/08-02).
//
// Read README.md's "Avanse" section alongside this file — every screen here
// maps to a numbered screen there, and the failure modes there carry the
// reasoning this file only summarises.
//
// SCOPE (team decision, 2026-08-04): the agent guides the applicant from the
// upsy.in invite through co-applicant bank verification (Screen 14). What
// comes after — KYC Verification, Additional Documents — is manual for now and
// deliberately absent below. Do not invent guidance for those stages.
//
// This file is data, not live logic: liveAssist.js only serializes it into the
// system prompt so the agent can match what it sees on screen against what we
// actually observed.

export const id = "avanse";
export const displayName = "Avanse Financial Services";

export const matchHints = [
  "online.avanse.com",
  "AVANSE FINANCIAL SERVICES",
  "ASPIRE WITHOUT BOUNDARIES",
  "Need Help?",
  "My Loan Applications",
];

export const supportPhone = "1800-266-9722";

// Rules that apply on EVERY Avanse screen, not just one. These encode the
// failures we hit first-hand rather than predicted — see README failure modes
// #10, #11, #12. They matter more than any individual field description.
export const crossCuttingRules = [
  "AVANSE AUTO-FILLS FIELDS FROM UPLOADED DOCUMENTS, AND IT GETS THEM WRONG. Confirmed in real testing: after an Aadhaar upload, the " +
    "applicant's own NAME came out wrong and had to be corrected by hand, along with other fields. Avanse's own screen warns the address is " +
    "auto-captured and must be verified, but the errors are not limited to the address. Whenever the applicant uploads a document and fields " +
    "populate themselves, tell them plainly: do not trust these, read every auto-filled field and fix anything wrong before continuing. Avanse " +
    "has no checksum safety net that we know of, and these details get stored permanently.",
  "The stepper at the top of the page is coarse and will mislead you. It can still say 'Applicant Details' while the screen is actually asking " +
    "for the co-applicant's income or bank account. Trust the heading and fields you can see on the screen, never the stepper label, when telling " +
    "the applicant where they are.",
  "This flow asks for TWO people's information — the student/primary applicant, and the co-applicant. Name, address, PAN, and personal details " +
    "are each asked twice, once per person, and Avanse stores them as separate records. If the applicant says 'I already filled this in', check " +
    "whose details the current screen is asking for before agreeing with them.",
  "Never read out, repeat, or confirm a PAN number, Aadhaar number, bank account number, or date of birth you can see on screen — not even to " +
    "check it. Describe which field to look at and let the applicant read their own document.",
];

export const screens = [
  {
    name: "Sign-in",
    url: "online.avanse.com",
    fields: [
      {
        field: "Phone Number / Email ID",
        required: true,
        notes: "One combined field, then a Get OTP button. No password and no separate signup step for existing users.",
      },
    ],
    agentNote:
      "If the OTP goes to the same phone they are screen-sharing from, expect a gap while they switch away to read it. Stay quiet and wait — " +
      "do not fill the silence or repeat yourself.",
  },

  {
    name: "Dashboard (/my-loans)",
    fields: [],
    agentNote:
      "Greeting 'Hi <name>', then 'My Loan Applications' with Apply Now / My Offers buttons and All | Pending | Disbursed tabs. Existing " +
      "applications appear as cards with an Application Number (e.g. AVUPSKL040826176841), an 'In-Progress' chip with a stage in brackets, the " +
      "Institute, Course Name, Loan Amount, and View Details / Continue Application buttons. THIS DASHBOARD IS THE RELIABLE PLACE TO CONFIRM AN " +
      "APPLICATION EXISTS — more reliable than any confirmation screen. If a card is here, the application is real; tell them to press Continue " +
      "Application to resume, and read the stage name so they know what is next. An empty list reads 'No Application Found'.",
  },

  {
    name: "Consent / Key Facts screen (after arriving from upsy.in)",
    fields: [
      {
        field: "I agree with the above-mentioned details and provide my consent for the same",
        required: true,
        notes:
          "A checkbox under scrollable legal text, then an Accept & Continue button. This authorises Avanse and its third parties to pull the " +
          "applicant's credit bureau records, and to contact them by WhatsApp, call and SMS overriding NDNC registration.",
      },
    ],
    agentNote:
      "The legal text states: processing takes up to thirty days, product tenor usually up to thirty-six months, and interest may run up to " +
      "twenty-five percent per annum. If the applicant asks what they are agreeing to, summarise those honestly — including the bureau pull and " +
      "the marketing-contact permission. This is a real consent decision and it is theirs to make; explain it, never rush them past it, and never " +
      "tell them to tick it.",
  },

  {
    name: "Application process overview (the 5 stages)",
    fields: [],
    agentNote:
      "A one-time explainer listing the wizard's stages: 1 Course Selection, 2 Applicant Details, 3 Income Verification, 4 KYC Verification, " +
      "5 Additional Documents. Button reads 'Ready to Apply? Let's Start!'. Useful for orienting the applicant, but see the cross-cutting rule " +
      "above — these five labels are coarser than the actual sequence of screens, so do not promise what comes next based on them.",
  },

  {
    name: "Our Plans — Avanse's own EMI/plan screen",
    fields: [],
    agentNote:
      "Shows a plan such as '12 Month ROI' with a monthly figure, a principal/interest split, total amount payable, total interest and loan term, " +
      "with the note 'Selected EMI amount is a tentative amount, it may differ.' IMPORTANT: this is a SECOND, different EMI screen from the one on " +
      "upsy.in, and the numbers legitimately differ — upsy.in may show a no-cost-EMI total equal to the course fee, while Avanse's own plan adds " +
      "interest on top. If the applicant is confused that the numbers changed, that is why: this screen is Avanse's actual lending offer. Do not " +
      "claim either figure is the 'real' one; point out that this screen says tentative and that the final sanction letter is what binds.",
  },

  {
    name: "Applicant Details (a) — student identity and PAN",
    url: "online.avanse.com/applicant-eligibility",
    fields: [
      { field: "Student Name", required: true, notes: "Free text. Should match the student's own ID documents." },
      { field: "Student Relation", required: true, notes: "Dropdown; 'Myself' observed. Read the open dropdown off the screen for other options rather than guessing." },
      {
        field: "Loan Applicant Name",
        required: true,
        notes:
          "Free text, and NOT necessarily the same as Student Name — this is whoever is taking the loan. If the student is applying for " +
          "themselves both will match; otherwise they will not. Make sure the applicant understands which person each field means.",
      },
      {
        field: "Applicant is",
        required: true,
        notes:
          "Dropdown; 'Non-earning' and (by implication) an earning option. CONFIRMED LIVE: choosing 'Non-earning' immediately shows the message " +
          "'Since you have selected the non-earning option, you will need a co-applicant to complete the application process.' This single choice " +
          "decides whether the whole co-applicant branch appears. Make sure they pick honestly — a student with no income is non-earning, and that " +
          "is normal and expected, not a problem.",
      },
      {
        field: "Upload Applicant PAN",
        required: true,
        notes:
          "JPEG, JPG or PNG ONLY — the screen says so explicitly and there is no PDF option. This trips people up because PDFs are accepted " +
          "elsewhere in lending flows. If they only have a PDF of their PAN, they need a photo or screenshot of it instead.",
      },
      {
        field: "PAN Number",
        required: true,
        notes:
          "Typed alongside the PAN upload. Five letters, four digits, one letter. Do not read their PAN back to them; if they ask you to check it, " +
          "tell them to compare it against the card themselves, character by character.",
      },
    ],
    agentNote:
      "A green tick appears next to the PAN number once Avanse accepts it. If no tick appears, the number and the uploaded card probably disagree.",
  },

  {
    name: "Applicant Details (b) — personal details ('Let's check your eligibility')",
    fields: [
      {
        field: "Your Name",
        required: true,
        notes:
          "Free text. WATCH FOR A MISMATCH: in real testing this was filled with a fuller version of the name than the 'Student Name' field on the " +
          "previous screen (a middle name added). Downstream KYC compares these against the PAN and Aadhaar, so inconsistent versions of the same " +
          "person's name cause stalls later. Encourage one consistent spelling, matching their PAN, everywhere in this flow.",
      },
      { field: "Phone Number", required: true, notes: "Ten digits." },
      { field: "Email", required: true, notes: "Free text. This is where Avanse's follow-up instructions land, so it must be an inbox they actually read." },
      { field: "Father's Name", required: true, notes: "The applicant's own father's name." },
      { field: "Date of Birth", required: true, notes: "Date picker, shown as e.g. '22 January 2007'. Never read a date of birth back aloud." },
      { field: "Gender", required: true, notes: "Male / Female toggle buttons only; no other option was present on screen." },
      { field: "Marital Status", required: true, notes: "Dropdown; 'Single' observed." },
    ],
    agentNote: "",
  },

  {
    name: "Applicant Details (c) — Address Detail",
    url: "online.avanse.com/address-details/<id>",
    fields: [
      {
        field: "Upload Aadhar",
        required: true,
        notes:
          "The screen states: 'Once you upload the Aadhaar softcopy, the address will be automatically captured. Please verify this information " +
          "thoroughly, as these details will be stored in our records permanently.' Multiple image files can be attached (front and back).",
      },
      { field: "Applicant Name", required: true, notes: "Present on this screen to show WHOSE address is being captured — check it names the right person." },
      { field: "Pincode", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      { field: "Flat No./Building Name", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      { field: "Street Name", required: true, notes: "Auto-filled from Aadhaar — verify it. The field is narrow and long addresses are visually cut off, so scroll or click into it to read the whole value." },
      { field: "Landmark", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      { field: "City", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      { field: "State", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      { field: "Country", required: true, notes: "Auto-filled from Aadhaar — verify it." },
      {
        field: "My Current Address is same as Permanent Address (checkbox)",
        required: false,
        notes: "When ticked, copies the permanent address into a separate Current Address block with the same fields.",
      },
      {
        field: "My Corresspondance Address is same as Permanent Address (checkbox, on the Correspondence Address tab)",
        required: false,
        notes:
          "Avanse's own spelling error, not a mistake in what you are seeing. Ticked by default and it silently mirrors the permanent address.",
      },
    ],
    agentNote:
      "TWO TABS: 'Permanent and Current Address' and 'Correspondence Address'. THIS SCREEN IS WHERE PEOPLE GET HURT — two confirmed problems. " +
      "First, the Aadhaar auto-fill is unreliable (see the cross-cutting rules); walk them through every populated field rather than letting them " +
      "press Next. Second, applicants skate past the Correspondence Address tab because it is pre-ticked as 'same as permanent'. The screen states " +
      "'All official communication will be sent to your registered correspondence address', so ASK THEM DIRECTLY whether post should go somewhere " +
      "other than their permanent address — a hostel, a parent's house, a current city — before they move on. Do not assume the default is right.",
  },

  {
    name: "Applicant Details (d) — Co-applicant details",
    fields: [
      { field: "Co-applicant PAN upload + PAN Number", required: true, notes: "Same pattern as the student's PAN: image formats only, with a green tick once accepted." },
      { field: "Co-applicant's Name", required: true, notes: "Must match the co-applicant's own PAN/Aadhaar, for the same reason the student's does." },
      { field: "Phone number", required: true, notes: "The co-applicant's own number — this is where their verification message will be sent, so it must be a phone they actually hold." },
      { field: "Email", required: true, notes: "The co-applicant's own inbox, for the same reason." },
      { field: "Father's Name", required: true, notes: "The CO-APPLICANT's father's name, not the student's. Easy to get wrong when a parent is the co-applicant." },
      { field: "Date of Birth", required: true, notes: "The co-applicant's date of birth." },
      { field: "Gender", required: true, notes: "Male / Female toggle." },
      {
        field: "Co-applicant's Relation",
        required: true,
        notes:
          "Dropdown; 'Father' observed. UPSY's own rule is that a co-borrower must be immediate family — father, mother, brother, sister or spouse — " +
          "and a friend cannot co-borrow. Avanse's own policy may differ, so state that as UPSY's rule rather than theirs, but flag it early if the " +
          "applicant is planning to name a friend, because it is very likely to fail.",
      },
      { field: "Marital status", required: true, notes: "Dropdown; 'Married' observed." },
    ],
    agentNote:
      "This whole screen only appears because 'Applicant is' was set to Non-earning earlier. The co-applicant's contact details matter more than " +
      "they look — the next screen hands the process over to that person by email and SMS.",
  },

  {
    name: "Co-applicant verification pending (the hand-off screen)",
    fields: [],
    agentNote:
      "READ THIS SCREEN CAREFULLY BEFORE REACTING TO IT. The illustration is two people celebrating with confetti, which looks like success, but " +
      "the text says: 'The co-applicant's verification is pending. Please check your email & SMS for further instructions to complete the " +
      "verification process.' with Go Back and HOME buttons. THE APPLICATION IS PAUSED, NOT FINISHED. Progress now depends on a DIFFERENT PERSON — " +
      "the co-applicant — receiving their own email and SMS and acting on it, which will happen after this call ends. Say so plainly: congratulate " +
      "them on getting this far, then make sure they know to tell their co-applicant to expect a message from Avanse, to check both email and SMS " +
      "including spam, and that nothing moves until that person completes their step. Never let this screen be read as 'application complete'.",
  },

  {
    name: "Co-applicant's income details",
    fields: [
      { field: "Occupation Type", required: true, notes: "Dropdown; 'Salaried' observed. Read other options off the screen." },
      { field: "Company Name", required: true, notes: "Free text — the co-applicant's employer." },
      {
        field: "Designation",
        required: true,
        notes:
          "Free text with no validation — a misspelling will be accepted silently (in testing 'superviser' went through). Help them spell their job " +
          "title correctly; it appears on the application a credit officer will read.",
      },
      { field: "Work Experience", required: true, notes: "Dropdown; '>3 Years' observed. Other bands unknown — read them off the screen." },
      { field: "Sector", required: false, notes: "Dropdown; 'Private Sector' observed. Not marked required on screen." },
      { field: "Is your salary credited directly to your bank account?", required: true, notes: "Yes / No. Answering Yes is what makes the bank-verification step straightforward on the next screen." },
      {
        field: "Is your work related to any of the following sectors?",
        required: false,
        notes:
          "A further question below the fold that has NOT been seen in full — the list of sectors is unknown. Ask the applicant to scroll and read " +
          "the options aloud rather than guessing at them; do not invent a list.",
      },
    ],
    agentNote:
      "Note the wording says 'your' salary while the heading says 'Co-applicant's income details' — the questions are about the CO-APPLICANT, not " +
      "the student. If the student is filling this in on their own behalf, they will answer wrongly unless told. UPSY's own loan estimate is roughly " +
      "twenty four times the co-applicant's monthly income, so this section is what actually determines how much they can borrow.",
  },

  {
    name: "Co-applicant's Address Detail",
    url: "online.avanse.com/address-details/<different-id>",
    fields: [],
    agentNote:
      "Identical layout to the student's address screen — same two tabs, same Aadhaar auto-capture, same pre-ticked correspondence checkbox, same " +
      "field list — but for the CO-APPLICANT, and stored under a different record. The 'Applicant Name' field on the screen tells you whose address " +
      "it is. Every warning from the student's address screen applies again here: verify every auto-filled field, and ask explicitly about the " +
      "correspondence address instead of trusting the default.",
  },

  {
    name: "Verify your Bank Account",
    fields: [
      {
        field: "Account Aggregator (button)",
        required: false,
        notes:
          "The fastest route. The screen says: provide the mobile number linked to the bank account, and 'If your bank account gets verified " +
          "successfully, you will not be required to provide any proof for Bank Account.' Uses India's regulated Account Aggregator consent " +
          "framework, so no statement upload is needed if it works.",
      },
      {
        field: "Upload your Bank Statement — Bank Name",
        required: true,
        notes: "The fallback route. Asks for the last six months of statements, starting with the bank's name as a required text field.",
      },
      {
        field: "I want to use Net Banking (link)",
        required: false,
        notes: "A third route at the bottom of the screen. Not explored — do not describe how it works, only that it exists as an option.",
      },
    ],
    agentNote:
      "THREE ALTERNATIVE PATHS, not three steps — they only need one. Recommend trying Account Aggregator first, because succeeding there removes " +
      "the statement upload entirely; fall back to uploading six months of statements if it fails or their bank is not supported. This is the last " +
      "screen UPSY's live assistance currently covers: after bank verification the remaining stages (KYC Verification, Additional Documents) are " +
      "handled manually, so tell the applicant honestly that someone from UPSY will help them with the rest rather than pretending to guide them " +
      "through screens you do not know.",
  },
];

export const proactiveGuidance = [
  "Whenever a document upload auto-fills fields, immediately prompt the applicant to check every filled field — Avanse's extraction has been " +
    "confirmed to get names and address details wrong, and these are stored permanently.",
  "On any Address Detail screen, ask outright whether their correspondence address should differ from their permanent address, because the " +
    "'same as permanent' box is ticked by default and all official post follows it.",
  "Before they submit co-applicant details, warn them that the next screen looks celebratory but actually pauses the application until their " +
    "co-applicant acts on an email and SMS.",
  "Keep the applicant's name spelled identically across Student Name, Loan Applicant Name, Your Name and their PAN — mismatches stall verification later.",
  "PAN and Aadhaar uploads here accept images only (JPEG, JPG, PNG), not PDFs.",
  `If something is genuinely Avanse's problem rather than something UPSY can fix, their support number is ${supportPhone} and there is a 'Need Help?' button in the page header.`,
];

export const openQuestions = [
  "What the 'Income Verification', 'KYC Verification' and 'Additional Documents' stages actually contain — the walkthrough stopped at bank " +
    "verification, and these are currently handled manually rather than by the agent.",
  "The full option lists behind the Select Type, Student Relation, Occupation Type, Work Experience and Sector dropdowns — only one value of each " +
    "has ever been observed.",
  "The sectors listed under 'Is your work related to any of the following sectors?' on the co-applicant income screen.",
  "What the Net Banking route on the bank verification screen involves.",
  "Whether the older self-serve 'Apply Now' quick form (Select Type, Loan Amount, Time of Study, Place of Study, Admission Status) reliably " +
    "creates a resumable application — one walkthrough ended on 'No Application Found', a later dashboard showed real in-progress cards.",
];
