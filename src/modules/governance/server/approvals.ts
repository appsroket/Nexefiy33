// Read-only access to approval requests, under RLS with the user's session.
// Deciding requests (decide_approval RPC) arrives with the approvals feature.

import 'server-only'

import type { ListState } from '@/lib/list-params'
import { redact } from '@/lib/logging/redact'
import { createUserClient } from '@/lib/supabase/server'

import { escapeLikePattern, type ApprovalSortColumn } from '../domain/approvals'

export interface ApprovalListItem {
  id: string
  actionSummary: string
  status: string
  requiredRole: string
  createdAt: string
  expiresAt: string
}

export class ApprovalsUnavailableError extends Error {
  override name = 'ApprovalsUnavailableError'
}

export async function listApprovalRequests(
  organizationId: string,
  list: ListState<ApprovalSortColumn, 'status'>,
): Promise<{ items: ApprovalListItem[]; total: number }> {
  const supabase = await createUserClient()
  let query = supabase
    .from('approval_requests')
    .select('id, action_summary, status, required_role, created_at, expires_at', { count: 'exact' })
    .eq('organization_id', organizationId)

  if (list.filters.status) query = query.eq('status', list.filters.status)
  if (list.q) query = query.ilike('action_summary', `%${escapeLikePattern(list.q)}%`)

  const { data, count, error } = await query
    .order(list.sort.column, { ascending: list.sort.direction === 'asc' })
    .order('id')
    .range(list.from, list.to)

  if (error) {
    console.error('[governance] failed to list approval requests', redact(error))
    throw new ApprovalsUnavailableError('Approval requests could not be loaded.')
  }

  return {
    total: count ?? data.length,
    items: data.map((row) => ({
      id: row.id,
      actionSummary: row.action_summary,
      status: row.status,
      requiredRole: row.required_role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })),
  }
}
