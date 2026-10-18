# Integration Architecture

## 1. Concepts

| Concept | Meaning |
|---|---|
| **Provider** | An external system (Google, Slack, HubSpot). Code: `modules/integrations/providers/<provider>/`. |
| **Connection** | One organization's authorized account at a provider (`integration_connections`). An org may have several per provider. |
| **Adapter** | Server-only code that turns typed tool inputs into provider API calls and normalizes responses/errors. |
| **Tool** | A typed capability exposed to employees and workflow nodes (`gmail.send`), implemented by an adapter. |
| **Trigger source** | Adapter code that turns provider webhooks or polling into normalized events. |

## 2. Provider module contract

```ts
interface IntegrationProvider {
  key: 'google' | 'slack' | 'hubspot' | 'webhook' | string
  displayName: string
  auth: OAuth2Config | ApiKeyConfig | NoAuth
  scopes: { tool: string; scopes: string[] }[]     // minimal scopes per tool
  tools: ToolDefinition[]                          // typed tools implemented here
  triggers?: TriggerSourceDefinition[]
  healthCheck(conn: ConnectionContext): Promise<HealthResult>
  verifyWebhook?(req: Request): Promise<VerifiedEvent | null>
}

interface ToolDefinition<I, O> {
  key: string                     // 'gmail.send'
  description: string             // shown to the model
  input: ZodType<I>
  output: ZodType<O>
  risk: 'read' | 'write_internal' | 'write_external' | 'sensitive'
  requiresConnection: string | null
  idempotent: boolean
  execute(ctx: ToolContext, input: I): Promise<O>
  redact?(input: I, output?: O): { input: unknown; output?: unknown }
}
```

## 3. OAuth flow

1. Admin clicks Connect → server route creates `state` (random, stored server-side with org id, user id, PKCE verifier, expiry) → redirect to provider.
2. Callback route verifies `state`, exchanges code server-side, encrypts the token set with `encryptCredential()` (AES-256-GCM, bound to org id + connection id, ADR-014), stores the envelope in `integration_connections.encrypted_credentials`, records granted scopes.
3. Token refresh happens in the adapter layer with a row lock to avoid refresh races; failures set `status = needs_reauth` and notify admins.
4. Disconnect revokes at provider (where supported), clears `encrypted_credentials`, marks connection `revoked`, disables dependent tool grants and triggers.

Tokens never reach the browser, logs, task events, or model context.

## 4. Inbound events

- Webhook endpoint per provider: verify signature (Slack signing secret, Google Pub/Sub push auth, HubSpot v3 signature) **before** parsing business data.
- Dedupe on `(provider, provider_event_id)`.
- Respond quickly; processing happens in `integration.webhook.process`.
- Polling fallback runs on schedules with cursors stored per connection.

## 5. Honesty and testing rules

- An adapter is **available** in the UI only after it passes the contract tests *and* a manual verification against a real sandbox/test account, recorded in [known-limitations.md](known-limitations.md) with date.
- Until then it is shown as "Coming soon" and its tools cannot be granted.
- Contract tests use recorded fixtures and must be labelled as such; they do not count as live verification.

## 6. MVP providers

| Provider | Tools | Triggers |
|---|---|---|
| Google (Gmail) | `gmail.search`, `gmail.read`, `gmail.draft`, `gmail.send` | new email (Pub/Sub watch or polling) |
| Google (Calendar) | `calendar.availability`, `calendar.create_event`, `calendar.list_events` | — (P1) |
| Slack | `slack.post_message`, `slack.read_channel` | message in channel / mention |
| HubSpot | `hubspot.contacts.search/get/create/update`, `hubspot.deals.search/update`, `hubspot.notes.create` | new contact (webhook) |
| Outbound webhook | `webhook.post` (to admin-configured URLs only; SSRF-protected) | inbound webhook trigger |

Note: Gmail restricted scopes require Google OAuth app verification (and possibly a security assessment) before public launch — see known limitations.
