// How actions are classified: category → risk tier → who approves, who can
// waive approval, whether the requester may approve, how long an approval
// lasts. Categories without a connector yet say so.

import { StatusIndicator } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'

import { ACTION_CATEGORIES, ACTION_CATEGORY_INFO, RISK_TIER_INFO } from '../domain/risk'

const ROLE: Record<string, string> = { operator: 'Operator', admin: 'Admin', owner: 'Owner' }

export function RiskTable({ actions }: { actions: readonly { key: string; title: string; category: string }[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Action categories and the approval rules for each risk tier</caption>
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="py-2 pr-3 font-medium">Category</th>
              <th scope="col" className="py-2 pr-3 font-medium">Risk</th>
              <th scope="col" className="py-2 pr-3 font-medium">Approval</th>
              <th scope="col" className="py-2 pr-3 font-medium">Approver</th>
              <th scope="col" className="py-2 pr-3 font-medium">Can waive approval</th>
              <th scope="col" className="py-2 font-medium">Actions here</th>
            </tr>
          </thead>
          <tbody>
            {ACTION_CATEGORIES.map((category) => {
              const info = ACTION_CATEGORY_INFO[category]
              const tier = RISK_TIER_INFO[info.tier]
              const here = actions.filter((action) => action.category === category)
              return (
                <tr key={category} className="border-b align-top last:border-0">
                  <td className="py-2 pr-3">
                    <p className="font-medium">{info.label}</p>
                    <p className="text-muted-foreground">{info.description}</p>
                    <p className="text-muted-foreground">e.g. {info.examples.join('; ')}</p>
                  </td>
                  <td className="py-2 pr-3">
                    <StatusIndicator tone={tier.tone} label={tier.label} />
                  </td>
                  <td className="py-2 pr-3">{tier.consequential ? 'Required unless a policy permits it' : 'Not required'}</td>
                  <td className="py-2 pr-3">
                    {ROLE[tier.approverRole]} or above
                    {tier.separateApprover ? <span className="block text-muted-foreground">Not the requester</span> : null}
                    <span className="block text-muted-foreground">Valid {tier.maxApprovalHours} h</span>
                  </td>
                  <td className="py-2 pr-3">{tier.consequential ? `A policy saved by ${tier.authorizerRole === 'owner' ? 'an owner' : 'an admin or owner'}, naming the action` : '—'}</td>
                  <td className="py-2">
                    {here.length ? (
                      <span className="flex flex-wrap gap-1">
                        {here.map((action) => (
                          <Badge key={action.key} variant="outline" title={action.key}>
                            {action.title}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{info.available ? 'None' : 'No connector yet'}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        Policies can only make these stricter, except that an admin (or, for critical actions, an owner) can explicitly let a named action run without approval. An action’s own
        “always needs approval” rule and an employee’s own approval rule are never waived.
      </p>
    </div>
  )
}
