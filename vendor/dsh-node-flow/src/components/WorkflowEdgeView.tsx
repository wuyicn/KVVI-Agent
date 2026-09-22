import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'

export type WorkflowEdgeData = {
  label?: string
  error?: boolean
  onInsert?: () => void
}

export function WorkflowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const edgeData = data as WorkflowEdgeData | undefined
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`wf-edge-add nodrag nopan${edgeData?.error ? ' wf-edge-add--error' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(event) => {
            event.stopPropagation()
            edgeData?.onInsert?.()
          }}
          title={edgeData?.error ? '在错误分支中插入节点' : '在连线中插入节点'}
          aria-label={edgeData?.error ? '在错误分支中插入节点' : '在连线中插入节点'}
        >
          <Plus size={13} strokeWidth={2.2} />
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
