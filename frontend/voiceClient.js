// Browser voice call transport: microphone → WebSocket → speaker.
//
// The entire "call" is this file plus a socket. There is no meeting platform,
// no bot, no peer connection — the phone's own browser streams raw PCM to the
// voice provider and plays the reply back. Speech-to-text, the language model,
// text-to-speech and turn-taking all happen on the provider's side; nothing
// here decides anything, which is why swapping providers later (Sarvam for
// Hindi) does not touch this file.
//
// Deliberately provider-agnostic and dependency-free, in the same plain-script
// style as the rest of frontend/ (no build step, no modules).

(function (global) {
  // Must match INPUT_FORMAT / SAMPLE_RATE in backend/voiceCall.js.
  const SAMPLE_RATE = 44100;
  // Frames per chunk. ~46ms at 44.1kHz — small enough that barge-in feels
  // immediate, large enough that we are not sending hundreds of tiny frames a
  // second over a phone's mobile data connection.
  const FRAME_SIZE = 2048;

  // The capture worklet runs on the audio thread and does nothing but fill a
  // fixed buffer and hand it over. Kept dumb on purpose: any work here is work
  // done in the real-time audio callback, where overruns become dropouts.
  const WORKLET_SOURCE = `
class UpsyCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(${FRAME_SIZE});
    this._offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const space = this._buffer.length - this._offset;
      const take = Math.min(space, channel.length - read);
      this._buffer.set(channel.subarray(read, read + take), this._offset);
      this._offset += take;
      read += take;
      if (this._offset === this._buffer.length) {
        const out = this._buffer;
        this._buffer = new Float32Array(${FRAME_SIZE});
        this._offset = 0;
        // Transferred, not copied — this runs ~21 times a second.
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("upsy-capture-processor", UpsyCaptureProcessor);
`;

  function floatToPcm16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      // Asymmetric on purpose: Int16 range is -32768..32767, so scaling both
      // directions by 32767 would clip quiet negatives slightly differently.
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return out;
  }

  // Linear resample. Only runs when the browser refuses the sample rate we
  // asked for — Safari on iOS in particular often hands back a 48kHz context
  // regardless of what was requested, and sending 48kHz audio labelled as
  // 44.1kHz makes the caller sound slow and deep to the speech recogniser.
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const length = Math.round(input.length / ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  function pcm16ToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    // Chunked because String.fromCharCode.apply on a whole frame can blow the
    // argument limit on some engines.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToPcm16(b64) {
    const binary = atob(b64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(buffer);
  }

  class VoiceCall {
    constructor(options) {
      this.options = options || {};
      this.status = "idle";
      this.ws = null;
      this.streamId = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : "upsy-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      this.mediaStream = null;
      this.captureContext = null;
      this.captureSource = null;
      this.captureWorklet = null;
      this.workletUrl = null;
      this.playbackContext = null;
      this.playbackQueueTime = 0;
      this.scheduledSources = new Set();
      this.muted = false;
      this.startedAt = null;
      // Whether the agent ever actually spoke. Distinguishes "the caller hung
      // up" from "the connection died before anything happened".
      this.receivedAudio = false;
      this.closeCode = null;
      this.closeReason = null;
      // Live signal levels for the waveform UI: 0..1.
      this.inputLevel = 0;
      this.outputLevel = 0;
      this.outputAnalyser = null;
      this._analyserBuf = null;
    }

    setStatus(next, detail) {
      if (this.status === next) return;
      this.status = next;
      if (this.options.onStatus) this.options.onStatus(next, detail || null);
    }

    fail(message) {
      if (this.options.onError) this.options.onError(message);
      this.setStatus("error", message);
      // A failure at any point — before or after the call connected — must
      // release the microphone and close the socket. Only the pre-connection
      // path (start()'s catch block) did this before; a later in-band error
      // or an unexpected close left the mic indicator on with nothing telling
      // the caller their call was actually over.
      this.stop().catch(() => {});
    }

    async start() {
      this.setStatus("connecting");
      try {
        // Ask for the microphone FIRST. On a phone this shows a permission
        // sheet, and doing it before opening the socket means a caller who
        // declines never burns a session token — and, more importantly, that
        // the whole chain still sits inside the tap that started it, which is
        // what iOS requires to let audio play at all.
        await this.startCapture();
        await this.openSocket();
        this.startedAt = Date.now();
      } catch (e) {
        const message = e && e.message ? e.message : "The call could not be started.";
        this.fail(this.friendlyError(message, e));
        await this.stop();
        throw e;
      }
    }

    // Turn a WebSocket close into something actionable. The codes below are the
    // ones that actually happen with a hosted voice agent; anything else falls
    // through with its raw code so it can at least be reported accurately.
    explainClose(event, wasOpen) {
      const reason = (event.reason || "").trim();
      const raw = reason ? `${event.code}: ${reason}` : `code ${event.code}`;

      if (/not.*publish|unpublish|not.*found|no.*agent|draft/i.test(reason)) {
        return "The voice agent isn't published yet. Open it in the Cartesia dashboard and press Publish, then try again.";
      }
      if (event.code === 1008 || /unauth|forbidden|token|expired|invalid/i.test(reason)) {
        return "The voice service rejected our credentials. The access token may have expired — try the call again.";
      }
      // 1011 is the provider's catch-all, and it is what an *undeployed* agent
      // returns — confirmed 2026-08-07, after this exact close code sent a
      // debugging session through the whole audio path before anyone looked at
      // the account. The server now preflights for that case (see
      // checkAgentReady in backend/voiceCall.js), so by the time a caller gets
      // here it is genuinely the provider having a bad moment.
      if (event.code === 1011 || /internal|server error/i.test(reason)) {
        return `The voice service hit an error on its side (${raw}). Try again in a moment — if it keeps happening, run npm run voice:check.`;
      }
      if (/credit|quota|billing|limit/i.test(reason)) {
        return "The voice account is out of credit, so calls cannot connect right now.";
      }
      if (wasOpen) {
        return `The call ended before it started (${raw}). If this repeats, check the agent is published in the Cartesia dashboard.`;
      }
      return `Could not connect to the voice service (${raw}).`;
    }

    friendlyError(message, e) {
      const name = e && e.name;
      if (name === "NotAllowedError" || /permission/i.test(message)) {
        return "UPSY needs microphone access to talk to you. Allow the microphone and tap Call again.";
      }
      if (name === "NotFoundError") {
        return "No microphone was found on this device.";
      }
      if (name === "NotReadableError") {
        return "Your microphone is being used by another app. Close it and try again.";
      }
      return message;
    }

    async startCapture() {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // All three matter far more on a phone held to a face in a noisy
          // room than on a laptop: without echo cancellation the agent hears
          // its own voice through the speaker and interrupts itself.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const Ctx = global.AudioContext || global.webkitAudioContext;
      this.captureContext = new Ctx({ sampleRate: SAMPLE_RATE });
      this.playbackContext = new Ctx({ sampleRate: SAMPLE_RATE });
      // iOS hands back suspended contexts even inside a gesture; without this
      // the caller hears nothing and there is no error to explain why.
      if (this.captureContext.state === "suspended") await this.captureContext.resume();
      if (this.playbackContext.state === "suspended") await this.playbackContext.resume();
      this.playbackQueueTime = this.playbackContext.currentTime;

      this.outputAnalyser = this.playbackContext.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.connect(this.playbackContext.destination);
      this._analyserBuf = new Uint8Array(this.outputAnalyser.frequencyBinCount);

      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      this.workletUrl = URL.createObjectURL(blob);
      await this.captureContext.audioWorklet.addModule(this.workletUrl);

      this.captureSource = this.captureContext.createMediaStreamSource(this.mediaStream);
      this.captureWorklet = new AudioWorkletNode(this.captureContext, "upsy-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      const actualRate = this.captureContext.sampleRate;
      this.captureWorklet.port.onmessage = (event) => {
        const frame = event.data;
        this.trackInputLevel(frame);
        if (this.muted) return;
        this.sendChunk(floatToPcm16(resample(frame, actualRate, SAMPLE_RATE)));
      };
      this.captureSource.connect(this.captureWorklet);
    }

    trackInputLevel(frame) {
      let peak = 0;
      // Every 8th sample: this runs on every frame and only feeds a waveform.
      for (let i = 0; i < frame.length; i += 8) {
        const v = frame[i] < 0 ? -frame[i] : frame[i];
        if (v > peak) peak = v;
      }
      // Decay rather than snap, so the bars fall smoothly between frames.
      this.inputLevel = Math.max(peak, this.inputLevel * 0.82);
    }

    // 0..1 level of what the agent is currently saying, for the waveform.
    readOutputLevel() {
      if (!this.outputAnalyser) return 0;
      this.outputAnalyser.getByteTimeDomainData(this._analyserBuf);
      let peak = 0;
      for (let i = 0; i < this._analyserBuf.length; i++) {
        const v = Math.abs(this._analyserBuf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      this.outputLevel = Math.max(peak, this.outputLevel * 0.8);
      return this.outputLevel;
    }

    openSocket() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(this.options.signedUrl);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        let opened = false;

        ws.addEventListener("open", () => {
          opened = true;
          ws.send(JSON.stringify({
            event: "start",
            stream_id: this.streamId,
            config: this.options.config,
            // The prompt travels with the call rather than living on the
            // provider's dashboard, so the agent's instructions stay in git
            // and get reviewed like any other code.
            agent: this.options.agent,
            metadata: this.options.metadata,
          }));
          this.setStatus("connected");
          resolve();
        }, { once: true });

        ws.addEventListener("message", (event) => this.handleMessage(event.data));

        ws.addEventListener("error", () => {
          if (opened) return;
          const message = "Could not reach the voice service. Check your connection and try again.";
          this.fail(message);
          reject(new Error(message));
        });

        ws.addEventListener("close", (event) => {
          // Always record why. A close with no explanation is the single most
          // confusing failure here: the call sheet just vanishes a second after
          // it opens, which looks like our bug and usually isn't.
          this.closeCode = event.code;
          this.closeReason = event.reason || "";
          console.warn("[voice] socket closed", event.code, event.reason || "(no reason given)");

          if (!opened) {
            const message = this.explainClose(event, false);
            this.fail(message);
            reject(new Error(message));
            return;
          }
          // Closed *after* opening. If it happened before the agent ever said
          // anything, the call never really started — treat it as a failure
          // with a reason rather than a normal hang-up, or the caller is left
          // staring at a sheet that closed itself.
          if (!this.receivedAudio && this.status !== "error") {
            this.fail(this.explainClose(event, true));
            return;
          }
          if (this.status !== "error") this.setStatus("ended");
        });
      });
    }

    handleMessage(data) {
      if (typeof data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }

      switch (msg.event) {
        case "ack":
          // The server may assign its own stream id; every media_input after
          // this has to carry that one, not ours.
          if (typeof msg.stream_id === "string") this.streamId = msg.stream_id;
          break;

        case "media_output":
          if (msg.media && typeof msg.media.payload === "string") {
            this.receivedAudio = true;
            this.playPcm(msg.media.payload);
          }
          break;

        // Some providers report a rejected start as an in-band error rather
        // than closing the socket, which would otherwise look like silence.
        case "error":
          console.error("[voice] service error:", msg);
          this.fail(msg.message || msg.error || "The voice service reported an error.");
          break;

        default:
          // Barge-in: when the caller talks over the agent, the provider stops
          // generating — but audio already scheduled in our playback queue
          // would keep playing over them for as long as the queue is deep.
          // The exact event name is not confirmed against a live call yet, so
          // match defensively rather than pinning one spelling, and log
          // anything unrecognised so the first real call tells us the truth.
          if (/interrupt|clear|barge|cancel|flush/i.test(msg.event || "")) {
            this.flushPlayback();
          } else if (msg.event) {
            console.debug("[voice] unhandled event:", msg.event, msg);
          }
          if (this.options.onEvent) this.options.onEvent(msg);
          break;
      }

      if (msg.event === "media_output" && this.options.onEvent) this.options.onEvent(msg);
    }

    sendChunk(pcm) {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        event: "media_input",
        stream_id: this.streamId,
        media: { payload: pcm16ToBase64(pcm) },
      }));
    }

    playPcm(payload) {
      const pcm = base64ToPcm16(payload);
      if (!pcm.length) return;
      const ctx = this.playbackContext;
      if (!ctx) return;

      const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputAnalyser || ctx.destination);

      // The queue cursor is the whole trick for gapless playback: each chunk
      // starts exactly where the last one ended, never at "now". Clamping to
      // currentTime recovers if the network stalled long enough for the cursor
      // to fall into the past.
      const startAt = Math.max(this.playbackQueueTime, ctx.currentTime);
      source.start(startAt);
      this.playbackQueueTime = startAt + buffer.duration;

      this.scheduledSources.add(source);
      source.onended = () => this.scheduledSources.delete(source);
    }

    // Drop everything already queued — used for barge-in.
    flushPlayback() {
      for (const source of this.scheduledSources) {
        try {
          source.stop();
        } catch (e) {
          // Already finished; nothing to stop.
        }
      }
      this.scheduledSources.clear();
      if (this.playbackContext) this.playbackQueueTime = this.playbackContext.currentTime;
    }

    setMuted(muted) {
      this.muted = Boolean(muted);
      // Also disable the track itself, so the mute is real at the device level
      // and not just a flag we could forget to check.
      if (this.mediaStream) {
        this.mediaStream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
      }
      return this.muted;
    }

    elapsedSeconds() {
      return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    }

    // Teardown is deliberately exhaustive and order-sensitive: a leaked
    // MediaStream track leaves the phone's microphone indicator on after the
    // call, which reads as the app still listening.
    async stop() {
      this.flushPlayback();

      const worklet = this.captureWorklet;
      this.captureWorklet = null;
      if (worklet) {
        try {
          worklet.port.onmessage = null;
          worklet.port.close();
          worklet.disconnect();
        } catch (e) { /* already torn down */ }
      }

      if (this.workletUrl) {
        URL.revokeObjectURL(this.workletUrl);
        this.workletUrl = null;
      }

      const src = this.captureSource;
      this.captureSource = null;
      if (src) { try { src.disconnect(); } catch (e) { /* noop */ } }

      const stream = this.mediaStream;
      this.mediaStream = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());

      const capture = this.captureContext;
      this.captureContext = null;
      if (capture && capture.state !== "closed") { try { await capture.close(); } catch (e) { /* noop */ } }

      const ws = this.ws;
      this.ws = null;
      if (ws && ws.readyState <= WebSocket.OPEN) { try { ws.close(); } catch (e) { /* noop */ } }

      const playback = this.playbackContext;
      this.playbackContext = null;
      this.outputAnalyser = null;
      if (playback && playback.state !== "closed") { try { await playback.close(); } catch (e) { /* noop */ } }

      if (this.status !== "error") this.setStatus("ended");
    }
  }

  // Ask our server for a session, then open the call. Two steps on purpose:
  // the credential is minted per call and short-lived, so it cannot be lifted
  // out of the page and reused.
  async function startVoiceCall(options) {
    const opts = options || {};
    const res = await fetch("/api/voice/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: opts.leadId || null }),
    });
    const session = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(session.error || "Could not start the call right now.");
    }
    const call = new VoiceCall({
      signedUrl: session.signedUrl,
      config: session.config,
      agent: session.agent,
      metadata: session.metadata,
      onStatus: opts.onStatus,
      onError: opts.onError,
      onEvent: opts.onEvent,
    });
    await call.start();
    return { call, session };
  }

  global.UpsyVoice = {
    VoiceCall: VoiceCall,
    start: startVoiceCall,
    SAMPLE_RATE: SAMPLE_RATE,
    // Exposed so the audio conversion can be exercised directly. Getting a
    // sign, a scale factor or a byte order wrong here does not throw — it just
    // makes the caller sound like static, which is a miserable thing to debug
    // from a live call. Not part of the calling API; do not build on it.
    _codec: {
      floatToPcm16: floatToPcm16,
      pcm16ToBase64: pcm16ToBase64,
      base64ToPcm16: base64ToPcm16,
      resample: resample,
    },
  };
})(window);
