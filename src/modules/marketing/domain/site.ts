// Public website structure: every page, the header and footer navigation, and
// the sitemap all come from this list, so a link can't point at a page that
// doesn't exist (tests/app/site-content.test.ts checks every route).

export interface PublicPage {
  path: string
  /** Used for the <title> and navigation. */
  title: string
  /** Meta description: one or two plain sentences. */
  description: string
  /** Draft legal pages and account entry points stay out of search engines. */
  indexable: boolean
}

export const PUBLIC_PAGES = {
  home: {
    path: '/',
    title: 'Supervised AI employees for your business',
    description:
      'Nexefiy is a platform, in development, for configuring AI employees, connecting them to your business apps, coordinating their work through workflows, and supervising what they do.',
    indexable: true,
  },
  employees: {
    path: '/ai-employees',
    title: 'AI employees',
    description:
      'How AI employees are configured in Nexefiy, which roles are planned first, and what each one needs your approval for.',
    indexable: true,
  },
  useCases: {
    path: '/use-cases',
    title: 'Use cases',
    description: 'Illustrative scenarios for sales, support, marketing, operations, analytics and voice work in Nexefiy.',
    indexable: true,
  },
  integrations: {
    path: '/integrations',
    title: 'Integrations',
    description:
      'The business apps Nexefiy plans to connect first, what an AI employee could do in each, and how connections are secured.',
    indexable: true,
  },
  security: {
    path: '/security',
    title: 'Security',
    description:
      'How Nexefiy separates each business’s data, protects connected-app credentials, and keeps people in control of AI actions.',
    indexable: true,
  },
  pricing: {
    path: '/pricing',
    title: 'Pricing',
    description: 'Nexefiy’s pricing isn’t set yet. Here is the plan structure we’re working toward.',
    indexable: true,
  },
  gettingStarted: {
    path: '/getting-started',
    title: 'Getting started',
    description: 'What you can do with Nexefiy today, and the setup steps that come next.',
    indexable: true,
  },
  contact: {
    path: '/contact',
    title: 'Contact',
    description: 'Ask about early access, the product, or security.',
    indexable: true,
  },
  signIn: {
    path: '/sign-in',
    title: 'Sign in',
    description: 'Sign in to your Nexefiy workspace.',
    indexable: false,
  },
  signUp: {
    path: '/sign-up',
    title: 'Create an account',
    description: 'Create a Nexefiy account.',
    indexable: false,
  },
  forgotPassword: {
    path: '/forgot-password',
    title: 'Reset your password',
    description: 'Get a link to choose a new password for your Nexefiy account.',
    indexable: false,
  },
  resetPassword: {
    path: '/reset-password',
    title: 'Choose a new password',
    description: 'Choose a new password for your Nexefiy account.',
    indexable: false,
  },
  invite: {
    path: '/invite',
    title: 'Join a workspace',
    description: 'Accept an invitation to a Nexefiy workspace.',
    indexable: false,
  },
  legal: {
    path: '/legal',
    title: 'Legal',
    description: 'Draft legal documents for Nexefiy. They are awaiting legal review and are not in effect.',
    indexable: false,
  },
  terms: {
    path: '/legal/terms',
    title: 'Terms of Service (draft)',
    description: 'Draft Terms of Service for Nexefiy, awaiting legal review. Not in effect.',
    indexable: false,
  },
  privacy: {
    path: '/legal/privacy',
    title: 'Privacy Policy (draft)',
    description: 'Draft Privacy Policy for Nexefiy, awaiting legal review. Not in effect.',
    indexable: false,
  },
  acceptableUse: {
    path: '/legal/acceptable-use',
    title: 'Acceptable Use Policy (draft)',
    description: 'Draft Acceptable Use Policy for Nexefiy, awaiting legal review. Not in effect.',
    indexable: false,
  },
} as const satisfies Record<string, PublicPage>

export type PublicPageKey = keyof typeof PUBLIC_PAGES

export interface SiteLink {
  label: string
  href: string
}

const link = (key: PublicPageKey, label?: string): SiteLink => ({
  label: label ?? PUBLIC_PAGES[key].title,
  href: PUBLIC_PAGES[key].path,
})

/** Main header navigation, in reading order. */
export const HEADER_NAV: readonly SiteLink[] = [
  link('employees'),
  link('useCases'),
  link('integrations'),
  link('security'),
  link('pricing'),
  link('gettingStarted'),
]

export const FOOTER_NAV: readonly { title: string; links: readonly SiteLink[] }[] = [
  {
    title: 'Product',
    links: [link('employees'), link('useCases'), link('integrations'), link('pricing')],
  },
  {
    title: 'Trust',
    links: [link('security'), link('gettingStarted'), link('contact')],
  },
  {
    title: 'Legal drafts',
    links: [
      link('terms', 'Terms of Service'),
      link('privacy', 'Privacy Policy'),
      link('acceptableUse', 'Acceptable Use'),
      link('legal', 'All legal drafts'),
    ],
  },
]

/** The one sentence every page agrees on about where the product stands. */
export const PRODUCT_STATUS =
  'Nexefiy is in early development. You can create an account and a workspace and invite your team; AI employees and app connections aren’t available yet. Features marked “Built” exist in the product today; everything else is planned.'

/** Where "Get early access" leads: the contact form with the topic chosen. */
export const EARLY_ACCESS_HREF = `${PUBLIC_PAGES.contact.path}?topic=early-access`

/** Matches a header link to the current path (a section and its sub-pages). */
export function isSiteLinkActive(href: string, pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0]!.replace(/(.)\/+$/, '$1')
  if (href === '/') return path === '/'
  return path === href || path.startsWith(`${href}/`)
}
