// UPSY Admin — borrower-file dashboard (left-sidebar layout).
// Everything rendered here is real backend data: format checks, OCR name/DOB,
// cross-document flags, the rule-based eligibility memo, reminders and the
// email packet. No invented signals.

const $ = (s) => document.querySelector(s);
let selected = null;
let activeTab = "extract";
let apps = [];

const STATUS = {
  in_progress: { label: "In progress", cls: "bg-primary-soft text-primary-dark" },
  documents_complete: { label: "Docs complete", cls: "bg-success-soft text-success" },
  approved: { label: "Approved", cls: "bg-success-soft text-success" },
  rejected: { label: "Rejected", cls: "bg-danger-soft text-danger" },
};
const DOC_STATUS = {
  verified: { label: "Verified", dot: "bg-success", txt: "text-success" },
  on_file: { label: "On file", dot: "bg-primary", txt: "text-primary" },
  pending: { label: "Pending", dot: "bg-outline-variant", txt: "text-on-surface-variant" },
  reupload: { label: "Re-upload requested", dot: "bg-amber", txt: "text-amber" },
};

// Escape before interpolating anything a person supplied. The voice surface
// makes this load-bearing rather than hygiene: an /m account's name is typed by
// the caller, and a call transcript is literally every word they said, rendered
// into innerHTML on an officer's screen. Anything reaching this dashboard from
// a caller must go through here.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const rupees = (n) => {
  if (!n) return "—";
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
};
const prettyEvent = (e) => ({
  agent_session_started: "Applicant started the assistant",
  intake_captured: "Smart intake captured",
  document_verified: "Document verified",
  all_documents_collected: "All documents collected",
  application_approved: "Application approved",
  application_rejected: "Application rejected",
  reupload_requested: "Re-upload requested",
  name_mismatch: "⚠ Name mismatch",
  cross_document_mismatch: "⚠ Cross-document mismatch",
  reminder_sent: "📨 Reminder sent",
  documents_emailed: "📧 Packet emailed",
  packet_emailed: "📧 Packet emailed",
  lender_draft_created: "✉️ Lender email drafted",
  lender_email_shared: "📤 Email shared with lender",
  income_extracted: "💰 Income verified from document",
  document_deleted: "🗑 Document deleted by applicant",
}[e] || e);

// ---------- list ----------
async function loadList() {
  apps = await (await fetch("/api/applications")).json();
  renderList();
}

function renderList() {
  const q = ($("#search").value || "").toLowerCase();
  const list = apps.filter((a) => !q || (a.profile.name || "").toLowerCase().includes(q) || (a.profile.phone || "").includes(q));
  $("#pageSub").textContent = `${apps.length} borrower file${apps.length === 1 ? "" : "s"} · live from the UPSY assistant.`;
  if (!list.length) {
    $("#appList").innerHTML = `<div class="p-6 text-sm text-on-surface-variant bg-white rounded-2xl border border-outline-variant/50">No applications yet. Start one in the applicant view.</div>`;
    return;
  }
  $("#appList").innerHTML = list.map((a) => {
    const pct = a.total ? Math.round((a.done / a.total) * 100) : 0;
    const st = STATUS[a.status] || STATUS.in_progress;
    const sel = selected === a.leadId;
    return `
    <div data-id="${a.leadId}" class="app-card cursor-pointer bg-white rounded-2xl p-4 border transition card-shadow ${sel ? "border-primary border-l-4" : "border-outline-variant/50 hover:border-primary/50"}">
      <div class="flex justify-between items-start mb-1">
        <div>
          <h3 class="font-bold">${a.profile.name || "New applicant"}</h3>
          <p class="text-xs text-on-surface-variant">${a.profile.course || "—"} · ${a.profile.phone || a.leadId}</p>
        </div>
        <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${st.cls}">${st.label}</span>
      </div>
      <div class="flex gap-1 mb-2">
        ${a.eligible === true ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-success-soft text-success">Eligible</span>` : ""}
        ${a.eligible === false ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-soft text-amber">Needs review</span>` : ""}
        ${a.stale ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-soft text-amber">Stalled</span>` : ""}
      </div>
      <div class="flex justify-between text-[11px] font-bold text-on-surface-variant mb-1"><span>Documents</span><span>${a.done} / ${a.total ?? "?"}</span></div>
      <div class="w-full h-1.5 bg-surface-container rounded-full overflow-hidden"><div class="bg-primary h-full rounded-full" style="width:${pct}%"></div></div>
      <div class="flex items-center justify-between mt-2.5">
        <button data-draftmail="${a.leadId}" class="text-[11px] font-bold text-primary bg-primary-soft border border-primary-line hover:bg-primary hover:text-white rounded-full px-3 py-1.5 transition inline-flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">outgoing_mail</span> Draft email</button>
        <div class="text-[11px] text-on-surface-variant">${fmtTime(a.updatedAt)}</div>
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll(".app-card").forEach((el) => el.addEventListener("click", () => selectApp(el.dataset.id)));
  // "Draft email" jumps straight to this lead's Lenders tab (doesn't bubble to the card click).
  document.querySelectorAll("[data-draftmail]").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    selectApp(b.dataset.draftmail, "lenders");
  }));
}

// Keep the selected lead + tab in the URL (?lead=LD-1001&tab=lenders) so the
// browser Back/Forward buttons walk through selections instead of leaving the page.
const EMPTY_DETAIL = `<div class="h-64 grid place-items-center text-on-surface-variant bg-white/50 border border-dashed border-outline-variant rounded-2xl">Select an application to open its borrower file.</div>`;

function syncUrl() {
  const params = new URLSearchParams();
  if (selected) { params.set("lead", selected); params.set("tab", activeTab); }
  const target = params.toString() ? `${location.pathname}?${params}` : location.pathname;
  if (location.pathname + location.search !== target) history.pushState({}, "", target);
}

async function selectApp(leadId, tab, fromHistory = false) {
  selected = leadId;
  if (tab) activeTab = tab;
  if (!fromHistory) syncUrl();
  renderList();
  const d = await (await fetch(`/api/applications/${leadId}`)).json();
  if (selected !== leadId) return; // user clicked elsewhere while we fetched
  renderDetail(d);
}

// ---------- detail ----------
function renderDetail(d) {
  const p = d.profile || {};
  const st = STATUS[d.status] || STATUS.in_progress;
  const flagCount = (d.flags || []).length;

  $("#detail").innerHTML = `
  <div class="fade-in space-y-6">
    <!-- Profile card -->
    <div class="bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40">
      <div class="flex justify-between items-start mb-6 flex-wrap gap-4">
        <div class="flex items-center gap-5">
          <div class="w-16 h-16 rounded-2xl bg-primary-soft text-primary grid place-items-center text-2xl font-black">${(p.name || "?")[0]}</div>
          <div>
            <h1 class="text-2xl font-bold">${p.name || "New applicant"}${p.nameSource === "document" ? ` <span class="text-xs font-normal text-on-surface-variant">(read from document)</span>` : ""}</h1>
            <div class="flex items-center gap-2 mt-1 flex-wrap">
              <span class="bg-primary-soft text-primary px-3 py-1 rounded-full text-xs font-bold">${p.course || "—"}${p.institute ? " · " + p.institute : ""}</span>
              <span class="text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-full ${st.cls}">${st.label}</span>
            </div>
          </div>
        </div>
        ${d.status === "in_progress" ? nudgeRow(d) : ""}
      </div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-y-5 gap-x-10 border-t border-outline-variant/40 pt-6">
        ${fact("Phone", p.phone)}
        ${fact("Lead source", p.source)}
        ${fact("Loan type", p.loanType)}
        ${fact("Co-applicant", p.coApplicantType)}
        ${fact("Co-applicant name", d.coApplicantNameOnFile ? `${d.coApplicantNameOnFile} (from document)` : null)}
        ${fact("Co-applicant phone", d.coApplicantContact?.phoneNumber ? `${d.coApplicantContact.phoneNumber} (from bank statement)` : null)}
        ${fact("Partner institute", d.partnerInstitute ? `🎓 ${d.partnerInstitute.name}` : "No")}
        ${fact("Documents", `${d.done} / ${d.total}`)}
        ${fact("Reminders sent", d.nudgeCount ? `${d.nudgeCount} (last ${fmtTime(d.lastNudgeAt)})` : "None")}
      </div>
    </div>

    ${creditMemo(d)}
    ${packetCard(d)}
    ${liveAssistPlaceholder()}

    <!-- Tabs -->
    <div class="border-b border-outline-variant/60 flex gap-8 px-1">
      ${tabBtn("extract", "Extract")}
      ${tabBtn("fraud", `Fraud Check${flagCount ? ` <span class="ml-1 text-[10px] font-bold bg-danger text-white rounded-full px-1.5 py-0.5">${flagCount}</span>` : ""}`)}
      ${tabBtn("lenders", `Lenders${(d.lenderDrafts || []).length ? ` <span class="ml-1 text-[10px] font-bold bg-primary text-white rounded-full px-1.5 py-0.5">${d.lenderDrafts.length}</span>` : ""}`)}
      ${tabBtn("activity", "Activity")}
    </div>
    <div id="tabBody"></div>
  </div>`;

  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { activeTab = b.dataset.tab; syncUrl(); renderDetail(d); }));
  renderTab(d);
  wireActions(d);
  loadLiveAssistCard(d);
}

