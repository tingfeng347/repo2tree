import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {flowModel} from '../web/diagram-model.js';
import {renderDiagram,wrapLabel} from '../web/diagram-svg.js';
const demo=()=>JSON.parse(readFileSync(new URL('../examples/demo.project.json',import.meta.url)));
let serial=0;
const op=(kind,fields={})=>({id:`op-${++serial}`,kind,text:kind,line:serial,...fields});
const fixture=flows=>({nodes:Object.keys(flows).map(id=>({id,name:id,kind:'function',path:'app.py'})),flows,snapshot:{id:'test'}});

test('SVG escapes source text and keeps actual model identifiers out of DOM IDs',()=>{
  const operation=op('stmt',{text:'</text><script>alert("x")</script>'}),model=flowModel(fixture({'main"<>':[operation]}),'main"<>');
  const svg=renderDiagram(model).svg;
  assert(!svg.includes('<script>'));assert(svg.includes('&lt;script&gt;'));
  assert(!svg.includes('NaN'));assert(!svg.includes('Infinity'));
  assert(svg.includes('data-diagram-op='));
  assert.equal(wrapLabel('中文文本和LongIdentifier',10,2).length,2);
});

test('every demo function produces finite SVG geometry with reachable edge endpoints',()=>{
  const graph=demo();
  for(const id of Object.keys(graph.flows)){
    const model=flowModel(graph,id),ids=new Set(model.nodes.map(n=>n.id)),result=renderDiagram(model);
    assert(model.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));
    assert(Number.isFinite(result.height)&&result.height>0);
    assert(!result.svg.includes('NaN'),id);
  }
});

test('a large linear function renders without recursive layout traversal overflow',()=>{
  const graph=fixture({main:Array.from({length:5000},(_,i)=>op('stmt',{text:`statement ${i}`}))});
  const model=flowModel(graph,'main'),rendered=renderDiagram(model);
  assert.equal(model.nodes.length,5002);
  assert(Number.isFinite(rendered.height));
  assert(!rendered.svg.includes('NaN'));
});
