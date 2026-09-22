import { type EdgeProps } from '@xyflow/react';
export type WorkflowEdgeData = {
    label?: string;
    error?: boolean;
    onInsert?: () => void;
};
export declare function WorkflowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data, }: EdgeProps): import("react").JSX.Element;
