# UPSY Loan Agent

AI loan agent for education loans, modeled on the Kuhoo app's journey. The agent **fetches the applicant's data from your lead source**, greets them personally, then collects only the **missing** documents **in the same order** as the real loan journey (student → co-applicant → collateral). For every document it explains **why it is required**, cross-checks the upload against the expected format, and **writes the verified status back to the lead source**.

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

## Partner-lender research: Avanse's real online flow (2026-07-30)

Checked `online.avanse.com` live (one of the 6 demo lenders in `backend/lenders.js`), at the team's request, to compare their real applicant experience against UPSY's:

- **Sign-in**: phone/email + OTP, no separate signup step — straight to a "My Loan Applications" dashboard (Apply Now / My Offers / All-Pending-Disbursed tabs) once logged in.
- **"Apply Now" quick form** (tested with "Executive Education" as the loan type): Select Type, Name, Email ID, Phone Number, Loan Amount, Time of Study, Place of Study, Admission Status — a lead-intent form, roughly comparable to UPSY's `/intake` step but simpler (no institution name, no co-applicant, no secured/unsecured choice at this stage).
- **⚠️ Dead end found**: submitting that form returned straight to "My Loan Applications" showing **"No Application Found"** — no visible continuation into a document/KYC step in-browser. Unconfirmed whether this is a UI quirk or Avanse's real flow hands off asynchronously (email/SMS follow-up, human loan-officer contact) rather than continuing live in the same session. Not chased further this session — worth a Pending-tab / inbox check next time.
- **Comparison takeaway**: on what we could observe, UPSY's applicant flow goes further live — straight from stated intent into guided, real-time document collection with instant eligibility feedback, versus Avanse appearing to stop at lead capture. Caveat: Avanse is a real production lender with actual compliance/backend behind it; UPSY is ahead on live interaction design but still behind on production-readiness (no dashboard auth, PII logged in plaintext, DPDP consent not built — see Phase 2 below).

### New idea (not yet built): out-of-app live-call assistance via AgentCall

Team request over WhatsApp: mimic what **RevRag AI** (revrag.ai — "#1 In-App AI Agents Platform," embeds AI agents directly into a BFSI product to automate onboarding and re-engage drop-offs) does, but for a partner lender's product UPSY doesn't control the codebase of (e.g. Avanse) — an "out-of-app" equivalent, since we can't embed an agent inside someone else's site.

