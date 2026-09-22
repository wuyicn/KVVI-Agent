import type { LucideIcon } from 'lucide-react';
import type { WorkflowNodeType } from '../model.js';
export type NodeCatalogItem = {
    kind: WorkflowNodeType;
    label: string;
    description: string;
    group: '触发器' | '执行' | '流程控制' | '辅助';
    color: string;
    icon: LucideIcon;
    keywords: string;
};
export declare const NODE_CATALOG: NodeCatalogItem[];
export declare const NODE_META: Record<WorkflowNodeType, NodeCatalogItem>;
export declare function NodeGlyph({ kind, size, iconSize, }: {
    kind: WorkflowNodeType;
    size?: number;
    iconSize?: number;
}): import("react").JSX.Element;
