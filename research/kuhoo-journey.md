# Kuhoo Education Loan — App Journey & Document Requirements

Research notes for the UPSY Loan Agent. Source: kuhoo.com, kuhoo.com/faqs, web5.kuhoo.com/app (lead form), Play Store listing. 
TODO: verify against the actual logged-in app journey (blocked on Chrome extension connection — see README).

## The journey (order matters — our agent should mirror this)

1. **Lead capture / signup** — name, phone (OTP login), institute name, course/degree, "institute decided?" yes/no. Terms + privacy accept → "Check Eligibility Now".
2. **4-minute eligibility check** — education details (highest qualification, college, course, specialization, duration, marks, 10th & 12th %), work details (experience, monthly income, last employer), PAN (mandatory, minor PAN if minor).
3. **Document upload in-app** (see checklist below), guided by support.
4. **Document review** — within 24 hours.
5. **Product selection** — Kuhoo team + algorithm picks lender/product.
6. **Status tracking** — real-time in app.
7. **Sanction** — 2–7 days.
8. **Processing fee + post-sanction requirements.**
9. **Disbursement scheduling** — inform lender ≥2 weeks before needed date.
10. **Disbursement** — loan agreement signing, KYC verification, auto-debit (NACH) mandate, compliance.

## Document checklist (the collection order for our agent)

### Student
- KYC: Aadhaar, PAN (mandatory)
- Photo
- Admission/admit letter
- Entrance test scores (CAT/XAT/JEE/NEET etc.)
- Latest degree marksheet (+ 10th/12th marksheets)
- Work experience proof
- Last salary slip or offer letter
- Last 6 months' bank statement

### Co-applicant — non-financial
- KYC: Aadhaar, PAN
- Photo
- Relationship proof with student
- Cancelled cheque / passbook (for NACH)

### Co-applicant — financial (all of the above, plus)
- 6-month bank statement
- 3-month salary slips or ITR

### Collateral (if secured loan)
- Accepted: fixed deposits; flat/house/bungalow, non-agricultural land, shop
- Not accepted: mutual funds, commercial property; agricultural land case-by-case
- Property papers as collateral documents

## Eligibility rules worth encoding

- Indian citizen, admission to eligible course, minimum academic criteria
- Co-borrower must be family (father/mother/brother/sister/spouse; no friends); stable income
- NRI co-borrower: needs NRE/NRO account + Indian collateral + an additional India-resident co-borrower
- Loan range: ₹50k – ₹1 Cr unsecured, ₹2 Cr collateralized
- Target segment: 3rd/4th-yr engineering, final-yr MBA, dual-degree 4th/5th yr; medical, law, pilot training, study abroad (33 countries)
- Moratorium: course duration + 6–12 months grace; Section 80-E tax deduction on interest (8 yrs, no cap)

## Key insight from user

"Same document requirements are needed across industry" — this checklist is roughly standard for every Indian education-loan lender (banks + NBFCs). The agent's core value: know this list cold, collect documents in this order, validate each one.
