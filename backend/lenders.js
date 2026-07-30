// Demo partner-lender catalogue + a rule-based lender matcher. These are DEMO
// entries (names are real Indian education-loan lenders, contact emails are
// .example.com placeholders) — real lender APIs/emails get wired here later.
// The matcher reuses the same underwriting facts as eligibility.js: loan type,
// estimated amount, academic score, co-borrower income and citizenship.

export const LENDERS = [
  {
    id: "hdfc_credila",
    name: "HDFC Credila",
    type: "NBFC",
    email: "partnerships@hdfccredila.example.com",
    rateRange: "10.5% – 12.5%",
    maxUnsecured: 7500000,
    maxSecured: 20000000,
    minAcademicPercent: 60,
    nriOk: true,
    blurb: "Education-loan specialist; strong for unsecured loans to ranked institutes in India and abroad.",
  },
  {
    id: "auxilo",
    name: "Auxilo Finserve",
    type: "NBFC",
    email: "loans@auxilo.example.com",
    rateRange: "11% – 13.5%",
    maxUnsecured: 6500000,
    maxSecured: 15000000,
    minAcademicPercent: 60,
    nriOk: true,
    blurb: "Fast unsecured sanctions for study abroad; flexible on co-applicant income profiles.",
  },
  {
    id: "avanse",
    name: "Avanse Financial Services",
    type: "NBFC",
    email: "referrals@avanse.example.com",
    rateRange: "10.75% – 13%",
    maxUnsecured: 7500000,
    maxSecured: 20000000,
    minAcademicPercent: 60,
    nriOk: true,
    blurb: "Covers full cost of education including living expenses; good for both India and abroad.",
  },
  {
    id: "incred",
    name: "InCred",
    type: "NBFC",
    email: "education@incred.example.com",
    rateRange: "11.25% – 13.5%",
    maxUnsecured: 6000000,
    maxSecured: 10000000,
    minAcademicPercent: 65,
    nriOk: false,
    blurb: "Digital-first unsecured loans; quick decisions for strong academic profiles.",
  },
  {
    id: "union_bank",
    name: "Union Bank of India",
    type: "Bank",
    email: "educationloans@unionbank.example.com",
    rateRange: "9.25% – 10.75%",
    maxUnsecured: 4000000,
    maxSecured: 20000000,
    minAcademicPercent: 60,
    nriOk: true,
    blurb: "Public-sector rates; best pricing when collateral is offered (secured loans).",
  },
  {
    id: "sbi",
    name: "State Bank of India",
    type: "Bank",
    email: "studentloans@sbi.example.com",
    rateRange: "9.15% – 10.15%",
    maxUnsecured: 4000000,
    maxSecured: 15000000,
    minAcademicPercent: 60,
    nriOk: true,
    blurb: "Lowest rates for secured loans; concessional pricing for partner/ranked institutes.",
  },
];

export function getLender(id) {
  return LENDERS.find((l) => l.id === id);
}

const rupees = (n) => {
  if (!n) return "—";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
};

// Score every lender against this applicant. Returns all lenders, each with
// fit: true/false and human-readable reasons — the UI shows matches first and
// explains misses, mirroring how the eligibility engine explains itself.
export function matchLenders(lead, eligibility) {
  const loanType = lead?.loanType === "secured" ? "secured" : "unsecured";
  const amount = eligibility?.estimatedAmount || 0;

  return LENDERS.map((l) => {
    const reasons = [];
    let fit = true;

    if (!eligibility) {
      return { ...l, fit: false, reasons: ["Eligibility not assessed yet — applicant needs to sign in first."] };
    }
    if (!eligibility.eligible) {
      return { ...l, fit: false, reasons: ["Application is marked 'needs review' — resolve eligibility issues before referring."] };
    }

    const cap = loanType === "secured" ? l.maxSecured : l.maxUnsecured;
    if (amount > cap) {
      fit = false;
      reasons.push(`Estimated ${rupees(amount)} exceeds their ${rupees(cap)} ${loanType} cap.`);
    } else {
      reasons.push(`Covers the estimated ${rupees(amount)} (${loanType}, up to ${rupees(cap)}).`);
    }

    if (lead?.academicPercent != null) {
      if (lead.academicPercent < l.minAcademicPercent) {
        fit = false;
        reasons.push(`Academic score ${lead.academicPercent}% is below their ${l.minAcademicPercent}% minimum.`);
      } else {
        reasons.push(`Academic score ${lead.academicPercent}% meets their ${l.minAcademicPercent}% minimum.`);
      }
    }

    if (lead?.citizenship === "NRI" && !l.nriOk) {
      fit = false;
      reasons.push("Does not take NRI co-borrower cases.");
    }

    if (loanType === "secured" && l.type === "Bank") {
      reasons.push("Bank pricing advantage on secured loans.");
    }

    return { ...l, fit, reasons };
  }).sort((a, b) => Number(b.fit) - Number(a.fit));
}