const fact = (k, v) => `
  <div>
    <p class="text-[11px] font-bold text-outline uppercase tracking-wider">${k}</p>
    <p class="text-sm font-medium capitalize mt-0.5">${v || "—"}</p>
  </div>`;

const tabBtn = (id, label) => `
  <button data-tab="${id}" class="pb-3 text-sm font-${activeTab === id ? "bold text-primary border-b-2 border-primary" : "medium text-on-surface-variant hover:text-primary"} transition">${label}</button>`;

function nudgeRow(d) {
  return `
  <div class="flex items-center gap-3 text-sm text-on-surface-variant">
    ${d.stale ? `<span class="text-amber font-semibold">Gone quiet</span>` : ""}
    <button id="nudgeBtn" class="bg-amber-soft text-amber text-xs font-bold px-4 py-2 rounded-full hover:bg-amber hover:text-white transition">Send reminder now</button>
  </div>`;
}

// Credit memo — strictly what the rule-based eligibility engine computed.
function creditMemo(d) {
  const e = d.eligibility;
  if (!e) return "";
  const decided = d.status === "approved" || d.status === "rejected";
  const verdict = e.eligible
    ? `<div class="px-4 py-1.5 bg-success-soft border border-success/20 rounded-full flex items-center gap-2"><span class="w-2 h-2 bg-success rounded-full"></span><span class="text-success text-sm font-semibold">Eligible</span></div>`
    : `<div class="px-4 py-1.5 bg-danger-soft border border-danger/20 rounded-full flex items-center gap-2"><span class="w-2 h-2 bg-danger rounded-full"></span><span class="text-danger text-sm font-semibold">Needs review</span></div>`;

  const insights = [
    ...(e.incomeNote ? [e.incomeNote] : []),
    ...(e.eligible ? [`Estimated facility ${rupees(e.estimatedAmount)} within the ${rupees(e.loanRange.min)}–${rupees(e.loanRange.max)} band.`, `Moratorium: ${e.moratoriumMonths} months (course + grace).`] : []),
    ...(e.reasons || []),
    ...(e.warnings || []),
  ];

  return `
  <section class="bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40">
    <div class="flex justify-between items-start mb-6 flex-wrap gap-3">
      <div>
        <h2 class="text-xl font-semibold mb-1">Credit memo</h2>
        <p class="text-xs text-on-surface-variant">Rule-based preliminary assessment — final decision stays with you.</p>
      </div>
      ${verdict}
    </div>
    ${e.eligible ? `
    <div class="bg-primary-soft rounded-xl p-6 mb-6 border border-primary-line">
      <div class="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Recommended facility</div>
      <div class="flex items-baseline gap-2"><span class="text-3xl font-bold text-primary">${rupees(e.estimatedAmount)}</span><span class="text-on-surface-variant">at ${(e.ratePreview || "").split(" (")[0]}</span></div>
    </div>` : ""}
    <ul class="space-y-2 mb-6">
      ${insights.map((r) => `<li class="flex items-start gap-3 text-sm"><span class="material-symbols-outlined ${e.eligible ? "text-success" : "text-amber"} text-[20px] mt-0.5">${e.eligible ? "check_circle" : "warning"}</span>${r}</li>`).join("")}
    </ul>
    ${decided
      ? `<div class="pt-5 border-t border-outline-variant/40 text-sm font-semibold ${d.status === "approved" ? "text-success" : "text-danger"}">${d.status === "approved" ? "✓ Approved" : "✕ Rejected"}${d.decisionNote ? ` — <span class="font-normal text-on-surface-variant">${d.decisionNote}</span>` : ""}</div>`
      : `<div class="flex flex-wrap gap-3 pt-5 border-t border-outline-variant/40">
          <button id="approveBtn" class="px-7 py-2.5 bg-success text-white rounded-full text-sm font-semibold hover:opacity-90 active:scale-[0.98] transition flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">done_all</span>Approve</button>
          <button id="rejectBtn" class="px-7 py-2.5 bg-danger-soft text-danger rounded-full text-sm font-semibold hover:bg-danger hover:text-white active:scale-[0.98] transition">Reject</button>
        </div>`}
  </section>`;
}

function packetCard(d) {
  if (d.done < d.total) return "";
  return `
  <section class="bg-surface-high/50 rounded-2xl p-6 border border-primary/10 flex flex-col md:flex-row justify-between items-center gap-4">
    <div class="flex items-center gap-4">
      <div class="w-12 h-12 rounded-2xl bg-primary grid place-items-center"><span class="material-symbols-outlined text-white text-[26px]">inventory_2</span></div>
      <div>
        <h3 class="font-semibold">Document packet — all documents received</h3>
        <p class="text-sm text-on-surface-variant" id="packetStatus">Email the full packet to the ops inbox.</p>
      </div>
    </div>
    <button id="packetBtn" class="px-6 py-2.5 bg-primary text-white rounded-full text-sm font-semibold hover:bg-primary-dark transition flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">forward_to_inbox</span>Send packet email</button>
  </section>`;
}

// ---------- live-assist (voice agent joins a real call) ----------
function liveAssistPlaceholder() {
  return `<div id="liveAssistCard" class="bg-white rounded-2xl p-6 card-shadow border border-outline-variant/40 text-sm text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span> Checking live-assist status…</div>`;
}

// While a call is live the phase changes on its own (joining → connected →
// speaking → listening), so the card re-checks instead of waiting for the user
// to click something. Cleared as soon as the call is over or the officer
// switches lead, so only one poll is ever in flight.
let liveAssistPoll = null;
function stopLiveAssistPoll() {
  if (liveAssistPoll) { clearTimeout(liveAssistPoll); liveAssistPoll = null; }
}

async function loadLiveAssistCard(d) {
  stopLiveAssistPoll();
  let status;
  try { status = await (await fetch(`/api/applications/${d.leadId}/live-assist`)).json(); }
  catch { status = { running: false }; }
  if (selected !== d.leadId) return; // user moved on while we fetched
  const el = $("#liveAssistCard");
  if (!el) return;
  el.outerHTML = liveAssistHtml(d, status);
  wireLiveAssist(d);
  if (status.running) liveAssistPoll = setTimeout(() => loadLiveAssistCard(d), 2000);
}