**Chosen approach**: [AgentCall](https://agentcall.dev) (`pattern-ai-labs/agentcall`, MIT-licensed `join-meeting` skill) lets a coding agent join a Google Meet/Zoom/Teams call as a bot with voice + optional video/screenshare. Scenario decided with the team:
- **Agent + applicant, live voice** — the applicant is on a call alone with the AI agent (no human loan officer needed for this path).
- **Applicant screenshares their own screen** (showing `online.avanse.com` or another partner lender's real form) — the agent periodically calls the skill's `screenshot.take` command to see what's currently on screen, and talks the applicant through it via TTS, grounded in what it sees plus loan-domain knowledge. The agent never touches the form itself — the applicant fills it, guided by voice only, same trust boundary as every other LLM-assist feature in this repo (never auto-fills/auto-submits KYC-adjacent fields).
- Mode: `audio` or `direct` voice-strategy — Pattern 2 ("Customer Support") from the skill's own docs is the simplest fit for this 1:1 use case.

**Status**: researched and scoped, not yet tested live. `SKILL.md` reviewed in full; Python 3.13 and Node 22 both confirmed available on the dev machine (either runtime works — `bridge.py` recommended for voice-only). **Blocked on**: an AgentCall account + API key — the user needs to sign up at `app.agentcall.dev` themselves (account creation isn't something an assistant should do on someone's behalf, even with the self-registration-via-email-OTP option the skill supports) and paste the key in, the same pattern already used for `OPENROUTER_API_KEY` etc.

**Open question, not yet decided**: how this becomes a real *product* feature vs. a one-off interactive demo — AgentCall's `join-meeting` skill is built for a coding agent (like Claude Code) to join a call interactively in the same session; turning it into something that joins calls autonomously/unattended for arbitrary applicants at scale is a separate, later architecture question.

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
  - **⚠️ Known gap found in Render deploy testing (2026-07-30): sidebar is invisible on mobile.** It's `class="hidden lg:flex ..."` (`checklistHtml()` in `app.js`) — deliberately desktop-only, matching the rest of this UI's "not a mobile chat widget" design, but nobody built a phone equivalent. Result: on a real phone, the jump-to-any-document nav and the always-visible progress list simply aren't there (rest of the flow — Continue, upload, verification — still works). Not fixing now; **tracked for the next UI upgrade batch once more review feedback comes in** (user's call — reviews expected from multiple people, upgrading together rather than one-off patches).
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

- `render.yaml` (Blueprint config) defines the web service — `npm install` / `npm start`, free plan. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, and `APP_URL` are `sync: false` (entered in the Render dashboard, never stored in the yaml). `NOTIFY_CHANNEL=mock` is baked in, matching the local "Exotel off" state.
- **Verified live end-to-end**: `/login` → `/intake` sign-in with a demo lead works and greets correctly; `/team.html` dashboard loads and reflects live applications; no console errors on either page.
- **⚠️ Storage is ephemeral on the free tier.** `data/applications.json` + `data/uploads/` are gitignored, local-disk-only (`backend/store.js`, `backend/files.js`). Free-tier instances spin down after 15 min idle and lose that disk on respin — any application created mid-testing won't survive a gap in usage or a redeploy. The 3 pre-seeded demo leads (`mockSource.js`) always survive, since they're code, not `data/`. Fine for single-sitting testing (decided against a paid instance + persistent Disk for now — revisit if multi-day test persistence is ever needed).

## Configuration (.env)

All credentials are read from a `.env` file (loaded automatically via `dotenv`). Copy the template and fill it in:

```bash
cp .env.example .env   # then edit .env with your Exotel + SMTP values
npm start
```

`.env` is gitignored. With nothing set, everything runs in demo mode (messages/emails are logged, not sent).

## Code map

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
- `backend/lenderDraft.js` — lender referral email drafting (LLM chain + template fallback) and the `.eml` (Outlook draft) export with attachments.
- `backend/income.js` — income extraction from ITR / salary slips (ITR annual ÷ 12 rule); also reads address now. Feeds eligibility, credit memo and lender drafts. Has a plausibility guard (rejects `salary_slip` reads above ₹5L/month as likely mislabeled annual figures — see "Income eval harness" above).
- `backend/bankStatement.js` — reads the co-applicant's name, address, and registered phone off `co_bank_statement` (Claude → OpenRouter chain); phone becomes the co-applicant's contact (see "Co-applicant identity verification" above).
- `backend/eval-income.js` — `npm run eval:income`: batch income-doc eval / model A/B harness over the project root + `data/uploads/` or given paths (now also prints extracted address).
- `backend/leadSources/` — the pluggable lead-source layer (`mockSource.js` + `index.js` registry). **Add real platforms here.**
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

## Next (roadmap) — in likely priority order for a new session

**Phase 0 — prove the reader (top of the list, now with two independent findings backing it):**
- [ ] **Add `ANTHROPIC_API_KEY` to `.env`** (platform.claude.com — separate developer account from the claude.ai Pro subscription; buy ~$5 credits; **set a console spend limit first**). The whole Claude path — including PDF reading, which currently has *no* working reader — activates on restart; the startup log confirms it.
- [ ] Run `npm run eval` **and** `npm run eval:income` before/after the key: the repo's PDF fixtures should go from "(not read)" to parsed with checksums passing, and the income figures should stop varying between runs — that's the demo-able proof both ways.
- [ ] A/B `claude-opus-4-8` vs `claude-sonnet-5` vs `claude-haiku-4-5` (swap `ANTHROPIC_VISION_MODEL` between eval runs) on real + deliberately blurry cards **and** on the real ITR/Form16/payslip fixtures now in the repo root; pick by accuracy ÷ cost.
- [ ] Re-run `npm run eval:income` a few times on `ITR-24-25.pdf` specifically once Claude is active, to confirm the ₹1.39L vs ₹13.91L non-determinism is actually gone (not just less frequent).

**New track — partner-portal live assistance (exploratory, see sections above for full context):**
- [ ] Confirm what actually happens after Avanse's "Apply Now" quick form (check the Pending tab / the test inbox for an async follow-up) — currently looks like a dead end in-browser; needed before assuming their real flow is "worse" than UPSY's.
- [ ] Get an AgentCall API key (user signs up at `app.agentcall.dev`) and run a first live test call — applicant screenshares a partner lender's real form, agent watches via `screenshot.take` and guides via voice. Validate the concept live before deciding whether/how it becomes a real product feature.

**Phase 1 — harden:**
- [ ] **Mobile: build a phone equivalent of the document checklist sidebar** (found testing the Render deploy on a real phone, 2026-07-30) — it's `hidden lg:flex`, so it doesn't exist below desktop width at all. Holding off on a one-off patch; batching with whatever else comes back from the wider review round.
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
- [ ] Bundle Tailwind CDN + Google Fonts locally so the UI works fully offline.
- [ ] Housekeeping: decide whether to remove the standalone `intake.html` demo now that `/intake` is a real step.
