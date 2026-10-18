# Known Limitations

Honest list of what does not exist or is unverified. Update every phase.

## As of Phase 8 (2026-10-18)

### Implemented and verified
- **Database:** migration `20261018154440_integration_framework` (OAuth states, refresh lease, rate-limit windows, connection health, tool-execution pending input/attempts/lease, `consume_integration_rate_limit`, `claim_tool_executions`) was applied to the development project through the Supabase MCP connector; the local file is byte-identical (MD5) to the recorded statement. Live checks: RLS on both new tables, no client privileges on them, `pending_input` not selectable by `authenticated`, both RPCs service-role only, the `authenticated` RPC list unchanged. **pgTAP `007_integration_framework`: 34/34** in one rolled-back transaction (the database held no test data afterwards). Security advisor: only "RLS enabled, no policy" on the two service-only tables (intentional, like `integration_secrets`). Hand-written types match the live columns.
- **Application:** the connector framework, HubSpot and Slack connectors, OAuth connect/callback, encrypted token storage and leased renewal, health checks, disconnect with provider revocation, the executor (roles, schemas, scopes, policies, payload-bound approvals, idempotency, retries, rate limits), approve/reject from Approvals, integration pages and test console, `/api/cron/integrations`. Vitest: 103 new tests (474 total). `tsc`, ESLint, `next build` and the bundle secret scan pass.

