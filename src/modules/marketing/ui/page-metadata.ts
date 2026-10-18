import type { Metadata } from 'next'

import { PUBLIC_PAGES, type PublicPageKey } from '../domain/site'

/**
 * Title, description, canonical URL and social preview text for a public page.
 * Relative URLs resolve against `metadataBase` (the app URL) set in the root
 * layout. Pages that must stay out of search engines say so here; whether the
 * rest are indexed depends on the environment (src/app/(site)/layout.tsx).
 */
export function pageMetadata(key: PublicPageKey, options: { absoluteTitle?: string } = {}): Metadata {
  const page = PUBLIC_PAGES[key]
  return {
    title: options.absoluteTitle ? { absolute: options.absoluteTitle } : page.title,
    description: page.description,
    alternates: { canonical: page.path },
    openGraph: {
      type: 'website',
      siteName: 'Nexefiy',
      title: options.absoluteTitle ?? `${page.title} · Nexefiy`,
      description: page.description,
      url: page.path,
    },
    ...(page.indexable ? {} : { robots: { index: false, follow: true } }),
  }
}
