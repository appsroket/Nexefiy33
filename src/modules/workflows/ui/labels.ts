// Display helpers shared by the workflow builder's components. Zod-free.

import { Bot, Clock, Flag, GitBranch, Play, Plug, ShieldCheck, Shuffle, type LucideIcon } from 'lucide-react'

import type { NodeType } from '../domain/types'

export const SELECT_CLASS =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  trigger: Play,
  employee_task: Bot,
  tool_action: Plug,
  condition: GitBranch,
  approval: ShieldCheck,
  transform: Shuffle,
  delay: Clock,
  end: Flag,
}

/** A coloured stripe per step type (with the icon and label, so colour is never the only cue). */
export const NODE_ACCENT: Record<NodeType, string> = {
  trigger: 'border-l-info',
  employee_task: 'border-l-primary',
  tool_action: 'border-l-chart-2',
  condition: 'border-l-chart-4',
  approval: 'border-l-warning',
  transform: 'border-l-chart-3',
  delay: 'border-l-muted-foreground',
  end: 'border-l-success',
}

export const RISK_TEXT: Record<string, string> = {
  read: 'Reads data',
  write_internal: 'Changes data',
  write_external: 'Changes data or sends something',
  sensitive: 'Sensitive',
}

export const DECISION_TEXT: Record<string, string> = {
  allow: 'Runs without review',
  require_approval: 'Asks for approval each time',
  deny: 'Blocked',
  employee_grant: 'Under the employee’s own grant',
}
