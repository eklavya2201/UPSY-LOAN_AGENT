// Smart intake box (prototype) — sends the free-text request to /api/intake and
// renders the structured loan intent it comes back with.

const $ = (id) => document.getElementById(id);
const text = $("text");
const go = $("go");
const result = $("result");

// Field labels + how to display each value.
const FIELDS = [
  ["amountInr", "Loan amount", (v) => `₹${Number(v).toLocaleString("en-IN")}`],
  ["purpose", "Purpose", (v) => v],
  ["studyLevel", "Study level", (v) => v],
  ["fieldOfStudy", "Field of study", (v) => v],
  ["institution", "Institution", (v) => v],
  ["country", "Country", (v) => v],
  ["intake", "Intake", (v) => v],
  ["coApplicant", "Co-applicant", (v) => v],
  ["collateral", "Loan type", (v) => (v === "secured" ? "Secured (collateral)" : v === "unsecured" ? "Unsecured" : v)],
  ["tenureYears", "Tenure", (v) => `${v} years`],
];

$("examples").querySelectorAll(".ex").forEach((b) =>
  b.addEventListener("click", () => { text.value = b.textContent.trim(); text.focus(); })
);

go.addEventListener("click", run);
text.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });

async function run() {
  const value = text.value.trim();
  if (!value) { text.focus(); return; }
  go.disabled = true;
  result.innerHTML = `<div class="text-on-surface-variant flex items-center gap-2 fade-in"><span class="material-symbols-outlined animate-spin">progress_activity</span> Reading your request…</div>`;

  let data;
  try {
    const res = await fetch("/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
  } catch (e) {
    result.innerHTML = `<div class="bg-danger-soft border border-danger/30 rounded-2xl p-4 text-danger fade-in">${e.message}</div>`;
    go.disabled = false;
    return;
  }

  render(data);
  go.disabled = false;
}

function render(data) {
  const captured = FIELDS.filter(([k]) => data.intent[k] != null);
  const missing = FIELDS.filter(([k]) => data.intent[k] == null);

  const chip = (label, val, muted) => `
    <div class="flex items-center justify-between py-2.5 border-b border-surface-container last:border-0">
      <span class="text-sm ${muted ? "text-on-surface-variant/70" : "text-on-surface-variant"}">${label}</span>
      <span class="text-sm font-semibold ${muted ? "text-on-surface-variant/50 italic" : "text-on-surface"}">${val}</span>
    </div>`;

  result.innerHTML = `
    <div class="fade-in space-y-6">
      ${data.summary ? `
        <div class="bg-success-soft border border-success/30 rounded-2xl p-4 flex items-start gap-3">
          <span class="material-symbols-outlined text-success">check_circle</span>
          <div><div class="font-semibold text-success">Here's what we understood</div>
          <div class="text-sm text-on-surface mt-0.5">${data.summary}</div></div>
        </div>` : ""}

      <div class="bg-white rounded-2xl p-6 card-shadow border border-outline-variant/40">
        <div class="text-xs uppercase tracking-widest text-on-surface-variant mb-3">Structured application</div>
        ${captured.map(([k, label, fmt]) => chip(label, fmt(data.intent[k]), false)).join("") || `<div class="text-sm text-on-surface-variant">Nothing captured yet — try adding more detail.</div>`}
        ${missing.length ? `<div class="text-xs uppercase tracking-widest text-on-surface-variant mt-5 mb-3">Not provided yet</div>
          ${missing.map(([k, label]) => chip(label, "we'll ask", true)).join("")}` : ""}
      </div>

      ${data.followUps && data.followUps.length ? `
        <div class="bg-primary-soft border border-primary-line rounded-2xl p-5">
          <div class="font-semibold text-primary mb-2 flex items-center gap-2"><span class="material-symbols-outlined">forum</span> A few quick questions</div>
          <ul class="space-y-1.5">${data.followUps.map((q) => `<li class="text-sm text-on-surface flex gap-2"><span class="text-primary">•</span> ${q}</li>`).join("")}</ul>
        </div>` : ""}

      <div class="text-xs text-on-surface-variant">Structured by: <b>${data.source}</b> · This is where the agent would build the document checklist and pre-fill the form.</div>
    </div>`;
}
