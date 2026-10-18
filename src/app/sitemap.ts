import type { MetadataRoute } from 'next'

import { getServerEnv } from '@/lib/env/server'
import { PUBLIC_PAGES } from '@/modules/marketing/domain/site'

// Indexable public pages only: no drafts, account entry points or app routes.
export default function sitemap(): MetadataRoute.Sitemap {
  const { appUrl } = getServerEnv().core
  return Object.values(PUBLIC_PAGES)
    .filter((page) => page.indexable)
    .map((page) => ({ url: new URL(page.path, appUrl).toString() }))
}
