// Document requirements for the UPSY education-loan agent.
// Ordered to mirror the real loan journey (student -> co-applicant -> collateral).
// `why` is shown to the applicant when the agent requests the document.
// `identifier` (optional) is an ID the agent also asks for and format-checks (e.g. PAN number).
// `accept` + `maxSizeMB` drive the file-format cross-check on the backend.

export const IMAGE_OR_PDF = ["pdf", "jpg", "jpeg", "png"];

export const STAGES = [
  { id: "student", title: "Student documents", blurb: "Your own KYC, academic and income proofs." },
  { id: "coapplicant", title: "Co-applicant documents", blurb: "Your co-borrower (a family member) — KYC and income proofs." },
  { id: "collateral", title: "Collateral documents", blurb: "Only for a secured loan (higher amounts / lower rates)." },
];

export const DOCUMENTS = [
  // ---------------- STUDENT ----------------
  {
    id: "student_pan",
    stage: "student",
    label: "PAN card",
    required: true,
    why:
      "PAN is mandatory for any loan in India. Lenders use it to pull your credit history (CIBIL) and to report the loan to tax authorities. Without a valid PAN the file cannot even be opened.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: {
      name: "PAN number",
      pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$",
      example: "ABCDE1234F",
      hint: "5 letters, then 4 digits, then 1 letter.",
    },
  },
  {
    id: "student_aadhaar",
    stage: "student",
    label: "Aadhaar card",
    required: true,
    why:
      "Aadhaar is the primary KYC and address proof. It is used to verify your identity and to pre-fill your details, and later for the e-sign / e-NACH mandate at disbursement.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: {
      name: "Aadhaar number",
      pattern: "^[2-9][0-9]{11}$",
      example: "234567890123",
      hint: "12 digits, not starting with 0 or 1.",
    },
  },
  {
    id: "student_photo",
    stage: "student",
    label: "Passport-size photo",
    required: true,
    why: "A recent photograph is required on the loan application form and for the lender's KYC record.",
    accept: ["jpg", "jpeg", "png"],
    maxSizeMB: 2,
    identifier: null,
  },
  {
    id: "student_admit_letter",
    stage: "student",
    label: "Admission / admit letter",
    required: true,
    why:
      "This proves you actually have a seat in an eligible course. The loan amount, the institute and the disbursement schedule are all tied to what this letter says.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 10,
    identifier: null,
  },
  {
    id: "student_entrance_score",
    stage: "student",
    label: "Entrance test scorecard (CAT / GRE / NEET / JEE etc.)",
    required: false,
    why:
      "For many programs the lender uses your entrance score as a risk / merit signal. A strong score can improve eligibility and pricing. Skip if your course had no entrance test.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: null,
  },
  {
    id: "student_marksheet_degree",
    stage: "student",
    label: "Latest degree marksheet",
    required: true,
    why:
      "Your most recent academic result confirms you meet the minimum academic criteria for the loan and that you are on track in your program.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 10,
    identifier: null,
  },
  {
    id: "student_marksheet_10_12",
    stage: "student",
    label: "10th & 12th marksheets",
    required: true,
    why:
      "Standard academic-history check. 10th also serves as an age / date-of-birth proof that lenders cross-verify against KYC.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 10,
    identifier: null,
  },
  {
    id: "student_bank_statement",
    stage: "student",
    label: "Last 6 months' bank statement",
    required: true,
    why:
      "Shows your banking conduct — inflows, EMIs, bounces. Even if you have no income yet, the account activity is part of the credit assessment.",
    accept: ["pdf"],
    maxSizeMB: 15,
    identifier: null,
  },

  // ---------------- CO-APPLICANT ----------------
  {
    id: "co_pan",
    stage: "coapplicant",
    label: "Co-applicant PAN card",
    required: true,
    why:
      "The co-applicant (a family member) is financially liable during your moratorium. Their PAN is mandatory to pull their credit score, which largely drives sanction and interest rate.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: {
      name: "Co-applicant PAN number",
      pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$",
      example: "ABCDE1234F",
      hint: "5 letters, then 4 digits, then 1 letter.",
    },
  },
  {
    id: "co_aadhaar",
    stage: "coapplicant",
    label: "Co-applicant Aadhaar card",
    required: true,
    why: "KYC and address proof for the co-borrower, and needed for their e-sign / NACH mandate on the loan agreement.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: {
      name: "Co-applicant Aadhaar number",
      pattern: "^[2-9][0-9]{11}$",
      example: "234567890123",
      hint: "12 digits, not starting with 0 or 1.",
    },
  },
  {
    id: "co_relationship_proof",
    stage: "coapplicant",
    label: "Relationship proof with student",
    required: true,
    why:
      "The co-borrower must be immediate family (father / mother / brother / sister / spouse) — friends are not allowed. This document (e.g. passport, ration card, birth certificate) proves the relationship.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: null,
  },
  {
    id: "co_cancelled_cheque",
    stage: "coapplicant",
    label: "Cancelled cheque / passbook front page",
    required: true,
    why:
      "The account details here are used to set up the auto-debit (NACH) mandate through which EMIs will be collected after the moratorium.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 5,
    identifier: null,
  },
  {
    id: "co_bank_statement",
    stage: "coapplicant",
    label: "Co-applicant 6 months' bank statement",
    required: true,
    why: "Confirms the co-borrower's income stability and repayment capacity — a core part of the underwriting.",
    accept: ["pdf"],
    maxSizeMB: 15,
    identifier: null,
  },
  {
    id: "co_income_proof",
    stage: "coapplicant",
    label: "3 months' salary slips OR latest ITR",
    required: true,
    why:
      "Direct proof of the co-borrower's income. Salaried co-applicants give salary slips; self-employed give the ITR. This sets the maximum loan the lender will sanction.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 10,
    identifier: null,
  },

  // ---------------- COLLATERAL (conditional) ----------------
  {
    id: "collateral_property_papers",
    stage: "collateral",
    label: "Property / FD papers offered as collateral",
    required: false,
    why:
      "Only for a secured loan. Accepted: fixed deposits, or residential / non-agricultural property (flat, house, plot, shop). Not accepted: mutual funds, commercial property; agricultural land is case-by-case. These papers let the lender value and mortgage the asset.",
    accept: IMAGE_OR_PDF,
    maxSizeMB: 20,
    identifier: null,
  },
];

export function getDocument(id) {
  return DOCUMENTS.find((d) => d.id === id);
}
