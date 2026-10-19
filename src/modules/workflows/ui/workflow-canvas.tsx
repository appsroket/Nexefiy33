'use client'

// The visual editor: a React Flow canvas over the same definition the step
// forms and the JSON view edit. Steps are nodes with one handle per path they
// allow (then / true / false / approved / rejected / on failure); connecting
// two handles adds a connection on that path. Positions are kept apart from
// the definition (the layout), so moving a step never changes what it does.
// Read-only for versions and runs, where each step can show its status.

import '@xyflow/react/dist/style.css'

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useMemo } from 'react'

import { cn } from '@/lib/utils'

import { BRANCH_LABELS, NODE_TYPE_INFO, STEP_STATUS_DISPLAY, type Branch, type StepStatus, type WorkflowDefinition, type WorkflowLayout, type WorkflowNode } from '../domain/types'
import { NODE_ACCENT, NODE_ICONS } from './labels'

export interface StepNodeData extends Record<string, unknown> {
  node: WorkflowNode
  subtitle: string
  errors: number
  warnings: number
  status?: StepStatus
}

type StepFlowNode = Node<StepNodeData, 'step'>

const TONE_CLASS: Record<string, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-foreground',
  success: 'bg-success/15 text-foreground',
  warning: 'bg-warning/20 text-foreground',
  danger: 'bg-destructive/15 text-foreground',
}

