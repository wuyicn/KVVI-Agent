import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import { Plus } from 'lucide-react';
export function WorkflowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data, }) {
    const edgeData = data;
    const [path, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });
    return (_jsxs(_Fragment, { children: [_jsx(BaseEdge, { id: id, path: path, markerEnd: markerEnd, style: style }), _jsx(EdgeLabelRenderer, { children: _jsx("button", { type: "button", className: `wf-edge-add nodrag nopan${edgeData?.error ? ' wf-edge-add--error' : ''}`, style: { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }, onClick: (event) => {
                        event.stopPropagation();
                        edgeData?.onInsert?.();
                    }, title: edgeData?.error ? '在错误分支中插入节点' : '在连线中插入节点', "aria-label": edgeData?.error ? '在错误分支中插入节点' : '在连线中插入节点', children: _jsx(Plus, { size: 13, strokeWidth: 2.2 }) }) })] }));
}
