// Shared presentation for the live-assist call phases reported by the backend
// (liveAssist.js emits them, liveAssistManager surfaces them on the status
// endpoint). Loaded by both index.html and team.html so the applicant and the
// officer see the same wording for the same state.
//
// Why this exists: before it, the UI said "in progress" from the instant the
// process spawned, so an applicant staring at an empty meeting could not tell
// "the bot is on its way" from "nothing is happening". Worse, a bot stuck in
// the waiting room looked identical to a bot that had joined — with nobody
// realising it needed admitting.

(function (global) {
  const PHASES = {
    starting: {
      label: "Starting UPSY…",
      hint: "Getting the assistant ready.",
      icon: "rocket_launch",
      tone: "busy",
    },
    waiting_room: {
      label: "UPSY is waiting to be let in",
      // The one phase that needs the human to act, so it is worded as an ask.
      hint: "Admit UPSY from your meeting's waiting room to continue.",
      icon: "meeting_room",
      tone: "attention",
    },
    in_meeting: {
      label: "UPSY is in the meeting",
      hint: "Waiting for you to join.",
      icon: "podcasts",
      tone: "busy",
    },
    connected: {
      label: "UPSY is with you",
      hint: "Share your screen and just talk normally.",
      icon: "verified",
      tone: "good",
    },
    thinking: {
      label: "UPSY is thinking…",
      hint: "Looking at your screen.",
      icon: "neurology",
      tone: "busy",
    },
    speaking: {
      label: "UPSY is speaking",
      hint: "You can talk over it any time.",
      icon: "graphic_eq",
      tone: "speaking",
    },
    listening: {
      label: "Your turn",
      hint: "UPSY is listening.",
      icon: "hearing",
      tone: "good",
    },
    ending: {
      label: "Wrapping up…",
      hint: "Leaving the meeting.",
      icon: "call_end",
      tone: "busy",
    },
  };

  const TONE_CLASS = {
    busy: "text-primary bg-primary-soft border-primary-line",
    good: "text-success bg-success-soft border-success/30",
    attention: "text-amber bg-amber-soft border-amber/40",
    speaking: "text-primary bg-primary-soft border-primary-line",
  };

  function phaseInfo(phase) {
    return PHASES[phase] || PHASES.starting;
  }

  // The little animated pill shown inside a running call card.
  function phasePillHtml(phase, detail) {
    const p = phaseInfo(phase);
    const tone = TONE_CLASS[p.tone] || TONE_CLASS.busy;
    // Speaking gets equaliser bars; anything mid-flight gets a soft pulse dot.
    const indicator =
      p.tone === "speaking"
        ? `<span class="ua-bars" aria-hidden="true"><i></i><i></i><i></i></span>`
        : `<span class="ua-dot ${p.tone === "busy" ? "ua-dot-pulse" : ""}" aria-hidden="true"></span>`;
    const who = phase === "connected" && detail ? ` <span class="opacity-70">(${detail})</span>` : "";
    return `
      <div class="ua-phase inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${tone}" role="status" aria-live="polite">
        ${indicator}
        <span class="material-symbols-outlined text-[16px]">${p.icon}</span>
        <span>${p.label}${who}</span>
      </div>
      <p class="text-xs text-on-surface-variant mt-1.5">${p.hint}</p>`;
  }

  // Ordered checklist of the connection milestones, so "is it working?" has a
  // visible answer. Live conversation states all count as fully connected.
  const STEPS = [
    { key: "starting", label: "Assistant started" },
    { key: "in_meeting", label: "Joined the meeting" },
    { key: "connected", label: "Connected with you" },
  ];
  const REACHED = {
    starting: 0,
    waiting_room: 0,
    in_meeting: 1,
    connected: 2,
    thinking: 2,
    speaking: 2,
    listening: 2,
    ending: 2,
  };

  function phaseStepsHtml(phase) {
    const reached = REACHED[phase] ?? 0;
    return `<ol class="ua-steps mt-3 space-y-1.5">${STEPS.map((s, i) => {
      const done = i < reached;
      const active = i === reached;
      const icon = done ? "check_circle" : active ? "radio_button_checked" : "radio_button_unchecked";
      const cls = done ? "text-success" : active ? "text-primary" : "text-outline-variant";
      return `<li class="flex items-center gap-2 text-xs ${cls} ${active ? "ua-step-active font-semibold" : ""}">
        <span class="material-symbols-outlined text-[15px]">${icon}</span>${s.label}</li>`;
    }).join("")}</ol>`;
  }

  // Corner toast confirming a call was actually started. Pasting a link and
  // seeing nothing happen is what made this feel broken; a bot takes a few
  // seconds to appear in the meeting, and this covers that gap.
  let toastEl = null;
  let toastTimer = null;

  function showToast({ title, body, tone = "busy", timeout = 9000 } = {}) {
    hideToast();
    const p = TONE_CLASS[tone] || TONE_CLASS.busy;
    toastEl = document.createElement("div");
    toastEl.className = "ua-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    toastEl.innerHTML = `
      <div class="bg-white rounded-2xl border border-outline-variant/60 shadow-xl p-4 flex items-start gap-3">
        <div class="w-10 h-10 rounded-xl grid place-items-center border ${p} ua-ripple flex-none">
          <span class="material-symbols-outlined text-[20px]">support_agent</span>
        </div>
        <div class="min-w-0">
          <p class="font-semibold text-sm">${title}</p>
          <p class="text-xs text-on-surface-variant mt-0.5">${body}</p>
        </div>
        <button class="ua-toast-close text-on-surface-variant hover:text-on-surface flex-none" aria-label="Dismiss">
          <span class="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>`;
    toastEl.querySelector(".ua-toast-close").addEventListener("click", hideToast);
    document.body.appendChild(toastEl);
    if (timeout) toastTimer = setTimeout(hideToast, timeout);
  }

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    const el = toastEl;
    toastEl = null;
    if (!el) return;
    el.classList.add("ua-toast-out");
    setTimeout(() => el.remove(), 300);
  }

  // Banner for a call that failed to start. Shown on the idle card, because
  // by then the process is already gone and the card has reverted — without
  // this the failure is invisible.
  function failureHtml(failure) {
    if (!failure || !failure.reason) return "";
    return `
      <div class="ua-phase flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft text-danger px-3 py-2.5 mb-3 text-xs" role="alert">
        <span class="material-symbols-outlined text-[16px] flex-none">error</span>
        <span><strong class="font-semibold">UPSY couldn't join.</strong> ${failure.reason}</span>
      </div>`;
  }

  global.UpsyPhases = { phaseInfo, phasePillHtml, phaseStepsHtml, showToast, hideToast, failureHtml };
})(window);
