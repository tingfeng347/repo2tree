/** View model for the teaching stage. All events are hypothetical player events. */
const cache = new WeakMap();
export const eventNames = { enter: '进入函数', leave: '退出函数', call: '函数调用', http: 'HTTP 请求', choice: '等待选择', decision: '已记录假设', if: '条件', cb: '回调', switch: '多路分支', loop: '循环', ret: '返回', raise: '抛出异常', try: '异常保护区', finally: '清理步骤', await: '异步／生成器边界', boundary: '未展开的调用', stmt: '语句', break: '退出循环', continue: '下一轮', done: '演示结束' };
export const eventTone = kind => ['call', 'http', 'enter'].includes(kind) ? 'call' : ['if', 'cb', 'switch', 'loop', 'try', 'choice', 'decision'].includes(kind) ? 'branch' : ['ret', 'leave', 'finally', 'done'].includes(kind) ? 'return' : ['raise', 'boundary'].includes(kind) ? 'exception' : 'neutral';

// Cache only the functions the user visits, not every operation in a large graph.
function functionInfo(index, graph, symbol) {
  if (index.functions.has(symbol)) return index.functions.get(symbol);
  const steps = [], operations = new Map(), counts = { calls: 0, branches: 0, loops: 0 };
  const walk = (ops, depth = 0) => {
    for (const op of ops || []) {
      operations.set(op.id, op); steps.push({ ...op, depth });
      if (['call', 'http'].includes(op.kind)) counts.calls++;
      if (['if', 'cb', 'switch'].includes(op.kind)) counts.branches++;
      if (op.kind === 'loop') counts.loops++;
      for (const key of ['conditionBody', 'body', 'incrementBody', 'elseBody', 'finallyBody']) walk(op[key], depth + 1);
      for (const key of ['arms', 'handlers']) for (const arm of op[key] || []) walk(arm.body, depth + 1);
    }
  };
  walk(graph.flows[symbol]);
  const info = { steps, operations, counts }; index.functions.set(symbol, info); return info;
}

function indexGraph(graph) {
  if (cache.has(graph)) return cache.get(graph);
  const value = { nodes: new Map(graph.nodes.map(n => [n.id, n])), functions: new Map() };
  cache.set(graph, value); return value;
}

export function buildPresentation(graph, player) {
  const index = indexGraph(graph), { nodes } = index;
  const event = player.current;
  const history = player.history.slice(0, player.cursor + 1), stack = event?.stack || [];
  const symbol = stack.at(-1)?.symbol || event?.symbol || player.entry;
  const focus = nodes.get(symbol), caller = nodes.get(stack.at(-2)?.symbol);
  const info = functionInfo(index, graph, symbol), op = info.operations.get(event?.op);
  const entered = new Map(), exits = new Map();
  for (const [index, e] of history.entries()) {
    const frame = e.stack?.at(-1);
    if (e.type === 'enter' && frame) entered.set(frame.invocation, { symbol: e.symbol, invocation: frame.invocation, index, depth: e.stack.length });
    if (e.type === 'leave' && frame) exits.set(frame.invocation, e.outcome);
  }
  const active = new Set(stack.map(f => f.invocation));
  const trace = [...entered.values()].map(item => ({ ...item, node: nodes.get(item.symbol), state: active.has(item.invocation) ? 'active' : exits.get(item.invocation) === 'raise' ? 'exception' : 'returned' })).slice(-10);
  const decisions = [];
  let choiceIndex = null;
  for (const [index, e] of history.entries()) {
    if (e.type === 'choice') choiceIndex = index;
    if (e.type === 'decision') decisions.push({ ...e, index, choiceIndex });
  }
  const invocation = stack.at(-1)?.invocation;
  const visited = new Set(history.filter(e => e.stack?.at(-1)?.invocation === invocation && e.op).map(e => e.op));
  const position = Math.max(0, info.steps.findIndex(s => s.id === event?.op));
  const start = Math.max(0, position - 2);
  const steps = info.steps.slice(start, start + 8).map(s => ({ ...s, current: s.id === event?.op, visited: visited.has(s.id) }));
  const targets = (event?.targets || op?.targets || []).map(t => ({ ...t, node: nodes.get(t.id) }));
  const isCall = ['call', 'http'].includes(event?.type) || event?.choiceKind === 'target';
  const returning = ['ret', 'leave'].includes(event?.type);
  const exceptional = event?.type === 'raise' || event?.outcome === 'raise';
  const sameInvocation = e => e.stack?.at(-1)?.invocation === stack.at(-1)?.invocation;
  const returnedExpression = returning ? [...history].reverse().find(e => e.type === 'ret' && sameInvocation(e))?.text : null;
  const entry = graph.entries?.find(e => e.id === player.entry && e.kind !== 'function') || graph.entries?.find(e => e.id === player.entry);
  let next;
  if (isCall) next = {
    title: targets.length > 1 ? `${targets.length} 个候选目标` : targets[0]?.node?.name || op?.name || '未解析调用',
    detail: targets.length === 1 ? targets[0].node?.path || '调用边界' : targets.length > 1 ? '选择后才进入具体函数' : '内部行为尚未解析',
    status: targets.length === 1 && targets[0].status === 'indexed' ? '索引目标 · 尚未进入' : targets.length ? '候选 · 待确认' : '未解析边界',
    node: targets.length === 1 ? targets[0].node : null,
    role: '下一调用',
  };
  else if (returning || exceptional) next = {
    title: exceptional ? '异常待处理' : returnedExpression || '函数末尾 · 隐式返回',
    detail: exceptional ? '由最近的保护区或调用者决定后续路径' : '返回表达式展示，不是求值结果',
    status: exceptional ? '异常路径' : '返回阶段', role: exceptional ? '异常' : '返回表达式',
  };
  else if (event?.type === 'choice') next = {
    title: `${event.choices.length} 条可选路径`, detail: '在当前步骤中选择本次场景采用的路径', status: '等待你的选择', role: '当前选择',
  };
  else if (event?.type === 'boundary') next = {
    title: op?.name || '未展开的调用', detail: '假设调用返回，内部行为未知', status: '保留分析缺口', role: '调用边界',
  };
  else next = {
    title: `${info.counts.calls} 个调用点`, detail: `${info.counts.branches} 个条件／回调 · ${info.counts.loops} 个循环`, status: '源码静态结构', role: '函数概览',
  };

  return {
    guidance: guidanceFor(event, targets, focus, player.navigation),
    event, focus, caller, entry, op, next, steps, trace, stack: stack.map(f => ({ ...f, node: nodes.get(f.symbol) })),
    counts: info.counts, decisions: decisions.slice(-3),
    summary: { calls: entered.size, decisions: decisions.length, maxDepth: history.reduce((depth, e) => Math.max(depth, e.stack?.length || 0), 0), events: history.length },
    direction: event?.type === 'leave' && caller ? 'return' : event?.type === 'ret' && caller ? 'pending-return' : event?.type === 'enter' && caller ? 'call' : isCall ? 'pending' : 'none',
    exceptional,
  };
}

