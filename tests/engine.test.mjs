import test from 'node:test';
import assert from 'node:assert/strict';
import { Player, allDecisions } from '../web/engine.js';

const node = (id, parent = 'file', kind = 'function') => ({ id, name: id, qualifiedName: id, path: 'app.py', parent, kind, flowStatus: 'structured' });
let serial = 0;
const op = (kind, fields = {}) => ({ id: `op${++serial}`, kind, text: kind, line: serial, targets: [], ...fields });
const call = id => op('call', { targets: [{ id, origin: 'codegraph', status: 'indexed' }] });
const ret = () => op('ret');
const stmt = text => op('stmt', { text });
const condition = (a, b) => op('if', { arms: [{ label: 'yes', body: a }, { label: 'no', body: b }] });
const fixture = (flows, extra = []) => ({ schemaVersion: 1, snapshot: { id: 'snapshot-1' }, nodes: [node('root', null, 'project'), node('file', 'root', 'file'), ...Object.keys(flows).map(id => node(id)), ...extra], flows });
const drive = (p, choose = () => 0, limit = 500) => {
  for (let i = 0; i < limit && p.status !== 'done'; i++) p.step(p.current.type === 'choice' ? choose(p.current) : undefined);
  assert.equal(p.status, 'done', 'player must finish within test event budget');
  return p.history;
};

test('no branch choice is made implicitly', () => {
  const branch = condition([stmt('yes')], [stmt('no')]);
  const p = new Player(fixture({ main: [branch] })); p.start('main'); p.step();
  assert.equal(p.status, 'waiting'); const at = p.cursor;
  assert.equal(p.step(), false); assert.equal(p.cursor, at);
  drive(p, () => 1);
  assert(p.history.some(e => e.text === 'no'));
  assert(!p.history.some(e => e.text === 'yes'));
});

test('return unwinds finally before leaving, and skips subsequent statements', () => {
  const p = new Player(fixture({ main: [op('try', { body: [ret()], finallyBody: [stmt('cleanup')], handlers: [] }), stmt('unreachable')] }));
  p.start('main'); const events = drive(p);
  assert(events.findIndex(e => e.text === 'cleanup') > events.findIndex(e => e.type === 'ret'));
  assert(events.findIndex(e => e.text === 'cleanup') < events.findIndex(e => e.type === 'leave'));
  assert(!events.some(e => e.text === 'unreachable'));
});

test('finally return overrides pending exception', () => {
  const p = new Player(fixture({ main: [op('try', { body: [op('raise', { text: 'failure' })], finallyBody: [ret()], handlers: [] })] }));
  p.start('main'); drive(p);
  assert.equal(p.current.outcome, 'completed');
});

test('nested calls propagate exception to a manually selected handler and always run finally', () => {
  const p = new Player(fixture({ main: [op('try', { body: [call('fail')], handlers: [{ label: 'except ValueError', body: [stmt('caught')] }], elseBody: [stmt('no-error')], finallyBody: [stmt('finally')] })], fail: [op('raise', { text: 'error' })] }));
  p.start('main'); const events = drive(p);
  assert(events.some(e => e.choiceKind === 'handler'));
  assert(events.some(e => e.text === 'caught')); assert(events.some(e => e.text === 'finally'));
  assert(!events.some(e => e.text === 'no-error'));
});

test('try else exceptions do not enter the same try handler', () => {
  const p = new Player(fixture({ main: [op('try', { body: [stmt('ok')], handlers: [{ label: 'handler', body: [stmt('wrong-handler')] }], elseBody: [op('raise')], finallyBody: [stmt('cleanup')] })] }));
  p.start('main'); drive(p);
  assert(!p.history.some(e => e.text === 'wrong-handler'));
  assert(p.history.some(e => e.text === 'cleanup')); assert.equal(p.current.outcome, 'raise');
});

test('loops expand multiple iterations; continue runs finally and increment; exhaustion runs else', () => {
  const loop = op('loop', { conditionBody: [stmt('condition')], whileLoop: true, body: [op('try', { body: [op('continue')], finallyBody: [stmt('cleanup')] })], incrementBody: [stmt('increment')], elseBody: [stmt('exhausted')] });
  const p = new Player(fixture({ main: [loop] })); p.start('main'); let count = 0;
  const events = drive(p, e => e.choiceKind === 'loop' && count++ >= 3 ? 1 : 0);
  assert.equal(events.filter(e => e.text === 'cleanup').length, 3);
  assert.equal(events.filter(e => e.text === 'increment').length, 3);
  assert.equal(events.filter(e => e.text === 'condition').length, 4);
  assert(events.some(e => e.text === 'exhausted'));
});

