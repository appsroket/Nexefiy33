// Graph helpers over a workflow's nodes and edges: adjacency, cycle detection,
// reachability, topological order and dominators. Pure and Zod-free.

import type { WorkflowDefinition, WorkflowEdge } from './types'

export interface GraphIndex {
  ids: Set<string>
  outgoing: Map<string, WorkflowEdge[]>
  incoming: Map<string, WorkflowEdge[]>
}

export function indexGraph(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): GraphIndex {
  const ids = new Set(definition.nodes.map((node) => node.id))
  const outgoing = new Map<string, WorkflowEdge[]>()
  const incoming = new Map<string, WorkflowEdge[]>()
  for (const id of ids) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    outgoing.get(edge.source)!.push(edge)
    incoming.get(edge.target)!.push(edge)
  }
  return { ids, outgoing, incoming }
}

/** Node ids in topological order, or null when the graph has a cycle. */
export function topologicalOrder(index: GraphIndex): string[] | null {
  const remaining = new Map([...index.ids].map((id) => [id, index.incoming.get(id)!.length]))
  const ready = [...index.ids].filter((id) => remaining.get(id) === 0)
  const order: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    order.push(id)
    for (const edge of index.outgoing.get(id)!) {
      const left = remaining.get(edge.target)! - 1
      remaining.set(edge.target, left)
      if (left === 0) ready.push(edge.target)
    }
  }
  return order.length === index.ids.size ? order : null
}

/** One cycle's nodes, for the error message (empty when acyclic). */
export function findCycle(index: GraphIndex): string[] {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting')
    stack.push(id)
    for (const edge of index.outgoing.get(id)!) {
      const seen = state.get(edge.target)
      if (seen === 'visiting') return stack.slice(stack.indexOf(edge.target))
      if (!seen) {
        const found = visit(edge.target)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of index.ids) {
    if (!state.has(id)) {
      const found = visit(id)
      if (found) return found
    }
  }
  return []
}

/** Nodes reachable from `start` (including it), optionally ignoring some edges. */
export function reachableFrom(index: GraphIndex, start: string, skip?: (edge: WorkflowEdge) => boolean): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of index.outgoing.get(id) ?? []) {
      if (skip?.(edge) || seen.has(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
    }
  }
  return seen
}

/**
 * Dominators of an acyclic graph from `entry`: node A dominates B when every
 * path from the entry to B passes through A. Only reachable nodes appear.
 */
export function dominators(index: GraphIndex, entry: string, order: readonly string[]): Map<string, Set<string>> {
  const reachable = reachableFrom(index, entry)
  const result = new Map<string, Set<string>>()
  for (const id of order) {
    if (!reachable.has(id)) continue
    if (id === entry) {
      result.set(id, new Set([id]))
      continue
    }
    let common = null as Set<string> | null
    for (const edge of index.incoming.get(id)!) {
      const parent = result.get(edge.source)
      if (!parent) continue
      common = common ? new Set([...common].filter((item: string) => parent.has(item))) : new Set(parent)
    }
    const own = common ?? new Set<string>()
    own.add(id)
    result.set(id, own)
  }
  return result
}

/** Whether `to` can be reached from `from` without passing through a node for which `blocks` is true. */
export function reachableAvoiding(index: GraphIndex, from: string, to: string, blocks: (id: string) => boolean): boolean {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of index.outgoing.get(id) ?? []) {
      if (edge.target === to) return true
      if (seen.has(edge.target) || blocks(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
    }
  }
  return false
}
