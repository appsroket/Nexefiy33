// Database setup for the integration tests: each test gets its own copy of
// the migrated local database (CREATE DATABASE … TEMPLATE), loaded with the
// shared pgTAP fixture (two organizations, one user per role) plus an active
// "Sales Ops" employee with a current configuration and a HubSpot connection.
// Started by npm run db:test:local, which sets LOCAL_PG_HOST/PORT/TEMPLATE.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { buildTemplateDraft, EMPLOYEE_TEMPLATES } from '@/modules/employees/domain/templates'
import { listEmployeeTools } from '@/modules/employees/server/tools'
import { storeTokens } from '@/modules/integrations/server/credentials'

import { fakeToken, HUBSPOT_SCOPES, recordingFetch, testRuntime, type Responder } from '../helpers/integration-fixtures'
import { PgSupabase } from '../helpers/pg-supabase'

export const LOCAL_DB = process.env.LOCAL_PG_HOST
  ? { host: process.env.LOCAL_PG_HOST, port: Number(process.env.LOCAL_PG_PORT ?? 5432), template: process.env.LOCAL_PG_TEMPLATE ?? 'nexefiy' }
  : null

export const ORG = 'a1000000-0000-4000-8000-000000000000'
export const OTHER_ORG = 'b1000000-0000-4000-8000-000000000000'
export const OWNER = 'a0000000-0000-4000-8000-000000000001'
export const OPERATOR = 'a0000000-0000-4000-8000-000000000003'
export const VIEWER = 'a0000000-0000-4000-8000-000000000004'
export const OTHER_OWNER = 'b0000000-0000-4000-8000-000000000001'
export const EMPLOYEE = 'a2000000-0000-4000-8000-0000000000e1'
export const HUBSPOT = 'a4000000-0000-4000-8000-0000000000e1'
export const SEARCH_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts/search'
export const UPSERT_URL = 'https://api.hubapi.com/crm/objects/2026-09/contacts'

export interface TestDatabase {
  admin: PgSupabase
  as(userId: string): PgSupabase
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const FIXTURE = readFileSync(new URL('../../supabase/test-fixtures/two_organizations.sql', import.meta.url), 'utf8')

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!LOCAL_DB) throw new Error('LOCAL_PG_HOST is not set; run npm run db:test:local')
  const name = `it_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const server = new pg.Client({ host: LOCAL_DB.host, port: LOCAL_DB.port, user: 'postgres', database: 'postgres' })
  await server.connect()
  await server.query(`create database ${name} template ${LOCAL_DB.template}`)
  // Per-database settings are not copied from the template.
  await server.query(`alter database ${name} set search_path = "$user", public, extensions`)
  await server.end()

  const pool = new pg.Pool({ host: LOCAL_DB.host, port: LOCAL_DB.port, user: 'postgres', database: name, max: 6 })
  // Dropping the database at the end terminates any connection still open.
  pool.on('error', () => {})
  await pool.query(FIXTURE)
  const admin = new PgSupabase(pool)
  return {
    admin,
    as: (userId) => admin.as({ role: 'authenticated', userId }),
    sql: async (text, params = []) => (await pool.query(text, params)).rows,
    close: async () => {
      await pool.end()
      const cleanup = new pg.Client({ host: LOCAL_DB.host, port: LOCAL_DB.port, user: 'postgres', database: 'postgres' })
      await cleanup.connect()
      await cleanup.query(`drop database if exists ${name} with (force)`)
      await cleanup.end()
    },
  }
}

/** A connected HubSpot portal and an active employee whose current configuration grants it. */
export async function seedSalesEmployee(db: TestDatabase, routes: [string, Responder | Responder[]][], limits: Record<string, number> = {}) {
  await db.sql(
    `insert into public.integrations (id, organization_id, provider, display_name, status, external_account_id, external_account_label,
       granted_scopes, provider_metadata, health_status, connected_at)
     values ($1, $2, 'hubspot', 'example.hubspot.com', 'connected', '123456', 'example.hubspot.com', $3, '{"hubId": "123456"}', 'healthy', now())`,
    [HUBSPOT, ORG, HUBSPOT_SCOPES],
  )
  const recorder = recordingFetch(routes)
  const { runtime } = testRuntime(db.admin as never, recorder.fetch, { now: () => new Date() })
  await storeTokens(runtime, { id: HUBSPOT, organizationId: ORG }, { accessToken: fakeToken('access'), scopes: HUBSPOT_SCOPES })

  const draft = buildTemplateDraft(EMPLOYEE_TEMPLATES.find((template) => template.key === 'sales_operations')!, listEmployeeTools(), (provider) =>
    provider === 'hubspot' ? HUBSPOT : null,
  )
  const config = { ...draft.config, tools: draft.config.tools.filter((grant) => grant.integrationId === HUBSPOT || !grant.integrationId), limits: { ...draft.config.limits, ...limits } }
  await db.sql(`insert into public.ai_employees (id, organization_id, name, role_category) values ($1, $2, 'Sales Ops', 'sales')`, [EMPLOYEE, ORG])
  const [version] = await db.sql<{ id: string }>(
    `insert into public.employee_versions (organization_id, employee_id, instructions, config, config_schema_version)
     values ($1, $2, $3, $4, 2) returning id`,
    [ORG, EMPLOYEE, draft.instructions, JSON.stringify(config)],
  )
  await db.sql(
    `update public.ai_employees set current_version_id = $1, active_version_id = $1, status = 'active', activated_at = now() where id = $2`,
    [version!.id, EMPLOYEE],
  )
  for (const grant of config.tools) {
    await db.sql(
      `insert into public.employee_tool_permissions (organization_id, employee_id, tool_key, integration_id, decision) values ($1, $2, $3, $4, $5)`,
      [ORG, EMPLOYEE, grant.toolKey, grant.integrationId ?? null, grant.approval],
    )
  }
  return { runtime, requests: recorder.requests, versionId: version!.id, config }
}
