// Real record counts for the overview page, read under RLS with the user's
// session. When the employees, workflows and integrations modules exist,
// these counts move behind their public server services.

import 'server-only'

import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'

import { ShellDataError } from './shell-context'

export interface WorkspaceSummary {
  employees: number
  workflows: number
  connectedApps: number
}

export async function getWorkspaceSummary(organizationId: string): Promise<WorkspaceSummary> {
  const supabase = await createUserClient()
  const [employees, workflows, connectedApps] = await Promise.all([
    supabase
      .from('ai_employees')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .neq('status', 'archived'),
    supabase
      .from('workflow_definitions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .neq('status', 'archived'),
    supabase
      .from('integrations')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'connected'),
  ])

  for (const result of [employees, workflows, connectedApps]) {
    if (result.error) {
      console.error('[app-shell] failed to load workspace summary', redact(result.error))
      throw new ShellDataError('We couldn’t load your workspace summary. Please try again in a moment.')
    }
  }
  return {
    employees: employees.count ?? 0,
    workflows: workflows.count ?? 0,
    connectedApps: connectedApps.count ?? 0,
  }
}
