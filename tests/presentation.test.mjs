import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../web/engine.js';
import { buildPresentation } from '../web/presentation.js';

let serial = 0;
const op = (kind, fields = {}) => ({ id: `p${++serial}`, kind, text: kind, line: serial, ...fields });
const call = id => op('call', { targets: [{ id, status: 'indexed' }] });
function fixture(flows) {
  return { flows, entries: [], nodes: Object.keys(flows).map(id => ({ id, name: id, path: 'demo.py', kind: 'function' })) };
}
function until(player, predicate) {
  for (let i = 0; i < 100 && !predicate(player.current); i++) {
    assert(player.step(), 'expected a reachable event without an implicit decision');
  }
  assert(predicate(player.current));
}

test('a pending indexed call is distinct from entering its callee', () => {
  const graph = fixture({ main: [call('helper')], helper: [] });
  const player = new Player(graph); player.start('main'); player.step();
  let model = buildPresentation(graph, player);
  assert.equal(model.direction, 'pending');
  assert.equal(model.next.node.id, 'helper');
  assert.match(model.next.status, /尚未进入/);
  assert.equal(model.summary.calls, 1);
  player.step(); model = buildPresentation(graph, player);
  assert.equal(model.direction, 'call');
  assert.equal(model.focus.id, 'helper');
  assert.equal(model.caller.id, 'main');
  assert.equal(model.summary.maxDepth, 2);
});

test('candidate targets do not become entered invocations before confirmation', () => {
  const graph = fixture({ main: [op('call', { targets: [{ id: 'helper', status: 'candidate', origin: 'route' }] })], helper: [] });
  const player = new Player(graph); player.start('main'); player.step(); player.step();
  const model = buildPresentation(graph, player);
  assert.equal(model.event.choiceKind, 'target');
  assert.equal(model.direction, 'pending');
  assert.equal(model.next.status, '候选 · 待确认');
  assert.equal(model.trace.length, 1);
});

test('return remains pending until finally completes and the frame leaves', () => {
  const graph = fixture({ main: [call('helper')], helper: [op('try', { body: [op('ret', { text: 'return result' })], finallyBody: [op('stmt', { text: 'cleanup()' })] })] });
  const player = new Player(graph); player.start('main');
  until(player, e => e.type === 'ret');
  assert.equal(buildPresentation(graph, player).direction, 'pending-return');
  assert.equal(buildPresentation(graph, player).next.title, 'return result');
  until(player, e => e.text === 'cleanup()');
  assert.equal(buildPresentation(graph, player).direction, 'none');
  until(player, e => e.type === 'leave');
  assert.equal(buildPresentation(graph, player).direction, 'return');
  assert.equal(buildPresentation(graph, player).next.title, 'return result');
});

test('throwing inside a protected function does not prematurely draw a return', () => {
  const graph = fixture({ main: [call('helper')], helper: [op('try', { body: [op('raise')], handlers: [{ label: 'caught', body: [] }] })] });
  const player = new Player(graph); player.start('main'); until(player, e => e.type === 'raise');
  const model = buildPresentation(graph, player);
  assert.equal(model.exceptional, true);
  assert.equal(model.direction, 'none');
  assert.equal(model.next.title, '异常待处理');
});

test('recursion keeps invocation identities and rewind excludes future teaching events', () => {
  const graph = fixture({ main: [call('main')] });
  const player = new Player(graph); player.start('main'); player.step(); player.step();
  const model = buildPresentation(graph, player);
  assert.deepEqual(model.trace.map(item => item.invocation), [1, 2]);
  assert.deepEqual(model.stack.map(item => item.symbol), ['main', 'main']);
  player.seek(0);
  const rewound = buildPresentation(graph, player);
  assert.equal(rewound.summary.calls, 1);
  assert.equal(rewound.summary.maxDepth, 1);
  assert.equal(rewound.trace.length, 1);
});

test('unselected source branches are previews and the recorded choice follows the cursor', () => {
  const yes = op('stmt', { text: 'yes' }), no = op('stmt', { text: 'no' });
  const graph = fixture({ main: [op('if', { arms: [{ label: 'yes', body: [yes] }, { label: 'no', body: [no] }] })] });
  const player = new Player(graph); player.start('main'); player.step();
  const choiceCursor = player.cursor;
  assert.equal(buildPresentation(graph, player).next.title, '2 条可选路径');
  player.step(1); player.step();
  let model = buildPresentation(graph, player);
  assert.equal(model.summary.decisions, 1);
  assert.equal(model.steps.find(s => s.id === yes.id).visited, false);
  assert.equal(model.steps.find(s => s.id === no.id).current, true);
  player.seek(choiceCursor); model = buildPresentation(graph, player);
  assert.equal(model.summary.decisions, 0);
  assert.equal(model.steps.find(s => s.id === no.id).visited, false);
});

