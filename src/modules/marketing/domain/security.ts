// Security statements for the public Security page. Same rules as
// capabilities.ts: `built` only for what exists and is tested in this
// repository. Never claim certifications, audits or hosting regions that
// haven't happened or been decided.

import type { CapabilityStatus } from './capabilities'

export interface SecurityMeasure {
  title: string
  description: string
  status: CapabilityStatus
}

export interface SecurityTopic {
  id: string
  title: string
  summary: string
  measures: readonly SecurityMeasure[]
}

export const SECURITY_TOPICS: readonly SecurityTopic[] = [
  {
    id: 'separation',
    title: 'Each business’s data is kept separate',
    summary: 'Separation is enforced by the database itself, so a bug in one screen can’t show another business’s data.',
    measures: [
      {
        title: 'Database-enforced workspace isolation',
        description:
          'Every table that holds business data has row-level security: the database only returns rows from workspaces the signed-in person belongs to.',
        status: 'built',
      },
      {
        title: 'Automated isolation tests',
        description:
          'Tests try to read and change another workspace’s data, escalate a role, and act while signed out, and check that each attempt is refused.',
        status: 'built',
      },
      {
        title: 'Four roles',
        description: 'Owner, admin, operator and viewer, each limited to what that role needs.',
        status: 'built',
      },
    ],
  },
  {
    id: 'control',
    title: 'People stay in control of AI actions',
    summary: 'What the AI suggests is never treated as permission to act.',
    measures: [
      {
        title: 'Server-side checks on every action',
        description:
          'Each action an AI employee proposes is re-checked against its workspace, the tools it was granted and your rules before anything runs.',
        status: 'first_release',
      },
      {
        title: 'Approval rules',
        description:
          'Each action runs automatically, needs approval, or is never allowed. Actions outside your business, like sending email, need approval by default.',
        status: 'first_release',
      },
      {
        title: 'Pause and spending limits',
        description: 'Stop an AI employee instantly and cap what each workspace can spend.',
        status: 'first_release',
      },
      {
        title: 'Activity and audit history',
        description:
          'An append-only record of security-relevant events. The storage exists; screens to review it are planned.',
        status: 'built',
      },
    ],
  },
  {
    id: 'credentials',
    title: 'Credentials and secrets are protected',
    summary: 'Keys to your connected apps and to our own services are handled as carefully as passwords.',
    measures: [
      {
        title: 'Encrypted connected-app credentials',
        description: 'Access tokens are encrypted with AES-256-GCM before storage, with support for rotating keys.',
        status: 'built',
      },
      {
        title: 'No secret keys in the browser',
        description:
          'Only public configuration reaches web pages, and an automated check scans every production build for leaked keys.',
        status: 'built',
      },
      {
        title: 'Secrets kept out of logs',
        description: 'Keys, tokens and authorization headers are removed before anything is written to logs.',
        status: 'built',
      },
    ],
  },
  {
    id: 'hardening',
    title: 'Before launch',
    summary: 'Work planned before Nexefiy is opened to customers.',
    measures: [
      {
        title: 'Rate limiting, security headers and error monitoring',
        description: 'Protection against abuse and faster detection of problems.',
        status: 'first_release',
      },
      {
        title: 'Data export and deletion',
        description: 'Ways for a business to export its data or have it deleted.',
        status: 'first_release',
      },
      {
        title: 'Independent security review',
        description: 'A security review of the platform before launch.',
        status: 'first_release',
      },
      {
        title: 'Single sign-on',
        description: 'Sign in through your company’s identity provider.',
        status: 'later',
      },
    ],
  },
]

/** Plain statements of what doesn't exist yet. */
export const SECURITY_NOT_YET: readonly string[] = [
  'Nexefiy holds no security certifications (such as SOC 2 or ISO 27001) and has not had an independent audit or penetration test.',
  'The hosting region for customer data hasn’t been decided.',
  'There is no public status page or service-level agreement yet.',
]
