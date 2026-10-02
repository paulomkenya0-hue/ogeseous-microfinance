# OGESEOUS MICROFINANCE

© Paulo Mkenya · Developed by Paulo Mkenya

Student loan management for university students in Iringa, Tanzania — verification, applications,
disbursement, repayment schedules, collections and reporting.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc && vite build
npm run verify      # typecheck + test + build
```

Never put the Supabase **service role** key in `.env` or anywhere in `src/`. The anon key is designed
to be public; the service key is not, and it bypasses every Row Level Security policy in the database.

---

## Database migrations

Run these in the Supabase SQL editor, **in order**:

| # | File | What it does |
|---|------|--------------|
| 001 | `001_foundation.sql` | Tables, `is_admin()`, RLS, `audit_logs`, the column guard |
| 002 | `002_verification.sql` | Verification requests, RUCU register, private storage bucket |
| 003 | `003_marketing_referrals.sql` | Marketing officers and referral codes |
| 004 | `004_loan_applications.sql` | Loan applications, drafts, terms acceptance |
| 005 | `005_submission_and_verification.sql` | Submission, application numbers, QR tokens |
| 006 | `006_admin_review.sql` | `review_loan_application()` |
| 007 | `007_loans_and_repayments.sql` | Loans and repayments |
| 008 | `008_collections.sql` | Arrears listing, reminders |
| 009 | `009_reports.sql` | Dashboard and report figures |
| 010 | `010_fixes.sql` | Four defects in the functions above (superseded in part by 011/013) |
| 011 | `011_security_hardening.sql` | **The verification blocker, plus identity and storage hardening** |
| 012 | `012_staff_administration.sql` | Staff roles, suspension, staff directory, account search |
| 013 | `013_repayment_schedule.sql` | Installment schedules, reversals, recalculation |
| 014 | `014_application_wizard.sql` | **The seven-step application wizard: RUCU lookup, loan documents, application numbers, public tracking** |

**011 must run before 012, 013 and 014** — the later migrations depend on objects it creates.

After applying all of them, run `supabase/verify_migrations.sql`. It checks that every expected
object exists, that `sum(repayments)` reconciles with disbursed minus outstanding, that
`track_application` is callable by `anon` and nothing else is, and it lists any loans that still
need a schedule (see the note below). Run it before any real money moves.

### Turning off email confirmation — you have to do this by hand

**Email confirmation is a Supabase project setting, not something this code can switch off.** No
amount of editing `src/` will stop it, and any instruction that says otherwise is wrong.

Go to **Supabase → Authentication → Providers → Email → Confirm email** and untick it. Then a new
account receives a session immediately and the sign-up page's `[ Go to Dashboard ]` button works on
the first click.

Until you do, the app does the next best thing: the account is genuinely created, and the sign-up page
says so, and names the exact setting that is still in the way instead of telling the student to go
and check their inbox for a message the office has no way to resend.

### What 011 fixed

Before 011, **no student could ever submit verification.** `submit_verification()` writes
`verification_status` on the profile, and the `trg_profiles_guard` trigger raised *'Not allowed to
change verification status'* for any non-admin. Inside a `security definer` function `auth.uid()`
still returns the student's own id, so the trigger's `is_admin()` check was false for every student.
The function was unusable; this was not a hardening gap, it was a dead feature.

011 replaces the check with a transaction-local marker that the trusted functions set explicitly
(`trusted_write()` / `in_trusted_write()`), rather than trying to detect the caller from session
state. `current_user is not distinct from session_user` was tried first and does not work in
Supabase, where `session_user` is `authenticator` and `current_user` is `postgres` inside a definer
function.

011 also adds:

- a unique index on `(university, registration_number)` so one identity cannot hold two accounts. It
  **refuses to run** if duplicates already exist and names them, rather than silently skipping;
- a unique constraint on repayment references so one mobile-money reference cannot be recorded twice;
- storage policies for MIME type, size and delete — previously the bucket checked only the folder;
- a rate limit on RUCU register search.

### What 013 changed about money

`rebuild_loan_payments()` is now the only thing that moves money across a loan. Both recording and
reversing a repayment call it, so the two paths cannot drift apart. Reversals are **soft**: the row
is kept and marked with `reversed_at` / `reversal_reason`, never deleted, and every total excludes
reversed rows.

New functions: `recalculate_loan`, `reverse_repayment`, `void_disbursement`, `mark_loan_defaulted`,
`get_loan_schedule`.

> **013 does not backfill schedules** for loans that already exist. They keep working, but they have
> no installments, so they do not appear in arrears figures derived from the schedule.
> `verify_migrations.sql` section 12 lists them. Run the backfill noted there, or leave them — but
> know which is which before reporting on arrears.

### Interest is off, on purpose

`annual_interest_rate` is `0` and `interest_convention` is `none`. **OGESEOUS has not confirmed a
rate.** Setting one is a commercial and legal decision, not a configuration detail, so it lives in
the `app_settings` table rather than in code, where nobody would notice it. Until it is decided,
installments are equal shares of the principal.

`interest_convention` accepts `none`, `flat`, or `reducing_balance`, so enabling interest later is a
settings change and not a code change.

### What 014 changed about applying for a loan

Before 014 a student verified themselves on one page, then applied on another, and the two were never
quite the same record. 014 makes applying a single seven-step wizard and makes each step save to the
application row itself:

| Step | What it collects | Saved by |
|------|------------------|----------|
| 1 Student | RUCU/RUCU register match on registration number **and** last name, or a self-declaration for the other universities | `verify_student_from_register` / `declare_application_student` |
| 2 Loan details | amount, purpose, repayment period | `save_application_loan` |
| 3 Contact | phone, address, emergency contact | `save_application_contact` |
| 4 Financial | income, source, expenses, support | `save_application_financial` |
| 5 Guarantor | only when `guarantor_required` is true | `save_application_guarantor` |
| 6 Documents | Student ID, National ID, Guarantor ID, other | `attach_application_document` |
| 7 Review | the declaration checkbox that gates submission | `submit_loan_application` |

After a successful submission the wizard stops being a wizard and shows the confirmation screen: the
application number **the database generated**, the status `UNDER REVIEW`, and a reminder to keep the
number. It is rendered from the value `submit_loan_application()` returned, not composed in the
browser, so the number on that page is proof the row exists. The progress strip stays on screen and
ends on a ticked **Submitted**, with nothing clickable on it.

Two things about the step list, both worth knowing before anyone "tidies" it up:

- **Contact is a step of its own, and it is not in the original brief's list.** The telephone number
  collected there is the second factor on the public tracking page — the one thing that stops a
  screenshot of an application number from being enough to look up a stranger's loan. Folding it
  into another step would have broken that feature, not saved a click.
- **The progress strip says `UNDER REVIEW`, not "submitted".** Nothing waits in a queue for somebody
  to pick it up; the application is in the reviewer's list. A status that describes a step that does
  not exist is a promise the office cannot keep.

Four things about this are deliberate and worth not undoing:

- **Two save functions for steps 2 and 4, not one.** Step 2 has never seen the income fields. A
  combined function would either refuse to save the amount until the student had reached step 4, or
  silently ignore the missing arguments — which makes it impossible to clear a field you previously
  filled in. Split, each validates only what it writes, so pressing BACK to correct an amount never
  costs you your finances.
- **The wizard never touches `student_profiles.verification_status`.** The register match is recorded
  on the *application* as `student_confirmed_at` + `student_record_id` + `verification_method`, so a
  student's identity is frozen per application and staff still confirm it during review. A student
  record status and an application status are different facts and are not allowed to become one.
- **Submission goes straight to `UNDER_REVIEW`.** `SUBMITTED` exists in the vocabulary and history
  records `DRAFT → UNDER_REVIEW`, but nothing sits in `SUBMITTED` waiting to be picked up.
- **The number is generated by a sequence**, `OGS-<year>-<6 digits>`, and the column is `UNIQUE`, so
  two applications cannot collide however hard a double-click is pressed. `submit_loan_application`
  also takes a `for update` row lock and only updates `where status = 'DRAFT'`, so the second click
  is refused by the server rather than by a disabled button.

### Public tracking, and what it deliberately does not return

`/track` needs the application number **and** the phone number on the account. It returns a status,
two dates, the applicant's initials and a count of documents still outstanding — and nothing else.
Not the amount, not the full name, not the registration number, not the university, not the purpose,
not the guarantor, not any document path. A wrong phone number produces exactly the same "no match"
answer as a wrong application number, so the page cannot be used to discover which numbers exist.
Every lookup writes an audit row, and more than 120 in a minute is refused.

`/verify` still exists and still uses the printed verification token. Each submission regenerates
that token, so an old receipt cannot be replayed against a new application state.

---

## First steps

1. Promote the first admin once, in SQL:

   ```sql
   update public.users set role = 'SUPER_ADMIN' where email = 'you@example.com';
   ```

2. Every further staff account, and every role change, is done through **/admin/settings** (role
   assignment is SUPER_ADMIN only, so a manager cannot mint a super admin).
3. Confirm the business settings on the same page: loan minimum and maximum, permitted terms, and —
   new in 014 — **guarantor required** and **required application documents**.
4. Turn off email confirmation in Supabase (see above).
5. Replace the placeholders in `src/config/site.ts` — logo, contact details.

---

## Routes

Students are under `/dashboard`, `/loan/*` and `/track`; staff under `/admin/*`. Route guards are UX
only: **Row Level Security in the database is the real enforcement**, and the admin navigation
mirrors the policies so that a link a role cannot use is hidden rather than quietly rendering an
empty table.

| Route | Who |
|-------|-----|
| `/` `/about` `/how-it-works` `/contact` `/privacy` `/terms` | public |
| `/verify` | public — application verification by number + token |
| `/track` | public — status by application number + phone number |
| `/dashboard` | students |
| `/loan/apply` | students — the seven-step wizard |
| `/loan/application` | students — their own application, number, status, history |
| `/loan/schedule` | students — installments, payments and balance |
| `/admin/dashboard` | all staff |
| `/admin/students` `/admin/audit-log` `/admin/settings` | MANAGER, SUPER_ADMIN (role assignment: SUPER_ADMIN only) |
| `/admin/applications` `/admin/applications/:id` | LOAN_OFFICER, MANAGER, SUPER_ADMIN |
| `/admin/loans` | LOAN_OFFICER, ACCOUNTANT, COLLECTION_OFFICER, MANAGER, SUPER_ADMIN |
| `/admin/repayments` `/admin/collections` | ACCOUNTANT, COLLECTION_OFFICER, MANAGER, SUPER_ADMIN |
| `/admin/reports` | ACCOUNTANT, MANAGER, SUPER_ADMIN |
| `/admin/marketing` | MARKETING_OFFICER (own referrals only), MANAGER, SUPER_ADMIN |

**Everyone signs in at `/login`.** There is deliberately no `/admin/login` form: a second sign-in
page would be the same `signInWithPassword` against the same `auth.users`, so it would look stricter
than it is. What decides access is `public.users.role`, read by RLS on every query and by the
`area="admin"` guard. `/admin/login` and the old `/student/*` paths are kept as redirects so
bookmarks and forwarded links still land in the right place, rather than becoming duplicate pages
that drift apart.

---

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) runs the tests, builds, and publishes to Pages on
every push to `master`. Three settings have to agree:

- **`VITE_BASE_PATH`** — set to `/ogeseous-microfinance/` for Pages. It becomes both Vite's `base`
  (asset URLs) and React Router's `basename`. The default is `/`, which is right for Vercel, Netlify
  or a domain root.
- **`BASE`** in `public/404.html` — must match `VITE_BASE_PATH`. Pages has no rewrite rules, so it
  serves `404.html` for every route path; that file hands the requested path back to the app via
  `sessionStorage` and `src/main.tsx` restores it.
- **`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`** — repository secrets.

Also set the Supabase Auth Site URL and Redirect URLs to the real domain, or password reset links
will not come back to the app. See `SECURITY.md`.

---

## Not built, and stated plainly rather than hidden

- **No SMS or email is sent.** Collections reminders record that contact was *attempted*; the
  reminder has no message behind it until a provider is configured. The contact form opens the
  visitor's mail client if an address is published, and otherwise says plainly that nothing was
  delivered.
- **No logo, address, phone or opening hours are published.** The site shows "not yet published"
  rather than a blank that looks like an oversight.
- **Privacy Policy and Terms are draft summaries, not legal documents.** They describe what the code
  actually does so there is something concrete to review, and say so at the top. OGESEOUS must write
  and approve the real documents.
- **The SQL in this repository has never been executed.** It passed a structural check (dollar
  quoting, plpgsql block and parenthesis balance) and nothing more. Treat AI-written
  financial-logic SQL as something a human developer must read line by line before it moves money.
- **Two 014 defaults are guesses, flagged `TODO(OGESEOUS)` in the database and in /admin/settings.**
  `guarantor_required` is `true` and `required_application_documents` is
  `STUDENT_ID,NATIONAL_ID,GURANTOR_ID` — the stricter of the plausible readings, not a decision
  anyone has made. A required document a student cannot obtain stops applications at the last step,
  and a guarantor rule that is wrong rejects students who had no way to know. Confirm both before
  the institution opens.
- **The frontend has unit tests for its pure logic** (password rules, error-message scrubbing, file
  validation, deep-link restoration, wizard step navigation and per-step completeness). It has no
  end-to-end tests, and nothing has been run against a live Supabase project.