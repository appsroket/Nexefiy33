# Integration Architecture

Status (Phase 8, 2026-10-18): the framework and two connectors — **HubSpot** (CRM) and **Slack** (communication) — are built and tested against documented provider behaviour. They have **not yet been exercised against a live HubSpot or Slack account**; see §7 and [known-limitations.md](known-limitations.md). ADR-023 records the decisions.

## 1. Concepts

| Concept | Meaning | Code |
|---|---|---|
| **Connector** | Declaration of one provider: authentication, scopes, rate limits, health check, error normalization, actions. | `src/modules/integrations/connectors/<provider>.ts`, registry in `connectors/registry.ts` |
| **Action** | One typed operation (`hubspot.contacts.upsert`). Also the tool key AI employees and workflows will use. | declared inside its connector |
| **Connection** | One organization's authorized account at a provider (`integrations` row + encrypted tokens in `integration_secrets`). | `server/oauth.ts`, `server/connections.ts` |
| **Action setting** | Per connection and action: enabled, approval mode (`integration_actions`). | seeded on connect; admins change it |
| **Execution** | One requested run of an action (`tasks` + `tool_executions`, approval in `approval_requests`). | `server/executor.ts` |

## 2. What every connector declares

`ConnectorDefinition` / `ActionDefinition` in `connectors/types.ts`:

