// Does a call actually turn into a file? — `npm run eval:extract`
//
// Two halves, deliberately separable:
//
//   PART 1  The arithmetic and the flag rules. No API key, no network, runs in
//           milliseconds. These are the numbers a loan officer acts on, and they
//           must be reproducible — the whole reason the FOIR is computed on the
//           server instead of being asked of a model.
//
//   PART 2  The extractor against a scripted transcript. Needs a key, and it is
//           the counterpart to `npm run eval` and `npm run eval:income`: the same
//           model that reads a figure off a PDF is now reading one off speech,
//           with the same failure mode. This repo has caught gpt-4o-mini reading
//           one ITR as ₹1,39,100 and ₹13,91,000 on separate runs, so the money
//           assertions below are the ones worth watching.
//
// Part 1 failing is a bug in this repo. Part 2 failing may just be the model
// having a bad run — which is itself the finding, and why it prints what it got.

import "dotenv/config";
import { coverage, computeUnderwriting, deriveFlags, coerce, parseRupees, getField } from "./callSchema.js";
import { extractCallFacts, extractorConfigured, extractorStatusLine, validate } from "./callExtract.js";
import { profilePatch } from "./callExtract.js";
import { planDocuments } from "./docPlan.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`);
  }
}

// ── PART 1 ──────────────────────────────────────────────────────────────────

console.log("\n── Money, as people actually say it ─────────────────────────");
check("15 lakh", parseRupees("15 lakh"), 1500000);
check("₹15,00,000", parseRupees("₹15,00,000"), 1500000);
check("1.5L", parseRupees("1.5L"), 150000);
check("95k a month", parseRupees("95k"), 95000);
check("1.2 crore", parseRupees("1.2 crore"), 12000000);
check("plain number passes through", parseRupees(1500000), 1500000);
// Word numerals are deliberately NOT parsed — better null than guessed.
check("'fifteen lakh' in words is refused", parseRupees("fifteen lakh"), null);

console.log("\n── Coercion refuses what it cannot trust ────────────────────");
const marks = getField("applicant", "marksPercent");
check("76% reads as 76", coerce(marks, "76%"), 76);
// The trap: a CGPA in a percent field would silently become 8%.
check("8.2 CGPA is refused, not read as 8.2%", coerce(marks, "8.2"), undefined);
const relation = getField("coApplicant", "relation");
check("father is father", coerce(relation, "Father"), "father");
// The model keeps writing "father" into the co-applicant's NAME field, because
// that is genuinely all the caller said. A relationship is not a name.
const coName = getField("coApplicant", "name");
check("a relationship is refused as a name", coerce(coName, "father"), undefined);
check("and so is 'my father'", coerce(coName, "My father"), undefined);
check("a real name is kept", coerce(coName, "Suresh Verma"), "Suresh Verma");
// The flowchart's exclusion: anything outside the permitted list must land on
// "other" so the flag fires, rather than vanishing as unrecognised.
check("cousin normalises to other", coerce(relation, "cousin"), "other");

console.log("\n── FOIR and the lender bands ───────────────────────────────");
// ₹95,000/month, ₹10,000 of existing EMI, ₹15L over 10 years:
//   new EMI      = 1500000 / 120        = 12500
//   FOIR now     = 10000 / 95000        = 10.5%
//   FOIR after   = 22500 / 95000        = 23.7%  → Lender 1
const strong = {
  coApplicant: { monthlyIncome: 95000, existingEmiMonthly: 10000, relation: "father" },
  loan: { amountNeeded: 1500000, type: "unsecured" },
};
const uwStrong = computeUnderwriting(strong);
check("proposed EMI is principal ÷ 120", uwStrong.proposedEmi, 12500);
check("FOIR before this loan", uwStrong.foirExisting, 10.5);
check("FOIR after this loan", uwStrong.foirUpdated, 23.7);
check("lands on Lender 1", uwStrong.lender, "Lender 1");

