# OGESEOUS MICROFINANCE — Security & Deployment

> ## TODO — MAKE THIS REPOSITORY PRIVATE
> This repo is **public** while setup is in progress. It must be switched to private before the app
> is deployed or anyone outside the team is given access.
> **How:** repo → `Settings` → `Danger Zone` → `Change repository visibility` → `Make private`.
> **Verify it worked:** open the repo in a browser while logged OUT — you should get a 404.
>
> Why it matters even though no secrets are committed: **the SQL migrations are the security model.**
> They publish every role, every RLS policy, and every money-handling function, including the exact
> checks each one applies. A public repo hands an attacker the design in full. No student PII and no
> keys are in git — those live in the Supabase database — so the exposure is the design, not the data.
>
> Git history is permanent. Making it private protects everything from that point on; anything
> already fetched or scraped stays fetched or scraped. If student names or registration numbers were
> ever pasted into an issue, a commit message or a file, assume they are known and treat them as
> compromised rather than expecting the switch to clean them up.
>
> Note: the deployed **website** stays public. Making the repository private does not make the
> GitHub Pages site private — it only hides the source. That is the correct arrangement here.

---

Nothing in this file has been deployed or penetration-tested. Migrations 028 and 029 are new and
must be applied to Supabase before their RBAC controls are active. Run
`supabase/authorization_matrix_tests.sql` after applying them and confirm the results before relying
on the role restrictions. It is a checklist and an account of the code; frontend hiding alone is not
server-side enforcement.

## Already in the code

- Every table has Row Level Security enabled; students can only read their own rows.
- All writes that matter go through `security definer` SQL functions rather than raw table access, so
  the browser can never set its own status, role or balance.
- `guard_protected_columns()` stops a verified name, university or registration number being edited
  after approval. Migration 011 adds a unique index on `(university, registration_number)` so one
  identity cannot hold two accounts.
- Passwords are handled entirely by Supabase Auth. Nothing in `public.*` stores a raw password.
  The client-side rule is exactly four digits (016, `strongPw`); the PIN is stretched with a fixed
  public suffix before it is sent (`pinToAuthPassword`), so the server's own minimum password
  length cannot reject it.
- The `verification-documents` bucket is private; each student can read and write only their own
  folder. 011 adds MIME type and 5MB size constraints and a delete policy — previously only the
  folder path was checked, so a `passport.php.exe` and a 400MB archive both went through.
- `audit_logs` records sensitive actions with the acting user and timestamp. After migration 029,
  only active Super Admins can read it; writes remain limited to server-side functions. The route is
  `/admin/audit-log`.
- The anon key is the only Supabase key in the frontend (`src/lib/supabase.ts`).
- `.env` is git-ignored; `.env.example` ships with empty values.
- Role assignment is **SUPER_ADMIN only**, cannot be applied to your own account, and cannot demote
  the last active super admin — so a manager cannot mint a super admin or lock everyone out.
- Suspension takes effect immediately: every function checks `status = 'ACTIVE'`, not just sign-in.
- Migrations 028–029 add the CEO role and enforce the role-specific RLS/RPC boundaries for
  application review, disbursement, repayments, collections, reporting, settings, and staff
  administration. Loan Officers see active loans only; Collection Officers cannot read general
  repayment or loan records; only Accountants and Super Admins can record repayments.
- `delete_my_account()` refuses while any loan exists, because the institution's record of the debt
  must outlive the account. Migration 014 restates it, because the `ON DELETE CASCADE` from
  `public.users` now has much more to take with it — and restores the STUDENT-only check that a
  later migration had dropped, which had let any member of staff delete their own account.
- **The application wizard never sets a verification status.** A register match is recorded on the
  *application* (`student_confirmed_at`, `student_record_id`, `verification_method`), not on
  `student_profiles.verification_status`. The browser cannot promote itself to "verified", and a
  student's identity is frozen per application rather than being a single global flag that a later
  application could silently inherit.
- **Double submission is refused by the server.** `submit_loan_application()` takes a `for update` row
  lock and updates `where status = 'DRAFT'`, so a second click on a slow connection is rejected by
  the database rather than relying on a disabled button.
- **Application numbers are generated by a sequence** and the column is `UNIQUE`, so two applications
  cannot share one however hard the button is pressed.
- **Public tracking returns a deliberately thin answer.** `/track` needs the application number *and*
  the phone number on the account, and returns a status, two dates, initials and a document count —
  not the amount, the full name, the registration number, the university, the purpose, the guarantor
  or any document path. A wrong phone number returns exactly the same "no match" as a wrong number,
  so the page cannot be used to discover which application numbers exist. Lookups are rate-limited
  and audited.
- **Register lookup requires both a registration number and a last name**, is rate-limited, and
  returns no rows rather than creating a record when nothing matches. The wizard cannot invent a
  student.
