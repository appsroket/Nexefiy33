# Supabase Setup and Database Operations

## Project

| Item | Value |
|---|---|
| Project name | Nexefiy |
| Project ref | `rnqrqconfbcrmszllxgu` |
| API URL | `https://rnqrqconfbcrmszllxgu.supabase.co` |
| Region | eu-north-1 (Stockholm) |
| Postgres | 17 |
| Role | **Development database** (decided 2026-10-17, ADR-010). Create a separate production project before launch. |
| Schema state (2026-10-17) | 12 migrations applied, 33 tables, RLS on all; no application data |

## API keys

| Key | Format | Where used | Notes |
|---|---|---|---|
| Publishable key | `sb_publishable_…` | Browser + server (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) | Safe to expose; all access governed by RLS. |
| Secret key | `sb_secret_…` | Server/worker only (`SUPABASE_SECRET_KEY`) | Bypasses RLS. Used by `src/lib/supabase/admin.ts`. Never `NEXT_PUBLIC_`. |
| Legacy `anon` / `service_role` JWT keys | `eyJ…` | Not used | Still enabled; disable once nothing uses them. |

Credential setup details: [credential-setup.md](credential-setup.md#a-supabase).

## Clients

| Client | File | Status |
|---|---|---|
| Admin (secret key, typed) | `src/lib/supabase/admin.ts` | Implemented (Phase 3) |
| Browser / server (user session via `@supabase/ssr`) | `src/lib/supabase/{client,server}.ts` | With the app-shell phase |
| Types | `src/lib/supabase/database.types.ts` (generated), `types.ts` (helpers) | Implemented |

## Auth configuration (Dashboard → Authentication)

To configure with the app-shell phase:
- Site URL: `http://localhost:3000` for dev; production domain later.
- Redirect URLs: `http://localhost:3000/**`, Vercel preview pattern, production URL. The app's callback route is `/auth/callback` (`src/lib/config/endpoints.ts`).
- Email confirmations: on — `accept_invitation()` requires a confirmed email. Custom SMTP via Resend before launch — settings in [credential-setup.md](credential-setup.md#c-email-resend).
- Minimum password length 10; leaked-password protection on (if available on plan).

## Storage

Planned bucket `knowledge` (private). Path convention `<organization_id>/<source_id>/<filename>` — `knowledge_sources.storage_path` must start with the organization id (check constraint). Storage policies arrive with the knowledge phase.

---

## Operations

All commands run from the repository root. The Supabase CLI is used through `npx supabase` (no global install needed).

### One-time setup (per developer machine)

```bash
npx supabase login
```

```bash
npx supabase link --project-ref rnqrqconfbcrmszllxgu
```

`link` asks for the database password (Dashboard → Project Settings → Database). Keep it in a password manager; it is not an app variable.

### Local database (requires Docker)

The primary dev machine has no Docker, so this path is not used there. On a machine with Docker (or in CI):

```bash
npx supabase start
```

```bash
npx supabase db reset
```

`db reset` rebuilds the **local** database from `supabase/migrations/` (it never touches the linked project). Stop with `npx supabase stop`.

### Create a migration

```bash
npx supabase migration new <short_name>
```

Write SQL in the generated file. Never edit a migration that has been applied anywhere — add a new one.

### Inspect migration status

```bash
npx supabase migration list --linked
```

Shows local vs. remote versions side by side. They must match exactly.

### Apply migrations to development

```bash
npx supabase db push --linked --dry-run
```

```bash
npx supabase db push --linked
```

Review the dry run first: it lists exactly which migrations will run.

> Migrations 1–12 were applied on 2026-10-17 through the Supabase MCP connector (`apply_migration`), which records its own timestamp; the local files were renamed to those recorded versions, and their contents were verified byte-identical (MD5) to what the database recorded. `migration list` therefore shows them as in sync. Migration 13 (`20261018102320_invitation_lookup`) was applied the same way on 2026-10-18 and verified the same way. Migration 14 (`20261018145032_business_context`) was applied and verified the same way on 2026-10-18. Migration `20261018154440_integration_framework` (Phase 8) was applied and verified the same way on 2026-10-18, and pgTAP `007` ran against it (34/34). Migration `knowledge_pipeline` (local file `20261018150000_knowledge_pipeline.sql`) is **not applied yet** — its local timestamp is now older than an applied migration, so the CLI needs `db push --include-all`, or apply it through the connector and rename the file to the recorded version: the connector asks the project owner to confirm statements containing `DROP`. After applying it, rename the local file to the version the database records (`npx supabase migration list --linked` or the MCP `list_migrations` tool), check the MD5, run pgTAP (`001`–`006`), check the advisors and regenerate types.

### Run the database security tests

```bash
npx supabase test db --linked
```

Runs the pgTAP files in `supabase/tests/database/` against the linked project. Each file runs in a transaction that is rolled back, so no test data persists. Locally (Docker): `npx supabase test db`.

After editing `supabase/test-fixtures/two_organizations.sql`, copy it into the test files:

```bash
npm run db:test:sync
```

### Generate TypeScript types

```bash
npm run db:types
```

Writes `src/lib/supabase/database.types.ts` from the linked project. Regenerate after every migration and commit the result; `npm test` fails if a table in the migrations is missing from the types.

### Check advisors after every migration

Dashboard → Advisors (Security and Performance), or the Supabase MCP `get_advisors` tool. Fix new **WARN/ERROR** findings before merging. Accepted findings are listed in [database-design.md §6](database-design.md#security-definer-review).

### Staging and production (safe rollout)

1. Create separate Supabase projects for staging and production (same region). Never point development tooling at production by default.
2. Promote only migrations that passed review, `npm test`, and `supabase test db` against development.
3. For each target, link explicitly and dry-run:

```bash
npx supabase link --project-ref <target-project-ref>
```

```bash
npx supabase db push --linked --dry-run
```

4. Take a backup / confirm point-in-time recovery is enabled, then `npx supabase db push --linked`.
5. Run `npx supabase test db --linked` against staging (never production — tests insert and roll back data).
6. Re-link to development afterwards.

Rules: never run `db reset` against a linked remote project; destructive migrations (drops, type changes, data rewrites) need a written plan, a backup, and explicit approval; prefer expand-and-contract (add new column → backfill → switch code → drop old in a later release).