/** One explanation/action contract shared by the canvas and inspector. */
function guidanceFor(event, targets, focus, navigation) {
  const continuation = navigation ? ({ over: '选择后继续跳过调用', out: '选择后继续跳出函数', class: '选择后继续跳出类', module: '选择后继续跳出模块' })[navigation.mode] : null;
  const guide = (title, action, hint) => ({ title, action, hint, continuation });
  if (!event) return guide('选择演示入口', null, '从 API、前端组件或任意函数开始。');
  if (event.type === 'done') return guide(event.outcome === 'raise' ? '这条路径以异常结束' : '这条路径已讲解完成', null, '保存本次场景，或回到选择点比较另一条路径。');
  if (event.type === 'choice') {
    const choices = { target: ['确认调用目标', '静态候选可能不唯一，请指定本次要进入的函数。'], if: ['选择条件结果', '按要讲解的输入情况选择条件结果。'], cb: ['选择是否触发回调', '事件注册不等于已经触发，请选择本次场景的行为。'], switch: ['选择匹配分支', '指定本次要讲解的分支。'], loop: ['决定这一轮是否继续', `已演示 ${event.iterations || 0} 轮；可以继续，也可以退出循环。`], handler: ['选择异常处理方式', '异常类型未求值，请指定本次假设匹配的处理器。'], scheduling: ['选择异步调用的展开方式', '明确是否进入主体；演示不推断并发时序。'], recursion: ['选择递归的展开深度', '每次递归有独立调用帧；未展开的部分保留为边界。'], unsupported: ['处理尚未解析的流程', '该处无法可靠展开，选择一种明确的教学假设。'] };
    const [title, hint] = choices[event.choiceKind] || ['选择本次路径', '选择只记录为本次场景的假设。'];
    return guide(title, null, hint);
  }
  if (event.type === 'leave' && event.stack.length === 1) return guide('入口调用即将结束', '查看本次复盘', event.outcome === 'raise' ? '异常已传播到入口；下一步查看本次路径和选择记录。' : '所有调用即将退出；下一步查看本次路径和选择记录。');
  if (['call', 'http'].includes(event.type)) {
    if (!targets.length) return guide('遇到未解析调用', '查看调用边界', '内部行为未知，下一步会标记这处缺口。');
    if (targets.length !== 1 || targets[0].status !== 'indexed') return guide('调用目标需要确认', '选择调用目标', '下一步会列出候选；候选不会自动当作实际调用。');
    const target = targets[0].node;
    if (['generator', 'coroutine', 'async'].includes(target?.executionKind)) return guide('遇到异步／惰性调用', '选择展开方式', '先确认是否进入主体，再继续讲解。');
    return guide(`准备调用 ${target?.name || '目标函数'}`, '跟进此调用', '继续到调用目标；遇到递归展开边界时会再次询问。');
  }
  const steps = {
    enter: [`正在讲解 ${focus?.name || '当前函数'}`, '查看函数第一步', '当前调用已进入，下面从函数主体开始。'],
    decision: ['本次选择已记录', '沿所选路径继续', '可以随时回到下方的选择记录，改走另一条分支。'],
    ret: ['到达返回语句', '继续返回流程', '返回表达式不会求值；如有 finally，会先完成清理。'],
    leave: ['当前调用即将退出', '继续到调用者', '调用帧退出后，再继续上层流程。'],
    raise: ['异常正在向外传播', '查看异常去向', '继续到清理步骤或处理器选择点。'],
    finally: ['先完成清理步骤', '继续清理流程', '清理完成后才能返回或继续传播异常。'],
    boundary: ['此调用没有展开', '继续后续步骤', '这里只假设调用返回，内部流程仍是分析缺口。'],
    stmt: ['阅读当前语句', '继续单步', '继续查看后续的调用、分支或返回。'],
  };
  return guide(...(steps[event.type] || [eventNames[event.type] || '当前步骤', '继续单步', '沿当前场景继续；遇到选择点会暂停。']));
}
