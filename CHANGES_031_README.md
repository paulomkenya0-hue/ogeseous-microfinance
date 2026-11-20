# OGESEOUS RUCU CSV / Form Four patch

Changes:
- Admin CSV import accepts blank `form_four_index_number` and reconstructs full names from `first_name`, `middle_name`, `last_name` when needed.
- Upload in batches of 200; show progress and errors.
- New migration `031_rucu_optional_index.sql`: nullable Form Four index; unique case-insensitive registration; updated import RPC; student self-report RPC limited to own RUCU matched DRAFT, logged and not verified.
- Wizard: student can submit or correct self-reported Form Four index after matching registration and surname. Staff verification is still required.

**Before deploying:** Take a database backup, review migration 031 for existing duplicate registration numbers, then apply to the *correct* linked Supabase project. Existing duplicates cause the migration to fail deliberately. Deploy the frontend only after migration succeeds.

**Important:** Matching registration + surname is NOT strong proof of identity. A self-reported index is not a verified credential. Existing RUCU matching workflow may need additional identity-proofing before any lending approval. Do not treat a match as identity verification.

Local TypeScript typecheck passed. Vitest/build could not run in this container because the uploaded Windows `node_modules` includes a missing Linux Rollup native package; run `npm ci && npm run verify` on the developer machine.
