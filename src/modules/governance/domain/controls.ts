// Small shared rules of the governance controls. Zod-free: client components import it.

/** Typed to confirm a workspace emergency stop. */
export const EMERGENCY_STOP_CONFIRMATION = 'STOP'

/** Retention bounds in days (the database enforces the same: organization_governance). */
export const RETENTION_BOUNDS = { min: 30, max: 3650 } as const

export interface HandoffControls {
  /** A person may take the task over (unfinished, not running, not already taken). */
  takeOver: boolean
  /** The viewer may complete the task they (or, for admins, anyone) took over. */
  complete: boolean
}

export function handoffControls(task: {
  status: string
  handedOffTo: string | null
  handedOffAt: string | null
  viewerId: string
  viewerRole: 'owner' | 'admin' | 'operator' | 'viewer'
  isEmployeeTask: boolean
}): HandoffControls {
  const operator = task.viewerRole !== 'viewer'
  const admin = task.viewerRole === 'owner' || task.viewerRole === 'admin'
  return {
    takeOver: operator && task.isEmployeeTask && !task.handedOffAt && ['pending', 'queued', 'waiting_approval', 'blocked', 'paused'].includes(task.status),
    complete: !!task.handedOffAt && task.status === 'blocked' && (task.handedOffTo === task.viewerId || admin),
  }
}
