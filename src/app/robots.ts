import type { MetadataRoute } from 'next'

import { getServerEnv } from '@/lib/env/server'
import { APP_HOME } from '@/modules/app-shell/domain/navigation'

// Production: crawl the public website, not the application. Every other
// environment (preview, development) asks crawlers to stay away entirely.
export default function robots(): MetadataRoute.Robots {
  const { appEnv, core } = getServerEnv()
  if (appEnv !== 'production') return { rules: { userAgent: '*', disallow: '/' } }
  return {
    rules: { userAgent: '*', allow: '/', disallow: [APP_HOME, '/legal'] },
    sitemap: new URL('/sitemap.xml', core.appUrl).toString(),
  }
}