const StepNode = memo(function StepNode({ data, selected, isConnectable }: NodeProps<StepFlowNode>) {
  const { node } = data
  const info = NODE_TYPE_INFO[node.type]
  const Icon = NODE_ICONS[node.type]
  const branches = info.branches
  const status = data.status ? STEP_STATUS_DISPLAY[data.status] : null
  return (
    <div
      className={cn(
        'w-60 rounded-lg border border-l-4 bg-card px-3 pt-2 pb-4 text-left shadow-sm',
        NODE_ACCENT[node.type],
        selected && 'ring-2 ring-ring',
        data.errors > 0 && 'border-destructive',
      )}
    >
      {node.type !== 'trigger' ? <Handle type="target" position={Position.Top} isConnectable={isConnectable} className="!size-2.5" /> : null}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{info.label}</span>
        {data.errors > 0 ? (
          <span className="ml-auto inline-flex items-center gap-0.5 text-destructive" title={`${data.errors} problem(s)`}>
            <CircleAlert className="size-3.5" aria-hidden="true" />
            {data.errors}
          </span>
        ) : data.warnings > 0 ? (
          <span className="ml-auto inline-flex items-center gap-0.5 text-warning-foreground" title={`${data.warnings} warning(s)`}>
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {data.warnings}
          </span>
        ) : null}
      </div>
      <div className="truncate text-sm font-medium">{node.label || node.id}</div>
      {data.subtitle ? <div className="truncate text-xs text-muted-foreground">{data.subtitle}</div> : null}
      {status ? <div className={cn('mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium', TONE_CLASS[status.tone])}>{status.label}</div> : null}
      {branches.map((branch, position) => {
        const left = `${((position + 1) / (branches.length + 1)) * 100}%`
        return (
          <div key={branch || 'then'}>
            <Handle id={branch || 'then'} type="source" position={Position.Bottom} isConnectable={isConnectable} style={{ left }} className="!size-2.5" />
            {branch ? (
              <span className="pointer-events-none absolute -bottom-5 -translate-x-1/2 text-[10px] whitespace-nowrap text-muted-foreground" style={{ left }}>
                {BRANCH_LABELS[branch as Branch]}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
})

const NODE_TYPES = { step: StepNode }

export function WorkflowCanvas({
  definition,
  layout,
  subtitles,
  issueCounts,
  statuses,
  selectedId,
  readOnly = false,
  onSelect,
  onLayoutChange,
  onConnect,
  onRemoveNodes,
  onRemoveEdges,
}: {
  definition: WorkflowDefinition
  layout: WorkflowLayout
  subtitles: Record<string, string>
  issueCounts?: Record<string, { errors: number; warnings: number }>
  statuses?: Record<string, StepStatus>
  selectedId: string | null
  readOnly?: boolean
  onSelect: (nodeId: string | null) => void
  onLayoutChange?: (layout: WorkflowLayout) => void
  onConnect?: (edge: { source: string; target: string; branch?: Branch }) => void
  onRemoveNodes?: (ids: string[]) => void
  onRemoveEdges?: (ids: string[]) => void
}) {
  const nodes = useMemo<StepFlowNode[]>(
    () =>
      definition.nodes.map((node) => ({
        id: node.id,
        type: 'step',
        position: layout[node.id] ?? { x: 0, y: 0 },
        selected: node.id === selectedId,
        deletable: !readOnly,
        data: {
          node,
          subtitle: subtitles[node.id] ?? '',
          errors: issueCounts?.[node.id]?.errors ?? 0,
          warnings: issueCounts?.[node.id]?.warnings ?? 0,
          ...(statuses?.[node.id] ? { status: statuses[node.id] } : {}),
        },
      })),
    [definition.nodes, layout, selectedId, readOnly, subtitles, issueCounts, statuses],
  )

  const edges = useMemo<Edge[]>(
    () =>
      definition.edges.map((edge) => {
        const taken = statuses ? statuses[edge.source] && statuses[edge.target] && statuses[edge.target] !== 'skipped' : false
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.branch ?? 'then',
          markerEnd: { type: MarkerType.ArrowClosed },
          deletable: !readOnly,
          ...(edge.branch === 'failure' ? { style: { strokeDasharray: '6 4' } } : {}),
          ...(taken ? { animated: false, style: { strokeWidth: 2 } } : {}),
        }
      }),
    [definition.edges, readOnly, statuses],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => {
      if (readOnly) {
        for (const change of changes) if (change.type === 'select' && change.selected) onSelect(change.id)
        return
      }
      let moved: WorkflowLayout | null = null
      const removed: string[] = []
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moved ??= { ...layout }
          moved[change.id] = { x: Math.round(change.position.x), y: Math.round(change.position.y) }
        } else if (change.type === 'remove') {
          removed.push(change.id)
        } else if (change.type === 'select' && change.selected) {
          onSelect(change.id)
        }
      }
      if (moved) onLayoutChange?.(moved)
      if (removed.length) onRemoveNodes?.(removed)
    },
    [layout, onLayoutChange, onRemoveNodes, onSelect, readOnly],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
      if (removed.length && !readOnly) onRemoveEdges?.(removed)
    },
    [onRemoveEdges, readOnly],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return
      const branch = connection.sourceHandle && connection.sourceHandle !== 'then' ? (connection.sourceHandle as Branch) : undefined
      onConnect?.({ source: connection.source, target: connection.target, ...(branch ? { branch } : {}) })
    },
    [onConnect],
  )

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-lg border bg-muted/30" aria-label="Workflow canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/** One line under each step's name: who or what it uses. */
export function stepSubtitles(definition: WorkflowDefinition, names: { employees: Map<string, string>; tools: Map<string, string> }): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of definition.nodes) {
    switch (node.type) {
      case 'trigger':
        result[node.id] = node.config.kind === 'schedule' ? `Schedule: ${node.config.cron || '(not set)'} ${node.config.timezone}` : 'Started by hand'
        break
      case 'employee_task':
        result[node.id] = names.employees.get(node.config.employeeId) ?? 'Choose an employee'
        break
      case 'tool_action':
        result[node.id] = names.tools.get(node.config.toolKey) ?? 'Choose an action'
        break
      case 'condition':
        result[node.id] = `${node.config.rules.length} rule${node.config.rules.length === 1 ? '' : 's'} (${node.config.match})`
        break
      case 'approval':
        result[node.id] = `Needs a ${node.config.approverRole}; expires in ${node.config.expiresInHours} h`
        break
      case 'transform':
        result[node.id] = node.config.fields.map((field) => field.key).join(', ')
        break
      case 'delay':
        result[node.id] = `Wait ${node.config.minutes} min`
        break
      case 'end':
        result[node.id] = node.config.status === 'failed' ? 'Ends as failed' : 'Ends as succeeded'
        break
    }
  }
  return result
}
