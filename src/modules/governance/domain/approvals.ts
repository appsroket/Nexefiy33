// Approval request list: which columns can be sorted and filtered. Pure.

import type { ListSpec } from '@/lib/list-params'
import { STATUS_DISPLAY } from '@/lib/status'

export const APPROVAL_STATUSES = Object.keys(STATUS_DISPLAY.approval) as (keyof typeof STATUS_DISPLAY.approval)[]

export type ApprovalSortColumn = 'created_at' | 'expires_at'

export const APPROVAL_LIST_SPEC = {
  sortable: ['created_at', 'expires_at'],
  defaultSort: { column: 'created_at', direction: 'desc' },
  filters: { status: APPROVAL_STATUSES },
  pageSize: 20,
} as const satisfies ListSpec<ApprovalSortColumn, 'status'>

/** Escapes LIKE wildcards so a search for "50%" matches the literal text. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