function liveAssistHtml(d, status) {
  if (status.running) {
    return `
    <section id="liveAssistCard" class="bg-primary-soft rounded-2xl p-6 border border-primary-line flex flex-col md:flex-row justify-between items-center gap-4">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-2xl bg-primary text-primary grid place-items-center ${status.phase === "connected" || status.phase === "listening" || status.phase === "speaking" ? "" : "ua-ripple"}"><span class="material-symbols-outlined text-white text-[26px]">podcasts</span></div>
        <div>
          <h3 class="font-semibold">UPSY live-assist call in progress</h3>
          <div class="mt-1.5">${UpsyPhases.phasePillHtml(status.phase, status.phaseDetail)}</div>
          ${UpsyPhases.phaseStepsHtml(status.phase)}
          <p class="text-sm text-on-surface-variant mt-2">Started ${fmtTime(status.startedAt)} · <a class="text-primary underline" href="${status.meetUrl}" target="_blank" rel="noopener">${status.meetUrl}</a></p>
          ${status.invite ? (status.invite.sent
            ? `<p class="text-xs text-success mt-1 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">check_circle</span>Join link sent to ${status.invite.phone}</p>`
            : `<p class="text-xs text-amber mt-1 flex items-start gap-1"><span class="material-symbols-outlined text-[14px]">warning</span>${status.invite.reason}</p>`) : ""}
        </div>
      </div>
      <button id="liveAssistStopBtn" class="px-6 py-2.5 bg-danger text-white rounded-full text-sm font-semibold hover:bg-danger-dark transition flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">call_end</span>Stop call</button>
    </section>`;
  }
  return `
  <section id="liveAssistCard" class="bg-surface-high/50 rounded-2xl p-6 border border-outline-variant/40 flex flex-col md:flex-row justify-between items-center gap-4">
    <div class="flex items-center gap-4 flex-1">
      <div class="w-12 h-12 rounded-2xl bg-primary-soft text-primary grid place-items-center"><span class="material-symbols-outlined text-[26px]">support_agent</span></div>
      <div class="flex-1">
        <h3 class="font-semibold">UPSY live-assist (voice)</h3>
        ${UpsyPhases.failureHtml(status && status.failure)}
        <p class="text-sm text-on-surface-variant mb-2">Paste a Google Meet link — UPSY joins the call and helps this applicant fill out a form live, grounded in their own eligibility record. The join link is texted to the applicant automatically.</p>
        <input id="liveAssistUrl" type="text" placeholder="https://meet.google.com/xxx-xxxx-xxx" class="w-full border border-outline-variant rounded-full px-4 py-2 text-sm" />
      </div>
    </div>
    <button id="liveAssistStartBtn" class="px-6 py-2.5 bg-primary text-white rounded-full text-sm font-semibold hover:bg-primary-dark transition flex items-center gap-2 whitespace-nowrap"><span class="material-symbols-outlined text-[18px]">call</span>Start call</button>
  </section>`;
}

function wireLiveAssist(d) {
  const startBtn = $("#liveAssistStartBtn");
  if (startBtn) startBtn.addEventListener("click", async () => {
    const url = $("#liveAssistUrl")?.value?.trim();
    if (!url) { alert("Paste a meeting link first."); return; }
    startBtn.disabled = true; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Starting…`;
    try {
      const r = await (await fetch(`/api/applications/${d.leadId}/live-assist`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetUrl: url, notifyApplicant: true }),
      })).json();
      if (r.error) {
        alert(r.error);
        startBtn.disabled = false; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call</span>Start call`;
        return;
      }
      // The bot takes a few seconds to appear in the meeting; say so straight
      // away rather than leaving the officer watching an empty call.
      UpsyPhases.showToast({
        title: "UPSY is joining the call",
        body: "Give it a few seconds to appear. If your meeting has a waiting room, admit UPSY when it knocks.",
      });
      await loadLiveAssistCard(d);
    } catch {
      alert("Couldn't reach the server — try again.");
      startBtn.disabled = false; startBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call</span>Start call`;
    }
  });
  const stopBtn = $("#liveAssistStopBtn");
  if (stopBtn) stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true; stopBtn.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Stopping…`;
    try {
      await fetch(`/api/applications/${d.leadId}/live-assist/stop`, { method: "POST" });
      await loadLiveAssistCard(d);
    } catch {
      alert("Couldn't reach the server — try again.");
      stopBtn.disabled = false; stopBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">call_end</span>Stop call`;
    }
  });
}

// ---------- tabs ----------
function renderTab(d) {
  const body = $("#tabBody");
  if (activeTab === "extract") body.innerHTML = extractTab(d);
  else if (activeTab === "fraud") body.innerHTML = fraudTab(d);
  else if (activeTab === "lenders") { renderLendersTab(d); return; }
  else body.innerHTML = activityTab(d);
  document.querySelectorAll("[data-reupload]").forEach((b) => b.addEventListener("click", () => askReupload(d.leadId, b.dataset.reupload)));
}

