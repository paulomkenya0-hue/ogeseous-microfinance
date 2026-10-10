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
| 015 | `015_register_lookup_fix.sql` | **Corrects two functions in 014 whose OUT parameter shadowed a column they read, which made the RUCU lookup raise on every call** |
| 016 | `016_phone_signup.sql` | **Students register with a phone number and no email address. Makes `users.email` nullable and teaches the signup trigger about `auth.users.phone`** |
| 017 | `017_no_rucu_self_declaration.sql` | **Closes a self-verification path: `declare_application_student` now refuses `RUCU`, so RUCU details can only come from the register** |
| 018 | `018_auth_update_no_phone_auth.sql` | Retires phone-identity auth: students sign in with a synthetic email derived from the phone number; `handle_new_user` reads phone from metadata/auth; single canonical unique index on `users(phone)`. The §0.1 syntax defect is fixed in place. |
| 019 | `019_verification_rate_limit.sql` | Dedicated rate-limit table + throttling on `get_application_verification` |
| 020 | `020_search_active_loans.sql` | Server-side active-loan search for the repayments console |
| 021 | `021_rucu_register_csv_import.sql` | Allows the current RUCU register format without inventing Form Four index numbers; validates import rows in the database |
| 022 | `022_staff_suspension_audit_reason.sql` | Requires and records the reason for suspending a user account |
| 023 | `023_fix_verification_requests_select.sql` | Restores the correct admin read policy for verification requests |
| 024 | `024_rucu_register_admin_read.sql` | Limits RUCU register reads to managers and super admins |
| 025 | `025_rucu_explicit_confirmation.sql` | Separates RUCU lookup from student confirmation; a short-lived match must be confirmed before a draft is created |
| 026 | `026_super_admin_mfa.sql` | Historical migration; its unfinished MFA requirement is removed by migration 027 |
| 027 | `027_remove_super_admin_mfa.sql` | Removes the unfinished MFA requirement and recursive policy; restores role-based admin access |
| 028 | `028_add_ceo_role.sql` | Adds the distinct CEO staff role |
| 029 | `029_strict_role_based_access_control.sql` | Enforces the strict role matrix, application workflow, restricted reporting, and server-side 403 guards |

**011 must run before 012, 013 and 014** — the later migrations depend on objects it creates.
Apply migrations **028 and 029 after 027**, in that order. Then run
`supabase/authorization_matrix_tests.sql` in the Supabase SQL editor and confirm every applicable
case reports `PASS`. This does not apply the migrations; frontend route guards and hidden navigation
are not a substitute for database enforcement.

After applying all of them, run `supabase/verify_migrations.sql`. It checks that every expected
object exists, that `sum(repayments)` reconciles with disbursed minus outstanding, that
`track_application` is callable by `anon` and nothing else is, and it lists any loans that still
need a schedule (see the note below). Run it before any real money moves.

### Students register with a phone number and a PIN — the Supabase settings that matter

**Supabase Auth cannot create a password account with neither an email address nor a phone number.**
One of the two has to be the account identifier. Students are created against a **synthetic email
address derived from the phone number** (`phoneToAuthEmail` in `src/lib/validate.ts`), because this
project runs no SMS provider — the Phone provider stays **OFF**, and the 016-era phone-identity
flow is retired. The signup form asks for a phone number and a four-digit PIN; the student never
sees the derived address, and sign-in derives it again from the number they type. The student's
name is collected during the loan application, from the RUCU register for RUCU students or by
manual entry for other universities. Staff are unaffected: they keep signing in with their email
address, exactly as before, and the sign-in page tells them apart by whether what they typed
contains an `@`.

These are project settings. No amount of editing `src/` will change any of them.

| # | Where | What |
|---|---|---|
| 1 | **Authentication → Providers → Email** | Leave the **Email** provider **ON** (it is by default) and **untick "Confirm email"** (or enable autoconfirm). With confirmation on, sign-up returns no session, so nobody lands on the dashboard after registering — and the synthetic address has no inbox to confirm through. |
| 2 | **Authentication → Providers → Phone** | Leave the **Phone** provider **OFF**. The app does not use it; turning it on only opens an identity path nobody maintains. |
| 3 | **Authentication → Sign In / Providers → Email → Minimum password length** | Set it to **4**. This no longer gates student registration (see below), but the staff password-reset page stores a password exactly as typed, and a four-digit staff password is refused by the server unless the minimum is 4. |

Apply migrations through **027** in order before signing in. Super-admin access uses the existing
role-based authorization; the unfinished TOTP requirement has been removed.