// ₹40,000/month, ₹18,000 existing, ₹30L: new EMI 25000, FOIR 107.5% → Lender 4.
const stretched = {
  coApplicant: { monthlyIncome: 40000, existingEmiMonthly: 18000, relation: "father" },
  loan: { amountNeeded: 3000000, type: "unsecured" },
};
const uwStretched = computeUnderwriting(stretched);
check("FOIR over 100 is reported, not clamped", uwStretched.foirUpdated, 107.5);
check("lands on Lender 4", uwStretched.lender, "Lender 4");

// The self-employed path: annual ITR ÷ 12, the same rule income.js applies to
// an uploaded ITR.
const selfEmployed = {
  coApplicant: { category: "self-employed", annualItr: 1200000, existingEmiMonthly: 0 },
  loan: { amountNeeded: 1200000 },
};
check("ITR ÷ 12 becomes monthly income", computeUnderwriting(selfEmployed).monthlyIncome, 100000);
check("and says where the figure came from", computeUnderwriting(selfEmployed).incomeBasis, "latest ITR ÷ 12");

// The one that matters most: no income means NO ratio, rather than a confident
// zero an officer might act on.
const empty = computeUnderwriting({});
check("an unknown income yields no FOIR at all", empty.ready, false);
check("and names what is missing", empty.missing, ["the co-applicant's income", "the loan amount"]);

console.log("\n── The flowchart's flags ───────────────────────────────────");
const codes = (p) => deriveFlags(p).map((f) => f.code).sort();
check("12th standard at 21 flags the gap", codes({ applicant: { age: 21, currentQualification: "12th" } }), ["age_vs_qualification"]);
check("17 at 12th standard flags nothing", codes({ applicant: { age: 17, currentQualification: "12th" } }), []);
check("living away from the Aadhaar address flags", codes({ applicant: { city: "Pune", aadhaarCity: "Nagpur" } }), ["address_mismatch"]);
check("same city, different case, does not flag", codes({ applicant: { city: "Pune", aadhaarCity: "pune " } }), []);
check("a cousin co-applicant flags", codes({ coApplicant: { relation: "other" } }), ["relation_not_permitted"]);
check("CIBIL 610 flags", codes({ applicant: { cibilScore: 610 } }), ["cibil_below_650"]);
// "NTC is good to go" — no bureau record is explicitly fine.
check("no CIBIL at all does not flag", codes({ applicant: { cibilScore: null } }), []);
check("one year of ITR flags", codes({ coApplicant: { itrYearsAvailable: 1 } }), ["itr_years_short"]);
// Observed: "three years of Form 16" lands in BOTH year fields. On a salaried
// file an ITR count is a threat about a document that will never be asked for.
check("an ITR count on a salaried file raises nothing",
  codes({ coApplicant: { category: "salaried", itrYearsAvailable: 1 } }), []);
check("a Form 16 count on a self-employed file raises nothing",
  codes({ coApplicant: { category: "self-employed", form16YearsAvailable: 1 } }), []);
check("but a short Form 16 on a salaried file still flags",
  codes({ coApplicant: { category: "salaried", form16YearsAvailable: 1 } }), ["form16_years_short"]);
check("52% marks flags", codes({ applicant: { marksPercent: 52 } }), ["marks_below_minimum"]);
check("a stretched file flags its FOIR", codes(stretched).includes("foir_high"), true);
check("an empty profile flags nothing at all", codes({}), []);

console.log("\n── Coverage ────────────────────────────────────────────────");
const cov = coverage({});
check("an empty profile has captured nothing", cov.captured, 0);
check("and every branch is listed", cov.branches.length, 5 - 1); // four collected; underwriting is derived
const partial = coverage({ applicant: { name: "Rohan", age: 24 } });
check("two answers count as two", partial.captured, 2);
// Form 16 is meaningless for a self-employed co-applicant and an ITR count is
// meaningless for a salaried one. Neither should sit on the dashboard as a
// permanent gap, and neither should be asked on a call.
const asks = (profile, branchId) =>
  coverage(profile).branches.find((b) => b.id === branchId).missing.map((m) => m.id);