function extractTab(d) {
  const byStage = {};
  d.documents.forEach((doc) => (byStage[doc.stage] ||= []).push(doc));
  const rows = Object.entries(byStage).map(([stage, docs]) => `
    <tr><td colspan="4" class="px-6 py-2 bg-surface-container text-[11px] font-bold text-outline uppercase tracking-wider">${stage}</td></tr>
    ${docs.map((doc) => {
      const s = DOC_STATUS[doc.status] || DOC_STATUS.pending;
      return `
      <tr class="hover:bg-surface transition">
        <td class="px-6 py-3.5"><div class="flex items-center gap-2"><span class="w-2 h-2 rounded-full ${s.dot}"></span><span class="text-xs font-bold ${s.txt}">${s.label}</span></div></td>
        <td class="px-6 py-3.5">
          <div class="text-sm font-semibold">${doc.label}${doc.required ? "" : ` <span class="font-normal text-on-surface-variant">(optional)</span>`}</div>
          ${doc.filename ? `<div class="text-[11px] text-outline">${doc.filename}${doc.at ? " · " + fmtTime(doc.at) : ""}</div>` : ""}
          ${doc.nameOnDoc ? `<div class="text-[11px] ${doc.nameMatch === false ? "text-danger font-semibold" : "text-on-surface-variant"}">Name on card: ${doc.nameOnDoc}${doc.nameMatch === true ? " ✓" : doc.nameMatch === false ? " ✕ doesn't match lead" : ""}${doc.dobOnDoc ? ` · DOB ${doc.dobOnDoc}` : ""}</div>` : ""}
          ${doc.addressOnDoc ? `<div class="text-[11px] text-on-surface-variant">Address on doc: ${doc.addressOnDoc}</div>` : ""}
          ${doc.incomeOnDoc ? `<div class="text-[11px] text-success font-semibold">Income verified: ₹${(doc.incomeOnDoc.monthlyIncomeInr || 0).toLocaleString("en-IN")}/month (${doc.incomeOnDoc.basis || doc.incomeOnDoc.docType})${doc.incomeOnDoc.holderName ? ` · ${doc.incomeOnDoc.holderName}` : ""}</div>` : ""}
          ${doc.bankInfoOnDoc?.phoneNumber ? `<div class="text-[11px] text-success font-semibold">Co-applicant contact verified: ${doc.bankInfoOnDoc.phoneNumber}</div>` : ""}
          ${doc.reuploadNote ? `<div class="text-[11px] text-amber">Re-upload asked: ${doc.reuploadNote}</div>` : ""}
        </td>
        <td class="px-6 py-3.5">${doc.score != null ? `<span class="text-xs font-bold text-primary bg-primary-soft px-2 py-0.5 rounded-full">${doc.score}% checks</span>` : `<span class="text-xs text-outline">—</span>`}</td>
        <td class="px-6 py-3.5">
          <div class="flex gap-1.5">
            ${doc.fileUrl ? `<a class="text-primary hover:bg-primary-soft p-1.5 rounded-lg transition" href="${doc.fileUrl}" target="_blank" rel="noopener" title="View file"><span class="material-symbols-outlined text-[20px]">visibility</span></a>` : ""}
            ${doc.status === "verified" ? `<button data-reupload="${doc.id}" class="text-outline hover:bg-amber-soft hover:text-amber p-1.5 rounded-lg transition" title="Request re-upload"><span class="material-symbols-outlined text-[20px]">replay</span></button>` : ""}
          </div>
        </td>
      </tr>`;
    }).join("")}`).join("");

  return `
  <div class="fade-in bg-white border border-outline-variant/40 rounded-2xl overflow-hidden card-shadow">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse min-w-[640px]">
        <thead><tr class="bg-surface-container border-b border-outline-variant/50">
          <th class="px-6 py-3 text-[11px] font-bold text-outline uppercase tracking-wider">Status</th>
          <th class="px-6 py-3 text-[11px] font-bold text-outline uppercase tracking-wider">Document</th>
          <th class="px-6 py-3 text-[11px] font-bold text-outline uppercase tracking-wider">Checks</th>
          <th class="px-6 py-3 text-[11px] font-bold text-outline uppercase tracking-wider">Actions</th>
        </tr></thead>
        <tbody class="divide-y divide-outline-variant/30">${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function fraudTab(d) {
  const flags = d.flags || [];
  const flagPanel = flags.length ? `
    <section class="bg-danger-soft border border-danger/20 rounded-2xl p-7 card-shadow">
      <div class="flex items-start gap-4">
        <div class="bg-danger text-white w-10 h-10 rounded-full grid place-items-center shrink-0"><span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">warning</span></div>
        <div class="flex-1">
          <h2 class="text-lg font-semibold text-danger mb-4">${flags.length} issue${flags.length > 1 ? "s" : ""} — needs review</h2>
          <div class="space-y-3">
            ${flags.map((f) => `
            <div class="bg-white/70 p-4 rounded-xl border border-danger/15 flex items-center gap-4">
              <span class="material-symbols-outlined text-danger">${f.type === "cross_document" ? (f.field === "name" ? "badge" : "event") : "badge"}</span>
              <p class="text-sm">${f.type === "cross_document"
                ? `The <b>${f.label}</b> shows ${f.field} <b>${f.thisValue}</b>, but the <b>${f.withLabel}</b> shows <b>${f.otherValue}</b> — these should be the same document set.`
                : `On the <b>${f.label}</b> the name reads <b>${f.nameOnDoc}</b>, but the lead record says <b>${f.expected || "—"}</b>.`}</p>
            </div>`).join("")}
          </div>
        </div>
      </div>
    </section>`
    : `<section class="bg-success-soft border border-success/20 rounded-2xl p-6 flex items-center gap-4 card-shadow">
        <div class="bg-success text-white w-9 h-9 rounded-full grid place-items-center"><span class="material-symbols-outlined text-[20px]" style="font-variation-settings:'FILL' 1">check_circle</span></div>
        <p class="text-sm font-bold text-success uppercase tracking-wider">No cross-document conflicts found</p>
      </section>`;

  const evidence = d.documents.filter((doc) => doc.nameOnDoc || doc.dobOnDoc || doc.addressOnDoc);
  const evidenceGrid = evidence.length ? `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mt-6">
      ${evidence.map((doc) => {
        const conflict = doc.nameMatch === false || (doc.crossDocConflicts || []).length;
        return `
        <div class="bg-white rounded-2xl p-5 card-shadow border border-outline-variant/40">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-bold text-outline uppercase tracking-wider">${doc.label}</span>
            <span class="${conflict ? "bg-danger-soft text-danger" : "bg-success-soft text-success"} px-3 py-1 rounded-full text-[11px] font-bold">${conflict ? "Conflict found" : "Consistent"}</span>
          </div>
          <p class="text-sm text-on-surface-variant">Extracted name: <b class="text-on-surface">${doc.nameOnDoc || "—"}</b></p>
          <p class="text-sm text-on-surface-variant">Extracted DOB: <b class="text-on-surface">${doc.dobOnDoc || "—"}</b></p>
          ${doc.addressOnDoc ? `<p class="text-sm text-on-surface-variant">Extracted address: <b class="text-on-surface">${doc.addressOnDoc}</b></p>` : ""}
          ${doc.fileUrl ? `<a class="inline-flex items-center gap-1 text-primary text-sm font-semibold mt-3 hover:underline" href="${doc.fileUrl}" target="_blank" rel="noopener"><span class="material-symbols-outlined text-[18px]">visibility</span>View document</a>` : ""}
        </div>`;
      }).join("")}
    </div>` : `<p class="text-sm text-on-surface-variant mt-6">No ID documents with readable name/DOB yet — evidence appears here as cards are verified.</p>`;

  return `<div class="fade-in">${flagPanel}${evidenceGrid}</div>`;
}

// ---------- Lenders tab: match → generate draft → open in Outlook → mark shared ----------
let expandedLender = null; // which lender's draft editor is open

async function renderLendersTab(d) {
  const body = $("#tabBody");
  body.innerHTML = `<div class="fade-in bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40 text-sm text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined animate-spin">progress_activity</span> Matching partner lenders…</div>`;
  let data;
  try { data = await (await fetch(`/api/applications/${d.leadId}/lenders`)).json(); }
  catch { body.innerHTML = `<div class="fade-in bg-danger-soft rounded-2xl p-6 text-danger text-sm">Couldn't load lenders — try again.</div>`; return; }
  if (activeTab !== "lenders" || selected !== d.leadId) return; // user moved on while we fetched

  const lenders = data.lenders || [];
  body.innerHTML = `
  <div class="fade-in space-y-4">
    ${data.partnerInstitute ? `<div class="bg-success-soft border border-success/20 rounded-2xl p-4 text-sm flex items-start gap-2"><span class="material-symbols-outlined text-success text-[20px]">school</span><span><b>${data.partnerInstitute.name}</b> is a partner institute — flag this in the referral for preferential processing.</span></div>` : ""}
    <p class="text-xs text-on-surface-variant px-1">Demo lender catalogue — matched by loan type, amount, academics and citizenship. Generate a referral draft, review it, open it in Outlook (verified documents attached) and send; then mark it shared so the timeline records it.</p>
    ${lenders.map((l) => lenderCard(d, l)).join("")}
  </div>`;
  wireLenderCards(d, lenders);
}

