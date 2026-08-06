// UPSY applicant app — multi-page step flow (sign in → eligibility → per-document
// upload → verification result → done), wired to the live backend.

const app = document.getElementById("app");
let LEAD = null;
let queue = [];     // remaining documents (agenda)
let idx = 0;
let total = 0;
let verified = 0;       // docs already done at session start (on file)
let eligibility = null;
let onFileDocs = [];
const doneSet = new Set(); // doc ids verified during this session (avoids double counting on re-upload)
let completedSent = false;
let CONTEXT = null; // structured loan intent captured by the smart intake step at login
let lastFailedChecks = []; // failed checks from the most recent upload (context for the doc helper)
let partnerInstitute = null; // set at sign-in if the lead's institute is a UPSY partner
let previewUrl = null; // object URL of the currently previewed upload (revoked on replace)

const progressDone = () => verified + doneSet.size;
const firstPendingIdx = () => {
  const i = queue.findIndex((d) => !doneSet.has(d.id));
  return i < 0 ? queue.length : i; // all done -> past the end (completion)
};

const rupees = (n) => {
  if (!n) return "—";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
};

// ---- shared chrome ----
function topbar(progressLabel) {
  const pct = total ? Math.round((progressDone() / total) * 100) : 0;
  return `
    <header class="fixed top-0 inset-x-0 z-50 h-16 bg-surface/80 backdrop-blur-md shadow-sm">
      <div class="h-16 px-6 flex items-center justify-between">
        <span class="text-2xl font-bold text-primary">UPSY</span>
        <div class="flex items-center gap-4">
          ${progressLabel ? `
          <div class="hidden md:flex flex-col items-end">
            <span class="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">${progressLabel}</span>
            <div class="w-40 h-1.5 bg-surface-container rounded-full mt-1 overflow-hidden">
              <div class="h-full bg-primary rounded-full transition-all duration-700" style="width:${pct}%"></div>
            </div>
          </div>` : ""}
          <div class="w-9 h-9 rounded-full bg-primary-soft border border-outline-variant grid place-items-center text-primary font-bold">
            ${LEAD?.name ? LEAD.name[0] : "U"}
          </div>
        </div>
      </div>
    </header>`;
}

function page(inner) {
  app.innerHTML = inner;
  window.scrollTo(0, 0);
}

// ---- client-side routing: /login → /intake → /docs ----
function go(path, opts = {}) {
  if (opts.replace) history.replaceState({}, "", path);
  else if (location.pathname !== path) history.pushState({}, "", path);
  route();
}
// Navigate to a document step by index — every step gets its own history entry
// (/docs/1, /docs/2, … /docs/done) so the browser Back button walks the steps
// instead of dumping the applicant all the way back to the phone login.
function goDoc(i, opts = {}) {
  idx = i;
  go(i >= queue.length ? "/docs/done" : `/docs/${i + 1}`, opts);
}

let restoring = false;
function route() {
  const p = location.pathname;
  const guarded = p === "/intake" || p === "/docs" || p.startsWith("/docs/");
  // A page refresh drops the in-memory session — quietly restore it from the
  // saved phone number instead of bouncing the applicant back to login.
  if (guarded && !LEAD) {
    if (restoring) return;
    const savedPhone = sessionStorage.getItem("upsy_phone");
    if (!savedPhone) return go("/login", { replace: true });
    restoring = true;
    page(`${topbar("")}
      <main class="pt-40 text-center fade-in">
        <div class="text-on-surface-variant flex items-center justify-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span> Getting your application back…</div>
      </main>`);
    startSession(savedPhone)
      .then(() => { restoring = false; route(); })
      .catch(() => { restoring = false; sessionStorage.removeItem("upsy_phone"); go("/login", { replace: true }); });
    return;
  }
  if (p === "/intake") return renderIntake();
  if (p === "/docs" || p.startsWith("/docs/")) {
    const seg = p.slice("/docs/".length);
    if (!seg) return renderEligibility();          // /docs — eligibility overview
    if (seg === "done") return renderDone();       // /docs/done — completion
    const n = Number(seg);                          // /docs/N — document N
    if (Number.isInteger(n) && n >= 1 && n <= queue.length) { idx = n - 1; return renderCurrent(); }
    return go("/docs", { replace: true });          // unknown step — back to overview
  }
  if (p !== "/login") history.replaceState({}, "", "/login");
  renderSignin();
}

// ---- 1. Sign in ----
function renderSignin() {
  page(`
    ${topbar("")}
    <main class="pt-16 min-h-screen flex items-center justify-center px-6">
      <div class="w-full max-w-md bg-white rounded-2xl p-8 md:p-10 card-shadow border border-outline-variant/30 fade-in">
        <h1 class="text-3xl font-bold mb-2">Welcome to UPSY</h1>
        <p class="text-on-surface-variant mb-8">Enter your mobile number and we'll pull up your loan application.</p>
        <label class="block text-sm font-medium text-on-surface-variant mb-2 ml-1">Mobile number</label>
        <input id="phone" type="tel" inputmode="numeric" placeholder="e.g. 9999999999"
          class="w-full h-12 px-4 rounded-xl border border-outline-variant bg-surface focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition mb-6"/>
        <button id="continue" class="w-full h-12 bg-primary text-white font-semibold rounded-full hover:bg-primary-dark active:scale-[0.98] transition">Continue</button>
        <p id="signin-error" class="text-danger text-sm mt-3 hidden"></p>
      </div>
    </main>`);
  const input = document.getElementById("phone");
  input.addEventListener("input", () => (input.value = input.value.replace(/\D/g, "")));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") beginSession(); });
  document.getElementById("continue").addEventListener("click", beginSession);
  input.focus();
}

