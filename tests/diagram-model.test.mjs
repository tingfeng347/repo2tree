import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProjectModel} from '../web/project-model.js';
import {overviewModel,sequenceModel,flowModel} from '../web/diagram-model.js';
import {Player} from '../web/engine.js';
const demo=()=>JSON.parse(readFileSync(new URL('../examples/demo.project.json',import.meta.url)));
let serial=0;
const op=(kind,fields={})=>({id:`op-${++serial}`,kind,text:kind,line:serial,...fields});
const fixture=flows=>({nodes:Object.keys(flows).map(id=>({id,name:id,kind:'function',path:'app.py'})),flows,snapshot:{id:'test'}});
const find=(model,operation)=>model.nodes.find(n=>n.op===operation.id);
const follow=(model,id)=>model.edges.filter(e=>e.from===id).map(e=>model.nodes.find(n=>n.id===e.to));

test('overview groups real classes and functions by file, retains candidate evidence',()=>{
  const graph=demo(),before=JSON.stringify(graph),project=createProjectModel(graph),model=overviewModel(project);
  assert.equal(model.groups.length,2);
  const service=model.nodes.find(n=>n.name==='OrderService');
  const create=graph.nodes.find(n=>n.name==='create');
  assert.equal(model.owners.get(create.id),service.id);
  assert(service.members.includes(create.id));
  assert(model.edges.some(e=>e.candidate));
  assert(model.edges.every(e=>e.evidence.length>0));
  assert.equal(JSON.stringify(graph),before);
});

test('sequence waits for entered invocations and never treats pending targets as calls',()=>{
  const call=op('call',{targets:[{id:'child',status:'indexed'}]});
  const graph=fixture({main:[call],child:[]}),player=new Player(graph);player.start('main');player.step();
  const pending=sequenceModel(graph,player);
  assert.equal(pending.participants.length,1);assert(!pending.messages.some(m=>m.type==='return'));
  player.step();assert.equal(sequenceModel(graph,player).participants.length,2);
});

test('sequence preserves recursive invocation identities and excludes future events on rewind',()=>{
  const graph=fixture({main:[]});
  const frame=(invocation)=>({symbol:'main',invocation});
  const player={cursor:2,history:[
    {type:'enter',symbol:'main',stack:[frame(1)]},
    {type:'enter',symbol:'main',stack:[frame(1),frame(2)]},
    {type:'ret',symbol:'main',text:'return 1',stack:[frame(1),frame(2)]},
    {type:'leave',symbol:'main',stack:[frame(1),frame(2)]}
  ]};
  let model=sequenceModel(graph,player);
  assert.deepEqual(model.participants.map(p=>p.id),[1,2]);
  assert(!model.messages.some(m=>m.type==='return'));
  player.cursor=3;model=sequenceModel(graph,player);assert(model.messages.some(m=>m.type==='return'&&m.from===2&&m.to===1));
  player.cursor=0;assert.equal(sequenceModel(graph,player).participants.length,1);
});

test('flow branches retain empty exits; return and raise never fall through to later statements',()=>{
  const ret=op('ret'),unreachable=op('stmt',{text:'not reached'}),branch=op('if',{arms:[{label:'yes',body:[ret,unreachable]},{label:'no',body:[]}]});
  const after=op('stmt',{text:'after branch'}),model=flowModel(fixture({main:[branch,after]}),'main');
  assert(!find(model,unreachable));
  assert(follow(model,find(model,ret).id).every(n=>n.kind==='end'));
  const no=model.edges.find(e=>e.from===find(model,branch).id&&e.label==='no');
  assert.equal(model.nodes.find(n=>n.id===no.to).op,after.id);
});

test('loop break bypasses loop else and continue passes through the increment',()=>{
  const br=op('break'),cont=op('continue'),inc=op('stmt',{text:'increment'}),after=op('stmt',{text:'after loop'}),otherwise=op('stmt',{text:'loop else'});
  const branch=op('if',{arms:[{label:'break',body:[br]},{label:'continue',body:[cont]}]});
  const loop=op('loop',{body:[branch],incrementBody:[inc],elseBody:[otherwise]});
  const model=flowModel(fixture({main:[loop,after]}),'main');
  assert.equal(follow(model,find(model,br).id)[0].op,after.id);
  assert.equal(follow(model,find(model,cont).id)[0].op,inc.id);
  assert.equal(follow(model,find(model,inc).id)[0].op,loop.id);
});

test('return traverses finally and a return in finally overrides a pending exception',()=>{
  const ret=op('ret'),clean=op('stmt',{text:'audit'}),tri=op('try',{body:[ret],finallyBody:[clean]});
  const model=flowModel(fixture({main:[tri]}),'main');
  const gate=follow(model,find(model,ret).id)[0];assert.equal(gate.kind,'cleanup');
  assert.equal(follow(model,gate.id)[0].op,clean.id);
  const thrown=op('raise'),override=op('ret'),over=flowModel(fixture({main:[op('try',{body:[thrown],finallyBody:[override]})]}),'main');
  assert(!over.nodes.some(n=>n.label==='异常向外传播'));
  assert(follow(over,find(over,override).id).every(n=>n.kind==='end'));
});

test('try else and handler exceptions bypass the same handler and still run finally',()=>{
  const thrownElse=op('raise',{text:'else failure'}),handled=op('raise',{text:'handler failure'}),cleanup=op('stmt',{text:'cleanup'});
  const model=flowModel(fixture({main:[op('try',{body:[op('call',{targets:[]})],elseBody:[thrownElse],handlers:[{label:'catch',body:[handled]}],finallyBody:[cleanup]})]}),'main');
  for(const operation of [thrownElse,handled]){
    const next=follow(model,find(model,operation).id)[0];assert.equal(next.kind,'cleanup');
    assert(!next.label.includes('选择异常处理器'));
  }
  assert(model.nodes.some(n=>n.label==='选择异常处理器'));
});

test('cleanup retains loop control through nested try contexts',()=>{
  const cont=op('continue'),br=op('break'),clean=op('stmt',{text:'cleanup'}),inc=op('stmt',{text:'increment'});
  const tri=op('try',{body:[op('if',{arms:[{label:'continue',body:[cont]},{label:'break',body:[br]}]})],finallyBody:[clean]});
  const model=flowModel(fixture({main:[op('loop',{body:[tri],incrementBody:[inc]})]}),'main');
  assert.equal(follow(model,find(model,cont).id)[0].kind,'cleanup');
  assert.equal(follow(model,find(model,br).id)[0].kind,'cleanup');
  assert(model.nodes.filter(n=>n.op===clean.id).length>=2);
});

test('unsupported functions and opaque operations remain visible boundaries',()=>{
  assert(flowModel(fixture({main:[]}), 'missing').unsupported);
  const opaque=op('opaque',{text:'unknown syntax'}),model=flowModel(fixture({main:[opaque]}),'main');
  assert.equal(find(model,opaque).kind,'boundary');
  assert(model.edges.some(e=>e.from===find(model,opaque).id&&e.candidate));
});


test('unknown calls stay explicit boundaries and candidate calls keep their evidence label',()=>{
  const unknown=op('call',{text:'unresolved_external()',targets:[],resolution:'unresolved'});
  const candidate=op('call',{text:'dynamic()',targets:[{id:'other',status:'candidate',origin:'name-candidate'}]});
  const model=flowModel(fixture({main:[unknown,candidate],other:[]}),'main');
  assert.equal(find(model,unknown).kind,'boundary');
  assert.match(find(model,unknown).detail,/未解析.*边界/);
  assert.match(find(model,candidate).detail,/候选待确认/);
});