function lenderCard(d, l) {
  const draft = l.draft;
  const open = expandedLender === l.id && draft;
  const status = draft
    ? draft.sharedAt
      ? `<span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-success-soft text-success">Shared ${fmtTime(draft.sharedAt)}</span>`
      : `<span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary-soft text-primary">Drafted ${fmtTime(draft.draftedAt)}</span>`
    : "";
  return `
  <div class="bg-white rounded-2xl p-6 card-shadow border ${l.fit ? "border-outline-variant/40" : "border-outline-variant/40 opacity-60"}">
    <div class="flex justify-between items-start flex-wrap gap-3">
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <h3 class="font-bold">${l.name}</h3>
          <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${l.type === "Bank" ? "bg-success-soft text-success" : "bg-primary-soft text-primary"}">${l.type}</span>
          <span class="text-[11px] text-on-surface-variant">${l.rateRange} p.a.</span>
          ${status}
        </div>
        <p class="text-xs text-on-surface-variant mt-1">${l.blurb}</p>
        <div class="flex flex-wrap gap-1.5 mt-2">
          ${l.reasons.map((r) => `<span class="text-[11px] rounded-full px-2.5 py-1 ${l.fit ? "bg-success-soft text-success" : "bg-amber-soft text-amber"}">${l.fit ? "✓" : "✕"} ${r}</span>`).join("")}
        </div>
      </div>
      <div class="flex gap-2 shrink-0">
        ${draft
          ? `<button data-toggle="${l.id}" class="px-4 py-2 text-xs font-bold rounded-full border border-primary text-primary hover:bg-primary-soft transition">${open ? "Hide draft" : "View draft"}</button>
             <button data-generate="${l.id}" class="px-4 py-2 text-xs font-bold rounded-full text-on-surface-variant hover:bg-surface-container transition" title="Regenerate from scratch">Regenerate</button>`
          : `<button data-generate="${l.id}" class="px-5 py-2 text-xs font-bold rounded-full bg-primary text-white hover:bg-primary-dark transition inline-flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">auto_awesome</span> Generate draft</button>`}
      </div>
    </div>
    ${open ? `
    <div class="mt-5 pt-5 border-t border-outline-variant/40 space-y-3">
      <div class="text-xs text-on-surface-variant">To: <b class="text-on-surface">${draft.to}</b> · ${draft.attachmentsCount} verified document${draft.attachmentsCount === 1 ? "" : "s"} will be attached</div>
      <input data-subject="${l.id}" value="${(draft.subject || "").replace(/"/g, "&quot;")}" class="w-full h-11 px-3 bg-surface border border-outline-variant rounded-xl text-sm font-semibold focus:border-primary outline-none transition"/>
      <textarea data-body="${l.id}" rows="12" class="w-full p-3 bg-surface border border-outline-variant rounded-xl text-sm leading-relaxed focus:border-primary outline-none transition font-mono">${(draft.body || "").replace(/</g, "&lt;")}</textarea>
      <div class="flex flex-wrap gap-2 items-center">
        <button data-outlook="${l.id}" class="px-5 py-2.5 text-xs font-bold rounded-full bg-primary text-white hover:bg-primary-dark transition inline-flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">outgoing_mail</span> Open in Outlook (.eml)</button>
        <button data-share="${l.id}" ${draft.sharedAt ? "disabled" : ""} class="px-5 py-2.5 text-xs font-bold rounded-full ${draft.sharedAt ? "bg-success-soft text-success cursor-default" : "bg-white border border-success text-success hover:bg-success hover:text-white"} transition inline-flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">${draft.sharedAt ? "check_circle" : "send"}</span> ${draft.sharedAt ? `Shared via ${draft.sharedVia === "outlook" ? "Outlook" : draft.sharedVia}` : "Mark as shared"}</button>
        <span data-savednote="${l.id}" class="text-xs text-on-surface-variant"></span>
      </div>
      <p class="text-[11px] text-on-surface-variant">Edits save automatically when you open the .eml or mark it shared. The .eml opens as an unsent Outlook draft — review and hit Send there, then come back and mark it shared.</p>
    </div>` : ""}
  </div>`;
}

function wireLenderCards(d, lenders) {
  const saveEdits = async (lenderId) => {
    const s = document.querySelector(`[data-subject="${lenderId}"]`);
    const b = document.querySelector(`[data-body="${lenderId}"]`);
    if (!s || !b) return true; // editor not open — nothing to save
    const r = await fetch(`/api/applications/${d.leadId}/lenders/${lenderId}/draft`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: s.value, body: b.value }),
    });
    return r.ok;
  };

  document.querySelectorAll("[data-generate]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> Drafting…`;
    try {
      const r = await fetch(`/api/applications/${d.leadId}/lenders/${b.dataset.generate}/draft`, { method: "POST" });
      if (!r.ok) throw new Error();
      expandedLender = b.dataset.generate;
      renderLendersTab(d);
    } catch { b.disabled = false; b.textContent = "Try again"; }
  }));

  document.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    expandedLender = expandedLender === b.dataset.toggle ? null : b.dataset.toggle;
    renderLendersTab(d);
  }));

  document.querySelectorAll("[data-outlook]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.outlook;
    const note = document.querySelector(`[data-savednote="${id}"]`);
    if (!(await saveEdits(id))) { if (note) note.textContent = "Couldn't save your edits — check subject/body aren't empty."; return; }
    if (note) note.textContent = "Saved ✓ — downloading .eml…";
    window.location.href = `/api/applications/${d.leadId}/lenders/${id}/draft.eml`;
  }));

  document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", async () => {
    if (b.disabled) return;
    const id = b.dataset.share;
    if (!(await saveEdits(id))) return;
    b.disabled = true; b.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> Recording…`;
    await fetch(`/api/applications/${d.leadId}/lenders/${id}/share`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ via: "outlook" }),
    });
    renderLendersTab(d);
  }));
}

function activityTab(d) {
  const events = (d.timeline || []).slice().reverse();
  if (!events.length) return `<div class="fade-in bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40 text-sm text-on-surface-variant">No activity yet.</div>`;
  return `
  <div class="fade-in bg-white rounded-2xl p-8 card-shadow border border-outline-variant/40">
    <div class="relative space-y-7 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[2px] before:bg-surface-container">
      ${events.map((e) => {
        const isLenderEvent = e.event === "lender_draft_created" || e.event === "lender_email_shared";
        const dot = e.event === "lender_email_shared" ? "bg-success" : "bg-primary";
        return `
      <div class="relative pl-10">
        <div class="absolute left-0 top-0.5 w-6 h-6 bg-white border-2 border-primary-line rounded-full grid place-items-center z-10"><div class="w-2 h-2 ${dot} rounded-full"></div></div>
        <p class="text-sm font-semibold">${prettyEvent(e.event)}${isLenderEvent && e.lender ? ` — ${e.lender}` : ""}</p>
        ${e.label ? `<p class="text-xs ${isLenderEvent ? "text-on-surface bg-surface-container rounded-lg px-3 py-2 mt-1" : "text-on-surface-variant mt-0.5"} break-words">${e.label}</p>` : ""}
        <time class="text-[11px] text-outline mt-0.5 block">${fmtTime(e.at)}</time>
      </div>`;
      }).join("")}
    </div>
  </div>`;
}

// ---------- actions ----------
function wireActions(d) {
  const approve = $("#approveBtn"), reject = $("#rejectBtn"), nudge = $("#nudgeBtn"), packet = $("#packetBtn");
  if (approve) approve.addEventListener("click", () => decide(d.leadId, "approve"));
  if (reject) reject.addEventListener("click", () => decide(d.leadId, "reject"));
  if (nudge) nudge.addEventListener("click", async () => {
    nudge.disabled = true; nudge.textContent = "Sending…";
    await fetch(`/api/applications/${d.leadId}/nudge`, { method: "POST" });
    await loadList(); selectApp(d.leadId);
  });
  if (packet) packet.addEventListener("click", async () => {
    packet.disabled = true; packet.innerHTML = `<span class="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>Sending…`;
    try {
      const r = await (await fetch("/api/session/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: d.leadId }) })).json();
      const m = r.mail || {};
      $("#packetStatus").innerHTML = m.ok
        ? `✓ Emailed ${m.count} attachment${m.count === 1 ? "" : "s"} to <b>${m.to}</b>${m.preview ? ` · <a class="text-primary underline" href="${m.preview}" target="_blank" rel="noopener">view test email</a>` : ""}`
        : `Couldn't send — ${m.simulated ? "email isn't configured yet (set SMTP in .env)" : "try again"}.`;
    } catch { $("#packetStatus").textContent = "Couldn't reach the server — try again."; }
    packet.disabled = false; packet.innerHTML = `<span class="material-symbols-outlined text-[18px]">forward_to_inbox</span>Re-send email`;
  });
}