test('break runs finally but does not run loop else', () => {
  const p = new Player(fixture({ main: [op('loop', { body: [op('try', { body: [op('break')], finallyBody: [stmt('cleanup')] })], elseBody: [stmt('wrong')] })] }));
  p.start('main'); drive(p);
  assert(p.history.some(e => e.text === 'cleanup')); assert(!p.history.some(e => e.text === 'wrong'));
});

test('switch break exits switch without breaking the surrounding loop', () => {
  const p = new Player(fixture({ main: [op('loop', { body: [op('switch', { arms: [{ label: 'case 1', body: [op('break')] }] }), stmt('after-switch'), op('break')] })] }));
  p.start('main'); drive(p);
  assert(p.history.some(e => e.text === 'after-switch'));
});

test('step over and step out respect a nested function breakpoint', () => {
  const graph = fixture({ main: [call('service'), stmt('after')], service: [call('inner')], inner: [ret()] });
  for (const command of ['over', 'out', 'class', 'module']) {
    const p = new Player(graph); p.start('main'); p.step(); p.breakpoints.add('inner');
    assert.equal(p.command(command), 'breakpoint'); assert.equal(p.current.symbol, 'inner'); assert.equal(p.current.type, 'enter');
  }
});

test('source line breakpoint uses file path and applies inside step over', () => {
  const body = stmt('stop'); const p = new Player(fixture({ main: [call('service')], service: [body] }));
  p.start('main'); p.step(); p.lineBreakpoints.add(`app.py:${body.line}`);
  assert.equal(p.command('over'), 'breakpoint'); assert.equal(p.current.text, 'stop');
});

test('module exit follows invocation lifetime across foreign helper calls', () => {
  const graph = fixture({ main: [call('one'), stmt('outside')], one: [call('helper'), call('two')], helper: [stmt('helper-body')], two: [ret()] }, [node('other-file', 'root', 'file')]);
  graph.nodes.find(n => n.id === 'one').parent = 'other-file'; graph.nodes.find(n => n.id === 'two').parent = 'other-file';
  const p = new Player(graph); p.start('main'); p.step(); p.step();
  assert.equal(p.current.symbol, 'one'); assert.equal(p.command('module'), 'step');
  assert.equal(p.current.text, 'outside'); assert.equal(p.current.symbol, 'main');
});

test('pending step-out target survives a branch pause', () => {
  const p = new Player(fixture({ main: [call('service'), stmt('outside')], service: [condition([stmt('inside')], [])] }));
  p.start('main'); p.step(); p.step();
  assert.equal(p.command('out'), 'choice'); p.step(0);
  assert.equal(p.command('resume'), 'step'); assert.equal(p.current.text, 'outside');
});

test('rewinding reconstructs frames and allows a different branch without retaining its future', () => {
  const branch = condition([stmt('yes')], [stmt('no')]); const p = new Player(fixture({ main: [branch] }));
  p.start('main'); drive(p); const choice = p.history.findIndex(e => e.type === 'choice');
  p.seek(choice); drive(p, () => 1);
  assert(!p.history.some(e => e.text === 'yes')); assert(p.history.some(e => e.text === 'no'));
  assert.equal([...p.coverage().values()][0].size, 1);
});

