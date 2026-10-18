// Server-side environment access. Importing this from a Client Component fails
// the build (`server-only`), which keeps secrets out of browser bundles.

import 'server-only'

import type { FeatureKey, OptionalFeatureKey } from './catalog'
import { parseEnvironment, type EnvironmentSnapshot, type FeatureStatus, type ServerEnv } from './core'
import { FeatureUnavailableError } from './errors'

let snapshot: EnvironmentSnapshot | undefined

/** Parsed once per process. Throws EnvValidationError if core configuration is invalid. */
export function getEnvironment(): EnvironmentSnapshot {
  snapshot ??= parseEnvironment(process.env)
  return snapshot
}

export function getServerEnv(): ServerEnv {
  return getEnvironment().env
}

export function getFeatureStatus(feature: FeatureKey): FeatureStatus {
  return getEnvironment().features[feature]
}

export function isFeatureConfigured(feature: OptionalFeatureKey): boolean {
  return getFeatureStatus(feature).configured
}

/**
 * Returns the feature's configuration or throws FeatureUnavailableError with
 * setup instructions. Call at the point of use (route handler, task), not at
 * module load, so a missing optional credential only affects its own feature.
 */
export function requireFeature<K extends OptionalFeatureKey>(feature: K): NonNullable<ServerEnv[K]> {
  const config = getServerEnv()[feature]
  if (!config) throw new FeatureUnavailableError(getFeatureStatus(feature))
  return config as NonNullable<ServerEnv[K]>
}

/** Test helper: forces the next call to re-read process.env. */
export function resetEnvironmentCache(): void {
  snapshot = undefined
}

export type { EnvironmentSnapshot, FeatureStatus, ServerEnv } from './core'
export { EnvValidationError, FeatureUnavailableError } from './errors'