| Requirement | Where |
|---|---|
| Provider | `provider`, `displayName`, `category`, `docsUrl` |
| Supported actions | `actions[]` |
| Input and output schemas | `action.input` / `action.output` (Zod; inputs validated on the server before anything is recorded, outputs validated before they are stored) |
| Authentication requirements | `auth` (OAuth 2.0 authorization code: authorize URL, scope separator, code exchange, refresh, revocation) and `feature` (the env feature holding the client credentials) |
| Required scopes | `auth.baseScopes` + each `action.scopes`; a connection asks for exactly their union, and an action refuses to run unless its scopes were granted |
| Risk classification | `action.risk`: `read`, `write_internal`, `write_external`, `sensitive` |
| Rate limits | `rateLimits` by bucket (with the provider source of each number) and `action.rateLimitBucket`; requests can name extra buckets (e.g. Slack's per-channel limit) |
| Timeout and retry behavior | `requestTimeoutMs`, `action.timeoutMs` (per attempt), `action.retry` (attempts, backoff, cap) |
| Idempotency strategy | `action.idempotency`: `read_only`, `natural_key` (provider deduplicates, e.g. contact email), `not_idempotent` (never resent once it may have arrived) |
| Approval requirements | `action.approval`: `none`, `default_required` (admins may relax per connection), `always` |
| Error normalization | `normalizeError(response)` → `IntegrationError` with a code from `domain/errors.ts` |

Health checks (`healthCheck`) and token revocation (`auth.revoke`) are part of the declaration too.

## 3. Built connectors

| Action | Risk | Approval by default | Scopes | Idempotency |
|---|---|---|---|---|
| `hubspot.contacts.search` — find by exact email or text | read | no | `crm.objects.contacts.read` | read only |
| `hubspot.contacts.upsert` — create, or update the contact with the same email (only given fields) | write_external | yes | contacts read + write | natural key: email (409 race handled by updating the named existing contact) |
| `hubspot.notes.create` — add a plain-text note to a contact (association type 202) | write_external | yes | `crm.objects.contacts.write` | not idempotent |
| `slack.channels.list` — public channels, membership | read | no | `channels:read` | read only |
| `slack.messages.post` — plain text to a channel or thread; `<`, `>`, `&` escaped so text can't ping @channel or disguise links; no unfurling | write_external | yes | `chat:write` | not idempotent |

HubSpot uses date-versioned endpoints (OAuth `2026-03`, CRM `2026-09`); Slack uses the Web API with bot tokens (token rotation supported when enabled on the app). Provider documentation was checked on 2026-10-18; each connector file lists what was checked and what is least certain.

These two were chosen for the first workflow ("new lead → create or update the HubSpot contact, add a note, tell the sales channel in Slack"): both offer free test accounts, and neither needs a provider security review before testing (Gmail's restricted scopes do).

## 4. Connecting, refreshing, disconnecting

1. **Connect** (admins): the `startConnection` Server Action (origin-checked by Next.js) creates a random state, stores only its SHA-256 in `integration_oauth_states` (bound to organization, user, provider, 10-minute expiry), and redirects to the provider.
2. **Callback** `/api/integrations/<provider>/callback`: verifies the session, re-checks the user is still an admin of the state's organization, consumes the state exactly once, exchanges the code server-side, identifies the account (HubSpot token introspection; Slack `team`/`enterprise`), encrypts the token set with `encryptCredential()` (bound to organization + connection + purpose, ADR-014), records the connection and seeds one `integration_actions` row per action with its declared default. Reconnecting must authorize the same account.
3. **Tokens** are decrypted only in memory for a provider call. Before expiry (2-minute margin) they are renewed under a short lease on the secret row (`refresh_lease_until`), so two servers never refresh at once (Slack rotation invalidates the old refresh token). A token the provider rejects gets one forced renewal; if that fails the connection becomes `needs_reauth`.
4. **Health** (`Check connection`, and the cron route every 6 hours): HubSpot reads one contact; Slack calls `auth.test` (and records the scopes Slack reports). Revoked tokens → `needs_reauth`; outages → `degraded`.
5. **Disconnect** (admins): revokes at the provider (HubSpot refresh-token revoke; Slack `auth.revoke`, which must confirm `revoked: true`), deletes `integration_secrets`, marks the connection `revoked` (kept for history), cancels its pending executions and approval requests, and writes an audit event. If the provider can't confirm revocation the connection is still disconnected locally and the result says so.

Tokens never reach the browser, logs, execution records, audit metadata or model context.

## 5. Running an action

`requestAction` (server only) checks, in order: the action exists; the caller's role is operator or above (organization and role come from the verified session, never the request body); the input passes the schema; the connection belongs to the organization, is connected, is for the action's provider and holds the scopes; the action is enabled; the decision — the strictest of the connection setting, the declared requirement and enabled organization policies (`domain/policy.ts`). Then it records a task and a tool execution under the caller's idempotency key (a repeated key returns the first result).

- **deny** → recorded as skipped; nothing sent.
- **require_approval** → `approval_requests` row with the exact input (approvers see what will be sent) and its fingerprint (`input_sha256`, SHA-256 of canonical JSON of action + connection + input); approver role is admin for external writes. The exact input waits in `tool_executions.pending_input`, which clients cannot read and which can be cleared but never replaced. After approval (`decide_approval`, which refuses a changed fingerprint), the execution is claimed (`claim_tool_executions`) by the after-approval nudge or `/api/cron/integrations`.
- **allow** → runs now.

Running re-checks the connection, scopes, setting/policy and the fingerprint, so an approval doesn't survive a disconnect or a changed payload. Each attempt has a deadline; every provider request is first counted in the shared Postgres rate-limit windows (`consume_integration_rate_limit`) and refused locally when a window is full. Retries follow `domain/retry.ts`: transient errors only, within the attempt budget, honouring Retry-After; a non-idempotent action is retried only when the provider certainly didn't receive it (429 or a connection that failed before sending). A timed-out non-idempotent action, or one recovered after its server stopped, ends as `outcome_unknown` instead of being resent.

## 6. Inbound events (not built)

Webhook endpoints (`/api/webhooks/slack`, `/api/webhooks/hubspot`), signature verification and event triggers arrive with workflow triggers. Until then the connectors are action-only.

## 7. Honesty and testing rules

- An integration is **available** on the public website only after contract tests *and* a manual check against a real test account, recorded in [known-limitations.md](known-limitations.md) with the date. HubSpot and Slack remain `first_release` on the website until then.
- Contract tests (`tests/integrations/connectors.test.ts`) use responses written from provider documentation and are labelled as such; they do not count as live verification.

### Live verification checklist (controlled environment)

Needs: a HubSpot developer test account and a Slack development workspace; apps set up as in [credential-setup.md](credential-setup.md#e3-slack); on the deployment (e.g. the Vercel preview): `HUBSPOT_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET/SIGNING_SECRET`, `INTEGRATION_ENCRYPTION_KEYS` + `INTEGRATION_ENCRYPTION_ACTIVE_KEY_ID`, `SUPABASE_SECRET_KEY`, and the redirect URLs registered for that deployment's URL. Then, signed in as a workspace admin:

1. Integrations → Connect HubSpot → approve → the connection page shows Connected, Healthy, granted scopes.
2. Test an action: `hubspot.contacts.search` with a test email → real result.
3. `hubspot.contacts.upsert` → "needs approval" → Approvals → open → Approve and run → contact appears in HubSpot; run again → `updated`, no duplicate.
4. `hubspot.notes.create` on that contact (approve) → note on the contact timeline.
5. Connect Slack, `/invite` the app to a test channel, `slack.channels.list`, then `slack.messages.post` (approve) → message appears; text with `<!channel>` shows literally.
6. Check connection on both.
7. Disconnect both → provider shows the app's access removed; `integration_secrets` has no rows for them; a queued approval for them is cancelled; running an action is refused.
8. Record the date and results in known-limitations.md; only then may the website status change.
