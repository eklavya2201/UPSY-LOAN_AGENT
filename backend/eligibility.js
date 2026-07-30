// Preliminary eligibility engine. Encodes the industry-standard rules from
// research/kuhoo-journey.md so the agent can give an instant estimate instead
// of just collecting paperwork for a human to eventually decide on.
//
// This is intentionally simple and transparent (no ML) — every number below
// traces back to a rule in the research notes, and every reason is explained
// so an officer or applicant can see exactly why.

const UNSECURED_MAX = 10000000; // ₹1 Cr
const SECURED_MAX = 20000000; // ₹2 Cr
const LOAN_FLOOR = 50000; // ₹50k
const MIN_ACADEMIC_PERCENT = 60;
const INCOME_MULTIPLE = 24; // common bank heuristic: ~24x monthly co-applicant income

export function assessEligibility(lead) {
  const reasons = [];
  const warnings = [];
  let eligible = true;

  // 1. Academic minimum.
  if (lead.academicPercent != null) {
    if (lead.academicPercent < MIN_ACADEMIC_PERCENT) {
      eligible = false;
      reasons.push(`Academic score of ${lead.academicPercent}% is below the ${MIN_ACADEMIC_PERCENT}% minimum most lenders require.`);
    }
  } else {
    warnings.push("Academic score not on record yet — needed to confirm eligibility.");
  }

  // 2. Co-applicant must be family, with stable/verifiable income.
  const familyRelations = ["father", "mother", "brother", "sister", "spouse"];
  if (lead.coApplicantRelation && !familyRelations.includes(lead.coApplicantRelation.toLowerCase())) {
    eligible = false;
    reasons.push(`Co-borrower must be immediate family (father/mother/brother/sister/spouse) — "${lead.coApplicantRelation}" is not eligible. Friends cannot co-borrow.`);
  }

  const income = lead.coApplicantMonthlyIncome || 0;
  if (income <= 0) {
    eligible = false;
    reasons.push("No co-applicant income on record — a family co-borrower with stable income is mandatory.");
  }

  // 3. NRI co-borrower needs extra requirements (not disqualifying, just a heads-up).
  if (lead.citizenship === "NRI") {
    warnings.push("As an NRI co-borrower case, you'll also need an NRE/NRO account, Indian collateral, and an additional India-resident co-borrower.");
  }

  // 4. Estimate a loan amount within the applicable band.
  const cap = lead.loanType === "secured" ? SECURED_MAX : UNSECURED_MAX;
  const incomeBasedEstimate = income * INCOME_MULTIPLE;
  const estimatedAmount = eligible ? Math.min(Math.max(incomeBasedEstimate, income > 0 ? LOAN_FLOOR : 0), cap) : 0;

  // 5. Moratorium: course duration + 6-12 months grace (use the midpoint, 9 months).
  const courseDurationMonths = lead.courseDurationMonths || 24;
  const moratoriumMonths = courseDurationMonths + 9;

  return {
    eligible,
    reasons,
    warnings,
    estimatedAmount,
    loanRange: { min: LOAN_FLOOR, max: cap },
    moratoriumMonths,
    ratePreview: lead.loanType === "secured" ? "9.5% – 11.5% (secured, indicative)" : "10.5% – 13% (unsecured, indicative)",
  };
}