const salariedAsks = asks({ coApplicant: { category: "salaried" } }, "coApplicant");
const selfEmpAsks = asks({ coApplicant: { category: "self-employed" } }, "coApplicant");
check("a salaried file is not asked for ITR years", salariedAsks.includes("itrYearsAvailable"), false);
check("a salaried file IS asked for Form 16 years", salariedAsks.includes("form16YearsAvailable"), true);
check("a self-employed file is not asked for Form 16", selfEmpAsks.includes("form16YearsAvailable"), false);
check("a self-employed file IS asked for the ITR figure", selfEmpAsks.includes("annualItr"), true);
// Before the category is known both paths are still live, or the question that
// resolves them never gets asked.
check("an unknown category asks both", asks({}, "coApplicant").includes("annualItr") && asks({}, "coApplicant").includes("form16YearsAvailable"), true);

console.log("\n── Validation rejects what it should ───────────────────────");
const turnsForValidate = [{ role: "caller", text: "my father earns ninety five thousand a month" }];
const bad = validate(
  {
    applicant: { salary: { value: 100, said: "x" } },        // no such field
    nonsense: { name: { value: "x", said: "y" } },           // no such branch
    coApplicant: {
      monthlyIncome: { value: "95000", said: "my father earns ninety five thousand a month" },
      cibilScore: { value: 700, said: "made up" },           // not a field a call may fill
    },
  },
  turnsForValidate
);
check("an invented field is dropped", bad.facts.applicant, undefined);
check("an invented branch is dropped", bad.facts.nonsense, undefined);
check("a real field survives", bad.facts.coApplicant.monthlyIncome, 95000);
check("an api-sourced field cannot be filled by a call", bad.facts.coApplicant.cibilScore, undefined);
check("a quote that is in the transcript is marked verbatim", bad.evidence["coApplicant.monthlyIncome"].verbatim, true);

// The same leak, caught one step earlier: never stored at all when the caller's
// own answers rule it out.
const leaked = validate(
  { coApplicant: { category: { value: "salaried", said: "he is salaried" }, itrYearsAvailable: { value: 3, said: "three years" } } },
  [{ role: "caller", text: "he is salaried, three years of Form 16" }]
);
check("an ITR count is not stored against a salaried co-applicant", leaked.facts.coApplicant.itrYearsAvailable, undefined);
check("and its quote goes with it", leaked.evidence["coApplicant.itrYearsAvailable"], undefined);
check("while the category itself is kept", leaked.facts.coApplicant.category, "salaried");

// The guard that exists because the model may write a sentence rather than
// quote one. The value survives; the officer is told to check it.
const invented = validate(
  { loan: { amountNeeded: { value: 1500000, said: "I need fifteen lakh" } } },
  [{ role: "caller", text: "something else entirely" }]
);
check("a quote that is NOT in the transcript is flagged", invented.evidence["loan.amountNeeded"].verbatim, false);
check("but the value is kept, not silently binned", invented.facts.loan.amountNeeded, 1500000);

console.log("\n── The patch that reaches storage ──────────────────────────");
const patch = profilePatch(
  { coApplicant: { monthlyIncome: 95000, existingEmiMonthly: 10000 } },
  { facts: { loan: { amountNeeded: 1500000 } }, evidence: {} }
);
// The point of the merge: the FOIR is computed against old facts PLUS new ones,
// so a call that only establishes the amount still produces a complete verdict.
check("underwriting is recomputed against the merged profile", patch.underwriting.foirUpdated, 23.7);
check("and the branch that arrived is in the patch", patch.loan.amountNeeded, 1500000);

console.log("\n── The doc agent only brings what the call implies ──────────");
const docAsks = (p) => planDocuments(p).asked.map((d) => d.id);
const docSkips = (p) => planDocuments(p).skipped.map((d) => d.id);