test('scenario round-trip reproduces an exact cursor and rejects other source snapshots', () => {
  const graph = fixture({ main: [condition([call('a')], [])], a: [ret()] });
  const p = new Player(graph); p.start('main'); drive(p); const saved = p.export({ arbitrary: 12 }, 'success');
  const q = new Player(graph); q.import(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(q.history, p.history); assert.equal(q.cursor, p.cursor);
  assert.throws(() => q.import({ ...saved, snapshot: 'changed' }), /源码快照/);
  assert.throws(() => q.import({ ...saved, responses: [...saved.responses, 99] }), /记录/);
});

test('ambiguous and name-only targets require explicit confirmation', () => {
  const p = new Player(fixture({ main: [op('call', { targets: [{ id: 'target', status: 'candidate', origin: 'name-candidate' }] })], target: [ret()] }));
  p.start('main'); p.step(); p.step(); assert.equal(p.current.choiceKind, 'target');
  assert.equal(p.step(), false); drive(p, () => 1);
  assert(!p.history.some(e => e.type === 'enter' && e.symbol === 'target'));
});

test('unknown functions and unsupported bodies never become a guessed sequential call list', () => {
  const graph = fixture({ main: [op('call', { name: 'unknown' }), call('opaque')] }, [node('opaque')]);
  graph.edges = [{ source: 'opaque', target: 'main', kind: 'calls' }];
  const p = new Player(graph); p.start('main'); drive(p);
  assert(p.history.some(e => e.type === 'boundary'));
  assert(p.history.some(e => e.choiceKind === 'unsupported'));
  assert.equal(p.history.filter(e => e.type === 'enter' && e.symbol === 'main').length, 1);
});

test('recursive occurrences remain separate invocation frames and require a boundary decision', () => {
  const p = new Player(fixture({ main: [call('main')] })); p.start('main'); drive(p, e => e.choiceKind === 'recursion' ? 0 : 0);
  const enters = p.history.filter(e => e.type === 'enter'); assert.equal(enters.length, 3);
  assert.equal(new Set(enters.map(e => e.stack.at(-1).invocation)).size, 3);
  assert(p.history.some(e => e.choiceKind === 'recursion'));
});

test('decision inventory traverses nested flows and cyclic call candidates only once', () => {
  const graph = fixture({ main: [condition([call('a')], [])], a: [call('main'), op('loop', { body: [] })] });
  const inventory = allDecisions(graph, 'main'); assert.equal(inventory.length, 2); assert.equal(inventory.reduce((s, d) => s + d.count, 0), 4);
});

test('a coroutine call requires a scheduling assumption before its body is expanded', () => {
  const graph=fixture({main:[call('task')],task:[stmt('async-body')]});
  graph.nodes.find(n=>n.id==='task').executionKind='coroutine';
  const p=new Player(graph);p.start('main');drive(p,e=>e.choiceKind==='scheduling'?1:0);
  assert(!p.history.some(e=>e.text==='async-body'));
  assert(p.history.some(e=>e.choiceKind==='scheduling'));
});

test('entering a cross-file function locates its definition, not the caller line', () => {
  const invocation=call('callee');invocation.line=200;
  const graph=fixture({main:[invocation],callee:[ret()]});
  Object.assign(graph.nodes.find(n=>n.id==='callee'),{path:'lib.py',line:7});
  const p=new Player(graph);p.start('main');p.step();p.lineBreakpoints.add('lib.py:200');p.step();
  assert.equal(p.current.line,7);assert.equal(p.current.callsite.line,200);assert(!p.atBreakpoint());
  p.lineBreakpoints.add('lib.py:7');assert(p.atBreakpoint());
});

test('saved expansion options are immutable and constructor branches remain in the inventory', () => {
  const graph=fixture({main:[call('Class')],ctor:[condition([],[])]},[node('Class','file','class')]);
  const ctor=graph.nodes.find(n=>n.id==='ctor');ctor.name='__init__';ctor.parent='Class';
  const p=new Player(graph);p.start('main');const saved=p.export();p.options.maxDepth=32;
  assert.equal(saved.options.maxDepth,16);
  assert.equal(allDecisions(graph,'main').length,1);
});

test('choosing resumes a pending exit and still stops at a function breakpoint', () => {
  const graph=fixture({main:[call('helper')],helper:[condition([call('leaf')],[])],leaf:[ret()]});
  const p=new Player(graph);p.start('main');p.step();p.step();p.breakpoints.add('leaf');
  assert.equal(p.command('out'),'choice');
  assert.equal(p.choose(0),'breakpoint');assert.equal(p.current.symbol,'leaf');assert.equal(p.status,'breakpoint');
});

test('choose cannot advance a non-choice event or accept an invalid choice', () => {
  const graph=fixture({main:[condition([],[])]}),p=new Player(graph);p.start('main');
  assert.equal(p.choose(0),false);assert.equal(p.cursor,0);
  p.step(); const cursor=p.cursor;
  assert.equal(p.choose(-1),false);assert.equal(p.choose(20),false);assert.equal(p.cursor,cursor);
  assert.equal(p.choose(1),'step');assert.equal(p.current.type,'decision');
});
