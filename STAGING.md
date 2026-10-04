# OGESEOUS MICROFINANCE — Staging Verification

> **Never run any of this against the production project.** Staging uses a separate Supabase
> project, throwaway credentials and invented test people only. No production credentials, no real
> student data, no real phone numbers.

This is the gate between "the code compiles and the unit tests pass" and "real students use this".
Nothing in this file has been executed yet — every result row starts as **NOT TESTED** and is only
flipped to PASS/FAIL by actually doing the step on staging.

---

## 0. Known migration defects — resolve BEFORE staging

The static audit (001→018, read in full) found two defects that staging would trip over
immediately. **They are reported here with their proposed fixes and are awaiting approval — the
migration files have deliberately not been rewritten unilaterally.**

### 0.1 `018_auth_update_no_phone_auth.sql` — syntax error (migration cannot execute)

The function body is delimited by literal `\$\$` (backslash-dollar) at lines 8 and 19 instead of
`$$`. Verified at byte level (`5C 24 5C 24`) in both the working tree and remote HEAD `714dd09`.
PostgreSQL rejects it with `syntax error at or near "\"`. It is the **only** `\$` sequence in the
whole migrations directory — every other function uses `$$`.

What happens if it is run as-is in the SQL editor: the `create unique index` statement (line 4)
executes, then the function definition fails and the script aborts. `handle_new_user` stays at the
016 version, which reads `auth.users.phone` only — so `public.users.phone` is **NULL for every
student** created through the current synthetic-email signup. Registration, login and `/track`
still appear to work (`student_profiles.phone` is populated from metadata and `track_application`
reads it first), so the failure is easy to miss — but `verify_migrations.sql` cannot detect it
(section 16a passes on both the 016 and 018 trigger bodies).

Also in 018: `users_phone_unique_idx` (line 4) duplicates 016's `users_phone_unique` — two names
for the same partial unique index on `public.users(phone)`. Harmless but redundant; keep one.

**Proposed fix:** replace `\$\$` with `$$` at both delimiters (4 characters). Optionally drop the
duplicate index (`drop index if exists public.users_phone_unique_idx;`) in a follow-up migration.

### 0.2 `011_security_hardening.sql` — `allowed_repayment_months()` crashes at runtime

`app_settings` seeds `allowed_repayment_months = '6,12,18,24'` (011 line 170), a comma-separated
list. But `allowed_repayment_months()` (011 lines 212–219) reads it through
`setting_num('allowed_repayment_months', 24)`, whose body does `value::numeric` — and
`'6,12,18,24'::numeric` raises `invalid input syntax for type numeric`. The `coalesce` cannot
catch a cast error. Every caller fails: `loan_policy()` (011:236, 014:271),
`save_loan_application_draft()` (011:270), `save_application_loan()` (014:532). The LoanWizard
reads `loan_policy` on mount and calls `save_application_loan` at steps 2/7, so **the loan
application wizard cannot work** until this is fixed. A manager saving the same comma format from
/admin/settings would re-trigger it at any time.

**Proposed fix:** make `allowed_repayment_months()` read the raw setting text instead of the
numeric helper — same shape, same fallback, no caller changes:

```sql
create or replace function public.allowed_repayment_months() returns integer[]
language sql stable as $$
  select array(
    select btrim(m)::int
    from unnest(string_to_array(
      coalesce(
        nullif(trim((select value from public.app_settings where key = 'allowed_repayment_months')), ''),
        '24'),
      ',')) as btrim(m)
    where btrim(m) ~ '^[0-9]{1,3}$' and btrim(m)::int between 1 and 120
    order by 1);
$$;
```

### 0.3 Non-blocking discrepancies (record, do not fix blindly)

- `README.md`'s migration table stops at 017; 018 is undocumented (added with the table update in
  this change set).
- `verify_migrations.sql` header says "001 → 017"; it has no checks for 018's objects and its
  section 16a cannot tell the 016 and 018 trigger bodies apart. Extend it after 0.1 lands.