// Fetch the lead + agenda and set all session state. Used by the login form and
// by the refresh-restore path in route(). Throws on failure.
async function startSession(phone) {
  const res = await fetch("/api/session/start", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  LEAD = data.lead;
  queue = data.documents || data.agenda;   // full ordered list, done ones flagged
  total = data.total;
  verified = 0;                            // all completion tracked via doneSet
  doneSet.clear();
  queue.forEach((d) => { if (d.done) doneSet.add(d.id); });
  eligibility = data.eligibility; onFileDocs = data.onFileDocs || [];
  partnerInstitute = data.partnerInstitute || null;
  idx = firstPendingIdx();
  sessionStorage.setItem("upsy_phone", phone); // lets a page refresh restore the session
  // Also readable from /m (frontend/m.js), so a voice call started there can be
  // grounded in this applicant's real record instead of running anonymously.
  if (LEAD && LEAD.leadId) sessionStorage.setItem("upsy_lead", LEAD.leadId);
  // The name too, purely so /m can greet them before the call rather than
  // waiting for the session round trip to tell it who is calling.
  if (LEAD && LEAD.name) sessionStorage.setItem("upsy_name", LEAD.name);
}

async function beginSession() {
  const phone = document.getElementById("phone").value.replace(/\D/g, "");
  const err = document.getElementById("signin-error");
  if (phone.length < 10) { err.textContent = "Enter a valid 10-digit number."; err.classList.remove("hidden"); return; }
  const btn = document.getElementById("continue");
  btn.disabled = true; btn.textContent = "Looking you up…";
  try {
    await startSession(phone);
    // Every login goes through the smart intake first, then documents.
    // (Returning users can hit "Skip for now" on the intake to jump straight to docs.)
    go("/intake");
  } catch (e) {
    err.textContent = e.message || "Something went wrong. Try again.";
    err.classList.remove("hidden");
    btn.disabled = false; btn.textContent = "Continue";
  }
}

// ---- 1b. Smart intake: capture loan context (in plain words) before documents ----
const INTAKE_FIELDS = [
  ["amountInr", "Loan amount", (v) => rupees(v)],
  ["studyLevel", "Study level", (v) => v],
  ["fieldOfStudy", "Field of study", (v) => v],
  ["institution", "Institution", (v) => v],
  ["country", "Country", (v) => v],
  ["intake", "Intake", (v) => v],
  ["coApplicant", "Co-applicant", (v) => v],
  ["collateral", "Loan type", (v) => (v === "secured" ? "Secured (collateral)" : v === "unsecured" ? "Unsecured" : v)],
  ["tenureYears", "Tenure", (v) => `${v} years`],
];

function intakeRow(label, val, muted) {
  return `<div class="flex items-center justify-between py-2.5 border-b border-surface-container last:border-0">
    <span class="text-sm ${muted ? "text-on-surface-variant/70" : "text-on-surface-variant"}">${label}</span>
    <span class="text-sm font-semibold ${muted ? "text-on-surface-variant/50 italic" : "text-on-surface"}">${val}</span>
  </div>`;
}

// How to ask for each field when it's missing (rendered as answerable inputs on /intake).
const INTAKE_INPUTS = {
  amountInr: { label: "How much do you need? (₹)", type: "number", placeholder: "e.g. 800000" },
  studyLevel: { label: "What level are you studying?", type: "select", options: ["Bachelors", "Masters", "MBA", "PhD", "Diploma"] },
  fieldOfStudy: { label: "What field of study?", type: "text", placeholder: "e.g. Computer Science" },
  institution: { label: "Which institution?", type: "text", placeholder: "College / university" },
  country: { label: "Which country?", type: "text", placeholder: "e.g. US, Canada, India" },
  intake: { label: "When do you start (intake)?", type: "text", placeholder: "e.g. Aug 2026" },
  coApplicant: { label: "Who is your co-applicant?", type: "select", options: ["father", "mother", "spouse", "sibling", "other"] },
  collateral: { label: "Secured or unsecured loan?", type: "select", options: ["unsecured", "secured"] },
  tenureYears: { label: "Preferred tenure (years)?", type: "number", placeholder: "e.g. 10" },
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function intakeInput(key) {
  const m = INTAKE_INPUTS[key];
  if (!m) return "";
  const control = m.type === "select"
    ? `<select data-intent="${key}" class="mt-1.5 w-full h-11 px-3 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition">
         <option value="">Select…</option>
         ${m.options.map((o) => `<option value="${o}">${cap(o)}</option>`).join("")}
       </select>`
    : `<input data-intent="${key}" type="${m.type}" placeholder="${m.placeholder || ""}" class="mt-1.5 w-full h-11 px-3 bg-white border border-outline-variant rounded-xl focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition"/>`;
  return `<label class="block"><span class="text-sm font-medium text-on-surface">${m.label}</span>${control}</label>`;
}

// Read the answered inputs, merge into the captured intent, then move to documents.
function saveIntakeAndContinue() {
  document.querySelectorAll("[data-intent]").forEach((el) => {
    const key = el.dataset.intent;
    const raw = (el.value || "").trim();
    if (!raw) return;
    if (key === "amountInr" || key === "tenureYears") {
      const n = Number(raw.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n > 0) CONTEXT.intent[key] = n;
    } else {
      CONTEXT.intent[key] = raw;
    }
  });
  go("/docs");
}

function contextSummaryLine() {
  if (!CONTEXT?.intent) return "";
  const i = CONTEXT.intent;
  return [
    i.amountInr ? rupees(i.amountInr) : null, i.studyLevel, i.fieldOfStudy,
    i.institution, i.country, i.collateral === "secured" ? "secured" : null,
  ].filter(Boolean).join(" · ");
}

function renderIntake() {
  const examples = ["MS in US, ~8 lakh, dad co-applicant", "MBA abroad, 25 lakhs, property to pledge", "B.Tech in India, 5 lakh, mom co-borrower"];
  page(`
    ${topbar("")}
    <main class="pt-28 pb-20 max-w-2xl mx-auto px-6 fade-in">
      <span class="text-xs font-bold text-primary bg-primary-soft border border-primary-line px-2.5 py-1 rounded-full">STEP 1</span>
      <h1 class="text-3xl font-bold mt-3 mb-2">Hi ${LEAD.name || "there"} 👋 Tell us what you need</h1>
      <p class="text-on-surface-variant mb-6">In one line, describe your loan in plain words. We'll set up your application and only ask for what's missing — then collect your documents.</p>
      <textarea id="intakeText" rows="3" placeholder="e.g. I need around 8 lakh for an MS in the US, starting this August. My dad will be co-applicant."
        class="w-full p-4 bg-white border border-outline-variant rounded-2xl text-base focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition resize-none"></textarea>
      <div id="intakeExamples" class="flex flex-wrap gap-2 mt-3">
        ${examples.map((x) => `<button class="ex text-xs text-on-surface-variant bg-white border border-outline-variant hover:border-primary rounded-full px-3 py-1.5 transition">${x}</button>`).join("")}
      </div>
      <div class="flex items-center gap-3 mt-5">
        <button id="intakeGo" class="h-12 px-8 bg-primary text-white font-semibold rounded-full hover:bg-primary-dark active:scale-[0.98] transition inline-flex items-center gap-2 disabled:opacity-50"><span class="material-symbols-outlined">auto_awesome</span> Continue</button>
        <button id="intakeSkip" class="h-12 px-5 text-on-surface-variant font-medium rounded-full hover:bg-surface-container transition">Skip for now</button>
      </div>
      <div id="intakeResult" class="mt-8"></div>
    </main>`);
  const ta = document.getElementById("intakeText");
  if (CONTEXT?.rawText) ta.value = CONTEXT.rawText;
  document.getElementById("intakeExamples").querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => { ta.value = b.textContent.trim(); ta.focus(); }));
  document.getElementById("intakeSkip").addEventListener("click", () => go("/docs"));
  document.getElementById("intakeGo").addEventListener("click", submitIntake);
  ta.focus();
}

async function submitIntake() {
  const ta = document.getElementById("intakeText");
  const value = ta.value.trim();
  if (!value) { ta.focus(); return; }
  const go = document.getElementById("intakeGo");
  const res = document.getElementById("intakeResult");
  go.disabled = true;
  res.innerHTML = `<div class="text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span> Setting up your application…</div>`;
  let data;
  try {
    const r = await fetch("/api/intake", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: value, leadId: LEAD.leadId }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || "Couldn't process that.");
  } catch (e) {
    res.innerHTML = `<div class="bg-danger-soft border border-danger/30 rounded-2xl p-4 text-danger">${e.message}</div>`;
    go.disabled = false; return;
  }
  CONTEXT = { ...data, rawText: value };
  renderIntakeConfirm(data);
}

