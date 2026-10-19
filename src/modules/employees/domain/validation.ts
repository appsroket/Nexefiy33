// Semantic checks a schema can't express: the tools exist, connections
// belong to this organization and match the tool's provider, skills and
// knowledge sources exist, and the budget can cover at least one task.
// Run on the server before every save (and again before activation), after
// the Zod schema has accepted the shape.

import { getSkill } from './skills'
import type { ConnectionOption, EmployeeConfig, EmployeeToolInfo, KnowledgeSourceOption, SkillOption } from './types'

export interface ConfigIssue {
  path: string
  message: string
}

export interface ValidationContext {
  tools: readonly EmployeeToolInfo[]
  connections: readonly ConnectionOption[]
  sources: readonly KnowledgeSourceOption[]
  skills: readonly SkillOption[]
}

export interface ValidationResult {
  /** Problems that block saving. */
  errors: ConfigIssue[]
  /** Things to fix before activation (saving is still allowed). */
  warnings: ConfigIssue[]
}

export function validateConfig(config: EmployeeConfig, context: ValidationContext): ValidationResult {
  const errors: ConfigIssue[] = []
  const warnings: ConfigIssue[] = []

  config.tools.forEach((grant, index) => {
    const path = `tools.${index}`
    const tool = context.tools.find((candidate) => candidate.key === grant.toolKey)
    if (!tool) {
      errors.push({ path, message: `“${grant.toolKey}” isn’t a tool Nexefiy has.` })
      return
    }
    if (!tool.needsConnection) {
      if (grant.integrationId) errors.push({ path, message: `${tool.title} doesn’t use a connection.` })
    } else if (!grant.integrationId) {
      warnings.push({ path, message: `${tool.title}: choose which ${tool.providerName} connection it uses.` })
    } else {
      const connection = context.connections.find((candidate) => candidate.id === grant.integrationId)
      if (!connection) errors.push({ path, message: `${tool.title}: that connection doesn’t exist in this workspace.` })
      else if (connection.provider !== tool.provider) errors.push({ path, message: `${tool.title} needs a ${tool.providerName} connection.` })
      else if (connection.status !== 'connected') warnings.push({ path, message: `${tool.title}: the ${tool.providerName} connection isn’t connected.` })
    }
    if (grant.approval === 'allow' && tool.approvalRequirement !== 'none') {
      warnings.push({
        path,
        message: `${tool.title} still needs approval unless an admin relaxes it on the connection; the employee can’t skip it on its own.`,
      })
    }
  })

  config.skills.forEach((key, index) => {
    if (!context.skills.some((skill) => skill.key === key)) {
      errors.push({ path: `skills.${index}`, message: `The skill “${key}” isn’t available.` })
      return
    }
    // A skill never grants tools: point out the ones its procedure uses that aren't granted.
    const missing = (getSkill(key)?.toolKeys ?? []).filter((toolKey) => !config.tools.some((grant) => grant.toolKey === toolKey))
    if (missing.length) {
      const titles = missing.map((toolKey) => context.tools.find((tool) => tool.key === toolKey)?.title ?? toolKey)
      warnings.push({ path: `skills.${index}`, message: `The skill “${getSkill(key)!.name}” uses ${titles.join(', ')}, which ${missing.length === 1 ? 'isn’t' : 'aren’t'} granted.` })
    }
  })

  if (config.knowledge.access === 'selected') {
    config.knowledge.sourceIds.forEach((id, index) => {
      if (!context.sources.some((source) => source.id === id)) {
        errors.push({ path: `knowledge.sourceIds.${index}`, message: 'A selected knowledge source no longer exists.' })
      }
    })
  }
  if (config.knowledge.access !== 'none' && !config.tools.some((grant) => grant.toolKey === 'knowledge.search')) {
    warnings.push({ path: 'knowledge', message: 'Knowledge access is on, but the “Search knowledge” tool isn’t granted, so the employee can’t use it.' })
  }

  if (config.budget.monthlyUsd < config.limits.maxCostUsdPerTask) {
    errors.push({ path: 'budget.monthlyUsd', message: 'The monthly budget must cover at least one task at the per-task cost limit.' })
  }
  if (config.limits.maxToolCallsPerTask === 0 && config.tools.length > 0) {
    warnings.push({ path: 'limits.maxToolCallsPerTask', message: 'Tool calls are limited to 0, so the granted tools can’t be used.' })
  }

  return { errors, warnings }
}

/** Problems that must be fixed before an admin can activate a version. */
export function activationBlockers(config: EmployeeConfig, context: ValidationContext): ConfigIssue[] {
  const { errors, warnings } = validateConfig(config, context)
  const missingConnections = warnings.filter((warning) => /choose which|isn’t connected/.test(warning.message))
  return [...errors, ...missingConnections]
}
