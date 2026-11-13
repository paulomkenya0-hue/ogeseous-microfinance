# Connecting this app to a client's fresh Supabase project

This runbook covers the **fresh-database** handover: the client owns a new Supabase
project, and this app is moved from the developer's project to it. No existing data is
carried across. To move existing data instead, see the note at the end.

The app never talks to Supabase directly from a server of ours: the browser uses the
project URL and the **publishable/anon** key. Everything else (schema, auth settings,
admin bootstrap) is configured once in the client's dashboard or with the CLI.

---

## 0. What the client must provide

Safe to share (these end up in the browser anyway):

- **Project URL** — `https://<project-ref>.supabase.co`
- **Publishable / anon key** — `sb_publishable_...` or the legacy `eyJ...` anon key
- **Project ref** — the `<project-ref>` part of the URL
- **The site's real domain** — for Auth redirects

Keep private, never in chat, never in git:

- **Database password**
- **Service role / secret key** (`sb_secret_...`) — bypasses RLS; server-side only
- The client's Supabase account password. Ask the client to invite you to the project
  as a **Developer** instead, and remove your access after handover.

---

## 1. Point the app at the new project

Create `.env` from the template (it is gitignored):

```bash
cp .env.example .env
```

Fill in:

```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
```

Do **not** put a service role key here. Vite inlines these values into the client
bundle, so anything in `.env` is public.

The app should now start, but every query will fail with “relation does not exist”
until step 2. That is expected on an empty project.

---

## 2. Create the schema

All 24 migrations must run **in order**. They are not idempotent as a set, so do not
re-run one that already succeeded.

### Option A — Supabase CLI (recommended)

```bash
npm i -D supabase
npx supabase login
npx supabase init          # creates supabase/config.toml; safe if it does not exist yet
npx supabase link --project-ref <project-ref>
npx supabase db push
```

`link` asks for the database password. `db push` applies every file in
`supabase/migrations/` and records them in `supabase_migrations.schema_migrations`.

### Option B — psql

Keep the connection string out of your shell history and out of chat. Put it in a
local, gitignored file such as `.env.migration`:

```env
SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
```

Then:

```bash
set -a; . ./.env.migration; set +a
for f in supabase/migrations/*.sql; do
  echo "== $f"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

### Option C — SQL editor

Open **SQL Editor** in the client's dashboard and run each file from
`supabase/migrations/001_foundation.sql` through `024_restore_is_admin_execute.sql`, in
order. Slower, but needs no local tooling.

### If `db.<project-ref>.supabase.co` is unreachable

That hostname is often IPv6-only. On a network without IPv6, use the IPv4 pooler
instead, with the **session** port:

```env
SUPABASE_DB_HOST=aws-0-<region>.pooler.supabase.com
SUPABASE_DB_PORT=5432
SUPABASE_DB_USER=postgres.<project-ref>
SUPABASE_DB_PASSWORD=<database-password>
SUPABASE_DB_NAME=postgres
```

Keep the password in separate variables rather than URL-encoding it into a connection
string; `pg` and the CLI can disagree about the encoding. `scripts/run-sql.cjs` accepts
either form and runs a multi-statement `.sql` file statement by statement.

### Verify

```bash
# with SUPABASE_DB_URL, or the SUPABASE_DB_* variables above
node scripts/run-sql.cjs supabase/verify_migrations.sql
```

Every row must say `PASS`. On a fresh database, the sections that list legacy data
are simply empty.

---

## 3. Configure Auth in the client's project

Dashboard → **Authentication**:

| Setting | Value | Why |
|---|---|---|
| Providers → Email | **ON** | Students use a synthetic email identity |
| Providers → Email → Confirm email | **OFF** | With it on, GoTrue's mail path sends the `.local` domain to Supabase's email validator, which rejects it (`email_address_invalid`); signup fails and no account is usable. Off means no mail is sent at all and signup returns a session immediately. Do not re-enable it. |
| Providers → Email → Minimum password length | **6** (Cloud minimum) | The form asks for four digits; `studentPassword()` appends a fixed public suffix so GoTrue's length check passes. Cloud will not accept 4. |
| URL Configuration → Site URL | the client's real domain | Password reset and auth redirects |
| URL Configuration → Redirect URLs | the client's domain and `http://localhost:5173` | Local testing |

These are dashboard settings. They cannot be set with SQL, and `supabase config push`
needs a personal access token; do them by hand once per project.

Optional but recommended: configure a real SMTP provider if staff password reset by
email must work. Student PINs are reset by an administrator.

---

## 4. Create the first administrator

1. In the client's dashboard → **Authentication → Users → Add user**, create the first
   staff account with a real email and a strong password. The `on_auth_user_created`
   trigger creates the matching `public.users` row.
2. Promote it once, in SQL:

   ```sql
   update public.users set role = 'SUPER_ADMIN' where email = 'owner@example.com';
   ```

3. Sign in at `/login` and use **/admin/settings** for every further staff account and
   role change. That page also holds the loan limits, terms, guarantor rule and the
   required document list — confirm them with the client before students register.

---

## 5. Deploy the frontend

Update the production environment so the built bundle uses the new project:

- **GitHub Actions**: repository secrets `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` (`.github/workflows/deploy.yml`).
- Any other host (Vercel/Netlify/Cloudflare): the same two variables, then rebuild.
- Keep `VITE_BASE_PATH` and `public/404.html` consistent with the deployment path.

Changing `.env` locally does **not** change an already-deployed site; the bundle must
be rebuilt and redeployed.

---

## 6. Smoke test

Run through these on the new project before calling it done:

- [ ] Student registration with a phone number and a 4-digit PIN
- [ ] Sign out and sign back in with phone + PIN
- [ ] Staff login with email + password
- [ ] Upload a verification document and open it as staff (Storage + signed URLs)
- [ ] Submit an application and track it at `/track` with the application number + phone
- [ ] Create a loan, record a repayment, reverse it, and check the balance
- [ ] `/admin/settings` loads and saves
- [ ] `verify_migrations.sql` reports no `FAIL`

---

## 7. Handover and cleanup

- Client changes the database password and, if they choose, rotates the JWT secret
  (rotating the JWT secret invalidates sessions and requires updating the anon key).
- Remove the developer's membership from the client's Supabase organisation.
- Keep the old project read-only for 7–30 days as a rollback, then pause/delete it.
- Delete local database dumps and `.env.migration` when finished. They contain PII.
- Never commit `.env`, `.env.migration`, dumps, or service keys.

---

## If data must be moved instead

A fresh start is not the same as a migration. Moving existing data means copying, in
this order:

1. `public` table data (which references `auth.users`, so auth comes first or triggers
   must be handled)
2. `auth.users` + `auth.identities`, preserving `id` and `encrypted_password` so PINs
   keep working — or recreating users and issuing new PINs
3. the private `verification-documents` Storage bucket, preserving object paths
4. sequences, then row counts and the financial reconciliation checks

Freeze writes on the old app for the whole copy. Test the restore into a scratch
project first; direct writes to `auth` are the part most likely to break across
Supabase Auth versions.