async function decide(leadId, action) {
  let note = "";
  if (action === "reject") note = prompt("Reason for rejection (optional):") || "";
  await fetch(`/api/applications/${leadId}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note }),
  });
  await loadList(); selectApp(leadId);
}

async function askReupload(leadId, docId) {
  const note = prompt("What should the applicant fix? (optional — shown to them)") || "";
  await fetch(`/api/applications/${leadId}/documents/${docId}/request-reupload`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
  });
  await loadList(); selectApp(leadId);
}

// ---------- voice callers ----------
// People who have only ever talked to UPSY on the phone, via /m. A separate
// population from borrower files on purpose — see the note in team.html. What
// the calls establish about someone lands in `profile`, which is rendered
// generically here so that adding a field to what the agent captures needs no
// change on this side.

let voiceAccounts = [];
let selectedVoice = null;
// The branch definitions, fetched once. Labels, order and types all come from
// backend/callSchema.js so this file never restates the schema — a field the
// agent stops asking for disappears from here on its own.
let voiceSchema = null;

async function loadVoiceSchema() {
  if (voiceSchema) return voiceSchema;
  try {
    voiceSchema = await (await fetch("/api/voice/schema")).json();
  } catch (e) {
    voiceSchema = { branches: [] }; // render values under raw keys rather than nothing
  }
  return voiceSchema;
}

async function loadVoiceAccounts() {
  await loadVoiceSchema();
  const r = await (await fetch("/api/voice/accounts")).json();
  voiceAccounts = r.accounts || [];
  renderVoiceList();
}

function renderVoiceList() {
  const q = ($("#search").value || "").toLowerCase();
  const list = voiceAccounts.filter((a) => !q || (a.name || "").toLowerCase().includes(q) || (a.phone || "").includes(q));
  $("#pageSub").textContent = `${voiceAccounts.length} voice caller${voiceAccounts.length === 1 ? "" : "s"} · from the /m phone line.`;
  if (!list.length) {
    $("#appList").innerHTML = `<div class="p-6 text-sm text-on-surface-variant bg-white rounded-2xl border border-outline-variant/50">${
      voiceAccounts.length ? "No caller matches that search." : "Nobody has signed up on the phone line yet. Accounts appear here as soon as someone creates one at /m."
    }</div>`;
    return;
  }
  $("#appList").innerHTML = list.map((a) => {
    const sel = selectedVoice === a.accountId;
    // Coverage comes from the server, computed against the same schema the
    // agent's agenda is built from — see the note on /api/voice/accounts.
    const cov = a.coverage || { captured: 0, total: 0, percent: 0 };
    const threats = (a.profile?._flags || []).filter((f) => f.severity === "threat").length;
    return `
    <div data-voice="${a.accountId}" class="voice-card cursor-pointer bg-white rounded-2xl p-4 border transition card-shadow ${sel ? "border-primary border-l-4" : "border-outline-variant/50 hover:border-primary/50"}">
      <div class="flex justify-between items-start mb-1">
        <div>
          <h3 class="font-bold">${esc(a.name)}</h3>
          <p class="text-xs text-on-surface-variant">${esc(a.phone)}</p>
        </div>
        <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${a.callCount ? "bg-primary-soft text-primary-dark" : "bg-surface-container text-on-surface-variant"}">${
          a.callCount ? `${a.callCount} call${a.callCount === 1 ? "" : "s"}` : "No calls yet"
        }</span>
      </div>
      <div class="mt-2.5 h-1.5 rounded-full bg-surface-container overflow-hidden">
        <div class="h-full rounded-full ${cov.percent >= 80 ? "bg-success" : "bg-primary"}" style="width:${cov.percent}%"></div>
      </div>
      <div class="flex items-center justify-between mt-2">
        <span class="text-[11px] text-on-surface-variant">${cov.captured}/${cov.total} answered${threats ? ` · <span class="text-danger font-bold">${threats} flag${threats === 1 ? "" : "s"}</span>` : ""}</span>
        <span class="text-[11px] text-on-surface-variant">${a.lastCallAt ? fmtTime(a.lastCallAt) : "signed up " + fmtTime(a.createdAt)}</span>
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll(".voice-card").forEach((el) => el.addEventListener("click", () => selectVoice(el.dataset.voice)));
}

async function selectVoice(accountId) {
  selectedVoice = accountId;
  renderVoiceList();
  const r = await (await fetch(`/api/voice/accounts/${encodeURIComponent(accountId)}`)).json();
  if (selectedVoice !== accountId) return; // clicked elsewhere while we fetched
  voiceDetailSignature = detailSignature(r.account);
  renderVoiceDetail(r.account);
}

// What an open caller's file looks like right now. Compared tick to tick so the
// pane is only rebuilt when something actually changed.
let voiceDetailSignature = null;
function detailSignature(a) {
  return JSON.stringify({
    profile: a.profile,
    plan: a.documentPlan?.counts,
    calls: a.callCount,
    last: a.lastCallAt,
  });
}

/**
 * Keep the OPEN caller's file live while a call is still running.
 *
 * The list already polls; without this the detail pane was a snapshot from
 * whenever it was clicked, so an officer watching a call in progress would see
 * the coverage bar on the list tick up while the branches, the flags and the
 * document plan beside it stayed frozen. That is worse than not updating at
 * all — two numbers on one screen disagreeing about the same call.
 *
 * Re-rendered only when the payload changed, and that guard is the whole
 * design: `renderVoiceDetail()` rebuilds `innerHTML`, which collapses any call
 * transcript the officer has expanded. Doing that every seven seconds would
 * make the call history unreadable. On a quiet caller nothing moves; when a
 * fact lands mid-call the pane updates once, which is exactly when a collapsed
 * transcript is a fair price.
 */
async function refreshVoiceDetail() {
  if (!selectedVoice) return;
  const id = selectedVoice;
  const r = await (await fetch(`/api/voice/accounts/${encodeURIComponent(id)}`)).json();
  if (!r.account || selectedVoice !== id) return; // they clicked elsewhere mid-flight
  const sig = detailSignature(r.account);
  if (sig === voiceDetailSignature) return;
  voiceDetailSignature = sig;
  renderVoiceDetail(r.account);
}

// A value, in the shape the field says it is. The schema carries the type, so
// ₹ formatting and "Yes/No" happen once here rather than at each call site.
function fmtFact(field, v) {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join(", ");
  if (!field) return String(v);
  // Type formatting only applies to a value of that type. A money field holding
  // a string ("₹95,000" — how the profile was hand-seeded before the schema
  // existed) would come back as "₹₹95,000" through rupees().
  if (field.type === "money" && typeof v === "number") return rupees(v);
  if (field.type === "percent" && typeof v === "number") return `${v}%`;
  if (field.unit && typeof v === "number") return `${v} ${field.unit}`;
  return String(v);
}

// One captured answer: the value, and underneath it the caller's own words.
//
// The quote is not decoration. The README's extractor decision says it plainly:
// this repo has caught the same model reading one figure as ₹1,39,100 and
// ₹13,91,000, and a number on an officer's screen with no way back to the
// sentence it came from is a lending decision made on an unverifiable claim.
// `verbatim: false` means the model could not be matched to anything in the
// transcript — the value stands, but it is marked, and an officer who acts on
// it should open the call first.
function factRow(field, key, value, evidence) {
  const ev = evidence?.[key];
  const quote = ev?.said
    ? `<p class="text-[11px] text-on-surface-variant italic mt-0.5 leading-snug">“${esc(ev.said)}”${
        ev.verbatim === false
          ? ` <span class="not-italic font-bold text-amber" title="This quote could not be matched to anything in the transcript — read the call before acting on this value.">· unmatched</span>`
          : ""
      }</p>`
    : "";
  return `<div class="py-2 border-b border-outline-variant/40 last:border-0">
    <div class="flex justify-between gap-4 items-baseline">
      <span class="text-xs text-on-surface-variant">${esc(field?.label || key)}</span>
      <span class="text-xs font-bold text-right">${esc(fmtFact(field, value))}</span>
    </div>
    ${quote}
  </div>`;
}