function renderIntakeConfirm(data) {
  const captured = INTAKE_FIELDS.filter(([k]) => data.intent[k] != null);
  const missing = INTAKE_FIELDS.filter(([k]) => data.intent[k] == null);
  page(`
    ${topbar("")}
    <main class="pt-28 pb-20 max-w-2xl mx-auto px-6 fade-in">
      <span class="text-xs font-bold text-primary bg-primary-soft border border-primary-line px-2.5 py-1 rounded-full">STEP 1</span>
      ${data.summary ? `
        <div class="bg-success-soft border border-success/30 rounded-2xl p-4 flex items-start gap-3 mt-3 mb-6">
          <span class="material-symbols-outlined text-success">check_circle</span>
          <div><div class="font-semibold text-success">Got it — here's your application so far</div>
          <div class="text-sm text-on-surface mt-0.5">${data.summary}</div></div>
        </div>` : ""}
      <div class="bg-white rounded-2xl p-6 card-shadow border border-outline-variant/40 mb-6">
        <div class="text-xs uppercase tracking-widest text-on-surface-variant mb-3">Your application so far</div>
        ${captured.map(([k, label, fmt]) => intakeRow(label, fmt(data.intent[k]), false)).join("") || `<div class="text-sm text-on-surface-variant">Nothing captured yet — a few questions below.</div>`}
      </div>
      ${missing.length ? `
        <div class="bg-primary-soft border border-primary-line rounded-2xl p-5 mb-6">
          <div class="font-semibold text-primary mb-4 flex items-center gap-2"><span class="material-symbols-outlined">forum</span> A few quick questions before your documents</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${missing.map(([k]) => intakeInput(k)).join("")}
          </div>
        </div>` : ""}
      <div class="flex items-center gap-3">
        <button id="intakeEdit" class="h-12 px-5 text-on-surface-variant font-medium rounded-full hover:bg-surface-container transition">Edit</button>
        <button id="intakeNext" class="h-12 px-8 bg-primary text-white font-semibold rounded-full hover:bg-primary-dark active:scale-[0.98] transition inline-flex items-center gap-2">Continue to documents <span class="material-symbols-outlined">arrow_forward</span></button>
      </div>
    </main>`);
  document.getElementById("intakeEdit").addEventListener("click", renderIntake);
  document.getElementById("intakeNext").addEventListener("click", saveIntakeAndContinue);
}

// ---- EMI assistance: education-loan instalment estimate with study moratorium ----
const inr = (n) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;

// Education-loan EMI. Repayment starts after the moratorium (study + grace). Two modes:
//  - pay interest during study (simple interest each month) → principal stays as-is
//  - full moratorium → interest accrued during study is added to the loan (capitalised)
function computeEmiNumbers({ principal, annualRatePct, years, moratoriumMonths, payDuringStudy }) {
  const n = Math.max(1, Math.round(years * 12));
  const r = annualRatePct / 100 / 12;
  const moratoriumInterest = principal * (annualRatePct / 100) * (moratoriumMonths / 12);
  let emiPrincipal = principal;
  let duringStudyMonthly = 0;
  if (payDuringStudy) duringStudyMonthly = principal * r;      // pay interest monthly while studying
  else emiPrincipal = principal + moratoriumInterest;          // otherwise it's capitalised
  const emi = r > 0 ? (emiPrincipal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : emiPrincipal / n;
  const totalRepayment = emi * n + duringStudyMonthly * moratoriumMonths;
  return { emi, n, duringStudyMonthly, totalRepayment, totalInterest: totalRepayment - principal };
}

function emiCardHtml() {
  const e = eligibility || {};
  const amount = (CONTEXT && CONTEXT.intent && CONTEXT.intent.amountInr) || e.estimatedAmount || 500000;
  const rateStr = (e.ratePreview || "").split(" (")[0];
  const rateNums = (rateStr.match(/\d+(\.\d+)?/g) || []).map(Number);
  const rate = rateNums.length ? (rateNums.length > 1 ? (rateNums[0] + rateNums[1]) / 2 : rateNums[0]) : 11;
  const tenure = (CONTEXT && CONTEXT.intent && CONTEXT.intent.tenureYears) || 7;
  const mor = e.moratoriumMonths || 0;
  return `
    <div class="bg-white rounded-2xl p-6 md:p-8 border border-outline-variant/40 mb-10">
      <div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined text-primary">calculate</span><h3 class="text-xl font-semibold">EMI assistance</h3></div>
      <p class="text-sm text-on-surface-variant mb-6">Estimate your monthly instalment. Repayment starts after your ${mor}-month study moratorium — move the tenure to see how the EMI changes.</p>
      <div class="grid md:grid-cols-2 gap-8">
        <div class="space-y-4">
          <label class="block"><span class="text-sm font-medium">Loan amount (₹)</span>
            <input id="emiAmount" type="number" value="${Math.round(amount)}" class="mt-1.5 w-full h-11 px-3 bg-surface border border-outline-variant rounded-xl focus:border-primary outline-none"/></label>
          <label class="block"><span class="text-sm font-medium">Interest rate (% p.a.)</span>
            <input id="emiRate" type="number" step="0.1" value="${rate}" class="mt-1.5 w-full h-11 px-3 bg-surface border border-outline-variant rounded-xl focus:border-primary outline-none"/></label>
          <label class="block"><span class="text-sm font-medium">Repayment tenure — <span id="emiTenureLabel">${tenure} years</span></span>
            <input id="emiTenure" type="range" min="1" max="15" step="1" value="${tenure}" class="mt-2 w-full accent-primary"/></label>
          <label class="flex items-center gap-2 text-sm cursor-pointer"><input id="emiPayDuring" type="checkbox" class="accent-primary w-4 h-4"/> Pay interest during study <span class="text-on-surface-variant">(lowers total cost)</span></label>
        </div>
        <div id="emiOut"></div>
      </div>
      <p class="text-xs text-on-surface-variant italic mt-6 flex items-start gap-2"><span class="material-symbols-outlined text-[16px] mt-0.5">info</span> Illustration only — not a sanction or offer. Your final EMI depends on the approved amount, rate and tenure.</p>
    </div>`;
}

function computeEmi() {
  const num = (id) => Number(document.getElementById(id).value) || 0;
  const amount = Math.max(0, num("emiAmount"));
  const rate = Math.max(0, num("emiRate"));
  const years = Math.max(1, num("emiTenure"));
  const payDuringStudy = document.getElementById("emiPayDuring").checked;
  const mor = (eligibility && eligibility.moratoriumMonths) || 0;
  document.getElementById("emiTenureLabel").textContent = `${years} year${years > 1 ? "s" : ""}`;
  const res = computeEmiNumbers({ principal: amount, annualRatePct: rate, years, moratoriumMonths: mor, payDuringStudy });
  document.getElementById("emiOut").innerHTML = `
    <div class="bg-primary-soft rounded-xl p-5 text-center mb-3">
      <div class="text-xs uppercase tracking-wide text-primary/70 mb-1">Monthly EMI (after study)</div>
      <div class="text-4xl font-extrabold text-primary">${inr(res.emi)}</div>
      <div class="text-xs text-on-surface-variant mt-1">for ${res.n} months</div>
    </div>
    ${payDuringStudy && res.duringStudyMonthly > 0 ? `<div class="flex justify-between text-sm py-2 border-b border-surface-container"><span class="text-on-surface-variant">During study (interest only)</span><span class="font-semibold">${inr(res.duringStudyMonthly)}/mo</span></div>` : ""}
    <div class="flex justify-between text-sm py-2 border-b border-surface-container"><span class="text-on-surface-variant">Total interest</span><span class="font-semibold">${inr(res.totalInterest)}</span></div>
    <div class="flex justify-between text-sm py-2"><span class="text-on-surface-variant">Total payable</span><span class="font-semibold">${inr(res.totalRepayment)}</span></div>`;
}

function wireEmi() {
  if (!document.getElementById("emiOut")) return;
  ["emiAmount", "emiRate", "emiTenure", "emiPayDuring"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", computeEmi);
  });
  computeEmi();
}