const salariedProfile = { coApplicant: { category: "salaried", recentJobChange: false, livesAtKycAddress: true } };
const selfEmpProfile = { coApplicant: { category: "self-employed", livesAtKycAddress: true } };

check("a salaried co-applicant is asked for Form 16", docAsks(salariedProfile).includes("co_form16"), true);
check("...and is NOT asked for three years of ITR", docSkips(salariedProfile).includes("co_itr_multi"), true);
check("...nor a computation of income", docSkips(salariedProfile).includes("co_income_computation"), true);
check("...nor a business current account", docSkips(salariedProfile).includes("co_current_account_statement"), true);
check("a self-employed co-applicant IS asked for the ITR years", docAsks(selfEmpProfile).includes("co_itr_multi"), true);
check("...and the computation behind them", docAsks(selfEmpProfile).includes("co_income_computation"), true);
check("...and is NOT asked for Form 16", docSkips(selfEmpProfile).includes("co_form16"), true);
check("no recent job change means no joining letter", docSkips(salariedProfile).includes("co_joining_letter"), true);
check("a recent job change asks for it",
  docAsks({ coApplicant: { category: "salaried", recentJobChange: true } }).includes("co_joining_letter"), true);
check("living at the KYC address needs no utility bill", docSkips(salariedProfile).includes("co_address_proof"), true);
check("living elsewhere does",
  docAsks({ coApplicant: { category: "salaried", livesAtKycAddress: false } }).includes("co_address_proof"), true);

// "if student is going for PG course, ask 10,12,UG; if UG then 10th&12th"
check("an MBA asks for the UG marksheet too", docAsks({ institute: { course: "MBA" } }).includes("student_marksheet_ug"), true);
check("a BTech does not", docSkips({ institute: { course: "BTech" } }).includes("student_marksheet_ug"), true);
check("10th and 12th are asked either way", docAsks({ institute: { course: "BTech" } }).includes("student_marksheet_10_12"), true);
check("an unsecured loan skips the property papers",
  docSkips({ loan: { type: "unsecured" } }).includes("collateral_property_papers"), true);
check("a secured loan asks for them",
  docAsks({ loan: { type: "secured" } }).includes("collateral_property_papers"), true);
check("the offer letter is asked for once it exists",
  docAsks({ institute: { offerLetter: "received" } }).includes("student_admit_letter"), true);
check("and is not asked for while they are still applying",
  docSkips({ institute: { offerLetter: "applied" } }).includes("student_admit_letter"), true);

// The pending list is the instruction half: what to ask to settle the rest.
const unknownCategory = planDocuments({});
check("an unknown income category is named as the question that decides most",
  unknownCategory.pending.some((p) => p.field === "category"), true);
check("and nothing is guessed in the meantime",
  docAsks({}).some((id) => ["co_form16", "co_itr_multi"].includes(id)), false);
// Narrowing has to actually narrow, or the join buys nothing.
check("a fully-known salaried file asks for fewer documents than an unknown one",
  docAsks({ ...salariedProfile, institute: { course: "MBA", offerLetter: "received" }, loan: { type: "unsecured" } }).length <
    docAsks({ ...selfEmpProfile, institute: { course: "MBA", offerLetter: "received" }, loan: { type: "secured" } }).length,
  true);

// ── PART 2 ──────────────────────────────────────────────────────────────────

