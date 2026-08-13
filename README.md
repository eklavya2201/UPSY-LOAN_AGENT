# UPSY Loan Agent

AI loan agent for education loans, modeled on the Kuhoo app's journey. The agent **fetches the applicant's data from your lead source**, greets them personally, then collects only the **missing** documents **in the same order** as the real loan journey (student → co-applicant → collateral). For every document it explains **why it is required**, cross-checks the upload against the expected format, and **writes the verified status back to the lead source**.

---

## 🧭 Start here (orientation for a new session)

**Where the project is (2026-08-11):** everything below is built and running. Applicant flow, team dashboard, document verification, eligibility, lender referral, and a **live voice agent that joins a real Google Meet** are all working, deployed at **https://upsy-loan-agent.onrender.com**  ,https://upsy-loan-agent.onrender.com/upsy-voice-agent and confirmed in production. A second, completely separate voice agent lives at **`/upsy-voice-agent` — a mobile page where the applicant taps a button and talks to UPSY in the browser**, no meeting platform involved.

**🔊 UPSY has its own voice stack now, and it talks (2026-08-07).** We stopped waiting for Cartesia. `backend/voiceRelay.js` is a WebSocket server on this process that terminates the caller's audio socket and runs the call itself — turn-taking and barge-in ours. **`VOICE_PROVIDER=upsy` must stay set** (it defaults to `cartesia` in code, which cannot be deployed on a free account and fails every call).

**The live chain, and where each piece is configured:**

| | Provider | Notes |
|---|---|---|
| Hearing | **Deepgram** nova-3, `en-IN` | `DEEPGRAM_ENDPOINTING_MS=800` — not their default of 300, which splits one thought into two turns |
| Thinking | **OpenRouter `gpt-4o-mini`** | ⚠️ **The Anthropic credits ran out on 2026-08-12 and the key is now blank**, so the fallback is what runs — the swap the row below always said would happen, and it needed no code change. Claude Haiku 4.5 returns the moment a key is pasted back into `.env`. The model is ~65% of reply latency, and Haiku measured *faster* than this (1780ms vs 2086ms) — see "Claude, measured" |
| Speaking | **Deepgram Aura** `aura-2-athena-en` | Moved off Cartesia when its free tier ran out. `TTS_PROVIDER=cartesia` switches back |
| Repeated lines | **Phrase cache** | Greeting + 10 acknowledgements bought once, pre-warmed at boot: 1593ms → 25ms |

**One API key now does hearing *and* speaking**, so `DEEPGRAM_API_KEY` is the single thing voice cannot run without. Cartesia's credit is spent until **Sep 1, 2026**.

**✅ The audio round trip is closed — the thing that had never worked.** Verified in a real browser against a real Cartesia account: `POST /api/voice/session` → 200 with a URL pointing at *us*, socket opens, and **the agent's spoken introduction arrives 524ms later** — 2.06s of continuous PCM, no gaps, decoded by `voiceClient.js`'s own codec and accepted by an `AudioContext`. `npm run voice:relay` reproduces the whole thing in one command with no server running.

**The browser did not change, which was the test.** `frontend/voiceClient.js` only knows "PCM over a WebSocket". It was pointed at a different socket and everything still worked, first try — the provider abstraction was real, not aspirational.

**🎁 And owning the socket gave us something the hosted agent could not.** We have the caller's words as text, so the relay emits `transcript` events. `/upsy-voice-agent`'s constellation was built to spotlight the topic being discussed and had to settle for a timed rotation because Cartesia only ever sent audio; `matchTopic()` has been waiting for exactly this event and needs no changes.

**🌿 A call now fills in a loan file, branch by branch (2026-08-10).** The team's underwriting flowchart is `backend/callSchema.js`: five branches — **applicant → institute → loan → co-applicant**, plus **underwriting** derived from those four. The agent works through them as an agenda rather than a form (answer their question first, one question at a time, drop anything they will not answer), `backend/callExtract.js` reads the transcript into the branches **off the voice critical path**, and `/team` → Voice callers shows an officer the branches, the flowchart's flags, the FOIR and lender band, **and the caller's own words under every single value**. Second calls only ask for what is still missing. **And it is wired to the doc collection agent the way the team designed it — the params from the conversation narrow the document requests** (a salaried co-applicant is never asked for three years of ITR; a PG course pulls in the UG marksheet; an unsecured loan drops the property papers), with the dropped ones shown *with their reason* so an officer can tell narrowed from missed. `npm run eval:extract` proves it — 113 checks. Full detail in "The extractor is built". This closes the one piece the previous session left open.

**👤 `/upsy-voice-agent` has accounts now, and a second call knows what the first one said (2026-08-07).** Until today every call started from zero — the transcript existed and was thrown away the moment the socket closed. `backend/voiceAccounts.js` adds a **standalone account** (name + mobile + password, scrypt-hashed) that is deliberately *not* the lead record; the relay files each call's transcript against it, and `buildVoiceSystemPrompt()` reads it back on the next call. The team dashboard grew a **Voice callers** view. Full detail in "`/upsy-voice-agent` accounts and remembered calls". *(The extractor this section once listed as the missing piece was built on 2026-08-10 — see the paragraph above.)*

**✅ And it hears you — the loop is closed (2026-08-07).** A `DEEPGRAM_API_KEY` already existed on this machine, in the separate `UPSY AI AGENT` project (`backend/.env`, same team account, `upsytechno@gmail.com`); it is now in this project's `.env` too, along with the `SARVAM_API_KEY` that was sitting beside it. `npm run voice:relay` runs the **whole loop with no microphone and no human**: it synthesises a caller (in a different voice from the agent's, so it is not testing whether Deepgram can hear itself), streams that audio in at real-time pace, and asserts the transcript comes back, the brain answers, and the answer is spoken. **Run this first in any new session** — it is the fastest way to know whether voice is healthy, and it names the broken link rather than making you find it.

```
✅ heard, 765ms after the caller stopped: "I need about 15 lakh rupees for an MBA. Am I eligible?"
✅ UPSY answered out loud 2203ms after the caller stopped
```

**⏱️ Latency: the reply now lands ~0.85–1.5s after the caller stops, down from 2.3–3.4s.** `npm run eval:voice` measures the cause — **time to first *sentence*, not total generation**, because the relay speaks each sentence as it lands, so a long reply costs nothing extra. It found the brain is ~65% of the wait: OpenRouter's `gpt-4o-mini` averages **2086ms** (worst 3635ms) against a ~1.2s budget. Three fixes, in order of how much they actually bought:

1. **Spoken acknowledgements (`voiceFillers.js`) — the big one.** The agent says *"Okay, so you want to know which documents you'll need"* the instant the turn confirms, while the model is still generating. The caller hears a response in ~400ms instead of ~2s, and it doubles as confirmation they were understood. Chosen by keyword match, never by the model, so it costs nothing — which is exactly why **every line restates the question and stops**: it is picked before the model has decided anything, so any hint of a number, rate or verdict would be this server inventing lending advice. Hindi lines are written and waiting on Sarvam.
2. **Speculative thinking.** When Deepgram settles a fragment mid-utterance, the relay starts generating against it and buffers the sentences, releasing them instantly if the turn confirms unchanged. Real but partial: on a short question Deepgram sends one final chunk, so there is nothing to get a head start on — which is why the acknowledgement carries most of the win.
3. **A breathing rim light on `/upsy-voice-agent`.** The relay emits `state` (listening / thinking / speaking) and the frame's edge glows to match — slow and cool while listening, quick and warm while thinking. Verified painting all three states from a live socket. This is the other thing owning the socket bought us: the hosted agent sent audio and nothing else, so the page could only guess.

**🗣️ Two things a real listener caught that no test did (2026-08-07).** Both were reported from an actual call, and both turned out to be measurable once someone went looking:

- **"She said yes, then stopped."** The agent was **interrupting itself**. Barge-in fired on Deepgram's raw voice-activity event, and a caller on speakerphone leaks the agent's own voice back into the mic — so it spoke two or three words, cut its own reply, flushed the playback queue, and went silent. Barge-in now requires **two recognised words**, not a VAD blip: browser echo suppression mangles leaked audio enough that it rarely survives as clean multi-word text, while a person actually interrupting always does.
- **"She's replying so fast — I don't know if it's the accent."** Both, and both were fixable. Measured: every Cartesia voice runs **195–222 words/min** against a conversational norm of 140–160 (over ~185 reads as rushed).

  **Cartesia's speech-rate control does nothing on sonic-2.** Not "works badly" — does nothing. Tested across string values, numeric values from -0.3 to -1, nested and top-level shapes, and two newer API versions: 197 to 222 wpm, which is the spread you get from re-requesting the same sentence twice. Do not re-add a `speed` field expecting it to help.

  So pacing is fixed in `backend/voicePacing.js`, where we actually own the stream. Not by resampling — that drops the pitch with the rate and turns her into a different, deeper person — and not by time-stretching, which costs CPU per sentence and smears consonants. It does what a person does when asked to slow down: **it doesn't stretch the words, it lengthens the gaps between them.** Speech untouched, pitch identical, only the silence grows. Runs per streamed chunk, so the first syllable still leaves on time.

  **❌ That gap-widening shipped, broke the audio, and is now OFF by default (`VOICE_PACE_EXTRA_MS=0`).** It made the agent stutter mid-word on a real call — on a laptop and a phone alike, so not a bandwidth problem. Cause: it runs per streamed chunk to protect first-syllable latency, Cartesia's chunks are only ~130ms, and in a 130ms window the detector genuinely cannot tell "a pause between words" from "a quiet moment inside a word". A rule that also treated *quiet at the end of a chunk* as a gap fired on roughly every other chunk, splicing 110ms of silence into the middle of words.

  **The measurement that missed it is the lesson worth keeping.** It was validated by comparing **duration** before and after — a clean +32% on a whole buffer — and never by listening. Run the same settings the way they actually execute, per chunk, and it is +47% with 19 inserts across 34 chunks: 2.1s of silence shot through 4.4s of speech. Duration was the wrong metric; it cannot see stuttering. Every other number in this section came from a harness, and this is the one that a harness structurally could not catch.

  **What is still on** is the between-sentence pause (`VOICE_SENTENCE_PAUSE_MS=280`), which is safe because a sentence boundary is a place we actually know about rather than one we infer from amplitude.

**On the voice itself, four picks in one day, and only the ones made by listening were any good.** Skylar (US, "customer care") → Kiara, on the reasoning that an Indian-accented voice would be easier for Indian callers to follow → Jacqueline, "empathic customer support" → **`aura-2-athena-en` on Deepgram**, "calm, smooth, professional". The accent argument was sound and still lost: Cartesia has 412 English voices and exactly three Indian-accented ones, and none of them sound good; Deepgram has none at all. There is also a register trap worth noting — Kiara is sold as "joyful… for happy conversations", which is the wrong tone for someone anxious about borrowing fifteen lakh. **If you change it again, listen first**; picking from a catalogue's prose was wrong twice.

### 📞 The first real calls, and the four bugs only a human found (2026-08-10)

Every measurement before this came from a synthetic caller on a clean socket. A person picked up the phone and found four things in two calls, none of which any harness had caught. **This is the section to read before tuning anything in the voice path.**

**1. ⛔ The agent's voice broke up mid-word — and it was one sentence's audio spliced into another's.** Reported as *"immm u...p..syyy"*. Not pacing (`VOICE_PACE_EXTRA_MS` is 0), not bandwidth, not the microphone.

**Aura's audio frames carry no request id.** Cartesia tags every chunk with a `context_id`; Deepgram sends bare binary. `handleMessage()` handed each frame to whatever request was currently pending, so the moment one request was abandoned — a barge-in, a stall — its remaining audio was delivered **into the next sentence**, and its late `Flushed` then resolved that sentence early. The socket stayed one request out of step for the rest of the call.

A comment in the file claimed late audio "is dropped because `pending` has already moved on". **It never was.** The code did the opposite of what its own comment promised, which is why this survived so long.

Reproduced by speaking a real call's sentence pattern down one socket, and the give-away is that the durations swap places:

| sentence | before | after |
|---|---|---|
| `"Right."` | **3.60s** of audio, 90 chunks | 0.56s, 14 chunks |
| `"Your father's income is the main thing…"` | **0.52s**, 13 chunks | 2.68s, 67 chunks |
| worst gap between chunks | **5,907 ms** | 52 ms |
| timeouts across 7 sentences | 2 | 0 |

Fixed two ways. **Nothing may be in flight when a new request starts**: an abnormal end marks the socket `dirty`, and the next `speak()` sends `Clear`, waits for Deepgram's `Cleared`, and **replaces the socket** if that confirmation does not arrive. And the stall detector is now **idle-based** — a sentence still delivering audio is alive however long it takes. The old flat 10s ceiling was killing sentences that were streaming perfectly well: a four-second greeting delivered 3.16s of audio in 79 chunks and was then declared timed out, which is what triggered the desync in the first place.

**2. It greeted the caller by name, then asked them their name — three times.** The whole call, verbatim:

```
UPSY  : Hi eklavya, this is UPSY again. Where would you like to pick up?
UPSY  : Can you tell me your full name as it appears on your ID?   ← it just used it
CALLER: Will my full full name be                                   ← Deepgram mangling
UPSY  : Okay, let me think about that for a second.
UPSY  : Yes, please share your full name as it appears on your ID.
CALLER: Is that q?
UPSY  : I didn't catch that. Could you please repeat your full name?
```

62 seconds, 12 turns, and the extractor logged **"nothing new established"**. Three separate defects stacked:

- **The name was already on file** and the branch profile did not know it. `accountIdentityFacts()` now seeds `applicant.name` from what they typed at signup, at signup and again when a session starts, so accounts created earlier benefit too. A name is also the worst thing to put through speech recognition — arbitrary proper nouns, no language model behind them — so **the best version of that question is the one never asked.**
- **Nothing limited retries.** One retry now, then say you will pick it up later and move on. Asking a third time tells the caller the machine is broken and they are right. Names get *zero* retries.
- **The caller's own name is now a Deepgram keyterm.** We know it, so the recogniser may as well be told to expect it. Per-call keyterms sit on top of the standing lending vocabulary.

**3. "It keeps saying wait a moment / let me think about that."** The user compared it to a competitor and was exactly right about why theirs felt smoother: **their fillers are receipts, ours were stalls.** "Let me think about that for a second" announces a wait. "Got it." buys the identical two seconds and reads as the front of the answer.

Worse, every acknowledgement bucket had been written for a caller *asking a question* — back when that was all this agent did. It asks questions of its own now, so most turns are **answers**, and "okay, so you want to know how much you could borrow" is nonsense in reply to "my father earns ninety-five thousand". Every answer therefore fell through to a generic stall. And utterances under three words got **nothing at all**, so the turns with least to think about had the longest silence.

Now: a question gets its topic restated; **an answer gets a receipt** ("Got it." / "Right." / "Sure."), including two-word answers; a bare "yes" still gets nothing. Receipts may repeat on consecutive turns, because people do that — only the identical word is blocked.

**4. Numbers are read back before they are used.** Not a bug report, but the mitigation for the one open defect this file has always flagged. Claude produces it naturally: *"Okay, so your father earns ninety thousand a month — have I got that right?"*

### 🧪 Claude, measured (2026-08-10)

A borrowed key, one testing session, ~3 calls of spend. `npm run eval:voice` **can now rank Anthropic** — it previously spoke only the OpenAI dialect, so it could not measure the one provider `voiceBrain.js` prefers, which made "Claude is faster" a claim nobody here had ever tested.

| | avg to first spoken sentence | best | worst |
|---|---|---|---|
| **Claude Haiku 4.5** | **1780 ms** | 1373 | 2186 |
| OpenRouter `gpt-4o-mini` | 2418 ms | 2400 | 2436 |

Real, ~640ms, and audible — but **still above the ~1200ms budget**, so the honest verdict is "noticeable pause", not "smooth". Extraction quality is the bigger win: 16/16 assertions, **21/21 values carrying a transcript-matched quote**. It still tried to write "father" into the co-applicant's *name* field, so that guard earns its place on any model.

**❌ Prompt caching is NOT working, and this corrects an earlier guess in this file.** The brain logs it every turn:

```
[voice:brain] claude usage in=2416 cache_read=0 cache_write=0
```

Zero writes, zero reads — the 2,416-token system prompt is **below Haiku 4.5's minimum cacheable size**, so `cache_control` is silently ignored. An earlier reading of the latency spread as "caching kicking in" was wrong; it was variance.

**▶️ So the next lever is trimming the prompt, and it pays twice.** Every turn buys 2,416 tokens of input — latency *and* money. The agenda currently spells out a full sentence for each of ~30 fields where short labels would do, and the document plan lists the skipped documents in full. Halving it is realistic without changing behaviour, and it should be measured with `npm run eval:voice` before and after rather than assumed.

### 🔁 TTS moved to Deepgram Aura (2026-08-07)

**Why: Cartesia's free tier ran out mid-build.** 1 credit per *character*, 20,000 a month — about **21 four-turn calls** — and most of a month went on this session's own preflight runs, each of which re-bought the same greeting. 204 credits were left, which is two greetings, not two calls. Deepgram bills comparable speech against a **$200 balance the team already had**, unused: roughly **7,000 calls on credit already paid for**.

Measured head to head before switching, on the same sentences (working files in `Desktop/testing-deepgram/`, outside this repo):

| | Cartesia Sonic | Deepgram Aura-2 |
|---|---|---|
| Credit available | 204 chars | **$200 ≈ 6.7M chars** |
| First audio, warm socket | ~360 ms | ~396 ms |
| Pace | Jacqueline 218 wpm | athena 195 wpm |
| Audio format | raw pcm_s16le 44.1 kHz | **identical — drop-in** |
| Indian-accented voices | 3 | **0** |

The 40 ms latency difference is far below perception and is dwarfed by the 1.4–2 s the model takes to write a first sentence. **Cartesia stays behind `TTS_PROVIDER=cartesia`** — it works, and a second proven path costs nothing to keep.

⚠️ **Use Aura's WebSocket, never its REST endpoint.** `POST /v1/speak` returns the whole clip in one response: measured at **3.3 seconds before any audio exists at all**, against 396 ms for the first streamed chunk.

### 💸 The phrase cache — and the mistake that made it necessary

The greeting and the ten acknowledgements are byte-identical on every call and were **re-synthesised, and re-paid for, every single time**. An acknowledgement fires on most turns, so roughly a third of a four-turn call's characters were spent on audio already bought. It is also precisely what drained Cartesia in a day: every preflight run bought the same greeting again.

They are now synthesised once and replayed — **1593 ms → 25 ms**, and free. Faster as well as cheaper, and the acknowledgement is the one line whose entire job is to land fast. `warmVoiceCache()` buys them at boot so no caller pays: on a free instance that sleeps after 15 minutes, "the first caller after a wake-up" is usually the person being shown a demo.

Deliberately **not** a general-purpose cache — only exact strings from a known fixed set. Model replies never repeat, so caching them would grow without bound and never be read. A personalised greeting ("Hi Aarav, this is UPSY again") is unique per caller and is excluded for the same reason.