// ---- 2. Eligibility ----
function renderEligibility() {
  const e = eligibility || {};
  const eligible = e.eligible;
  const rateShort = (e.ratePreview || "—").split(" (")[0];
  const statTiles = eligible ? `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
      ${[["Estimated", rupees(e.estimatedAmount)], ["Rate", rateShort], ["Moratorium", `${e.moratoriumMonths} months`]]
        .map(([k, v]) => `
        <div class="bg-white p-6 rounded-xl border border-outline-variant/40">
          <div class="text-xs uppercase tracking-wide text-on-surface-variant mb-2">${k}</div>
          <div class="text-3xl font-bold">${v}</div>
        </div>`).join("")}
      ${e.incomeNote ? `<div class="md:col-span-3 -mt-2 text-sm text-success flex items-start gap-2"><span class="material-symbols-outlined text-[18px] mt-0.5">verified</span>${e.incomeNote}</div>` : ""}
      ${(e.warnings || []).map((w) => `<div class="md:col-span-3 -mt-2 text-sm text-amber flex items-start gap-2"><span class="material-symbols-outlined text-[18px] mt-0.5">info</span>${w}</div>`).join("")}
    </div>` : `
    <div class="bg-white p-6 rounded-xl border border-danger/30 mb-6">
      ${(e.reasons || []).map((r) => `<p class="text-on-surface flex gap-2 mb-2"><span class="material-symbols-outlined text-danger text-[20px]">warning</span>${r}</p>`).join("")}
    </div>`;

  const onFileLine = onFileDocs.length
    ? `<p class="text-on-surface-variant mb-6 flex items-center gap-2"><span class="material-symbols-outlined text-success">check_circle</span> We already have your ${onFileDocs.map((d) => d.label).join(", ")}, so we'll skip those.</p>`
    : "";

  page(`
    ${topbar(`${progressDone()} of ${total} verified`)}
    <main class="pt-32 pb-20 max-w-container mx-auto px-6 md:px-16 fade-in">
      <h1 class="text-4xl font-bold mb-2">Hi ${LEAD.name || "there"} 👋</h1>
      <p class="text-lg text-on-surface-variant mb-4">${LEAD.course || ""}${LEAD.institute ? " at " + LEAD.institute : ""}${LEAD.source ? " · via " + LEAD.source : ""}</p>
      ${partnerInstitute ? `<div class="inline-flex items-start gap-2 text-sm bg-success-soft border border-success/30 rounded-2xl px-4 py-2.5 text-on-surface mb-4"><span class="material-symbols-outlined text-success text-[20px]">school</span><span><b class="text-success">${partnerInstitute.name} is a UPSY partner institute.</b> ${partnerInstitute.perk}</span></div>` : ""}
      ${CONTEXT && contextSummaryLine() ? `<div class="inline-flex items-center gap-2 text-sm bg-primary-soft border border-primary-line rounded-full px-4 py-2 text-primary mb-10"><span class="material-symbols-outlined text-[18px]">bolt</span> Your request: ${contextSummaryLine()}</div>` : `<div class="mb-10"></div>`}

      <div class="bg-primary-soft rounded-2xl p-8 border border-primary-line mb-10">
        <div class="flex items-center gap-3 mb-6">
          <span class="material-symbols-outlined text-primary" style="font-variation-settings:'FILL' 1">verified</span>
          <h2 class="text-2xl font-semibold text-primary">Preliminary eligibility — ${eligible ? "Eligible" : "Needs review"}</h2>
        </div>
        ${statTiles}
        <p class="text-sm text-on-surface-variant italic flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">info</span> An early estimate, not a final sanction.</p>
      </div>

      ${onFileLine}
      <button id="start" class="px-10 h-14 bg-primary text-white font-semibold rounded-full hover:bg-primary-dark active:scale-[0.98] transition inline-flex items-center gap-2">
        ${doneSet.size >= total ? "Review my documents" : doneSet.size > 0 ? "Continue where I left off" : "Start uploading documents"} <span class="material-symbols-outlined">arrow_forward</span>
      </button>
    </main>`);
  document.getElementById("start").addEventListener("click", () => goDoc(firstPendingIdx()));
}

// Lenders this applicant may match with (demo catalogue, matched server-side by
// the same underwriting facts as the eligibility engine).
async function loadLenderCards() {
  const box = document.getElementById("lenderCards");
  if (!box) return;
  let data;
  try { data = await (await fetch(`/api/applications/${LEAD.leadId}/lenders`)).json(); } catch { return; }
  const fits = (data.lenders || []).filter((l) => l.fit);
  if (!fits.length) return;
  box.innerHTML = `
    <div class="bg-white rounded-2xl p-6 md:p-8 border border-outline-variant/40 mb-10">
      <div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined text-primary">account_balance</span><h3 class="text-xl font-semibold">Lenders you may match with</h3></div>
      <p class="text-sm text-on-surface-variant mb-6">Based on your profile, these partner lenders could take your file. The UPSY team will refer you to the right one — nothing is shared without you knowing.</p>
      <div class="grid md:grid-cols-2 gap-4">
        ${fits.map((l) => `
        <div class="border border-outline-variant/50 rounded-xl p-5 hover:border-primary/50 transition">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold">${l.name}</span>
            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${l.type === "Bank" ? "bg-success-soft text-success" : "bg-primary-soft text-primary"}">${l.type}</span>
          </div>
          <div class="text-sm text-on-surface-variant mb-3">${l.blurb}</div>
          <div class="flex flex-wrap gap-1.5">
            <span class="text-[11px] font-semibold bg-surface-container rounded-full px-2.5 py-1">${l.rateRange} p.a.</span>
            ${l.reasons.slice(0, 2).map((r) => `<span class="text-[11px] bg-success-soft text-success rounded-full px-2.5 py-1">✓ ${r}</span>`).join("")}
          </div>
        </div>`).join("")}
      </div>
      <p class="text-xs text-on-surface-variant italic mt-5 flex items-start gap-2"><span class="material-symbols-outlined text-[16px] mt-0.5">info</span> Indicative matches for illustration — the final lender, rate and sanction depend on each lender's own underwriting.</p>
    </div>`;
}

// Self-serve live voice help: applicant starts a call, UPSY (via AgentCall)
// joins to help them fill out a form. `compact` renders the shrunk-down
// version that fits inside the narrow Ask UPSY sidebar on document pages;
// the full version is used on the completion screen.
// While a call is live the phase moves on its own (joining → connected →
// speaking → listening), so the panel re-checks rather than waiting for a
// click. One poll at a time, cleared as soon as the call ends.
let liveAssistPoll = null;
function stopLiveAssistPoll() {
  if (liveAssistPoll) { clearTimeout(liveAssistPoll); liveAssistPoll = null; }
}

async function loadLiveAssistApplicant(compact) {
  stopLiveAssistPoll();
  const box = document.getElementById("liveAssist");
  if (!box) return;
  let status;
  try { status = await (await fetch(`/api/applications/${LEAD.leadId}/live-assist`)).json(); } catch { status = { running: false }; }
  box.innerHTML = status.running
    ? (compact ? liveAssistRunningCompactHtml(status) : liveAssistRunningHtml(status))
    : (compact ? liveAssistIdleCompactHtml(status.failure) : liveAssistIdleHtml(status.failure));
  wireLiveAssistApplicant(compact);
  if (status.running && document.getElementById("liveAssist")) {
    liveAssistPoll = setTimeout(() => loadLiveAssistApplicant(compact), 2000);
  }
}

