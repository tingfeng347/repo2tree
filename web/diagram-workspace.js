import {functionKinds, walkFlow} from './project-model.js';
import {overviewModel, sequenceModel, flowModel} from './diagram-model.js';
import {renderDiagram, xml} from './diagram-svg.js';

export const diagramViews = new Set(['overview', 'sequence', 'flow']);
const cache = new WeakMap();

/** DOM adapter for all diagram views; the player remains owned by the workspace. */
export class DiagramWorkspace {
  constructor(host, {onSelect, download}) {
    this.host=host;this.onSelect=onSelect;this.download=download;this.page=0;this.detail=null;this.zoom=new Map();
    host.addEventListener('click', event => this.click(event));
    host.addEventListener('keydown', event => {
      const node=event.target.closest('[data-diagram-symbol]');
      if(node && ['Enter',' '].includes(event.key)){event.preventDefault();node.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
    });
    host.addEventListener('wheel', event => {
      if(!event.ctrlKey&&!event.metaKey)return;
      event.preventDefault();this.setZoom((this.zoom.get(this.state.view)||1)*(event.deltaY>0?.9:1.1));
    },{passive:false});
    host.addEventListener('pointerdown', event => {
      const scroller=event.target.closest('.diagram-scroll');if(!scroller||!event.altKey||event.button!==0)return;
      event.preventDefault();this.drag={scroller,x:event.clientX,y:event.clientY,left:scroller.scrollLeft,top:scroller.scrollTop};
      scroller.setPointerCapture(event.pointerId);scroller.classList.add('panning');
    });
    host.addEventListener('pointermove', event => {const d=this.drag;if(d){d.scroller.scrollLeft=d.left+d.x-event.clientX;d.scroller.scrollTop=d.top+d.y-event.clientY;}});
    const end=()=>{this.drag?.scroller.classList.remove('panning');this.drag=null;};
    host.addEventListener('pointerup',end);host.addEventListener('pointercancel',end);
  }
  reset() {this.page=0;this.detail=null;this.zoom.clear();this.renderedKey=null;}
  operation(graph, symbol) {
    let found;
    if(this.detail?.symbol===symbol&&this.detail.op)walkFlow(graph.flows[symbol],op=>{if(op.id===this.detail.op)found=op;});
    return found;
  }
  render(state) {
    this.state=state;
    const {graph,project,player,view,selected}=state;
    let cached=cache.get(graph);if(!cached){cached=new Map();cache.set(graph,cached);}
    let model;
    if(view==='overview') {
      if(!cached.has('overview'))cached.set('overview',overviewModel(project));
      model=cached.get('overview');
    } else if(view==='sequence')model=sequenceModel(graph,player);
    else {
      const symbol=functionKinds.has(project.nodes.get(selected)?.kind)?selected:player.current?.stack?.at(-1)?.symbol||player.entry;
      const key=`flow:${symbol}`;
      if(!cached.has(key))cached.set(key,flowModel(graph,symbol));
      model=cached.get(key);
    }
    const host=this.host, active=host.contains(document.activeElement)?document.activeElement:null;
    const focus=active?Object.fromEntries([...active.attributes].filter(a=>a.name.startsWith('data-diagram-')).map(a=>[a.name,a.value])):null;
    if(model.unsupported||view==='sequence'&&!model.messages.length||view==='overview'&&!model.nodes.length) {
      host.innerHTML=`<div class="diagram-empty"><h2>${view==='sequence'?'先记录一段讲解路径':view==='flow'?'选择一个已适配的函数':'尚无可绘制的类或函数'}</h2><p>${view==='sequence'?'选择入口并推进几步，调用实例、返回与选择就会出现在时序图中。导入已有场景也可查看完整时序。':view==='flow'?'从左侧选择函数。尚未提取控制流的语言可浏览全景和调用关系。':'打开一个项目或导入项目快照后再查看。'}</p>${view==='sequence'?'<button data-view="journey">选择演示入口</button>':''}</div>`;
      this.result=null;return;
    }
    const old=host.querySelector('.diagram-scroll'),scroll={x:old?.scrollLeft||0,y:old?.scrollTop||0};
    this.result=renderDiagram(model,{selected,focusNode:this.detail?.node,page:this.page});this.page=this.result.page;
    const {pages,total}=this.result;
    host.innerHTML=`<header class="diagram-heading"><div><h2>${xml(model.title)}</h2><p>${xml(model.subtitle)}</p></div></header><div class="diagram-tools" aria-label="图表工具"><button data-diagram-fit>适应</button><button data-diagram-zoom="1">100%</button><button data-diagram-scale="0.8" aria-label="缩小图表">−</button><output id="diagram-zoom"></output><button data-diagram-scale="1.25" aria-label="放大图表">+</button><button data-diagram-export>导出 SVG</button>${pages>1?`<button data-diagram-page="-1" ${this.page===0?'disabled':''}>上一页</button><button data-diagram-page="1" ${this.page===pages-1?'disabled':''}>下一页</button>`:''}<span class="diagram-count">${pages>1?`${this.page+1}/${pages} 页 · `:''}${total} ${view==='sequence'?'条事件':'个节点'}</span></div><div class="diagram-scroll" tabindex="0" role="region" aria-label="${xml(model.title)}画布，滚动查看，按住 Alt 拖动平移">${this.result.svg}</div>`;
    const scroller=host.querySelector('.diagram-scroll');
    if(!this.zoom.has(view))this.zoom.set(view,view==='sequence'?1:Math.max(.85,Math.min(1,(scroller.clientWidth-36)/this.result.width)));
    this.setZoom(this.zoom.get(view));scroller.scrollLeft=scroll.x;scroller.scrollTop=scroll.y;
    const renderKey=`${view}:${model.symbol||''}:${this.page}`;
    if(view==='flow'&&this.renderedKey!==renderKey) {
      const entry=[...host.querySelectorAll('[data-diagram-node]')].find(n=>n.dataset.diagramNode===model.entry);
      if(entry){const rect=entry.getBoundingClientRect(),canvas=scroller.getBoundingClientRect();scroller.scrollLeft+=rect.x+rect.width/2-canvas.x-canvas.width/2;scroller.scrollTop=0;}
    }
    this.renderedKey=renderKey;
    if(focus) {
      const match=Object.keys(focus).length?[...host.querySelectorAll('[tabindex],button')].find(el=>!el.disabled&&Object.entries(focus).every(([key,value])=>el.getAttribute(key)===value)):null;
      (match||scroller).focus({preventScroll:true});
    }
  }
  setZoom(scale) {
    if(!this.result)return;
    scale=Math.max(.15,Math.min(3,scale));this.zoom.set(this.state.view,scale);
    const svg=this.host.querySelector('#diagram-svg');
    if(svg){svg.style.width=`${this.result.width*scale}px`;svg.style.height=`${this.result.height*scale}px`;}
    const label=this.host.querySelector('#diagram-zoom');if(label)label.textContent=`${Math.round(scale*100)}%`;
  }
  fit() {
    const scroller=this.host.querySelector('.diagram-scroll');
    if(scroller&&this.result){this.setZoom(Math.min((scroller.clientWidth-36)/this.result.width,(scroller.clientHeight-36)/this.result.height));scroller.scrollTop=0;scroller.scrollLeft=0;}
  }
  click(event) {
    const node=event.target.closest('[data-diagram-symbol]');
    if(node){this.detail={symbol:node.dataset.diagramSymbol,op:node.dataset.diagramOp,node:node.dataset.diagramNode};this.onSelect({...this.detail,seek:node.dataset.diagramSeek});return;}
    const button=event.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-diagram-fit'))this.fit();
    if(button.dataset.diagramZoom)this.setZoom(Number(button.dataset.diagramZoom));
    if(button.dataset.diagramScale)this.setZoom((this.zoom.get(this.state.view)||1)*Number(button.dataset.diagramScale));
    if(button.dataset.diagramPage){this.page+=Number(button.dataset.diagramPage);this.render(this.state);this.host.querySelector('.diagram-scroll').scrollTop=0;}
    if(button.hasAttribute('data-diagram-export'))this.exportSvg();
  }
  exportSvg() {
    const svg=this.host.querySelector('#diagram-svg').cloneNode(true);svg.removeAttribute('style');
    const sheet=[...document.querySelector('#diagram-styles').sheet.cssRules].map(rule=>rule.cssText).join('\n');
    const computed=getComputedStyle(document.documentElement),vars=[...computed].filter(key=>key.startsWith('--')).map(key=>`${key}:${computed.getPropertyValue(key)}`).join(';');
    const style=document.createElementNS('http://www.w3.org/2000/svg','style');const tones=['call','branch','return','exception'].map(tone=>`[data-tone=${tone}]{--tone-bg:var(--tone-${tone}-bg);--tone-text:var(--tone-${tone}-text);--tone-border:var(--tone-${tone}-border)}`).join('');
    style.textContent=`svg{${vars}}${tones}${sheet}`;svg.prepend(style);
    this.download(`repo2tree-${this.state.view}.svg`,new XMLSerializer().serializeToString(svg),'image/svg+xml;charset=utf-8');
  }
  description() {
    const {graph,project,selected,view}=this.state||{},node=project?.nodes.get(selected);
    if(!node)return '<p class="empty">点击树或图中的节点查看说明。</p>';
    const op=this.operation(graph,selected),outgoing=project.outgoing.get(selected)||[],incoming=project.incoming.get(selected)||[];
    const targets=op?.targets||outgoing.map(e=>({id:e.target,origin:e.origin,status:e.status}));
    const unique=[...new Map(targets.map(t=>[JSON.stringify([t.id,t.origin,t.status]),t])).values()];
    const label=id=>project.nodes.get(id)?.qualifiedName||project.nodes.get(id)?.name||id;
    return `<h3>${xml(label(selected))}</h3><p>${xml(node.kind)} · ${xml(node.path||'项目根')}${op?.line||node.line?` · L${op?.line||node.line}`:''}</p><p>${xml(node.origin||'快照')} · ${xml(node.flowStatus||'结构符号')}</p>${op?`<code>${xml(op.text)}</code>`:`<p>${incoming.length} 条入向证据 · ${outgoing.length} 条出向证据</p>`}<div class="symbol-targets">${unique.map(t=>`<button data-symbol="${xml(t.id)}">${xml(label(t.id))}<br><small>${xml(t.origin)} · ${t.status==='indexed'?'已索引':'候选待确认'}</small></button>`).join('')}</div><p class="diagram-source-note">${view==='sequence'?'时序来自本次手动假设路径；点选消息可回到对应事件。':'实线为结构连接，虚线保留候选或可能的异常路径；条件不会自动求值。'}</p>`;
  }
}
