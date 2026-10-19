// How a run moves through its graph, as pure decisions the orchestrator
// (server/orchestrator.ts) acts on. Steps run in order along the
// connections; a step with several incoming connections waits until every one
// of them is decided, then runs if at least one was taken and is skipped if
// none was (so a path not taken skips everything only it leads to). That one
// rule gives sequential runs, conditional branches (a condition or approval
// takes one path) and parallel branches (several connections out of a step,
// joined where they meet again).
//
// A run ends when nothing is running, waiting or ready: it fails if a step
// failed with no failure path, or it reached a failing end step; it is
// rejected when an approval was rejected and the step has no rejected path;
// otherwise it succeeds. Pure and Zod-free.

import { indexGraph, type GraphIndex } from './graph'
import { FINISHED_STEP_STATUSES, type Branch, type StepStatus, type WorkflowDefinition, type WorkflowEdge } from './types'

export interface StepState {
  status: StepStatus
  /** The path the step took when it finished (condition, approval, or "failure"); null for the normal path. */
  branch: Branch | null
}

export type StepStates = Record<string, StepState>

export interface RunPlan {
  /** Steps whose turn has come. */
  ready: string[]
  /** Steps none of whose incoming paths was taken. */
  skip: string[]
  /** Set when the run is over (or must stop). */
  outcome: RunOutcome | null
}

export type RunOutcome =
  | { status: 'succeeded'; endNodes: string[] }
  | { status: 'failed'; reason: 'step_failed'; nodeId: string }
  | { status: 'failed'; reason: 'end_failed'; endNodes: string[] }
  | { status: 'rejected'; nodeId: string }

const finished = (state: StepState | undefined) => !!state && FINISHED_STEP_STATUSES.includes(state.status)

/** Whether a connection was taken, given its source step's state. */
export function edgeTaken(edge: WorkflowEdge, source: StepState | undefined): boolean {
  if (!source) return false
  if (source.status === 'failed') return edge.branch === 'failure'
  if (source.status !== 'succeeded') return false
  return (edge.branch ?? null) === source.branch
}

export function planRun(definition: WorkflowDefinition, steps: StepStates, index: GraphIndex = indexGraph(definition)): RunPlan {
  // A failure with nowhere to go, or a rejection with no rejected path, ends the run at once.
  for (const [nodeId, state] of Object.entries(steps)) {
    const outgoing = index.outgoing.get(nodeId) ?? []
    if (state.status === 'failed' && !outgoing.some((edge) => edge.branch === 'failure')) {
      return { ready: [], skip: [], outcome: { status: 'failed', reason: 'step_failed', nodeId } }
    }
    if (state.status === 'succeeded' && state.branch === 'rejected' && !outgoing.some((edge) => edge.branch === 'rejected')) {
      return { ready: [], skip: [], outcome: { status: 'rejected', nodeId } }
    }
  }

  const ready: string[] = []
  const skip: string[] = []
  for (const node of definition.nodes) {
    if (steps[node.id]) continue
    const incoming = index.incoming.get(node.id) ?? []
    if (node.type === 'trigger') {
      ready.push(node.id)
      continue
    }
    if (!incoming.length) continue
    if (!incoming.every((edge) => finished(steps[edge.source]))) continue
    if (incoming.some((edge) => edgeTaken(edge, steps[edge.source]))) ready.push(node.id)
    else skip.push(node.id)
  }

  const active = Object.values(steps).some((state) => state.status === 'running' || state.status === 'waiting')
  if (ready.length || skip.length || active) return { ready, skip, outcome: null }

  const endNodes = definition.nodes.filter((node) => node.type === 'end' && steps[node.id]?.status === 'succeeded')
  const failedEnds = endNodes.filter((node) => node.type === 'end' && node.config.status === 'failed').map((node) => node.id)
  if (failedEnds.length) return { ready, skip, outcome: { status: 'failed', reason: 'end_failed', endNodes: failedEnds } }
  // Every path ended; a run that never reached an end step (all skipped) still finished.
  return { ready, skip, outcome: { status: 'succeeded', endNodes: endNodes.map((node) => node.id) } }
}

/** Whether a failed step may try again under its retry policy. */
export function shouldRetry(attempt: number, maxAttempts: number, retryable: boolean): boolean {
  return retryable && attempt < maxAttempts
}

/** Waits between tool-action attempts: the step's backoff, doubled per attempt, at most an hour. */
export function retryDelayMs(backoffSeconds: number, attempt: number): number {
  return Math.min(3_600_000, backoffSeconds * 1000 * 2 ** Math.max(0, attempt - 1))
}