function branchCard(branch, profile, coverageBranch, evidence) {
  const values = profile[branch.id] || {};
  const rows = branch.fields
    .filter((f) => values[f.id] !== undefined && values[f.id] !== null && values[f.id] !== "")
    .map((f) => factRow(f, `${branch.id}.${f.id}`, values[f.id], evidence))
    .join("");
  const missing = (coverageBranch?.missing || [])
    .map((m) => `<span class="text-[11px] px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant">${esc(m.label)}</span>`)
    .join(" ");
  // Asked on a call and met "I don't know" — resolved without data, which is a
  // different fact from "never asked", and mislabelling it as the latter is
  // what made the agent re-ask a caller three times.
  const declined = (coverageBranch?.declined || [])
    .map((m) => `<span class="text-[11px] px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant italic" title="Asked on a call — the caller did not know or preferred not to say">${esc(m.label)} · didn't know</span>`)
    .join(" ");
  const captured = coverageBranch ? `${coverageBranch.captured}/${coverageBranch.total}` : "";

  return `<div class="bg-white rounded-2xl p-5 border border-outline-variant/50 card-shadow mb-4">
    <div class="flex justify-between items-start mb-2">
      <div>
        <h4 class="font-bold text-sm">${esc(branch.title)}</h4>
        <p class="text-[11px] text-on-surface-variant">${esc(branch.blurb)}</p>
      </div>
      <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
        coverageBranch && coverageBranch.captured === coverageBranch.total ? "bg-success-soft text-success" : "bg-surface-container text-on-surface-variant"
      }">${captured}</span>
    </div>
    ${rows || `<p class="text-xs text-on-surface-variant py-1">Nothing established yet.</p>`}
    ${missing ? `<div class="mt-3 pt-3 border-t border-outline-variant/40"><p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant mb-1.5">Still to ask</p><div class="flex flex-wrap gap-1">${missing}</div></div>` : ""}
    ${declined ? `<div class="mt-3 pt-3 border-t border-outline-variant/40"><p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant mb-1.5">Asked — no answer</p><div class="flex flex-wrap gap-1">${declined}</div></div>` : ""}
  </div>`;
}

// The flowchart's lender box. Everything in it is arithmetic on the branches
// above — no model touches these numbers, which is the whole reason they are
// computed on the server rather than extracted.
function underwritingCard(uw) {
  if (!uw) return "";
  if (!uw.ready) {
    return `<div class="bg-white rounded-2xl p-5 border border-outline-variant/50 card-shadow mb-4">
      <h4 class="font-bold text-sm mb-1">Underwriting</h4>
      <p class="text-xs text-on-surface-variant">Cannot be worked out yet — still missing ${esc((uw.missing || []).join(" and "))}.</p>
    </div>`;
  }
  const heavy = uw.foirUpdated >= 80;
  const cell = (label, value, cls = "") =>
    `<div><p class="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">${label}</p><p class="text-sm font-bold ${cls}">${value}</p></div>`;
  return `<div class="bg-white rounded-2xl p-5 border ${heavy ? "border-danger/40" : "border-outline-variant/50"} card-shadow mb-4">
    <div class="flex justify-between items-start mb-3">
      <h4 class="font-bold text-sm">Underwriting</h4>
      <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${heavy ? "bg-danger-soft text-danger" : "bg-primary-soft text-primary-dark"}">${esc(uw.lender)}</span>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      ${cell("FOIR now", `${uw.foirExisting}%`)}
      ${cell("FOIR with this loan", `${uw.foirUpdated}%`, heavy ? "text-danger" : "text-primary")}
      ${cell("New EMI (est.)", rupees(uw.proposedEmi))}
      ${cell("Rate band", esc(uw.rateBand))}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4 pt-3 border-t border-outline-variant/40">
      ${cell("Monthly income", `${rupees(uw.monthlyIncome)}<span class="font-normal text-[10px] text-on-surface-variant"> · ${esc(uw.incomeBasis || "")}</span>`)}
      ${cell("Existing EMIs", uw.existingEmiKnown ? rupees(uw.existingEmi) : "not asked")}
      ${cell("Loan", `${rupees(uw.loanAmount)}<span class="font-normal text-[10px] text-on-surface-variant"> · ${esc(uw.amountBasis || "")}</span>`)}
    </div>
    <p class="text-[11px] text-on-surface-variant mt-3">${esc(uw.lenderNote)} ${esc(uw.basis)}</p>
  </div>`;
}

// Anything on the profile the schema does not describe.
//
// The extractor cannot produce these — validate() drops unknown branches and
// fields before they reach storage. They exist because profiles written before
// the schema did (and anything a future field rename leaves behind) are still
// real things a caller said, and a dashboard that silently hides data it does
// not recognise is worse than one that shows it plainly under a raw key.
function otherFactsCard(profile) {
  const known = new Map((voiceSchema?.branches || []).map((b) => [b.id, new Set(b.fields.map((f) => f.id))]));
  const rows = [];
  const push = (label, v) => {
    const shown = v && typeof v === "object" ? JSON.stringify(v) : String(v);
    rows.push(`<div class="flex justify-between gap-4 py-1.5 border-b border-outline-variant/40 last:border-0">
      <span class="text-xs text-on-surface-variant">${esc(label)}</span>
      <span class="text-xs font-bold text-right">${esc(shown)}</span>
    </div>`);
  };

  for (const [key, value] of Object.entries(profile)) {
    if (key.startsWith("_") || key === "underwriting") continue; // metadata and the derived branch
    if (!known.has(key)) {
      push(key, value);
      continue;
    }
    const fields = known.get(key);
    for (const [k, v] of Object.entries(value || {})) {
      if (!fields.has(k)) push(`${key} · ${k}`, v);
    }
  }
  if (!rows.length) return "";
  return `<div class="bg-white rounded-2xl p-5 border border-outline-variant/50 card-shadow mb-4">
    <h4 class="font-bold text-sm mb-1">Other details on file <span class="font-normal text-[11px] text-on-surface-variant">— captured before the current branch schema, or under a name it no longer uses</span></h4>
    ${rows.join("")}
  </div>`;
}

// The join with the doc collection agent: what this conversation narrowed the
// catalogue down to.
//
// The skipped list is shown, not hidden, and that is the point of the card. An
// officer who can only see what was asked for cannot tell "correctly narrowed"
// from "quietly missed" — and "we are NOT asking your father for three years of
// ITR because he is salaried" is the sentence that makes the two agents worth
// joining at all.
function documentPlanCard(plan) {
  if (!plan) return "";
  const asked = plan.asked.map((d) => `<div class="py-2 border-b border-outline-variant/40 last:border-0">
      <div class="flex justify-between gap-3 items-baseline">
        <span class="text-xs font-bold">${esc(d.label)}</span>
        ${d.inCollectionFlow ? "" : `<span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-soft text-amber flex-none" title="The flowchart asks for this, but the /docs upload flow has no row for it yet.">not in upload flow</span>`}
      </div>
      <p class="text-[11px] text-on-surface-variant mt-0.5 leading-snug">${esc(d.because)}</p>
    </div>`).join("");

  const skipped = plan.skipped.map((d) => `<div class="py-1.5 border-b border-outline-variant/40 last:border-0">
      <span class="text-xs line-through text-on-surface-variant">${esc(d.label)}</span>
      <p class="text-[11px] text-on-surface-variant leading-snug">${esc(d.because)}</p>
    </div>`).join("");

  const pending = plan.pending.map((p) => `<div class="py-1.5 border-b border-outline-variant/40 last:border-0">
      <p class="text-xs">Ask: ${esc(p.question)}</p>
      <p class="text-[11px] text-on-surface-variant leading-snug">Settles ${esc(p.settles)}.</p>
    </div>`).join("");

  return `<div class="bg-white rounded-2xl p-5 border border-outline-variant/50 card-shadow mb-4">
    <div class="flex justify-between items-start mb-1">
      <div>
        <h4 class="font-bold text-sm">Documents to request</h4>
        <p class="text-[11px] text-on-surface-variant">Narrowed from the ${plan.counts.catalogue}-document catalogue by what this caller said.</p>
      </div>
      <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary-soft text-primary-dark flex-none">${plan.counts.asked} to ask</span>
    </div>
    ${asked}
    ${skipped ? `<details class="mt-3 pt-3 border-t border-outline-variant/40">
      <summary class="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Not being asked for (${plan.counts.skipped}) — and why</summary>
      <div class="mt-2">${skipped}</div>
    </details>` : ""}
    ${pending ? `<div class="mt-3 pt-3 border-t border-outline-variant/40">
      <p class="text-[10px] font-bold uppercase tracking-wider text-amber mb-1.5">${plan.counts.pending} question${plan.counts.pending === 1 ? "" : "s"} would narrow this further</p>
      ${pending}
    </div>` : ""}
  </div>`;
}

function flagsCard(flags) {
  if (!flags || !flags.length) return "";
  const rows = flags.map((f) => {
    const threat = f.severity === "threat";
    return `<div class="flex gap-2.5 py-2 border-b border-outline-variant/40 last:border-0">
      <span class="material-symbols-outlined text-base flex-none ${threat ? "text-danger" : "text-amber"}">${threat ? "error" : "info"}</span>
      <div>
        <p class="text-xs leading-snug">${esc(f.message)}</p>
        <p class="text-[10px] text-on-surface-variant uppercase tracking-wider mt-0.5">${esc(f.branch)} · ${esc(f.code)}</p>
      </div>
    </div>`;
  }).join("");
  const threats = flags.filter((f) => f.severity === "threat").length;
  return `<div class="bg-white rounded-2xl p-5 border ${threats ? "border-danger/40" : "border-outline-variant/50"} card-shadow mb-4">
    <h4 class="font-bold text-sm mb-1">Flags <span class="font-normal text-[11px] text-on-surface-variant">— raised by the rules on the flowchart, not by the model</span></h4>
    ${rows}
  </div>`;
}

function renderVoiceDetail(a) {
  if (!a) { $("#detail").innerHTML = EMPTY_DETAIL; return; }
  const profile = a.profile || {};
  const evidence = profile._evidence || {};
  const cov = a.coverage || { branches: [], captured: 0, total: 0, percent: 0 };
  const byId = new Map(cov.branches.map((b) => [b.id, b]));
  const branches = (voiceSchema?.branches || [])
    .map((b) => branchCard(b, profile, byId.get(b.id), evidence))
    .join("");
  const calls = (a.calls || []).map((c) => {
    const mins = Math.floor(c.seconds / 60);
    const secs = c.seconds % 60;
    const turns = (c.turns || []).map((t) => `
      <div class="flex gap-2 py-1">
        <span class="text-[10px] font-bold uppercase tracking-wider w-12 flex-none pt-0.5 ${t.role === "caller" ? "text-primary" : "text-on-surface-variant"}">${t.role === "caller" ? "Them" : "UPSY"}</span>
        <span class="text-xs leading-relaxed">${esc(t.text)}</span>
      </div>`).join("");
    return `
    <details class="bg-white rounded-2xl border border-outline-variant/50 card-shadow mb-3">
      <summary class="cursor-pointer list-none p-4 flex justify-between items-center">
        <span class="text-sm font-bold">${fmtTime(c.startedAt)}</span>
        <span class="text-xs text-on-surface-variant">${mins ? `${mins}m ` : ""}${secs}s · ${(c.turns || []).length} turns</span>
      </summary>
      <div class="px-4 pb-4 border-t border-outline-variant/40 pt-3 max-h-96 overflow-y-auto custom-scrollbar">${turns || `<p class="text-xs text-on-surface-variant">Nothing was said on this call.</p>`}</div>
    </details>`;
  }).join("");

  $("#detail").innerHTML = `
    <div class="bg-white rounded-2xl p-6 border border-outline-variant/50 card-shadow mb-6">
      <div class="flex justify-between items-start">
        <div>
          <h2 class="text-2xl font-bold">${esc(a.name)}</h2>
          <p class="text-on-surface-variant text-sm mt-0.5">${esc(a.phone)} · voice caller since ${fmtTime(a.createdAt)}</p>
        </div>
        <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-primary-soft text-primary-dark">${a.callCount} call${a.callCount === 1 ? "" : "s"}</span>
      </div>
      <div class="mt-4">
        <div class="flex justify-between text-[11px] text-on-surface-variant mb-1">
          <span>What the calls have established</span>
          <span class="font-bold">${cov.captured} of ${cov.total} · ${cov.percent}%</span>
        </div>
        <div class="h-2 rounded-full bg-surface-container overflow-hidden">
          <div class="h-full rounded-full ${cov.percent >= 80 ? "bg-success" : "bg-primary"}" style="width:${cov.percent}%"></div>
        </div>
      </div>
      <p class="text-[11px] text-on-surface-variant mt-4 pt-3 border-t border-outline-variant/40">
        This person signed up on the phone line. They are not linked to a borrower file — if that is the same human as one of the applications, link them by hand.
        Everything below is <strong>what they said on a call</strong>, not verified against a document.
      </p>
    </div>

    ${flagsCard(profile._flags)}
    ${underwritingCard(profile.underwriting)}
    ${documentPlanCard(a.documentPlan)}
    ${branches || `<div class="bg-white rounded-2xl p-6 border border-outline-variant/50 card-shadow mb-4"><p class="text-sm text-on-surface-variant">Nothing captured yet. The branches fill in as the agent works through them on a call.</p></div>`}
    ${otherFactsCard(profile)}

    <h3 class="font-bold mb-3 mt-6">Call history</h3>
    ${calls || `<div class="p-6 text-sm text-on-surface-variant bg-white rounded-2xl border border-outline-variant/50">No calls yet — the account exists but nobody has talked to UPSY on it.</div>`}`;
}

// ---------- list mode ----------
let listMode = "leads";

function setListMode(mode) {
  listMode = mode === "voice" ? "voice" : "leads";
  document.querySelectorAll(".list-mode").forEach((b) => {
    const on = b.dataset.mode === listMode;
    b.classList.toggle("bg-white", on);
    b.classList.toggle("text-primary", on);
    b.classList.toggle("card-shadow", on);
    b.classList.toggle("text-on-surface-variant", !on);
  });
  $("#search").placeholder = listMode === "voice" ? "Search callers…" : "Search applicants…";
  $("#pageTitle").textContent = listMode === "voice" ? "Voice callers" : "Applications";
  $("#detail").innerHTML = EMPTY_DETAIL;
  if (listMode === "voice") { selectedVoice = null; loadVoiceAccounts(); }
  else { selected = null; renderList(); }
}

// ---------- boot ----------
window.addEventListener("popstate", () => {
  const q = new URLSearchParams(location.search);
  const lead = q.get("lead");
  if (lead) selectApp(lead, q.get("tab") || "extract", true);
  else { selected = null; activeTab = "extract"; renderList(); $("#detail").innerHTML = EMPTY_DETAIL; }
});

document.querySelectorAll(".list-mode").forEach((b) => b.addEventListener("click", () => setListMode(b.dataset.mode)));

// One search box, two lists — it filters whichever one is on screen.
$("#search").addEventListener("input", () => (listMode === "voice" ? renderVoiceList() : renderList()));

loadList().then(() => {
  // Deep link / refresh: restore the lead + tab from the URL.
  const q = new URLSearchParams(location.search);
  if (q.get("lead")) selectApp(q.get("lead"), q.get("tab") || "extract", true);
});

// Auto-refresh only the list the officer is actually looking at. Refreshing
// both would re-render the voice list out from under a click, and re-rendering
// the lead list while the voice view is open puts the wrong cards on screen.
setInterval(async () => {
  // Swallowed on purpose. This runs forever, so any blip — a restart, a sleeping
  // laptop, a dropped wifi — becomes an uncaught rejection in the console every
  // seven seconds, which buries the errors that actually mean something. The
  // next tick re-renders from live data anyway, so there is nothing to recover.
  try {
    if (listMode === "voice") {
      await loadVoiceAccounts();
      // ...and the file that is open beside it, or the two disagree.
      await refreshVoiceDetail();
    } else await loadList();
  } catch (e) {
    /* transient — the next tick will pick it up */
  }
}, 7000);
