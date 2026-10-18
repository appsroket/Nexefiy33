// A simplified rendering of the real workspace interface. The navigation comes
// from the app's own navigation data, so "Soon" markers always match what is
// built; the approval rows are labelled example data.

import { StatusBadge } from '@/components/status-badge'
import type { OrganizationRole } from '@/lib/supabase/types'
import { cn } from '@/lib/utils'
import { NAVIGATION } from '@/modules/app-shell/domain/navigation'
import { roleLabel } from '@/modules/app-shell/domain/workspace'

interface ExampleApproval {
  request: string
  status: 'pending' | 'approved' | 'rejected'
  role: OrganizationRole
  requested: string
}

const EXAMPLE_APPROVALS: readonly ExampleApproval[] = [
  { request: 'Send a reply to a customer asking about delivery times', status: 'pending', role: 'operator', requested: '4 min ago' },
  { request: 'Create a meeting with a new lead for Thursday at 10:00', status: 'pending', role: 'operator', requested: '18 min ago' },
  { request: 'Update a deal stage in the CRM', status: 'approved', role: 'admin', requested: '1 hr ago' },
  { request: 'Send a discount offer to a customer', status: 'rejected', role: 'admin', requested: 'Yesterday' },
]

export function ProductPreview({ className }: { className?: string }) {
  return (
    <figure className={cn('flex flex-col gap-3', className)}>
      <div
        aria-hidden="true"
        inert
        className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg shadow-primary/5"
      >
        <div className="flex items-center gap-1.5 border-b bg-muted/50 px-3 py-2">
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          <span className="size-2.5 rounded-full bg-muted-foreground/30" />
          <span className="ml-3 text-xs text-muted-foreground">Example Workspace · Approvals</span>
        </div>
        <div className="grid xl:grid-cols-[10rem_1fr]">
          <div className="hidden flex-col gap-3 border-r bg-muted/30 p-3 text-xs xl:flex">
            {NAVIGATION.map((section) => (
              <div key={section.title} className="flex flex-col gap-1">
                <span className="px-2 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
                  {section.title}
                </span>
                {section.items.map((item) => (
                  <span
                    key={item.href}
                    className={cn(
                      'flex items-center justify-between rounded-md px-2 py-1',
                      item.title === 'Approvals' ? 'bg-background font-medium shadow-xs' : 'text-muted-foreground',
                    )}
                  >
                    {item.title}
                    {item.availability === 'planned' ? (
                      <span className="rounded border px-1 text-[0.6rem] text-muted-foreground">Soon</span>
                    ) : null}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-base font-semibold">Approvals</span>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[0.65rem] font-medium">Example data</span>
            </div>
            <div className="overflow-hidden rounded-lg border text-xs">
              <div className="grid grid-cols-[1fr_auto] gap-3 border-b bg-muted/50 px-3 py-2 font-medium text-muted-foreground">
                <span>Request</span>
                <span>Status</span>
              </div>
              {EXAMPLE_APPROVALS.map((row) => (
                <div key={row.request} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
                  <span className="flex min-w-[8rem] flex-col gap-0.5">
                    <span className="line-clamp-2">{row.request}</span>
                    <span className="text-muted-foreground">
                      {row.requested} · {roleLabel(row.role)} or above can decide
                    </span>
                  </span>
                  <StatusBadge kind="approval" status={row.status} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="text-sm text-pretty text-muted-foreground">
        A simplified view of the Nexefiy workspace as it’s built today, filled with example data. The approvals list
        exists; the AI employees that would create these requests, and approving from this screen, are planned. Sections
        marked “Soon” aren’t built yet.
      </figcaption>
    </figure>
  )
}