### Not verified yet
- **No live HubSpot or Slack call has been made.** This development container's network policy refuses `api.hubapi.com` and `slack.com` (proxy 403), the provider documentation sites could only be checked through web search, and no HubSpot/Slack app credentials, encryption keyring or Supabase secret key are configured anywhere yet. Connector behaviour is covered by contract tests whose responses were written from the providers' documentation (labelled as such) — they are not proof that a live account accepts the requests. Least certain, per the docs checked: the HubSpot `2026-03` revoke request body and introspection response fields, and whether notes accept only the contacts scope. Run the checklist in [integration-architecture.md §7](integration-architecture.md#live-verification-checklist-controlled-environment) before calling either integration available; the website keeps both at `first_release`.
- No signed-in browser check of the integration and approval pages (no real account has signed in yet; see Phase 6).
- pgTAP 001–006 were not re-run in this phase (006 still needs `knowledge_pipeline`, which remains unapplied; see Phase 7).

### Limitations
- **Actors:** only signed-in members (operator and above) request actions, through the test console. AI employees and workflows will call the same executor once built; `employee_tool_permissions` is not consulted yet.
- **Approvals:** an admin can approve an action they requested themselves (no separation of duties yet). Expired requests show as pending until someone opens them; `decide_approval` then marks them expired.
- **Execution:** approved actions run from an after-response nudge or `/api/cron/integrations`; there is no Vercel cron schedule yet (`vercel.json` does not exist) and no durable engine. A non-idempotent action whose server stops mid-call ends as "outcome unknown" (never resent).
- **Rate limits:** fixed windows allow short bursts at window edges; HubSpot is held at 100/10 s and 4 search requests/s, below the published 110/10 s and 5/s.
- **Not built:** inbound webhooks and triggers (Slack events, HubSpot webhooks), Gmail/Calendar, outbound webhooks, deal actions, private Slack channels, credential re-encryption after key rotation.
- Health checks and approved-action claims run across organizations from the cron route; each row is then handled with queries scoped to its own organization. `purgeOAuthStates` deletes expired states of every organization.
- The performance advisor lists composite foreign keys without a full covering index across the schema (pre-existing pattern), including the two new tables; informational.

## As of Phase 7 (2026-10-18)

### Implemented and verified
- **Database (partly):** migration `20261018145032_business_context` was applied to the development project through the Supabase MCP connector; the local file is byte-identical (MD5) to the recorded statement. Checked live with read-only queries: the company settings and per-kind attribute validators accept and reject the expected documents (18/18 checks), RLS is on with four policies, `anon` has no privileges, clients cannot update `kind`. Security advisor: no new findings. Generated types for `business_context_items` are identical to the hand-written ones.
- **Application:** company profile, hours and brand voice; eight kinds of business context; document upload, processing status, retry, reprocessing and deletion; test search with citations and an evidence verdict. Vitest covers text extraction from real (runtime-built) PDF and Word files plus text, Markdown, CSV and HTML; chunking; the evidence verdict, citations and untrusted-content framing (including delimiter forgery); the processing worker against an in-memory database (ready, retries with backoff, permanent failures, lost leases, organization scoping of every query, refusal to read another organization's folder); the Voyage client contract (fake fetch); retrieval; and the Server Actions. `tsc`, ESLint, `next build` and the bundle secret scan pass.

### Not verified yet
- **Migration `knowledge_pipeline` is not applied.** The Supabase connector held it for the owner's confirmation (it contains `DROP CONSTRAINT` / `DROP POLICY` to widen a check constraint and replace three policies) and the prompt was cancelled. Until it is applied the storage bucket, the processing queue, business context indexing and `search_knowledge` do not exist in the development database, so uploads and search fail there. pgTAP `006_knowledge_and_business_context` (storage folder isolation, roles, the sync trigger, reprocessing, the queue, retrieval boundaries) and the updated `001` have **not run**: the connector also held every write in a rolled-back test transaction for confirmation.
- No live Voyage AI call: the client is contract-tested with a fake fetch; the 0.45 similarity threshold is a starting value to calibrate with real documents.
- No signed-in browser check of the knowledge pages (no real account has signed in yet; see Phase 6).

### Limitations
- Processing runs after the response (`after()`) and from `/api/cron/knowledge`; there is no Vercel cron schedule yet (`vercel.json` does not exist). Without `SUPABASE_SECRET_KEY`, sources stay queued. Durable execution (Trigger.dev) is a later phase.
- Reprocessing a ready document takes it out of search until it is ready again. Two workers can only overlap after a 10-minute lease expires; the later one wins and the earlier one's final update is discarded.
- Scanned PDFs (images) are not supported (no OCR). Legacy `.doc`, spreadsheets, slides, URLs and integration content are not supported yet. Keyword search uses English stemming.
- Deleting a document deletes its row first and then its file; if the file removal fails the file stays in the organization's private folder (logged). Deleting a source directly through the Data API leaves its file behind.
- Prompt-injection detection is a short list of patterns that flags passages for people and models; it is not a filter and will miss rephrased attacks. The real protection is that retrieved text never authorizes anything (CLAUDE.md rule 2).
- Search is rate-limited to 30 per minute per user in memory per server instance.

## As of Phase 6 (2026-10-18)

### Implemented and verified
- **Database:** migration `20261018102320_invitation_lookup` (adds `get_invitation()`; `create_invitation()` now expires a lapsed invitation before re-inviting and reports a live one clearly) was applied to the development project through the Supabase MCP connector, and the local file is byte-identical (MD5) to the recorded statement. pgTAP, run on 2026-10-18 through the MCP wrapper (each file in one rolled-back transaction): new `005_auth_workspace_flow` 59/59, `001` 18/18 (RPC list updated), `002` 40/40, `003` 60/60. `004` (55 tests) was not re-run; nothing it covers changed. Afterwards the database held no test data (0 users, 0 organizations, 0 invitations, 0 audit rows). Security advisor: only the accepted findings (now five RPCs).
- **Application:** sign-up, sign-in, sign-out (this device and all devices), email confirmation and password-reset landing routes, password reset and change, workspace creation, switching, settings, company details, members (role changes, removal), invitations (create, resend, revoke, accept), leaving and deleting a workspace, profile, onboarding checklist. Vitest: 276 tests, including identity rules (39) and Server Actions and email-link routes with a fake Supabase client (27). `tsc`, ESLint, `next build` and the bundle secret scan pass.
- **Browser, signed out only** (dev server): `/app` redirects to sign-in and remembers the destination; sign-in and sign-up validation shows field errors and moves focus; `/reset-password` without a session and email links with a missing or bad code land on clear notices; a link that falls back to the Site URL (`/?code=`) is finished by the callback; an invitation link opened signed out removes the token from the address bar, keeps it in this browser, and offers sign-in/sign-up that return to it; account pages fit 375 px with one `<h1>` each.

### Not verified yet
- **No live sign-up, sign-in, confirmation email, password reset, invitation, or signed-in page has been exercised against Supabase.** Accounts weren't created during development. Signed-in pages are covered by type checking, the build and unit tests with a fake client; the authorization rules by pgTAP. A manual checklist is in the Phase 6 report.
- Supabase Auth URL settings can't be read without the dashboard. The public settings endpoint confirms email sign-up is on, confirmation is required, and no other providers are enabled. Site URL and Redirect URLs must be set as in [credential-setup.md](credential-setup.md#a-supabase).

### Limitations
- **Email delivery:** Supabase's built-in email service sends only to members of the Supabase project's team and is heavily rate-limited, so other people can't receive confirmation or reset emails until custom SMTP (Resend) is set up. Invitation emails need `RESEND_API_KEY` and `EMAIL_FROM`; without them the person inviting gets the link to share (shown once, never stored).
- **Email links (PKCE)** work only in the browser that asked for them. Switching the email templates to token-hash links handled by `/auth/confirm` removes this (see credential-setup).
- **Revoked sessions:** signing out everywhere and changing a password revoke refresh tokens at once, and every Server Action re-checks the session with Supabase Auth. Page rendering verifies the access token locally (ES256), so another device can still view pages, and call the Data API directly, until its access token expires (1 hour by default).
- **Rate limits** on sign-in, sign-up and reset emails are in memory per server instance. Server-side auth calls reach Supabase from the server's address, so Supabase's own per-IP limits apply to all users together; review before launch.
- **Sign-up is open** to anyone who can reach the site: no waitlist or invite-only mode. Decide before a public deployment (Supabase can disable sign-ups).
- No limit on how many workspaces one person can create. Deleting a workspace is immediate and permanent (cascading delete; the audit log keeps the record); no grace period or export.
- Not built: changing the sign-in email, multi-factor authentication, single sign-on or social sign-in, avatar upload, a per-device session list.
- An invitation token is kept in the browser's local storage for up to 7 days while the invitee signs in or signs up, and removed once used or found invalid.
- Pending invitations past their expiry show as expired by date; their status changes to `expired` when the address is invited again.
- CI and Playwright, planned for this phase in the roadmap, are not set up yet.
- Fixed in passing: `/app/settings` had been failing since Phase 4 (it looked up the navigation item by its old path).

## As of Phase 5 (2026-10-18)

### Implemented and verified
- **Application shell** (Phase 4) under `/app`: navigation, workspace switcher, account and notification menus, reusable components, error boundaries, read-only approvals list, overview counts. Verified with `tsc`, ESLint, `next build`, the bundle secret scan and Vitest. Only the signed-out state has been seen in a browser.
- **Public website** (Phase 5) at `/`: every page renders at 375 px and at desktop width without horizontal scrolling (dev server, 2026-10-18); the mobile menu moves focus in and returns it on Escape; the contact form shows its disabled state and the server refuses submissions while delivery isn't configured.

### Website limitations
- **Contact form not live:** `RESEND_API_KEY`, `EMAIL_FROM` and `CONTACT_FORM_TO` aren't configured, so the form is disabled. Delivery to Resend is covered only by tests with a fake `fetch`; no real email has been sent.
- **Rate limiting is per server instance** (in memory): it resets on deploy and isn't shared across instances. Replace it with a shared store in the hardening phase.
- ~~**Sign-in and sign-up pages are placeholders.**~~ Replaced by working pages in Phase 6.
- **Legal pages are unreviewed drafts** with placeholders (company name, address, jurisdiction, retention periods, contacts). They are marked "not in effect" and are noindex.
- **No social preview image** (Open Graph image) and no analytics.
- **No automated accessibility scan** (axe) or Playwright tests yet; keyboard behaviour was checked by hand on key flows only.
- The website shows no prices because pricing isn't decided.

### Application limitations
- ~~**No authentication.**~~ Built in Phase 6; the signed-in shell still hasn't been exercised live (see above).
- `npm audit` reports 5 high-severity findings in the lint toolchain (`braces` via `fast-glob` in `@next/eslint-plugin-next`); development-only. The automatic fix would downgrade `eslint-config-next`.
- npm warns that the install scripts of `esbuild` and `unrs-resolver` are not approved; build, lint and tests work without them.
- No CI pipeline yet.

## As of Phase 3 (2026-10-17)

### Implemented and verified
- **Environment configuration** (Phase 2): validated env module with feature gating, `.env.example`, `npm run env:check`, credential encryption library, log redaction. Covered by Vitest.
- **Database** (Phase 3): 12 migrations applied to the development project `rnqrqconfbcrmszllxgu` (verified via migration history; local files byte-identical to what was applied). 33 tables, RLS and explicit grants on all of them, 5 RPCs.
- **Database security tests**: 173 pgTAP assertions in `supabase/tests/database/`, all passing against the development project on 2026-10-17. They ran through the Supabase MCP connector, with each file wrapped so its TAP output came back in an error message and its transaction was always rolled back. They have **not** been run with `supabase test db` (CLI login and DB password not configured, no Docker). After the runs, the database held no test data (0 users, 0 organizations, 0 audit rows).
- Supabase advisors: no ERROR findings. Accepted findings are listed in database-design.md §6 and §8.
- Generated TypeScript types and a typed admin client (`src/lib/supabase/admin.ts`, not yet called by any route).

### Not implemented
- ~~No Next.js application yet.~~ Superseded: the application shell (Phase 4) and website (Phase 5) exist; workers still don't.
- Endpoint paths in `src/lib/config/endpoints.ts` are reserved, not implemented.
- No Storage bucket or storage policies yet (knowledge phase).
- No integrations, billing, model adapter, or embedding client. `requireFeature()` returning a config means only that credentials are present and well-formed.
- No scheduled jobs: approval expiry happens only when someone tries to decide, and retention purges (`execution_events`, webhook events, audit logs after 365 days) are not scheduled.
- Credential re-encryption job (key rotation step 3) is designed, not built.
- No CI pipeline yet; `npm test` and pgTAP are run manually.

### Credentials
- Configured locally: Supabase URL and publishable key only.
- Not configured: `SUPABASE_SECRET_KEY`, DB password / CLI login, and every optional provider (Anthropic, Voyage, Resend, Stripe, Google, Slack, HubSpot, Trigger.dev, Sentry, cron secret, encryption keyring).
- Connectivity checks for Anthropic, Resend, Stripe, and the Supabase secret key are untested against real credentials.
- OAuth scopes in the setup guide are the planned minimum and must be re-checked against provider docs when each adapter is built.

### Environment
- Docker is not installed on the dev machine → no local Supabase stack (ADR-010: the current project is the development database).
- GitHub CLI (`gh`) is not installed; git access works through the Git credential manager.
- Git identity is configured for this repository only.
- `npm install` warns that `esbuild`'s install script is not approved under npm's script policy; Vitest and tsx work without it.

### Unverified decisions
- Trigger.dev pricing/EU region (ADR-004).
- Pricing and plan quotas (plans seeded with `NULL` prices).
- Final MVP integration list.

### Known external constraints
- Gmail read scopes are **restricted**: Google OAuth verification plus a third-party security assessment is required before non-test users can connect.
- Slack requires HTTPS redirect URLs and event endpoints → local development needs a tunnel.
- Supabase default SMTP is rate-limited; custom SMTP (Resend) required before launch. Invitation acceptance requires confirmed emails.
- Legacy Supabase `anon`/`service_role` JWT keys are still enabled on the project.
- The development project is also the only project: create staging and production projects before real customer data exists.

## Integration verification log

| Integration | Contract tests | Live sandbox verified | Date | Notes |
|---|---|---|---|---|
| — | — | — | — | none yet |
