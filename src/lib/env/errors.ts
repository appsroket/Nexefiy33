import type { FeatureStatus } from './core'

export interface EnvIssue {
  variable?: string
  message: string
}

/** The core configuration is missing or invalid; the application cannot start. */
export class EnvValidationError extends Error {
  override name = 'EnvValidationError'

  constructor(
    readonly issues: EnvIssue[],
    readonly appEnv: string,
  ) {
    super(
      [
        `Nexefiy environment configuration is invalid (${appEnv}):`,
        ...issues.map((issue) => `  - ${issue.message}`),
        '',
        'Local: add the values to .env.local (template: .env.example).',
        'Vercel: Project → Settings → Environment Variables, then redeploy.',
        'Setup guide: docs/credential-setup.md · Check with: npm run env:check',
      ].join('\n'),
    )
  }
}

/** A feature was used whose credentials are not configured. */
export class FeatureUnavailableError extends Error {
  override name = 'FeatureUnavailableError'

  constructor(readonly status: FeatureStatus) {
    super(describeUnavailable(status))
  }
}

function describeUnavailable(status: FeatureStatus): string {
  const reasons: string[] = []
  if (status.missing.length) reasons.push(`missing ${status.missing.join(', ')}`)
  for (const issue of status.issues) reasons.push(issue.message)
  if (status.blockedBy.length) reasons.push(`requires ${status.blockedBy.join(', ')} to be configured first`)
  const reason = reasons.length ? reasons.join('; ') : 'not configured'
  return `${status.label} is unavailable: ${reason}. Setup guide: ${status.guide}`
}