// A scripted call that covers all four collected branches, written the way
// people actually talk: numbers spoken in lakhs, one self-correction, one
// question answered with a question, and a relation the flowchart forbids.
const TRANSCRIPT = [
  { role: "agent", text: "Hi, this is UPSY. Tell me what you are studying and what you need, and I will tell you where you stand." },
  { role: "caller", text: "Hi, I am Rohan Verma. I want to do an MBA and I need a loan." },
  { role: "agent", text: "Happy to help with that, Rohan. How old are you, and where are you based?" },
  { role: "caller", text: "I am 24, I live in Pune. But my Aadhaar address is Nagpur, that is my home town." },
  { role: "agent", text: "That is fine, we will just need a current address proof later. What have you finished so far, and roughly what did you score?" },
  { role: "caller", text: "I finished my BCom, I got 76 percent. There was a two year gap after that, I was working." },
  { role: "agent", text: "Good. Which institute is the MBA at?" },
  { role: "caller", text: "IIM Bangalore, it is a two year course. The fee is about 25 lakh, sorry, 24 lakh." },
  { role: "agent", text: "Does that figure include hostel and living costs?" },
  { role: "caller", text: "No, that is just tuition. Hostel is extra." },
  { role: "agent", text: "Understood. Do you have the admission letter yet?" },
  { role: "caller", text: "Yes I received the offer letter last week." },
  { role: "agent", text: "And how much of that fee do you need to borrow?" },
  { role: "caller", text: "About 15 lakh. We do not have any property to give as security, so it has to be without collateral." },
  { role: "agent", text: "So that is fifteen lakh unsecured — have I got that right?" },
  { role: "caller", text: "Yes, fifteen lakh." },
  { role: "agent", text: "Who will co-apply with you?" },
  { role: "caller", text: "My uncle, he is like a father to me." },
  { role: "agent", text: "I should be straight with you — lenders need immediate family for this. Is a parent an option?" },
  { role: "caller", text: "Okay, then my father. He is salaried, he takes home about 95,000 a month." },
  { role: "agent", text: "Thank you. Is he paying any EMIs at the moment?" },
  { role: "caller", text: "Yes, a car loan, around 12,000 every month. He has not guaranteed anyone else's loan." },
  { role: "agent", text: "And how many years of Form 16 can he produce?" },
  { role: "caller", text: "Three years, he has been at the same company for a long time." },
];

async function part2() {
  console.log(`\n── The extractor, on a scripted call (${extractorStatusLine()}) ──`);
  if (!extractorConfigured()) {
    console.log("  ⏭  Skipped — neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set.");
    console.log("     Part 1 above still proves the arithmetic; nothing proves the reading.");
    return;
  }

  const result = await extractCallFacts({ turns: TRANSCRIPT });
  if (!result) {
    failed++;
    console.log("  ❌ extraction returned nothing at all");
    return;
  }
  console.log(`  read in ${result.ms}ms by ${result.model}\n`);
  console.log(JSON.stringify(result.facts, null, 2).split("\n").map((l) => `     ${l}`).join("\n"));
  if (result.dropped.length) console.log(`\n     dropped: ${result.dropped.join("; ")}`);

  const f = result.facts;
  console.log("");
  check("student's name", f.applicant?.name, "Rohan Verma");
  check("age", f.applicant?.age, 24);
  check("city they live in", f.applicant?.city, "Pune");
  check("Aadhaar city, which is the mismatch the flowchart wants flagged", f.applicant?.aadhaarCity, "Nagpur");
  check("marks", f.applicant?.marksPercent, 76);
  check("institute", f.institute?.name, "IIM Bangalore");
  check("hostel fee is outside the quoted figure", f.institute?.hostelFeeIncluded, false);
  check("offer letter", f.institute?.offerLetter, "received");
  // The self-correction: 25 lakh was said first, 24 lakh corrected immediately.
  check("the corrected fee, not the first figure", f.institute?.totalFee, 2400000);
  check("loan amount", f.loan?.amountNeeded, 1500000);
  check("unsecured", f.loan?.type, "unsecured");
  // The other correction, and the one with a rule attached: the uncle was
  // withdrawn in favour of the father.
  check("the co-applicant they settled on", f.coApplicant?.relation, "father");
  check("co-applicant income", f.coApplicant?.monthlyIncome, 95000);
  check("existing EMIs", f.coApplicant?.existingEmiMonthly, 12000);
  check("Form 16 years", f.coApplicant?.form16YearsAvailable, 3);
  check("not a guarantor elsewhere", f.coApplicant?.guarantorElsewhere, false);

  // And the whole point: the branches turn into a verdict.
  const patched = profilePatch({}, result);
  const uw = patched.underwriting;
  console.log("");
  if (uw.ready) {
    console.log(`  → FOIR ${uw.foirExisting}% now, ${uw.foirUpdated}% with this loan → ${uw.lender}`);
  } else {
    console.log(`  → no verdict: missing ${uw.missing.join(" and ")}`);
  }
  const flagCodes = patched._flags.map((x) => x.code);
  console.log(`  → flags: ${flagCodes.length ? flagCodes.join(", ") : "none"}`);

  // And the whole point of the join: a shorter list of documents to go and get.
  const plan = planDocuments(patched);
  console.log(`  → documents: ask for ${plan.counts.asked}, ruled out ${plan.counts.skipped}, ${plan.counts.pending} question(s) still open`);
  console.log(`     ruled out: ${plan.skipped.map((d) => d.label).join("; ") || "nothing"}`);
  check("a salaried co-applicant on this call is not asked for ITR years",
    plan.skipped.some((d) => d.id === "co_itr_multi"), true);
  check("and the MBA pulls in the UG marksheet",
    plan.asked.some((d) => d.id === "student_marksheet_ug"), true);
  check("the Pune/Nagpur mismatch is flagged", flagCodes.includes("address_mismatch"), true);
  check("the hostel fee exclusion is flagged", flagCodes.includes("hostel_fee_excluded"), true);

  // Every value carries the sentence it came from — the README's second
  // extractor decision, checked rather than assumed.
  const quoted = Object.values(result.evidence).filter((e) => e.said).length;
  const total = Object.keys(result.evidence).length;
  const unmatched = Object.entries(result.evidence).filter(([, e]) => e.said && !e.verbatim).map(([k]) => k);
  console.log(`\n  → ${quoted}/${total} values carry a quote; ${unmatched.length} could not be matched to the transcript`);
  if (unmatched.length) console.log(`     unmatched: ${unmatched.join(", ")}`);
  check("every value carries a quote", quoted, total);
}

