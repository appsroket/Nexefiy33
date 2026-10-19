// What the builder and the validator know about a workspace: its employees
// (with the tools their active version grants), the integration actions
// Nexefiy has (with their input and output fields), and the workspace's
// connections. Read from the database for the organization the caller is a
// verified member of — never taken from the browser.

import 'server-only'

import { z } from 'zod'

import { redact } from '@/lib/logging/redact'
import type { Database } from '@/lib/supabase/database.types'
import { findAction } from '@/modules/integrations/connectors/registry'
import { listIntegrationToolActions } from '@/modules/integrations/server/catalog'

import type { BuilderContext, ToolOption } from '../domain/types'

import type { SupabaseClient } from '@supabase/supabase-js'

type Client = SupabaseClient<Database>

export class WorkflowDataError extends Error {
  override name = 'WorkflowDataError'
}

function fail(what: string, error: { code?: string }): never {
  console.error(`[workflows] loading ${what} failed`, redact({ code: error.code }))
  throw new WorkflowDataError(`We couldn’t load ${what}. Please try again.`)
}

interface JsonSchemaObject {
  properties?: Record<string, { type?: unknown; description?: unknown; format?: unknown; enum?: unknown }>
  required?: string[]
}

function topLevel(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaObject {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchemaObject
  } catch {
    return {}
  }
}

let cachedTools: ToolOption[] | null = null

/** Every integration action, with the fields a workflow step can map and the output fields later steps can use. */
export function listWorkflowTools(): ToolOption[] {
  cachedTools ??= listIntegrationToolActions().map((action) => {
    const input = topLevel(action.input, 'input')
    const found = findAction(action.key)
    const output = found ? topLevel(found.action.output, 'output') : {}
    return {
      key: action.key,
      title: `${action.providerName}: ${action.title}`,
      provider: action.provider,
      providerName: action.providerName,
      risk: action.risk,
      approval: action.approval,
      fields: Object.entries(input.properties ?? {}).map(([name, property]) => ({
        name,
        required: (input.required ?? []).includes(name),
        description: typeof property.description === 'string' ? property.description : '',
        type: Array.isArray(property.enum) ? `one of: ${property.enum.join(', ')}` : typeof property.type === 'string' ? property.type : 'value',
      })),
      outputFields: Object.keys(output.properties ?? {}),
    }
  })
  return cachedTools
}

export async function loadBuilderContext(client: Client, organizationId: string): Promise<BuilderContext> {
  const [employees, connections] = await Promise.all([
    client.from('ai_employees').select('id, name, status, active_version_id').eq('organization_id', organizationId).order('name').limit(200),
    client.from('integrations').select('id, provider, display_name, external_account_label, status').eq('organization_id', organizationId).order('display_name').limit(200),
  ])
  if (employees.error) fail('employees', employees.error)
  if (connections.error) fail('connections', connections.error)

  const versionIds = employees.data.map((row) => row.active_version_id).filter((id): id is string => Boolean(id))
  const versions = new Map<string, { version: number; toolKeys: string[] }>()
  if (versionIds.length) {
    const { data, error } = await client.from('employee_versions').select('id, version, config').eq('organization_id', organizationId).in('id', versionIds)
    if (error) fail('employee versions', error)
    for (const row of data) {
      const tools = ((row.config ?? {}) as { tools?: { toolKey?: unknown }[] }).tools
      versions.set(row.id, { version: row.version, toolKeys: Array.isArray(tools) ? tools.map((tool) => tool.toolKey).filter((key): key is string => typeof key === 'string') : [] })
    }
  }

  return {
    employees: employees.data.map((row) => {
      const version = row.active_version_id ? versions.get(row.active_version_id) : undefined
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        activeVersionId: row.active_version_id,
        activeVersion: version?.version ?? null,
        toolKeys: version?.toolKeys ?? [],
      }
    }),
    tools: listWorkflowTools(),
    connections: connections.data.map((row) => ({
      id: row.id,
      provider: row.provider,
      label: row.external_account_label ?? row.display_name ?? row.provider,
      status: row.status,
    })),
  }
}
