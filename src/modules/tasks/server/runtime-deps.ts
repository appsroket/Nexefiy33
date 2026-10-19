// What the task runner needs, built from configuration. Free of Next.js
// imports so the execution engine's workers (trigger/) can use it too.

import 'server-only'

import { isFeatureConfigured } from '@/lib/env/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { canRunIntegrations, getIntegrationRuntime } from '@/modules/integrations/server/runtime'
import { getEmbedder } from '@/modules/knowledge/server/embeddings'
import { getModelGateway, isModelConfigured } from '@/modules/models/server/provider'

import type { TaskRuntimeDeps } from './runner'

/** Tasks need the Supabase secret key (the runtime records state) and a model. */
export function canRunTasks(): boolean {
  return isFeatureConfigured('supabaseAdmin') && isModelConfigured()
}

export function getTaskRuntimeDeps(): TaskRuntimeDeps {
  return {
    admin: getAdminClient(),
    gateway: getModelGateway(),
    integrations: canRunIntegrations() ? getIntegrationRuntime() : null,
    embedder: getEmbedder(),
  }
}
