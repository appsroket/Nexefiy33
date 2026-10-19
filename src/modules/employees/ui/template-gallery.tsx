'use client'

// The template gallery: every category's template with what it declares —
// purpose, required integrations (and whether this workspace has them
// connected), skills, permissions, risk, approvals, success criteria and
// limitations. Availability is computed from what is built; a template that
// needs something not built can't be used.

import { CircleCheck, CircleDashed } from 'lucide-react'

import { SectionCard } from '@/components/cards'
import { StatusIndicator } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { TEMPLATE_AVAILABILITY_DISPLAY, TEMPLATE_RISK_LABELS, type TemplateCard, type TemplateRisk } from '../domain/templates'
import { DEPARTMENT_LABELS } from '../domain/types'

const RISK_TONE: Record<TemplateRisk, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger' }

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (!items.length) return null
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export function TemplateGallery({ templates, pending, action, organizationId }: { templates: TemplateCard[]; pending: boolean; action: (formData: FormData) => void; organizationId: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {templates.map((template) => {
        const availability = TEMPLATE_AVAILABILITY_DISPLAY[template.availability]
        const usable = template.availability !== 'planned'
        return (
          <SectionCard
            key={template.key}
            title={template.name}
            description={
              <>
                <span className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{DEPARTMENT_LABELS[template.department]}</Badge>
                  <StatusIndicator tone={availability.tone} label={availability.label} />
                  <StatusIndicator tone={RISK_TONE[template.risk]} label={`${TEMPLATE_RISK_LABELS[template.risk]} risk`} />
                </span>
                <span className="block">{template.purpose}</span>
              </>
            }
            footer={
              usable ? (
                <form action={action}>
                  <input type="hidden" name="organizationId" value={organizationId} />
                  <input type="hidden" name="templateKey" value={template.key} />
                  <Button type="submit" variant="outline" disabled={pending}>
                    Use this template
                  </Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">{availability.description}</p>
              )
            }
          >
            <div className="flex flex-col gap-2 text-sm">
              {usable ? <List title="Can" items={template.capabilities} /> : null}
              <List title="Can’t yet" items={template.limitations} />
              <details className="group">
                <summary className="cursor-pointer font-medium underline-offset-4 hover:underline">Everything this template declares</summary>
                <div className="mt-2 flex flex-col gap-2">
                  {template.integrations.length ? (
                    <div>
                      <p className="font-medium">Required integrations</p>
                      <ul className="flex flex-col gap-1 text-muted-foreground">
                        {template.integrations.map((integration) => (
                          <li key={integration.name} className="flex gap-1.5">
                            {integration.built ? (
                              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                            ) : (
                              <CircleDashed className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                            )}
                            <span>
                              <span className="text-foreground">{integration.name}</span>
                              {integration.built ? '' : ' (not built)'}
                              {integration.connected === false ? ' — not connected in this workspace' : integration.connected ? ' — connected' : ''}
                              . {integration.evidence}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <List title="Skills" items={template.skills.map((skill) => (skill.available ? skill.name : `${skill.name} (not available yet)`))} />
                  <List
                    title="Permissions"
                    items={template.permissions.map((permission) => `${permission.title}${permission.approval ? ' — needs approval' : ' — read only'}`)}
                  />
                  <div>
                    <p className="font-medium">Risk</p>
                    <p className="text-muted-foreground">
                      {TEMPLATE_RISK_LABELS[template.risk]}: {template.riskReason}
                    </p>
                  </div>
                  <List title="Approvals" items={template.approvals.length ? template.approvals : ['None: it changes nothing outside Nexefiy']} />
                  <List title="Success criteria" items={template.successCriteria} />
                </div>
              </details>
            </div>
          </SectionCard>
        )
      })}
    </div>
  )
}
