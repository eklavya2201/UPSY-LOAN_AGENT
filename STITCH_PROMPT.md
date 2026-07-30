# UPSY — Stitch (Google) UI Generation Prompts

Paste these into **Stitch by Google**. Tips: set the theme to **Light**, generate **one screen at a time** for best results, and keep the same style line at the top of each so the screens stay consistent. **All screens are desktop web** (both the Applicant app and the Team dashboard).

---

## GLOBAL STYLE (prepend to every prompt, or set once)

> Clean, minimal fintech product in **white and blue**. Primary blue `#2563eb`, soft blue-tinted background `#eef3fb`, white cards with 14px rounded corners and subtle soft shadows, lots of whitespace. Accent colors: green `#16a34a` for verified/eligible, amber `#f59e0b` for pending/attention, red `#dc2626` for errors/flags. Friendly, modern sans-serif (Inter/SF). Simple, uncluttered, easy for non-technical users. Rounded pill buttons, small status chips. Think a calm, trustworthy loan assistant — like a cleaner Kita.

---

# APPLICANT APP (desktop web — spacious, Kita-style)

All applicant screens are a **full-width desktop web page** in the spacious style of Kita's Capture screen — **NOT** a compact/mobile card. Every page has: a slim white **top nav bar** (blue **UPSY** logo on the left; a step/progress indicator; a round user avatar on the right), then a **wide content area with big margins and lots of whitespace** — a large bold page title, a one-line grey subtitle, and the main interactive element as a big full-width panel. Airy, clean, professional, white and blue.

## Screen 1 — Sign in
> Full-width desktop web page for an education-loan assistant called **UPSY**, spacious and airy like Kita. Slim white top nav bar: blue "UPSY" logo on the left, a round user-avatar circle on the right. Wide content area with big side margins and lots of whitespace. Large bold heading "Welcome to UPSY" and a grey subtitle "Enter your mobile number and we'll pull up your loan application." Below, a clean wide text input "Mobile number — e.g. 9999999999" and a blue rounded "Continue" button. White and blue, minimal, roomy.

## Screen 2 — Personalized greeting + eligibility
> Full-width spacious UPSY desktop page. Top nav bar with a step indicator "Step 2 of 14" and a thin blue progress bar beneath it. Big bold heading "Hi Aarav 👋" and grey subtitle "MBA at IIM Bangalore · via Meta lead ad". Below, a wide light-blue eligibility banner titled "Preliminary eligibility — Eligible", containing three big stat tiles in a row: "Estimated ₹22.8 L", "Rate 10.5–13%", "Moratorium 33 months", and a small note "An early estimate, not a final sanction." Generous whitespace, white and blue.

## Screen 3 — Document upload (the key Kita-Capture-style screen)
> Full-width desktop UPSY page in the exact spacious style of Kita's Capture screen. Slim top nav bar (blue UPSY logo, step indicator "Step 3 of 14", user avatar). Wide content with big margins: a large bold title "PAN card" and a grey subtitle "Why we need this: PAN is mandatory — lenders use it to pull your credit history." A wide text field labelled "PAN number — e.g. ABCDE1234F". Then a **large full-width dashed-border drop zone** with a centered upload icon and bold text "Drop your PAN card here, or click to browse", a row of small file-type chips "PDF  PNG  JPG", and a small helper line. A blue "Upload & verify" button below. Very spacious, lots of whitespace, white and blue.

## Screen 4 — Verification result
> Full-width spacious UPSY desktop page. Top nav with progress "Step 3 of 14 · verified". Big bold heading in green "PAN card — verified ✓". Below, a wide white card listing verification checks, each row a green circular check with a label: "File type accepted", "Contents match the document", "Size within limit", "PAN number matches the card". A blue "Continue to next document" button. Clean, airy, green accents on white and blue.

## Screen 5 — All done
> Full-width desktop UPSY completion page, spacious and celebratory. Top nav with a full progress bar "14 of 14". Big centered heading "All documents received 🎉" and grey subtitle "Our team will review your application within 24 hours." A wide summary card listing the collected documents each with a green check. Calm, professional, white and blue, lots of whitespace.

---

# TEAM DASHBOARD (desktop web — spacious, Kita-style) — "Borrower File"

Same spacious, airy Kita look as the applicant pages: a slim white top nav bar, full-width content, generous whitespace, white cards with rounded corners. Not cramped.

## Screen 6 — Applications list + borrower file (main screen)
> Desktop web dashboard for loan officers, called **UPSY Team**. Top blue bar: round "U" logo, product name "UPSY Team", nav tabs "Files · Batch · Activity", a small "100 credits" pill on the right, and a user avatar. Two-column layout below.
>
> **Left column (narrow):** a searchable list of loan applicants. Each card shows the applicant name, course and phone, a thin blue progress bar, a document count "8 / 14 documents", and small status chips ("Eligible" green, or "Needs review" amber, or "Stalled" amber). One card is selected (light-blue highlight, blue left border).
>
> **Right column (wide) — the borrower file for "Aarav Sharma":** a white profile card with name, "MBA · IIM Bangalore", and a grid of facts (Phone, Lead source, Loan type, Co-applicant, Documents 8/14, Status). Below it, two tabs "Extract" and "Fraud Check". Under "Extract", a clean key–value grid of financial data pulled from documents: Monthly income ₹95,000, Avg bank balance ₹1.2L, Employer "Infosys", Net flow positive. Then a section "Application Materials — 8 of 14 accepted" listing documents, each row with a colored status dot (green verified / blue on-file / grey pending), the file name, a "100% checks" note, and small "View" and "Request re-upload" buttons. At the bottom, green "Approve application" and light-red "Reject" buttons. White cards, blue theme, generous spacing, very readable.

## Screen 7 — Fraud Check tab
> Same UPSY Team borrower-file screen with the "Fraud Check" tab active. A red-tinted warning panel titled "⚠ 2 issues — needs review" listing cross-document conflicts: "The Aadhaar card shows name Rohan Kumar, but the PAN card shows Aarav Sharma" and "Aadhaar DOB 22/01/1999 vs PAN DOB 15/06/2000". Below, a green panel "All other checks passed". Clean, white and blue with red flags.

## Screen 8 — Credit memo + email packet
> UPSY Team borrower-file screen for a completed applicant. A blue-tinted "Document packet — all documents received" card with text "✓ Emailed to loans@upsy.ai" and a blue "Re-send email" button. Above it, a white "Credit memo" card: a green "Eligible" header, "Recommended amount ₹22.8 L at 10.5–13%", a short bullet list of reasons, and Approve / Reject / Request re-upload buttons. An activity timeline on the right showing events like "Document verified", "📧 Documents emailed to ops", "📨 Reminder sent". White and blue, calm and professional.

---

## Notes for whoever wires these to code
The generated screens map onto the existing `upsy-loan-agent` app: Screens 1–5 = `frontend/` (applicant chat), Screens 6–8 = `frontend/team.html` (officer dashboard). Keep the blue `#2563eb` / white palette so the generated UI drops straight in.
