// The mobile surface at /m: starfield, scroll reveals, and the in-call sheet.
// Voice transport lives in frontend/voiceClient.js — this file is presentation
// and call lifecycle only.

(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Escape hatch for debugging the page without any animation running.
  const forceStatic = new URLSearchParams(location.search).has("static");
  const animate = !reduceMotion && !forceStatic;

  // ── Starfield ─────────────────────────────────────────────────────────────
  // Deliberately cheap: a phone rendering this behind a scrolling page has a
  // battery and a thermal budget. Capping DPR at 2 and halving the star count
  // on small screens are the two settings that actually decide whether this
  // stays at 60fps on a mid-range Android.
  function startSky() {
    const canvas = document.getElementById("sky");
    if (!canvas || !animate) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const isSmall = window.matchMedia("(max-width: 767px)").matches;
    let width = 0;
    let height = 0;
    let stars = [];

    function build() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const base = Math.round((width * height) / 5200);
      const count = isSmall ? Math.floor(base / 2) : base;
      stars = new Array(Math.max(40, Math.min(count, 220)));
      for (let i = 0; i < stars.length; i++) {
        // depth drives size, brightness AND drift speed together, which is what
        // reads as parallax without a second layer.
        const depth = Math.random();
        stars[i] = {
          x: Math.random() * width,
          y: Math.random() * height,
          r: 0.4 + depth * 1.5,
          a: 0.12 + depth * 0.55,
          vy: 0.02 + depth * 0.12,
          tw: Math.random() * Math.PI * 2,
          tws: 0.008 + Math.random() * 0.02,
        };
      }
    }

    let ready = false;
    let rafId = null;

    function frame() {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.y += s.vy;
        if (s.y > height + 2) { s.y = -2; s.x = Math.random() * width; }
        s.tw += s.tws;
        const alpha = s.a * (0.65 + 0.35 * Math.sin(s.tw));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(190, 230, 255," + alpha.toFixed(3) + ")";
        ctx.fill();
      }
      if (!ready) { ready = true; canvas.classList.add("is-ready"); }
      rafId = requestAnimationFrame(frame);
    }

    build();
    frame();

    let resizeTimer = null;
    window.addEventListener("resize", function () {
      // Mobile browsers fire resize on every address-bar collapse; rebuilding
      // the whole field each time would stutter the scroll.
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 200);
    });

    // Stop burning frames while the page is backgrounded or a call is open.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      } else if (!rafId) {
        frame();
      }
    });
  }

  // ── Scroll reveals ────────────────────────────────────────────────────────
  function startReveals() {
    const items = document.querySelectorAll(".reveal");
    const revealAll = function () {
      document.documentElement.classList.remove("reveal-ready");
      items.forEach(function (node) { node.classList.add("in"); });
    };

    // No animation wanted, or no observer to drive it: leave the copy exactly
    // as the HTML delivered it, fully visible.
    if (!animate || !("IntersectionObserver" in window)) return;

    // Arming the effect is what hides the copy — never the stylesheet alone.
    document.documentElement.classList.add("reveal-ready");

    let delivered = false;
    const io = new IntersectionObserver(function (entries) {
      delivered = true;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target); // reveal once, never re-hide on scroll back
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.15 });
    items.forEach(function (node) { io.observe(node); });

    // Last resort. Some environments create the observer happily and then
    // never call back — an invisible page is a far worse outcome than an
    // un-animated one, so give up on the effect rather than on the content.
    setTimeout(function () {
      if (!delivered) {
        io.disconnect();
        revealAll();
      }
    }, 1500);
  }

  // ── Call ──────────────────────────────────────────────────────────────────
  const el = {
    callBtn: document.getElementById("callBtn"),
    sheet: document.getElementById("sheet"),
    status: document.getElementById("sheetStatus"),
    error: document.getElementById("sheetError"),
    timer: document.getElementById("timer"),
    orb: document.getElementById("orb"),
    orbRing: document.getElementById("orbRing"),
    wave: document.getElementById("wave"),
    muteBtn: document.getElementById("muteBtn"),
    muteLabel: document.getElementById("muteLabel"),
    hangupBtn: document.getElementById("hangupBtn"),
  };

  let call = null;
  let timerId = null;
  let levelRaf = null;
  let waveCtx = null;
  let waveBars = [];
  let closing = false;

  const STATUS_TEXT = {
    connecting: "Connecting…",
    connected: "Listening — go ahead",
    ended: "Call ended",
    error: "Couldn't connect",
  };

  function setStatus(state, detail) {
    el.status.textContent = STATUS_TEXT[state] || detail || state;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
  }

  function openSheet() {
    closing = false;
    el.error.hidden = true;
    el.timer.hidden = true;
    el.timer.textContent = "0:00";
    el.sheet.classList.add("open");
    // A sheet, not a page — but Back is the reflex for "get me out of here" on
    // a phone, so give it a history entry to pop and treat that as hang up.
    history.pushState({ upsyCall: true }, "");
  }

  function closeSheet() {
    el.sheet.classList.remove("open");
    el.callBtn.disabled = false;
    if (history.state && history.state.upsyCall) {
      closing = true;
      history.back();
    }
  }

  function startTimer() {
    el.timer.hidden = false;
    clearInterval(timerId);
    timerId = setInterval(function () {
      if (!call) return;
      const s = call.elapsedSeconds();
      el.timer.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
  }

  function setupWave() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = el.wave.clientWidth || 280;
    const h = 46;
    el.wave.width = Math.floor(w * dpr);
    el.wave.height = Math.floor(h * dpr);
    waveCtx = el.wave.getContext("2d");
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    waveBars = new Array(28).fill(0);
  }

  // One loop drives the orb and the bars off the same two levels, so what the
  // caller sees always matches whether it is them or the agent making sound.
  function runLevels() {
    if (!call) return;
    const out = call.readOutputLevel();
    const inp = call.inputLevel;
    const level = Math.max(out, inp * 0.85);

    el.orb.style.transform = "scale(" + (1 + level * 0.28).toFixed(3) + ")";
    el.orbRing.style.transform = "scale(" + (1 + level * 0.13).toFixed(3) + ")";
    el.orbRing.style.opacity = (0.35 + level * 0.5).toFixed(2);

    if (waveCtx) {
      waveBars.shift();
      waveBars.push(level);
      const w = el.wave.clientWidth || 280;
      const h = 46;
      waveCtx.clearRect(0, 0, w, h);
      const gap = 3;
      const barW = (w - gap * (waveBars.length - 1)) / waveBars.length;
      for (let i = 0; i < waveBars.length; i++) {
        const v = waveBars[i];
        const barH = Math.max(2, v * h * 0.92);
        const x = i * (barW + gap);
        const y = (h - barH) / 2;
        // Newer samples (right edge) are brighter, so it reads as flowing.
        const alpha = 0.18 + (i / waveBars.length) * 0.55;
        waveCtx.fillStyle = "rgba(99, 216, 255," + alpha.toFixed(2) + ")";
        waveCtx.beginPath();
        waveCtx.roundRect ? waveCtx.roundRect(x, y, barW, barH, barW / 2) : waveCtx.rect(x, y, barW, barH);
        waveCtx.fill();
      }
    }
    levelRaf = requestAnimationFrame(runLevels);
  }

  function stopLevels() {
    if (levelRaf) cancelAnimationFrame(levelRaf);
    levelRaf = null;
  }

  async function endCall() {
    stopLevels();
    clearInterval(timerId);
    timerId = null;
    const active = call;
    call = null;
    if (active) {
      try {
        await active.stop();
      } catch (e) {
        // Teardown is best-effort; the sheet closes either way.
      }
    }
    closeSheet();
  }

  async function beginCall() {
    if (call) return;
    el.callBtn.disabled = true;
    openSheet();
    setStatus("connecting");
    setupWave();

    // Only present if this browser has signed in through /login in this tab —
    // written by frontend/app.js. Absent means an anonymous caller, which the
    // backend prompt handles as its own case rather than as an error.
    const leadId = sessionStorage.getItem("upsy_lead");

    try {
      const started = await window.UpsyVoice.start({
        leadId: leadId,
        onStatus: function (state, detail) {
          console.log("[voice] status:", state, detail || "");
          setStatus(state, detail);
          if (state === "connected") { startTimer(); runLevels(); }
          // "error" already shows a message via onError below and must stay on
          // screen — only a clean "ended" should close the sheet on its own.
          if (state === "ended" && call) endCall();
        },
        onError: function (message) {
          console.error("[voice] error:", message);
          stopLevels();
          clearInterval(timerId);
          showError(message);
          setStatus("error");
          el.callBtn.disabled = false;
        },
      });
      call = started.call;
      if (started.session.caller && started.session.caller.name) {
        el.status.textContent = "Connected — go ahead, " + started.session.caller.name.split(/\s+/)[0];
      }
    } catch (e) {
      showError(e && e.message ? e.message : "Couldn't start the call.");
      setStatus("error");
      stopLevels();
      // Leave the sheet open so the caller can read why it failed, but give
      // them the End button as the way out.
      el.callBtn.disabled = false;
    }
  }

  el.callBtn.addEventListener("click", beginCall);
  el.hangupBtn.addEventListener("click", endCall);

  el.muteBtn.addEventListener("click", function () {
    if (!call) return;
    const muted = call.setMuted(!call.muted);
    el.muteBtn.classList.toggle("on", muted);
    el.muteBtn.setAttribute("aria-pressed", String(muted));
    el.muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    el.muteLabel.textContent = muted ? "Unmute" : "Mute";
  });

  window.addEventListener("popstate", function () {
    // Ignore the pop we caused ourselves in closeSheet().
    if (closing) { closing = false; return; }
    if (call || el.sheet.classList.contains("open")) endCall();
  });

  // Never leave the microphone open on a page the caller has left — on a phone
  // that shows as a live recording indicator long after they think they hung up.
  window.addEventListener("pagehide", function () {
    if (call) call.stop();
  });

  startSky();
  startReveals();
})();