- 011's two storage policies (lines 484–487) have no `drop policy if exists` — 011 is not
  re-runnable. Fine for one-shot migrations; matters if a staging run is repeated.
- 005's `get_application_verification` is granted to `anon` with sequential application numbers
  guarded only by a 10-hex-char (40-bit) token and **no rate limit** (unlike `track_application`,
  which has one). Flag for a risk decision; add a rate limit in a future migration.
- 013/014 `delete_my_account` deletes the `public.users` row but cannot delete the `auth.users`
  identity (no SQL path to it). The orphan auth account can sign in but gets "Account unavailable".
  Acceptable; document for support.
- Stale comments: 011:156 (`013_installments.sql`), 011:533 (reversal columns "added by 012" —
  they are added by 011 itself at 536–538).

---

## 1. Create the staging project

1. Supabase dashboard → **New project** → name it clearly, e.g. `ogeseous-staging`. Separate
   organisation is fine; separate project is mandatory.
2. Record the staging `VITE_SUPABASE_URL` and **anon** key in a local `.env.staging` (git-ignored).
   Never copy the production keys or any production data into it.
3. Point a local checkout at staging (`cp .env.staging .env`) or deploy a preview build with the
   staging values as environment variables. The GitHub Pages production secrets stay untouched.

## 2. Apply migrations

In the **staging** SQL editor, run in order, one file at a time, reading the output of each:

`001 → 002 → … → 017 → 018` (018 only after 0.1 is fixed and approved).

- 011 before 012/013/014 — the later ones depend on objects 011 creates.
- 016 section 3's sanity SELECTs return: zero staff without email; the SUPER_ADMIN row; counts of
  students with/without email; zero invented addresses.
- After each file: no error message. If a file errors, stop — do not "fix forward" by skipping.
- Then run `supabase/verify_migrations.sql` end to end. Every row must read PASS (or the expected
  value where the section says so). Note its blind spots (0.3): also run the two manual checks:

```sql
-- 018 actually applied: the trigger body reads the metadata fallback, not only new.phone
select case when p.prosrc like '%raw_user_meta_data->>''phone''%'
            then 'PASS - 018 handle_new_user' else 'FAIL - still the 016 body' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'handle_new_user';

-- 0.2 fixed: returns {6,12,18,24} instead of raising
select public.allowed_repayment_months();
```

## 3. Configure authentication (staging dashboard)

| Setting | Value | Why |
|---|---|---|
| Authentication → Providers → **Email** | **ON** (default) | Student accounts are synthetic email identities; staff sign in with email. |
| Authentication → Providers → Email → **Confirm email** | **OFF** | With it on, sign-up returns no session and the synthetic address has no inbox. |
| Authentication → Providers → **Phone** | **OFF** | The app does not use phone auth (018). Login tolerates either state, but off is the documented configuration. |
| Authentication → Sign In / Providers → Email → **Minimum password length** | **4** | Student flows are independent of this (PINs are stretched client-side), but the staff reset page stores passwords as typed — a 4-digit staff password is refused by the server otherwise. |
| Authentication → URL Configuration → **Site URL / Redirect URLs** | the staging URL | Staff password-reset links must come back to the staging app. |

## 4. Seed staging (invented people only)

1. Create the first staff account in the dashboard (Authentication → Users → Add user, email
   identity), then promote it:

   ```sql
   update public.users set role = 'SUPER_ADMIN' where email = 'staff@example.test';
   ```

2. Sign in as that account, open /admin/settings, set loan min/max, permitted terms,
   guarantor_required and required documents to the intended test values.
3. Import two invented RUCU register rows via /admin/students (CSV/JSON through
   `import_rucu_students`) so the wizard's RUCU path can be tested. All names/numbers invented.

## 5. End-to-end test plan

Mark each row PASS / FAIL / BLOCKED / NOT TESTED with a date and initials.

### Student auth

