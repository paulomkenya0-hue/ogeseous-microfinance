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

Nothing in this file has been deployed or penetration-tested. There is no network access in the
environment this was written in. It is a checklist and an account of what the code already does.

## Already in the code

- Every table has Row Level Security enabled; students can only read their own rows.
- All writes that matter go through `security definer` SQL functions rather than raw table access, so
  the browser can never set its own status, role or balance.
- `guard_protected_columns()` stops a verified name, university or registration number being edited
  after approval. Migration 011 adds a unique index on `(university, registration_number)` so one
  identity cannot hold two accounts.
- Passwords are handled entirely by Supabase Auth. Nothing in `public.*` stores a raw password.
  The client-side rule is at least 10 characters with upper case, lower case and a digit.
- The `verification-documents` bucket is private; each student can read and write only their own
  folder. 011 adds MIME type and 5MB size constraints and a delete policy — previously only the
  folder path was checked, so a `passport.php.exe` and a 400MB archive both went through.
- `audit_logs` records sensitive actions with the acting user and timestamp. Only managers and super
  admins can read it; nothing writes to it except the server-side functions. It is now readable in
  the app at **/admin/audit-log**, which it previously was not at all.
- The anon key is the only Supabase key in the frontend (`src/lib/supabase.ts`).
- `.env` is git-ignored; `.env.example` ships with empty values.
- Role assignment is **SUPER_ADMIN only**, cannot be applied to your own account, and cannot demote
  the last active super admin — so a manager cannot mint a super admin or lock everyone out.
- Suspension takes effect immediately: every function checks `status = 'ACTIVE'`, not just sign-in.
- `delete_my_account()` refuses while any loan exists, because the institution's record of the debt
  must outlive the account.

## Before going to production

1. **Make the repository private.** The TODO at the top of this file.
2. **Environment variables** — set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
   `VITE_BASE_PATH` in your hosting provider's dashboard or repository secrets.
3. **Supabase Auth settings** — enable email confirmation, set a minimum password policy that
   matches the app's own rule (10 characters, mixed case and a digit), and set the Site URL and
   Redirect URLs to the real domain. Password reset links depend on all three.
4. **Confirm the business settings in /admin/settings.** The loan minimum, maximum and permitted
   terms ship as **unconfirmed defaults**, and the maximum is not a number anyone has agreed to. Set
   them before a student can see them on the application form.
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
- `search_rucu_student` is rate-limited in the database, which is a mitigation rather than a
  complete answer to enumeration. Put a WAF in front of the public site as well.
- Loans that predate migration 013 have no repayment schedule (see item 10 above).
- The frontend has unit tests for its pure logic but no end-to-end tests, and nothing has been run
  against a live Supabase project.