**Why registration no longer depends on setting 3.** A bare four-character PIN fails GoTrue's
default minimum password length (6) before any code in this repository runs, and the rejection
used to surface as *"Your PIN does not meet the minimum length requirement. Please enter exactly 4
digits."* on a perfectly valid PIN. The app now stretches the PIN with a fixed, public suffix
before sending it (`pinToAuthPassword` in `src/lib/validate.ts`), so a 4-digit PIN registers and
signs in whatever the server's minimum is. The suffix is not a secret — the secret is still only
the four digits. Sign-in also tries the bare PIN, so accounts created while the setting had been
lowered by hand, or reset to a bare PIN by an administrator, keep working.

**Why 016 is needed and not just the form.** `public.users.email` was declared `text not null` in
001. A student with no email has `auth.users.email = NULL`, so the `handle_new_user()` trigger's
insert would fail on the not-null constraint and **no student account could ever be created**. 016
drops that constraint — keeping the unique index, so two staff addresses still cannot collide — and
rewrites the trigger to read `auth.users.phone`, which is the column GoTrue actually keeps unique.
Role stays `STUDENT` and status stays `ACTIVE`; no existing account is touched.

**Password reset.** There is no self-service reset for a student, and the sign-in page says so
rather than offering a button that does nothing. The Supabase client has no
`resetPasswordForPhone`, and GoTrue has no password-reset-by-SMS endpoint the browser may call — a
four-digit PIN on a phone-identified account is recoverable by an administrator and by nobody else.
Staff still reset by email.

> A four-digit PIN has ten thousand possibilities, and the account is identified by a phone number,
> which is the only thing an attacker has to get right. Anyone who already knows the number can walk
> that space quickly. This is the rule the business asked for and it is implemented as asked; it is
> recorded in `016_phone_signup.sql` so the choice is visible to whoever reads the schema next.

### Turning off email confirmation

Students no longer sign up with an email address, so email confirmation no longer affects them at
all. **Staff** accounts still use an email identity, and **Confirm email** under **Authentication →
Providers → Email** will still hold back a staff sign-up. Untick it, and lower the **Minimum
password length** to 4 as set out in the table above.

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
| 1 Student | RUCU register match on registration number **and** last name, followed by explicit student confirmation; or a self-declaration for other universities | `verify_student_from_register` / `confirm_student_from_register` / `declare_application_student` |
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
   new in 014 — **guarantor required** and **required application documents**. Repayment periods are
   fixed by the business at **1, 2 or 3 months** (enforced by the CHECK constraint in 004 and the
   filter in `allowed_repayment_months()`); the setting can only narrow that list, never widen it.
4. Apply the **three Supabase settings** in "Students register with a phone number and a PIN" above
   — enable the Phone provider, untick Confirm phone, and set the minimum password length to 4.
   Until all three are done, **no student can register at all**.
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
| `/admin/dashboard` | all staff, with role-filtered figures and shortcuts |
| `/admin/students` | LOAN_OFFICER, MANAGER, SUPER_ADMIN |
| `/admin/audit-log` `/admin/settings` | SUPER_ADMIN only |
| `/admin/applications` `/admin/applications/:id` | LOAN_OFFICER, MANAGER, CEO, SUPER_ADMIN; Accountants receive approved-application context for disbursement |
| `/admin/loans` | LOAN_OFFICER (active loans only), ACCOUNTANT (disbursement), MANAGER, CEO, SUPER_ADMIN |
| `/admin/repayments` | ACCOUNTANT (entry), MANAGER and CEO (oversight), SUPER_ADMIN |
| `/admin/collections` | COLLECTION_OFFICER, MANAGER, CEO (read-only arrears), SUPER_ADMIN |
| `/admin/reports` | ACCOUNTANT, MANAGER, CEO, SUPER_ADMIN |
| `/admin/marketing` | MARKETING_OFFICER (own referrals only), SUPER_ADMIN |

Application flow: student submits; Loan Officer verifies and assesses; CEO makes the final approval
decision (Managers retain operational approval authority); Accountant verifies the approved
contract and disburses; Loan Officer records loan details and provides the schedule; Collection
Officer follows arrears; Accountant records/reconciles payments; CEO reviews financial and overdue
reports. Only SUPER_ADMIN manages system settings, staff roles, and audit logs. CEO leadership
oversight includes institutional strategy, senior-staff coordination, objectives, stakeholder
relationships, regulatory compliance, and major operating decisions.

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