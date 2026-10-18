import {
  Activity,
  BookOpen,
  Bot,
  ChartColumn,
  ClipboardCheck,
  LayoutDashboard,
  Plug,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

import type { NavIcon } from '../domain/navigation'

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  employees: Bot,
  workflows: Workflow,
  activity: Activity,
  approvals: ClipboardCheck,
  knowledge: BookOpen,
  integrations: Plug,
  analytics: ChartColumn,
  settings: Settings,
}
