import {functionKinds} from './project-model.js';

const types = new Set(['class', 'struct', 'interface', 'enum']);
const nameOf = node => node?.qualifiedName || node?.name || '未知符号';

/** File groups and owned callables, never a static-edge execution order. */
export function overviewModel(project) {
  const {nodes, ancestors} = project, owners = new Map(), displayed = new Map();
  for (const node of nodes.values()) {
    if (!functionKinds.has(node.kind) && !types.has(node.kind)) continue;
    const chain = ancestors(node.id).map(id => nodes.get(id));
    const owner = chain.find(n => types.has(n.kind)) || chain.filter(n => functionKinds.has(n.kind)).at(-1) || node;
    owners.set(node.id, owner.id);
    if (!displayed.has(owner.id)) displayed.set(owner.id, {...owner, label:nameOf(owner), members:[]});
    displayed.get(owner.id).members.push(node.id);
  }
  const groups = new Map();
  for (const node of displayed.values()) {
    const path = node.path || '未归档符号';
    if (!groups.has(path)) groups.set(path, {id:path, label:path, nodes:[]});
    groups.get(path).nodes.push(node);
  }
  const merged = new Map();
  for (const edge of project.edges) {
    const from = owners.get(edge.source), to = owners.get(edge.target);
    if (!from || !to || from === to) continue;
    const key = JSON.stringify([from, to]);
    if (!merged.has(key)) merged.set(key, {from, to, evidence:[], candidate:false});
    const link = merged.get(key); link.evidence.push(edge); link.candidate ||= edge.status !== 'indexed';
  }
  return {type:'overview', title:'项目全景', subtitle:'文件分组 · 类与函数职责 · 静态调用依赖',
    nodes:[...displayed.values()], groups:[...groups.values()], edges:[...merged.values()], owners};
}

/** Actual hypothetical invocation records, cut at the current cursor. */
export function sequenceModel(graph, player) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n])), participants = [], messages = [], open = new Map();
  const history = player.history.slice(0, player.cursor + 1);
  for (const [index, event] of history.entries()) {
    const frame = event.stack?.at(-1), caller = event.stack?.at(-2);
    if (!frame) continue;
    if (event.type === 'enter') {
      const participant = {id:frame.invocation, symbol:frame.symbol, label:nameOf(nodes.get(frame.symbol)), depth:event.stack.length,
        start:messages.length, end:null, index};
      participants.push(participant); open.set(frame.invocation, participant);
      messages.push({type:'call', from:caller?.invocation ?? frame.invocation, to:frame.invocation, label:caller ? '进入调用' : '演示入口',
        symbol:frame.symbol, index, op:event.op, line:event.line});
    } else if (event.type === 'leave') {
      const participant = open.get(frame.invocation);
      if (participant) participant.end = messages.length;
      messages.push({type:event.outcome === 'raise' ? 'exception' : 'return', from:frame.invocation, to:caller?.invocation ?? frame.invocation,
        label:event.outcome === 'raise' ? '异常退出' : caller ? '返回调用者' : '入口退出', symbol:frame.symbol, index, line:event.line});
    } else if (['choice', 'decision', 'boundary', 'await', 'finally', 'ret', 'raise'].includes(event.type)) {
      const labels = {choice:'等待选择', decision:'已选假设', boundary:'未解析边界', await:'异步展开假设', finally:'finally 清理', ret:'待返回', raise:'抛出异常'};
      messages.push({type:'note', tone:event.type, from:frame.invocation, to:frame.invocation, label:`${labels[event.type]} · ${event.text || ''}`,
        symbol:frame.symbol, index, op:event.op, line:event.line});
    }
  }
  return {type:'sequence', title:'场景时序', subtitle:'手动假设路径 · 按调用实例分列 · 纵轴为事件次序，无耗时含义', participants, messages};
}

