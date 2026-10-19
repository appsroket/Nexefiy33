// Read access to approval requests, under RLS with the user's session.
// Decisions go through approval-actions.ts (decide_approval RPC).

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

export interface ApprovalDetail extends ApprovalListItem {
  proposedAction: Record<string, unknown>
  payloadSha256: string
  decidedAt: string | null
  decisionNote: string | null
  /** Null for a workflow's approval step (kind "workflow_gate"). */
  toolExecutionId: string | null
  kind: 'tool_action' | 'workflow_gate'
  workflowRunId: string | null
}

export async function getApprovalRequest(organizationId: string, id: string): Promise<ApprovalDetail | null> {
  const supabase = await createUserClient()
  const { data, error } = await supabase
    .from('approval_requests')
    .select('id, action_summary, status, required_role, created_at, expires_at, proposed_action, payload_sha256, decided_at, decision_note, tool_execution_id, kind, workflow_run_id')
    .eq('organization_id', organizationId)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[governance] failed to load an approval request', redact(error))
    throw new ApprovalsUnavailableError('The approval request could not be loaded.')
  }
  if (!data) return null
  return {
    id: data.id,
    actionSummary: data.action_summary,
    status: data.status,
    requiredRole: data.required_role,
    createdAt: data.created_at,
    expiresAt: data.expires_at,
    proposedAction: (data.proposed_action ?? {}) as Record<string, unknown>,
    payloadSha256: data.payload_sha256,
    decidedAt: data.decided_at,
    decisionNote: data.decision_note,
    toolExecutionId: data.tool_execution_id,
    kind: data.kind === 'workflow_gate' ? 'workflow_gate' : 'tool_action',
    workflowRunId: data.workflow_run_id,
  }
}
