# UPSY Document Intelligence — Build Prompt (Kita-style)

Build a **Kita-style AI document-intelligence product for Indian education loans**, in **blue + white**, with two clean, basic, easy-to-use UIs (Applicant + Team). Build **on top of the existing `upsy-loan-agent` codebase** (Node + Express, `backend/` + `frontend/` + `frontend/team.html`) — do not start from scratch. Reuse the eligibility engine, lead-source adapter, Exotel notifier, email packet, and document store already there.

## Mirror Kita's three assistants
1. **Capture** — a vision/LLM layer that reads each uploaded document into **structured JSON** (fields + confidence), replacing the current tesseract-only OCR.
2. **Credit Officer** — the applicant chat + reminders (already built): keep, restyle to match.
3. **Underwriter** — extend the eligibility engine to run the *real extracted financials* against lending policy and draft a **credit memo** the officer approves/rejects.

## Models — via OpenRouter (use `OPENROUTER_API_KEY` from env, never hardcode)
Use only the allowed models. Route by task:
- **Vision extraction (photos/scans of PAN, Aadhaar, bank statements, payslips):** `google/gemini-2.5-flash` (primary — strong vision, cheap, fast), fallback `openai/gpt-4o-mini`.
- **Text-PDF extraction (digital bank statements/ITR):** extract text with a PDF parser first, then `meta-llama/llama-3.3-70b-instruct` (free tier) — no vision cost.
- **Underwriting reasoning + credit memo:** `meta-llama/llama-3.3-70b-instruct` or `GPT-5 Mini`.
- **Fast classification (which document type is this?):** `google/gemini-2.5-flash-lite` or `meta-llama/llama-3.1-8b-instruct`.
Use the exact model IDs from the "Allowed Models" list. Provider is swappable via `INFERENCE_PROVIDER`; keep the auto-fallback to Groq that already exists.

## Extraction contract (Capture output)
Each processed document returns:
```json
{
  "docType": "pan_card | aadhaar | bank_statement | salary_slip | itr | admit_letter | ...",
  "confidence": 0.0-1.0,
  "fields": {
    "name": "...", "dob": "...", "panNumber": "...", "aadhaarNumber": "...",
    "monthlyIncome": 0, "avgBalance": 0, "bouncedPayments": 0,
    "employer": "...", "accountNumber": "****1234"
  },
  "riskSignals": ["low_avg_balance", "recent_bounce", "name_mismatch"],
  "pages": 1
}
```
Store this JSON per document alongside the file. Feed `fields.monthlyIncome` etc. into the eligibility engine so the loan estimate is based on the **document**, not the lead-source number.

## Fraud / consistency check (Kita "Fraud Check" tab)
- Cross-check name + DOB across every document in the applicant's file (already started — keep).
- Flag: income on payslip vs bank-statement credits mismatch; PAN name vs Aadhaar name; document older than N months; low average balance vs requested amount.
- Surface as a red flag panel on the borrower file.

## Screens

### Applicant UI (`/`) — the "Credit Officer"
Keep the current chat flow. Restyle to blue/white, minimal. After sign-in show the preliminary eligibility (already built). On each upload, run Capture and show the applicant a friendly one-line confirmation of what was read.

### Team UI (`/team`) — the "Borrower File" (Kita Results layout)
- **Top bar:** UPSY logo · nav (Files · Batch · Activity) · credits/usage · user.
- **Left column:** searchable list of applicants (name, course, progress bar, Eligible/Needs-review chip, Stalled chip).
- **Center — selected borrower file:**
  - **Application Materials** checklist — "X of Y required documents accepted", each with status (verified / on file / pending / re-upload) and a **View** link.
  - **Extract tab:** the structured financial metrics pulled from the documents (income, avg balance, employer, net flow) in a clean key/value grid.
  - **Fraud Check tab:** the cross-document flags.
  - **Document viewer:** page thumbnails + file metadata (size, pages, created, SHA-256).
  - **Ask** button: chat over this applicant's documents (RAG — see below).
  - **Credit memo:** the Underwriter's draft (eligibility verdict, amount, rate, reasons) with **Approve / Reject / Request re-upload** buttons (already built) and **Email packet** (already built).
  - **Export:** download the packet / memo.

### "Ask" over documents (optional, uses Qdrant)
Embed each extracted document's text into **Qdrant** (`QDRANT_URL`); the Ask box answers officer questions ("what's the average balance?") via retrieval + `llama-3.3-70b`.

## Design system
- **Blue `#2563eb` + white.** Soft blue-tinted background, white cards, rounded corners (14px), subtle shadows, generous whitespace. Green = verified/eligible, amber = pending/stalled, red = flag/reject.
- **Basic and easy:** one file open at a time, big obvious actions, no clutter, mobile-friendly applicant view. Match the existing `frontend/styles.css` and `team.html` palette.

## Infra already in env (reuse, keep secrets in `.env`)
- **OpenRouter** for inference · **Postgres** (`DATABASE_URL`) for persistence (migrate the file-store) · **Redis** for queues/caching · **Qdrant** for Ask/RAG · **Exotel** for SMS+WhatsApp reminders · **SMTP** for the completed-packet email · CRM adapters (Zoho/LeadSquared/Salesforce/HubSpot) as lead sources + write-back.

## Non-negotiables
- Never hardcode secrets — read every key from env.
- Keep the human-in-the-loop: AI extracts, checks, and drafts; the officer approves. No auto-approval.
- Every extraction stores its confidence + the source model, so low-confidence reads are flagged for manual review, not trusted silently.