| # | Test | Expected |
|---|---|---|
| S1 | Register `0754 123 456` + PIN `1234` | Account created; session returned; lands on /dashboard (no error panel). |
| S2 | In SQL: `select email, phone from public.users order by created_at desc limit 1;` | email `phone_plus255754123456@ogeseous.local`, phone `+255754123456` — proves 018's trigger is live. |
| S3 | Sign out; sign in with `+255754123456` + `1234` | Signs in (normalisation matches registration). Also try `0754123456` and `754123456`. |
| S4 | Sign in with correct number + wrong PIN `4321` | Fails with "That phone number and password do not match an account." — nothing else revealed. |
| S5 | Sign in with an unregistered number + any PIN | Identical message to S4 (no enumeration). |
| S6 | Register with PIN `123` / `12345` / `12a4` / `12 4` / `abcd` / empty | Each rejected at the form with "4 digits, numbers only"; no account created. |
| S7 | Register with mismatched confirmation PIN | Rejected with "PINs do not match"; no account created. |
| S8 | Register + sign in with `0000`, and a leading-zero PIN like `0712` | Both accepted (business rule allows), sign-in works. Leading zero preserved (string, never a number). |
| S9 | Signed-in student opens /reset-password directly, sets a new PIN | New PIN signs in; old PIN fails. (Staff-link recovery also exercised under T2.) |
| S10 | Register the same phone twice | Second attempt: "An account already exists with that phone number…" |

### Staff auth and authorisation

| # | Test | Expected |
|---|---|---|
| T1 | Staff sign in with email + password | Lands on /admin. |
| T2 | Staff "Forgot password" → email link → /reset-password → new password | Reset succeeds; new password signs in; old one fails. (If the new password is 4 digits this requires setting 3 = 4.) |
| T3 | SUPER_ADMIN promotes/demotes a second staff account at /admin/settings | Works; audited (`audit_logs` row). Cannot demote the last active SUPER_ADMIN. |
| T4 | Signed-in student opens /admin/dashboard | Redirected to /dashboard (guard). Direct SQL: student JWT calling `set_user_role` / `list_staff` / `disburse_loan` → permission exceptions. |
| T5 | Suspended staff member (set status SUSPENDED) | Loses access on next request; role functions refuse them. |

### Wizard smoke (depends on 0.2 fix)

| # | Test | Expected |
|---|---|---|
| W1 | Wizard loads | `loan_policy()` returns ranges; no "invalid input syntax" error. |
| W2 | Step 1 RUCU match with an invented register row | Confirms via `verify_student_from_register`. |
| W3 | Steps 2–7 with uploads, submit | Application number `OGS-<year>-<serial>` shown; row is UNDER_REVIEW. |
| W4 | /track with the number + a wrong phone | Same "no match" answer as a wrong number — no enumeration. |

## 6. Security verification on staging

| # | Check | How | Expected |
|---|---|---|---|
| V1 | Anonymous cannot read users | `curl "$URL/rest/v1/users?select=*" -H "apikey: $ANON"` | `[]` (RLS denies; no rows, no error). |
| V2 | Student cannot read another student's data | As student A: select `student_profiles`/`loan_applications` filtered to B's id | `[]`. |
| V3 | Student cannot call admin functions | As student: `rpc/set_user_role`, `rpc/disburse_loan`, `rpc/list_staff` | Exception messages ("Only…"), no state change. |
| V4 | RLS on every table | verify_migrations.sql section 2 | Every public table `rls_enabled = true`. |
| V5 | Errors don't reveal account existence | S4 vs S5 side by side | Byte-identical messages. |
| V6 | No PIN in logs/URLs | Browser devtools during S1–S9 | PIN/stretched password only ever in POST bodies to `/auth/v1/*`; nothing in console, storage, or URLs. |
| V7 | No service-role key shipped | Inspect built bundle + environment | Only the anon key present. |
| V8 | Storage privacy | Signed URL for student A's document opened as student B / anonymous | Refused. |
| V9 | Track endpoint shape | W4 + a burst of >120 lookups/min | Thin response only; 121st refused. |

## 7. Sign-off

Staging is complete only when: migrations 001–018 applied cleanly, `verify_migrations.sql` all
PASS plus the two manual checks in §2, every S/T/W row PASS, every V row PASS. Anything less stays
**BLOCKED** and production is not discussed.