/** Build control-flow with explicit continuations, including cleanup on abrupt exit. */
export function flowModel(graph, symbol) {
  const node = graph.nodes.find(n => n.id === symbol);
  if (!node || !Object.hasOwn(graph.flows, symbol)) return {type:'flow', symbol, title:nameOf(node), unsupported:true, nodes:[], edges:[]};
  let serial = 0;
  const nodes = [], edges = [];
  const add = (label, kind, op = {}, detail = '') => {
    const id = `flow-${++serial}`;
    nodes.push({id, label, kind, op:op.id, symbol, line:op.line, detail, targets:op.targets || []}); return id;
  };
  const link = (from, to, label = '', candidate = false) => { if (from && to) edges.push({from, to, label, candidate}); };
  const normal = add('函数结束 / 返回', 'end'), thrown = add('异常向外传播', 'exception');
  const context = {return:normal, raise:thrown, break:thrown, continue:thrown};
  const withContext = (ctx, values) => Object.create(ctx, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {value, enumerable:true}])));
  const compile = (ops, next, ctx, detail = '') => {
    let head = next;
    for (const op of [...(ops || [])].reverse()) {
      const text = String(op.text || op.kind).split('\n')[0];
      if (['if', 'switch', 'cb'].includes(op.kind)) {
        const id = add(text, 'decision', op, detail);
        for (const arm of op.arms || []) link(id, compile(arm.body, head, op.kind === 'switch' ? withContext(ctx, {break:head}) : ctx, detail), arm.label);
        if (!op.arms?.length) link(id, head, '无分支');
        head = id;
      } else if (op.kind === 'loop') {
        const id = add(text, 'decision', op, detail);
        const condition = compile(op.conditionBody, id, ctx, detail);
        const again = op.whileLoop ? condition : id;
        const increment = compile(op.incrementBody, again, ctx, detail);
        const body = compile(op.body, increment, withContext(ctx, {break:head, continue:increment}), detail);
        link(id, body, '继续一轮'); link(id, compile(op.elseBody, head, ctx, detail), '条件不成立');
        // A do/while must enter its body before the first condition.
        head = op.minIterations ? body : condition;
      } else if (op.kind === 'try') {
        const finals = new Map();
        const finish = (target, reason) => {
          if (!op.finallyBody?.length) return target;
          if (!finals.has(target)) {
            const first = compile(op.finallyBody, target, ctx, `finally · ${reason}`);
            const gate = add(`finally · ${reason}`, 'cleanup', op, detail); link(gate, first); finals.set(target, gate);
          }
          return finals.get(target);
        };
        const routed = {};
        // Resolve cleanup paths lazily: unused control signals need no cloned blocks.
        for (const key of ['return', 'raise', 'break', 'continue']) Object.defineProperty(routed, key,
          {get:() => finish(ctx[key], {return:'待返回', raise:'待抛出', break:'待退出循环', continue:'待下一轮'}[key])});
        const normalNext = finish(head, '正常结束');
        const afterBody = compile(op.elseBody, normalNext, routed, detail);
        let handler = routed.raise;
        if (op.handlers?.length) {
          handler = add('选择异常处理器', 'decision', op, '异常类型由讲解者确认');
          for (const arm of op.handlers) link(handler, compile(arm.body, normalNext, routed, detail), arm.label, true);
          link(handler, routed.raise, '未匹配，向外抛出', true);
        }
        const bodyContext = Object.create(routed); Object.defineProperty(bodyContext, 'raise', {value:handler});
        const id = add('try · 异常保护区', 'group', op, detail);
        link(id, compile(op.body, afterBody, bodyContext, detail)); head = id;
      } else {
        const unresolved = ['call', 'http'].includes(op.kind) && !op.targets?.length;
        const kind = op.kind === 'opaque' || unresolved ? 'boundary' : op.kind;
        const evidence = unresolved ? '调用目标未解析 · 未展开边界' : op.targets?.some(t => t.status !== 'indexed') ? '候选待确认' : detail;
        const id = add(text, kind, op, evidence);
        if (kind === 'ret') link(id, ctx.return, '待返回');
        else if (kind === 'raise') link(id, ctx.raise, '异常');
        else if (kind === 'break') link(id, ctx.break, '退出循环 / switch');
        else if (kind === 'continue') link(id, ctx.continue, '下一轮');
        else {
          link(id, head);
          if (['call', 'http'].includes(kind)) link(id, ctx.raise, '若调用抛出异常', true);
          if (kind === 'boundary') link(id, ctx.raise, unresolved ? '若调用抛出异常' : '若结束演示', true);
        }
        head = id;
      }
    }
    return head;
  };
  const first = compile(graph.flows[symbol], normal, context), entry = add(nameOf(node), 'start'); link(entry, first);
  // Drop statements made unreachable by return/raise; all reachable exceptional paths remain.
  const outgoing = new Map();
  for (const edge of edges) {if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);outgoing.get(edge.from).push(edge.to);}
  const reachable = new Set(), pending = [entry];
  while (pending.length) {const id=pending.pop();if(reachable.has(id)) continue;reachable.add(id);pending.push(...(outgoing.get(id)||[]));}
  return {type:'flow', symbol, entry, title:nameOf(node), subtitle:'源码控制流 · 条件手选 · 虚线表示可能的异常路径',
    nodes:nodes.filter(n => reachable.has(n.id)), edges:edges.filter(e => reachable.has(e.from) && reachable.has(e.to))};
}
