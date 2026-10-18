// Convenience types over the generated schema (database.types.ts).

import type { Database } from './database.types'

export type { Database, Json } from './database.types'

type PublicSchema = Database['public']
export type TableName = keyof PublicSchema['Tables']

export type Row<T extends TableName> = PublicSchema['Tables'][T]['Row']
export type InsertRow<T extends TableName> = PublicSchema['Tables'][T]['Insert']
export type UpdateRow<T extends TableName> = PublicSchema['Tables'][T]['Update']

/** Mirrors the check constraint on organization_members.role and private.role_rank(). */
export const ORGANIZATION_ROLES = ['viewer', 'operator', 'admin', 'owner'] as const
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number]

export function hasMinRole(role: OrganizationRole, minimum: OrganizationRole): boolean {
  return ORGANIZATION_ROLES.indexOf(role) >= ORGANIZATION_ROLES.indexOf(minimum)
}
