# OGESEOUS MICROFINANCE — Step 1
© Paulo Mkenya · Developed by Paulo Mkenya

1. Create a Supabase project; run `supabase/migrations/001_foundation.sql` in the SQL editor.
2. `cp .env.example .env` and fill URL + anon key (never the service key).
3. `npm install && npm run dev`
4. Register, then promote your first admin in SQL: `update public.users set role='SUPER_ADMIN' where email='you@example.com';`
5. Edit `src/config/site.ts` for logo and contact details.
Route guards are UX only; Row Level Security in the database is the real enforcement.

## Step 2 — Student Verification
1. In the Supabase SQL editor, run `supabase/migrations/002_verification.sql` (after 001).
2. This creates the private `verification-documents` storage bucket automatically — no manual bucket setup needed.
3. As SUPER_ADMIN/MANAGER, go to `/admin/students` to import the RUCU register (CSV: form_four_index_number, registration_number, last_name, full_name) and to approve/reject submitted verifications.
4. Students verify at `/student/dashboard` → "Start Verification" → `/student/verify`.
   - RUCU: search the imported register by index number + (reg. number or last name), confirm the match.
   - Mkwawa / Iringa University: manual entry, reviewed by staff.
   - All: upload Form Four certificate, an additional ID document, and a passport photo (max 5MB each).
5. All writes to verification data go through `submit_verification()` and `review_verification()` (SQL functions), not raw table access, so status can't be forged from the browser.
6. Not built yet (Step 3+): loan application, PDF + QR generation, disbursement, repayments.

## Marketing Officer Referrals
1. Run `supabase/migrations/003_marketing_referrals.sql` (after 001 and 002).
2. As SUPER_ADMIN/MANAGER: `/admin/marketing` → "Add Marketing Officer" (name + university) generates a unique referral number, e.g. `OG-RUCU-A1B2C`. Give this number to the officer.
3. Students are asked once, on their dashboard, "How did you hear about OGESEOUS?" — Fellow students / Google / Marketing Officer (+ referral number). The number is checked and resolved to the officer server-side (`submit_referral()`), so it can't be faked from the browser.
4. `/admin/marketing` shows every officer's referral count, university and status — full visibility for admins.
5. If a marketing officer is later given a login (`role = MARKETING_OFFICER`, linked via `marketing_officers.user_id`), `/admin/marketing` shows only *their own* referral count and code — enforced by `get_marketing_stats()`, not just hidden in the UI.
6. When Step 3 (loan application) is built, the same "how did you hear about us" answer can be reused or re-asked there — the table isn't tied to any one screen.

## Step 3 — Loan Application System (draft only)
1. Run `supabase/migrations/004_loan_applications.sql` (after 001–003).
2. Only students with `verification_status = 'VERIFIED'` can open `/student/apply`; others are redirected to Verification.
3. The form has three sections: Personal Information (read-only, pulled from the verified profile), Loan Details (amount, purpose, repayment period — 6/12/18/24 months), and Review.
4. "Save Draft" writes through `save_loan_application_draft()`, which re-checks verification server-side and only edits the application while it is still a `DRAFT`.
5. The dashboard's "Loan application" card now shows "No loan application submitted yet" or "Draft saved — not yet submitted" based on real data.
6. **Not built yet, on purpose:** the "Accept Terms & Submit Application" button is disabled — mandatory Terms & Conditions acceptance and final submission are Step 4. Admin review/assessment of applications is Step 7. PDF generation and QR codes are Steps 5–6.

## Steps 4–12
Run these migrations, in order, after 001–004: `005_submission_and_verification.sql`, `006_admin_review.sql`,
`007_loans_and_repayments.sql`, `008_collections.sql`, `009_reports.sql`, `010_fixes.sql`.
`010_fixes.sql` must be **last**, and it only re-defines functions — no tables or data are altered.

- **Step 4 — Submit:** `/student/apply` → Review & Submit → checkbox + "Accept Terms & Submit Application" calls
  `submit_loan_application()`, which generates the application number and a private QR token.
- **Step 5 — PDF:** `/student/application` shows the application and a "Download Application PDF" button
  (client-side, via jsPDF) once submitted, with the QR code embedded.
- **Step 6 — QR verification:** the QR encodes `/verify?app=...&token=...`. Anyone (no login needed) can also
  open `/verify` (linked in the footer) and type the two values in by hand. Only exact number + token combinations
  resolve — the application number alone reveals nothing.
- **Step 7 — Admin review:** `/admin/loan-applications` (LOAN_OFFICER/MANAGER/SUPER_ADMIN) — Review / Approve / Reject.
- **Step 8 — Disbursement:** `/admin/loans` (ACCOUNTANT/MANAGER/SUPER_ADMIN) — disburse approved applications,
  see all loans and balances.
- **Step 9 — Repayments:** `/admin/repayments` records payments against a loan; students see their own history
  at `/student/loan`.
- **Step 10 — Collections:** `/admin/collections` lists loans past their due date (disbursement + repayment
  period) and lets staff log that a reminder was attempted. **No real SMS/email is sent** — nothing is configured
  for that, consistent with the Step 1 contact form.
- **Step 11 — Reports:** `/admin/reports` (ACCOUNTANT/MANAGER/SUPER_ADMIN) — student/application/loan totals and
  an applications-by-university breakdown.
- **Step 12 — Security & deployment:** see `SECURITY.md`. Nothing has been deployed or run from this environment
  (no network access here) — that file is a checklist for whoever deploys it, not a completed deployment.

### Corrections in `010_fixes.sql` (run after 009)
Re-defines three functions to close four defects. It never edits 002 or 007, so it is safe on a database that
already has 001–009 applied.

1. **`submit_verification()` did not consult the RUCU register.** `p_rucu_student_id` was stored but never
   validated, so a student could call the function directly with `method = 'RUCU_AUTO'` and any name. The register
   is now the source of truth: the index number and registration number must match the row, and the stored full
   name is taken *from the register*, never from the browser.
2. **`submit_verification()` never wrote the student's university, registration number or Form Four index number**
   to `student_profiles` — so `/student/application` and the PDF showed a blank University and Registration No.
   for every student. They are populated now. **Students verified before this migration keep the blank values**
   and must resubmit, or an admin must run the backfill query commented at the bottom of `010_fixes.sql`.
3. **`disburse_loan()` had no upper bound** — any amount could be disbursed against an approved application,
   including more than was applied for. It is now capped at the approved amount. Disbursing *less* is still allowed.
4. **`record_repayment()` silently absorbed overpayment** via `greatest(balance - amount, 0)` while storing the
   full amount in `repayments`, so `sum(repayments)` stopped reconciling with the loan balances. It also accepted
   payments on CLOSED/DEFAULTED loans and read the balance without a lock, so two concurrent payments could
   over-collect. Overpayment is now rejected, only ACTIVE loans accept payments, and the loan row is locked.

This SQL has **not been executed** — no Postgres was available in this environment. It passed a structural check
(dollar-quoting, plpgsql block and parenthesis balance) and nothing more. Run it against a staging project first,
and confirm with the reconciliation query in `SECURITY.md` that `sum(repayments)` equals disbursed minus
outstanding before any real money moves.

### Known simplifications (stated plainly, not hidden)
- Due dates are a single date per loan (disbursement + repayment period), not a real installment schedule.
- No amortization/interest calculation was specified, so none is applied — amounts are simple principal/outstanding.
- Reports are aggregate totals, not a charting library.
- None of this has been run — install and test locally, and treat any AI-written financial-logic code as something
  a human developer should review line-by-line before it handles real money.