- **Staff read one applicant at a time, through `application_student_detail()`**, not through a
  widened policy on `student_profiles`. Loosening that table would have handed a loan officer the
  contact details of every student who had ever signed up, including the many who never applied.
- **Application documents are opened through short-lived signed URLs.** No permanent URL to any
  document exists anywhere in the system, and the storage policy limits reads to the owner or an
  active reviewer.

## Before going to production

1. **Make the repository private.** The TODO at the top of this file.
2. **Environment variables** — set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
   `VITE_BASE_PATH` in your hosting provider's dashboard or repository secrets.
3. **Supabase Auth settings — students use a phone number and four-digit PIN, mapped to a synthetic
  email** (see `README.md` and `phoneToAuthEmail` in `src/lib/validate.ts`). The project settings
   must match the current flow:

   - **Authentication → Providers → Email: ON.** Student accounts use the email provider with a
     synthetic address; staff continue to use their real email addresses.
   - **Authentication → Providers → Phone: OFF.** The app does not use Supabase phone identity or
     SMS verification.
   - **Authentication → Providers → Email → Confirm email: OFF.** Synthetic student addresses
     cannot receive confirmation mail, and staff sign-up also needs an immediate session.
   - **Authentication → Sign In / Providers → Email → Minimum password length: 4.** Student PINs
     are stretched before reaching Auth, but staff password resets store the password as typed.

   Also set the Site URL and Redirect URLs to the real domain — email password reset depends on it.

   **The credential itself, stated once.** A four-digit PIN has ten thousand possibilities, and a
   student account is identified by a phone number rather than an email address, which means the
   number is the only secret an attacker has to guess alongside it. Anyone who knows a student's
   number can walk that space quickly, and no email confirmation or lockout stands in the way. This
   is the policy the business specified and it is implemented as specified; it is recorded here
   because the alternative — leaving the app enforcing a stronger rule than the account server —
   produces a product that looks secure and is not. If that risk is not acceptable, the change that
   reverses it is `strongPw` in `src/lib/validate.ts` **and** the Minimum password length setting;
   the app-side rule alone is not enough, and it is not a boundary.
4. **Confirm the business settings in /admin/settings.** The loan minimum, maximum and permitted
   terms ship as **unconfirmed defaults**, and the maximum is not a number anyone has agreed to. Set
   them before a student can see them on the application form. Migration 014 adds two more that are
   equally unconfirmed: **guarantor required** (ships `true`) and **required application documents**
   (ships `STUDENT_ID,NATIONAL_ID,GURANTOR_ID`). A required document a student cannot obtain stops
   applications at the last step, and a guarantor rule that is wrong rejects students who had no way
   to know.
5. **Decide the interest rate — or explicitly decide there is none.** `annual_interest_rate` is 0 and
   `interest_convention` is `none` because OGESEOUS has not confirmed a rate. Charging interest on
   student loans in Tanzania raises regulatory questions as well as commercial ones. Leaving it at
   zero is a valid, defensible answer; setting it non-zero without that decision is not.
6. **Backups** — enable Supabase automatic daily backups, or point-in-time recovery, before real
   student and financial data goes in.
7. **HTTPS** — serve only over HTTPS. GitHub Pages does this by default.
8. **Real notifications** — SMS/email reminders are recorded as attempts and go nowhere. Configure a
   provider (e.g. Africa's Talking) before relying on collections, and remove the "not configured"
   notices once they work.
9. **Publish the contact details and the legal documents.** The site currently says "not yet
   published" and the privacy and terms pages are clearly marked as drafts. A contact form that
   reaches nobody is worse than none, and a terms page a student accepts that does not exist is a
   real problem, not a cosmetic one.
10. **Run `supabase/verify_migrations.sql`** and read section 12 — it lists loans that predate the
    installment schedule and have no installments generated for them.
11. **Human review of the SQL.** It has never been executed. Every function that moves money —
    `disburse_loan`, `record_repayment`, `reverse_repayment`, `void_disbursement`,
    `recalculate_loan`, `rebuild_loan_payments` — should be read line by line by someone who can
    verify the arithmetic, and then exercised against a staging project with reconciliation queries
    after each step.
12. **Penetration testing** before real students are onboarded.

## Known limitations, stated rather than buried

- Reminders and the contact form deliver nothing; there is no SMS or email provider configured.
- Reports are aggregate totals, not a BI dashboard.
- `search_rucu_student` and the wizard's `verify_student_from_register` are rate-limited in the
  database, which is a mitigation rather than a complete answer to enumeration. Put a WAF in front of
  the public site as well.
- Loans that predate migration 013 have no repayment schedule (see item 10 above).
- The frontend has unit tests for its pure logic but no end-to-end tests, and nothing has been run
  against a live Supabase project.
- **A staff member who is signed in on a shared or public machine can read applications**, documents
  included. There is no second-factor authentication anywhere. Revoke access by setting
  `status = 'SUSPENDED'` rather than by relying on the account being forgotten.