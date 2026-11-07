// The map is a projection of a snapshot, never an execution plan.
export const functionKinds = new Set(['function', 'method', 'constructor', 'lambda', 'closure']);
export const structuralKinds = new Set(['project', 'directory', 'file', 'module', 'namespace', 'class', 'struct', 'interface', 'enum', ...functionKinds]);

export function walkFlow(ops, visit) {
  for (const op of ops || []) {
    visit(op);
    for (const key of ['body', 'elseBody', 'finallyBody', 'conditionBody', 'incrementBody']) walkFlow(op[key], visit);
    for (const key of ['arms', 'handlers']) for (const arm of op[key] || []) walkFlow(arm.body, visit);
  }
}

export function createProjectModel(graph) {
  const invalid = () => { throw new Error('项目快照格式不支持；请用 repo2tree scan 重新生成。'); };
  if (!graph || graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !graph.flows ||
      typeof graph.flows !== 'object' || Array.isArray(graph.flows) || typeof graph.snapshot?.id !== 'string' ||
      !Array.isArray(graph.edges) || !Array.isArray(graph.entries) || !Array.isArray(graph.diagnostics) ||
      !graph.stats || !graph.sources || typeof graph.project?.name !== 'string' ||
      graph.nodes.some(n => !n || typeof n.id !== 'string' || typeof n.name !== 'string' || typeof n.kind !== 'string') ||
      Object.values(graph.flows).some(flow => !Array.isArray(flow))) invalid();
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  if (!nodes.has(graph.root) || nodes.size !== graph.nodes.length || nodes.get(graph.root).parent) invalid();
  // Validate ancestry once. A malformed imported cycle must not hang the player.
  const checked = new Set();
  for (const node of nodes.values()) {
    const path = new Set();
    let id = node.id;
    while (nodes.has(id) && !checked.has(id)) {
      if (path.has(id)) invalid();
      path.add(id); id = nodes.get(id).parent;
    }
    for (const id of path) checked.add(id);
  }
  const ancestors = id => {
    const result = [];
    while (nodes.has(id)) { result.push(id); id = nodes.get(id).parent; }
    return result;
  };
  const children = new Map(), parents = new Map();
  for (const n of nodes.values()) {
    if (n.id === graph.root || !structuralKinds.has(n.kind)) continue;
    const parent = ancestors(n.parent).find(id => structuralKinds.has(nodes.get(id).kind)) || graph.root;
    parents.set(n.id, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n.id);
  }
  const label = id => nodes.get(id).qualifiedName || nodes.get(id).name;
  for (const ids of children.values()) ids.sort((a, b) => {
    const rank = id => children.has(id) ? 0 : functionKinds.has(nodes.get(id).kind) ? 1 : 2;
    return rank(a) - rank(b) || label(a).localeCompare(label(b)) || a.localeCompare(b);
  });
  const edges = [], seen = new Set(), incoming = new Map(), outgoing = new Map();
  const add = edge => {
    if (!edge || !nodes.has(edge.source) || !nodes.has(edge.target)) return;
    // Same pair can have several call sites and different evidence. Retain both.
    const kind = edge.kind === 'call' ? 'calls' : edge.kind;
    const key = JSON.stringify([edge.source, edge.target, kind, edge.line, edge.column, edge.origin, edge.status]);
    if (seen.has(key)) return;
    seen.add(key); edges.push(edge);
    for (const [index, id] of [[incoming, edge.target], [outgoing, edge.source]]) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(edge);
    }
  };
  for (const edge of graph.edges) if (['calls', 'instantiates'].includes(edge?.kind)) add(edge);
  for (const [id, ops] of Object.entries(graph.flows)) walkFlow(ops, op => {
    for (const target of op.targets || []) add({source:id, target:target.id, kind:op.kind,
      status:target.status, origin:target.origin, line:op.line, column:op.column});
  });
  return {nodes, children, parents, edges, incoming, outgoing, ancestors};
}