await part2();

// ── PART 3, opt-in: `npm run eval:extract -- --seed` ────────────────────────
//
// Puts the scripted call above into the real store, against a real account, so
// there is something to look at on /team → Voice callers without needing a
// phone, a microphone and a Deepgram key. It goes through recordCall() and
// fileCall() — the same two functions voiceRelay.js calls when a real caller
// hangs up — rather than writing JSON into data/ by hand, so what appears on
// the dashboard is what a live call would put there.
//
// Off by default: an eval that mutates the store every time it runs is not an
// eval. Re-running reuses the same account rather than piling up demo callers.
async function seed() {
  const { createAccount, authenticate, recordCall } = await import("./voiceAccounts.js");
  const { fileCall } = await import("./callExtract.js");

  const phone = "9000000001";
  const password = "upsy-demo-seed";
  let account;
  try {
    ({ account } = await createAccount({ name: "Rohan Verma", phone, password }));
    console.log(`\n  created demo caller ${account.accountId} (${phone})`);
  } catch (e) {
    if (e.code !== "TAKEN") throw e;
    ({ account } = await authenticate({ phone, password }));
    console.log(`\n  reusing demo caller ${account.accountId} (${phone})`);
  }

  await recordCall(account.accountId, {
    startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    endedAt: new Date().toISOString(),
    seconds: 232,
    endedBecause: "seeded by eval:extract",
    turns: TRANSCRIPT.map((t) => ({ ...t, at: new Date().toISOString() })),
  });

  const result = await fileCall({ accountId: account.accountId, turns: TRANSCRIPT, reason: "seed" });
  console.log(`  ${result?.summary || "nothing filed — is a model key set?"}`);
  console.log(`  → open /team, switch to Voice callers, and pick ${account.name}.\n`);
}

if (process.argv.includes("--seed")) await seed();

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
