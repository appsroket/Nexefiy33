// What the orchestrator needs, built from configuration. Free of Next.js
// imports so the execution engine's workers (trigger/) can use it too.

import 'server-only'

import { isFeatureConfigured } from '@/lib/env/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { canRunIntegrations, getIntegrationRuntime } from '@/modules/integrations/server/runtime'

import type { WorkflowRuntimeDeps } from './orchestrator'

/** Advancing runs needs only the Supabase secret key; employee steps also need a model (the task runtime). */
export function canRunWorkflows(): boolean {
  return isFeatureConfigured('supabaseAdmin')
}

export function getWorkflowRuntimeDeps(): WorkflowRuntimeDeps {
  return { admin: getAdminClient(), integrations: canRunIntegrations() ? getIntegrationRuntime() : null }
}
