# OGESEOUS MICROFINANCE — Security & Deployment (Step 12)

> ## TODO — MAKE THIS REPOSITORY PRIVATE
> This repo is **public** while setup is in progress. It must be switched to private before
> the app is deployed or anyone outside the team is given access.
> **How:** repo → `Settings` → `Danger Zone` → `Change repository visibility` → `Make private`.
> **Verify it worked:** open the repo in a browser while logged OUT — you should get a 404.
>
> Why it matters even though nothing sensitive is committed: the SQL migrations *are* the security
> model. They publish every role, every RLS policy and every money-handling function. No secrets
> and no student PII are in git (those live in the Supabase database), so the exposure is the
> design, not the data — but there is no reason for a live financial system to publish it.
> Note that git history is permanent: making it private later protects everything from that point
> on, but anything already scraped stays scraped. See `supabase/` for the sensitive part.

This environment has no network access, so nothing here has been deployed or penetration-tested.
This is a checklist and a summary of what the code already does, for whoever deploys it.

## Already in the code
- Every table has Row Level Security enabled; students can only read their own rows.
- All writes that matter (role changes, verification, review, disbursement, repayments) go through
  `security definer` SQL functions, not raw table access — so the browser can never set its own status,
  role, or balance.
- Passwords are handled entirely by Supabase Auth; nothing touches or stores raw passwords in `public.*`.
- Storage (`verification-documents`) is a private bucket; each student can read/write only their own folder.
- `audit_logs` records every sensitive action (role changes blocked, verification decisions, disbursements,
  repayments, reminders) with the acting user and timestamp. Only admins can read it; nothing can write to
  it except the server-side functions.
- The anon key is the only Supabase key ever used in the frontend (`src/lib/supabase.ts`); the service role
  key must never be added there.
- `.env` is git-ignored; `.env.example` ships with empty values.

## Before going to production
1. **Environment variables** — set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in your hosting
   provider's dashboard, not committed to source control.
2. **Supabase Auth settings** — turn on email confirmation, set a strong minimum password policy, and set
   the Site URL / Redirect URLs to your real domain (password reset links depend on this).
3. **First admin** — after deploying, run the `update public.users set role='SUPER_ADMIN' ...` line from the
   README once, then create further staff/marketing-officer accounts through the app, never by hand.
4. **HTTPS** — serve the app only over HTTPS (Vercel/Netlify/Supabase-linked hosts do this by default).
5. **Backups** — enable Supabase's automatic daily backups (or point-in-time recovery on a paid plan)
   before real student and financial data goes in.
6. **Rate limiting / abuse** — Supabase Auth already rate-limits login attempts; consider adding a WAF or
   Cloudflare in front of the app for the public site once it's live.
7. **Real notifications** — SMS/email reminders and the contact form are placeholders on purpose (Step 10 /
   Step 1). Wire an actual provider (e.g. Africa's Talking for SMS, a transactional email service) before
   relying on them, and remove the "not configured" notices once they work.
8. **Load testing / review** — this was built and reviewed by one AI-assisted pass with no test run. Before
   real money moves through it, have it reviewed by a human developer and tested end-to-end against a
   staging Supabase project.

## What's intentionally simple, not yet "production-grade"
- Repayment due dates are a single date (disbursement + repayment period), not an installment schedule.
- Collections reminders are logged, not sent.
- Reports are aggregate totals, not a full BI dashboard.
These can be extended without restructuring what's already built.
