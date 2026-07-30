// Mock lead platform. Stands in for ANY source of leads — a CRM (Zoho, Salesforce,
// LeadSquared), a Meta/Google lead ad, a website eligibility form, or a spreadsheet.
// A real source just implements the same two methods: getLead() and pushStatus().

const LEADS = {
  // A warm lead that already came in with some info + a couple of documents on file.
  "9999999999": {
    leadId: "LD-1001",
    name: "Aarav Sharma",
    phone: "9999999999",
    source: "Meta lead ad",
    course: "MBA",
    institute: "IIM Bangalore",
    loanType: "unsecured",          // -> collateral docs not needed
    coApplicantType: "salaried",    // -> co-applicant income = salary slips
    coApplicantRelation: "father",
    coApplicantMonthlyIncome: 95000,
    academicPercent: 76,
    courseDurationMonths: 24,
    citizenship: "Indian",
    known: { student_pan: "ABCDE1234F" },              // pre-fill this identifier
    documentsOnFile: ["student_photo", "student_marksheet_10_12"], // skip these
  },
  // A lead going for a secured loan, self-employed co-applicant, nothing on file yet.
  "8888888888": {
    leadId: "LD-1002",
    name: "Priya Nair",
    phone: "8888888888",
    source: "Website eligibility form",
    course: "MS (Computer Science)",
    institute: "University of Texas",
    loanType: "secured",            // -> collateral docs required
    coApplicantType: "self-employed", // -> co-applicant income = ITR
    coApplicantRelation: "mother",
    coApplicantMonthlyIncome: 60000,
    academicPercent: 82,
    courseDurationMonths: 24,
    citizenship: "NRI",
    known: {},
    documentsOnFile: [],
  },
  // A weak case: low academic score + friend co-applicant, to demo an "ineligible" result.
  "7777700000": {
    leadId: "LD-1003",
    name: "Rahul Verma",
    phone: "7777700000",
    source: "Google lead ad",
    course: "B.Tech",
    institute: "Private Engineering College",
    loanType: "unsecured",
    coApplicantType: "salaried",
    coApplicantRelation: "friend",
    coApplicantMonthlyIncome: 40000,
    academicPercent: 52,
    courseDurationMonths: 48,
    citizenship: "Indian",
    known: {},
    documentsOnFile: [],
  },
};

// Where write-backs land, so we can prove the agent is updating the source.
const statusLog = {};

export const mockSource = {
  name: "Mock lead platform",

  // Look up a lead by phone. Unknown numbers become a fresh enquiry (nothing pre-filled).
  async getLead(phone) {
    const base = LEADS[phone];
    if (base) return structuredClone(base);
    return {
      leadId: "LD-" + phone,
      name: null,
      phone,
      source: "New enquiry",
      course: null,
      institute: null,
      loanType: "unsecured",
      coApplicantType: "salaried",
      known: {},
      documentsOnFile: [],
    };
  },

  // Write a status update back to the lead platform (here: an in-memory log).
  async pushStatus(leadId, payload) {
    (statusLog[leadId] ||= []).push({ ...payload, at: new Date().toISOString() });
    console.log(`[lead-source] ${leadId} <- ${payload.event}${payload.docId ? " (" + payload.docId + ")" : ""}`);
    return true;
  },

  // Read the write-back log for a lead (used by the officer timeline endpoint).
  async getTimeline(leadId) {
    return statusLog[leadId] || [];
  },
};