test('the same source operation is not visited in a fresh recursive frame', () => {
  const first = op('stmt'), recurse = call('main');
  const graph = fixture({ main: [first, recurse] });
  const p = new Player(graph); p.start('main'); p.step(); p.step(); p.step();
  assert.equal(p.current.type, 'enter');
  assert.equal(p.current.stack.length, 2);
  assert.equal(buildPresentation(graph, p).steps.find(s => s.id === first.id).visited, false);
  p.seek(2);
  assert.equal(buildPresentation(graph, p).steps.find(s => s.id === first.id).visited, true);
});

test('change-choice links return to the actual choice, and rewinding clears future decisions', () => {
  const graph = fixture({ main: [op('loop', { body: [op('stmt')] })] });
  const p = new Player(graph); p.start('main'); p.step();
  const firstChoice = p.cursor; p.choose(0); p.step(); p.step();
  const secondChoice = p.cursor; p.choose(1);
  let m = buildPresentation(graph, p);
  assert.deepEqual(m.decisions.map(d => d.choiceIndex), [firstChoice, secondChoice]);
  p.seek(m.decisions[0].choiceIndex);
  assert.equal(p.current.type, 'choice'); assert.equal(buildPresentation(graph, p).decisions.length, 0);
  p.choose(1);
  m = buildPresentation(graph, p); assert.equal(m.decisions.length, 1);
  assert.equal(m.decisions[0].selection, 1);
});

test('step guidance distinguishes candidates, unknown targets and deferred calls', () => {
  for (const [targets, kind, action] of [
    [[], undefined, '查看调用边界'],
    [[{id:'helper',status:'candidate'}], undefined, '选择调用目标'],
    [[{id:'helper',status:'indexed'}], 'coroutine', '选择展开方式'],
    [[{id:'helper',status:'indexed'}], undefined, '跟进此调用'],
  ]) {
    const graph=fixture({main:[op('call',{targets})],helper:[]}); graph.nodes[1].executionKind=kind;
    const p=new Player(graph);p.start('main');p.step();
    assert.equal(buildPresentation(graph,p).guidance.action,action);
  }
});

test('presentation starts idle, indexes only visited functions and scopes operation IDs', () => {
  const graph=fixture({main:[op('call',{id:'shared',targets:[{id:'helper',status:'indexed'}]})],helper:[op('call',{id:'shared',targets:[]})]});
  Object.defineProperty(graph.flows,'unvisited',{enumerable:true,get(){throw Error('unvisited body should not be traversed');}});
  const p=new Player(graph);
  assert.equal(buildPresentation(graph,p).guidance.title,'选择演示入口'); assert.equal(p.current,null);
  p.start('main');p.step();assert.equal(buildPresentation(graph,p).next.node.id,'helper');
  p.step();p.step();assert.equal(buildPresentation(graph,p).next.node,null);
});

test('completion offers recap, not another executable step; exception endings stay explicit', () => {
  for (const failed of [false,true]) {
    const graph=fixture({main:failed?[op('raise')]:[]}),p=new Player(graph);p.start('main');until(p,e=>e.type==='done');
    const m=buildPresentation(graph,p);assert.equal(m.guidance.action,null);assert.equal(m.stack.length,0);
    assert.equal(m.exceptional,failed);assert.match(m.guidance.title,failed?/异常结束/:/讲解完成/);
  }
});

test('a paused jump tells the user that choosing will continue that jump', () => {
  const graph=fixture({main:[op('if',{arms:[{label:'yes',body:[]},{label:'no',body:[]}]})]}),p=new Player(graph);p.start('main');p.command('out');
  assert.equal(buildPresentation(graph,p).guidance.continuation,'选择后继续跳出函数');
});

test('leaving the entry offers recap rather than a nonexistent caller', () => {
  const graph=fixture({main:[]}),p=new Player(graph);p.start('main');p.step();
  assert.equal(p.current.type,'leave');
  assert.equal(buildPresentation(graph,p).guidance.action,'查看本次复盘');
});
