// Paths that external providers call back into. Registered in provider
// dashboards, so changing one requires updating every environment's
// configuration (see docs/credential-setup.md#urls-to-register-with-providers).

export const PROVIDER_ENDPOINTS = [
  { provider: 'Supabase Auth', kind: 'auth redirect', path: '/auth/callback' },
  { provider: 'Google', kind: 'OAuth redirect URI', path: '/api/integrations/google/callback' },
  { provider: 'Google', kind: 'Gmail push (Pub/Sub)', path: '/api/webhooks/google' },
  { provider: 'Slack', kind: 'OAuth redirect URL', path: '/api/integrations/slack/callback' },
  { provider: 'Slack', kind: 'Event Subscriptions request URL', path: '/api/webhooks/slack' },
  { provider: 'HubSpot', kind: 'OAuth redirect URL', path: '/api/integrations/hubspot/callback' },
  { provider: 'HubSpot', kind: 'webhook target URL', path: '/api/webhooks/hubspot' },
  { provider: 'Stripe', kind: 'webhook endpoint', path: '/api/webhooks/stripe' },
  { provider: 'Vercel Cron', kind: 'cron job path prefix', path: '/api/cron/' },
] as const

export function absoluteUrl(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, '')}${path}`
}
