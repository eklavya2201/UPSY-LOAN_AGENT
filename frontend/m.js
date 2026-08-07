// The mobile surface at /m — three states in one page: the pre-call brief, a
// connecting screen, and the call itself over a constellation of the things
// UPSY can actually talk about.
//
// Voice transport lives in frontend/voiceClient.js; this file is presentation
// and call lifecycle only. Deliberately plain script, no build step, matching
// the rest of frontend/.

(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Escape hatch for looking at the layout with nothing moving.
  const forceStatic = new URLSearchParams(location.search).has("static");
  const animate = !reduceMotion && !forceStatic;

  const $ = (id) => document.getElementById(id);

  const el = {
    views: { auth: $("viewAuth"), brief: $("viewBrief"), connecting: $("viewConnecting"), call: $("viewCall") },
    authTitle: $("authTitle"),
    authSub: $("authSub"),
    tabLogin: $("tabLogin"),
    tabSignup: $("tabSignup"),
    authNameField: $("authNameField"),
    authName: $("authName"),
    authPhone: $("authPhone"),
    authPassword: $("authPassword"),
    authWhy: $("authWhy"),
    authMsg: $("authMsg"),
    authSubmit: $("authSubmit"),
    skipAuth: $("skipAuth"),
    accountRow: $("accountRow"),
    briefSub: $("briefSub"),
    briefMsg: $("briefMsg"),
    devices: $("devices"),
    micSelect: $("micSelect"),
    spkWrap: $("spkWrap"),
    spkSelect: $("spkSelect"),
    permBtn: $("permBtn"),
    joinBtn: $("joinBtn"),
    scheduleBtn: $("scheduleBtn"),
    map: $("map"),
    focus: $("focus"),
    focusTitle: $("focusTitle"),
    focusDesc: $("focusDesc"),
    timer: $("timer"),
    callStatus: $("callStatus"),
    callError: $("callError"),
    muteBtn: $("muteBtn"),
    hangupBtn: $("hangupBtn"),
    sheet: $("scheduleSheet"),
    scheduleForm: $("scheduleForm"),
    scheduleDone: $("scheduleDone"),
    scheduleDoneLine: $("scheduleDoneLine"),
    cbName: $("cbName"),
    cbPhone: $("cbPhone"),
    cbWhen: $("cbWhen"),
    cbMsg: $("cbMsg"),
    cbSubmit: $("cbSubmit"),
    cbCancel: $("cbCancel"),
    cbClose: $("cbClose"),
  };

  // Only present if this browser signed in through /login in this tab — written
  // by frontend/app.js. Absent means an anonymous caller, which the backend
  // prompt handles as its own case rather than as an error.
  const leadId = sessionStorage.getItem("upsy_lead");

  function showView(name) {
    Object.keys(el.views).forEach((k) => el.views[k].classList.toggle("on", k === name));
  }

  // ── The account ───────────────────────────────────────────────────────────
  // /m's own sign-in, separate from the phone lookup behind /login. It exists
  // for one reason: a call that is not attached to anything teaches us nothing
  // and leaves the caller starting from scratch every time.
  //
  // localStorage, not sessionStorage — the whole point is the person who calls
  // again next week, and sessionStorage dies with the tab. The token is a
  // server-side session id and carries nothing readable on its own.
  const TOKEN_KEY = "upsy_m_token";

  let account = null;
  let authMode = "login";

  function storedToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      // Private mode in some browsers throws on access rather than returning
      // null. That downgrades the caller to anonymous, which is a working path.
      return null;
    }
  }

  function keepToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* see storedToken */
    }
  }

  async function api(path, options) {
    const opts = options || {};
    const token = storedToken();
    const headers = {};
    if (opts.body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  // What the brief says about who is signed in — and, when nobody is, an
  // unpushy way back to the sign-in screen for someone who skipped it.
  function renderAccountRow() {
    el.accountRow.innerHTML = "";
    if (account) {
      const who = document.createElement("span");
      who.textContent = "Signed in as " + account.name.split(/\s+/)[0];
      const dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      dot.textContent = "·";
      const out = document.createElement("button");
      out.className = "linkish";
      out.type = "button";
      out.textContent = "Sign out";
      out.addEventListener("click", signOut);
      el.accountRow.append(who, dot, out);
    } else {
      const link = document.createElement("button");
      link.className = "linkish";
      link.type = "button";
      link.textContent = "Sign in so UPSY remembers this";
      link.addEventListener("click", function () {
        setAuthMode("login");
        showView("auth");
      });
      el.accountRow.appendChild(link);
    }
    el.accountRow.hidden = false;
  }

  function applyAccount(next) {
    account = next || null;
    if (account) {
      const first = account.name.split(/\s+/)[0];
      el.briefSub.textContent = account.callCount
        ? "Welcome back, " + first + " — I still have everything from last time."
        : "Hi " + first + " — ask me anything about funding your studies.";
    }
    renderAccountRow();
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "login";
    const isSignup = authMode === "signup";
    el.tabLogin.setAttribute("aria-selected", String(!isSignup));
    el.tabSignup.setAttribute("aria-selected", String(isSignup));
    el.authNameField.hidden = !isSignup;
    el.authSubmit.textContent = isSignup ? "Create account" : "Log in";
    el.authTitle.innerHTML = isSignup ? "Talk to UPSY,<br/>and be remembered" : "Pick up where<br/>you left off";
    el.authSub.textContent = isSignup
      ? "One account, so every call builds on the last one instead of starting over."
      : "Sign in so UPSY remembers this conversation the next time you call.";
    // Tell the password manager which kind of field this is, or it offers to
    // save a login as a new password and vice versa.
    el.authPassword.setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
    el.authPassword.setAttribute("placeholder", isSignup ? "At least 8 characters" : "Your password");
    el.authMsg.textContent = "";
  }

  async function submitAuth() {
    const phone = el.authPhone.value.trim();
    const password = el.authPassword.value;
    const name = el.authName.value.trim();

    // Checked here as well as on the server so the common mistakes cost no
    // round trip — the server remains the authority, this is only courtesy.
    if (authMode === "signup" && name.length < 2) {
      el.authMsg.textContent = "Please tell us your name.";
      el.authName.focus();
      return;
    }
    if (!phone) {
      el.authMsg.textContent = "Enter your mobile number.";
      el.authPhone.focus();
      return;
    }
    if (!password) {
      el.authMsg.textContent = "Enter your password.";
      el.authPassword.focus();
      return;
    }

    el.authMsg.textContent = "";
    el.authSubmit.disabled = true;
    const label = el.authSubmit.textContent;
    el.authSubmit.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
    try {
      const res = await api(authMode === "signup" ? "/api/m/signup" : "/api/m/login", {
        method: "POST",
        body: authMode === "signup" ? { name: name, phone: phone, password: password } : { phone: phone, password: password },
      });
      if (!res.ok) {
        el.authMsg.textContent = res.data.error || "That didn't work. Please try again.";
        // A number that already has an account is not really a failure — it is
        // the wrong tab. Move them rather than making them find it.
        if (res.status === 409) setAuthMode("login");
        return;
      }
      keepToken(res.data.token);
      // Clear the password from the DOM the moment it is no longer needed. It
      // is already out of our hands, but a filled password field left behind a
      // hung-up call is an avoidable thing to leave on a shared phone.
      el.authPassword.value = "";
      applyAccount(res.data.account);
      showView("brief");
    } catch (e) {
      el.authMsg.textContent = "Couldn't reach UPSY just now. Check your connection and try again.";
    } finally {
      el.authSubmit.disabled = false;
      el.authSubmit.textContent = label;
    }
  }

  async function signOut() {
    api("/api/m/logout", { method: "POST" }).catch(function () {
      // The local token is dropped either way — a caller tapping Sign out must
      // end up signed out even if the network does not cooperate.
    });
    keepToken(null);
    account = null;
    el.briefSub.textContent = "I'll help you work out what you can borrow and what you'll need to get there.";
    setAuthMode("login");
    el.authPhone.value = "";
    el.authPassword.value = "";
    showView("auth");
  }

  // Decide the first screen synchronously from whether a token exists at all,
  // then confirm with the server in the background. Waiting for /api/m/me
  // before showing anything would put a blank frame in front of every caller;
  // showing the sign-in screen first would make a returning caller watch it
  // flash past. A token that turns out to be dead bounces back here.
  async function bootAccount() {
    if (!storedToken()) {
      setAuthMode("login");
      showView("auth");
      return;
    }
    showView("brief");
    renderAccountRow();
    const res = await api("/api/m/me").catch(function () {
      return { ok: false, status: 0, data: {} };
    });
    if (res.ok) {
      applyAccount(res.data.account);
      return;
    }
    // 401 means the session really is gone (expired, or signed out elsewhere).
    // Any other failure is the network, and the caller keeps the brief — being
    // offline should not lock someone out of a page they were already on.
    if (res.status === 401) {
      keepToken(null);
      setAuthMode("login");
      showView("auth");
    }
  }

  // ── The constellation ─────────────────────────────────────────────────────
  // A map of what UPSY can talk about, not a transcript. That distinction is
  // deliberate and load-bearing: we get audio frames from the provider, not a
  // running transcript, so the page cannot honestly claim to know which topic
  // is being discussed right now. The nodes are therefore phrased as things you
  // can ask about, and the spotlight moves on its own as an invitation.
  //
  // If a real transcript event ever shows up (see onEvent below), matchTopic()
  // upgrades this from an invitation to an actual reflection of the call — the
  // first live call will tell us whether that event exists.
  const TOPICS = [
    { key: "amount", label: "How much you can borrow", desc: "Your course, your co-applicant's income, and a realistic number", match: /borrow|amount|lakh|crore|how much|eligib|income|salary/i },
    { key: "docs", label: "What you'll need", desc: "The documents a lender actually asks for, in the order they ask", match: /document|paper|pan|aadhaar|marksheet|admit|statement|upload/i },
    { key: "cost", label: "What it will cost", desc: "Indicative EMI, the interest rate, and the moratorium while you study", match: /emi|cost|interest|rate|repay|month|tenure/i },
    { key: "coapp", label: "Your co-applicant", desc: "Who can co-sign, and whose income actually counts", match: /co.?applicant|co.?borrow|father|mother|parent|spouse|guarantor/i },
    { key: "secured", label: "Secured or unsecured", desc: "Whether putting up collateral changes what you're offered", match: /secur|collateral|property|fd|deposit/i },
    { key: "next", label: "What happens next", desc: "How this call turns into a real application", match: /next|apply|start|process|after|lender|bank/i },
  ];

  const map = {
    nodes: [],
    cam: { x: 0, y: 0, scale: 1 },
    target: { x: 0, y: 0, scale: 1 },
    focusIdx: -1,
    stars: [],
    raf: null,
    t: 0,
  };

  function buildMap() {
    // Hand-placed rather than an even ring: a perfect circle reads as a chart,
    // an irregular scatter reads as a constellation.
    const seats = [
      [0.02, -0.86], [0.82, -0.42], [0.88, 0.34],
      [0.06, 0.84], [-0.85, 0.44], [-0.82, -0.38],
    ];
    map.nodes = [{ key: "you", label: "You", desc: "", x: 0, y: 0, hub: true }].concat(
      TOPICS.map((t, i) => ({
        ...t,
        x: seats[i % seats.length][0],
        y: seats[i % seats.length][1],
        // Per-node phase so they twinkle out of step with each other.
        phase: Math.random() * Math.PI * 2,
      }))
    );

    const n = window.matchMedia("(max-width: 767px)").matches ? 70 : 130;
    map.stars = new Array(n);
    for (let i = 0; i < n; i++) {
      map.stars[i] = {
        x: (Math.random() - 0.5) * 3.4,
        y: (Math.random() - 0.5) * 3.4,
        r: 0.3 + Math.random() * 1.1,
        a: 0.1 + Math.random() * 0.45,
        phase: Math.random() * Math.PI * 2,
      };
    }
  }

  function focusTopic(idx) {
    map.focusIdx = idx;
    if (idx < 0) {
      map.target = { x: 0, y: 0, scale: 1 };
      el.focus.classList.remove("on");
      return;
    }
    const node = map.nodes[idx];
    // Pull the focused node up and left of centre so the big DOM caption below
    // it has room — the caption is what the caller actually reads.
    map.target = { x: node.x + 0.16, y: node.y + 0.42, scale: 2.15 };
    el.focusTitle.textContent = node.label;
    el.focusDesc.textContent = node.desc;
    el.focus.classList.add("on");
  }

  // Set up once; startMap()/stopMap() only control the loop. Doing the setup
  // per start would stack a resize listener and a second rAF loop every time
  // the tab came back to the foreground.
  function drawMap() {
    const canvas = el.map;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;

    function size() {
      // The call view is display:none until the call connects, so at load this
      // element measures 0×0. A ResizeObserver is what catches the moment it
      // gains a real size — without it the backing store keeps the fallback
      // dimensions and the whole map renders stretched.
      w = canvas.clientWidth || 380;
      h = canvas.clientHeight || 700;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener("resize", size);
    if (window.ResizeObserver) new ResizeObserver(size).observe(canvas);

    function project(x, y) {
      // One unit ≈ 38% of the smaller screen dimension, so the map keeps its
      // shape on a tall phone and a short landscape one alike.
      const unit = Math.min(w, h) * 0.38;
      return [
        w / 2 + (x - map.cam.x) * unit * map.cam.scale,
        h / 2 + (y - map.cam.y) * unit * map.cam.scale,
      ];
    }

    function frame() {
      map.t += 0.016;

      // Ease the camera rather than jumping. 0.045 is slow enough to read as a
      // drift toward the topic rather than a cut.
      const k = animate ? 0.045 : 1;
      map.cam.x += (map.target.x - map.cam.x) * k;
      map.cam.y += (map.target.y - map.cam.y) * k;
      map.cam.scale += (map.target.scale - map.cam.scale) * k;

      ctx.clearRect(0, 0, w, h);

      // Stars, parallaxed at half the camera's rate so they sit "behind".
      for (let i = 0; i < map.stars.length; i++) {
        const s = map.stars[i];
        const unit = Math.min(w, h) * 0.38;
        const px = w / 2 + (s.x - map.cam.x * 0.5) * unit * (1 + (map.cam.scale - 1) * 0.35);
        const py = h / 2 + (s.y - map.cam.y * 0.5) * unit * (1 + (map.cam.scale - 1) * 0.35);
        if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
        const tw = animate ? 0.7 + 0.3 * Math.sin(map.t * 1.4 + s.phase) : 1;
        ctx.beginPath();
        ctx.arc(px, py, s.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(198, 226, 246," + (s.a * tw).toFixed(3) + ")";
        ctx.fill();
      }

      const hub = project(map.nodes[0].x, map.nodes[0].y);

      // Links from the hub outward.
      for (let i = 1; i < map.nodes.length; i++) {
        const p = project(map.nodes[i].x, map.nodes[i].y);
        const focused = map.focusIdx === i;
        ctx.beginPath();
        ctx.moveTo(hub[0], hub[1]);
        ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = focused ? "rgba(134, 196, 232, 0.5)" : "rgba(114, 170, 208, 0.16)";
        ctx.lineWidth = focused ? 1.3 : 0.8;
        ctx.stroke();
      }

      // Nodes.
      for (let i = 0; i < map.nodes.length; i++) {
        const node = map.nodes[i];
        const p = project(node.x, node.y);
        const focused = map.focusIdx === i;
        const dim = map.focusIdx >= 0 && !focused && !node.hub;

        const pulse = animate && !node.hub ? 0.85 + 0.15 * Math.sin(map.t * 1.1 + (node.phase || 0)) : 1;
        const r = (node.hub ? 4.5 : 3.4) * (focused ? 1.9 : 1) * pulse;

        // Glow first, dot on top — a flat dot reads as a bullet point, the
        // glow is what makes it a star.
        const glow = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 6);
        const strength = focused ? 0.55 : dim ? 0.08 : 0.25;
        glow.addColorStop(0, "rgba(150, 208, 246," + strength + ")");
        glow.addColorStop(1, "rgba(150, 208, 246, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fillStyle = focused
          ? "rgba(244, 251, 255, 0.98)"
          : dim ? "rgba(226, 240, 250, 0.32)" : "rgba(232, 242, 250, 0.85)";
        ctx.fill();

        // The focused node's caption is DOM (see .focus), so skip it here and
        // never draw the same words twice.
        if (focused) continue;

        const alpha = dim ? 0.28 : node.hub ? 0.9 : 0.66;
        ctx.font = (node.hub ? "600 13px " : "500 12px ") + "Hind, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(226, 240, 250," + alpha + ")";
        ctx.fillText(node.label, p[0], p[1] + r + 9);
      }

      map.raf = requestAnimationFrame(frame);
    }

    // Set up, but do not start: the map is only on screen during a call, and a
    // canvas loop running behind the brief screen is battery spent on nothing.
    // start() re-measures first — the ResizeObserver above is a convenience for
    // orientation changes, not something correctness may depend on, since its
    // callbacks are tied to the rendering steps and a browser that is not
    // compositing (backgrounded tab, hidden pane) never delivers them.
    map.start = function () {
      size();
      if (!map.raf) frame();
    };
  }

  function stopMap() {
    if (map.raf) cancelAnimationFrame(map.raf);
    map.raf = null;
  }

  // Rotate the spotlight while the call runs. Slow — it is ambient, and a
  // caller mid-sentence should not feel the screen hurrying them.
  let rotateId = null;
  function startRotation() {
    let i = 0;
    focusTopic(-1);
    clearInterval(rotateId);
    rotateId = setInterval(function () {
      i = (i % TOPICS.length) + 1;
      focusTopic(i);
    }, 7000);
    // First move comes sooner than the interval, so the screen does something
    // while the agent is saying hello.
    setTimeout(function () { if (rotateId) focusTopic(1); }, 2200);
  }
  function stopRotation() {
    clearInterval(rotateId);
    rotateId = null;
  }

  // If the provider ever sends us text, spotlight what is actually being said
  // instead of the rotation. Nothing depends on this working.
  // Paint the frame's rim to match what the agent is doing. Unknown states are
  // dropped rather than rendered, so the server can add one later without this
  // page showing a rim with no styling behind it.
  var VOICE_STATES = { listening: 1, thinking: 1, speaking: 1 };
  function setVoiceState(state) {
    var frameEl = document.getElementById("frame");
    if (!frameEl) return;
    if (state && VOICE_STATES[state]) frameEl.setAttribute("data-voice", state);
    else frameEl.removeAttribute("data-voice");
  }

  function matchTopic(text) {
    if (!text) return;
    for (let i = 0; i < TOPICS.length; i++) {
      if (TOPICS[i].match.test(text)) {
        stopRotation();
        focusTopic(i + 1);
        // Fall back to the ambient rotation if the talk moves on to something
        // none of the topics cover.
        clearTimeout(matchTopic._idle);
        matchTopic._idle = setTimeout(startRotation, 15000);
        return;
      }
    }
  }

  // ── Devices ───────────────────────────────────────────────────────────────
  let permissionGranted = false;

  function fillSelect(select, devices, kind) {
    select.innerHTML = "";
    devices
      .filter((d) => d.kind === kind)
      .forEach(function (d, i) {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || (kind === "audioinput" ? "Microphone " + (i + 1) : "Speaker " + (i + 1));
        select.appendChild(opt);
      });
    return select.options.length;
  }

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = fillSelect(el.micSelect, devices, "audioinput");
    const spks = fillSelect(el.spkSelect, devices, "audiooutput");
    el.devices.hidden = mics === 0;
    // Safari and Firefox do not expose output devices at all; showing an empty
    // picker would be worse than showing none.
    el.spkWrap.hidden = spks === 0;
  }

  async function requestPermission() {
    el.briefMsg.textContent = "";
    el.permBtn.disabled = true;
    try {
      // Requesting and immediately releasing: the point here is only to unlock
      // device labels and get the OS prompt out of the way before the call. The
      // real capture stream is opened by voiceClient.js inside the Join tap,
      // which is what iOS needs to allow audio playback.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      permissionGranted = true;
      await listDevices();
      el.permBtn.hidden = true;
      el.joinBtn.hidden = false;
      el.joinBtn.focus({ preventScroll: true });
    } catch (e) {
      el.briefMsg.textContent =
        e && e.name === "NotAllowedError"
          ? "UPSY needs your microphone to talk to you. Allow it in your browser settings, then tap again."
          : e && e.name === "NotFoundError"
            ? "No microphone was found on this device. You can ask us to call you instead."
            : "Couldn't get to your microphone. You can ask us to call you instead.";
    } finally {
      el.permBtn.disabled = false;
    }
  }

  // ── Call lifecycle ────────────────────────────────────────────────────────
  let call = null;
  let timerId = null;
  let closingSelf = false;

  const STATUS_TEXT = {
    connecting: "Connecting…",
    connected: "Listening — go ahead",
    ended: "Call ended",
    error: "Couldn't connect",
  };

  function startTimer() {
    clearInterval(timerId);
    timerId = setInterval(function () {
      if (!call) return;
      const s = call.elapsedSeconds();
      el.timer.textContent =
        String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
  }

  async function beginCall() {
    if (call) return;
    el.joinBtn.disabled = true;
    el.callError.hidden = true;
    el.callStatus.textContent = "";
    el.timer.textContent = "00:00";
    showView("connecting");
    // A view, not a route — but Back is the reflex for "get me out of here" on
    // a phone, so give it a history entry to pop and treat that as hang up.
    history.pushState({ upsyCall: true }, "");

    try {
      const started = await window.UpsyVoice.start({
        leadId: leadId,
        // The server reads the caller's account from this and files the call
        // against it. Absent for someone who skipped sign-in, which is a
        // supported call, just not a remembered one.
        authToken: storedToken(),
        deviceId: el.micSelect.value || null,
        sinkId: el.spkWrap.hidden ? null : el.spkSelect.value || null,
        onStatus: function (state, detail) {
          console.log("[voice] status:", state, detail || "");
          el.callStatus.textContent = STATUS_TEXT[state] || detail || state;
          if (state === "connected") {
            showView("call");
            if (map.start) map.start();
            startTimer();
            startRotation();
          }
          // "error" keeps its message on screen and must not close the view —
          // only a clean "ended" ends the call by itself.
          if (state === "ended" && call) endCall();
        },
        onError: function (message) {
          console.error("[voice] error:", message);
          showView("call");
          stopRotation();
          focusTopic(-1);
          clearInterval(timerId);
          el.callError.textContent = message;
          el.callError.hidden = false;
          el.callStatus.textContent = STATUS_TEXT.error;
        },
        onEvent: function (msg) {
          // The relay tells us what it is doing — listening / thinking /
          // speaking — and the frame's rim light shows it. This is the one
          // thing the hosted agent could never give us: it sent audio and
          // nothing else, so the page had to guess. Now it doesn't.
          if (msg && msg.event === "state" && typeof msg.state === "string") {
            setVoiceState(msg.state);
            return;
          }
          // The provider's event vocabulary is not fully confirmed against a
          // live call yet. Pick up anything that looks like text and let it
          // drive the spotlight; ignore everything else.
          const text = msg && (msg.text || msg.transcript || (msg.data && msg.data.text));
          if (typeof text === "string") matchTopic(text);
        },
      });
      call = started.call;
      const name = started.session.caller && started.session.caller.name;
      if (name) {
        el.callStatus.textContent = "Listening — go ahead, " + name.split(/\s+/)[0];
      }
    } catch (e) {
      showView("call");
      el.callError.textContent = (e && e.message) || "Couldn't start the call.";
      el.callError.hidden = false;
      el.callStatus.textContent = STATUS_TEXT.error;
    } finally {
      el.joinBtn.disabled = false;
    }
  }

  async function endCall() {
    stopRotation();
    focusTopic(-1);
    stopMap();
    setVoiceState(null); // the rim must not keep breathing over a dead call
    clearInterval(timerId);
    timerId = null;
    const active = call;
    call = null;
    if (active) {
      try {
        await active.stop();
      } catch (e) {
        // Teardown is best-effort; the view returns either way.
      }
    }
    showView("brief");
    el.joinBtn.disabled = false;
    if (history.state && history.state.upsyCall) {
      closingSelf = true;
      history.back();
    }
  }

  // ── Schedule a callback ───────────────────────────────────────────────────
  function openSchedule() {
    el.sheet.hidden = false;
    // Force a reflow so the transition has a start state to animate from.
    // Deliberately not requestAnimationFrame: rAF does not fire in a tab that
    // is not compositing, and the sheet would then never become visible at all.
    void el.sheet.offsetHeight;
    el.sheet.classList.add("open");
    el.cbMsg.textContent = "";
    // A signed-in caller has already told us both of these once. Asking again
    // is the thing an account is supposed to stop.
    if (account) {
      if (!el.cbName.value) el.cbName.value = account.name;
      if (!el.cbPhone.value) el.cbPhone.value = account.phone;
    }
    setTimeout(function () {
      // Land on the first field they still have to fill.
      (account ? el.cbWhen : el.cbName).focus({ preventScroll: true });
    }, 260);
  }

  function closeSchedule() {
    el.sheet.classList.remove("open");
    setTimeout(function () {
      el.sheet.hidden = true;
      // Reset for a second request in the same session.
      el.scheduleForm.hidden = false;
      el.scheduleDone.hidden = true;
    }, 300);
  }

  async function submitCallback() {
    const name = el.cbName.value.trim();
    const phone = el.cbPhone.value.trim();
    if (!name) { el.cbMsg.textContent = "Please tell us your name."; el.cbName.focus(); return; }
    if (!phone) { el.cbMsg.textContent = "Please add a mobile number."; el.cbPhone.focus(); return; }

    el.cbMsg.textContent = "";
    el.cbSubmit.disabled = true;
    el.cbSubmit.textContent = "Sending…";
    try {
      const res = await fetch("/api/voice/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          phone: phone,
          whenText: el.cbWhen.value.trim(),
          leadId: leadId || null,
          // Context for whoever picks this up, so they are not calling blind.
          topic: "Requested from the /m voice page",
        }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        el.cbMsg.textContent = data.error || "That didn't go through. Please try again.";
        return;
      }
      const when = el.cbWhen.value.trim();
      el.scheduleDoneLine.textContent =
        "Someone from UPSY will call you on " + (data.phone || phone) +
        (when ? " — we've noted " + when.toLowerCase() + "." : ".");
      el.scheduleForm.hidden = true;
      el.scheduleDone.hidden = false;
    } catch (e) {
      el.cbMsg.textContent = "Couldn't reach us just now. Check your connection and try again.";
    } finally {
      el.cbSubmit.disabled = false;
      el.cbSubmit.textContent = "Request a callback";
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  el.tabLogin.addEventListener("click", function () { setAuthMode("login"); });
  el.tabSignup.addEventListener("click", function () { setAuthMode("signup"); });
  el.authSubmit.addEventListener("click", submitAuth);
  el.skipAuth.addEventListener("click", function () {
    // Deliberately does not remember the choice. Someone who skips today and
    // has a useful call is exactly the person worth inviting again tomorrow,
    // and the invitation on the brief is where that happens.
    showView("brief");
    renderAccountRow();
  });
  // Enter anywhere in the form submits it — on a phone keyboard the Go key is
  // where the thumb already is, and hunting for the button below the fold is
  // the kind of small friction that ends a sign-up.
  [el.authName, el.authPhone, el.authPassword].forEach(function (input) {
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitAuth(); }
    });
  });

  el.permBtn.addEventListener("click", requestPermission);
  el.joinBtn.addEventListener("click", beginCall);
  el.hangupBtn.addEventListener("click", endCall);
  el.scheduleBtn.addEventListener("click", openSchedule);
  el.cbCancel.addEventListener("click", closeSchedule);
  el.cbClose.addEventListener("click", closeSchedule);
  el.cbSubmit.addEventListener("click", submitCallback);

  el.muteBtn.addEventListener("click", function () {
    if (!call) return;
    const muted = call.setMuted(!call.muted);
    el.muteBtn.classList.toggle("on", muted);
    el.muteBtn.setAttribute("aria-pressed", String(muted));
    el.muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    el.callStatus.textContent = muted ? "Microphone off" : STATUS_TEXT.connected;
  });

  window.addEventListener("popstate", function () {
    if (closingSelf) { closingSelf = false; return; }
    if (call || el.views.call.classList.contains("on") || el.views.connecting.classList.contains("on")) {
      endCall();
    }
  });

  // Never leave the microphone open on a page the caller has left — on a phone
  // that shows as a live recording indicator long after they think they hung up.
  window.addEventListener("pagehide", function () {
    if (call) call.stop();
  });

  // Devices can be plugged in or removed while the brief is on screen.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", function () {
      if (permissionGranted) listDevices();
    });
  }

  // Greet a caller who signed in through /login in this tab — one round trip
  // already told app.js who they are. An /m account, if there is one, overrides
  // this a moment later in bootAccount(): it is the identity this page owns and
  // the one the call is actually filed against.
  const knownName = sessionStorage.getItem("upsy_name");
  if (knownName) {
    el.briefSub.textContent =
      "Hi " + knownName.split(/\s+/)[0] + " — I have your application open. Ask me anything about it.";
  }

  buildMap();
  drawMap();
  bootAccount();

  // Stop burning frames while the page is backgrounded, and only resume if a
  // call is actually on screen.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopMap();
    else if (map.start && el.views.call.classList.contains("on")) map.start();
  });
})();
