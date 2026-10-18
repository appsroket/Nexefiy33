# Nexefiy

Universal AI workforce and business operations platform: configure AI employees, connect business apps, coordinate work through workflows, and supervise execution with human approvals.

**Status:** Phase 6 — accounts and workspaces (sign-up, sign-in, invitations, roles, settings) on top of the public website, application shell and database. AI employees, integrations and workflows are not built yet, and nothing is deployed.

- Project instructions: [CLAUDE.md](CLAUDE.md)
- Specification and architecture: [docs/](docs/)
- Credentials: [inventory](docs/api-credentials.md) · [setup guide](docs/credential-setup.md) · [variable reference](docs/environment-variables.md)
- Database: [design](docs/database-design.md) · [operations](docs/supabase-setup.md)
- Roadmap: [docs/implementation-roadmap.md](docs/implementation-roadmap.md)

## Local setup

Requires Node.js ≥ 20.9 (developed on Node 24).

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in at least the core Supabase values ([setup guide](docs/credential-setup.md)).
3. Check configuration (prints no secrets): `npm run env:check`
4. Run tests: `npm test`, `npm run typecheck` and `npm run lint`
5. Start the dev server: `npm run dev`, then open http://localhost:3000 (website) or http://localhost:3000/app (application)
6. Production build and secret scan: `npm run build`, then `npm run check:bundle`
