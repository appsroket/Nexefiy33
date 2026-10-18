// What Nexefiy can and can't do, stated once and reused on every public page.
//
// Rules for editing this file:
// - `built` only for things that exist in this repository and are covered by
//   automated tests. Say what is missing in the same sentence.
// - Everything else is `first_release` (in docs/mvp-scope.md) or `later`.
// - Move an item to `built` in the same change that ships and tests it.

export type CapabilityStatus = 'built' | 'first_release' | 'later'

export const CAPABILITY_STATUS: Record<
  CapabilityStatus,
  { label: string; tone: 'success' | 'info' | 'neutral'; description: string }
> = {
  built: {
    label: 'Built',
    tone: 'success',
    description:
      'Exists in Nexefiy today and is covered by automated tests.',
  },
  first_release: {
    label: 'Planned: first release',
    tone: 'info',
    description: 'In scope for the first customer release. Not built yet.',
  },
  later: {
    label: 'Planned: later',
    tone: 'neutral',
    description: 'On the roadmap after the first release. Not built yet, and details may change.',
  },
}

export const STATUS_ORDER: readonly CapabilityStatus[] = ['built', 'first_release', 'later']

export interface Capability {
  id: string
  title: string
  description: string
  status: CapabilityStatus
}

export type CapabilityArea = 'configure' | 'connect' | 'coordinate' | 'supervise' | 'platform'

export const CAPABILITY_AREAS: Record<CapabilityArea, { title: string; summary: string }> = {
  configure: {
    title: 'Configure AI employees',
    summary: 'Give each AI employee a role, instructions, your business knowledge, and the tools it may use.',
  },
  connect: {
    title: 'Connect your tools',
    summary: 'Link the apps your business already uses, so AI employees can work where your work happens.',
  },
  coordinate: {
    title: 'Coordinate workflows',
    summary: 'Turn repeatable work into workflows that hand tasks between AI employees and people.',
  },
  supervise: {
    title: 'Supervise execution',
    summary: 'Decide what needs your approval, see every step an AI employee took, and stop work at any time.',
  },
  platform: {
    title: 'Workspace and accounts',
    summary: 'A separate, private workspace for each business, with roles for everyone on the team.',
  },
}

export const CAPABILITIES: Record<CapabilityArea, readonly Capability[]> = {
  configure: [
    {
      id: 'employee-templates',
      title: 'AI employees from templates',
      description:
        'Start from a Customer Support, Sales Development or Executive Assistant template, or a blank employee, and adjust its instructions.',
      status: 'first_release',
    },
    {
      id: 'knowledge',
      title: 'Business knowledge with sources',
      description:
        'Describe your business and upload documents once; AI employees answer from them and show which document they used.',
      status: 'first_release',
    },
    {
      id: 'more-templates',
      title: 'More roles, including voice',
      description: 'Marketing, analytics, operations, finance admin, HR admin, research and voice employees.',
      status: 'later',
    },
  ],
  connect: [
    {
      id: 'credential-encryption',
      title: 'Encrypted storage for app connections',
      description:
        'Access tokens for connected apps are encrypted before they are stored, with support for rotating encryption keys. No app can be connected yet.',
      status: 'built',
    },
    {
      id: 'first-integrations',
      title: 'Gmail, Google Calendar, Slack, HubSpot and webhooks',
      description: 'The first apps planned for connection. Each is listed as available only after testing against a real account.',
      status: 'first_release',
    },
    {
      id: 'more-integrations',
      title: 'More business apps',
      description: 'Other email, helpdesk, accounting and telephony tools. No providers have been chosen yet.',
      status: 'later',
    },
  ],
  coordinate: [
    {
      id: 'workflows',
      title: 'Workflows from a description',
      description:
        'Describe a process in plain language to get a draft workflow, then adjust it in a visual editor before publishing.',
      status: 'first_release',
    },
    {
      id: 'triggers',
      title: 'Start work on a schedule or an event',
      description: 'Run a workflow manually, on a schedule, when an email or CRM contact arrives, or from a webhook.',
      status: 'first_release',
    },
    {
      id: 'advanced-workflows',
      title: 'Parallel steps, loops and sub-workflows',
      description: 'More complex workflow building blocks and a dry-run mode.',
      status: 'later',
    },
  ],
  supervise: [
    {
      id: 'approvals-list',
      title: 'Approvals list',
      description:
        'A list of actions waiting for a person’s sign-off, with search and filters. Approving or rejecting from it is not built yet.',
      status: 'built',
    },
    {
      id: 'approval-decisions',
      title: 'Approval rules and decisions',
      description:
        'Choose which actions run automatically, which need approval and which are never allowed. Actions outside your business, like sending email, need approval by default.',
      status: 'first_release',
    },
    {
      id: 'activity',
      title: 'Step-by-step activity and controls',
      description: 'See each step an AI employee took and why, pause an employee instantly, and set spending limits.',
      status: 'first_release',
    },
    {
      id: 'outcomes',
      title: 'Outcome reporting',
      description: 'A dashboard of tasks completed, success rate, approvals and cost per AI employee.',
      status: 'first_release',
    },
  ],
  platform: [
    {
      id: 'workspace-isolation',
      title: 'Private workspaces with roles',
      description:
        'Each business’s data is kept separate by the database itself, and four roles (owner, admin, operator, viewer) control who can see and change what.',
      status: 'built',
    },
    {
      id: 'workspace-interface',
      title: 'Workspace interface',
      description:
        'Navigation, workspace switching, workspace settings and approval notifications for signed-in members.',
      status: 'built',
    },
    {
      id: 'accounts',
      title: 'Sign-up, sign-in and team invitations',
      description:
        'Email and password sign-in with email confirmation and password reset, creating workspaces, and inviting your team with a role.',
      status: 'built',
    },
    {
      id: 'billing',
      title: 'Plans and billing',
      description: 'A free trial and paid plans. Prices and limits haven’t been decided.',
      status: 'first_release',
    },
    {
      id: 'sso',
      title: 'Single sign-on and custom roles',
      description: 'For larger teams.',
      status: 'later',
    },
  ],
}

export const ALL_CAPABILITIES: readonly Capability[] = Object.values(CAPABILITIES).flat()

export function capabilitiesWithStatus(status: CapabilityStatus): Capability[] {
  return ALL_CAPABILITIES.filter((capability) => capability.status === status)
}
