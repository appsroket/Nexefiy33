// Drafting a workflow from a description without an AI model: keyword rules
// pick a trigger, one employee step, an optional condition, approval and
// delay, and the actions the description names. The result is labelled as
// drafted by rules, uses only what the workspace has, and is a starting point
// for the editor — never activated without review. Pure and Zod-free.

import { DEFAULT_RETRY, DEFAULT_SETTINGS } from './factory'
import type { BuilderContext, WorkflowDefinition, WorkflowEdge, WorkflowInput, WorkflowNode } from './types'

export interface WorkflowDraft {
  name: string
  description: string
  definition: WorkflowDefinition
  notes: string[]
  unsupported: string[]
}

const UNSUPPORTED: { pattern: RegExp; message: string }[] = [
  { pattern: /\b(e-?mail(s)? (to|the)|send (an |the )?e-?mail|gmail|outlook)\b/i, message: 'Sending email isn’t available yet (no email connector).' },
  { pattern: /\b(calendar|meeting invite|schedule a meeting)\b/i, message: 'Calendars aren’t available yet.' },
  { pattern: /\b(sms|text message|phone call|call (them|the))\b/i, message: 'Phone calls and text messages aren’t available.' },
  { pattern: /\b(when|whenever) (a|an|someone|new) .*\b(is created|signs up|submits|arrives|comes in)\b/i, message: 'Starting automatically from an event in another app isn’t available yet; the workflow starts by hand or on a schedule.' },
  { pattern: /\bwebhook\b/i, message: 'Webhook triggers aren’t available yet.' },
]

function scheduleFrom(text: string): { cron: string; label: string } | null {
  if (/\b(every|each) hour|hourly\b/i.test(text)) return { cron: '0 * * * *', label: 'Every hour' }
  if (/\b(weekday|every working day|monday to friday)\b/i.test(text)) return { cron: '0 9 * * 1-5', label: 'Weekdays at 9:00' }
  if (/\b(every|each) (monday|week)|weekly\b/i.test(text)) return { cron: '0 9 * * 1', label: 'Mondays at 9:00' }
  if (/\b(every|each) (day|morning)|daily\b/i.test(text)) return { cron: '0 9 * * *', label: 'Daily at 9:00' }
  return null
}