function liveAssistIdleHtml(failure) {
  return `
  ${UpsyPhases.failureHtml(failure)}
  <div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined text-primary">support_agent</span><h3 class="text-xl font-semibold">Talk to UPSY live</h3></div>
  <p class="text-sm text-on-surface-variant mb-4">Applying with a lender's own website and want help filling it out? Start a Google Meet, paste the link below, and UPSY will join the call to guide you — just share your screen.</p>
  <div class="flex flex-col sm:flex-row gap-3">
    <input id="liveAssistUrl" type="text" placeholder="https://meet.google.com/xxx-xxxx-xxx" class="flex-1 border border-outline-variant rounded-full px-4 py-2.5 text-sm" />
    <button id="liveAssistStartBtn" class="px-6 py-2.5 bg-primary text-white rounded-full text-sm font-semibold hover:bg-primary-dark transition flex items-center justify-center gap-2 whitespace-nowrap"><span class="material-symbols-outlined text-[18px]">call</span>Start call</button>
  </div>`;
}

function liveAssistRunningHtml(status) {
  return `
  <div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined text-primary">podcasts</span><h3 class="text-xl font-semibold">UPSY is live in your call</h3></div>
  <div class="mb-2">${UpsyPhases.phasePillHtml(status.phase, status.phaseDetail)}</div>
  ${UpsyPhases.phaseStepsHtml(status.phase)}
  <p class="text-sm text-on-surface-variant my-4">Join <a class="text-primary underline" href="${status.meetUrl}" target="_blank" rel="noopener">${status.meetUrl}</a> if you haven't already — UPSY is waiting there.</p>
  <button id="liveAssistStopBtn" class="px-6 py-2.5 bg-danger text-white rounded-full text-sm font-semibold hover:bg-danger-dark transition flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">call_end</span>End call</button>`;
}

function liveAssistIdleCompactHtml(failure) {
  return `
  ${UpsyPhases.failureHtml(failure)}
  <div class="flex items-center gap-1.5 mb-1"><span class="material-symbols-outlined text-primary text-[16px]">podcasts</span><div class="text-xs font-bold">Talk to UPSY live</div></div>
  <p class="text-[11px] text-on-surface-variant mb-2">Prefer voice while filling this in? Paste a Meet link and UPSY joins to help.</p>
  <input id="liveAssistUrl" type="text" placeholder="Meet link" class="w-full border border-outline-variant rounded-lg px-2.5 py-1.5 text-xs mb-2" />
  <button id="liveAssistStartBtn" class="w-full py-1.5 bg-primary text-white rounded-lg text-xs font-semibold hover:bg-primary-dark transition flex items-center justify-center gap-1"><span class="material-symbols-outlined text-[14px]">call</span>Start call</button>`;
}

function liveAssistRunningCompactHtml(status) {
  return `
  <div class="flex items-center gap-1.5 mb-1"><span class="material-symbols-outlined text-primary text-[16px]">podcasts</span><div class="text-xs font-bold">UPSY is live in your call</div></div>
  <div class="mb-2">${UpsyPhases.phasePillHtml(status.phase, status.phaseDetail)}</div>
  <p class="text-[11px] text-on-surface-variant mb-2">Join <a class="text-primary underline" href="${status.meetUrl}" target="_blank" rel="noopener">the meet</a> if you haven't already.</p>
  <button id="liveAssistStopBtn" class="w-full py-1.5 bg-danger text-white rounded-lg text-xs font-semibold hover:bg-danger-dark transition flex items-center justify-center gap-1"><span class="material-symbols-outlined text-[14px]">call_end</span>End call</button>`;
}

function wireLiveAssistApplicant(compact) {
  const startBtn = document.getElementById("liveAssistStartBtn");
  if (startBtn) startBtn.addEventListener("click", async () => {
    const url = document.getElementById("liveAssistUrl")?.value?.trim();
    if (!url) { alert("Paste your Google Meet link first."); return; }
    startBtn.disabled = true; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Starting…`;
    try {
      const r = await (await fetch(`/api/applications/${LEAD.leadId}/live-assist`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetUrl: url }),
      })).json();
      if (r.error) { alert(r.error); startBtn.disabled = false; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call</span>Start call`; return; }
      // A bot takes a few seconds to walk into the meeting. Say so, so the
      // wait does not look like nothing happened.
      UpsyPhases.showToast({
        title: "UPSY is joining your call",
        body: "Give it a few seconds to appear. If your meeting has a waiting room, let UPSY in when it knocks.",
      });
      await loadLiveAssistApplicant(compact);
    } catch {
      alert("Couldn't reach the server — try again.");
      startBtn.disabled = false; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call</span>Start call`;
    }
  });
  const stopBtn = document.getElementById("liveAssistStopBtn");
  if (stopBtn) stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true; stopBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Ending…`;
    try {
      await fetch(`/api/applications/${LEAD.leadId}/live-assist/stop`, { method: "POST" });
      await loadLiveAssistApplicant(compact);
    } catch {
      alert("Couldn't reach the server — try again.");
      stopBtn.disabled = false; stopBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call_end</span>End call`;
    }
  });
}

// Clickable document checklist — jump straight to any document.
function checklistHtml() {
  const groups = {};
  queue.forEach((d, i) => { (groups[d.stageTitle] ||= []).push({ d, i }); });
  const body = Object.entries(groups).map(([stage, items]) => `
    <div class="mb-3">
      <div class="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider mb-1 px-2">${stage}</div>
      ${items.map(({ d, i }) => {
        const done = doneSet.has(d.id);
        const current = i === idx;
        const icon = done ? "check_circle" : current ? "radio_button_checked" : "radio_button_unchecked";
        const iconColor = done ? "text-success" : current ? "text-primary" : "text-outline-variant";
        return `<button data-jump="${i}" class="w-full text-left flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition ${current ? "bg-primary-soft font-semibold text-primary" : "hover:bg-surface-container text-on-surface"}">
          <span class="material-symbols-outlined text-[18px] ${iconColor}" ${done ? `style="font-variation-settings:'FILL' 1"` : ""}>${icon}</span>
          <span class="flex-1 leading-snug">${d.label}${d.required ? "" : ` <span class="text-on-surface-variant font-normal">(optional)</span>`}</span>
        </button>`;
      }).join("")}
    </div>`).join("");
  return `
    <aside class="hidden lg:flex flex-col fixed left-0 top-16 bottom-0 w-72 bg-white border-r border-outline-variant/50 overflow-y-auto p-4 z-30">
      <div class="flex items-center justify-between px-2 mb-3">
        <span class="text-sm font-bold">Your documents</span>
        <span class="text-xs font-semibold text-primary bg-primary-soft px-2 py-0.5 rounded-full">${progressDone()}/${total}</span>
      </div>
      ${body}
    </aside>`;
}

// ---- 3. Document upload ----
// ---- Doc helper: right-side assistant for questions about the current document ----
function assistPanelHtml(doc) {
  const chips = [
    ["chipWhy", `Why is this needed?`],
    ["chipFormat", `What format works?`],
    ["chipRejected", `Why wasn't mine accepted?`],
  ];
  return `
    <aside class="hidden xl:flex flex-col fixed right-0 top-16 bottom-0 w-80 bg-white border-l border-outline-variant/50 z-30">
      <div class="p-4 border-b border-outline-variant/40">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-full bg-primary-soft grid place-items-center"><span class="material-symbols-outlined text-primary text-[18px]">support_agent</span></div>
          <div>
            <div class="text-sm font-bold">Ask UPSY</div>
            <div class="text-[11px] text-on-surface-variant">Questions about your ${doc.label}</div>
          </div>
        </div>
      </div>
      <div id="liveAssist" class="p-4 border-b border-outline-variant/40"></div>
      <div id="assistMsgs" class="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
        <div class="text-sm text-on-surface-variant bg-surface-container rounded-xl rounded-tl-sm p-3">Hi! Ask me anything about this document — why it's needed, what format works, or what to do if it isn't accepted.</div>
      </div>
      <div class="p-3 border-t border-outline-variant/40">
        <div class="flex flex-wrap gap-1.5 mb-2">
          ${chips.map(([id, label]) => `<button id="${id}" class="assist-chip text-[11px] text-primary bg-primary-soft border border-primary-line hover:bg-primary-line/50 rounded-full px-2.5 py-1 transition ${id === "chipRejected" && !lastFailedChecks.length ? "hidden" : ""}">${label}</button>`).join("")}
        </div>
        <div class="flex gap-2">
          <input id="assistInput" placeholder="Type a question…" class="flex-1 h-10 px-3 bg-surface border border-outline-variant rounded-xl text-sm focus:border-primary focus:ring-2 focus:ring-primary/10 outline-none transition"/>
          <button id="assistSend" class="w-10 h-10 grid place-items-center bg-primary text-white rounded-xl hover:bg-primary-dark active:scale-95 transition disabled:opacity-50"><span class="material-symbols-outlined text-[18px]">send</span></button>
        </div>
      </div>
    </aside>`;
}

function assistBubble(text, who) {
  const el = document.createElement("div");
  el.className = who === "user"
    ? "text-sm bg-primary text-white rounded-xl rounded-tr-sm p-3 ml-8"
    : "text-sm text-on-surface bg-surface-container rounded-xl rounded-tl-sm p-3 mr-2";
  el.textContent = text;
  return el;
}

function wireAssist(doc) {
  const input = document.getElementById("assistInput");
  const send = document.getElementById("assistSend");
  const msgs = document.getElementById("assistMsgs");
  if (!input || !send || !msgs) return;

  async function ask(question) {
    const q = (question || input.value).trim();
    if (!q) return;
    input.value = "";
    send.disabled = true;
    msgs.appendChild(assistBubble(q, "user"));
    const thinking = assistBubble("…", "bot");
    msgs.appendChild(thinking);
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const r = await fetch("/api/assist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId: doc.id, question: q,
          failedChecks: lastFailedChecks,
          intakeSummary: CONTEXT?.summary || "",
        }),
      });
      const data = await r.json();
      thinking.textContent = r.ok ? data.answer : (data.error || "Sorry, I couldn't answer that just now.");
    } catch {
      thinking.textContent = "Couldn't reach the helper — please try again.";
    }
    msgs.scrollTop = msgs.scrollHeight;
    send.disabled = false;
  }

  send.addEventListener("click", () => ask());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  document.getElementById("chipWhy")?.addEventListener("click", () => ask("Why is this document needed?"));
  document.getElementById("chipFormat")?.addEventListener("click", () => ask("What file format and quality do you need for this document?"));
  document.getElementById("chipRejected")?.addEventListener("click", () => ask("My upload wasn't accepted — why, and what should I fix?"));
}

