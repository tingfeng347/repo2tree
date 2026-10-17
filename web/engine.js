/** Pure, deterministic static-flow player. No eval and no target-project execution. */
export class Player {
  constructor(graph, options = {}) {
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map(n => [n.id, n]));
    this.options = { maxDepth: 16, ...options };
    this.breakpoints = new Set();
    this.lineBreakpoints = new Set();
    this.history = [];
    this.responses = [];
    this.cursor = -1;
    this.current = null;
    this.status = 'idle';
  }
  ancestors(id) {
    const result = [], seen = new Set();
    while (id && !seen.has(id)) { seen.add(id); result.push(id); id = this.nodes.get(id)?.parent; }
    return result;
  }
  scope(id, kind) { return this.ancestors(id).find(i => this.nodes.get(i)?.kind === kind) ?? null; }
  start(id) {
    if (!this.nodes.has(id)) throw new Error('入口符号不存在');
    this.entry = id; this.history = []; this.responses = []; this.cursor = -1; this.navigation = null;
    this._create(); this._next(); return this.current;
  }
  _create() {
    this.frames = []; this.serial = 0;
    this.iterator = this._session(this.entry);
    this.status = 'paused';
  }
  _event(type, op = {}, extra = {}) {
    return { type, symbol: this.frames.at(-1)?.symbol, line: op.line, text: op.text || '', op: op.id,
      stack: this.frames.map(f => ({ ...f })), ...extra };
  }
  *_session(id) {
    const result = yield* this._function(id);
    yield this._event('done', {}, { text: result?.type === 'raise' ? `未捕获异常：${result.text}` : '本次假设路径演示结束', outcome: result?.type || 'completed' });
  }
  *_function(id, callOp) {
    const node = this.nodes.get(id);
    if (!node) return { type: 'raise', text: '目标符号不存在' };
    if (['class', 'struct'].includes(node.kind)) {
      const ctor = [...this.nodes.values()].find(n => n.parent === id && ['constructor', '__init__', '__new__'].includes(n.kind === 'constructor' ? n.kind : n.name));
      if (ctor) return yield* this._function(ctor.id, callOp);
    }
    if (callOp && ['generator', 'coroutine', 'async'].includes(node.executionKind)) {
      const selection = yield this._event('choice', callOp, { targetSymbol: id, choiceKind: 'scheduling', text: `${node.name}：异步或惰性执行需要教学假设，本版不模拟调度器`, choices: [node.executionKind === 'generator' ? '假设本次迭代消费生成器，进入主体' : '假设本次等待／调度该调用，进入主体', '仅展示创建／调度边界，假设返回'] });
      if (selection === 1) { yield this._event('boundary', callOp, { text: `未展开 ${node.name} 的异步或生成器主体` }); return null; }
    }
    const repeated = this.frames.filter(f => f.symbol === id).length;
    if (this.frames.length >= this.options.maxDepth || repeated >= 3) {
      const hard = this.frames.length >= 128;
      const selection = yield this._event('choice', callOp, { targetSymbol: id, choiceKind: 'recursion', choices: hard ? ['达到 128 层边界，假设返回'] : ['假设本次递归返回', '继续展开一层'], text: `${node.name}：需要显式选择递归展开方式` });
      if (selection !== 1 || hard) { yield this._event('boundary', callOp, { text: `假设 ${node.name} 返回；未展开的函数体不计为已探索` }); return null; }
    }
    const frame = { symbol: id, invocation: ++this.serial };
    this.frames.push(frame);
    yield this._event('enter', { line: node.line }, { symbol: id, text: node.qualifiedName || node.name, callsite: callOp ? { line: callOp.line, op: callOp.id } : undefined });
    let control;
    if (!Object.hasOwn(this.graph.flows, id)) {
      const choice = yield this._event('choice', {}, { choiceKind: 'unsupported', text: '该函数尚无结构化控制流。结构关系不能用来推断执行顺序。', choices: ['查看关系后假设返回', '模拟抛出异常'] });
      if (choice === 1) control = { type: 'raise', text: `${node.name} 模拟异常` };
    } else control = yield* this._block(this.graph.flows[id]);
    yield this._event('leave', {}, { text: `${node.name} ${control?.type === 'raise' ? '异常退出' : '返回（表达式未求值）'}`, outcome: control?.type || 'completed' });
    this.frames.pop();
    return control?.type === 'raise' ? control : null;
  }
  *_block(ops = []) {
    for (const op of ops) {
      const control = yield* this._op(op);
      if (control) return control;
    }
    return null;
  }
  *_op(op) {
    switch (op.kind) {
      case 'call': case 'http': {
        const reply = yield this._event(op.kind, op, { targets: op.targets || [], resolution: op.resolution || 'indexed' });
        if (reply?.throw) return { type: 'raise', text: `在 ${op.text} 注入的模拟异常` };
        let target;
        if (op.targets?.length === 1 && op.targets[0].status === 'indexed') target = op.targets[0].id;
        else if (op.targets?.length) {
          const selection = yield this._event('choice', op, {
            choiceKind: 'target', text: '选择本次演示使用的调用目标（候选不等于已确认）',
            choices: [...op.targets.map(t => `${this.nodes.get(t.id)?.qualifiedName || this.nodes.get(t.id)?.name || t.id} · ${t.origin}`), '作为未解析边界跳过'],
          });
          target = op.targets[selection]?.id;
          yield this._event('decision', op, { selection, choiceKind: 'target', text: target ? `本场景采用 ${this.nodes.get(target)?.name}` : '假设跳过调用边界' });
        }
        if (target) return yield* this._function(target, op);
        yield this._event('boundary', op, { text: `未展开：${op.name || op.text}。仅假设调用返回，内部行为未知。` });
        return null;
      }
      case 'if': case 'cb': case 'switch': {
        const arms = op.arms || [];
        if (!arms.length) return null;
        const selection = yield this._event('choice', op, { choices: arms.map(a => a.label), choiceKind: op.kind });
        yield this._event('decision', op, { selection, total: arms.length, choiceKind: op.kind, text: `假设：${arms[selection].label}` });
        const control = yield* this._block(arms[selection].body);
        return op.kind === 'switch' && control?.type === 'break' ? null : control;
      }
      case 'loop': {
        let iterations = 0;
        while (true) {
          if ((op.whileLoop || iterations === 0) && !(op.minIterations && iterations === 0)) {
            const control = yield* this._block(op.conditionBody);
            if (control) return control;
          }
          let selection = 0;
          if (iterations >= (op.minIterations || 0)) {
            selection = yield this._event('choice', op, { choices: [`进入第 ${iterations + 1} 轮`, `退出循环（已演示 ${iterations} 轮）`], choiceKind: 'loop', iterations });
            yield this._event('decision', op, { selection, total: 2, choiceKind: 'loop', text: selection ? '假设循环条件不再成立' : `假设进入第 ${iterations + 1} 轮` });
          }
          if (selection === 1) return yield* this._block(op.elseBody);
          const control = yield* this._block(op.body);
          iterations++;
          if (control?.type === 'break') return null;
          if (control && control.type !== 'continue') return control;
          const increment = yield* this._block(op.incrementBody);
          if (increment) return increment;
        }
      }
      case 'try': {
        yield this._event('try', op);
        let control = yield* this._block(op.body);
        if (control?.type === 'raise' && op.handlers?.length) {
          const thrown = control;
          const selection = yield this._event('choice', op, { text: `${control.text}；选择假设适用的处理器（未检查异常类型）`, choices: [...op.handlers.map(h => h.label), '未匹配，继续向外抛出'], choiceKind: 'handler' });
          yield this._event('decision', op, { selection, total: op.handlers.length + 1, choiceKind: 'handler', text: selection < op.handlers.length ? `假设匹配 ${op.handlers[selection].label}` : '异常向外传播' });
          control = selection < op.handlers.length ? yield* this._block(op.handlers[selection].body) : thrown;
        } else if (!control) control = yield* this._block(op.elseBody);
        if (op.finallyBody?.length) {
          yield this._event('finally', op, { text: '执行 finally（保留待返回或待抛出的控制流）' });
          const finalControl = yield* this._block(op.finallyBody);
          if (finalControl) control = finalControl;
        }
        return control;
      }
      case 'ret': case 'raise': case 'break': case 'continue':
        yield this._event(op.kind, op);
        return { type: op.kind === 'ret' ? 'return' : op.kind, text: op.text };
      case 'opaque': {
        const selection = yield this._event('choice', op, { choices: ['确认该处为模型缺口，假设继续', '结束本次演示'], choiceKind: 'unsupported', text: op.reason || op.text });
        return selection ? { type: 'raise', text: '遇到未支持的控制流，用户结束演示' } : null;
      }
      default: yield this._event(op.kind, op); return null;
    }
  }
  _next(response, record = true) {
    const next = this.iterator.next(response);
    if (next.done) { this.status = 'done'; return false; }
    if (record) {
      this.responses.length = Math.max(0, this.cursor);
      if (this.cursor >= 0) this.responses.push(response ?? null);
      this.history.length = this.cursor + 1;
      this.history.push(next.value);
    }
    this.cursor++;
    this.current = next.value;
    this.status = next.value.type === 'done' ? 'done' : next.value.type === 'choice' ? 'waiting' : 'paused';
    return true;
  }
  step(response) {
    if (!this.current || this.status === 'done') return false;
    if (this.current.type === 'choice') {
      if (!Number.isInteger(response) || response < 0 || response >= this.current.choices.length) { this.status = 'waiting'; return false; }
    }
    return this._next(response);
  }
  /** Apply an explicit choice, then continue an interrupted navigation command. */
  choose(response) {
    if (this.current?.type !== 'choice' || !this.step(response)) return false;
    return this.navigation ? this.command('resume') : 'step';
  }
  seek(cursor) {
    if (cursor < 0 || cursor >= this.history.length) return;
    const responses = this.responses.slice(); this.navigation = null;
    this._create(); this.cursor = -1;
    this._next(undefined, false);
    for (let i = 0; i < cursor; i++) this._next(responses[i] ?? undefined, false);
  }
  back() { if (this.cursor > 0) this.seek(this.cursor - 1); }
  atBreakpoint() {
    const e = this.current;
    return e?.type === 'enter' && this.breakpoints.has(e.symbol) || e?.line && (this.lineBreakpoints.has(`${e.symbol}:${e.line}`) || this.lineBreakpoints.has(`${this.nodes.get(e.symbol)?.path}:${e.line}`));
  }
  /** Continue operations stop at choices, breakpoints or a finite event budget. */
  command(mode, budget = 5000) {
    if (!this.current || this.status === 'done') return 'done';
    if (this.current.type === 'choice') return 'choice';
    const stack = this.current.stack;
    let depth = stack.length;
    let anchor = stack.at(-1)?.invocation;
    if (mode === 'class' || mode === 'module') {
      const kind = mode === 'class' ? 'class' : 'file';
      const scope = this.scope(stack.at(-1)?.symbol, kind);
      if (scope) {
        let i = stack.length - 1;
        while (i > 0 && this.scope(stack[i - 1].symbol, kind) === scope) i--;
        anchor = stack[i]?.invocation;
      }
    }
    if (mode === 'resume') {
      if (!this.navigation) return 'step';
      ({ mode, depth, anchor } = this.navigation);
    } else this.navigation = { mode, depth, anchor };
    const finish = reason => { this.navigation = null; return reason; };
    for (let i = 0; i < budget; i++) {
      if (!this.step()) return this.status === 'waiting' ? 'choice' : 'done';
      if (this.atBreakpoint()) { this.status = 'breakpoint'; return finish('breakpoint'); }
      if (this.current.type === 'choice') return 'choice';
      if (this.status === 'done') return finish('done');
      if (mode === 'into') return finish('step');
      if (mode === 'over' && this.current.stack.length <= depth) return finish('step');
      if (['out', 'class', 'module'].includes(mode) && !this.current.stack.some(f => f.invocation === anchor)) return finish('step');
    }
    this.status = 'budget';
    return 'budget';
  }
  export(inputs = {}, title = '未命名场景') {
    return { schemaVersion: 1, mode: 'hypothetical', snapshot: this.graph.snapshot.id, entry: this.entry, title, inputs,
      options: { ...this.options }, responses: this.responses.slice(0, this.cursor), cursor: this.cursor };
  }
  import(scenario) {
    if (scenario.schemaVersion !== 1 || scenario.mode !== 'hypothetical') throw new Error('场景格式不支持');
    if (scenario.snapshot !== this.graph.snapshot.id) throw new Error('场景属于另一份源码快照；请重新选择入口并建立场景');
    if (!Array.isArray(scenario.responses) || scenario.responses.length > 100000 || scenario.cursor !== scenario.responses.length) throw new Error('场景事件记录不完整或过大');
    this.options = { ...this.options, maxDepth: Math.max(1, Math.min(128, Number(scenario.options?.maxDepth) || 16)) };
    this.start(scenario.entry);
    for (const response of scenario.responses) if (!this.step(response ?? undefined)) throw new Error('场景记录与控制流不一致');
  }
  coverage() {
    const explored = new Map();
    for (const e of this.history.slice(0, this.cursor + 1)) if (e.type === 'decision' && ['if', 'loop', 'cb', 'handler', 'switch'].includes(e.choiceKind)) {
      const k = `${e.symbol}:${e.op}:${e.choiceKind}`;
      if (!explored.has(k)) explored.set(k, new Set());
      explored.get(k).add(e.selection);
    }
    return explored;
  }
}

export function allDecisions(graph, entry) {
  const result = [], visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id);
    const node=graph.nodes.find(n=>n.id===id);
    if (['class','struct'].includes(node?.kind)) {
      const ctor=graph.nodes.find(n=>n.parent===id&&(n.kind==='constructor'||['__init__','__new__'].includes(n.name)));
      if(ctor) visit(ctor.id);
    }
    const walk = ops => { for (const op of ops || []) {
      if (['if', 'cb', 'switch', 'loop', 'try'].includes(op.kind)) {
        const kind = op.kind === 'try' ? 'handler' : op.kind;
        const count = op.kind === 'loop' ? 2 : op.kind === 'try' ? (op.handlers?.length ? op.handlers.length + 1 : 0) : op.arms?.length || 0;
        if (count) result.push({ key: `${id}:${op.id}:${kind}`, symbol: id, op, kind, count });
      }
      for (const t of op.targets || []) visit(t.id);
      for (const k of ['body', 'elseBody', 'finallyBody', 'conditionBody', 'incrementBody']) walk(op[k]);
      for (const k of ['arms', 'handlers']) for (const a of op[k] || []) walk(a.body);
    } };
    walk(graph.flows[id]);
  };
  visit(entry);
  return result;
}