function delayFrom(text: string): number | null {
  const match = text.match(/\bwait(?:s|ing)? (?:for )?(\d{1,4}) ?(minute|min|hour|day)s?\b/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const minutes = unit.startsWith('min') ? amount : unit === 'hour' ? amount * 60 : amount * 1440
  return Math.min(Math.max(minutes, 1), 10_080)
}

export function draftWorkflowFromDescription(description: string, context: BuilderContext): WorkflowDraft {
  const text = description.trim()
  const notes = ['Drafted by keyword rules from your description (no AI model is configured). Review every step before activating.']
  const unsupported = UNSUPPORTED.filter((rule) => rule.pattern.test(text)).map((rule) => rule.message)

  const wantsHubspot = /\b(hubspot|crm)\b/i.test(text) && /\b(add|create|update|save|record|log)\b/i.test(text)
  const wantsNote = wantsHubspot && /\bnote\b/i.test(text)
  const wantsSlack = /\b(slack|channel)\b/i.test(text) || (/\b(post|notify|announce)\b/i.test(text) && !/\be-?mail\b/i.test(text))
  const wantsApproval = /\b(approv|sign[- ]off|review(ed)? by|check with|confirm with|manager)\w*/i.test(text)
  const wantsCondition = /\b(only if|if (it|they|the lead) (is|are|looks?)|qualif)\w*/i.test(text)
  const schedule = scheduleFrom(text)
  const delay = delayFrom(text)
  const usesLead = /\b(lead|contact|prospect|customer|e-?mail address)\b/i.test(text)

  const hubspot = context.tools.find((tool) => tool.key === (wantsNote ? 'hubspot.notes.create' : 'hubspot.contacts.upsert'))
  const slack = context.tools.find((tool) => tool.key === 'slack.messages.post')
  const connectionFor = (provider: string) => {
    const candidates = context.connections.filter((connection) => connection.provider === provider && connection.status === 'connected')
    return candidates.length === 1 ? candidates[0]!.id : ''
  }

  const active = context.employees.filter((employee) => employee.status === 'active' && employee.activeVersionId)
  const employee = active.length === 1 ? active[0]! : (active.find((item) => text.toLowerCase().includes(item.name.toLowerCase())) ?? null)
  if (!employee) notes.push(active.length ? 'Choose which employee does the work in the employee step.' : 'There is no active employee yet: activate one, then choose it in the employee step.')

  const inputs: WorkflowInput[] = []
  if (usesLead && !schedule) {
    inputs.push({ key: 'email', label: 'Email', type: 'email', required: true, description: 'Email address of the person this run is about.' })
    inputs.push({ key: 'details', label: 'Details', type: 'long_text', required: false, description: 'Anything else the employee should know.' })
  } else if (!schedule) {
    inputs.push({ key: 'request', label: 'Request', type: 'long_text', required: true, description: 'What this run should handle.' })
  }

  const nodes: WorkflowNode[] = []
  const edges: WorkflowEdge[] = []
  let previous = 'trigger'
  let branch: WorkflowEdge['branch']
  const link = (target: string) => {
    edges.push({ id: `e${edges.length + 1}`, source: previous, target, ...(branch ? { branch } : {}) })
    previous = target
    branch = undefined
  }

  nodes.push({
    id: 'trigger',
    type: 'trigger',
    label: schedule?.label ?? 'Start',
    config: schedule ? { kind: 'schedule', cron: schedule.cron, timezone: 'UTC' } : { kind: 'manual', cron: '', timezone: '' },
  })
  if (schedule) notes.push(`Runs on a schedule (${schedule.label}, UTC). Change the time zone in the trigger if needed.`)

  if (delay) {
    nodes.push({ id: 'wait', type: 'delay', label: `Wait ${delay} min`, config: { minutes: delay } })
    link('wait')
  }

  const outputs = [
    ...(wantsCondition ? [{ key: 'decision', description: '“yes” if the work should continue, otherwise “no”.' }] : []),
    ...(wantsSlack ? [{ key: 'message', description: 'The message to post.' }] : []),
    ...(wantsHubspot && !wantsNote ? [{ key: 'first_name', description: 'The person’s first name, if known.' }] : []),
    ...(wantsNote ? [{ key: 'note', description: 'The note to add to the contact.' }, { key: 'contact_id', description: 'The HubSpot contact id.' }] : []),
  ]
  const inputLine = inputs.map((input) => `${input.label}: {{inputs.${input.key}}}`).join('\n')
  nodes.push({
    id: 'work',
    type: 'employee_task',
    label: 'Do the work',
    config: {
      employeeId: employee?.id ?? '',
      instructions: `${text}${inputLine ? `\n\n${inputLine}` : ''}\n\nDo not change records or send messages yourself; later steps of this workflow do that after the checks.`,
      outputs,
      timeoutMinutes: 120,
      requireVerified: true,
      retry: { ...DEFAULT_RETRY },
    },
  })
  link('work')

  if (wantsCondition) {
    nodes.push({ id: 'check', type: 'condition', label: 'Continue?', config: { match: 'all', rules: [{ left: '{{steps.work.output.decision}}', operator: 'equals', right: 'yes' }] } })
    nodes.push({ id: 'stopped', type: 'end', label: 'Stopped', config: { status: 'succeeded', summary: 'Stopped: the check said not to continue. {{steps.work.output.summary}}' } })
    link('check')
    edges.push({ id: `e${edges.length + 1}`, source: 'check', target: 'stopped', branch: 'false' })
    branch = 'true'
  }

  const actions: WorkflowNode[] = []
  if (wantsHubspot && hubspot) {
    actions.push({
      id: wantsNote ? 'add_note' : 'save_contact',
      type: 'tool_action',
      label: wantsNote ? 'Add a HubSpot note' : 'Save the contact in HubSpot',
      config: {
        toolKey: hubspot.key,
        integrationId: connectionFor('hubspot'),
        input: wantsNote
          ? [
              { field: 'contactId', value: '{{steps.work.output.contact_id}}' },
              { field: 'body', value: '{{steps.work.output.note}}' },
            ]
          : [
              { field: 'email', value: usesLead && !schedule ? '{{inputs.email}}' : '' },
              { field: 'firstName', value: '{{steps.work.output.first_name}}' },
            ],
        requireApproval: false,
        retry: { maxAttempts: 2, backoffSeconds: 60 },
      },
    })
  }
  if (wantsSlack && slack) {
    actions.push({
      id: 'post',
      type: 'tool_action',
      label: 'Post to Slack',
      config: {
        toolKey: slack.key,
        integrationId: connectionFor('slack'),
        input: [
          { field: 'channel', value: '' },
          { field: 'text', value: '{{steps.work.output.message}}' },
        ],
        requireApproval: false,
        retry: { maxAttempts: 1, backoffSeconds: 30 },
      },
    })
    notes.push('Fill in the Slack channel id in “Post to Slack”.')
  }
  if ((wantsHubspot && !hubspot) || (wantsSlack && !slack)) unsupported.push('An action the description mentions isn’t available.')

  if (actions.length) {
    nodes.push({ id: 'approve', type: 'approval', label: 'Approve', config: { message: 'Approve this?\n{{steps.work.output.summary}}', approverRole: 'admin', expiresInHours: 48 } })
    nodes.push({ id: 'rejected', type: 'end', label: 'Not approved', config: { status: 'succeeded', summary: 'Not approved; nothing was changed.' } })
    link('approve')
    edges.push({ id: `e${edges.length + 1}`, source: 'approve', target: 'rejected', branch: 'rejected' })
    branch = 'approved'
    notes.push('An approval step comes before every change, so a person reviews it first.')
  } else if (wantsApproval) {
    nodes.push({ id: 'approve', type: 'approval', label: 'Approve', config: { message: 'Approve the result?\n{{steps.work.output.summary}}', approverRole: 'admin', expiresInHours: 48 } })
    link('approve')
    branch = 'approved'
  }

  if (actions.length) {
    nodes.push({ id: 'failed', type: 'end', label: 'Action failed', config: { status: 'failed', summary: 'An action didn’t complete.' } })
  }
  for (const action of actions) {
    nodes.push(action)
    link(action.id)
    edges.push({ id: `e${edges.length + 1}`, source: action.id, target: 'failed', branch: 'failure' })
  }
  nodes.push({ id: 'done', type: 'end', label: 'Done', config: { status: 'succeeded', summary: '{{steps.work.output.summary}}' } })
  link('done')

  const name = text.split(/[.\n]/)[0]!.trim().slice(0, 60) || 'New workflow'
  return { name, description: text.slice(0, 2000), definition: { inputs, nodes, edges, settings: { ...DEFAULT_SETTINGS } }, notes, unsupported }
}
