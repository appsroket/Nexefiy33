// Primary navigation. Pure data and matching rules, shared by the sidebar,
// the command menu, page titles, and the "not available yet" pages.

/** Where the signed-in application lives; the public website owns "/". */
export const APP_HOME = '/app'

export type NavIcon =
  | 'overview'
  | 'employees'
  | 'workflows'
  | 'activity'
  | 'approvals'
  | 'knowledge'
  | 'integrations'
  | 'analytics'
  | 'settings'

/**
 * `available`: the page shows real data for the signed-in workspace.
 * `planned`: the page exists in navigation but its feature is not built yet;
 * it says so plainly instead of showing placeholder data.
 */
export type NavAvailability = 'available' | 'planned'

export interface NavItem {
  title: string
  href: string
  icon: NavIcon
  /** One sentence, written for nontechnical users. */
  description: string
  availability: NavAvailability
  keywords: readonly string[]
}

export interface NavSection {
  title: string
  items: readonly NavItem[]
}

export const NAVIGATION: readonly NavSection[] = [
  {
    title: 'Workspace',
    items: [
      {
        title: 'Overview',
        href: APP_HOME,
        icon: 'overview',
        description: 'Your workspace at a glance.',
        availability: 'available',
        keywords: ['home', 'dashboard', 'start'],
      },
      {
        title: 'AI employees',
        href: '/app/employees',
        icon: 'employees',
        description: 'Create AI employees, give them instructions and tools, and supervise their work.',
        availability: 'planned',
        keywords: ['agents', 'staff', 'team', 'assistants'],
      },
      {
        title: 'Workflows',
        href: '/app/workflows',
        icon: 'workflows',
        description: 'Combine steps and employees into a repeatable process.',
        availability: 'planned',
        keywords: ['automation', 'process', 'flows'],
      },
      {
        title: 'Activity',
        href: '/app/activity',
        icon: 'activity',
        description: 'Follow every task your AI employees run, step by step.',
        availability: 'planned',
        keywords: ['tasks', 'runs', 'history', 'log'],
      },
      {
        title: 'Approvals',
        href: '/app/approvals',
        icon: 'approvals',
        description: 'Actions your AI employees want to take that need a person to sign off.',
        availability: 'available',
        keywords: ['review', 'inbox', 'sign off', 'requests'],
      },
    ],
  },
  {
    title: 'Business',
    items: [
      {
        title: 'Knowledge',
        href: '/app/knowledge',
        icon: 'knowledge',
        description: 'Documents and business details your AI employees use to answer accurately.',
        availability: 'planned',
        keywords: ['documents', 'files', 'company', 'context'],
      },
      {
        title: 'Integrations',
        href: '/app/integrations',
        icon: 'integrations',
        description: 'Connect the business apps your AI employees work in, such as email, calendar and CRM.',
        availability: 'planned',
        keywords: ['apps', 'connections', 'gmail', 'slack', 'hubspot'],
      },
      {
        title: 'Analytics',
        href: '/app/analytics',
        icon: 'analytics',
        description: 'Measure the outcomes, time saved and costs of your AI workforce.',
        availability: 'planned',
        keywords: ['reports', 'metrics', 'outcomes', 'costs'],
      },
    ],
  },
  {
    title: 'Administration',
    items: [
      {
        title: 'Settings',
        href: '/app/settings',
        icon: 'settings',
        description: 'Workspace details, members, policies and billing.',
        availability: 'available',
        keywords: ['workspace', 'members', 'billing', 'preferences'],
      },
    ],
  },
]

export const NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((section) => section.items)

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || '/'
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Overview matches only APP_HOME; every other item matches itself and its sub-pages. */
export function isNavItemActive(item: Pick<NavItem, 'href'>, pathname: string): boolean {
  const path = normalize(pathname)
  if (item.href === APP_HOME) return path === APP_HOME
  return path === item.href || path.startsWith(`${item.href}/`)
}

/** The navigation item a page belongs to, or undefined (for example on a 404). */
export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.filter((item) => isNavItemActive(item, pathname)).sort((a, b) => b.href.length - a.href.length)[0]
}

export function getNavItem(href: string): NavItem {
  const item = NAV_ITEMS.find((candidate) => candidate.href === href)
  if (!item) throw new Error(`No navigation item for ${href}`)
  return item
}
