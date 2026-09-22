import { normalizeSavedWorkflow } from './workflowProtocol.js';
function cloneDocument(document) {
    return {
        ...structuredClone(document),
        nodes: document.nodes.map((node) => {
            const { dragging: _dragging, measured: _measured, selected: _selected, ...rest } = structuredClone(node);
            const { lastRun: _lastRun, ...data } = rest.data;
            return { ...rest, data, selected: false };
        }),
        edges: document.edges.map((edge) => ({ ...structuredClone(edge), selected: false })),
    };
}
function stableNode(node) {
    const { dragging: _dragging, measured: _measured, selected: _selected, ...rest } = node;
    const { lastRun: _lastRun, ...data } = rest.data;
    return { ...rest, data };
}
function stableEdge(edge) {
    const { selected: _selected, ...rest } = edge;
    return rest;
}
function nodeRef(node) {
    return { id: node.id, kind: node.data.kind, label: node.data.label };
}
function edgeRef(edge) {
    return { id: edge.id, source: edge.source, target: edge.target };
}
function changedNodeFields(before, after) {
    const fields = new Set();
    if (before.data.label !== after.data.label)
        fields.add('名称');
    if (before.data.kind !== after.data.kind)
        fields.add('类型');
    if (JSON.stringify(before.position) !== JSON.stringify(after.position))
        fields.add('位置');
    if (JSON.stringify(before.style) !== JSON.stringify(after.style))
        fields.add('尺寸');
    const beforeData = stableNode(before);
    const afterData = stableNode(after);
    for (const key of new Set([...Object.keys(beforeData.data), ...Object.keys(afterData.data)])) {
        if (key === 'kind' || key === 'label')
            continue;
        if (JSON.stringify(beforeData.data[key]) !== JSON.stringify(afterData.data[key]))
            fields.add(key);
    }
    return fields.size > 0 ? [...fields] : ['结构'];
}
export function createWorkflowVersion(workflow, kind, createdAt = workflow.updatedAt, sourceVersionId) {
    const current = normalizeSavedWorkflow(workflow);
    return {
        id: `${current.id}:r${current.revision}`,
        workflowId: current.id,
        revision: current.revision,
        draftRevision: current.draftRevision,
        publishedRevision: current.publishedRevision,
        kind,
        createdAt,
        sourceVersionId,
        name: current.name,
        description: current.description,
        status: current.status,
        doc: cloneDocument(current.doc),
        publishedAt: current.publishedAt,
        publishedDoc: current.publishedDoc ? cloneDocument(current.publishedDoc) : undefined,
    };
}
export function restoreWorkflowVersion(workflow, version, publish, now) {
    const current = normalizeSavedWorkflow(workflow);
    const draftRevision = current.draftRevision + 1;
    const doc = cloneDocument(version.doc);
    const restored = {
        ...current,
        name: version.name,
        description: version.description,
        revision: current.revision + 1,
        draftRevision,
        updatedAt: now,
        doc: { ...doc, name: version.name, description: version.description },
    };
    if (!publish)
        return restored;
    return {
        ...restored,
        status: 'enabled',
        publishedRevision: draftRevision,
        publishedAt: now,
        publishedDoc: cloneDocument(restored.doc),
    };
}
export function upsertWorkflowVersion(versions, version, maxPerWorkflow = 100) {
    const others = versions.filter((candidate) => candidate.id !== version.id);
    const sameWorkflow = [version, ...others.filter((candidate) => candidate.workflowId === version.workflowId)]
        .sort((left, right) => right.revision - left.revision)
        .slice(0, maxPerWorkflow);
    const allowedIds = new Set(sameWorkflow.map((candidate) => candidate.id));
    return [
        ...sameWorkflow,
        ...others.filter((candidate) => candidate.workflowId !== version.workflowId && !allowedIds.has(candidate.id)),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export function diffWorkflowDocuments(before, after) {
    const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
    const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
    const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
    const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
    const changedNodes = [];
    for (const [id, node] of afterNodes) {
        const previous = beforeNodes.get(id);
        if (!previous || JSON.stringify(stableNode(previous)) === JSON.stringify(stableNode(node)))
            continue;
        changedNodes.push({ ...nodeRef(node), fields: changedNodeFields(previous, node) });
    }
    return {
        nameChanged: before.name !== after.name,
        descriptionChanged: before.description !== after.description,
        inputsChanged: JSON.stringify(before.inputs ?? []) !== JSON.stringify(after.inputs ?? []),
        outputsChanged: JSON.stringify(before.outputs ?? []) !== JSON.stringify(after.outputs ?? []),
        concurrencyChanged: JSON.stringify(before.concurrency ?? {}) !== JSON.stringify(after.concurrency ?? {}),
        executionLimitsChanged: JSON.stringify(before.executionLimits ?? {}) !== JSON.stringify(after.executionLimits ?? {}),
        addedNodes: [...afterNodes.values()].filter((node) => !beforeNodes.has(node.id)).map(nodeRef),
        removedNodes: [...beforeNodes.values()].filter((node) => !afterNodes.has(node.id)).map(nodeRef),
        changedNodes,
        addedEdges: [...afterEdges.values()].filter((edge) => !beforeEdges.has(edge.id)).map(edgeRef),
        removedEdges: [...beforeEdges.values()].filter((edge) => !afterEdges.has(edge.id)).map(edgeRef),
        changedEdges: [...afterEdges.values()].filter((edge) => {
            const previous = beforeEdges.get(edge.id);
            return previous && JSON.stringify(stableEdge(previous)) !== JSON.stringify(stableEdge(edge));
        }).map(edgeRef),
    };
}
export function workflowDiffCount(diff) {
    return Number(diff.nameChanged)
        + Number(diff.descriptionChanged)
        + Number(diff.inputsChanged)
        + Number(diff.outputsChanged)
        + Number(diff.concurrencyChanged)
        + Number(diff.executionLimitsChanged)
        + diff.addedNodes.length
        + diff.removedNodes.length
        + diff.changedNodes.length
        + diff.addedEdges.length
        + diff.removedEdges.length
        + diff.changedEdges.length;
}