function renderCurrent() {
  if (idx >= queue.length) return go("/docs/done", { replace: true });
  const doc = queue[idx];
  const required = doc.required;
  const isDone = doneSet.has(doc.id);
  lastFailedChecks = []; // fresh document, fresh context
  page(`
    ${topbar(`${progressDone()} of ${total} verified`)}
    ${checklistHtml()}
    ${assistPanelHtml(doc)}
    <main class="pt-24 pb-24 lg:pl-72 xl:pr-80 fade-in">
      <div class="max-w-3xl mx-auto px-6 lg:px-12">
        <section>
          <div class="flex items-center gap-3 mb-4">
            <span class="text-xs font-bold px-3 py-1 rounded-full ${required ? "bg-primary-soft text-primary-dark" : "bg-surface-container text-on-surface-variant"}">${required ? "Required" : "Optional"}</span>
            <span class="text-xs text-on-surface-variant">Document ${idx + 1} of ${queue.length}</span>
          </div>
          <h1 class="text-4xl font-bold mb-4">${doc.label}</h1>
          <p class="text-lg text-on-surface-variant mb-6"><span class="font-semibold text-on-surface">Why we need this:</span> ${doc.why}</p>
          ${isDone ? `<div class="bg-success-soft border border-success/30 rounded-xl p-4 text-success flex items-center gap-2 mb-6"><span class="material-symbols-outlined">check_circle</span> You've already uploaded this one. Upload a new file to replace it, or continue.</div>` : ""}

          <div class="space-y-8">
            ${doc.identifier ? `
            <div>
              <label class="block text-sm font-medium text-on-surface-variant mb-3">${doc.identifier.name} — e.g. ${doc.identifier.example} <span class="text-on-surface-variant/70">(we auto-read this from your card — you can edit it here if anything's wrong)</span></label>
              <input id="idInput" ${doc.prefill ? `value="${doc.prefill}"` : ""} placeholder="Enter ${doc.identifier.name}" autocomplete="off"
                class="w-full h-14 px-6 bg-white border border-outline-variant rounded-xl text-xl font-semibold focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition"/>
            </div>` : ""}

            <div id="dropzone" class="bg-primary-soft border-2 border-dashed border-outline-variant rounded-2xl p-12 md:p-16 text-center cursor-pointer hover:border-primary transition">
              <div class="w-16 h-16 bg-white rounded-full grid place-items-center card-shadow mb-6 mx-auto">
                <span class="material-symbols-outlined text-primary text-[32px]">cloud_upload</span>
              </div>
              <h3 id="dropTitle" class="text-xl font-semibold mb-4">Drop your ${doc.label} here, or click to browse</h3>
              <div class="flex items-center justify-center gap-2 mb-4">
                ${doc.accept.map((x) => `<span class="px-3 py-1 bg-white border border-outline-variant rounded-full text-xs text-on-surface-variant uppercase">${x}</span>`).join("")}
              </div>
              <p class="text-sm text-on-surface-variant">Maximum ${doc.maxSizeMB} MB. Make sure it's clear and all corners are visible.</p>
              <input id="fileInput" type="file" class="hidden" accept="${doc.accept.map((x) => "." + x).join(",")}"/>
            </div>

            <div id="preview" class="hidden"></div>

            <div id="report"></div>

            <div class="flex flex-wrap gap-4 items-center pt-2">
              <button id="submit" disabled class="px-10 h-14 bg-primary text-white font-semibold rounded-full disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-dark active:scale-[0.98] transition inline-flex items-center gap-2">
                ${isDone ? "Replace document" : "Upload &amp; verify"} <span class="material-symbols-outlined">arrow_forward</span>
              </button>
              ${isDone ? `<button id="next" class="px-8 h-14 bg-white border border-primary text-primary font-semibold rounded-full hover:bg-primary-soft transition inline-flex items-center gap-2">Continue <span class="material-symbols-outlined">arrow_forward</span></button>` : ""}
              ${required || isDone ? "" : `<button id="skip" class="px-6 h-14 text-on-surface-variant font-semibold rounded-full hover:bg-surface-container transition">Skip</button>`}
              <span class="text-sm text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">lock</span> Encrypted &amp; handled securely.</span>
            </div>
          </div>
        </section>
      </div>
    </main>`);
  wireUpload(doc);
  wireAssist(doc);
  loadLiveAssistApplicant(true);
  if (isDone) showStoredPreview(doc);
}

// Revisiting a done document: show the file that's already on record so the
// applicant can review what they uploaded before deciding to replace it.
// (Docs marked done at the lead source have no stored file — then we show nothing.)
async function showStoredPreview(doc) {
  const pv = document.getElementById("preview");
  if (!pv) return;
  try {
    const r = await fetch(`/api/applications/${LEAD.leadId}/documents/${doc.id}/file`);
    if (!r.ok) {
      // Verified on record but no stored file (docs on file at the lead source,
      // or the file went missing from storage) — say so instead of staying blank.
      if (document.getElementById("fileInput")?.files.length) return;
      pv.classList.remove("hidden");
      pv.innerHTML = `
        <div class="bg-amber-soft border border-amber/30 rounded-2xl p-4 flex items-start gap-3">
          <span class="material-symbols-outlined text-amber text-[20px] mt-0.5">visibility_off</span>
          <div class="text-sm text-on-surface">This document is marked as received, but its preview isn't available anymore.
            <span class="text-on-surface-variant">If you want it reviewed again, just attach a fresh copy above — it will replace the old one.</span></div>
        </div>`;
      return;
    }
    const blob = await r.blob();
    if (!document.getElementById("preview") || document.getElementById("fileInput")?.files.length) return; // moved on / new file attached meanwhile
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const isPdf = (blob.type || "").includes("pdf");
    pv.classList.remove("hidden");
    pv.innerHTML = `
      <div class="bg-white border border-success/30 rounded-2xl p-4">
        <div class="flex items-center justify-between mb-3 gap-3">
          <span class="text-sm font-semibold flex items-center gap-2"><span class="material-symbols-outlined text-success text-[20px]">preview</span> Your uploaded ${doc.label}</span>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-on-surface-variant hidden md:inline">Attach a new file above to replace it</span>
            <button id="previewDelete" title="Delete this uploaded document" class="w-8 h-8 grid place-items-center rounded-full text-on-surface-variant hover:bg-danger-soft hover:text-danger transition"><span class="material-symbols-outlined text-[20px]">delete</span></button>
          </div>
        </div>
        ${isPdf
          ? `<iframe src="${previewUrl}" title="Your uploaded ${doc.label}" class="w-full h-80 rounded-xl border-0"></iframe>`
          : `<img src="${previewUrl}" alt="Your uploaded ${doc.label}" class="max-h-80 mx-auto rounded-xl"/>`}
      </div>`;
    document.getElementById("previewDelete").addEventListener("click", async () => {
      if (!confirm(`Delete your uploaded ${doc.label}? It will go back into your to-do list.`)) return;
      const btn = document.getElementById("previewDelete");
      btn.disabled = true;
      try {
        const r = await fetch(`/api/applications/${LEAD.leadId}/documents/${doc.id}`, { method: "DELETE" });
        if (!r.ok) throw new Error();
        doneSet.delete(doc.id);
        renderCurrent(); // same document, now back to pending
      } catch { btn.disabled = false; alert("Couldn't delete it just now — please try again."); }
    });
  } catch {}
}

function wireUpload(doc) {
  const fileInput = document.getElementById("fileInput");
  const dropzone = document.getElementById("dropzone");
  const submit = document.getElementById("submit");
  const idInput = doc.identifier ? document.getElementById("idInput") : null;
  const report = document.getElementById("report");

  const idOk = () => !doc.identifier || new RegExp(doc.identifier.pattern).test((idInput.value || "").trim().toUpperCase().replace(/\s/g, ""));
  const refresh = () => {
    const hasFile = fileInput.files.length > 0;
    if (doc.identifier && !idOk()) { submit.textContent = `Enter ${doc.identifier.name} first`; submit.disabled = true; }
    else if (!hasFile) { submit.innerHTML = `Attach file first`; submit.disabled = true; }
    else { submit.innerHTML = `Upload &amp; verify <span class="material-symbols-outlined">arrow_forward</span>`; submit.disabled = false; }
  };

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("border-primary", "bg-primary-line/40"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("border-primary", "bg-primary-line/40"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault(); dropzone.classList.remove("border-primary", "bg-primary-line/40");
    if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; onFile(); }
  });
  fileInput.addEventListener("change", onFile);
  if (idInput) idInput.addEventListener("input", () => { idInput.value = idInput.value.toUpperCase(); refresh(); });
  if (document.getElementById("skip")) document.getElementById("skip").addEventListener("click", () => goDoc(idx + 1));
  if (document.getElementById("next")) document.getElementById("next").addEventListener("click", () => goDoc(idx + 1));
  document.querySelectorAll("[data-jump]").forEach((b) => b.addEventListener("click", () => goDoc(+b.dataset.jump)));
  submit.addEventListener("click", () => submitDoc(doc));

  async function onFile() {
    report.innerHTML = "";
    if (!fileInput.files.length) return refresh();
    const f = fileInput.files[0];
    const sizeMB = f.size / (1024 * 1024);
    if (sizeMB > doc.maxSizeMB) {
      fileInput.value = "";
      report.innerHTML = `<div class="bg-danger-soft border border-danger/30 rounded-xl p-4 text-danger">That file is ${sizeMB.toFixed(1)} MB — over the ${doc.maxSizeMB} MB limit. Please attach a smaller one.</div>`;
      return refresh();
    }
    document.getElementById("dropTitle").textContent = f.name;
    dropzone.classList.add("border-primary");
    showFilePreview(doc, f, sizeMB);
    refresh();
    if (idInput && !idOk()) await autoFill(doc, f, idInput, report, refresh);
  }
  refresh();
}

// Show the applicant what they just attached, before it's uploaded — an image
// inline, a PDF in an embedded viewer — so wrong/blurry files get caught early.
function showFilePreview(doc, f, sizeMB) {
  const pv = document.getElementById("preview");
  if (!pv) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(f);
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isImage = f.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(f.name);
  const inner = isPdf
    ? `<iframe src="${previewUrl}" title="Preview of ${f.name}" class="w-full h-80 rounded-xl border-0"></iframe>`
    : isImage
      ? `<img src="${previewUrl}" alt="Preview of ${f.name}" class="max-h-80 mx-auto rounded-xl"/>`
      : `<div class="text-sm text-on-surface-variant p-4">No preview available for this file type.</div>`;
  pv.classList.remove("hidden");
  pv.innerHTML = `
    <div class="bg-white border border-outline-variant/50 rounded-2xl p-4">
      <div class="flex items-center justify-between mb-3 gap-3">
        <span class="text-sm font-semibold flex items-center gap-2 min-w-0"><span class="material-symbols-outlined text-primary text-[20px]">preview</span> <span class="truncate">Preview — ${f.name}</span> <span class="font-normal text-on-surface-variant shrink-0">(${sizeMB.toFixed(1)} MB)</span></span>
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-on-surface-variant hidden md:inline">Check it's clear and all corners are visible</span>
          <button id="previewClear" title="Remove this file" class="w-8 h-8 grid place-items-center rounded-full text-on-surface-variant hover:bg-danger-soft hover:text-danger transition"><span class="material-symbols-outlined text-[20px]">delete</span></button>
        </div>
      </div>
      ${inner}
    </div>`;
  document.getElementById("previewClear").addEventListener("click", () => {
    const fi = document.getElementById("fileInput");
    if (fi) { fi.value = ""; fi.dispatchEvent(new Event("change")); } // resets the submit button state
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    pv.classList.add("hidden"); pv.innerHTML = "";
    const t = document.getElementById("dropTitle");
    if (t) t.textContent = `Drop your ${doc.label} here, or click to browse`;
    document.getElementById("dropzone")?.classList.remove("border-primary");
  });
}

async function autoFill(doc, file, idInput, report, refresh) {
  report.innerHTML = `<div class="text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span> Reading the ${doc.identifier.name} from your document…</div>`;
  const fd = new FormData(); fd.append("docId", doc.id); fd.append("file", file);
  let data = null;
  try { data = await (await fetch("/api/extract", { method: "POST", body: fd })).json(); } catch {}
  if (data && data.found && data.value) {
    idInput.value = data.value; idInput.dispatchEvent(new Event("input"));
    const extras = [
      data.holderName ? `Name: <b>${data.holderName}</b>` : null,
      data.dob ? `DOB: <b>${data.dob}</b>` : null,
    ].filter(Boolean).join(" · ");
    report.innerHTML = `
      <div class="bg-success-soft border border-success/30 rounded-xl p-4 text-success">
        <div class="flex items-center gap-2"><span class="material-symbols-outlined">auto_awesome</span> Read off your document: ${doc.identifier.name} <b>${data.value}</b>${extras ? " · " + extras : ""}</div>
        <div class="text-xs text-on-surface-variant mt-1">✎ Check every digit against your card. If anything's off, just fix it in the box above, then hit Upload &amp; verify.</div>
      </div>`;
  } else {
    report.innerHTML = `<div class="bg-amber-soft border border-amber/30 rounded-xl p-4 text-amber">Couldn't read the ${doc.identifier.name} clearly — please type it above and we'll verify it.</div>`;
    idInput.focus();
  }
  refresh();
}

async function submitDoc(doc) {
  const fileInput = document.getElementById("fileInput");
  const file = fileInput.files[0];
  if (!file) return;
  const idInput = doc.identifier ? document.getElementById("idInput") : null;
  const identifier = idInput ? idInput.value.trim() : "";
  const submit = document.getElementById("submit");
  submit.disabled = true; submit.textContent = "Verifying…";

  const fd = new FormData();
  fd.append("docId", doc.id); fd.append("file", file); fd.append("leadId", LEAD.leadId);
  if (identifier) fd.append("identifier", identifier);

  let report;
  try { report = await (await fetch("/api/validate", { method: "POST", body: fd })).json(); }
  catch { document.getElementById("report").innerHTML = `<div class="bg-danger-soft border border-danger/30 rounded-xl p-4 text-danger">Couldn't reach the server — please try again.</div>`; submit.disabled = false; submit.textContent = "Upload & verify"; return; }

  if (report.error) { document.getElementById("report").innerHTML = `<div class="bg-danger-soft border border-danger/30 rounded-xl p-4 text-danger">${report.error}</div>`; submit.disabled = false; submit.textContent = "Upload & verify"; return; }

  if (report.accurate) { doneSet.add(doc.id); lastFailedChecks = []; renderResult(report, doc); }
  else {
    const failed = report.checks.filter((c) => !c.passed);
    // Remember what failed so the "Ask UPSY" helper can explain it, and surface its chip.
    lastFailedChecks = failed.map((c) => ({ name: c.name, detail: c.detail }));
    document.getElementById("chipRejected")?.classList.remove("hidden");
    document.getElementById("report").innerHTML = `
      <div class="bg-danger-soft border border-danger/30 rounded-xl p-5">
        <div class="font-semibold text-danger mb-3">A couple of things need fixing:</div>
        ${failed.map((c) => `<p class="text-sm text-on-surface mb-1">✕ <b>${c.name}</b> — ${c.detail}</p>`).join("")}
        <p class="text-xs text-on-surface-variant mt-3 flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">support_agent</span> Not sure what to fix? Ask UPSY on the right.</p>
      </div>`;
    submit.disabled = false; submit.innerHTML = `Upload &amp; verify <span class="material-symbols-outlined">arrow_forward</span>`;
  }
}

// ---- 4. Verification result ----
function renderResult(report, doc) {
  page(`
    ${topbar(`${progressDone()} of ${total} verified`)}
    <main class="pt-32 pb-24 max-w-2xl mx-auto px-6 text-center fade-in">
      <div class="w-20 h-20 bg-success-soft rounded-full grid place-items-center mx-auto mb-6">
        <span class="material-symbols-outlined text-success text-[40px]" style="font-variation-settings:'FILL' 1">check_circle</span>
      </div>
      <h1 class="text-4xl font-extrabold text-success mb-4">${doc.label} — verified ✓</h1>
      <p class="text-on-surface-variant mb-10">Your document passed every check.</p>
      <div class="bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40 text-left mb-10">
        <div class="text-xs uppercase tracking-widest text-on-surface-variant mb-6">Verification checklist</div>
        ${report.checks.map((c, i) => `
          <div class="flex items-center justify-between py-4 ${i < report.checks.length - 1 ? "border-b border-surface-container" : ""}">
            <div class="flex items-center gap-4">
              <div class="w-6 h-6 grid place-items-center rounded-full ${c.passed ? "bg-success" : "bg-danger"} text-white"><span class="material-symbols-outlined text-[16px]">${c.passed ? "check" : "close"}</span></div>
              <span>${c.name}</span>
            </div>
            <span class="text-xs font-semibold ${c.passed ? "text-success bg-success-soft" : "text-danger bg-danger-soft"} px-3 py-1 rounded-full">${c.passed ? "Passed" : "Failed"}</span>
          </div>`).join("")}
      </div>
      <button id="next" class="px-10 h-14 bg-primary text-white font-semibold rounded-full hover:bg-primary-dark active:scale-[0.98] transition inline-flex items-center gap-2">
        ${idx + 1 < queue.length ? "Continue to next document" : "Finish"} <span class="material-symbols-outlined">arrow_forward</span>
      </button>
    </main>`);
  document.getElementById("next").addEventListener("click", () => goDoc(idx + 1));
}

// ---- 5. Done ----
async function renderDone() {
  // Only fire the completion/email once, even if the user navigates back and forth.
  if (!completedSent) {
    completedSent = true;
    try { await fetch("/api/session/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: LEAD.leadId }) }); } catch {}
  }
  const eligible = eligibility?.eligible;
  page(`
    ${topbar(`${progressDone()} of ${total}`)}
    <main class="pt-32 pb-24 max-w-2xl mx-auto px-6 text-center fade-in">
      <div class="w-20 h-20 bg-primary-soft rounded-full grid place-items-center mx-auto mb-8">
        <span class="material-symbols-outlined text-primary text-[40px]" style="font-variation-settings:'FILL' 1">task_alt</span>
      </div>
      <h1 class="text-4xl font-bold mb-4">All documents received 🎉</h1>
      <p class="text-lg text-on-surface-variant mb-10">Our team will review your application within 24 hours. You'll hear from us by SMS, WhatsApp and email.</p>
      <div class="text-left">
        ${eligible ? emiCardHtml() : ""}
        ${eligible ? `<div id="lenderCards"></div>` : ""}
        <div id="liveAssist" class="bg-white rounded-2xl p-6 md:p-8 border border-outline-variant/40 mb-10">${liveAssistIdleHtml()}</div>
      </div>
    </main>`);
  if (eligible) { wireEmi(); loadLenderCards(); }
  loadLiveAssistApplicant(false);
}

window.addEventListener("popstate", route);
route();
