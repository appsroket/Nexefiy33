import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Cache Components stays off for now: every authenticated page is rendered
  // per request so tenant data never lands in a shared cache (ADR-018).
}

export default nextConfig
