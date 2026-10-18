// Runs once when a server instance starts. Validates configuration so a
// misconfigured deployment fails at startup instead of on the first request.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { getEnvironment } = await import('@/lib/env/server')
  const { appEnv, features } = getEnvironment() // throws EnvValidationError on invalid core config

  const unavailable = Object.values(features)
    .filter((feature) => !feature.configured)
    .map((feature) => `${feature.label} (${feature.state.replace('_', ' ')})`)

  // Feature names and states only; never values.
  console.info(
    `[nexefiy] environment: ${appEnv}; ` +
      (unavailable.length ? `features off: ${unavailable.join(', ')}` : 'all features configured'),
  )
}
