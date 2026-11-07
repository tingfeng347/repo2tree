import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProjectModel} from '../web/project-model.js';
const demo = () => JSON.parse(readFileSync(new URL('../examples/demo.project.json', import.meta.url)));
const fixture = () => ({schemaVersion:1, root:'root', snapshot:{id:'test'}, project:{name:'fixture'},
  nodes:[{id:'root', name:'root', kind:'project'}, {id:'a', name:'a', kind:'function', parent:'root'}, {id:'b', name:'b', kind:'function', parent:'root'}],
  flows:{}, edges:[], entries:[], diagnostics:[], stats:{}, sources:{}});

test('projects every shipped structural symbol exactly once without mutating the snapshot', () => {
  const graph = demo(), before = JSON.stringify(graph), model = createProjectModel(graph);
  const ids = [...model.children.values()].flat();
  assert.equal(new Set(ids).size, ids.length);
  for (const n of graph.nodes.filter(n => ['function', 'method', 'lambda', 'class', 'file', 'directory'].includes(n.kind))) assert(ids.includes(n.id), n.id);
  assert.equal(JSON.stringify(graph), before);
  for (const edge of model.edges) {
    assert(model.outgoing.get(edge.source).includes(edge));
    assert(model.incoming.get(edge.target).includes(edge));
  }
});

test('same-named functions, hidden parents and orphaned symbols keep distinct stable IDs', () => {
  const graph = fixture();
  graph.nodes.push({id:'hidden', name:'x', kind:'variable', parent:'a'}, {id:'nested', name:'b', kind:'function', parent:'hidden'}, {id:'orphan', name:'b', kind:'function', parent:'missing'});
  const model = createProjectModel(graph);
  assert.deepEqual(model.children.get('a'), ['nested']);
  assert(model.children.get('root').includes('orphan'));
  assert.deepEqual(model.ancestors('nested'), ['nested', 'hidden', 'a', 'root']);
  assert(model.nodes.has('hidden'));
});

test('call sites and candidate evidence survive pair aggregation and missing targets remain boundaries', () => {
  const graph = fixture();
  graph.edges = [{source:'a', target:'b', kind:'calls', line:1, status:'indexed', origin:'codegraph'},
    {source:'a', target:'b', kind:'calls', line:2, status:'indexed', origin:'codegraph'},
    {source:'a', target:'missing', kind:'calls'}];
  graph.flows.a = [{kind:'if', arms:[{body:[{kind:'call', line:2, targets:[{id:'b', status:'candidate', origin:'name-candidate'}]}]}]}];
  const model = createProjectModel(graph);
  assert.equal(model.outgoing.get('a').length, 3);
  assert.equal(model.incoming.get('b').filter(e => e.status === 'candidate').length, 1);
  assert.equal(graph.edges.length, 3, 'raw unresolved evidence is retained in the snapshot');
});

test('duplicate IDs, ancestry cycles, invalid roots and unsupported schema are rejected before use', () => {
  const cases = [null, {...fixture(), schemaVersion:2}, {...fixture(), root:'missing'}];
  const duplicate = fixture(); duplicate.nodes.push({...duplicate.nodes[1]}); cases.push(duplicate);
  const cyclic = fixture(); cyclic.nodes[1].parent='b'; cyclic.nodes[2].parent='a'; cases.push(cyclic);
  const rootParent = fixture(); rootParent.nodes[0].parent='a'; cases.push(rootParent);
  for (const graph of cases) assert.throws(() => createProjectModel(graph), /项目快照/);
});

test('the projected parent chain skips hidden nodes and attaches orphans to the root', () => {
  const graph = fixture();
  graph.nodes.push({id:'hidden', name:'metadata', kind:'variable', parent:'a'},
    {id:'nested', name:'nested', kind:'function', parent:'hidden'},
    {id:'orphan', name:'orphan', kind:'function', parent:'unknown'});
  const model = createProjectModel(graph);
  assert.equal(model.parents.get('nested'), 'a');
  assert.equal(model.parents.get('orphan'), 'root');
  assert(!model.parents.has('root'));
});

test('the same indexed call imported from graph and flow counts as one evidence', () => {
  const graph=fixture();
  graph.edges=[{source:'a',target:'b',kind:'calls',line:12,column:4,origin:'codegraph',status:'indexed'}];
  graph.flows.a=[{kind:'call',line:12,column:4,targets:[{id:'b',origin:'codegraph',status:'indexed'}]}];
  assert.equal(createProjectModel(graph).edges.length,1);
  graph.flows.a.push({kind:'call',line:13,column:4,targets:[{id:'b',origin:'codegraph',status:'indexed'}]});
  graph.flows.a.push({kind:'call',line:12,column:4,targets:[{id:'b',origin:'name-candidate',status:'candidate'}]});
  assert.equal(createProjectModel(graph).edges.length,3);
});