**Two bugs this work surfaced, both worth remembering:**
- **`speak()` could hang forever.** It settled only on Deepgram's `Flushed`, so a stalled socket blocked the shared speech queue and silenced the agent for the rest of the call, with no error raised anywhere. It deadlocked the boot prewarm on its first run. There is a 10 s ceiling now (`TTS_SPEAK_TIMEOUT_MS`).
- **The prewarm was buying all twelve Hindi lines** and feeding them to an English voice. Language was being guessed from the text by regex; the regex silently matched nothing. `allFixedPhrases(language)` now returns them by language, because the buckets already know — guessing was never necessary.

  **So the agent still speaks at ~200 wpm and that is a known, accepted gap.** Reviving it properly means pacing a whole sentence after synthesis and eating the latency, or getting real word boundaries from the provider (Cartesia's TTS supports `add_timestamps`). Do not try to make the per-chunk energy detector smarter — the information is not in a 130ms window.

**Still worth doing:** a faster brain would remove the problem rather than mask it. The Groq key on this machine is **expired** and the `OPENAI_API_KEY` is a placeholder (`your_ope…here`); either a working Groq key or `ANTHROPIC_API_KEY` (Haiku 4.5) should cut first-sentence time well under a second. Re-run `npm run eval:voice` after adding one — it ranks whatever is configured.

**Two defects that test caught, which no amount of reading would have:**
- **`language=en` mangles the vocabulary this product is made of.** "fifteen lakh rupees" came back as "15 **locker piece**", and on another run "fifteen" vanished entirely. Fixed with `en-IN` plus keyterm boosting for *lakh / crore / EMI / moratorium / Aadhaar / …* — 3 for 3 exact afterwards. An agent that mishears the loan amount is worse than one that cannot hear at all, because it answers the wrong question confidently.
- **Deepgram's default 300ms endpointing ends a turn at every sentence boundary.** "I need fifteen lakh for an MBA. Am I eligible?" was answered after the first sentence, and the second sentence then barged in on that answer. Raised to 800ms; one thought is now one turn.

**The old hosted path is still in the repo and still blocked**, deliberately not deleted: Cartesia's dashboard shows *"New agent deployment creation is temporarily paused for free accounts"*, so `VOICE_PROVIDER=cartesia` fails preflight with `is_live: false, deployment_count: 0`. It costs nothing to keep as a fallback. `npm run voice:check` still reports its real state.

**⚠️ There are now TWO voice agents and confusing them will waste your session:**

| | `liveAssist.js` (AgentCall) | `voiceRelay.js` (browser, `/upsy-voice-agent`) |
|---|---|---|
| Where | Joins a **Google Meet** as a bot | The caller's **own phone browser** on `/upsy-voice-agent` |
| Sees | A screen share of a lender's form | Nothing — voice only |
| For | Guiding someone through Avanse | Answering loan questions on the spot |
| Thinking | Ours (OpenRouter, per turn) | Ours (Claude Haiku 4.5, per turn) |
| Turn-taking | AgentCall's | **Ours** (`voiceRelay.js`) |
| Concurrency | **1 call server-wide** | One socket per caller, capped only by our providers |

**What to work on next (2026-08-07).** The voice stack is built, deployed and verified end to end. What is left is in this order:

1. **Get a Claude key of our own.** There is one in `.env` today and **it is borrowed from a friend of the user, added 2026-08-10 for a single testing session** — assume it is gone or rotated. Everything falls back to `gpt-4o-mini` automatically when it is, and the call gets slower rather than broken. What it bought is measured in "Claude, measured" below; the short version is 1780ms vs 2418ms to a first spoken sentence, and visibly better extraction. It also unblocks **PDF document reading** (see point 2 of the six gotchas).
2. **Numbers are still misheard.** "fifteen lakh" sometimes lands as "lakh". `en-IN` and keyterm boosting made it rare, not gone. **This is the most dangerous open bug in the voice path** — the agent quotes loan amounts, and a confident answer to a misheard number is worse than no answer. Nothing is built to mitigate it; the obvious move is having the agent confirm any figure back before reasoning from it.
3. ~~**Talk to it on a real phone.**~~ **Done 2026-08-10, and it found four bugs no harness had** — see "The first real calls". Keep doing it: every remaining measurement in this file still comes from a synthesised caller on a clean socket, and **barge-in on speakerphone** is still unexercised, because a synthetic caller structurally cannot trigger it — it never echoes.
4. **Hindi.** `SARVAM_API_KEY` is in `.env`, unimplemented. Neither Deepgram nor Cartesia has an Indian-accented voice worth using, so this is the only path to it. The plumbing (a `language` on the session and the ticket) already exists; asking for a non-English language throws a named error rather than reading Hindi in an English voice.
5. ~~**The transcript extractor**~~ — **done 2026-08-10**, see "The extractor is built". What is left on it is that a small model reading speech is not deterministic: identical transcripts have given 23/28 and 24/28 fields on consecutive runs. Absence is safe by design, but nothing detects a field the model quietly stops finding.

After those, the previous priority (**Avanse precision**) is the next real piece of work; it is still unverified live.

*Working files for the Deepgram evaluation live in `Desktop/testing-deepgram/` — outside this repo, with the head-to-head numbers, the voice samples the choice was made from, and `FINDINGS.md`. Nothing there is needed to run the product.*

The previous priority — *making the live-assist Meet agent precise on Avanse's form* — is **still real and still unverified live**, and its spec is the failure-mode list in the Avanse section. It is not cancelled, just no longer first: the voice work is blocked-and-unblockable today, and Hindi is a live product gap.

**The six things that will bite you if you don't know them:**

1. **Never run two server instances.** `EADDRINUSE` is now fatal on purpose — a zombie second instance once resurrected deleted records from a stale cache. See "Ops & reliability notes".
2. **The `ANTHROPIC_API_KEY` in `.env` is borrowed and temporary** (added 2026-08-10, a friend of the user's, pasted into chat — **treat it as compromised**). `ANTHROPIC_VISION_MODEL=claude-haiku-4-5` sits beside it purely to stop document reads defaulting to `claude-opus-4-8` and burning someone else's credit; **remove that line when testing document accuracy for real**, because Opus is the whole point there. Without a key, PDFs have *no working reader at all* and digit accuracy is unreliable — the repo has caught `gpt-4o-mini` reading one file as ₹1,39,100 and ₹13,91,000.
3. **The voice stack is ours, and one key runs all of it.** `DEEPGRAM_API_KEY` does BOTH the hearing and the speaking (Aura TTS) — it is the single thing voice cannot run without. `CARTESIA_API_KEY` is now only read when `TTS_PROVIDER=cartesia`, and **its credit is spent until Sep 1, 2026** (20k characters/month is ~21 calls; a day of building drained it). `CARTESIA_AGENT_ID` is dead weight. The Cartesia key was pasted into chat, so **treat it as compromised and rotate it**. Run `npm run voice:relay` before assuming anything about voice is broken on our side.
4. **`NOTIFY_CHANNEL=mock`** — every SMS/WhatsApp, including live-assist join links, only prints to the server console. Nothing reaches a real phone until Exotel is re-enabled (account balance + WhatsApp sender registration still unresolved).
5. **AgentCall's free tier is one-time and small**: 6 hours total, **1 concurrent call server-wide**, 1 hour max per call. Test calls already spent some of it. (This limit does **not** apply to `/upsy-voice-agent` — different vendor, different path.)
6. **Secrets have been pasted into chat more than once** (Exotel, Salesforce incl. a password, Zoho, HubSpot, Twilio, Groq, OpenRouter, LeadSquared, Deepgram, Sarvam, AgentCall). If more appear, flag rotating them and never echo them back.

**Fastest way to see it work:** `npm install && npm start`, then open `http://localhost:3000` and sign in as **9999999999** (Aarav, eligible) — the demo leads live in `backend/leadSources/mockSource.js` and always exist. Team view is at `/team`. The mobile surface is at **`/upsy-voice-agent`** — it renders as a phone-shaped frame on a desktop, so you do not need a device to look at it, and it now opens on its own sign-in screen (create an account, or tap "Just talk, don't save anything"). Voice callers show up under the **Voice callers** toggle on `/team`. **`npm run voice:relay` tells you whether the voice line works, and it makes the agent speak** — no server, no browser, no microphone needed.

**⚠️ `/upsy-voice-agent` accounts do not survive a Render respin.** `data/voiceAccounts.json` is gitignored local disk like everything else in `data/` — so on the free tier a caller who signs up today is a stranger again after the instance sleeps. Fine for testing, and the first thing to fix before real callers are told their calls are remembered.

**Where to read next, by question:**

| You want to… | Go to |
|---|---|
| Understand the Meet voice agent | "Live-call assistance via AgentCall" — includes an end-to-end runtime flow diagram |
| Understand the phone-browser voice agent | "Browser voice calls (`/upsy-voice-agent`)" |
| Work on what a call captures and remembers | "`/upsy-voice-agent` accounts and remembered calls" |
| Change what the agent asks for on a call | `backend/callSchema.js`, then "The extractor is built" |
| Debug how a call *sounds* | "The first real calls, and the four bugs only a human found" |
| Make the agent faster | "Claude, measured" — the prompt is 2,416 tokens and caching is not engaging |
| Work on the current priority | "▶️ ACTIVE — build our own voice stack" in the roadmap |
| Work on the *previous* priority (Avanse precision) | "Avanse (`online.avanse.com`)" then the "⏸️ PAUSED — Avanse precision" roadmap block |
| Find which file does what | "Code map" |
| Avoid repeating a past mistake | "Ops & reliability notes" |
| Know what blocks real users | "Phase 2 — compliance HARD GATE" |

---

## What we built: End-to-end loan document collection

**The flow (now real routed pages: `/login` → `/intake` → `/docs`):**

1. **`/login` — Applicant signs in** → enters mobile number → bot fetches their lead data from the CRM/lead-ad (or treats them as new).
2. **`/intake` — Smart intake (AI-Autocomplete-style)** → applicant describes the loan in one plain sentence ("15 lakh for an MBA at INSEAD, husband co-applicant") → LLM structures it into amount/level/institution/country/intake/co-applicant/secured-vs-unsecured → anything missing is asked **as answerable inline inputs on the same page** → merged context follows them through the flow and is written to the lead timeline (`intake_captured`). "Skip for now" available. Every login passes through intake (returning users can skip).
3. **`/docs` — Eligibility overview** → personalized greeting, "Your request: ₹15.0 L · MBA · INSEAD · France" context banner, preliminary eligibility (amount/rate/moratorium) — kept short and light before any commitment.
4. **Documents in order** → bot explains *why* each is needed → applicant uploads photo/PDF. An **"Ask UPSY" helper panel** sits on the right of every document page: quick chips ("Why is this needed?", "What format works?", "Why wasn't mine accepted?" — the last appears only after a rejection) plus free-text questions, answered by the LLM **grounded in that doc's definition, the applicant's loan context, and the exact failed checks** from their last upload.
5. **Vision AI reads the card** (Claude → OpenRouter → OCR chain; PDFs supported on the Claude path) → extracts PAN/Aadhaar/name/DOB/**address** automatically → **Aadhaar numbers are only trusted if they pass the real UIDAI Verhoeff checksum** (misreads degrade to "please type it" instead of showing a wrong number) → cross-checks the number matches the card → validates file format → shows pass/fail per check. For co-applicant documents (income proof, bank statement), name/address are cross-checked against each other and flagged on mismatch — see "Co-applicant identity verification" below.
6. **All documents received** → **EMI assistance card** (Auxilo-style: moratorium-aware math, pay-interest-during-study toggle, live tenure slider) and **matched partner lenders** now appear here, once there's a real submitted application behind them — not upfront on the eligibility page.
7. **Team sees everything** → UPSY loan officer opens dashboard → sees all applicants, each doc's status, intake context in the timeline, co-applicant's name/phone read off their documents, can approve/reject or ask for a re-upload.
8. **Status writes back** → every event (intake captured, doc passed, co-applicant contact extracted, app approved) is logged in the lead source → applicant sees progress → team can export the finished packet to the lender.

### Run it

```bash
npm install
npm start
# Applicant: open http://localhost:3000  (routes: /login → /intake → /docs)
# Team dashboard: open http://localhost:3000/team.html
# Standalone smart-intake demo (isolated from the main flow): http://localhost:3000/intake.html

npm run eval          # batch-test PAN/Aadhaar card reading on files in data/uploads/ (or pass file paths)
npm run eval:income   # batch-test ITR/Form16/salary-slip income reading (scans project root + data/uploads/, or pass file paths)
npm run voice:relay   # preflight OUR OWN voice stack: transport → tickets → does it actually speak → does the brain stream
npm run voice:check   # preflight the hosted Cartesia agent instead (only if VOICE_PROVIDER=cartesia)
npm run eval:extract  # the branch schema: FOIR maths + flag rules offline, then a scripted call through the real extractor
npm run eval:extract -- --seed   # ...and write that call into the store, so /team has a real caller to show
npm run eval:voice    # where the reply latency actually goes — time to first SENTENCE, not total generation
npm run assist:call   # join a real Meet/Zoom/Teams call directly (the live-assist agent, standalone)
```

On boot the server prints its **document-reader priority** so you can see at a glance which AI path is active, e.g. `Document reader priority: Claude (claude-opus-4-8) → OpenRouter (openai/gpt-4o-mini) → OCR (fallback)`.

**Demo leads (pre-seeded in mock source):**
- **9999999999** — Aarav (Meta lead ad, MBA at IIM Bangalore, unsecured loan, salaried co-applicant, 76% academic, ₹95k co-applicant income). Already has photo + 10th/12th on file; PAN pre-filled; collateral skipped. **Eligible.**
- **8888888888** — Priya (website form, MS in US, secured loan, self-employed co-applicant, NRI). Full list shown; co-applicant income asked as ITR. **Eligible**, with an NRI heads-up.
- **7777700000** — Rahul (weak case: 52% academic score, co-applicant is a "friend" — not allowed). Demonstrates a **"needs review"** result with clear reasons.
- **Any other number** — fresh enquiry; full document list shown.

## Lender referral flow (newest phase — "the main problem to solve")

Post-eligibility handoff to partner lenders, built per the WhatsApp spec (preview docs → partner institutes → eligible lenders → Outlook draft → activity trail):

- **Demo lender catalogue + matcher** (`backend/lenders.js`) — 6 demo lenders (HDFC Credila, Auxilo, Avanse, InCred, Union Bank, SBI; emails are `.example.com` placeholders until real lender APIs/contacts land). `matchLenders()` scores each against the same underwriting facts as the eligibility engine (loan type, estimated amount vs lender caps, academic %, NRI policy) and returns per-lender fit + human-readable reasons. Applicant sees matching lenders as cards on `/docs`; team sees all lenders with reasons in a **Lenders tab**.
- **Partner institutes** (`backend/institutes.js`) — alias-tolerant matcher ("IIM-B" → "IIM Bangalore"); partner status shows as a perk banner on the applicant's eligibility page, a fact + banner on the team side, and is stated in the referral email facts.
- **Lender-specific email drafts** (`backend/lenderDraft.js`) — "Generate draft" per lender: LLM-composed referral (Claude → OpenRouter → deterministic template fallback, so it always works) grounded ONLY in a facts block (profile, eligibility memo, co-applicant, verified docs) — instructed to never invent facts or assume gender. Draft is editable in the team UI (subject + body), auto-saved before export.
- **Open in Outlook (.eml)** — the draft downloads as an RFC-822 `.eml` with `X-Unsent: 1` (opens as an editable unsent compose window in Outlook) with **every verified document attached** (base64 MIME; missing files are skipped with a log, never a crash). Verified end-to-end: 467KB .eml with a real PDF inside. Real Microsoft Graph integration (create draft directly in a mailbox) is a later upgrade.
- **"Draft email" button on every lead card** in team.html — jumps straight to that lead's Lenders tab.
- **Mark as shared** — records when/how the email went out; the **Activity tab** logs both `lender_draft_created` and `lender_email_shared` with full detail (lender, recipient, subject, attached document list, via Outlook, timestamp), rendered as highlighted timeline entries.
- **Upload preview** — applicant sees an inline preview (image or PDF in an `<iframe>` — `<embed>` was unreliable in Chrome, showed "reload to view") of the file they just attached, before uploading. Revisiting an already-uploaded document shows the **stored file's preview** too, with a **delete icon** (confirm → removes the stored file via `DELETE /api/applications/:leadId/documents/:docId`, flips the doc back to *pending* everywhere, logs `document_deleted` on the timeline). A newly attached file's preview has its own delete icon that just clears the selection. If a doc is marked received but its file is gone from storage, the applicant sees a clear "preview isn't available anymore — attach a fresh copy" note instead of silence.

API: `GET /api/applications/:leadId/lenders` · `POST/PUT .../lenders/:id/draft` · `GET .../draft.eml` · `POST .../share`. Draft state persists in `applications.json` (`lenderDrafts`).

## Avanse (`online.avanse.com`) — our partner lender's real application site

**Why this section matters more than it first looks.** This started (2026-07-30) as competitor research. As of **2026-08-02 it is the primary target of the live-assist agent**: Avanse is one of our partner lenders, and real applicants will be sent to `online.avanse.com` to complete their actual application and verification. When they get stuck there, UPSY's voice agent is what helps them — so every quirk of this form is something the agent needs to handle. Read this section together with "Live-call assistance via AgentCall" below and the Avanse-precision phase in the roadmap.

Checked `online.avanse.com` live, at the team's request:

- **Sign-in**: phone/email + OTP, no separate signup step — straight to a "My Loan Applications" dashboard (Apply Now / My Offers / All-Pending-Disbursed tabs) once logged in.
- **"Apply Now" quick form** (tested with "Executive Education" as the loan type): Select Type, Name, Email ID, Phone Number, Loan Amount, Time of Study, Place of Study, Admission Status — a lead-intent form, roughly comparable to UPSY's `/intake` step but simpler (no institution name, no co-applicant, no secured/unsecured choice at this stage).
- **⚠️ Dead end found (2026-08-02), partially corrected by new evidence (2026-08-03)**: submitting that form returned straight to "My Loan Applications" showing **"No Application Found"** — no visible continuation into a document/KYC step in-browser at the time. However, a real logged-in dashboard screenshot the next day showed the opposite: **two persisted, resumable applications**, each with an Application Number (e.g. `AVUPSKL020826176243`), an **"In-Progress"** status chip with a stage tag like `(Applicant Details)` or `(Course Details)`, Institute/Course/Loan Amount, and a **"Continue Application"** button. So submit does **not** always dead-end silently — it can create a real multi-stage application that persists on the dashboard. **Not yet reconciled**: whether the original "No Application Found" run was a one-off (e.g. a field left blank, a slow write-through) or a genuinely different code path — this needs a fresh, deliberate walkthrough rather than assuming either result is the universal case.
- **Comparison takeaway** (from when this was competitor research): on what we could observe, UPSY's applicant flow goes further live — straight from stated intent into guided, real-time document collection with instant eligibility feedback, versus Avanse appearing to stop at lead capture. Caveat: Avanse is a real production lender with actual compliance/backend behind it; UPSY is ahead on live interaction design but still behind on production-readiness (no dashboard auth, PII logged in plaintext, DPDP consent not built — see Phase 2 below).
- **Reframed takeaway** (now that Avanse is a partner, not a rival): the gaps above stop being scorecard points and become **the exact places our applicants will get stuck**. Avanse's form being terse and unguided is precisely why a voice agent sitting alongside it has value — we are not competing with that form, we are the thing that gets people through it.

### ⚠️ Two distinct entry paths into Avanse — real applicants use the second one (found 2026-08-04)

Everything in "Observed screens and fields" below Screen 4 was walked via Avanse's own **self-serve "Apply Now"** button on its dashboard — a simple lead-capture form. A live walkthrough on 2026-08-04, starting from an actual course-application invite email, surfaced a **second, separate path that is the one real applicants will actually take**:

1. **Email invite** from `updates@upsy.in` ("Hello \<name\>, you have been invited by *Airtribe* to enroll in a course through Upsy, India's trusted education financing platform") — names the course and its fee (e.g. "Data Analytics Launchpad", ₹1,25,000) and links to a **"Claim this Application"** card (also shows a link-expiry date).
2. **`upsy.in` dashboard** ("My Applications") — every application the applicant has across courses/lenders, each as a card with status (Pending / In Review / Approved / Disbursed / Rejected / Cancelled) and a contextual action button (**Apply**, or **Continue with lender** once a specific lender is attached — we saw "Avanse Financial Services Ltd" named directly on a card here).
3. **`upsy.in` "Select Financing Option" modal** — shows tenure options (3/6/9/12 months, all labelled **"No Cost EMI"**) with monthly EMI and total payable per option, plus a **"View All Lenders"** link, before an **Apply Now** button hands off into the actual lender's site.
4. **Lands on `online.avanse.com`** already carrying the course + amount, and proceeds through Avanse's real structured multi-step wizard — see the new screens below.

**⚠️ Naming collision, read carefully:** `upsy.in` is a **real third-party platform** (Airtribe's financing partner) — it is **not us**, and the coincidence with our own product name "UPSY" is exactly that, a coincidence. Anywhere this README or the lender-guidance code says "Upsy" from here on, check context: our own product, or the external `upsy.in` marketplace.

**Why this matters more than the self-serve form:** applicants referred by a course provider like Airtribe — i.e. the applicants UPSY's own live-assist agent will actually be on a call with — arrive via this invite path, not by finding Avanse's own "Apply Now" button. The 5-stage wizard and its specific fields (documented below) are what the agent needs to be precise about, more so than the older quick-form findings.

### 🎯 The "happy path" — what the agent should be good at first (team decision, 2026-08-04)

**Definition, straight from the team (Akhil):** the happy path is *"the case when Avanse doesn't ask for a co-applicant."* One person applies on Avanse, alone, and the entire co-applicant branch never appears.

This is the single most important framing in this section, because it **reprioritises everything documented below**. The screens that involve a co-applicant are not the main case to solve — they are the fallback case, and the team has explicitly said to solve the happy path first.

**How UPSY deliberately produces that happy path** (this is a designed outcome, not luck):

1. A student is typically **non-earning**. If the student applies to Avanse in their own name, Avanse sees `Applicant is: Non-earning`, immediately demands a co-applicant, and the whole multi-person branch opens up.
2. So UPSY **does not send the student to Avanse as the applicant**. When UPSY's own checks determine the student needs a co-applicant (say, their father), UPSY makes **that co-applicant the primary applicant on the Avanse side**.
3. That person *is* earning, so Avanse sees an ordinary single earning applicant and **never asks for a co-applicant** — which is exactly the happy path.

So "make the co-applicant the primary applicant" is not a filing technicality. It is the mechanism that produces the clean single-person application.

**Related fact from the same conversation:** UPSY **does not share the student's and the co-applicant's details with Avanse together**. Avanse receives *one person's* application, not a student-plus-co-applicant package — which is consistent with the mechanism above.

**⚠️ Unresolved tension, do not let the agent assert either version:** the 2026-08-04 walkthrough *did* observe Avanse asking for full co-applicant details inside a single application (Screens 10, 12, 13 below), which appears to conflict with "we don't hand both over together." The likely reconciliation is that these describe different moments — what UPSY *pre-fills at hand-off* versus what Avanse *asks for once the applicant is inside its own wizard* — but that has not been confirmed.

**The "ineligible path", explicitly deprioritised:** if Avanse looks at that primary applicant and decides *they* also need a co-applicant, you are now being asked for a co-applicant's co-applicant. The team's observation is that **in most such cases the student simply drops off** — they do not go and find a third person, and the loan does not happen. Team call, verbatim in spirit: *"I don't think we need to refine yet for this path."*

→ **Do not build agent handling for the second-co-applicant case.** It is a known drop-off, deliberately out of scope until the happy path is solid. The agent should recognise it and hand off to a human rather than improvise.

**⚠️ Read this before trusting the screen-by-screen findings below: our walkthrough took the NON-happy path.** The 2026-08-04 session signed in as the *student*, selected `Applicant is: Non-earning`, and that choice fired the co-applicant branch — which is precisely Screens 10–13 (co-applicant details → verification pending → co-applicant income → co-applicant address). Everything recorded there is real and accurate, but it documents **the fallback case, not the case we were told to solve first**.

What that does and doesn't invalidate:
- **Still fully valid on both paths:** the cross-cutting failures — Aadhaar auto-fill getting the applicant's own name wrong (#10), the pre-ticked correspondence-address checkbox (#11), the confetti screen that is actually a pause (#12), the stepper label being coarser than the real screen. These are properties of Avanse's UI, not of which branch you're on.
- **Deprioritised, not deleted:** the co-applicant-specific screens. Keep them documented — the fallback case does still occur — but they should not drive the agent's tuning.

**🕳️ The honest gap: the happy path has never been walked.** Every screenshot we hold is from the co-applicant branch. Nobody has yet gone through Avanse as a single **earning** applicant, so the following are genuinely unknown and must not be guessed at:
- What Applicant Details asks for when `Applicant is` is set to an **earning** option — the option's exact label is itself unconfirmed, since only "Non-earning" was ever selected.
- Whether Income Verification and bank verification look different with no co-applicant attached.
- Whether the 5-stage stepper behaves differently, or skips stages, on a single-person application.

The expected happy-path sequence — **sign-in → consent → course selection → Applicant Details (earning) → personal details → address → income → bank verification, with no co-applicant screens at all** — is a reasonable inference from what we saw, *not* an observation. Walking it is the highest-value next research step, and it is what should ground the agent's tuning.

**One more thing the agent must not assume:** on the happy path the person on the call is most likely **a parent acting as the primary applicant, not the student**. Guidance phrased as "you, the student…" would be wrong in the common case.

### Observed screens and fields (reference for grounding the agent)

Everything below is what we **actually saw** on the live site. Anything not directly observed is marked as unknown rather than guessed — do not let the agent assert the unknowns as fact.

**Screen 1 — sign-in** (`online.avanse.com`)
- Single field: `Phone Number / Email ID`, then a **Get OTP** button. Helper text: "Verification code will be sent to the above information."
- No password. "Not yet a member? Sign Up!" links to `/signup` (signup flow itself not walked — unknown).
- A support number is in the header: **1800-266-9722** — useful for the agent to hand off to when something is genuinely Avanse's problem, not ours.

**Screen 2 — dashboard** (`/my-loans`)
- Greeting "Hi \<name\>", then **My Loan Applications** with two buttons: **Apply Now** and **My Offers**.
- Tabs: **All | Pending | Disbursed**. Empty state reads **"No Application Found"**.
- **Update (2026-08-03, real logged-in screenshot)**: a non-empty dashboard shows real application cards instead — Application Number (e.g. `AVUPSKL020826176243`), status chip **"In-Progress"** with a stage tag in parentheses (`(Applicant Details)`, `(Course Details)`), Institute, Course Name, Loan Amount, and **View Details** / **Continue Application** buttons. Confirms the dashboard is where to check for a submitted application, not the post-Submit screen itself — see the corrected Screen 4 note below.

**Screen 3 — the "Apply Now" modal.** Title matches the chosen type (we saw "Executive Education"). Fields, with `*` exactly as the site marks them:

| Field | Required | What we saw | Notes for the agent |
|---|---|---|---|
| `Select Type` | **Yes** | dropdown, "Executive Education" | **Other options unknown** — we only ever saw this one selected. Agent must read the open dropdown off the screenshot rather than recite a list it doesn't have. |
| `Name` | **Yes** | free text | Should match the applicant's KYC documents — see the mismatch risk below. |
| `Email Id` | **Yes** | free text | |
| `Phone Number` | **Yes** | free text, 10 digits | |
| `Loan Amount` | **Yes** | raw number, `500000`, no separators | No commas, no ₹ symbol, no lakh/crore toggle. See the zero-counting risk below. |
| `Time of Study` | No | `07/2026` | Format appears MM/YYYY. **Start vs end vs intake month is not labelled** — genuinely ambiguous. |
| `Place of Study` | No | `mumbai` | City? Country? Institute? Not labelled. |
| `Admission Status` | No | free text, we typed `ongoiing` | **Free text with no dropdown and no examples** — and note our own test typo went through unvalidated. |

Then a single **Submit** button.

**Screen 4 — after Submit:** on 2026-07-30 this returned to the dashboard showing **"No Application Found"** (see the dead-end note above), with no reference number, no confirmation, no visible next step. **Not yet re-walked live to confirm which outcome (this, or the persisted-card behaviour seen 2026-08-03) actually follows a fresh Submit.**

---

**The screens below (5–8) are from the invite-path walkthrough (2026-08-04) — see "Two distinct entry paths" above. This is the flow real referred applicants take.**

**Screen 5 — Avanse's own consent / Key Facts Statement screen.** Reached after landing from `upsy.in`, before the wizard proper. Scrollable legal text (digital-lending KFS-style disclosures: processing time up to 30 days, product tenor up to 36 months, interest rate up to 25% p.a.) followed by a checkbox — *"I agree with the above-mentioned details and provide my consent for the same"* (authorizes Avanse and third parties to pull credit bureau records, and to contact via WhatsApp/call/SMS overriding NDNC registration) — then an **Accept & Continue** button. Distinct from, and separate to, UPSY's own DPDP consent gap noted in Phase 2 below — this is *Avanse's* consent screen, not ours.

**Screen 6 — 5-stage wizard overview.** A one-time explainer screen (*"Hey, it's time to walk you through the easy application process for your reference and understanding"*) names the wizard's real stages in order, confirmed directly from the site (supersedes the guessed stage names inferred earlier from dashboard tags):
1. **Course Selection** — "Select the course of your choice to fulfill your academic aspiration."
2. **Applicant Details** — "Tell us a little more about yourself to help us build a customized financing plan."
3. **Income Verification** — "Upload your income documents for a quick verification."
4. **KYC Verification** — "An easy procedure to know you better and thus, serve you better."
5. **Additional Documents** — "Finally, upload some important documents to complete the application process."

A persistent stepper at the top of every subsequent screen shows which of these 5 stages is active. Button: **"Ready to Apply? Let's Start!"**. *(Note: the dashboard card stage tag seen earlier — `(Course Details)` — likely refers to this same "Course Selection" stage under a slightly different label; not fully reconciled.)*

**Screen 7 — Applicant Details, sub-screen (a): Student & PAN** (`online.avanse.com/applicant-eligibility`)

| Field | Required | What we saw | Notes for the agent |
|---|---|---|---|
| `Student Name` | **Yes** | free text | |
| `Student Relation` | **Yes** | dropdown, "Myself" | Who the student is relative to the person filling the form. |
| `Loan Applicant Name` | **Yes** | free text | |
| `Applicant is` | **Yes** | dropdown, "Non-earning" | **Live behaviour confirmed**: selecting "Non-earning" immediately shows inline text — *"Since you have selected the 'non-earning' option, you will need a co-applicant to complete the application process."* This is a real, on-screen eligibility branch, not a guess. |
| `Upload Applicant PAN` | shown as required for Next to enable | image upload | **JPEG / JPG / PNG only — explicitly no PDF option on this field**, unlike UPSY's own document capture which reads PDFs via Claude. |
| `PAN Number` | **Yes** | free text | Paired with the PAN image upload above. |

**Screen 8 — Applicant Details, sub-screen (b): Personal details** (still under "Applicant Details" in the stepper)

| Field | Required | What we saw | Notes for the agent |
|---|---|---|---|
| `Your Name` | **Yes** | free text | Seen filled as a full three-part name distinct from the shorter name typed on the previous sub-screen — worth having the applicant keep these consistent with each other and with their PAN. |
| `Phone Number` | **Yes** | free text, 10 digits | |
| `Email` | **Yes** | free text | |
| `Father's Name` | **Yes** | free text | |
| `Date of Birth` | **Yes** | date, e.g. `22 January 2007` | |
| Gender | shown as a required toggle | Male / Female buttons | Binary toggle only — no other options observed. |
| `Marital Status` | **Yes** | dropdown, "Single" | |

**Screen 9 — Applicant Details, sub-screen (c): Address Detail** (`online.avanse.com/address-details/<id>`)

Two tabs: **"Permanent and Current Address"** and **"Correspondence Address"**.
- **Permanent Address Details** carries an explicit on-screen disclosure: *"Once you upload the Aadhaar softcopy, the address will be automatically captured. Please verify this information thoroughly, as these details will be stored in our records permanently."* — followed by an **Upload Aadhar** control (JPEG shown in practice).
- Fields once populated (required, marked `*` on-screen): `Flat No./Building Name`, `Street Name`, `Landmark`, `Pincode`, `City`, `State`, `Country`.
- A checkbox — **"My Current Address is same as Permanent Address"** — when checked, mirrors the Permanent fields into a separate **Current Address Details** block with the same field set.
- The **Correspondence Address** tab has its own checkbox — **"My Corresspondance Address is same as Permanent Address"** (typo is on the live site, not ours) — same mirroring behaviour, same field set, ending in a **Next** button.

**Screen 10 — Applicant Details, sub-screen (d): Co-applicant details.** Reached because Screen 7 earlier had `Applicant is: Non-earning`, which requires a co-applicant (see failure mode #6/#7 below — this is that requirement actually appearing). The applicant's own PAN field is shown above it already verified (green checkmark), then:

| Field | Required | What we saw | Notes for the agent |
|---|---|---|---|
| `Co-applicant's Name` | **Yes** | free text, e.g. "VINAY KAILASHNATH PANDEY" | |
| `Phone number` | **Yes** | free text, 10 digits | |
| `Email` | **Yes** | free text | |
| `Father's Name` | **Yes** | free text — the co-applicant's *own* father's name, not the primary applicant's | |
| `Date of Birth` | **Yes** | date | |
| Gender | required toggle | Male / Female | Same binary toggle as the primary applicant's screen. |
| `Co-applicant's Relation` | **Yes** | dropdown, "Father" | Relation of the co-applicant to the primary applicant. |
| `Marital status` | **Yes** | dropdown, "Married" | |

A PAN upload + PAN Number pair for the co-applicant is implied by the same pattern as Screen 7 (partially visible above the fields captured here, already showing verified) — not yet confirmed field-by-field the way Screen 7 was.

**Screen 11 — ⚠️ the co-applicant hand-off screen. (Confirmed, 2026-08-04 — genuinely new pause point, distinct from the earlier quick-form "missing co-applicant fields" finding #7)**
After submitting Screen 10, the flow shows: *"The co-applicant's verification is pending. Please check your email & SMS for further instructions to complete the verification process."* with **Go Back** and **HOME** buttons. **The primary applicant's own progress stops here** — completing the rest of the wizard now depends on a *different person* (the co-applicant) independently receiving and acting on their own email/SMS, outside the call the agent is on.
⚠️ **Visual trap worth flagging on its own**: the illustration on this screen is two people jumping with confetti — visually reads as a *success/completion* screen, not a paused/blocked one. An applicant (or an agent glancing at a screenshot without reading the text) could easily mistake this for "done," when the application is actually stalled pending someone else's action.

**⚠️ Correction to the 5-stage model (Screens 12–14 below):** Screens 12, 13, and 14 all still show **"Applicant Details"** as the active stage in the top stepper, not "Income Verification" — even though Screen 12 is literally titled "Co-applicant's income details" and Screen 14 is a full bank-verification screen. So the 5 named stages from Screen 6 are **coarser than the real sub-screen sequence**: "Applicant Details" as a stepper label apparently covers primary applicant profile + address, *and* the entire co-applicant profile + address + income + bank flow. What (if anything) "Income Verification" as its own stage covers — the primary applicant's own income, since this one is `Non-earning`? something else? — is now an open question, not the assumption it looked like from Screen 6 alone.

**Screen 12 — Co-applicant's income details** (still under "Applicant Details" per the stepper — see correction above)

| Field | Required | What we saw | Notes for the agent |
|---|---|---|---|
| `Occupation Type` | **Yes** | dropdown, "Salaried" | Other options unknown. |
| `Company Name` | **Yes** | free text, e.g. "huhtamaki" | |
| `Designation` | **Yes** | free text, e.g. "superviser" (typed as-is, unvalidated) | Like `Admission Status` in the older quick form (failure mode #3), free text with no visible validation. |
| `Work Experience` | **Yes** | dropdown, ">3 Years" | Other bands unknown. |
| `Sector` | not marked required on screen | dropdown, "Private Sector" | |
| "Is your salary credited directly to your bank account?" | shown as required | Yes / No toggle, Yes selected | |
| "Is your work related to any of the following sectors?" | unknown | cut off before scrolling further | **Not yet observed** — likely a sensitive-sector/blocklist question (common in lending KYC), but the actual options are unknown. Do not guess a list. |

**Screen 13 — Co-applicant's own Address Detail.** Same two-tab pattern as Screen 9 (Permanent and Current Address / Correspondence Address), same Aadhaar-auto-capture disclosure and same field set — but this time scoped to the **co-applicant**, confirmed by a field not present on the primary applicant's version: **`Applicant Name`** (shown pre-filled, e.g. "Vinay K Pandey") naming whose address this is. Different URL id per person (`/address-details/178015` for the primary applicant vs `/address-details/178021` for the co-applicant) confirms Avanse tracks each person's address as a fully separate record — worth the agent knowing addresses are asked twice, once per person, not shared.

**Screen 14 — "Verify your Bank Account"** (heading "Bank Account Details"). Offers **three distinct verification paths**, not just a single upload:
1. **Account Aggregator** button — bullet copy: *"Provide mobile number linked to the Bank Account"* and *"If your bank account gets verified successfully, you will not be required to provide any proof for Bank Account."* (India's RBI-backed Account Aggregator / consent-based data-sharing framework.)
2. **or** — **Upload your Bank Statement**: *"Upload your last 6-month bank statements"* (info icon present, tooltip content not read), starting with a `Bank Name` field (**required**), file upload not yet reached in this walkthrough.
3. **or** — a **"Net Banking"** link at the bottom, presumably a third path (bank login/net-banking-based verification) — not opened, contents unknown.
→ *Worth flagging for later, not building now:* UPSY's own `backend/bankStatement.js` already reads the co-applicant's bank statement (name, address, phone) as part of its own document verification. If UPSY has already verified this before the applicant reaches Avanse, that's a second instance of the "we already know the answer" advantage from failure mode #6 — potentially able to tell the applicant which of these three paths will be fastest, or pre-empt a mismatch. Not scoped yet, just noted so it isn't lost.

**⏸️ Walkthrough paused here (2026-08-04) — to be continued in a future session.** Everything above Screen 14 is confirmed by direct testing. Still completely unexplored: the rest of Income Verification (if it's even a separate stage — see the correction above), all of KYC Verification, and all of Additional Documents. Pick up from Screen 14 next time rather than re-walking earlier screens.

**⚠️ Explicit scope decision (2026-08-04): live-assist coverage stops at Screen 14, on purpose.** The team's call is that the UPSY live-assist agent should be the one helping the applicant, in the Meet call, through everything from the `upsy.in` invite (Screen 0) all the way through co-applicant bank verification (Screen 14) — i.e. the whole "Two distinct entry paths" flow, sign-in, the 5-stage wizard, both people's Applicant Details, and bank verification. **Whatever comes after Screen 14 (KYC Verification, Additional Documents, and anything past that) is manual for now, not in scope for the agent.** This is a scope boundary for the spec, not a technical limitation — it should shape what "Ground the prompt in Avanse's actual form" (the ⏸️ PAUSED Avanse-precision block below) actually covers, and it may move once KYC Verification / Additional Documents are themselves walked and understood.

### Where applicants will get stuck — and what the agent should do

This is the working list the Avanse-precision phase is built from. **Confirmed** = we saw it ourselves; **Likely** = reasoned from the form's shape, not yet observed, so treat as a hypothesis to verify rather than fact.

**1. The submit dead-end — highest impact. (Downgraded to Likely, 2026-08-03 — see correction below)**
On 2026-07-30, Submit returned "No Application Found" with no reference number and no next step, in-browser. A 2026-08-03 screenshot of a real logged-in dashboard showed the opposite: submitted applications persisting as **In-Progress** cards with an Application Number and a stage tag (`(Applicant Details)`, `(Course Details)`) plus a **Continue Application** button — i.e. a real, resumable multi-stage application, not a dead end. Which behaviour is typical is now unconfirmed; both are recorded here rather than picking one.
→ *Agent:* warn **before** Submit that the next screen may not immediately confirm success, so it isn't alarming either way. Afterwards, **check the main dashboard for a new card** (Application Number + stage) — that is the more reliable confirmation seen so far. Only fall back to "I genuinely don't know, here's the support line (1800-266-9722)" if no such card appears.

**2. `Loan Amount` is a bare number — the zero-counting trap. (Confirmed)**
No commas, no ₹ symbol, no lakh/crore selector. Indian applicants think in lakhs; the field wants rupees. "Fifteen lakh" is `1500000`, and one missing zero makes it `150000` — a tenfold error that silently becomes the wrong loan.
→ *Agent:* have them say the amount aloud in words and count the zeros together. **Caveat that matters:** our vision model is `openai/gpt-4o-mini`, which this repo has already caught misreading digits non-deterministically (₹1,39,100 vs ₹13,91,000 on the same file — see "Income eval harness"). So the agent reading the number back off a screenshot is itself unreliable. It should reason from what the applicant *says* they want, not from pixels it may have misread — or we put Claude on this path first (Phase 0).

**3. `Admission Status` is unvalidated free text. (Confirmed)**
No dropdown, no examples, no validation — our own test typo, `ongoiing`, was accepted without complaint. Nobody knows what vocabulary Avanse's underwriting expects.
→ *Agent:* help them state it plainly and correctly spelled ("admitted", "applied, awaiting decision"). It must **not** invent an official list of accepted values, because we don't have one.

**4. `Time of Study` and `Place of Study` are ambiguous. (Confirmed)**
`07/2026` — is that the course start, the end, or the intake? `mumbai` — city, country, or institute? Neither is labelled. For a study-abroad applicant "place of study" is a genuinely open question, and a wrong study date flows straight into the moratorium calculation.
→ *Agent:* explain the most reasonable reading, flag the ambiguity honestly rather than asserting, and suggest the unambiguous form (e.g. course start month; city plus country).

**5. `Select Type` mis-selection. (Confirmed field, options unknown)**
We only ever saw "Executive Education" chosen; the rest of the dropdown was never opened. Choosing the wrong product type could mis-route the entire application.
→ *Agent:* ask them to open the dropdown and read the options **off the screenshot**, then reason about which fits. Never recite a list we don't have.

**6. Name mismatch against KYC — the one where UPSY has an unfair advantage. (Likely)**
`Name` is free text. If what they type differs from their PAN/Aadhaar (initials, married name, spelling), downstream verification stalls. Avanse's form has no way to catch this at entry.
→ *Agent:* **UPSY already knows the answer.** We extract the cardholder name off their PAN/Aadhaar (`backend/capture.js`) and already have `namesMatch()` for exactly this comparison. Feeding the verified KYC name into the call context lets the agent say "your PAN reads *Aarav Sharma* — type it exactly that way." This is real value Avanse's own form structurally cannot provide, and it is the strongest argument for this whole feature.

**7. Missing co-applicant fields set the wrong expectation. (Confirmed absence)**
The quick form asks nothing about a co-applicant, while UPSY collects co-applicant identity, income and bank data in depth. An applicant primed by UPSY may hunt for fields that aren't there and think they've done something wrong.
→ *Agent:* reassure that this first form is only intent capture; co-applicant details come later in Avanse's process.

**8. OTP on the same phone they're screen-sharing from. (Likely)**
Sign-in is OTP to phone or email. On a mobile screen-share the OTP notification interrupts the shared screen.
→ *Agent:* expect a gap, don't fill the silence, wait for them to come back.

**9. ⚠️ Our own privacy exposure — a risk we create, not one Avanse has. (Confirmed by design)**
The applicant screen-shares a page where they type their name, email and phone, and we screenshot it every 5 seconds and send it to OpenRouter. The system prompt forbids *reading numbers back aloud*, but that does not stop the pixels being transmitted. If they later reach a KYC upload step, ID documents would be captured the same way.
→ *This is a Phase 2 compliance item, not a prompt tweak.* It belongs in the DPDP consent conversation, and the applicant should be told what the agent can see before the screen share starts. Flagged here so it isn't discovered late.

**10. ⚠️ Aadhaar auto-extraction gets fields wrong — hit directly during live testing, not a hypothesis. (Confirmed by first-hand use, 2026-08-04)**
Avanse's own Address Detail screen (Screen 9 above) auto-captures the permanent address from an uploaded Aadhaar softcopy, and its own on-screen text already warns applicants to verify it. During an actual walkthrough, **the auto-extraction got more than the disclosed field wrong — the applicant's own name came out wrong and had to be manually corrected**, alongside other misreads. This is the same failure class this repo has already documented for its own vision pipeline (see the Aadhaar/PAN/income digit-accuracy findings elsewhere in this README) — except here it's happening on **Avanse's** extraction, which UPSY has no ability to fix, only to catch. Unlike our own pipeline, Avanse's has **no Verhoeff-checksum-style backstop** that we know of.
→ *Agent (not yet built — noting for the spec, not fixing now):* whenever Avanse auto-fills a field from an uploaded document (address on Screen 9, and potentially name/other fields elsewhere in the wizard), proactively tell the applicant **not to trust the auto-fill by default** — to actually read every auto-populated field aloud or carefully before moving on, the same way the agent already treats vision-model reads of its own screenshots as unreliable (see failure mode #2 above). This is a real, live-confirmed failure, not a defensive guess.

**11. ⚠️ The Correspondence Address tab gets skipped past without real scrutiny. (Confirmed by first-hand use, 2026-08-04)**
The Correspondence Address tab (Screen 9) defaults to a checked **"My Correspondance Address is same as Permanent Address"** box (note: that's the live site's own typo, not ours) that silently mirrors the Permanent Address fields. During testing, this is a spot applicants pass through without really registering — an applicant who *does* need a different correspondence address is likely to leave the default checked without noticing, or in the opposite direction, to click into the tab, get confused by the auto-filled/greyed values, and think something is broken. Several such small corrections had to be made by hand during this walkthrough (the applicant's own name being one of them, tied to finding #10 above).
→ *Agent (not yet built — noting for the spec, not fixing now):* explicitly ask whether the applicant's correspondence address is genuinely the same as their permanent address before letting them tab past this screen, rather than assuming the pre-checked default is correct. This is exactly the kind of easy-to-miss checkbox a human loan officer would normally catch by watching over someone's shoulder — which is the whole reason a manual-assist substitute doesn't scale and the agent needs to catch it instead.

**12. ⚠️ The co-applicant hand-off looks like success but is actually a stall. (Confirmed by first-hand use, 2026-08-04)**
See Screen 11 above. Once the primary applicant submits co-applicant details, Avanse shows a celebratory-looking screen (confetti, people jumping) whose actual text says verification is *pending*, not complete — and the real next step depends on the co-applicant, a different person, independently checking their own email/SMS. Nothing in the wizard tells the primary applicant what happens if the co-applicant misses that message, delays, or doesn't recognize the email as legitimate.
→ *Agent (not yet built — noting for the spec, not fixing now):* explicitly tell the applicant this is a pause, not completion, and that a second person now has to act — coach them on what to tell the co-applicant to expect (a message from Avanse, to check email and SMS) before ending the call, since the agent won't be there when the co-applicant actually receives it. Do not let the celebratory illustration be read as confirmation of anything, and revisit failure mode #7 above — it undersold this: the real gap isn't "the form doesn't ask about a co-applicant," it's "the form asks, then blocks on a handoff to someone who isn't on this call."

**Why this list matters right now:** every one of these is something a human loan officer would normally catch by manually watching the applicant fill the form — which is exactly what doesn't scale, and exactly why the live-assist agent exists. Findings #10–#12 above were hit directly during a real walkthrough, not reasoned out in advance — more of this kind are expected as further screens (Income Verification, KYC Verification, Additional Documents) get walked and documented the same way.

### Live-call assistance via AgentCall (built + tested live, 2026-07-31)

Team request over WhatsApp: mimic what **RevRag AI** (revrag.ai — "#1 In-App AI Agents Platform," embeds AI agents directly into a BFSI product to automate onboarding and re-engage drop-offs) does, but for a partner lender's product UPSY doesn't control the codebase of (e.g. Avanse) — an "out-of-app" equivalent, since we can't embed an agent inside someone else's site. Uses [AgentCall](https://agentcall.dev) (`pattern-ai-labs/agentcall`, MIT-licensed `join-meeting` skill) to join a real Google Meet/Zoom/Teams call as a bot.

**How it works**: the applicant is on a call alone with the AI agent (no human loan officer needed) and screenshares their own screen (e.g. `online.avanse.com` or another partner lender's real form). The agent periodically screenshots what's on screen and talks the applicant through it via voice, grounded in what it sees plus UPSY's own loan-domain knowledge. It never touches the form itself — the applicant fills it, guided by voice only, same trust boundary as every other LLM-assist feature in this repo (never auto-fills/auto-submits KYC-adjacent fields, and is explicitly instructed to never read back PAN/Aadhaar/account numbers even if visible on screen).

**Two-stage build, because the first version was too slow to be usable:**
1. **Interactive prototype first** (a human — Claude Code — manually relaying every event through this chat session): proved the concept (voice both ways, screen capture worked) but had multi-second-to-two-minute response latency, because every reply required a full agent turn (read notification → think → run a tool call). Not fixable by "trying to be faster" — it's structural.
2. **Standalone service, rebuilt for real-time** (`backend/liveAssist.js`): a plain Node script with no human in the loop. It spawns the vendored AgentCall bridge (`backend/agentcall/bridge.js`, MIT-licensed, copied from the skill repo — only dependency is `ws`), and on every `user.message` event calls OpenRouter directly (same `OPENROUTER_API_KEY`/`OPENROUTER_VISION_MODEL` as the rest of the repo) with the latest screenshot + short conversation history, then sends the reply straight to `tts.speak`. Screenshot polling runs on its own 5s timer, decoupled from response latency. This is the version actually wired into the product.

**Identity & tuning** (per team request): bot name `UPSY` (was `Nova`), voice `am_adam` (male). System prompt embeds UPSY's actual eligibility rules copied from `backend/eligibility.js` (60% academic minimum, family-only co-borrower, NRI requirements, ~24× income loan bands, moratorium formula, indicative rates) so its numbers stay consistent with what UPSY itself would tell the same applicant — explicitly caveated that a specific lender's own policy may differ.

**Three places it's wired in, all sharing the same start/stop API** (`POST/GET /api/applications/:leadId/live-assist`, `POST .../live-assist/stop`, managed by `backend/liveAssistManager.js` — one call at a time across the server, matching AgentCall's free-plan concurrency limit):
- **Team dashboard** (`team.js`) — an officer can start a call scoped to a specific applicant.
- **Applicant's completion screen** (`app.js`, `renderDone()`) — self-serve, next to the matched-lender cards, for use once they're about to apply with a real lender.
- **Ask UPSY panel on every document page** (`app.js`, `/docs/N`) — a compact version, since the team's actual point was "we need it where the applicant is filling out a form," not just after the fact. Same backend, a `compact` flag on `loadLiveAssistApplicant()`/`liveAssistIdleHtml()`/`liveAssistRunningHtml()` picks the shrunk-down sidebar variant vs. the full card.

When started from any of these, `--context <base64-json>` passes that specific applicant's real name/course/eligibility/document-count into the system prompt (built in `liveAssistManager.js` from `getApplication(leadId)` — never PAN/Aadhaar/account numbers, only summary facts), so answers are grounded in that lead's actual record, not just generic rules.

**The actual runtime flow** (worth reading before touching any of this — it's what the "own the stack" phase in the roadmap is measured against):

```
[Officer on team.html]  OR  [Applicant on /docs sidebar or /docs/done]
              │  paste Meet link → Start call
              ▼
   POST /api/applications/:leadId/live-assist          ← ours (server.js)
              ▼
   liveAssistManager.startCall()                       ← ours
     • getApplication(leadId) → name/course/eligibility/doc-count
     • base64 it → --context ; spawn liveAssist.js ; log live_assist_started
              ▼
   liveAssist.js  ──spawns──►  backend/agentcall/bridge.js
                                    │  POST api.agentcall.dev/v1/calls
                                    │  WS   /v1/calls/:id/ws
                                    ▼
                    ╔═══════════════════════════════════╗
                    ║  AGENTCALL CLOUD                  ║
                    ║  headless Chrome joins the Meet   ║
                    ║  as participant "UPSY"            ║
                    ╚═══════════════════════════════════╝

   ── per turn ──────────────────────────────────────────────────
   applicant speaks
     → THEIR browser hears it → THEIR STT              ← AgentCall
     → user.message ──WS──► bridge ──► liveAssist.js
     → OpenRouter (gpt-4o-mini) + latest screenshot    ← OURS  ★ the thinking
     → tts.speak ──WS──► THEIR TTS → audio into call   ← AgentCall

   every 5s, on an independent timer: screenshot → JPEG → latestScreenshot
```

Note the ★ line is the *only* part that is ours at runtime. Everything above and below it is AgentCall acting as a microphone, speaker, screen, and a pair of legs that can walk into a meeting.

**Verified live, multiple times**: joins a real Meet, greets automatically, answers questions, both starts and ends cleanly from all three UI surfaces; `live_assist_started`/`live_assist_ended` land on the applicant's Activity timeline each time.

**✅ Fixed (2026-08-05) — stop now waits for the process to actually exit.** `POST .../live-assist/stop` used to send `SIGINT` and return immediately, so the frontend's instant status re-check often still saw the call running and flickered back to "in progress" before settling on idle. `stopCall()` in `liveAssistManager.js` now resolves on the child's real `exit` event, escalating to `SIGKILL` after 3s so a wedged process can never keep holding the single global call slot. Verified against real child processes, including the already-exited and never-exits cases.

**⚠️ Platform caveat found while testing that fix: `SIGINT` behaves differently on Windows.** On Linux — which is what Render runs — `child.kill("SIGINT")` delivers the signal, so `liveAssist.js`'s handler runs, sends `leave` to the bridge, and the bot exits the meeting gracefully before the process dies. **On Windows, `child.kill("SIGINT")` force-terminates the child outright and the handler never runs** (verified directly: a child with a `process.on("SIGINT")` handler was killed without it firing). Consequence: in local Windows development the `leave` command is never sent, so the bot may linger in the meeting until AgentCall times it out on its own. Production behaviour on Render is unaffected; this only bites local testing.

**How much of this is actually AgentCall vs. ours** (came up when deciding whether to keep the dependency):
- **100% AgentCall, not worth rebuilding**: joining a live Google Meet/Zoom/Teams call as a bot at all — browser automation per platform, waiting-room handling, pulling real meeting audio out and injecting synthesized audio back in, screenshotting the shared screen. This is deep WebRTC + browser-automation infrastructure that breaks whenever the meeting platforms change their UI — realistically weeks-to-months of dedicated engineering to replicate, not something worth doing unless this becomes a much bigger strategic bet.
- **0% AgentCall, fully ours already**: everything the bot actually *thinks* — the system prompt, eligibility grounding, per-applicant context, the "never read back PAN/Aadhaar" rule, deciding what to say and when. AgentCall has no LLM of its own (its own bridge script says so explicitly); this layer was never theirs.
- **Swappable but not worth it yet**: speech-to-text and text-to-speech are commodity pieces (Deepgram, ElevenLabs, etc. all do this — AgentCall's pricing even has a "bring your own" tier for both), but AgentCall still has to carry that audio in/out of the actual meeting, so swapping these wouldn't reduce the real dependency — just add integration work for no gain today.

**Known gaps, honestly:**
- **Confirmed working on Render (2026-08-01).** `AGENTCALL_API_KEY` is declared in `render.yaml` and filled in on the dashboard (bridge.js reads this env var directly, same as it reads `~/.agentcall/config.json` locally — no code change needed). User-confirmed live on the deployed instance, not just locally.
- **One call at a time, globally.** `liveAssistManager.js` enforces a single active session across the whole server (matches the free plan's concurrency limit) — a second officer or applicant trying to start a call while one is active gets a clear error, not a silent failure, but this will need real concurrency handling before multiple simultaneous calls are a real requirement.
- **No fixture-tested against a real partner lender's full form yet** — verified with fake/test Meet URLs and the Avanse quick-apply form's first screen only (see "Partner-lender research" above); a full walkthrough of a real multi-step lender application hasn't been done live.

## Browser voice calls (`/upsy-voice-agent`) — tap a button on your phone and talk to UPSY (built 2026-08-06)

**The ask:** the team used [`profound.me`](https://profound.me)'s onboarding on a phone, had a ten-minute voice conversation with it, and wanted that — *"the response was insane, it was taking input like a live customer care is on the other end"* — as UPSY's mobile experience, with a call button at the top of the page.

### 🌿 The constellation is now the live loan file (2026-08-10)

Until today the star map behind a call was **hardcoded** — six fixed topics and a spotlight on a 7-second timer, pretending to follow a conversation it could not see. It now draws `callSchema.js` itself: **You → the four branches → a dot per question**, plus a fifth "Your number" node that lights when the FOIR becomes computable. Answered questions are warm/bright, pending ones dim, **ruled-out ones barely-there** (a salaried co-applicant's ITR dots fade rather than vanish — "not needed for you" is information), each branch shows "3 of 8", and a fact landing mid-call flashes an expanding ring.

Three server events feed it, all riding the socket the relay already owns:
- **`agenda`** — the branch/field map with a status per question (`agendaSnapshot()` in callSchema.js; labels and statuses only, no values). Sent at call start and after every extraction pass. `next` marks the first pending field in flow order — which is what the agent asks next by construction, since the prompt's COLLECTION_STYLE asks in branch order.
- **`focus`** — the relay word-matches each spoken agent sentence against field labels/asks (`matchAgendaField()`) and the page spotlights that dot. Cosmetic by design: a miss leaves the spotlight where it was.
- The existing extraction loop now runs every **3** caller turns (was 6 — fine for a dashboard nobody watches live, frozen-feeling for a caller looking at their own map), and **runs for anonymous callers too**: no account still means nothing is *stored* (same rule as the transcript), but the extraction feeds the live map and the mid-call prompt narrowing that used to be account-only.

The old topic ring survives as the fallback for any call where no `agenda` event arrives (echo mode, a future provider), and `matchTopic()`/the timed rotation are guarded off in agenda mode. `/upsy-voice-agent?debug` exposes `window.__upsyM.{showCall, applyAgenda, focusField}` so the map can be driven and screenshotted without a microphone.

### 🔎 The false-info check — is the course the caller named real? (2026-08-11)

The team's ask, verbatim in spirit: *"agar koi false info de toh hume pata ho — waisa course identify nahi hora online."* `backend/instituteVerify.js` is the scraper the schema had been waiting for: after an extraction pass lands an institute name, the relay fires one **web search → LLM judge** pass per distinct claim per call (off the voice path, nothing awaits it, cached per process). The judge reads ONLY the search snippets and returns `found` / `unclear` / `not_found`, plus a published programme fee when a snippet states one.

**Where the verdict goes:** `profile._verification` + `institute.feeVerifiedOnline`, then flags recompute — `not_found` raises the new **`course_not_found` threat**, and a published fee >25% away from the quoted one fires the pre-existing `fee_deviation` threat, which had been dormant since the schema landed. The underscore is load-bearing: the agent's prompt never sees the verdict, because **the agent must never accuse a caller of naming a course that doesn't exist** — a search miss is our evidence problem, and the flag is for the officer on `/team`. `unclear` raises nothing, same principle as every other flag rule: fire only on evidence.

**Search providers:** `SERPER_API_KEY` (google.serper.dev — free tier 2,500 queries) when set; otherwise DuckDuckGo's keyless HTML endpoint. ⚠️ **DDG answered with a bot-check (HTTP 202) from the dev machine on day one** — expect the keyless path to be flaky-to-dead depending on the IP, and treat the Serper key as the real path. Every failure is silence, never a flag. Judge verified against injected snippets: a real IIMB MBA → `found` with the ₹24.5L published fee extracted; an invented "MBA in Astro Finance" → `not_found`; thin results → `unclear`.

### 🎯 The agenda now leads with what decides the loan (2026-08-12)

The agent used to work the agenda in flowchart order — student, then institute, then loan, then co-applicant. That order is right and stays right for a call that runs its course. But **a caller who hangs up at four minutes left behind whatever happened to come first**: name, age, city, marks. No income, no amount, nothing an officer could act on. Nine fields are now marked **`essential`** in `callSchema.js` and named at the top of the agenda under "GET THESE FIRST".

**Which nine, and why exactly these:** they are what `computeUnderwriting()` actually consumes, plus the two that decide what follows. `institute.totalFee` and `loan.amountNeeded` are what is being borrowed; `coApplicant.monthlyIncome` / `annualItr` are what it is tested against; **`existingEmiMonthly` matters more than it looks — without it FOIR is computed as though the family has no debts, which flatters every single file**. `coApplicant.category` picks monthly-vs-ITR *and* the whole income document set; `loan.type` drops the property papers; `institute.name`/`course` drive the online verification and the course-level document rules.

**`essential` is not `required`.** Nothing here is required and a caller may refuse anything — the drop-it-and-move-on rule is untouched, and a refusal still lands in `_declined` and never gets asked twice.

Three things that had to move together, and are the reason this is not a one-line change:

- **The conditional income question carries its condition now.** An unknown gate keeps *both* income fields live on purpose (`fieldApplies`: "unknown gate ⇒ applicable"), so a must-have list would otherwise tell the agent to ask a salaried caller for an ITR. `conditionText()` renders `appliesWhen` as words — *"only if self-employed or farmer"* — inline in the agenda.
- **`agendaSnapshot().next` follows the same order**, or the `/upsy-voice-agent` constellation spotlights one dot while the agent asks about another. On a cold call `next` is now `institute.name`, not `applicant.name`.
- **The prompt gained a rule against marching.** The must-haves are what the agent steers toward, not a checklist to clear before it is allowed to be helpful — without that line, "get these first" reads as permission to interrogate.

**Once the essentials are in, the block inverts**: it stops pushing and says *"you already have everything the decision needs — take the rest only if the conversation goes there naturally, and let them lead."*

⚠️ **This was done for data quality, not cost.** At $0.028/min a 10-minute call is $0.28, so 100 callers is ~$28 and cutting four minutes off every call saves about $11. The reason to do it is that a short call now yields a decidable file instead of a random prefix of one. **The real per-client cost at this volume is SMS/WhatsApp**, which bills per DLT-registered message — see the nudge timings in "Ops & reliability".

### ⭐ Callers can rate the call now (2026-08-12)

Every judgement of the voice agent so far arrived by hand — the three fixes below came from one person saying *"she said yes, then stopped"* and *"it asked me three times"*. That is real feedback and it found real bugs, but it only ever arrives when somebody happens to mention it, and never from the caller we do not already know. `backend/reviews.js` gives it a path of its own: after a call ends, `/upsy-voice-agent` asks **five stars and an optional comment**, and `/team` grew a third list mode, **Feedback**.

**It only asks when there was something to judge:** at least **20 seconds and at least 2 caller turns**. Wall-clock alone counts a phone left on a table, and a four-second mis-tap is not a review — it is noise that would drag the average down for nothing. **And it asks once**: submitting *or* skipping stores a 7-day cooldown, because skipping is a real answer and a sheet that reappears after the next call is nagging rather than asking.

**A 1–2 star rating notifies ops; 4–5 only logs.** A happy caller does not need to wake anybody, and an unhappy one is worth hearing about while they might still be reachable. Each row also stores **call length and caller turns**, because a 1-star after fifteen seconds ("it could not hear me") and a 1-star after eight minutes are different complaints, and without that context every low score looks identical in the list.

The stars are **real radio inputs**, visually hidden with the SVG as the label — arrow keys, the tab stop and the announced group come free, where a div with click handlers would have to rebuild all three and usually rebuilds none. Comments are caller-typed free text rendered into an officer's `innerHTML`, so they go through `esc()` like everything else on that dashboard; verified with an `<img onerror>` payload that renders as text. ⚠️ `data/reviews.json` is on the same ephemeral disk as the rest of `data/`, so a Render respin wipes it — **the dashboard says so in the UI**, because an average that silently resets is worse than no average.

### 🧾 The first review round, and what it fixed (2026-08-11)

Three complaints from real testing, all shipped:

1. **"Newton School of Technology — BTEC program" got flagged `course_not_found`.** The caller said *B.Tech*; the recogniser wrote *BTEC*; the judge held the spelling against a real institute. The judge's rules now state the claim **came through speech recognition** — spelling is evidence of nothing — and `not_found` is reserved for **the institute itself**: a real institute whose snippets don't show the exact course caps at `unclear`, which raises no flag. Re-run on the exact case: `found`, with the judge noting "BTEC is speech recognition of B.Tech" and pulling the published fee.
2. **The yearly bonus was asked 2–3 times after "I don't know", and `/team` showed it as never asked.** The profile had no way to say *asked — no answer*, so the question stayed "missing" forever. The extractor can now return `{declined: true, said}` per field (rule 10); `profile._declined` carries the markers; `coverage()` takes declined questions **off the agenda and out of the denominator**; the prompt names them with "do NOT ask again"; `/upsy-voice-agent` fades their dots; `/team` shows them under **"Asked — no answer"**. Guards, because the very first test run needed them: a declined marker is accepted only with the **caller's own refusal, verbatim** — the quote must appear in caller turns (the agent's "Hi Aarav" greeting once vouched for a name-decline) *and* contain an actual refusal shape ("don't know", "rather not", "pata nahi"…). A dropped genuine decline just gets asked once more; an invented one would bury a question forever, so the guard errs that way.
3. **"Yeh not in upload flow kyu hai?"** — the call's document plan asked for documents `/docs` had no upload slot for. The flowchart's income-category set (Form 16, salary-account statement, joining letter, ITR ×3, income computation, current/savings account statements, utility bill) now lives in `documents.js` proper, gated by a new `coApplicantCategory` field so a salaried file never sees the ITR set and vice versa; `applicableDocuments()` is the one filter shared by the upload flow, the completeness gate and the voice agent's "what's pending" answer. The UG marksheet uploads through the existing degree-marksheet slot (alias in docPlan.js). The "NOT IN UPLOAD FLOW" tag on /team now has nothing to attach to — by construction, not by hiding the tag.

### 🔀 Switch providers by editing .env, nothing else (2026-08-11)

The whole system now follows one rule: **Claude first when `ANTHROPIC_API_KEY` is set; the OpenAI-compatible side otherwise; mid-call fallback between them when the preferred one fails.** Remove the Anthropic key → everything (voice brain, extractor, verifier judge, document vision, intake, assist, lender drafts, the Meet agent) runs on the other side; add it back → Claude everywhere. No code edits either way — verified by running the full `voice:relay` loop green with the Anthropic key deleted, then again with it present.

- `backend/llmProviders.js` decides what "the OpenAI side" is, in one place: **OpenRouter** when its key exists, else **OpenAI's own API** (`OPENAI_API_KEY`) with the `openai/` model-prefix stripped. Placeholder values (`your_…_here`) are treated as absent. Ten modules used to hardcode the OpenRouter URL each.
- **`liveAssist.js` was the one module that spoke only OpenRouter** — with only an Anthropic key the Meet agent refused to start. It now runs the same chain, including converting its screenshot messages to Anthropic's image format (the shape capture.js already uses). ⚠️ The Claude path there is **unexercised on a real Meet call** — the conversion mirrors proven code, but AgentCall minutes are scarce and nobody has spoken to it since.
- Boot lines name the active side per module (`Claude (…) → OpenRouter (…)`), so a key swap is visible in the first screen of logs rather than discovered on a call.

### What Profound actually does (researched from their shipped bundles, 2026-08-06)

Their onboarding is behind a phone-OTP gate we did not sign up for, but the whole app ships as public JavaScript. Read from `profound.me`'s own bundles:

- **Stack**: TanStack Start (React 19 + Vite SSR), TanStack Router + Query, shadcn/ui + Base UI + Floating UI, lucide icons, **Tailwind v4**, GSAP + SplitText, Motion, Lenis smooth scroll, Embla. Sentry + PostHog (proxied first-party through `/conduit/*` to survive ad blockers). Separate API at `api.profound.me`.
- **The call is not a meeting.** No LiveKit, no Vapi, no Daily, no Twilio, no WebRTC peer connection. It is a **raw WebSocket carrying base64 PCM**, and the client (`assets/cartesia-demo-*.js`, ~11KB) is nothing but an audio pump:
  `POST /api/…/start` → server returns `{signed_url, metadata}` → `new WebSocket(signed_url)` → mic via `AudioWorklet` (2048-sample frames, Float32→Int16→base64) → `{event:"media_input"}` up, `{event:"media_output"}` down → decode → `AudioBuffer` scheduled on a running `playbackQueueTime` cursor.
- **The client does no thinking at all.** STT, the LLM, TTS, turn-taking and barge-in are all **server-side inside Cartesia**. Their own UI text says the system prompt lives on the Cartesia dashboard and only `{{name}}` / `{{linkedin_data}}` are passed as `call_request.metadata`. The "live customer care" feel is a hosted voice agent, not something they engineered.

**The design lesson, separately:** their landing page is a pinned scrollytelling piece where nothing actually scrolls — copy blocks are `position:fixed` and swapped on a GSAP timeline over a WebGL canvas. Techniques worth stealing, and now used on `/upsy-voice-agent`: a **dark halo** (`radial-gradient(closest-side, …)` on a `::before`) behind every heading so text stays readable over a live background; a **second blurred text pass** via `content: attr(data-text)` purely to bloom; display type at **weight 400 serif** (bold reads cheap); `clamp(…, min(6vw, 8vh), …)` so type scales off the *smaller* viewport dimension; and on mobile specifically — **half the particle count**, DPR capped at 2, and a full static fallback for `prefers-reduced-motion`.

### What we built

`/upsy-voice-agent` is a **new page, not a route of the applicant SPA** — a different design (near-black blue, voice-first, phone-first) that shares nothing with `index.html` but the API. `/login → /intake → /docs` is untouched.

**Rebuilt 2026-08-07 around Profound's actual flow**, at the team's request, after seeing their onboarding on a phone. Four states in one page, no routing (Back should hang up, not navigate mid-sentence):

1. **Brief** — serif display heading, a *"What we'll cover next"* card numbering the three things the call covers, then **Schedule call** / **Allow Mic Permissions**. Permission is requested and immediately released *before* the call — its only job is to unlock device labels and get the OS prompt out of the way, because the browser reports unlabelled devices until permission is granted, and a picker reading "Microphone 1, Microphone 2" is worse than no picker.
2. **Device pickers + Join call** — replaces the permission button once granted. The speaker picker hides itself on Safari and Firefox, which do not expose output devices at all. `AudioContext.setSinkId` is Chromium-only and treated as a nicety that must never break a call.
3. **Connecting** — the logo tile over a ghosted mark.
4. **In call** — a **constellation**: "You" at the hub, six topic nodes around it, and a camera that eases toward one topic at a time while a large caption names it.

**The constellation is a map of what you can ask, not a transcript — and the copy says so.** We receive audio frames from Cartesia, not text, so the page *cannot* honestly claim to know what is being discussed. The spotlight rotates on a slow timer as an invitation. `matchTopic()` is wired to upgrade this the moment a real transcript event appears — `onEvent` sniffs for `text`/`transcript` and spotlights the matching topic, falling back to the rotation after 15s of no match. Nothing depends on that event existing; the first live call will say whether it does.

**Theme:** deep blue-black — the same hue family as UPSY's product blue, but darker and desaturated, because a voice surface held to your ear wants to be calm rather than bright. (It was built green first, matching Profound's own palette, and swapped to blue on 2026-08-07 at the team's call.) The `/login → /docs` flow shares the hue, not the stylesheet — nothing there changed. On a desktop the whole thing becomes a 400px phone-shaped frame centred on a light page, so the layout is never stretched to a width it was not designed for.

**Where the colour lives, if you retheme it again:** every value is a CSS custom property in `voice-agent.html`'s `:root`, *except* the constellation's canvas colours in `voice-agent.js` — a canvas cannot read CSS variables, so those five `rgba(...)` literals are the one place that has to be changed in step with the tokens. Both files say so in a comment. Verified after the swap: no colour on the page has a green cast, and every text/background pair clears WCAG AA (faint-on-ink 5.07:1, muted 8.52:1, body 17.08:1, button labels 5.11:1 and 16.09:1).

**"Schedule call" is a real callback request**, not a design flourish — `POST /api/voice/callback` → `backend/callbacks.js` → `data/callbacks.json`, announced on the ops channel and written to the lead timeline as `callback_requested` when the caller is signed in. This closes the roadmap item about anonymous callers evaporating: someone who has a good conversation, or who cannot get through because the agent is down, now leaves a name and a number behind. Numbers are normalized (`+91`, spaces and dashes all accepted; non-mobile prefixes rejected) and the confirmation echoes **the normalized number we will actually ring**, not the string they typed. `GET /api/voice/callbacks` is the officer-facing side.

```
[Applicant on their phone at /upsy-voice-agent]  ── taps "Call UPSY" (top right, always visible)
        │
        ▼
   POST /api/voice/session                        ← ours (server.js)
     • rate-limited 5 per 10 min per IP (public endpoint, billable per hit)
     • leadId from sessionStorage, if they signed in this tab
        ▼
   voiceCall.js                                   ← ours
     • POST api.cartesia.ai/access-token → short-lived, agent-scoped token
       (the sk_car_… account key NEVER reaches the browser)
     • builds the system prompt from voicePrompt.js + that lead's real facts
        ▼
   browser opens  wss://api.cartesia.ai/agents/stream/<id>?access_token=…
     • start event carries OUR system_prompt + introduction  ★
     • mic → AudioWorklet → PCM → media_input
     • media_output → PCM → AudioBuffer queue → speaker
        ▼
                    ╔═══════════════════════════════════╗
                    ║  CARTESIA                         ║
                    ║  STT + LLM + TTS + turn-taking    ║
                    ╚═══════════════════════════════════╝
```

**★ is where we deliberately diverge from Profound.** Cartesia's `start` event accepts `agent.system_prompt` inline, so the entire agent definition lives in `backend/voicePrompt.js` and is reviewed in git — rather than on a vendor dashboard where it is invisible to code review and drifts silently from `eligibility.js`.

**Three kinds of caller, one button.** They are independent — someone can be any one, or the last two at once — and `mergeCallerContext()` folds them into a single context rather than picking:
- **Anonymous** (no account, no login) — still the common case. The prompt says outright that it does not know who this is, must not guess a name or amount, and should point them at "Check my eligibility" when they are ready to apply.
- **Signed in with an `/upsy-voice-agent` account** (2026-08-07) — name from signup, plus everything earlier calls established. See "`/upsy-voice-agent` accounts and remembered calls" below.
- **Signed in through `/login` in the same tab** — `frontend/app.js` writes `upsy_lead` to `sessionStorage`, so the call is grounded in that applicant's real record: name, course, eligibility verdict, indicative amount, document progress, **the next document they still owe**, and the **name as it reads on their verified ID**. Same facts `liveAssistManager.buildContext()` feeds the Meet agent — names only, never ID numbers. `buildContextPayload()` is exported from `liveAssistManager.js` so both agents share one definition of those facts instead of drifting.
  - **Where the two disagree, the lead record wins.** It is built from verified documents and the eligibility engine; an account's profile is what a conversation established, which is weaker evidence.

**Voice-specific safety rules** (in `voicePrompt.js`, and genuinely different from the screen-share agent's): never ask the caller to say a PAN / Aadhaar / account number / OTP **out loud**, interrupt them if they start reading one, say it is an AI the moment it is asked, never promise an approval or a rate, and never claim to have done something it cannot do (it cannot see documents, upload anything, or check live status).

**What's verified and what isn't (updated 2026-08-06, against a real Cartesia account):**
- ✅ Server boots and prints `Voice calls: cartesia (agent agent_…, pcm_44100)`.
- ✅ Rate limiter unit-tested (blocks the 6th hit, per-key isolated, window expires, stale keys swept).
- ✅ Audio codec exercised directly via `UpsyVoice._codec`: sine round-trip accurate to ~1.8 LSB, clipping saturates without sign wraparound, 200k-sample frames survive `btoa`, 48k→44.1k resamples exactly.
- ✅ Page renders, fonts load, no horizontal overflow, call sheet centred.
- ✅ **`POST /api/voice/session` confirmed live against the real account**: HTTP 200, a real 263-char short-lived token minted at `api.cartesia.ai/agents/stream/<agent-id>`, our full system prompt attached, the account key never appears in the response. The whole server-side chain — rate limit → token mint → prompt build → per-lead grounding — works.
- ✅ **Root-caused the silent close (2026-08-07): the agent was never deployed.** See the block at the top of this README. Bisected against the live account — a bare `{"event":"start"}` fails identically to our full payload, so the request shape was never the problem. `checkAgentReady()` now catches this at boot and before every session; `npm run voice:check` reproduces the whole chain in one command.
- ✅ Our `start` payload independently confirmed correct against Cartesia's published protocol: `input_format: pcm_44100` is a valid value, and `config` / `agent.system_prompt` / `agent.introduction` / `metadata` are all accepted fields.
- ✅ **Barge-in is `clear`** — no longer a guess. Cartesia's protocol documents a `clear` event meaning "the agent is interrupting itself because the user started speaking". `voiceClient.js`'s defensive `/interrupt|clear|barge|cancel|flush/` already matches it; the regex stays because it costs nothing and still logs anything unrecognised.
- ✅ **`/upsy-voice-agent`'s own UI verified in-browser** (2026-08-07): brief scrolls inside a fixed frame with the actions pinned, no horizontal overflow at 375px or 1280px, the desktop phone-frame centres and fits, the constellation canvas sizes to exactly 2× its CSS box and paints, the spotlight caption populates, mute toggles state/aria/status, hang-up returns to the brief and clears focus, and the callback flow round-trips (validation → normalization → persisted to `data/callbacks.json` → ops log).
- ✅ **The undeployed-agent path verified end to end from the browser**: `POST /api/voice/session` → 503, the caller sees "UPSY's voice line isn't switched on yet", the developer detail names Publish as the fix, and it fails *before* the microphone is ever opened — so there is no stranded mic on this path at all.
- ❌ **Nobody has heard it talk yet.** Everything above the provider boundary is proven; the audio round trip is not, and cannot be until the agent is published.
- ❌ Not tested on a real phone yet. iOS Safari is the risk: the code resumes both `AudioContext`s inside the tap and resamples if the browser refuses 44.1kHz, but that is reasoning, not observation.
- ⚠️ CSS transitions and `requestAnimationFrame`/`ResizeObserver` callbacks were verified structurally, not visually — the automated browser pane does not composite, so nothing that depends on the rendering steps could be observed running. This is why the canvas re-measures explicitly in `map.start()` rather than trusting its `ResizeObserver`, and why the schedule sheet forces a reflow instead of waiting for a frame: both would otherwise never appear in a tab that is not compositing.

**Two dashboard gotchas found setting this up, worth knowing before creating an agent:**
- **A newly created Cartesia agent sits in "Building…" until you press Publish — and this is what actually broke `/upsy-voice-agent`.** Confirmed 2026-08-07, not theory: the symptom is a call that connects and then closes with `1011 Internal server error`, which names nothing and looks exactly like a bug on our side. `GET /agents/<id>` is the tell — `is_live: false` and `deployment_count: 0`. `npm run voice:check` reports it in one line.
- **The dashboard's own default system prompt includes a `web_search` tool and a "playful, matches your energy" persona** — both wrong for a loan agent (web search means the agent can state a lender's rate from whatever page it finds, not from `eligibility.js`). Our per-call `agent.system_prompt` override should replace it at runtime, but that override had never been tested against a real account until today, so pasting the anonymous-caller prompt (`buildVoiceSystemPrompt(null)`, regenerable any time — see `backend/voicePrompt.js`) into the dashboard too is the safe backstop in case the override silently doesn't apply.

**To turn it on:** create an agent at `play.cartesia.ai`, publish it, then put `CARTESIA_API_KEY` and `CARTESIA_AGENT_ID` in `.env` (both are `sync: false` in `render.yaml` for the deploy). Do not paste them into chat — if a key ever ends up in a chat session, treat it as compromised and rotate it.

**Why Cartesia first, and what comes after:** it is what Profound uses, so it is the shortest path to the feel the team asked for. But it is English-first, and a large share of UPSY's callers would rather be guided in Hindi. `voiceCall.js` is written as an adapter (`VOICE_PROVIDER`) and `voiceClient.js` is provider-agnostic by construction — it only knows "PCM over a WebSocket" — so the **Sarvam (TTS/STT) + Deepgram (STT)** path, using keys the team already has, slots in behind the same interface without touching the browser code. That is the next step, and it is the one that closes a real product gap rather than a cost one.

### Own the voice stack — costed 2026-08-07 (because Cartesia's deployment pause forced the question)

**Anthropic has no speech API.** Claude is the brain only; STT and TTS must come from somewhere else. "Build our own Cartesia" therefore means assembling four pieces, three of which we already have.

**Per minute of call**, assuming the applicant and the agent each speak ~40% of the time and the agent takes ~4 turns a minute, with our ~1.3k-token system prompt served from prompt cache:

| Piece | Provider | Rate | Per call-minute |
|---|---|---|---|
| Speech → text | Deepgram Nova-3 streaming | $0.0077 / min audio | **$0.008** |
| The thinking | Claude Haiku 4.5 ($1/$5 per MTok) | ~$0.002 / turn **uncached** — see below | **$0.008** |
| Text → speech | Cartesia Sonic | $0.03 / min generated | **$0.012** |
| | | **own stack, English** | **≈ $0.028/min** |
| Speech → text | Sarvam (Hindi) | ₹1.5 / min | $0.017 |
| Text → speech | Sarvam (Hindi) | ₹15–30 / 10k chars | $0.009 |
| | | **own stack, Hindi** | **≈ $0.034/min** |

**⚠️ Correction found while building it (2026-08-07): prompt caching will not fire, and this section previously assumed it would.** The original estimate called the system prompt "the single biggest cost lever" and costed the brain at $0.005/min on the assumption it would be served from cache. It will not be: **Claude Haiku 4.5's minimum cacheable prefix is 4,096 tokens**, and `buildVoiceSystemPrompt()` is ~1,300. A prompt below the minimum does not error — it silently does not cache, and `cache_creation_input_tokens` just reads 0. `voiceBrain.js` sends `cache_control` anyway (free, and it starts working if the prompt grows or the model changes) and **logs Anthropic's own cache counters on every turn**, so this is now checkable rather than assumed:

```
[voice:brain] claude usage in=1712 cache_read=0 cache_write=0
```

The practical answer is to stop worrying about it. Caching a 1.3k-token prompt would save ~$0.003/min; models with a small enough minimum to cache it (Opus 5 at 512 tokens) cost 5× more per token, which loses far more than it saves. **The corrected all-in figure is ~$0.028/min English, ~$0.034/min Hindi** — still well under hosted alternatives, and the conclusion below does not change.

Against the hosted alternatives: **OpenAI Realtime mini ≈ $0.02–0.05/min**, **full gpt-realtime-2.1 ≈ $0.06–0.11/min** (both token-billed, so the range is real and caching-dependent); **Cartesia's own agent product is plan-gated** rather than cleanly per-minute — Pro $4/mo, Startup $39/mo, Scale $239/mo, with credits and concurrency scaling by tier.

**At UPSY's likely volume the money is not the argument.** 1,000 calls × 5 minutes ≈ 5,000 minutes/month: ~$140 on our own stack, ~$175 on Realtime mini, ~$400 on full Realtime. Real, but not decisive. **The decisive reasons are that our own stack speaks Hindi, keeps the prompt and the eligibility grounding in git, and cannot be switched off by someone else's free-tier policy** — which is exactly what happened.

**What is already built and reusable unchanged:** `frontend/voiceClient.js` (the browser audio pump — it only knows "PCM over a WebSocket", which is what every provider on this list speaks), the whole `/upsy-voice-agent` surface, `voicePrompt.js`, the rate limiter, per-lead grounding, and the callback fallback.

**What is genuinely missing is one thing:** a server-side relay (browser ⇄ our server ⇄ STT/LLM/TTS) that handles **turn-taking** — endpointing (has the caller actually finished?), barge-in (kill in-flight TTS the moment they speak), and streaming TTS so the first syllable starts before the sentence is finished. That is the part hosted agents actually sell, and it is what makes Profound feel like "a live customer care rep." Do not hand-roll VAD for it — Deepgram's turn-detection model exists for exactly this. Honest estimate: **2–3 days to a call that works, 1–2 weeks for it to feel as good as Cartesia's.**

#### What Cartesia actually is, so we know what we are replacing

Established 2026-08-07 from their own API, their template catalogue and their source repo — not from marketing pages. Reproduce any of it with the key in `.env`:

```bash
# our agent's real config — note stt_preset, and note what is ABSENT
curl -s https://api.cartesia.ai/agents/$CARTESIA_AGENT_ID \
  -H "Authorization: Bearer $CARTESIA_API_KEY" -H "Cartesia-Version: 2025-04-16"
# the template it was built from, including its required env vars
curl -s https://api.cartesia.ai/agents/templates \
  -H "Authorization: Bearer $CARTESIA_API_KEY" -H "Cartesia-Version: 2025-04-16"
```

| Layer | What it is | Theirs? |
|---|---|---|
| Text → speech | **Sonic** — built on State Space Models rather than transformers (the company was founded by the Mamba/SSM authors). This is where the low latency comes from. | ✅ |
| Speech → text | **Ink-2** — our agent literally reports `stt_preset: "ink-2"`. | ✅ |
| Turn-taking | **Line** — orchestration, interruptions, barge-in. | ✅ |
| The thinking | **Any LLM, via LiteLLM** (100+ providers). Our `at_basic_chat` template declares `required_env_vars: ["ANTHROPIC_API_KEY"]`. | ❌ **not theirs** |

**They never sold us the intelligence.** Cartesia's own reference voice agent thinks with Claude, on your key — the same conclusion this README already reached about AgentCall ("0% AgentCall, fully ours already"). What a voice vendor actually sells is speech models plus turn-taking, which means **the stack planned above is architecturally identical to their own**.

**🎁 The accelerator, and the single most useful fact in this section: [`github.com/cartesia-ai/line`](https://github.com/cartesia-ai/line) is public and Apache-2.0, and it handles interruptions and turn-taking out of the box.** Steps 2 and 5 above — the honest risk in this whole plan — have a working reference implementation we are licensed to read. **Caveat: Line is Python and this server is Node**, so read it, do not import it; a Python sidecar would cost more in Render deployment complexity than it saves.

**⚠️ A governance gap worth its own line.** The hosted agent object exposes `llm_system_prompt` and `llm_introduce` and **no model field at all** — on that path we could not see or pin which model quotes eligibility rules and rate bands to loan applicants. For a lending product that is a real problem independent of the outage, and owning the stack fixes it. Related to, but separate from, the Phase 2 compliance gate.

#### Cartesia's plans, if the hosted path is ever revisited

Official monthly pricing (annual billing is 20% less — the $4/$39/$239 figures floating around are the annual rates):

| Plan | Price/mo | Credits | Agent minutes | Concurrency | Agent slots |
|---|---|---|---|---|---|
| Free | $0 | 20K | $1 prepaid | 2 TTS / 8 STT | 1 |
| **Pro** | **$5** | 100K | $5 prepaid | 3 TTS / 12 STT | 3 |
| Startup | $49 | 1.25M | $49 prepaid | higher | more |
| Scale | $299 | 8M | $299 prepaid | higher | 10 |

Two separate wallets, and the difference decides how to spend: **credits** feed TTS/STT (~750 credits per minute of generated speech, so 100K ≈ 133 min), while **agent minutes** are a separate prepaid balance for the hosted agent (~$0.05–0.06/min, so $5 ≈ 85 min).

**Which means using Cartesia for TTS only stretches the same $5 about 4×** — ~330 call-minutes (133 min of speech at ~40% talk time) versus ~85 on the hosted agent, with STT moving to Deepgram's free credit. Pro also adds a **commercial-use licence**, which the Free tier's feature list does not appear to include — worth confirming before any real applicant uses this.

**Ceilings to remember:** 3 concurrent TTS requests on Pro means at most 3 simultaneous callers server-wide, and ~85 agent-minutes a month is demo scale. The hosted path cannot carry production regardless of whether the deployment pause lifts.

*A shareable 3-page version of this analysis is generated at `UPSY-voice-decision-brief.pdf` (gitignored, since `*.pdf` is excluded for the real ITR fixtures).*

## `/upsy-voice-agent` accounts and remembered calls (built 2026-08-07)

**The gap this closes, stated plainly: every call was a first call.** The raw material was already there and was being thrown away — `voiceRelay.js` has emitted `transcript` events since the day it was written, `voice-agent.js` used them for exactly one thing (moving the constellation spotlight) and then dropped them, and `RelayCall.history` lived in memory and died with the socket. A caller could have a ten-minute conversation, hang up, ring back an hour later, and be greeted as a stranger. Nothing an officer could look at, either.

Team ask, verbatim in spirit: *a login page where the user signs in with their name and details, saved to the team page; after every call it updates; and the next call from the same account already has that person's data.*

### The identity decision, and why it went the way it did

**It is a standalone account, not the lead record — and that was the team's explicit call.** The alternative on the table was resolving the caller's mobile to the same `leadId` that `/login` uses, so a voice caller and a borrower file would be one row. The team chose standalone, on the reasoning that `/upsy-voice-agent` is for someone on a phone who has never seen the desktop flow, and requiring them to exist in the lead source first is a step they have no reason to take.

That choice has a consequence worth stating rather than discovering: **the same human can now exist twice** — once as a borrower file, once as a voice caller — and nothing joins them automatically, *even when the mobile numbers match*. This is deliberate. Guessing that two records are the same person and being wrong merges two applicants' documents and income, which is far worse than leaving them side by side. The dashboard says so directly on the caller's card: *"They are not linked to a borrower file — if that is the same human as one of the applications, link them by hand."*

**Login is mobile + password; the name is captured at signup.** The ask said "name and password", and this deviates on purpose: names collide (two Rahul Sharmas cannot both own an account), while a mobile number is unique, memorable, and the one field an officer needs anyway to call someone back. Changing it is a one-line change in `findByPhone()` if the team prefers the literal reading.

### Passwords — the only place in this repo that handles one

`backend/voiceAccounts.js` is the sole owner. The rules are narrow because the blast radius is not:

| Concern | How it is handled |
|---|---|
| Hashing | `scrypt` from node's own `crypto` — **no new dependency**, nothing hand-rolled. 16-byte random per-account salt, 64-byte key, stored as a self-describing `scrypt$<salt>$<hash>` so a future algorithm change is detectable rather than silently mis-verified |
| Comparison | `timingSafeEqual`, with a length guard because it throws rather than returning false on a mismatch |
| Escaping the module | It doesn't. `publicAccount()` is the only shape any route returns, and **`/api/voice/session` is handed that shape rather than the raw record specifically so a hash cannot end up inside a system prompt** |
| Logging | Never — not the password, not the hash. Even the signup log line prints only the `accountId`, not the name or number, so this feature does not widen the plaintext-PII gap in Phase 2 |
| In the browser | The password field is cleared the moment signup or login succeeds. Already out of our hands by then, but a filled password box left behind a hung-up call is an avoidable thing to leave on a shared phone |

**Account enumeration is closed, and it is not free — it cost a deliberate wasted hash.** A wrong password and an unknown mobile number return the *identical* message, and the unknown-number path still runs a full scrypt against a dummy hash so the two take the same time. Without that, response latency alone answers "does this person have an account?" — which, for a lending product, tells a stranger that someone is shopping for a loan. **Measured: 115ms on both paths.** Signup is the deliberate exception and *does* say "there's already an account on this number" — the person typing already knows whether the number is theirs, and "log in instead" is the actual next step.

Both endpoints share one rate limiter (10 attempts / 15 min / IP, via the existing `backend/rateLimit.js`), tighter than the voice limiter, so a script cannot walk numbers against a password list.

### Sessions, and why they are long

Server-side random tokens (32 bytes), stored against the account, swept opportunistically once the map passes 500 — the same reasoning as the ticket sweep in `voiceRelay.js`: an endpoint anyone can hit must not accumulate state forever because nobody logged out.

**TTL is 30 days, and the token lives in `localStorage`, not `sessionStorage`.** Both follow from what the feature is *for*: the person who calls again next week. A session that expires in a day would put a password prompt in front of the call button, which is the one place this product cannot afford friction. `sessionStorage` would die with the tab and make "remember me" a lie.

### Signing in is optional, and stays optional

**"Just talk, don't save anything"** sits on the sign-in screen, and the anonymous call is completely unchanged. **An account buys continuity, not access.** Skipping is not remembered either — someone who skips today and has a useful call is exactly the person worth inviting again tomorrow, so the brief carries a quiet *"Sign in so UPSY remembers this"* rather than a wall.

The first screen is chosen **synchronously from whether a token exists at all**, then confirmed against `/api/voice/me` in the background. Waiting for that round trip would put a blank frame in front of every caller; showing the sign-in screen first would make a returning caller watch it flash past. A token that turns out to be dead bounces back and clears itself; any *other* failure (offline) keeps them on the brief, because being offline should not lock someone out of a page they are already on.

### What a call now leaves behind

```
[caller on /upsy-voice-agent]  signs in ──► POST /api/voice/login ──► token (localStorage, 30d)
      │
      │  taps Call — token goes as an Authorization header, never in the body
      ▼
POST /api/voice/session ──► resolveSession() ──► publicAccount()
      │                                              │
      │                         mergeCallerContext(leadContext, account)
      │                                              │
      │                              accountId is put on the relay TICKET
      ▼                                        (server-side, not the browser)
voiceRelay.js  ── every finished turn ──► this.turns[]
      │
      └── on teardown ──► recordCall(accountId, { turns, seconds, … })
                                │
                  data/voiceAccounts.json ──► GET /api/voice/accounts
                                │                      │
                    next call's system prompt      Voice callers tab
```

Two details in that diagram are load-bearing:

- **The token travels as a header and the `accountId` lives on the ticket, not in the browser.** Same reasoning that keeps the system prompt server-side on this path: a value the page could also put in the request body invites trusting the wrong one, and a client that could name the account a transcript gets filed under is a client that can write into someone else's record.
- **`sendAgentText()` sends and records in one place.** Those two had already drifted apart once — the spoken acknowledgement was emitted to the page but never entered the conversation history — and a transcript missing the lines the caller actually heard is worse than no transcript at all.

**Persistence is fire-and-forget, on purpose.** `stop()` is synchronous and runs on socket close, where there is nothing left to await into; more importantly a failed disk write must never keep a call from tearing down, because a call that will not end holds an STT socket, a TTS socket and a timer open. An anonymous caller writes nothing at all — that is the intended outcome, not a gap: with no account there is nobody to show it to and no next call to inform.

**No audio is stored anywhere**, on this path or any other. Only the text both sides already receive.

Bounded on purpose: **20 calls per account, 300 turns per call**, oldest dropped first. The file is read whole into memory on every request, so a caller who rings twenty times must not make every later read slower — and no officer has ever needed the twenty-first call.

### The next call starts where the last one ended

`buildVoiceSystemPrompt()` renders whatever the account holds and tells the agent how to treat it:

```
You have spoken to this person before — 2 times, most recently on Wed Aug 05 2026.
Greet them as someone you already know, not as a stranger.
Here is what those earlier calls established about them:
- applicant:
  - name: Rohan Verma
  - age: 24
  - college: IIM Bangalore
  - course: MBA
- loan:
  - amount discussed: ₹15 lakh
  - type: unsecured
- co applicant:
  - relation: Father
  - monthly income: ₹95,000
How to use this: do NOT ask them again for anything already listed above. If something
matters to your answer, confirm it in passing ("you're doing the MBA at IIM Bangalore,
right?") rather than asking from scratch — but believe them over this list if they
correct you, because people's plans change and this is only what they told us last time.
```

That last clause is the one that matters. The list is **what they said last time, not a verified record**, and an agent that treats a remembered figure as fact will confidently answer the wrong question — the same failure this repo already documents for vision reads. The lead record wins wherever the two disagree, because that one is built from verified documents and the eligibility engine.

The introduction changes too — *"Hi Rohan, this is UPSY again. Where would you like to pick up?"* — because being asked your own name twice is the fastest way to make an agent feel like a phone tree.

**`renderFacts()` walks nested objects generically and is depth-capped at 3.** This is the seam that makes the pending schema cheap: adding a branch or a sub-branch changes nothing in the prompt builder.

### Team dashboard — the Voice callers view

A segmented toggle above the applicant list, because these are two different populations that happen to share a screen:

- **List:** name, mobile, call count, a coverage bar (`23/28 answered`), flag count, last call time.
- **Detail:** the caller's header (with the not-linked-to-a-borrower-file warning and the coverage bar), then **flags**, then **underwriting**, then **one card per branch** — each showing what was captured, **the caller's own words underneath every value**, and a "still to ask" row of what the call did not get to. Then **call history** — every call collapsible, expanding into the full two-sided transcript with duration and turn count.
- **"Documents to request"** — the narrowed list with *why each one applies*, a collapsible "not being asked for, and why", and the open questions that would narrow it further. See "In sync with the doc collection agent".
- **"Other details on file"** catches anything the schema does not describe. The extractor cannot produce such a key (validation drops unknown fields before storage), but profiles written *before* the schema did — and anything a future rename leaves behind — are still real things a caller said. A dashboard that silently hides data it does not recognise is worse than one that shows it under a raw key.
- Everything on that screen is labelled **what they said on a call, not verified against a document**. The lead record wins wherever the two disagree; that one is built from verified uploads and the eligibility engine.
- The single search box filters whichever list is on screen; auto-refresh polls only the active one, since refreshing both would re-render a list out from under a click.

⚠️ **`esc()` was added to `team.js` and it is load-bearing, not hygiene.** A call transcript is literally every word a caller said, rendered into `innerHTML` on an officer's screen — that is fully attacker-controlled free text arriving on an **unauthenticated dashboard**. Verified: `<img src=x onerror=alert(1)>` spoken into a call renders as inert text with no element created. **The pre-existing lead-list and detail rendering is still unescaped** and carries applicant names, vision-model reads and officer notes the same way — tracked as its own item in the status list below.

### API surface

| Route | Purpose |
|---|---|
| `POST /api/voice/signup` | name + mobile + password → token. 201, or 400 invalid / 409 number taken |
| `POST /api/voice/login` | mobile + password → token. 401 on either kind of failure, identical message |
| `POST /api/voice/logout` | drops the session server-side. 204 |
| `GET /api/voice/me` | the page's boot check. 401 when the token is dead |
| `GET /api/voice/accounts` | officer-facing list, each with its branch coverage |
| `GET /api/voice/accounts/:id` | one caller with full call history and coverage |
| `GET /api/voice/schema` | the branch definitions themselves — labels, order, types. Describes the questions, never anybody's answers |

`POST /api/voice/session` now reads an optional `Authorization: Bearer` header; everything else about it is unchanged, and a request without one is exactly as anonymous as it was before.

### What was verified, and how

The compositing limitation documented elsewhere in this README applies again — the browser pane does not composite, so `computer` clicks time out and nothing visual could be observed. Everything below was driven through the real handlers and asserted structurally.

- ✅ **36 store-level checks** — signup, duplicate rejection, validation, login, session resolve/expire/logout, profile merge semantics (later call overwrites, absent key never erases, empty string never creates), call recording, the 20-call cap, unknown-id no-ops, and that no `scrypt$` string appears in any listing output.
- ✅ **29 route-level checks** against the running server — including that `+91 98123 45678` and `09812345678` and `9812345678` all resolve to **one** account, that both login failure modes return an identical message, that a session response contains no system prompt, and that the officer endpoints leak no hash.
- ✅ **The `/upsy-voice-agent` flow in a real browser** — sign-up → brief, mode toggle rewrites title/labels/`autocomplete`, wrong password stays on the sign-in screen, sign-out clears the token and returns to sign-in, a dead token bounces, skip works, the callback sheet pre-fills from the account, no horizontal overflow at 375px.
- ✅ **Returning caller end to end** — signed in as a seeded account and got *"Welcome back, Rohan — I still have everything from last time"*, with `POST /api/voice/session` returning `known: true` and a relay URL pointing at us.
- ✅ **Team dashboard** — toggle, both lists, nested branch rendering, transcript expansion, search scoped to the active list, and the XSS check above.
- ⚠️ **Not exercised on a live call.** The relay's `persist()` path is code-verified and the store beneath it is tested, but no real conversation has been filed yet — see the credits note below.

### ⚠️ Cartesia's free tier ran out of credits while testing this

`npm run voice:relay` now fails its last two checks:

```
Insufficient credits: This request requires approximately 103 credits but you have 42 remaining.
```

**This is account balance, not a regression** — transport, single-use tickets, *does it actually speak* (468ms to first audio) and streamed sentence-by-sentence thinking all still pass. The failing checks are the synthetic-caller loop, which uses Cartesia TTS to *generate* the fake caller's voice; with no audio produced, Deepgram times out waiting. **Nobody can re-verify the hearing loop until the account is topped up** — Pro is $5/mo and the plan table in "Cartesia's plans" applies.

### ✅ The extractor is built — the branch schema landed (2026-08-10)

**The gap this closes: a call was heard, answered and remembered, and then nobody could do anything with it.** The transcript was stored and an officer could read it, but "what did this call actually establish?" was a human reading twenty turns. The schema arrived as the team's underwriting flowchart, and the prediction in the previous version of this section held — **storage, prompt grounding and both dashboard views needed no changes to accept it.** The new code is `backend/callSchema.js` (the definition) and `backend/callExtract.js` (the reading), plus a rebuilt caller view.

Both decisions recorded before the schema landed were implemented, not revisited:

1. **It runs off the voice critical path.** Never inside a turn. `captureFacts()` in `voiceRelay.js` starts it and abandons it — the relay owns *when*, `fileCall()` owns *what*.
2. **It stores what was *said* alongside every parsed value**, and now also **checks that quote against the transcript**. A value whose quote cannot be found is kept and marked `unmatched` on the dashboard, because a model that writes a sentence rather than quoting one is the signal an officer needs before acting on the number beside it.

**The five branches, from the flowchart.** Four are collected by talking; the fifth is arithmetic on the other four:

```
   applicant ──► institute ──► loan ──► coApplicant
                      │
                      ▼
             underwriting (FOIR, lender band, flags — derived, never asked)
```

The order is the flowchart's and is load-bearing: you cannot size a loan before you know the fee, and a co-applicant's income means nothing until there is an amount to test it against.

**One schema, three consumers, no restating it anywhere.** `voicePrompt.js` renders it into the agent's agenda (and into *what is still missing for this caller*, so a second call picks up where the first stopped); `callExtract.js` renders it into the JSON contract the model fills and validates the reply against it; `team.js` fetches it from `GET /api/voice/schema` and renders a caller's file under the same labels in the same order. Add a field in one place and all three follow.

**The derived branch is computed on the server, never asked of a model.** Straight from the flowchart's lender box: existing EMIs ÷ income is FOIR now; loan ÷ 120 is the new EMI (**principal ÷ 120 with no interest — as drawn, and deliberately optimistic; a real EMI at 11% is ~38% higher**, which is why every surface labels it indicative); the two together give FOIR after the loan, which picks the lender band. ⚠️ The flowchart's own bands read `<50 / <70 / >75 / >80`, which leaves 70–75 belonging to nobody — read here as four ordered bands, and `FOIR_BANDS` in `callSchema.js` is the one line to change if that was not the intent.

**An unknown input produces no verdict rather than a confident zero.** `computeUnderwriting()` returns `ready: false` and names what is missing, because a 0% FOIR on an unknown income is exactly the kind of number an officer would act on.

**What the validation refuses, and why each rule exists.** Every one of these was a real thing the model did on a real run, not a hypothetical:

| Refused | Because |
|---|---|
| Unknown branches and fields | A model inventing `applicant.salary` must not write a field no dashboard will ever show |
| `document`/`api`-sourced fields | A call may not fill in a CIBIL score or a PAN — those come from a bureau or an upload |
| A CGPA in a percent field | `8.2` stored as 8% trips the "below 60%" flag and puts a false threat on an officer's screen. The floor is 10 |
| `"father"` as the co-applicant's **name** | Measured: gpt-4o-mini writes this across runs, with a matching quote, because it is genuinely all the caller said. A relationship is not a name, and this one would reach a lender referral draft |
| A relation outside the permitted list | Normalised to `other` rather than dropped, so the flowchart's "no cousin" flag actually fires |
| An **ITR year-count on a salaried file** | Observed: "three years of Form 16" lands in *both* year fields. On a salaried co-applicant that raised `itr_years_short` — a threat about a document that file is never asked for. A flag nobody can act on is worse than no flag; it is the one that teaches an officer to skim the list. Gated in three places now: what is stored, what is flagged, and what is counted as missing |

**Verified with `npm run eval:extract` — 113 checks, no key needed for the arithmetic.** Part 1 is the FOIR maths, the lender bands, every flag rule and the coercion guards: deterministic, offline, and a failure there is a bug in this repo. Part 2 runs a scripted call through the real extractor and asserts sixteen fields, including **two self-corrections a naive reader gets wrong** — a fee stated as "25 lakh, sorry, 24 lakh", and an uncle withdrawn in favour of a father after the agent said lenders need immediate family. `npm run eval:extract -- --seed` writes that call into the store through the same two functions the relay calls, so `/team` has something real to show without a phone or a microphone.

**🐛 One bug this work found, worth keeping.** The quote-matcher normalised punctuation but *kept* full stops, so a model quoting `"I am 24."` never matched a transcript reading `"I am 24, I live in Pune"` once the comma became a space. Six of sixteen good quotes were marked unmatched — a warning badge that fires on correct data is a badge officers learn to ignore, which would have quietly disabled the one guard standing between a misheard number and a lending decision. All punctuation goes now; both sides get the same treatment, so `1.5 lakh` still matches itself.

### 🔗 In sync with the doc collection agent — the params narrow the requests

**The team's framing, verbatim in spirit:** *"I have designed this in sync with our doc collection agent — from the conversation we identify certain params, and the loan doc agent then brings only those requests."* `backend/docPlan.js` is that join.

The branches decide which documents are real for this person, and — the part that matters — **which ones are not**. On the scripted eval call (salaried co-applicant, MBA, unsecured): **15 to ask for, 6 ruled out, 2 questions still open.**

| The call established | So the doc agent | Because |
|---|---|---|
| Co-applicant is **salaried** | asks Form 16 + 3 months' slips + salary account | the flowchart's salaried branch |
| | **drops** ITR years, computation of income, current a/c, savings a/c | no business income to document |
| Co-applicant is **self-employed** | asks ITR 2–3 yrs + computation + current a/c 6m + savings a/c 3m | the flowchart's self-employed branch |
| | **drops** Form 16, salary slips, salary account | no employer |
| Course is **postgraduate** | adds the UG degree marksheet | *"if PG course, ask 10,12,UG; if UG then 10th&12th"* |
| **No** recent job change | drops the joining/offer letter | the older slips already cover the period |
| Lives **at** the KYC address | drops the electricity/gas bill | the Aadhaar already proves it |
| Loan is **unsecured** | drops the property papers | nothing to mortgage |

**Three outcomes, not two, and `pending` is the one that earns its place.** A plan reports `asked`, `skipped` *with the reason each was dropped*, and `pending` — the question that would settle the rest, named with what it settles. *"Ask whether the co-applicant is salaried and this list resolves by four documents"* is an instruction; "incomplete" is not.

**The skipped list is shown on the dashboard, not hidden.** An officer who can only see what was asked for cannot tell *correctly narrowed* from *quietly missed*.

**The officer's screen updates itself while the call is still running.** The list already polled; the open caller's file did not, so the coverage bar on the left ticked up while the branches, flags and document plan beside it stayed frozen at whatever was on screen when it was clicked — two numbers on one screen disagreeing about the same call. `refreshVoiceDetail()` re-fetches the open file every 7s and **re-renders only when the payload actually changed**, because a rebuild collapses any call transcript the officer has expanded. Verified by rolling the open pane back to a mid-call state and then not touching it: **12 documents → 15, and the co-applicant branch filled in, on its own.**

**The list narrows during the call, not just on the next one.** Each mid-call extraction pass rebuilds the system prompt against the new facts (`refreshPrompt()` in `voiceRelay.js`), so a caller who says "my father is salaried" in minute two is not still being told about three years of ITR in minute five. The conversation history is untouched — only the standing instructions change.

⚠️ **Six of the flowchart's documents have no row in the `/docs` upload flow yet** (Form 16, salary account statement, joining letter, the multi-year ITR set, computation of income, the current/savings account statements, the utility bill). They are marked **"not in upload flow"** on the dashboard rather than quietly added to `documents.js`: the plan is what a *call* asks for, and letting it diverge from what the upload UI can actually accept would produce a list nobody can act on. Adding rows to `documents.js` is how that closes.

⚠️ **Pensioner and farmer are named on the flowchart but not detailed.** Farmer follows the self-employed path; **pensioner asks for the pension order and raises a `pending` item saying so out loud**, rather than this module inventing a document set — which is the exact thing it exists to prevent.

**Still open, honestly:** extraction is a small model reading speech, and it is not deterministic. Across runs of the identical transcript it captured 23/28 fields once and 24/28 the next, and it missed the Aadhaar-city mismatch on one run while catching it on the others. **Absence is safe** — an unasked field is asked again next call — but nothing yet detects a field the model quietly *stops* finding. `ANTHROPIC_API_KEY` is the same fix as everywhere else in this file.

## Income extraction from ITR / salary slips (per product spec: "ITR value ÷ 12 = month income")

When the applicant uploads the **co-applicant income proof** (`co_income_proof`), `backend/income.js` reads the income off the document via the same Claude → OpenRouter chain:

- **ITR / Form 16** → reads the gross total income and applies the **annual ÷ 12** rule for monthly income. PDFs work **even without the Claude key** — the OpenRouter path sends PDFs through OpenRouter's file-parser (verified live with a text-native ITR-V fixture).
- **Salary slip** → reads the **gross monthly earnings** directly (verified live: correctly picked gross ₹75,000 over net pay on a synthetic slip).
- The verified figure then: (1) adds an "Income read from document" line to the applicant's verification checklist; (2) **re-runs the eligibility engine** (est. loan ≈ 24 × verified monthly income) and shows a green "verified from document" note on both the applicant's eligibility page and the team credit memo; (3) **overrides the lead source's claimed income on every future login**; (4) shows on the doc row in the team Extract tab; (5) is logged on the Activity timeline (`income_extracted`, with amount, basis and name on document); (6) feeds the lender referral drafts ("monthly income ₹X — verified from uploaded ITR").
- Failure is safe: sanity band ₹5k–₹1Cr/month, misreads/unreadable files just keep the lead-source figure (upload still verifies; nothing blocks).

### Income eval harness + a real bug it found and fixed (2026-07-29)

`npm run eval:income` (`backend/eval-income.js`) — the income-doc counterpart to `npm run eval`. Scans the project root + `data/uploads/` for ITR/Form16/Payslip/Computation files (or takes explicit paths), runs each through the real `extractIncome()`, prints doc type, the annual→÷12→monthly math, holder name, period, reader, latency. Used to test 12 real fixture files the user dropped straight into the project root (3 years of ITR + computation sheets, a Form 16 Part A/B pair, 3 payslips).

**🐛 Bug found & fixed: `Form16PartB` was misread as a `salary_slip`.** It took the document's *annual* figure (₹7,15,129) and reported it as **monthly**. Uncaught, that would have fed `24 × ₹7,15,129/month` into eligibility math — a loan estimate in the tens of crores from one bad label, with **no checksum to catch it** the way Aadhaar has. Fixed two ways in `income.js`:
1. **Prompt tightened** — explicitly tells the model Form 16 Part B is annual, never a salary slip, and that `salary_slip` only applies to a single month's payslip. Re-tested: now correctly reads `itr` / ₹6,22,885 annual.
2. **Sanity guard added (the real backstop)** — any doc classified `salary_slip` with a "monthly" figure above ₹5L is now rejected outright (`shape()` in `income.js`), regardless of what the model says. Mirrors the Aadhaar-checksum philosophy: don't just validate format, validate plausibility.

**⚠️ New open finding — non-determinism on plain digit strings.** Running the identical `ITR-24-25.pdf` twice gave two different annual figures: ₹1,39,100 vs **₹13,91,000** (a shifted/dropped digit — 10× apart) on `openai/gpt-4o-mini` via OpenRouter. Same failure class as the original Aadhaar/PAN number-accuracy issue, just showing up on income figures now — and **there's no checksum for income**, so a misread here is currently undetectable. Name reads were also inconsistent across the same person's documents (HISARIA / HISHAM / HSBARIA). This is the strongest evidence yet for getting `ANTHROPIC_API_KEY` in — Claude already tested exact on real PAN/Aadhaar; income docs carry the same risk with less of a safety net.

## Co-applicant identity verification: name, address, bank-statement phone (2026-07-29)

**Requested by the team over WhatsApp**, after testing income extraction on a real Form16PartB: *"toh it should name match the coapplicant, also address match across all docs, and flag where there seems to be a different address, bank statement also same, fetch banking phone number as number of coapplicant... let's plan to get these variable in place, accuracy we should not worry about — that's an AI problem."* Built exactly that — variables + flagging wired first, accuracy improves later via the Claude key (same pattern as everything else in this repo):

| Asked for | Built |
|---|---|
| Name match | Name extraction generalized to *any* document (not just PAN/Aadhaar) — income proof and bank statement now feed the same match logic |
| Address match, flag differences | New `addressesMatch()` (lenient token-overlap, tolerant of free-text formatting) in `ocr.js`; address now extracted on Aadhaar, income proof, and bank statement; flagged as a `crossDocConflicts` entry exactly like a name/DOB mismatch |
| Bank statement | New `backend/bankStatement.js` — reads account holder name, address, and registered phone off `co_bank_statement` (Claude → OpenRouter chain, same as income.js) |
| Fetch banking phone as co-applicant's number | Persisted via `saveCoApplicantContact()` in `store.js`, applied as `lead.coApplicantPhone` on every future `session/start` (same override pattern as the income figure) — shown on the team profile card as *"Co-applicant phone: ...(from bank statement)"* |

### A real bug fixed along the way

The pre-existing cross-document check compared the name/DOB on **every** verified document against every other — including the **student's** documents against the **co-applicant's**. Since those are two different people, this would have silently flagged a false "mismatch" on every normal application the moment both a student ID and a co-applicant ID were verified. Fixed with `identityGroup(docId)` — `co_*` docs only compare against other `co_*` docs, `student_*` only against `student_*`. Also added `deriveCoApplicantName()` — since this mock lead model has no lead-provided co-applicant name to check against (unlike the student's, which comes from the lead source), the co-applicant's canonical name is taken from whichever of their documents named them first, shown on the team profile as *"(from document)"*.

### Verified live, twice — once via raw API, once through the actual dashboard UI

Uploaded two real fixture PDFs as different co-applicant documents (genuinely different people's real documents, used deliberately to force a mismatch): the **Fraud Check tab correctly showed "2 issues — needs review"** — both a name conflict (*"...bank statement shows name Manoj Kumar, but ...ITR shows KESHARI NANDAN HSBARIA"*) and an address conflict (Gurgaon vs. a Bihar address), each with both values shown side by side. The Extract tab showed the extracted name/address/phone per document; the profile card showed the derived co-applicant name. Test data was cleaned up afterward via the app's own delete endpoint (not by hand-editing `applications.json`, per the ops notes above).

**`addressesMatch()` unit-verified against real extracted text:** correctly resolved two genuinely different real addresses as *not* matching, and the same address reworded/reordered as matching — low false-positive risk by design.

### Two known gaps, honestly

- **No real bank-statement fixture exists in the repo** (only ITR/Form16/payslip PDFs) — `bankStatement.js`'s phone extraction is logic-reviewed and wired correctly, but not yet proven against an actual bank statement layout.
- **No PAN/Aadhaar image fixtures exist either** (only PDFs, which the OpenRouter path can't read) — so the `identityGroup` scoping fix, while a one-line deterministic check that's easy to audit by reading the code, hasn't been exercised live with real student-vs-co-applicant ID documents. Both gaps close once `ANTHROPIC_API_KEY` is added (unlocks PDF reading end-to-end) or a real bank statement sample is dropped into the repo.

## Built from scratch

- **Vision document capture + format validation** — reads PAN/Aadhaar/name/DOB/address off card images **and PDFs** via a **Claude-first chain** (direct Anthropic API → OpenRouter vision model → local `tesseract.js` OCR), validates file integrity (magic bytes), checks ID format + Verhoeff checksum (now enforced on vision reads too), cross-references typed number against card. See "Vision document capture".
- **Co-applicant identity verification** — name/address matching generalized across ID docs, income proof, and bank statement; bank-statement phone number becomes the co-applicant's contact; a real cross-group false-positive bug fixed along the way. See "Co-applicant identity verification" above.
- **Smart intake (build-vs-buy answer to MagicX AI Autocomplete)** — `/intake` step + `/api/intake`: one plain sentence → structured loan intent (amount, level, field, institution, country, intake, co-applicant, secured/unsecured, tenure) → gaps rendered as answerable inputs on the same page → context banner carries into the rest of the flow and is pushed to the lead timeline. Runs on the same Claude → OpenRouter chain.
- **EMI assistance (Auxilo-style)** — interactive card on `/docs` with education-loan-aware math: study moratorium before repayment, optional pay-interest-during-study mode (vs. capitalising moratorium interest), live tenure slider, total interest/payable, pre-filled from the applicant's own intake + eligibility. Illustration-only disclaimer. Only shown to eligible applicants.
- **"Ask UPSY" document helper** — `/api/assist` + a right-side chat panel on every document page. Answers "why is this needed / what format / why was mine rejected" grounded in the doc definition, the applicant's loan context, and the exact failed checks of their last upload. The rejection report links to it ("Not sure what to fix? Ask UPSY on the right").
- **Client-side routing** — real `/login` → `/intake` → `/docs` URLs (history push/pop, browser back/forward works, cold hits to guarded routes bounce to `/login`; server serves the SPA for those paths). **Every document step now has its own URL too** (`/docs/1` … `/docs/N`, `/docs/done`) so the browser Back button walks document-by-document instead of dumping the applicant back to the phone login (user-reported issue, fixed 2026-07-27). The team dashboard keeps the selected lead + tab in the URL (`team.html?lead=LD-1001&tab=lenders`) — Back/Forward steps through selections, and the URL is a shareable deep link that survives refresh.
  - **Subpath gotchas fixed**: `index.html` must load its script as **`/app.js` (absolute)** — a relative `app.js` at `/docs/3` resolved to `/docs/app.js`, which the SPA route answered with HTML → silent white page on reload. And a **page refresh restores the session**: the phone number is kept in `sessionStorage`, so a cold hit to `/docs/N` shows "Getting your application back…", re-calls `session/start`, and lands back on the same step (falls back to `/login` if that fails).
- **Card-reading eval harness** — `npm run eval` runs any set of card files through the *real* `readCard()` pipeline and prints number/checksum/name/DOB/reader/latency per file. Doubles as the Claude-vs-OpenRouter A/B tool (swap `ANTHROPIC_VISION_MODEL` between runs). Finding this session: running it on the repo's own PDFs exposed a crash bug (below).
- **Lead-source adapter pattern** — pluggable interface so the bot works with any CRM/lead-ad/form; fetch lead → pre-fill → skip-known → write-back; mock source included; easy to wire Zoho/Salesforce/LeadSquared.
- **Eligibility engine** — encodes the real underwriting rules (academic minimum, family-only co-borrower, income multiple, loan bands, NRI requirements) to give an instant preliminary decision — amount, rate, moratorium — instead of just collecting paperwork for someone to eventually decide on.
- **Cross-document consistency check** — compares the name/DOB read off *every* uploaded ID against each other (not just against the lead record). Catches mixed-up or swapped documents — a real fraud/error signal, not just a formatting check.
- **Chat-style agent** — white-and-blue mobile-first UI, auto-fills from cards, explains *why* each document matters, shows a preliminary eligibility estimate right after sign-in, shows live verification per-check scores.
- **UPSY team dashboard** — real-time view of all applications, per-document status with file links, an eligibility card per applicant, name-mismatch / cross-document flags, officer actions (Approve/Reject/Request re-upload), a "Send reminder" button, activity timeline, auto-refresh.
- **Drop-off recovery (nudges)** — the server tracks how long an in-progress application has gone untouched and automatically sends a reminder (background sweep), or the officer can trigger one manually. Pluggable notification channel (console by default).
- **Messaging channel (Exotel primary, Twilio alternative)** — real Exotel SMS + WhatsApp integration for outbound reminders (user's live account is wired in, tested, blocked only by account-side balance/sender-registration — see known issues below) plus a Twilio WhatsApp path for quick sandbox testing. Inbound webhook auto-detects the provider and replies with live progress + a link back to the assistant.
- **File storage + retrieval** — uploads saved to disk on verification, linked in the dashboard so officers can open/review each document; re-upload requests un-verify the doc and ask the applicant again.
- **Resume & persistence** — applicant can close the app and come back; their progress (which docs passed) is remembered; if an officer asks for re-upload, the doc goes back into their to-do list.

## Two views

- **Applicant view** — `http://localhost:3000` — a **multi-page step flow** (rebuilt from an earlier single-page chat UI): sign in → eligibility → one document per page → verification result → done. Full-width, spacious "Kita-style" desktop design (white/blue, Tailwind CDN, Material Symbols icons), not a mobile chat widget.
- **UPSY team view** — `http://localhost:3000/team.html` — a **left-sidebar "UPSY Admin"** dashboard (also rebuilt in the Kita style): every application, each applicant's profile, a rule-based **credit memo** (eligibility verdict/amount/rate), an **Extract** tab (per-document status/checks/View/Request-re-upload), a **Fraud Check** tab (cross-document conflicts), an **Activity** tab (timeline), and a document-packet email button. Refreshes automatically as applicants submit documents. Note: some of the very first Stitch-generated mockups included **fake features that were deliberately NOT wired in** (face-liveness %, credit bureau score, AML/sanctions check, "N credits" billing UI, stock photos) — everything actually on screen reflects a real backend check only.

### Applicant flow details (for continuing UI work)

- `frontend/index.html` + `frontend/app.js` render everything client-side into a single `#app` div (no framework — plain template-string rendering + re-render on every step, plus a tiny hand-rolled history router: `go()`/`route()` mapping `/login` → `/intake` → `/docs`, popstate-aware, with session guards). `frontend/team.html` + `frontend/team.js` is the same pattern for the dashboard (no router).
- **Resume support**: logging in with a phone number already used loads the **full ordered document list** (`data.documents`, each flagged `done: true/false` from `session/start`), not just the remaining ones — this was a bug that got fixed (previously only remaining docs loaded, so Back couldn't reach earlier ones). Lands on the first pending doc but the full list is available for navigation.
- **Document checklist sidebar**: a fixed left-edge sidebar (not a centered/floating card — that looked bad and was corrected) lists every document, grouped by stage, with a green check for done / blue highlight for current / grey circle for pending. **Click any document to jump straight to it** (`data-jump` attribute + `idx = ...; renderCurrent()`). Replaced an earlier "Back to previous document" single-step button, which is now removed in favor of the sidebar.
  - **⚠️ Known gap found in Render deploy testing (2026-07-30): sidebar is invisible on mobile.** It's `class="hidden lg:flex ..."` (`checklistHtml()` in `app.js`) — deliberately desktop-only, matching the rest of this UI's "not a mobile chat widget" design, but nobody built a phone equivalent. Result: on a real phone, the jump-to-any-document nav and the always-visible progress list simply aren't there (rest of the flow — Continue, upload, verification — still works). Not fixing now; **tracked in the "fine-tuning the webpage" batch in the roadmap below** (user's call — reviews expected from multiple people, upgrading together rather than one-off patches).
- Revisiting an already-uploaded document shows an "already uploaded this one" banner with **Replace** (re-upload) and **Continue** actions; doesn't double-count progress (`doneSet` — a `Set` of doc ids — tracks completion, separate from the `verified` count from the server, so navigating back and forth never inflates the progress bar).
- The top bar (`UPSY` logo + progress + avatar) and the sidebar header are left-aligned to the same edge (both at `px-6`/`p-4` from the true left, not centered in a `max-w-container` — an earlier version had them misaligned).
- **Known/fixed rendering bug**: Material Symbols icons initially rendered as literal words ("check_circle", "cloud_upload") instead of icon glyphs — the font was loaded via `<link>` but `.material-symbols-outlined` never set `font-family` to it. Fixed in both `frontend/index.html` and `frontend/team.html`'s inline `<style>` blocks.
- The completion email (`/api/session/complete`) and progress tracking are guarded (`completedSent` flag) so navigating back into an already-finished flow doesn't re-trigger the packet email.
- **EMI assistance + matched lenders moved to the completion screen** (2026-07-29, user-requested) — previously shown upfront on the eligibility page before any document was uploaded; now they only render on "All documents received" (`renderDone()`), once there's a real completed application behind the numbers. `emiCardHtml()`/`wireEmi()`/`loadLenderCards()` are unchanged, just called from the new location.
- **Emoji removed from the team dashboard's Extract tab** (2026-07-29, user-requested) — the 💰 income line and 📞 phone line now read as plain text ("Income verified: ₹X/month", "Co-applicant contact verified: ...") for a more professional look.

### Design source material

- [`STITCH_PROMPT.md`](STITCH_PROMPT.md) — the prompts used to generate the current UI look via **Stitch by Google** (screen-by-screen visual descriptions, blue/white Kita-inspired style). Both the applicant flow and team dashboard were rebuilt directly off Stitch-generated HTML/Tailwind output the user pasted in (with fake/invented features stripped out — see above).
- [`BUILD_PROMPT.md`](BUILD_PROMPT.md) — a broader "make it like Kita" build prompt covering model routing, the Capture/Credit-Officer/Underwriter architecture, and infra (Postgres/Redis/Qdrant) the user has available but hasn't wired in yet. Written before the UI rebuild; still relevant for backend/architecture direction, less so for exact visual specifics (superseded by the actual Stitch output for those).

## Lead-source layer (fetch from anywhere, act accordingly)

The agent talks to **one active lead source** through a small adapter interface, so it works with any platform that produces leads — a CRM (Zoho, Salesforce, LeadSquared), Meta/Google lead ads, a website form, or a spreadsheet. Swapping the source is a config change, not a rewrite.

On session start the agent:
1. **Fetches the lead** by mobile number.
2. **Pre-fills** known identifiers (e.g. a PAN already on record).
3. **Skips** documents the source already has.
4. **Adapts the list** to the applicant — no collateral for an unsecured loan; co-applicant income asked as salary slips (salaried) or ITR (self-employed).
5. **Writes back** every verification event, so a loan officer sees live progress.

Each source implements just two methods — `getLead(phone)` and `pushStatus(leadId, payload)`.
**To add a real source:** create `backend/leadSources/<name>Source.js`, register it in `backend/leadSources/index.js`, and set `LEAD_SOURCE=<name>`.

## Vision document capture (Kita-style) — now Claude-first

`backend/capture.js` reads the PAN/Aadhaar **number, cardholder name, and DOB straight off the card** — images *and PDFs* — via a three-tier chain:

1. **Claude directly** (Anthropic Messages API) — best at reading ID numbers; enabled by `ANTHROPIC_API_KEY`; model via `ANTHROPIC_VISION_MODEL` (default `claude-opus-4-8`; `claude-sonnet-5` / `claude-haiku-4-5` are cheaper options to A/B). Handles **PDFs natively** (sent as a document block) — the only path that can. Transient 429/529 responses are **retried with backoff** (honouring `Retry-After`) before falling through.
2. **OpenRouter vision model** — `OPENROUTER_API_KEY` (+ optional `OPENROUTER_VISION_MODEL`, default `openai/gpt-4o-mini`). Images only.
3. **Local `tesseract.js` OCR** — always-available floor; images only (PDFs are guarded out — see fixed crash below).

Works for both `/api/extract` (auto-fill on attach) and `/api/validate` (number match + fraud checks). The response reports `source: "claude" | "vision" | "ocr"`, and the server prints the active chain at startup.

### ✅ Number-accuracy issue — largely resolved this session

The old #1 issue (vision models misreading long digit strings) got a two-part fix:

1. **Checksum guard (implemented).** `cleanNumber()` in `capture.js` now enforces the real UIDAI **Verhoeff checksum** on every Aadhaar number a model returns — a misread digit fails the checksum, returns `null`, and the UI degrades to "please type it" instead of confidently showing a wrong number. This protects the pipeline regardless of which model reads the card. PAN is strict-format-checked (an extra stray digit is rejected outright).
2. **Claude verified accurate (manual test).** The user tested their own real PAN + Aadhaar through claude.ai with the app's exact prompts: **all fields correct** — PAN structurally valid + surname-initial consistent, and the Aadhaar number **passed the Verhoeff checksum** (objective proof of an exact read, not a lucky guess). Name picked the cardholder (not father/header); DOB consistent across both cards.

**Remaining step: add `ANTHROPIC_API_KEY` to `.env`** (from platform.claude.com — the API is separate from a claude.ai Pro subscription; ~$5 of credits is plenty, set a console spend limit). Until then the Claude path is dormant and the chain starts at OpenRouter. Note: **PDF documents currently have *no* working reader without the Claude key** — OCR can't parse PDFs and the OpenRouter path is image-only, so `npm run eval` on the repo's own PDF uploads shows "(not read)". That's the single biggest reason to add the key.

The read number always remains **editable in the UI** (label + post-read banner now say so explicitly) — never auto-submitted without the applicant seeing and correcting it.

### 🐛 Fixed this session: PDF uploads could crash the server

`tesseract.js` cannot read PDFs — and worse, handing it one threw from a worker thread on a later tick, **escaping the try/catch and killing the whole Node process**. Found by running `npm run eval` against the repo's own PDF fixtures. `extractText()` in `backend/ocr.js` now detects the `%PDF` magic bytes and bails out gracefully, so a PDF upload can never take the server down.

## Smart intake, EMI assistance & doc helper (this session's product layer)

Explored **MagicX's AI Autocomplete SDK** (real product: ex-Meta founders, VC-backed, ~200ms per-keystroke "action engine" that structures free text into fields; self-hosting available) and **Auxilo's Smart Loan signup** (phone + consent gate → EMI financing journey — a good real-world model for the Phase-2 compliance gate). Conclusions: the *intent-structuring* idea is the valuable part and fits our front-of-funnel; the KYC fields must never flow through a third-party SDK; a debounced Claude call gets ~80% of the value with zero new vendors. So we **built it in-house**:

- **`/intake` step (in the main flow)** + standalone `intake.html` demo — free text → structured intent → inline gap questions (dropdowns/text/number per field) → context banner through the flow → `intake_captured` on the lead timeline. Interesting side-effect seen in testing: the intake can surface that the applicant's *current* plans differ from stale lead data (e.g. lead says "MS, UT Austin" but they now want "MBA, INSEAD") — a reconciliation signal for the future agent.
- **EMI assistance** on `/docs` — see "Built from scratch" bullet for the math details (moratorium-aware, interest-during-study toggle). Verified live: ₹36L @ ~11% → ₹52,851/mo at 7 yrs → slider to 12 yrs → ₹39,167/mo.
- **"Ask UPSY" doc helper** on every document page — `backend/assist.js` + `/api/assist`; grounded in doc definition + intake summary + last failed checks; "Why wasn't mine accepted?" chip appears only after a real rejection. (The rejected-chip path is wired but not yet exercised end-to-end with a real failing upload.)

All three run on the same **Claude → OpenRouter → off** provider chain (env: `ANTHROPIC_INTAKE_MODEL` / `ANTHROPIC_ASSIST_MODEL`, `OPENROUTER_INTAKE_MODEL` / `OPENROUTER_ASSIST_MODEL`), so they work today on the OpenRouter key and upgrade to Claude the moment the Anthropic key lands.

**Hard rule adopted:** LLM assistance is for *freeform* fields and doc Q&A only — **PAN/Aadhaar/income/bank field contents are never sent to an LLM** for autocomplete-style features.

## Auto-fill from the document (OCR fallback)

When you attach a PAN or Aadhaar card image, the backend runs local OCR (`tesseract.js`, no API keys) and **reads the number straight off the card** to fill the field for you — you just confirm it. On upload it also runs a **content cross-check**: the number you submit must actually appear on the document, otherwise the upload is rejected ("the document shows X but you entered Y").

It also reads the **name and date of birth** off the card. If the lead has no name yet, it fills the profile from the document; if the name on the card doesn't match the lead record, the team dashboard raises a **name-mismatch flag** for review.

- Works on image cards (JPG / PNG); PDFs skip OCR and fall back to typing.
- A blurry/unreadable image never blocks you — it just asks you to type the number.
- Corrupt uploads can't crash the server (`ocr.js` resets its worker; `server.js` has a recovery guard).

### What the format cross-check does

For each uploaded document the backend runs real checks and returns a pass/fail report:

1. **File type accepted** — extension is on the document's allow-list.
2. **Contents match extension** — reads the file's magic bytes, so a JPEG renamed to `.pdf` is caught.
3. **Size within limit** and **not empty**.
4. **Identifier format** — where applicable:
   - **PAN** — regex `ABCDE1234F` (5 letters, 4 digits, 1 letter).
   - **Aadhaar** — 12-digit format **and** the real UIDAI **Verhoeff checksum** (a wrong-checksum number is rejected even if the length is right).

A document is marked *verified* only when every check passes.

## Eligibility engine

Right after sign-in, `backend/eligibility.js` runs a transparent, rule-based assessment (no ML — every number traces back to a rule in `research/kuhoo-journey.md`):

- **Academic minimum** — below 60% is flagged ineligible.
- **Co-borrower rules** — must be immediate family (father/mother/brother/sister/spouse), with income on record; a "friend" co-applicant is rejected.
- **NRI heads-up** — doesn't block, but warns that an NRE/NRO account + Indian collateral + extra co-borrower will be needed.
- **Loan estimate** — ~24x the co-applicant's monthly income, capped at ₹1 Cr (unsecured) / ₹2 Cr (secured), floored at ₹50k.
- **Moratorium** — course duration + 9 months grace.

The applicant sees a friendly estimate in the chat ("you may qualify for ~₹22.8L"); the team dashboard shows the full breakdown plus an **Eligible / Needs review** chip on every application card.

## Cross-document consistency

Every time a document is verified, the backend compares the name, DOB **and address** it just read against every *other* document this same person has already uploaded (not just the lead record). A PAN that says "Aarav Sharma" next to an Aadhaar that says "Rohan Kumar" — or two different dates of birth, or two different addresses — raises a flag on the dashboard (**Fraud Check** tab) with both values shown side by side.

**Which documents feed this:** originally only PAN/Aadhaar (via the card reader). As of 2026-07-29 it also covers the **co-applicant's income proof** (ITR/Form16/salary slip — name + address) and **bank statement** (name + address + phone) — see "Co-applicant identity verification" below.

**Scoped by person, not just by applicant.** A loan application has TWO people's documents in it — the student's and the co-applicant's — and they're *supposed* to have different names. The check only compares documents within the same person's group (`student_*` docs against `student_*` docs, `co_*` against `co_*`); it never flags the student's PAN against the co-applicant's Aadhaar as a "mismatch" just because they're different people. (This scoping was added 2026-07-29 fixing a real latent bug — see below.)

**Known nuance while reading the dashboard:** a conflict is recorded on whichever document was uploaded *second* — the earlier document's own card can still show "Consistent" even though it's part of a real conflict. The **flag panel** (top of the Fraud Check tab) is the reliable summary; it always shows both sides regardless of upload order.

## Drop-off recovery (nudges)

`backend/notifier.js` + a background sweep in `server.js` track how long an in-progress application has sat untouched. Past a threshold (3 min in this demo; would be ~24h in production), it's marked "stalled" on the dashboard and a reminder is sent automatically (with a cooldown so it doesn't repeat every cycle). The officer can also hit **"Send reminder now"** any time. The notification channel is pluggable — console log by default, real WhatsApp if configured (see below).

## Going live with messaging (Exotel or Twilio)

The reminder channel is pluggable (`NOTIFY_CHANNEL`), and the inbound webhook at `POST /webhook/whatsapp` auto-detects whether the caller is **Exotel** (JSON) or **Twilio** (form), so either provider works without code changes. Every provider safely logs what it *would* send when credentials aren't set, so local/demo mode never breaks.

### Exotel (recommended for India — SMS or WhatsApp, DLT-compliant)

`backend/exotel.js`. Set these env vars, then `NOTIFY_CHANNEL=exotel`:

```
EXOTEL_API_KEY=...
EXOTEL_API_TOKEN=...
EXOTEL_SID=your_account_sid
EXOTEL_SUBDOMAIN=api.in.exotel.com     # Mumbai; api.exotel.com for Singapore
EXOTEL_MODE=both                       # "sms", "whatsapp", or "both" (sends each reminder over both)
EXOTEL_FROM=your_ExoPhone_or_WA_number
```

- **SMS** → `POST https://<sub>/v1/Accounts/<sid>/Sms/send.json` (needs a DLT-approved template).
- **WhatsApp** → `POST https://<sub>/v2/accounts/<sid>/messages`.
- **Inbound** → point Exotel's WhatsApp "incoming message" webhook at `POST /webhook/whatsapp` (needs a public URL — ngrok while developing). The applicant gets an auto-reply with their live document count and a link back to the assistant.

### ⚠️ Known live-account issues (Exotel, as of last session)

The user's real Exotel account (`upsy61`, Singapore region, KYC verified) is wired in `.env` and was tested live. Two account-side blockers, not code bugs:
- **SMS**: `403 Insufficient balance to send SMSes` — account needs a recharge.
- **WhatsApp**: `403 Whatsapp number doesn't exist in your account` / `From number is invalid` — the `EXOTEL_FROM` value (`09513886363`, the SMS ExoPhone) is **not** registered as a WhatsApp Business sender on the account. WhatsApp needs its own approved WhatsApp number from the Exotel WhatsApp product, separate from the SMS ExoPhone. Check the Exotel dashboard's WhatsApp Business API console for the correct number.
- Also, once real messaging is enabled: the demo `STALE_AFTER_MS` (3 min) / background sweep in `server.js` will spam every in-progress demo application repeatedly. Before going live, either bump the threshold to realistic values (~24–48h) or clear out `data/applications.json` demo records — otherwise old test leads keep getting real reminders attempted (and failing) every minute.

### Twilio (WhatsApp, good for quick sandbox testing)

`backend/whatsapp.js`. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, then `NOTIFY_CHANNEL=whatsapp`. Point Twilio's inbound webhook at the same `POST /webhook/whatsapp`.

## Email the document packet when complete

`backend/mailer.js`. **Only once every required document is received**, the server automatically bundles all the uploaded files and emails them (as attachments) to your ops/underwriting inbox, with a summary of the applicant, eligibility, and each document's check score. The team dashboard also shows a "Document packet" panel with a manual **Email packet / Re-send** button once an application is complete.

Guarantees (all verified): it will **not** send while any required document is still missing, and it will **not** send twice automatically (the officer can still manually re-send).

To go live, set: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `OPS_EMAIL` (where packets are delivered). Without them it safely logs what it *would* send.

**Google Workspace setup:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` = a Workspace mailbox, `SMTP_PASS` = a Google **App Password** (Google Account → Security → 2-Step Verification must be ON → App passwords → generate one for "Mail" — use that 16-character code, not your normal password).

## ⚠️ Ops & reliability notes (learned the hard way, 2026-07-27)

- **Never run two server instances.** The uncaught-exception guard used to "recover" `EADDRINUSE`, leaving a **zombie server with no port but a live background sweep** — every minute it rewrote `applications.json` from its stale in-memory cache. Real observed damage: an applicant deleted documents (files correctly unlinked from disk), then a zombie **resurrected the deleted records**, leaving "verified" documents whose files no longer exist. Fixed: `EADDRINUSE` is now **fatal** (`process.exit(1)`), so a second `npm start` dies immediately instead of becoming a zombie. If port 3000 seems stuck on Windows: `Get-NetTCPConnection -LocalPort 3000 -State Listen` → `Stop-Process -Id <pid> -Force` (killing the npm wrapper does not always kill the node child).
- **Missing-file resilience** (records can outlive files): the file-serving route now 404s cleanly instead of 500ing, the applicant preview explains "preview isn't available anymore — attach a fresh copy", and the packet email skips dead attachment paths (a dead path used to fail the whole nodemailer send). The lender `.eml` builder already skipped missing files.
- **The project lives under `OneDrive\Desktop`** — cloud sync is a suspect whenever `data/uploads/` files disappear, and sync can also lock files mid-write. Consider moving `data/` (or the whole project) outside OneDrive before real use.
- **Exotel is currently OFF** (`NOTIFY_CHANNEL=mock` since 2026-07-27) — the sweep was making real (failing, balance-blocked) SMS/WhatsApp attempts against the live account every minute during dev. Credentials are untouched in `.env`; set `NOTIFY_CHANNEL=exotel` to re-enable at launch (after fixing the account-side blockers + raising `STALE_AFTER_MS`).
- Notifier writes (`recordNudge`) and edits made to `applications.json` by external scripts don't mix while the server runs — the store caches the JSON in memory and writes it back whole. Stop the server before hand-editing data files.

## Deployment (Render)

Live test deploy, 2026-07-30: **https://upsy-loan-agent.onrender.com**

- `render.yaml` (Blueprint config) defines the web service — `npm install` / `npm start`, free plan. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `APP_URL`, and (as of 2026-07-31) `AGENTCALL_API_KEY` are all `sync: false` (entered in the Render dashboard, never stored in the yaml). `NOTIFY_CHANNEL=mock` is baked in, matching the local "Exotel off" state.
- **Verified live end-to-end**: `/login` → `/intake` sign-in with a demo lead works and greets correctly; `/team.html` dashboard loads and reflects live applications; no console errors on either page.
- **Re-deployed 2026-07-31** (manual deploy, after `AGENTCALL_API_KEY` was added to the Blueprint and filled in on the dashboard): confirmed the redeployed instance is up (`/login` returns 200) and `/api/session/start` correctly signs in a demo lead (`LD-1001` / Aarav Sharma) on the fresh container. **Live-assist itself confirmed working on the deployed instance as of 2026-08-01** (user-tested) — no longer local-only.
### Deploying the voice stack (2026-08-07)

The relay changes what deployment means for voice: on the old hosted path the browser streamed audio straight to Cartesia and this service only minted a token, so it barely mattered where it ran. **Now the audio flows through this service** — STT up, TTS down, plus a pacing pass per chunk.

**Two variables must be set in the Render dashboard** (both `sync: false`, so they are never in the repo). Copy the values from your local `.env`:

| Variable | Where the value comes from | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | local `.env` | Hearing. Without it the agent speaks, then says out loud that it cannot hear. |
| `VOICE_PROVIDER` | set to `upsy` | Blueprint already defaults to this; confirm the dashboard is not overriding it with `cartesia`. |

`CARTESIA_API_KEY` should already be present from the hosted-agent era — it is now used for **TTS only**. `CARTESIA_AGENT_ID` is dead weight on this path and can be left or removed. One of `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` is required for the brain; OpenRouter is what runs today.

**Check the boot log after deploying.** It states the whole chain in one line, and is the fastest way to know a key did not take:

```
Voice relay: Deepgram → OpenRouter (openai/gpt-4o-mini) → Deepgram Aura (aura-2-athena-en)
Voice: pre-synthesised 13 repeated phrases (greeting + acknowledgements).
```

Anything reading `DEAF (no DEEPGRAM_API_KEY)` or `MUTE` means the dashboard variable did not land.

**⚠️ Free tier will bite a demo, specifically:**
- **Cold start is ~50s after 15 min idle.** Someone opening the link cold waits on a blank page long enough to form an opinion. Open it yourself a minute before sending it to anyone.
- **Shared CPU, and audio now passes through.** Fine for one call; several concurrent callers on a free instance is untested and is the first thing to break.
- WebSockets themselves are fine on Render's free tier — the relay needs no special configuration beyond running on the service's own port, which it does.

- **⚠️ Storage is ephemeral on the free tier.** `data/applications.json` + `data/uploads/` are gitignored, local-disk-only (`backend/store.js`, `backend/files.js`). Free-tier instances spin down after 15 min idle and lose that disk on respin — any application created mid-testing won't survive a gap in usage or a redeploy. The 3 pre-seeded demo leads (`mockSource.js`) always survive, since they're code, not `data/`. Fine for single-sitting testing (decided against a paid instance + persistent Disk for now — revisit if multi-day test persistence is ever needed). Confirmed again on the 2026-07-31 redeploy: application list was back to empty on the fresh container, as expected.

## Configuration (.env)

All credentials are read from a `.env` file (loaded automatically via `dotenv`). Copy the template and fill it in:

```bash
cp .env.example .env   # then edit .env with your Exotel + SMTP values
npm start
```

`.env` is gitignored. With nothing set, everything runs in demo mode (messages/emails are logged, not sent).

## Code map

- `backend/llmProviders.js` — **which endpoint the non-Claude side talks to**, decided in one place: OpenRouter when its key exists, otherwise OpenAI's own API with the `openai/` model prefix stripped. Placeholder values (`your_…_here`) count as absent. Ten modules used to hardcode this URL each, which is how one of them ends up pointing somewhere else. **This is the file that makes "swap providers by editing `.env`" true.**
- `backend/documents.js` — the requirements config: stages, documents in collection order, the "why" text, and per-document format rules. **Edit here to change what the agent collects.**
- `backend/validators.js` — the format cross-check logic (magic-byte sniff, PAN regex, Aadhaar Verhoeff checksum).
- `backend/ocr.js` — local-OCR fallback: reads PAN/Aadhaar/name/DOB off card images; fuzzy-corrects common OCR misreads; the Verhoeff checksum for Aadhaar (`aadhaarChecksumValid`); `namesMatch()` / `addressesMatch()` — the fuzzy comparators used by cross-document consistency (both reusable for validating any vision-model output, not just OCR's own).
- `backend/capture.js` — **vision-first** document capture: Claude (images + PDFs, retry on 429/529) → OpenRouter → OCR; Aadhaar Verhoeff checksum enforced on all vision reads (see "Vision document capture" above).
- `backend/intake.js` — smart-intake structuring: free text → loan intent JSON + follow-up questions (Claude → OpenRouter chain).
- `backend/assist.js` — "Ask UPSY" doc Q&A: grounded answers about the current document, including why a failed upload failed (Claude → OpenRouter chain).
- `backend/eval-cards.js` — `npm run eval`: batch card-reading eval / model A/B harness over `data/uploads/` or given paths.
- `backend/eligibility.js` — the underwriting rules engine (pure function, no dependencies — easy to unit test or tune).
- `backend/lenders.js` — demo partner-lender catalogue + rule-based lender matcher (see "Lender referral flow").
- `backend/institutes.js` — partner-institute list + alias-tolerant matcher.
- `backend/instituteVerify.js` — **the false-info check**: web search (Serper, or DuckDuckGo's keyless endpoint) → LLM judge, one pass per distinct claim per call, off the voice path and cached per process. Returns `found` / `unclear` / `not_found` plus any published fee a snippet states. Two rules are load-bearing: `not_found` is reserved for **the institute itself** (a real institute whose snippets don't show the exact course caps at `unclear`), and the verdict never reaches the agent's prompt — **the agent must never accuse a caller**, so the flag goes only to the officer on `/team`.
- `backend/lenderDraft.js` — lender referral email drafting (LLM chain + template fallback) and the `.eml` (Outlook draft) export with attachments.
- `backend/income.js` — income extraction from ITR / salary slips (ITR annual ÷ 12 rule); also reads address now. Feeds eligibility, credit memo and lender drafts. Has a plausibility guard (rejects `salary_slip` reads above ₹5L/month as likely mislabeled annual figures — see "Income eval harness" above).
- `backend/bankStatement.js` — reads the co-applicant's name, address, and registered phone off `co_bank_statement` (Claude → OpenRouter chain); phone becomes the co-applicant's contact (see "Co-applicant identity verification" above).
- `backend/eval-income.js` — `npm run eval:income`: batch income-doc eval / model A/B harness over the project root + `data/uploads/` or given paths (now also prints extracted address).
- `backend/leadSources/` — the pluggable lead-source layer (`mockSource.js` + `index.js` registry). **Add real platforms here.**
- `backend/lenderForms/` — per-site screen/field guides for the live-assist agent. `upsyIn.js` (the course-invite entry path — **a real third-party platform, not this product, despite the name**) and `avanse.js` (the lender's own 14-screen journey, plus cross-cutting rules like "verify every auto-filled field"). `index.js`'s `buildLenderGuidancePrompt()` renders all registered portals into one system-prompt block in journey order; the agent works out which site is on screen itself (URL/logo), so there's deliberately no code-side selector. **Add a portal by creating `<name>.js` here and registering it in `index.js`.**
- `backend/voiceCall.js` — **browser voice calls** (`/upsy-voice-agent`): the session builder behind `POST /api/voice/session`, and the `VOICE_PROVIDER` switch. `upsy` mints a single-use ticket for our own relay; `cartesia` mints the vendor's short-lived agent token. Both return the identical shape, which is why the browser needs no branch. **Not the same thing as `liveAssist.js`** — see the comparison table in "Start here".
- `backend/voiceRelay.js` — **our own voice agent.** A WebSocket server on this process's own port (`/voice/stream`) that terminates the caller's audio socket and orchestrates the call: turn-taking, barge-in, conversation history, per-call teardown. Speaks `voiceClient.js`'s existing vocabulary exactly (`start`/`ack`/`media_input`/`media_output`/`clear`) so the browser never changed. `VOICE_RELAY_MODE=echo` bounces the caller's audio straight back — the transport test, with no AI in the path.
- `backend/voiceStt.js` — hearing: Deepgram streaming + endpointing. Emits *speech started* (barge-in), interim transcripts (the constellation), and *turn finished*. Falls back to a deliberately deaf engine when no key is set, so the agent still speaks and says plainly that it cannot hear.
- `backend/voiceBrain.js` — thinking: Claude Haiku 4.5 → OpenRouter, **streamed and split into sentences as it arrives** so speech starts before the reply is finished. Abortable mid-generation (the `respondTo()` lesson from `liveAssist.js`), and it logs Anthropic's cache-hit counters so the cost model is checked against evidence.
- `backend/voiceTts.js` — speaking: **Deepgram Aura** (`aura-2-athena-en`) over its streaming websocket, with **Cartesia Sonic** kept behind `TTS_PROVIDER=cartesia`. One socket per call rather than per sentence, since opening one costs ~1s. **⚠️ Aura's audio frames carry no request id**, so a request that ends any way other than its own `Flushed` marks the socket dirty and the next sentence drains it (`Clear` → `Cleared`, or a fresh socket) — without that, one abandoned sentence's audio plays inside the next one for the rest of the call. Read the header comment before touching `speak()`. Also holds the **phrase cache**: the greeting and acknowledgements are bought once and replayed (1593ms → 25ms), pre-warmed at boot by `warmVoiceCache()`. Every sentence has a 10s ceiling — without one, a stalled socket hangs the shared speech queue and silences the agent for the rest of the call.
- `backend/voiceFillers.js` — the spoken acknowledgements that hide model latency ("okay, so you want to know which documents…"), chosen by keyword match **before** the model has decided anything. That is exactly why every line restates the question and stops: a number, rate or verdict here would be this server inventing lending advice. Hindi lines are written and waiting on Sarvam.
- `backend/voicePacing.js` — slowing the agent down, since the vendor will not. Not resampling (drops the pitch and makes her a different person) and not time-stretching (CPU per sentence, smeared consonants) — it lengthens the **gaps between words**. ⚠️ Gap-widening is OFF by default (`VOICE_PACE_EXTRA_MS=0`) because it stutters mid-word in practice; only the between-sentence pause is on. Read the header before re-enabling it.
- `backend/sentences.js` — pure sentence helpers, kept out of `liveAssist.js` because that file spawns the AgentCall bridge on import and cannot be loaded from a test. `takeCompleteSentences()` only treats a sentence as complete once it sees whitespace **after** the `.?!` — never merely the end of the buffer, which is the whole trick for streaming speech without cutting decimals in half.
- `backend/eval-voice-latency.js` — `npm run eval:voice`: where the silence on a call actually comes from. Measures **time to first sentence**, not total generation, because the relay speaks each sentence as it lands. Run it before changing a voice model, not after — the ranking has nothing to do with which model reads a PAN card best.
- `backend/voice-relay-check.js` — `npm run voice:relay`: runs the relay in-process on an ephemeral port and drives it with a fake browser — config → transport echo → single-use tickets → *does it actually speak* → does the brain stream sentences. Needs no running server and no real applicant data.
- `backend/callSchema.js` — **what a call is supposed to establish**: the team's five branches, every field with the question that asks for it, and the derived branch (FOIR, lender bands, every flag rule on the flowchart). Also owns coercion — `parseRupees()`, the CGPA guard, the "a relationship is not a name" rule. **Edit here to change what the agent collects**; the prompt, the extractor and the dashboard all read it rather than restating it.
- `backend/docPlan.js` — **the join with the doc collection agent.** Branch facts → the documents *this* person actually needs, the ones they do not (with the reason each was dropped), and the question that would settle the rest. Read by the voice prompt, `/api/voice/accounts/:id` and the dashboard. **Edit here to change how a param narrows the list.**
- `backend/callExtract.js` — **transcript → branch facts.** Claude → OpenRouter, temperature 0, validated against the schema, every value carrying the caller's own words and a check that the quote is really in the transcript. `fileCall()` is the whole write path (extract → merge → recompute derived) and is what both the relay and `eval:extract` call, so there are not two versions of it.
- `backend/eval-extract.js` — `npm run eval:extract`: the FOIR maths, lender bands, flag rules and coercion guards offline, then a scripted call through the real extractor. `-- --seed` writes that call into the store for the dashboard.
- `backend/voicePrompt.js` — that agent's entire system prompt + opening line, deliberately kept in this repo rather than on the vendor's dashboard. Voice-only rules (never ask for an ID number *aloud*), eligibility facts copied from `eligibility.js`, a document checklist generated from `documents.js` so it cannot drift, and **the collection agenda generated from `callSchema.js`** — which shrinks to only what is still missing for that particular caller. The derived branch is deliberately withheld from the agent: it must never tell someone they are a "Lender 3 case", and the surest way is for it never to have been told.
- `backend/voice-check.js` — `npm run voice:check`: walks the same chain a real call walks (env → agent exists → agent deployed → token mints → socket accepts `start` → the agent actually speaks) and stops at the first thing that is wrong. Written because an undeployed agent's `1011 Internal server error` sent a whole session through the audio code before anyone looked at the account.
- `backend/voiceAccounts.js` — **`/upsy-voice-agent`'s own accounts**, separate from the lead source on purpose. scrypt password hashing (node crypto, no dependency), server-side sessions, per-account call history and the standing profile earlier calls established. `publicAccount()` is the only shape allowed out of the module; the hash never reaches a route, a prompt or the dashboard. File-backed in `data/voiceAccounts.json`, same ephemeral-storage caveat as the rest of `data/`.
- `backend/reviews.js` — **what the caller thought of the call.** File-backed like `callbacks.js`, same "a list an officer reads, not a system of record" shape. Owns the 1–5 validation (`parseRating` rejects `0`, `6`, `4.5` and `"abc"` alike), the summary the dashboard shows, and the rule that only a **poor** rating messages ops. **Edit `POOR_RATING` here to change what counts as worth interrupting someone for.**
- `backend/callbacks.js` — the "Schedule call" queue behind `/upsy-voice-agent`: phone normalization, file-backed storage in `data/callbacks.json`, and the ops message. Deliberately a queue an officer reads, not a system of record.
- `backend/rateLimit.js` — tiny in-memory per-key limiter. Exists because `POST /api/voice/session` is public and every hit mints a billable credential; `POST /api/voice/callback` uses it too, more generously.
- `frontend/voice-agent.html` / `frontend/voice-agent.js` — the mobile surface: the pre-call brief, device pickers, the connecting screen, and the in-call constellation (hub, topic nodes, easing camera, timer, mute, End) plus the schedule-a-callback sheet. Self-contained CSS, no Tailwind CDN. **Its own page, not a route of the applicant SPA.**
- `frontend/voiceClient.js` — the audio pump: mic → `AudioWorklet` → PCM → WebSocket → `AudioBuffer` playback queue. Provider-agnostic; knows nothing about loans. Exposes `UpsyVoice._codec` for testing the conversion math.
- `backend/liveAssist.js` — **the live-call agent** (`npm run assist:call`): joins a real Meet/Zoom/Teams call through AgentCall and voice-guides an applicant through a lender's form, grounded in UPSY's eligibility rules and that applicant's real record. Owns the turn-taking race fix (each turn claims a number and aborts the previous in-flight reply) and the incremental "never say the same line twice" rule. **Not the same thing as the `/upsy-voice-agent` voice stack** — different feature, different transport.
- `backend/liveAssistManager.js` — the process manager around it: spawns and reaps the child, builds the call context (including the **verified KYC name** read off the ID document, names only, never the numbers), and enforces the one-call-at-a-time global lock. The stop endpoint waits for real process exit, with a `SIGKILL` escalation after 3s.
- `backend/agentcall/bridge.js` — the AgentCall API client underneath both. ⚠️ It hardcodes `transcription: true` and never wired up raw audio, which is what blocks the "own the voice layer on Meet calls" step in the roadmap.
- `frontend/liveAssistPhases.js` — one shared vocabulary for the call phases, loaded by *both* `index.html` and `team.html` so the applicant and the officer read the same words for the same state. Exists because the UI used to say "in progress" from the instant the process spawned — a bot stuck in a waiting room looked identical to one that had joined, with nobody realising it needed admitting.
- `backend/notifier.js` — picks the active reminder channel (mock console / Exotel / Twilio).
- `backend/exotel.js` — real Exotel SMS + WhatsApp integration (primary messaging provider; see known issues above).
- `backend/whatsapp.js` — real Twilio WhatsApp integration (alternative provider, good for sandbox testing).
- `backend/mailer.js` — the completion-packet email (real SMTP or free Ethereal test mode via `MAIL_TEST=1`).
- `backend/store.js` — file-based application store (verified docs, eligibility, nudge history — remembers everything so the applicant can resume).
- `backend/files.js` — saves verified uploads to disk so the team can open them.
- `backend/server.js` — Express app and every API route.
- `frontend/index.html` / `frontend/app.js` — the applicant multi-page step UI, now with client-side routing (`/login` → `/intake` → `/docs`), the smart-intake step, EMI assistance card, and the "Ask UPSY" panel (see "Applicant flow details" above). No `styles.css` — styling is inline Tailwind config + a small `<style>` block in `index.html`.
- `frontend/intake.html` / `frontend/intake.js` — the standalone smart-intake demo page (isolated from the main flow; kept as the build-vs-buy comparison artifact — candidate for removal now that `/intake` is a real step).
- `frontend/team.html` / `team.js` — the UPSY Admin team dashboard (left-sidebar layout).
- `research/kuhoo-journey.md` — the competitor research the requirements are based on.
- `STITCH_PROMPT.md` / `BUILD_PROMPT.md` — design/build prompt source material (see "Design source material" above).
- `.env` / `.env.example` — all secrets; `.env` is gitignored. **The user has pasted real production secrets into chat at least twice** (Exotel, Salesforce, Zoho, HubSpot, Twilio, Groq, OpenRouter, LeadSquared, Deepgram, Sarvam keys, and a Salesforce **password**) — if a new session sees more secrets pasted in, flag rotating them (especially any password) and never echo them back in full.

## Status (what's done)

- [x] Kuhoo journey + document requirements researched
- [x] Applicant chat agent: sign-in → personalized greeting → document requests with "why" explanations → live verification reports
- [x] Lead-source adapter pattern: mock source with 3 demo leads; easily wire Zoho/Salesforce/LeadSquared
- [x] OCR auto-fill: reads PAN/Aadhaar/name/DOB off card images + cross-checks typed number against document
- [x] Format validation: file type, magic-byte sniff (catches renamed files), size limits, PAN regex, Aadhaar Verhoeff checksum
- [x] Name/DOB extraction: fills a blank profile from the document, flags a mismatch against the lead record
- [x] **Eligibility engine**: instant preliminary decision (amount/rate/moratorium) shown to applicant + team
- [x] **Cross-document consistency check**: compares name/DOB across all of an applicant's own uploaded documents
- [x] UPSY team dashboard: real-time application list, full profile, per-doc status, "View" file links, eligibility card, mismatch flags, activity timeline
- [x] File storage: uploads saved on verification; officers can open each document from the dashboard
- [x] Officer actions: Approve / Reject application (with optional notes); Request re-upload of a specific document
- [x] **Drop-off recovery**: auto-detects stalled applications, sends reminders (auto + manual), pluggable channel
- [x] **Messaging integration**: Exotel (SMS + WhatsApp, `both` mode) and Twilio, behind one pluggable channel; inbound webhook auto-detects the provider. Needs your credentials to actually send.
- [x] **Email packet on completion**: once all required docs are in, auto-bundles the files and emails them to ops (with a manual re-send button); gated so it never sends early or twice
- [x] Resume & persistence: applicant progress remembered; re-upload requests put docs back in the queue
- [x] **Vision document capture**: PAN/Aadhaar number + cardholder name + DOB read via OpenRouter vision model, OCR fallback (see known accuracy issue above — name/DOB reliable, number is not yet)
- [x] **UI rebuild in Kita style**: both applicant flow and team dashboard rewritten from Stitch-generated designs (blue/white, spacious, left-sidebar admin layout); fake/invented features from the mockups deliberately excluded
- [x] **Document checklist sidebar + resume navigation**: jump to any document, replace an already-uploaded one, no double-counting, no duplicate completion emails
- [x] **Live-tested real Exotel account** (SMS + WhatsApp): code confirmed correct (auth succeeds, payload format fixed for WhatsApp), blocked only by account balance + WhatsApp sender registration (see known issues above)
- [x] **Live-tested free email path**: Ethereal test-mode SMTP (`MAIL_TEST=1`) confirmed a real packet email end-to-end with attachments, no real SMTP account needed for testing
- [x] **Claude vision path** (`capture.js`): direct Anthropic API, Claude → OpenRouter → OCR chain, **PDF support** (Claude only), 429/529 retry with backoff, startup reader-priority log — dormant until `ANTHROPIC_API_KEY` is set
- [x] **Aadhaar checksum guard on vision reads**: `cleanNumber()` enforces the Verhoeff checksum, closing the old #1 number-accuracy issue (misreads degrade to manual entry instead of showing wrong numbers)
- [x] **Claude accuracy validated manually** (claude.ai, user's real PAN + Aadhaar, app's exact prompts): all fields exact; Aadhaar passed the Verhoeff checksum — objective proof
- [x] **Eval harness** (`npm run eval` / `backend/eval-cards.js`): per-file number/checksum/name/DOB/reader/latency; also the model A/B tool
- [x] **Fixed: PDF uploads crashed the server** (tesseract worker-thread throw escaping try/catch) — found by the eval harness, guarded in `ocr.js`
- [x] **Smart intake** (`/intake` + `/api/intake` + standalone demo): free text → structured loan intent → inline gap questions → context banner → `intake_captured` on the lead timeline
- [x] **Client-side routing**: `/login` → `/intake` → `/docs` with history, back/forward, and auth guards; server serves the SPA for those routes
- [x] **EMI assistance card** on `/docs` (Auxilo-style): moratorium-aware education-loan EMI, pay-interest-during-study toggle, live tenure slider — verified interactively
- [x] **"Ask UPSY" doc helper** (`/api/assist` + right panel on every doc page): grounded doc Q&A incl. rejection explanations — verified live ("Why is this needed?" on Aadhaar)
- [x] **Researched MagicX AI Autocomplete SDK & Auxilo Smart Loan signup** — build-vs-buy call: built the intent-structuring concept in-house (see "Smart intake" section); MagicX only worth revisiting for per-keystroke UX and only self-hosted + DPA
- [x] **Phased roadmap agreed** (with CEO-ready one-liners): 0 prove reader → 1 harden pipeline → **2 compliance HARD GATE (DPDP, retention/ZDR, PII hygiene)** → 3 form-assist → 4 conversational agent → 5 scale/ops
- [x] **Lender referral flow** (2026-07-27, backend-tested end-to-end; UI pending manual QA): demo lender catalogue + matcher, partner institutes, LLM lender-specific drafts with template fallback, `.eml` Outlook export with attachments, per-lead "Draft email" button, drafted/shared events with full detail on the Activity tab, applicant lender cards + upload preview
- [x] **Income extraction** (2026-07-27): ITR annual ÷ 12 / salary-slip gross monthly via LLM chain (PDFs work on OpenRouter file-parser without the Claude key), re-runs eligibility, verified live with synthetic fixtures
- [x] **Per-document-step browser history** (`/docs/N` URLs, applicant) + **URL state on the team dashboard** (`?lead=&tab=`) — Back/Forward now walks steps instead of leaving the flow; refresh restores the applicant session from `sessionStorage`
- [x] **Document preview everywhere** (attach-time + stored-file on revisit, iframe-based PDFs) with **delete icons** (clear selection / delete uploaded doc via new DELETE endpoint)
- [x] **Zombie-server data corruption found & fixed** (EADDRINUSE now fatal; dead verified-records pruned; missing-file 404s + graceful UI notes; packet-email attachment guard) — see "Ops & reliability notes"
- [x] **Income eval harness** (`npm run eval:income` / `backend/eval-income.js`, 2026-07-29): tested against 12 real fixture files (ITRs, computation sheets, Form 16 A/B, payslips) the user dropped into the repo
- [x] **Fixed: Form16PartB misread as a salary slip** — annual figure was being reported as monthly (would have inflated eligibility ~12×). Fixed with a tightened prompt + a new plausibility guard (`salary_slip` > ₹5L/month rejected outright) — same "validate the shape, not just the format" philosophy as the Aadhaar checksum
- [x] **Found (not yet fixed): non-deterministic digit misreads on income figures** — same file read twice gave ₹1,39,100 vs ₹13,91,000 on the free OpenRouter model; no checksum exists for income the way Aadhaar has one — reinforces Phase 0 priority
- [x] **Co-applicant identity verification** (2026-07-29, requested via WhatsApp): name/address extraction generalized beyond PAN/Aadhaar to income proof + new `backend/bankStatement.js`; address cross-document matching added (`addressesMatch()`); bank-statement phone becomes the co-applicant's persisted contact — all verified live through the real dashboard UI (Fraud Check tab correctly flagged both a name and an address conflict between two real documents)
- [x] **Fixed: student-vs-co-applicant false-positive cross-document bug** — the existing consistency check compared two different people's documents against each other; scoped by `identityGroup()` so student docs only compare against student docs, co-applicant against co-applicant
- [x] **EMI assistance + matched lenders relocated** to the completion screen (user-requested, 2026-07-29) — no longer shown before any document is uploaded
- [x] **Removed unprofessional emoji from the team dashboard** (💰/📞 → plain text, user-requested)
- [x] **Deployed to Render** (2026-07-30): `render.yaml` Blueprint, live at https://upsy-loan-agent.onrender.com, verified end-to-end (login/intake sign-in + team dashboard both working, no console errors) — see "Deployment (Render)" above for the ephemeral-storage caveat
- [x] **Live-call assistance via AgentCall** (2026-07-31): `backend/liveAssist.js` (standalone, real-time — replaced an interactive-agent prototype that was too slow) + `backend/liveAssistManager.js` (process manager) join a real Meet/Zoom/Teams call and voice-guide the applicant through a lender's form, grounded in UPSY's own eligibility rules and that applicant's real record; wired into the team dashboard, the applicant's completion screen, and the Ask UPSY panel on every document page — see "Live-call assistance via AgentCall" above for the full build story and known gaps (one-call-at-a-time limit, stop-endpoint race)
- [x] **Live-assist confirmed on the deployed Render instance** (2026-08-01): `AGENTCALL_API_KEY` wired through `render.yaml` + the Render dashboard, redeployed, user-verified working in production — no longer local-only
- [x] **Fixed: officer-started calls now text the applicant the join link** (2026-08-02): the team-side button previously had no way to get the applicant into the meeting — the bot joined an empty call and timed out alone after ~2 min. Officer-initiated calls now send the link over the same notifier channel as the reminder nudges (`liveAssistInviteMessage()` in `notifier.js`), and the card reports whether it sent or why it couldn't; applicant-initiated calls deliberately skip it via a `notifyApplicant` flag, since they created the meeting themselves. **Caveat:** `NOTIFY_CHANNEL=mock` today, so the invite only prints to the server console until Exotel is switched on
- [x] **Avanse documented as the live-assist target** (2026-08-02): observed screens/fields recorded plus nine applicant failure modes with intended agent behaviour — see "Avanse (`online.avanse.com`)" above; this is the spec for the current active phase
- [x] **Live-assist repeat bug fixed** (2026-08-03): `dedupeRepeatedSentences()` in `backend/liveAssist.js` collapses consecutive duplicate sentences in a reply before `tts.speak`, so a model echo no longer gets spoken as the same line twice in a row
- [x] **Per-lender field guide + self-detection wired into live-assist** (2026-08-03): `backend/lenderForms/` (`avanse.js` + `index.js`) grounds the agent in Avanse's actual screens/fields; the agent identifies the lender itself from the screen rather than any code-side selector, since the applicant learns the lender from an email UPSY doesn't record. Surfaced a correction to the "submit dead-end" finding — see the Avanse section above
- [x] **Agent upgraded to handle the real Avanse journey** (2026-08-04): `backend/lenderForms/avanse.js` rewritten from the quick-form-only config to the full referred-applicant journey (consent screen → 5-stage wizard → both people's Applicant Details → co-applicant hand-off → income → address → bank verification), plus a new `upsyIn.js` covering the invite/financing-option entry path as its own detectable portal. Encodes the three first-hand failure modes as cross-cutting rules: verify every auto-filled field, ask outright about the correspondence address, never read the celebratory hand-off screen as success
- [x] **Live-assist precision fixes** (2026-08-04): screenshots are now grabbed **on question arrival** (2s timeout, falls back to the 5s poll) so the agent describes the field they're actually on; `MAX_HISTORY` 8 → 24 so it stops forgetting the top of a long form; `temperature` 0.3 → 0.1 since field guidance should be near-deterministic; `tts.interrupted`, `call.max_duration_warning` and `call.credits_low` are now handled instead of silently ignored; and `OPENROUTER_LIVE_ASSIST_MODEL` lets live-assist use a different vision model from the document readers, which previously shared one env var
- [x] **Verified KYC name fed into the call** (2026-08-04): `liveAssistManager.buildContext()` now passes the name as it reads on the applicant's (and co-applicant's) verified ID document, so the agent can say "type it exactly this way" — the thing a lender's own form structurally cannot do (failure mode #6). Names only; never the ID numbers on those documents
- [x] **Live-assist turn-taking race fixed** (2026-08-05): generating a reply takes seconds (fresh screenshot grab, then the model call) and `respondTo()` was not serialized, so an applicant who spoke again inside that window triggered two concurrent replies — **both** spoken, the stale one first, with `history` written out of order so the following turn saw garbled context. Each turn now claims a number and aborts the previous in-flight request; a reply is only spoken if its turn is still the newest, while the applicant's words are recorded either way so the surviving turn still sees everything they said. This is the other half of the "it answers the wrong thing" complaint that `dedupeRepeatedSentences()` only partly addressed
- [x] **Stop endpoint now waits for real process exit** (2026-08-05) — closes the UI flicker race; see "Live-call assistance via AgentCall" above, including the Windows-only `SIGINT` caveat it surfaced
- [x] **Browser voice calls + the `/upsy-voice-agent` mobile surface** (2026-08-06): `backend/voiceCall.js` + `voicePrompt.js` + `frontend/voice-agent.html`/`voice-agent.js`/`voiceClient.js` — the applicant taps a button on their phone and talks to UPSY with no meeting platform involved, anonymously or grounded in their own record. Cartesia-backed, prompt kept in git, rate-limited, codec unit-tested. See "Browser voice calls (`/upsy-voice-agent`)" for what was verified and what wasn't, including the Profound teardown it was modelled on
- [x] **Root-caused the `/upsy-voice-agent` call failure: the Cartesia agent was never deployed** (2026-08-07). Not our code — an undeployed agent accepts the WebSocket handshake and closes it with `1011 Internal server error`, and bisection showed every payload including a bare `{"event":"start"}` fails identically. Now caught in three places instead of costing a debugging session: `checkAgentReady()` preflights at boot and before every call, the route returns a 503 whose detail names Publish as the fix, and `npm run voice:check` (`backend/voice-check.js`) walks the whole chain. **The Publish button itself has not been pressed — that is the one remaining step**
- [x] **`/upsy-voice-agent` rebuilt around Profound's flow** (2026-08-07, team-requested): brief with a "what we'll cover next" card → mic permission → device pickers → connecting → an in-call constellation with an easing camera. Deep-green theme, desktop phone-frame, self-contained CSS. The constellation is honestly framed as a map of what you can ask, since we get audio frames and not a transcript — `matchTopic()` upgrades it automatically if a real transcript event ever turns up
- [x] **"Schedule call" is a real callback request** (2026-08-07): `POST /api/voice/callback` + `backend/callbacks.js` + `GET /api/voice/callbacks`, with phone normalization, an ops notification and a `callback_requested` timeline entry. Closes the "anonymous caller evaporates" gap — including for callers who cannot get through at all
- [x] **`/upsy-voice-agent` accounts + remembered calls** (2026-08-07): `backend/voiceAccounts.js` (scrypt passwords, sessions, call history), a sign-in screen on `/upsy-voice-agent` that is skippable by design, the relay filing each call's transcript against the account, `buildVoiceSystemPrompt()` grounding the next call in the last one, and a **Voice callers** view on the team dashboard. See "`/upsy-voice-agent` has its own accounts now" above. The extractor this entry originally deferred landed three days later — next line
- [x] **The `/upsy-voice-agent` branch extractor** (2026-08-10): `backend/callSchema.js` encodes the team's five branches, `backend/callExtract.js` reads a live transcript into them off the voice path (temperature 0, every value carrying the caller's own words, each quote checked against the transcript), and `fileCall()` is the single write path both the relay and the eval use. `npm run eval:extract` covers it with 113 checks
- [x] **Our own voice stack, end to end** (2026-08-07): `voiceRelay.js` terminates the caller's socket on this process and runs the call itself — Deepgram nova-3 `en-IN` hearing, Claude Haiku 4.5 thinking, **Deepgram Aura speaking** (moved off Cartesia when its free tier ran dry). `frontend/voiceClient.js` did not change by one line, which was the actual hypothesis being tested. 524ms from a real browser to first spoken audio
- [x] **Reply latency 2.3–3.4s → ~0.85–1.5s** (2026-08-07): spoken acknowledgements (`voiceFillers.js`) carry most of the win, plus speculative generation and per-sentence streaming. `npm run eval:voice` is what found the brain was ~65% of the wait. The **phrase cache** buys the greeting and ten acknowledgements once and replays them: 1593ms → 25ms, pre-warmed at boot
- [x] **The four bugs only a real call found** (2026-08-10): the agent interrupting itself on speakerphone echo (barge-in now needs two recognised words, not a VAD blip), the 195–222 wpm rush, the gap-widening pacing that shipped and stuttered mid-word (now OFF by default), and the voice pick itself — all four measured afterwards, none catchable by the harness that existed. See "The first real calls"
- [x] **The team's five-branch loan file** (2026-08-10): `callSchema.js` encodes the underwriting flowchart — applicant → institute → loan → co-applicant, plus a derived branch (FOIR, lender bands, every flag rule). The agent works it as an **agenda, not a form** (answer their question first, one question at a time, drop what they will not answer), and `/team` → Voice callers shows an officer the branches, flags, FOIR and lender band **with the caller's own words under every value**. Second calls only ask for what is still missing
- [x] **Wired to the doc collection agent** (2026-08-10): `docPlan.js` narrows the document requests from what the call established — a salaried co-applicant is never asked for three years of ITR, a PG course pulls in the UG marksheet, an unsecured loan drops the property papers — with **dropped documents shown with their reason**, so an officer can tell narrowed from missed
- [x] **The constellation became the live loan file** (2026-08-10): `/upsy-voice-agent`'s star map was six hardcoded topics on a 7-second timer; it now draws `callSchema.js` itself, fed by `agenda` / `focus` / `transcript` events off the socket the relay already owns. Ruled-out questions fade rather than vanish — "not needed for you" is information
- [x] **The false-info check** (2026-08-11): `instituteVerify.js` searches the web for the course a caller names and judges it `found` / `unclear` / `not_found`, raising the new `course_not_found` threat and waking the dormant `fee_deviation` one. The verdict is deliberately withheld from the agent's prompt — **it must never accuse a caller** — and every search failure is silence, never a flag
- [x] **The first review round's three complaints** (2026-08-11): a real institute flagged over a speech-recognition spelling (`BTEC` for *B.Tech* — the judge now knows the claim came through a recogniser, and `not_found` is reserved for the institute itself), a question asked three times after "I don't know" (`_declined` markers, guarded so only the caller's own verbatim refusal counts), and documents requested that `/docs` had no upload slot for (the flowchart's income-category set now lives in `documents.js`, gated by `coApplicantCategory`)
- [x] **Switch providers by editing `.env` alone** (2026-08-11): `llmProviders.js` resolves the OpenAI-compatible side once (OpenRouter, else OpenAI) instead of ten modules hardcoding a URL. Remove the Anthropic key and every module — voice brain, extractor, verifier judge, document vision, intake, assist, lender drafts, the Meet agent — runs on the other side; add it back and Claude runs everywhere. Verified by running the full `voice:relay` loop green both ways. ⚠️ The Claude path **in `liveAssist.js` is unexercised on a real Meet call**
- [ ] **Escape the lead list in `team.js`** — `esc()` exists and the voice views use it; the older applicant-list and detail rendering still interpolate names and notes straight into `innerHTML`
- [ ] **Three more lenders' field guides** — same pattern as `avanse.js`, pending screenshots/walkthroughs of each

## Next (roadmap) — in likely priority order for a new session

**Where things stand (2026-08-11):** the full applicant + team flow is live on Render; the live-assist voice agent is confirmed working in production and texts officer-started join links to the applicant; `/upsy-voice-agent` runs on our own voice stack, files each call into the branch schema, narrows the document list from what the call established, checks the named course against the web, and runs on Claude or the OpenAI side depending on one key in `.env`. **The largest thing still unproven is not a build — it is that nobody has held a long, real conversation with the voice agent, and the reader evals in Phase 0 have never been run with the Claude key active.**

**The next session should start with "▶️ ACTIVE — build our own voice stack" below.** The Avanse-precision phase that used to be first is now **⏸️ PAUSED** — still real, still unverified live, just no longer the thing to open with.

Reading the rest of this roadmap:
- **Phase 0 (prove the reader)** is not competing with the active phase — it's a *dependency of it*. The Avanse `Loan Amount` field needs digits read reliably, and we have already caught `gpt-4o-mini` misreading numbers. Doing Phase 0 makes the active phase better.
- **"UPSY AgentCall" (own the call stack) is ⏸️ ON HOLD** as of 2026-08-02 — kept for reference, explicitly not queued. Do not start it.
- **Fine-tuning the webpage** (batched UI polish) is still open and independent.
- **Phase 2 (compliance)** remains the hard gate before any real applicant touches this — and note that live-assist *widened* it, since we now screenshot a shared screen and send it to a third-party model.

**Phase 0 — prove the reader (top of the list, now with two independent findings backing it):**
- [ ] **Re-add `ANTHROPIC_API_KEY`.** It was set on 2026-08-11 and its credits were **exhausted by 2026-08-12**, before a single eval below was run — so the Claude path has still never been measured here, and **PDF reading has no working reader again** (it is the only path that reads them). The blank key is deliberate: an exhausted key is worse than none, because every call tries it, fails, and falls back, paying the latency twice.
- [ ] Run `npm run eval` **and** `npm run eval:income` now that the key is set: the repo's PDF fixtures should go from "(not read)" to parsed with checksums passing, and the income figures should stop varying between runs — that's the demo-able proof.
- [ ] A/B `claude-opus-4-8` vs `claude-sonnet-5` vs `claude-haiku-4-5` (swap `ANTHROPIC_VISION_MODEL` between eval runs) on real + deliberately blurry cards **and** on the real ITR/Form16/payslip fixtures now in the repo root; pick by accuracy ÷ cost.
- [ ] Re-run `npm run eval:income` a few times on `ITR-24-25.pdf` specifically once Claude is active, to confirm the ₹1.39L vs ₹13.91L non-determinism is actually gone (not just less frequent).

**Partner-portal live assistance (see "Live-call assistance via AgentCall" above for full context — built and tested live, 2026-07-31):**
- [ ] Confirm what actually happens after Avanse's "Apply Now" quick form (check the Pending tab / the test inbox for an async follow-up) — **now genuinely unclear rather than "looks like a dead end"**: a 2026-08-03 screenshot showed submitted applications persisting as in-progress, resumable dashboard cards with an Application Number and stage tag, contradicting the earlier "No Application Found" observation. Needs a fresh, deliberate walkthrough to find out which is the normal case (and whether the two are just different points in the same flow).
- [x] ~~Wire AgentCall onto the deployed Render instance~~ — done 2026-07-31 (`AGENTCALL_API_KEY` in `render.yaml` + dashboard, redeployed), and **confirmed working live on the deployed instance 2026-08-01**. No longer local-only.
- [x] ~~Make the stop endpoint wait for the child process's actual `exit` event before responding~~ — done 2026-08-05, with a `SIGKILL` escalation after 3s. Surfaced a Windows-only `SIGINT` caveat in the process — see "Live-call assistance via AgentCall" above.
- [ ] Real concurrency handling beyond the current one-call-at-a-time global lock, if multiple simultaneous officer/applicant calls become a real need.
- [ ] Walk a real partner lender's full multi-step application live (not just the Avanse quick-apply first screen) to prove the guidance holds up beyond one form field.

---

### ⏸️ PAUSED — make the live-assist agent precise on Avanse (was active 2026-08-02, paused 2026-08-07)

> **Paused, not cancelled, and not finished.** The build below is written but **has never been exercised on a real call** — that verification item is still the most valuable single thing in this section. It lost priority on 2026-08-07 only because the voice work became both blocked and unblockable in the same day (see "▶️ ACTIVE — build our own voice stack" further down). Come back to this the moment a live Meet call is possible.

**The goal in one line:** an applicant on a call with UPSY, screen-sharing the flow from a `upsy.in` course invite through `online.avanse.com`, should get through it correctly on the first try — no wrong loan amount, no name mismatch, no panic at an unclear confirmation screen, no missed co-applicant hand-off. **Scope boundary (2026-08-04): the agent covers this all the way through co-applicant bank verification (Screen 14 in "Observed screens and fields") — KYC Verification and Additional Documents, past that point, are explicitly manual for now, not agent scope.** See "Explicit scope decision" in the Avanse section above.

**Read first:** "Where applicants will get stuck" in the Avanse section above. That list of failure modes (now 12, not just the original nine) *is* the spec for this phase — each item there has a "→ *Agent:*" line describing the behaviour we want.

**Why now:** the agent works, but it is generic. It knows UPSY's eligibility rules and can see the screen, yet it knows nothing about Avanse's specific fields, their quirks, or the dead-end after Submit. Precision on one real lender's form is worth more than breadth across hypothetical ones.

**Status 2026-08-04: the build is done, the live verification is not.** Everything below is written and syntax-checked, but **not one line of it has been exercised on a real call yet** — treat the whole upgrade as unproven until the verification item at the bottom is ticked.

- [x] **Ground the prompt in the real journey.** `backend/lenderForms/avanse.js` rewritten around the 14 observed screens; `upsyIn.js` added for the entry path. Both render into `SYSTEM_PROMPT` via `buildLenderGuidancePrompt()`, with per-site cross-cutting rules and explicit "read the dropdown off the screen, never recite a list we don't have" instructions.
- [x] **Handle unclear confirmation screens honestly.** Covered two ways: a global prompt rule ("never say something succeeded unless the screen says so; read the words, not the illustration") and screen-specific guidance for the co-applicant hand-off and the dashboard-card check.
- [x] **Feed the verified KYC name into the call context.** `buildContext()` now passes `kycName` and `coApplicantKycName`, read off verified ID documents (names only, never the numbers). The prompt tells the agent to have them type it exactly that way.
- [x] **Reduce the digit-accuracy risk.** The prompt now forbids presenting numbers read off a screenshot as fact and tells the agent to reason from what the applicant says. `OPENROUTER_LIVE_ASSIST_MODEL` also allows pointing live-assist at a stronger model without disturbing document reading. **The underlying Phase 0 dependency (a genuinely accurate reader) is still open** — this is mitigation, not a fix.
- [ ] **⚠️ Verify against the real form end to end.** Still the most important item here and now the *only* thing standing between this and being real. Do a full live call across `upsy.in` → Avanse and check each of the twelve failure modes behaves as intended. Expect the guidance to be wrong in places — it was written from screenshots, not from watching an applicant use it.
- [ ] **Re-check prompt size against answer quality.** The guidance block is now ~5.7k tokens and grows with every lender added. Cost and latency are fine, but a long prompt can dilute attention — if the agent starts giving vaguer answers than the old generic version did, this is the first thing to suspect, and the fix is filtering to the detected site rather than sending every portal every turn.

**Technical constraints found while reviewing the code for this phase** — most are now addressed:

- [x] **Screenshots are no longer 5s stale.** `requestFreshScreenshot()` grabs the screen when the applicant speaks and awaits it (2s cap) before answering, falling back to the background poll on timeout. Adds up to ~2s of latency by design — the README's own note called this the single most consequential setting for form precision, and accepted that trade.
- [x] **`OPENROUTER_VISION_MODEL` is no longer forced to be shared.** `OPENROUTER_LIVE_ASSIST_MODEL` now takes precedence for live-assist only, falling back to the shared var when unset, so tuning the call agent no longer silently changes `capture.js` / `income.js` / `bankStatement.js`.
- [x] **`MAX_HISTORY` raised 8 → 24.** Eight messages was about four exchanges; a form walkthrough is far longer than that.
- [x] **`temperature` lowered 0.3 → 0.1.** Field guidance should be near-deterministic.
- [x] **The three ignored AgentCall events are wired.** `tts.interrupted` now tells the next turn it was cut off (so it answers what was actually said instead of finishing its old thought), `call.max_duration_warning` warns the applicant out loud before the call dies, and `call.credits_low` logs loudly server-side without alarming the applicant about our billing.
- [ ] **Only one call can run server-wide** (`liveAssistManager.js` global lock, matching the plan's 1-concurrent-call limit). Fine for demos; a second officer or applicant gets a clear error rather than a silent failure, but this is a hard ceiling on any real rollout.
- [ ] **Handing over at the 1-hour cap is still not built.** We now *warn* at the 55-minute mark, but AgentCall's suggested pattern (start a fresh overlapping call and hand over seamlessly) is not implemented — the call still ends at sixty minutes.

**⏸️ ON HOLD — "UPSY AgentCall": own the live-call stack (raised 2026-07-31, paused 2026-08-02):**

> **⚠️ PARTIALLY THAWED 2026-08-07.** **Step 2 (in-app voice widget) is now being built**, because Cartesia paused agent deployments for free accounts and Hindi is still unserved. Its concrete task list lives in **"▶️ ACTIVE — build our own voice stack" further down this roadmap**; the sketch below is kept only as the original architecture note.
>
> **Steps 1 and 3 remain parked.** Step 1 (AgentCall as a dumb pipe) is now largely redundant — the `/upsy-voice-agent` relay covers the same voice layer without a meeting platform. Step 3 (our own meeting bot) is still weeks-to-months of browser automation and still not UPSY differentiation. Do not start either.

Original goal: stop depending on AgentCall for the live-call layer. The team already has **Deepgram** and **Sarvam** API keys (per the secrets note in Code map) plus other providers, and wanted this built in-house.

**Read "The actual runtime flow" + the dependency breakdown in "Live-call assistance via AgentCall" above before scoping this.** Short version: Deepgram (STT) and Sarvam (Indian-language STT/TTS) replace the *voice commodity layer* — which AgentCall's own pricing already treats as swappable ("bring your own transcription/TTS"). They do **not** replace the part that is actually hard and actually AgentCall's product: getting a bot into a live Google Meet/Zoom/Teams call at all. Going "100% our own" means building or licensing that piece too.

Sequenced cheapest-and-most-reversible first. **Step 1 is roughly a day's work and pays off on its own merits; Step 2 may make Step 3 unnecessary entirely — so follow this order rather than jumping to the most ambitious piece.**

---

**Step 1 — take back the voice layer** (AgentCall stays, but only as the pipe)

```
   ╔═ AGENTCALL CLOUD ═════════════╗
   ║  headless Chrome in the Meet  ║   ← still theirs (transport only)
   ╚═══════════════════════════════╝
        │ raw PCM 16kHz              ▲ raw PCM 16kHz
        │ audio.chunk                │ audio.inject
        ▼                            │
   ┌────────────────────────────────────────────────┐
   │  liveAssist.js                                 │
   │    → Deepgram streaming STT   (or Sarvam)      │  ← OURS
   │    → OpenRouter LLM + screenshot               │  ← OURS
   │    → Sarvam TTS  (Hindi / regional!)           │  ← OURS
   └────────────────────────────────────────────────┘
```

- [ ] Patch `backend/agentcall/bridge.js` — it currently **blocks this**, because it hardcodes `transcription: true` in the `/v1/calls` params (~line 419) and never wired up raw audio, even though AgentCall's API supports it. Three edits: add `audio_streaming: true`, flip `transcription` to `false` (stop paying for STT we no longer use), and handle inbound `audio.chunk` events + an outbound `audio.inject` command.
- [ ] Route STT through **Deepgram** (streaming) and TTS through **Sarvam**, replacing `tts.speak` with `audio.inject` of Sarvam's PCM.
- [ ] **Why this is worth doing regardless of the vendor question:** Sarvam unlocks Hindi and regional-language voice. Today's `am_adam` is English-only, so an applicant who'd rather be guided in Hindi simply cannot be — that's a product gap, not a cost optimisation. Cutting AgentCall's per-hour STT/TTS add-ons is the secondary benefit.

---

**Step 2 — in-app voice widget, no meeting platform at all** (removes AgentCall for most real usage)

```
   [Applicant on UPSY's own page]
     browser mic ──WebSocket──► UPSY server
                                  → Deepgram STT
                                  → OpenRouter LLM
                                  → Sarvam TTS
     browser speaker ◄────────────┘        AgentCall: gone entirely
```

- [ ] Build it as a widget on UPSY's own pages — no bot has to "join" anything, because we control the page. Needs only browser mic/speaker plus the Step 1 voice stack.
- [ ] This is also closest to what **RevRag actually does** (in-app, not on a call), which is what the team pointed at in the first place. It covers the `/docs` sidebar and completion-screen use cases — i.e. most of what would actually be demoed.

---

**Step 3 — our own meeting bot** (only if lenders' sites genuinely require it)

- [ ] Build a Playwright/Puppeteer headless Chrome that joins Meet/Zoom/Teams itself: waiting rooms, WebRTC audio out and in, screenshare capture, per-platform quirks. **This is the weeks-to-months piece**, and it breaks whenever Google/Zoom/Microsoft change their UI. It is the one thing AgentCall genuinely sells.
- [ ] **Scope check before starting:** the only scenario that truly needs this is watching the applicant's screen on a **lender's own site** (the original Avanse use case). Everything inside UPSY is covered by Step 2. Price this honestly as infrastructure — it is not UPSY product differentiation, and "we already have Deepgram and Sarvam keys" does **not** shorten it, since those solve a different layer.

**Next phase — fine-tuning the webpage (UI polish batch, agreed 2026-08-01):**

Now that the flow works end-to-end and is live on Render, the next round is UI/UX refinement rather than new capability. The user's standing preference is to **batch these into one upgrade pass once review feedback comes back from multiple people**, not one-off patches — so this list is the collection point.

- [x] ~~**Mobile: the document checklist and the "Ask UPSY" panel don't exist below desktop width**~~ — done 2026-08-11, and solved together as the note predicted. The checklist is a **left drawer** opened from a new top-bar button, and Ask UPSY is a **bottom sheet** on a floating button; the "Talk to UPSY live" control came back with it, since it lives inside that panel. Scrim, Escape, `aria-expanded` and a body scroll-lock all wired.

  **Each panel is one element restyled per breakpoint, never a second mobile copy** — both carry ids (`assistMsgs`, `assistInput`, `liveAssist`) that `wireAssist()` and `loadLiveAssistApplicant()` fetch with `getElementById`, so a duplicate would have wired whichever came first in the DOM and left the visible one dead. `wireAssist()` was not touched.

  ⚠️ **Tailwind's CDN build injects its utilities *after* the inline `<style>` block**, so at equal specificity `w-72` / `top-16` beat the panel rules and the sheet sat 122px on-screen instead of parked off it. The fix is one element selector (`aside.upsy-assist`), not `!important` — keep it that way if you touch this CSS.
- [x] ~~Responsive pass over the applicant flow at real phone widths~~ — done 2026-08-11 at 375/768/1100/1440. Headings scale, the primary action goes full-width below `sm`, the dropzone says "Tap to add" rather than "Drop … here" on a device with no drag-and-drop, and both text inputs are `text-base` because iOS zooms the whole page in on focus for anything under 16px. Every tap target inside the two panels was **35px or smaller** — sized for a desktop sidebar nobody could reach on a phone — and is now 40–48px, while desktop keeps its compact sizing via `lg:`/`xl:` variants (re-measured pixel-identical at 1440 after each change).
- [ ] **The drawer/sheet animations are unobserved.** Every open/closed end state is measured, but the browser used for verification was not compositing frames, so the slide-in itself has never been seen — the same gap `/upsy-voice-agent`'s CSS transitions still carry. Watch one open on a real phone; if it appears instantly rather than sliding, that is the thing to fix.
- [ ] Same treatment for `/login` and `/intake`, which were checked for overflow but not reworked, and for the team dashboard.
- [ ] Bundle Tailwind CDN + Google Fonts locally — currently CDN-loaded, which also means the deployed page prints a "cdn.tailwindcss.com should not be used in production" console warning on every load.
- [ ] Housekeeping: decide whether to remove the standalone `intake.html` demo now that `/intake` is a real step in the flow.

### ▶️ ACTIVE — build our own voice stack (team decision 2026-08-07)

**Why this moved from ⏸️ ON HOLD to the top of the list.** The hold was written when AgentCall was working and the only argument for owning the stack was cost. Two things changed: Cartesia **paused agent deployments for free accounts**, so `/upsy-voice-agent` could not be switched on at all by us, and Hindi is still a product gap. Owning the stack was the only path that solves both. Costs are worked out in "Own the voice stack" above — roughly **$0.028/min** English, **$0.034/min** Hindi, against $0.06–0.11/min for full OpenAI Realtime.

This is the README's old **Step 2 — in-app voice widget** (below), which was always the piece with standalone value. Steps 1 and 3 stay parked.

**Status: built, and it speaks.** Five of the seven steps are done and verified against live accounts, and the Deepgram key that was the last blocker is set — the remaining two steps are Sarvam/Hindi and the Cartesia path's fate, neither of which stops a call today. **`VOICE_PROVIDER` must be set to `upsy`** — `.env`, `.env.example` and `render.yaml` all set it, but the code still defaults to `cartesia` (`backend/voiceCall.js`), which cannot be deployed on a free account and fails every call.

**The seam held.** `frontend/voiceClient.js` only knows "PCM over a WebSocket". That socket now points at us instead of Cartesia and **the browser code did not change by one line** — which was the actual hypothesis being tested, and it passed.

```
[Applicant on /upsy-voice-agent]
   mic → AudioWorklet → PCM ──WS──►  voiceRelay.js  (ours, /voice/stream)
                                        │
                                        ├─► voiceStt.js    Deepgram  ✅ hears
                                        ├─► voiceBrain.js  Claude Haiku 4.5 (voicePrompt.js, unchanged)
                                        └─► voiceTts.js    Deepgram Aura  ✅ heard
   speaker ◄── PCM ◄──WS───────────────┘
                          ▲
                          └── plus `transcript` events, which the hosted agent never gave us
```

**Measured, not assumed** (`npm run voice:relay`, and a real browser at `/upsy-voice-agent`):

| | |
|---|---|
| Session → first spoken audio, in a browser | **524 ms** |
| TTS websocket → first chunk | ~360 ms (a fresh socket costs ~600 ms more, so it is opened once per call) |
| Audio format, end to end | `pcm_s16le` @ 44.1 kHz — **no resampling anywhere, in either direction** |
| PCM echo round trip | byte-identical |
| Tickets | single-use; a redeemed one is refused at the handshake, not after |

- [x] ~~**1. Stand up the relay skeleton**~~ — done. `backend/voiceRelay.js`, mounted on the existing HTTP server at `/voice/stream` (`noServer` + the `upgrade` event, because Render gives us one port). **`voiceClient.js` was not touched and connected first try**, which was the real thing being tested. Echo mode survives as `VOICE_RELAY_MODE=echo` — it answers "is it us or is it them?" in one env var, and `npm run voice:relay` asserts a 2048-sample frame round-trips byte-identical.
- [x] ~~**2. Wire Deepgram streaming STT**~~ — done and exercised against a real key. `backend/voiceStt.js`: nova-3, **`en-IN`**, keyterm boosting, `endpointing=800`, `utterance_end_ms=1000`, `vad_events`. Both non-default settings were forced by measurement, not taste — see the two defects in "Start here". Still worth doing: A/B against Deepgram's newer **turn-detection** model (we chose the stable endpointing protocol because we could not evaluate the alternative blind), and re-tune `DEEPGRAM_ENDPOINTING_MS` against real callers rather than one synthetic sentence. **`cartesia-ai/line`** (Apache-2.0, Python) is still the reference worth comparing turn-taking semantics against.
- [x] ~~**3. Wire Claude**~~ — done. `backend/voiceBrain.js` streams Haiku 4.5 with `buildVoiceSystemPrompt()` unchanged, splits the reply into sentences *as it arrives* via `sentences.js`, and aborts the in-flight turn when the caller speaks again (the `respondTo()` lesson). OpenRouter is the fallback and, since the Anthropic credits ran out on 2026-08-12, is what actually runs today — the switch cost one blank line in `.env` and no code edit, which is the first real test that "Switch providers by editing .env" was true rather than aspirational. It passed. **The "cache the system prompt" plan was wrong** — see the correction in "Own the voice stack" above; it is measured now, not assumed.
- [x] ~~**4. Wire streaming TTS**~~ — done and **heard**. Cartesia Sonic over their TTS websocket, one socket per call rather than per sentence (opening one costs ~600ms, which would otherwise land on the front of every reply). Verified against the live account: raw `pcm_s16le` @ 44.1kHz, first chunk ~360ms after the request, **524ms from a real browser to first spoken audio**.
- [x] ~~**5. Barge-in**~~ — implemented, **not yet observed** (it cannot fire without STT). When Deepgram reports speech during playback the relay aborts generation, advances the TTS context id so in-flight audio is dropped on arrival, and sends `clear` — which `voiceClient.js`'s existing regex already matches, so `flushPlayback()` runs untouched.
- [ ] **6. Swap in Sarvam for Hindi** — the plumbing is in (`language` flows from `POST /api/voice/session` → the ticket → `makeTts()`), but **Sarvam itself is not implemented and there is no key**; asking for a non-English language throws a named error rather than quietly reading Hindi in an English voice. This is still the payoff no hosted English-first vendor gives us.
- [ ] **7. Decide the Cartesia agent path's fate** — **deliberately kept**, not deleted, behind `VOICE_PROVIDER=cartesia`. It costs nothing to leave and it is the only fallback if our relay has a bad day. Revisit once the relay has carried real calls.

**Still open, and honest about it:**
- [ ] **Nobody has actually held a conversation with it.** Every link is verified and the loop closes end to end, but the only "caller" so far has been a synthesised voice speaking one clean sentence into a socket. A real person, on a phone, in a noisy room, interrupting, is a different test.
- [ ] **`data/voiceAccounts.json` is ephemeral on Render's free tier**, so "your last call is remembered" is a promise the deployment cannot currently keep across a respin. Needs a persistent disk or a real database before anyone is told otherwise.
- [ ] **Re-tune endpointing against real callers.** 800ms was chosen from one synthetic sentence. People who pause mid-thought need more; clipped Q-and-A needs less. `npm run voice:relay` reports how many turns one spoken thought got split into — that is the number to watch.
- [ ] **Test on a real phone, iOS Safari first.** Unchanged from the Cartesia path and still unobserved: the `AudioContext` resume-inside-the-tap and the 48kHz resample fallback are reasoned, not seen.
- [ ] **Watch for playback stutter.** One probe had Cartesia deliver 6.13s of audio over 16.9s of wall clock — slower than real time, which would drain `voiceClient.js`'s playback queue and produce gaps. The browser test showed 2.06s continuous with no gaps, so this may have been free-tier throttling on a cold socket. Measure it on a long reply before trusting it.
- [ ] **Echo cancellation is now load-bearing.** The relay treats "speech during playback" as barge-in, so if the caller's browser echoes the agent's own voice back into the mic, the agent will interrupt itself. `voiceClient.js` requests `echoCancellation: true`; a phone on speaker is where this will be found out.
- [ ] **Wire the `transcript` event into `/upsy-voice-agent`'s constellation properly.** The relay emits it and `matchTopic()` consumes anything with a `text` field, so it should already work — but nobody has watched it happen.

**Budget for testing: still near zero.** Deepgram's free credit plus Cartesia's free TTS tier covers the whole pipeline before anyone pays for anything.

**If the agent ever greets you and then goes silent, it is deaf, not broken.** With no `DEEPGRAM_API_KEY` the relay still connects, greets, and **says out loud that its hearing is not switched on**, then points at "Schedule call". That sentence exists because the failure was first found by hand — a greeting followed by silence, reasonably read as a bug. The boot log says the same thing (`Voice relay: DEAF (no DEEPGRAM_API_KEY) → …`). The key is set today, so you should never see this.

**Still open on the old Cartesia path, if it ever unblocks:**
- [ ] Try the **$4 Pro plan** — the deployment pause is scoped to *free* accounts, so this is the cheapest test of whether paid lifts it. Inference from their wording, not confirmed.
- [x] ~~**Hear it actually talk.**~~ — done 2026-08-07, though not on this path: our own relay speaks, verified from a real browser (524ms to first audio). The hosted agent still has never made a sound. (The barge-in event name was never a question either — Cartesia documents it as `clear`, which `voiceClient.js` already matches, and our relay sends the same event.)
- [ ] **Test on a real phone**, iOS Safari first. The `AudioContext` resume-inside-the-tap and the 48kHz resample fallback are reasoned, not observed — as are the CSS transitions and the constellation animation, which were verified structurally in a non-compositing browser.
- [ ] Rotate the Cartesia API key once testing is done — it was pasted into a chat session during setup.
- [ ] Surface the callback queue in the team dashboard. `GET /api/voice/callbacks` exists and `data/callbacks.json` fills up, but nobody sees it without curl — and note the free-tier ephemeral-storage caveat applies to this file like every other `data/` file.
- [ ] **Sarvam + Deepgram behind the same adapter** — this is the one that closes a product gap rather than a cost one: today a caller who would rather speak Hindi simply cannot. `voiceClient.js` needs no changes.
- [x] ~~Decide whether the anonymous caller should be able to leave a number~~ — done 2026-08-07 as the "Schedule call" button (`POST /api/voice/callback`). It also covers the caller who cannot get through at all, which is why it shipped alongside the deployment fix rather than after it.
- [x] ~~Put the same call button on `/docs`~~ — done 2026-08-12, and made a **round trip** rather than a one-way door: "Talk to agent" floats on every document page beside Ask UPSY, and `/upsy-voice-agent` grew a matching "Upload documents" pill. Two things make the hop worth taking: `voice-agent.js` reads the same `sessionStorage.upsy_lead` key `app.js` writes, so a same-tab jump lands the call **grounded in that applicant's own file instead of anonymous**; and the outbound tap stores the exact route, so the way back returns them to the document they left rather than the top of the flow (regex-guarded to a `/docs` path, so a stale value cannot aim that link elsewhere). The `/upsy-voice-agent` pill hides itself once the call view opens — a live call is not a place to offer someone a door out of the page.
- [ ] The same button on the **team dashboard** is still not done — the half of this item that was never about the applicant.
- [ ] "Talk to agent" is on document pages only, so someone who lands on `/docs` or the completion screen from `/upsy-voice-agent` has no way back to voice until they open a document.
- [ ] **Phase 2 applies here too, and slightly widens it**: voice is personal data going to a third-party processor. `/upsy-voice-agent` discloses it in the call sheet, which is not the same as DPDP consent.

**Phase 1 — harden:**
- [ ] Extend vision reading beyond PAN/Aadhaar/income-proof/bank-statement (admit letter, marksheets — each needs its own prompt/validation), multi-page PDFs, rotated/glare scans.
- [ ] **Test `bankStatement.js` against a real bank statement PDF** — no fixture exists yet in the repo (only ITR/Form16/payslips); the extraction logic is code-reviewed but not proven against real bank-statement layout/formatting.
- [ ] **Test the `identityGroup` scoping fix with real PAN/Aadhaar image fixtures** (student's + co-applicant's) — no image fixtures exist currently (only PDFs, unreadable by the OpenRouter-only path today), so this fix is logic-verified but not exercised live end-to-end.
- [ ] Consider fixing the evidence-card "Consistent"/"Conflict found" badge asymmetry (Fraud Check tab) — a conflict is currently only recorded on whichever document was uploaded second; the flag panel is reliable, individual card badges can understate it. Minor UX nuance, not a data-correctness bug.
- [ ] Exercise the "Why wasn't mine accepted?" helper chip end-to-end with a real failing upload (wired, not yet tested live).
- [ ] Feed the intake intent into the **document checklist** (secured → collateral docs; co-applicant relation → their KYC list) — the context is captured but doesn't shape the doc list yet.
- [ ] Reconcile intake vs stale lead data ("your lead says MS at UT Austin, you said MBA at INSEAD — which is current?").

**Phase 2 — compliance HARD GATE (open the conversation now; blocks real applicants):**
- [ ] DPDP Act consent + privacy policy covering third-party AI processing of ID documents (Auxilo's consent-first signup is the reference pattern); Anthropic data-retention/ZDR or DPA.
- [ ] **PII hygiene: the server logs full PAN/Aadhaar numbers, names, addresses, and phone numbers in plaintext** (`[capture:*]`, `[identity:*]`, `[income:*]`, `[bankstatement:*]` console lines — the identity/address/phone logging was added 2026-07-29 alongside co-applicant verification, widening this gap) — redact before production. Encrypt stored files at rest + move to object storage (S3).
- [ ] Keep the hard rule: KYC field contents never flow through LLM form-assist features.

**Lender-flow follow-ups (new):**
- [ ] Manual QA of the new UI (team Lenders tab, per-card Draft email button, applicant lender cards, upload preview) — backend verified via API, screens not yet eyeballed.
- [x] ~~Re-run income extraction on real sample ITRs/salary slips~~ — done 2026-07-29 with 12 real fixtures (see "Income eval harness" above); found + fixed the Form16PartB bug, surfaced the digit non-determinism issue. Still open: real *photographed* (not text-native) slips/ITRs haven't been tested — only clean digital PDFs so far.
- [ ] Replace `.example.com` lender emails + demo caps with real lender contacts/products when partnerships land; then swap `.eml` hand-off for Microsoft Graph (draft created directly in the team's Outlook mailbox).
- [ ] Salary-slip / income APIs per the WhatsApp spec ("salary clip etc apis we will get") — wire into the facts block when available.

**Phase 3+ (form-assist, agent, scale) & carried-over ops items:**
- [ ] Decide MagicX build-vs-buy properly only if per-keystroke UX is demanded (needs self-hosting + DPA + security review); otherwise the in-house intake is the path.
- [ ] Evolve toward the conversational agent (doc-reading, intake, EMI, doc-helper all become tools it calls).
- [ ] Resolve the two live Exotel blockers (account recharge; register a proper WhatsApp Business sender number, not the SMS ExoPhone) — then re-run the authorized test send.
- [ ] Before any real users: bump `STALE_AFTER_MS`/nudge cooldown from demo values (minutes) to ~24–48h and clear demo `data/applications.json`, so the sweep doesn't hammer old test leads.
- [ ] Team login (auth) — the dashboard is currently open to anyone with the URL.
- [ ] Full WhatsApp conversation flow (document upload via WhatsApp media messages, not just status replies).
- [ ] Push the finished, approved packet to the lender's underwriting system.
- [ ] Wire a real lead source (Zoho / Salesforce / LeadSquared / Meta lead ads) behind the adapter interface (see secrets note in Code map).
