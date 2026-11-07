// SVG vocabulary inspired by Archify: grouped lanes, ports and orthogonal routes.
// Layout and models are local to repo2tree; no external renderer or network is needed.
export const xml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const textUnits = value => [...String(value)].reduce((n,c) => n + (c.charCodeAt(0)>255 ? 2 : 1), 0);
export function wrapLabel(value, units = 26, limit = 3) {
  const lines = []; let row = '', used = 0;
  for (const char of String(value ?? '').replace(/\s+/g, ' ').trim()) {
    const size = char.charCodeAt(0)>255 ? 2 : 1;
    if (used + size > units && row) {lines.push(row);row='';used=0;}
    row += char; used += size;
  }
  if (row || !lines.length) lines.push(row);
  return lines.length <= limit ? lines : [...lines.slice(0, limit - 1), lines[limit - 1].slice(0,-1) + '…'];
}
const textBlock = (label, x, y, classes = 'diagram-label', units = 26, limit = 3, anchor = 'middle') => {
  const lines = wrapLabel(label, units, limit);
  return `<text class="${classes}" text-anchor="${anchor}" x="${x}" y="${y}">${lines.map((line,i)=>`<tspan x="${x}" dy="${i?17:0}">${xml(line)}</tspan>`).join('')}</text>`;
};
const attrs = node => `data-diagram-node="${xml(node.id || '')}" data-diagram-symbol="${xml(node.symbol || node.id)}"${node.op ? ` data-diagram-op="${xml(node.op)}"` : ''}${Number.isInteger(node.index)?` data-diagram-seek="${node.index}"`:''} role="button" tabindex="0" aria-label="${xml(node.label)}"`;
const toneFor = kind => ['decision','if','cb','switch','loop'].includes(kind) ? 'branch' : ['exception','raise','boundary'].includes(kind) ? 'exception' : ['call','http'].includes(kind) ? 'call' : ['ret','return','cleanup','end'].includes(kind) ? 'return' : 'neutral';
const icon = (kind,x,y) => {
  const path = kind === 'decision' ? 'M8 1 15 8 8 15 1 8Z' : ['class','struct','interface'].includes(kind) ? 'M2 3h12v10H2ZM2 7h12M6 7v6' : 'm5 3-4 5 4 5m6-10 4 5-4 5M9 1 7 15';
  return `<path class="diagram-icon" d="${path}" transform="translate(${x},${y})"/>`;
};
function nodeSvg(node, rect, selected) {
  const {x,y,w,h}=rect, diamond=node.kind==='decision';
  const shape = diamond ? `<path class="diagram-shape" d="M${x+w/2} ${y} ${x+w} ${y+h/2} ${x+w/2} ${y+h} ${x} ${y+h/2}Z"/>`
    : `<rect class="diagram-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="${['start','end'].includes(node.kind)?h/2:12}"/>`;
  const caption=node.detail || (node.line ? `L${node.line} · ${node.kind}` : node.kind);
  const labelY=diamond ? y+h/2-6 : y+31;
  return `<g class="diagram-node ${selected===node.symbol || selected===node.id?'selected':''}" data-tone="${toneFor(node.kind)}" ${attrs(node)}><title>${xml(node.label)}${caption?'\n'+xml(caption):''}</title>${shape}${diamond?'':icon(node.kind,x+13,y+14)}${textBlock(node.label,x+w/2,labelY,'diagram-label',diamond?23:27,diamond?2:2)}${textBlock(caption,x+w/2,diamond?y+h/2+27:y+h-12,'diagram-caption',diamond?22:32,1)}<circle class="diagram-port" cx="${x+w/2}" cy="${y}" r="2.5"/><circle class="diagram-port" cx="${x+w/2}" cy="${y+h}" r="2.5"/></g>`;
}
function edgeSvg(edge, path, labelX, labelY, title = '') {
  const tone=edge.type==='exception'?'exception':edge.type==='return'?'return':edge.candidate?'branch':'neutral';
  const lines=wrapLabel(edge.label,32,2), width=Math.max(...lines.map(textUnits),0)*6.3+14;
  return `<g class="diagram-connection ${edge.candidate || edge.type==='return'?'dashed':''}" data-tone="${tone}"><title>${xml(title || edge.label || '继续')}</title><path class="diagram-wire" d="${path}" marker-end="url(#diagram-arrow)"/>${edge.label?`<rect class="diagram-edge-mask" x="${labelX-width/2}" y="${labelY-13}" width="${width}" height="${lines.length*17+3}" rx="4"/>${textBlock(edge.label,labelX,labelY,'diagram-edge-label',32,2)}`:''}</g>`;
}

function overviewSvg(model, {selected, page=0}) {
  const limit=24, pages=Math.max(1,Math.ceil(model.nodes.length/limit));page=Math.max(0,Math.min(pages-1,page));
  const shown=model.nodes.slice(page*limit,(page+1)*limit), visible=new Set(shown.map(n=>n.id));
  const groups=model.groups.map(g=>({...g,nodes:g.nodes.filter(n=>visible.has(n.id))})).filter(g=>g.nodes.length);
  const rects=new Map(), frames=[], groupOf=new Map();
  let y=34;
  for(let i=0;i<groups.length;i+=2) {
    const pair=groups.slice(i,i+2), rowH=Math.max(...pair.map(g=>g.nodes.length))*112+85;
    for(const [col,group] of pair.entries()) {
      const x=48+col*440, w=380;
      frames.push(`<g class="diagram-group"><rect x="${x}" y="${y}" width="${w}" height="${rowH-25}" rx="18"/>${textBlock(group.label,x+22,y+29,'diagram-group-label',43,1,'start')}</g>`);
      group.nodes.forEach((node,j)=>{rects.set(node.id,{x:x+54,y:y+58+j*112,w:272,h:82});groupOf.set(node.id,{id:group.id,x,y,w,h:rowH-25});});
    }
    y+=rowH+52;
  }
  const routes=[];let lane=0;
  for(const edge of model.edges) {
    const a=rects.get(edge.from),b=rects.get(edge.to);if(!a||!b)continue;
    const ag=groupOf.get(edge.from),bg=groupOf.get(edge.to), offset=(lane++%4)*7;
    let path,lx,ly;
    if(ag.id===bg.id) {
      const side=ag.x+ag.w-22-offset;
      path=`M${a.x+a.w} ${a.y+a.h/2}H${side}V${b.y+b.h/2}H${b.x+b.w}`;lx=side;ly=(a.y+b.y+a.h)/2;
    } else if(ag.y===bg.y) {
      const right=b.x>a.x, ax=right?a.x+a.w:a.x, bx=right?b.x:b.x+b.w;
      const middle=(ax+bx)/2+offset;
      path=`M${ax} ${a.y+a.h/2}H${middle}V${b.y+b.h/2}H${bx}`;lx=middle;ly=(a.y+b.y+a.h)/2;
    } else {
      const ax=ag.x+ag.w-16-offset,bx=bg.x+bg.w-16-offset, corridor=Math.max(ag.y+ag.h,bg.y+bg.h)+20+offset;
      path=`M${a.x+a.w} ${a.y+a.h/2}H${ax}V${corridor}H${bx}V${b.y+b.h/2}H${b.x+b.w}`;lx=(ax+bx)/2;ly=corridor-6;
    }
    const origins=[...new Set(edge.evidence.map(e=>`${e.origin} · ${e.status}`))].join('\n');
    routes.push(edgeSvg({...edge,label:''},path,lx,ly,`${edge.evidence.length} 条调用证据${edge.candidate?'，含待确认候选':''}\n${origins}`));
  }
  return {width:950,height:Math.max(260,y),pages,page,total:model.nodes.length,
    body:frames.join('')+routes.join('')+shown.map(n=>nodeSvg({...n,detail:`${n.kind} · ${n.members.length} 个归属符号`,symbol:n.id},rects.get(n.id),selected)).join('')};
}

function flowSvg(model, {focusNode}) {
  const outgoing=new Map(model.nodes.map(n=>[n.id,[]])),back=new Set(),visited=new Set(),active=new Set();
  for(const e of model.edges) outgoing.get(e.from)?.push(e);
  if(model.entry) {
    const stack=[{id:model.entry,offset:0}];visited.add(model.entry);active.add(model.entry);
    while(stack.length) {
      const frame=stack.at(-1),edges=outgoing.get(frame.id)||[];
      if(frame.offset>=edges.length){active.delete(frame.id);stack.pop();continue;}
      const edge=edges[frame.offset++];
      if(active.has(edge.to))back.add(edge);
      else if(!visited.has(edge.to)){visited.add(edge.to);active.add(edge.to);stack.push({id:edge.to,offset:0});}
    }
  }
  const degree=new Map(model.nodes.map(n=>[n.id,0])), ranks=new Map(model.nodes.map(n=>[n.id,0]));
  for(const e of model.edges)if(!back.has(e))degree.set(e.to,degree.get(e.to)+1);
  const queue=model.nodes.filter(n=>degree.get(n.id)===0).map(n=>n.id);
  for(let i=0;i<queue.length;i++)for(const e of outgoing.get(queue[i])||[]){if(back.has(e))continue;ranks.set(e.to,Math.max(ranks.get(e.to),ranks.get(e.from)+1));degree.set(e.to,degree.get(e.to)-1);if(!degree.get(e.to))queue.push(e.to);}
  const rows=new Map();for(const n of model.nodes){const rank=ranks.get(n.id);if(!rows.has(rank))rows.set(rank,[]);rows.get(rank).push(n);}
  const maxColumns=Math.max(1,...[...rows.values()].map(row=>row.length)),width=Math.max(720,maxColumns*320+120),rects=new Map();
  for(const [rank,row]of rows)row.forEach((n,i)=>rects.set(n.id,{x:(width-row.length*320)/2+i*320+40,y:42+rank*180,w:240,h:n.kind==='decision'?112:88}));
  let backLane=0;
  const wires=model.edges.map(e=>{
    const a=rects.get(e.from),b=rects.get(e.to);if(!a||!b)return'';
    let path,lx,ly;
    if(back.has(e)||b.y<=a.y){const lane=24+(backLane++%5)*13;path=`M${a.x} ${a.y+a.h/2}H${lane}V${b.y+b.h/2}H${b.x}`;lx=lane+70;ly=a.y+a.h/2-8;}
    else if(b.y>a.y+180){const lane=width+190-(backLane++%4)*13;path=`M${a.x+a.w} ${a.y+a.h/2}H${lane}V${b.y+b.h/2}H${b.x+b.w}`;lx=width+75;ly=a.y+a.h/2-7;}
    else {const middle=a.y+a.h+26;path=`M${a.x+a.w/2} ${a.y+a.h}V${middle}H${b.x+b.w/2}V${b.y}`;lx=(a.x+b.x+a.w)/2;ly=middle-7;}
    return edgeSvg(e,path,lx,ly);
  }).join('');
  return {width:width+240,height:Math.max(260,(Math.max(0,...ranks.values())+1)*180+35),pages:1,page:0,total:model.nodes.length,
    body:wires+model.nodes.map(n=>nodeSvg(n,rects.get(n.id),n.id===focusNode?n.id:null)).join('')};
}

function sequenceSvg(model, {selected, page=0}) {
  const limit=36,pages=Math.max(1,Math.ceil(model.messages.length/limit));page=Math.max(0,Math.min(pages-1,page));
  const messages=model.messages.slice(page*limit,(page+1)*limit),ids=new Set(messages.flatMap(m=>[m.from,m.to]));
  const participants=model.participants.filter(p=>ids.has(p.id));
  const width=Math.max(740,participants.length*210+70),height=160+messages.length*82;
  const positions=new Map(participants.map((p,i)=>[p.id,140+i*210]));
  const headers=participants.map(p=>{
    const x=positions.get(p.id), start=Math.max(0,p.start-page*limit),end=p.end==null?messages.length:Math.min(messages.length,p.end-page*limit);
    const activation=end>=0&&start<=messages.length?`<rect class="diagram-activation" x="${x-5}" y="${130+start*82}" width="10" height="${Math.max(8,(end-start)*82)}" rx="3"/>`:'';
    return `<path class="diagram-lifeline" d="M${x} 102V${height-24}"/>${activation}${nodeSvg({id:p.symbol,symbol:p.symbol,label:p.label,kind:'function',index:p.index,detail:`调用帧 #${p.id}`},{x:x-91,y:20,w:182,h:82},selected)}`;
  }).join('');
  const rows=messages.map((m,i)=>{
    const a=positions.get(m.from),b=positions.get(m.to),y=142+i*82;
    if(m.type==='note' || a===b) {
      const label=m.label;
      return `<g class="diagram-note" data-tone="${toneFor(m.tone||m.type)}" ${attrs({...m,label})}><title>${xml(label)}</title><rect x="${a+14}" y="${y-18}" width="178" height="65" rx="9"/>${textBlock(label,a+26,y,'diagram-note-label',24,3,'start')}<text class="diagram-index" x="${a-20}" y="${y}">${m.index+1}</text></g>`;
    }
    return `<g ${attrs(m)} class="diagram-message"><title>${xml(m.label)} · 第 ${m.index+1} 个事件</title>${edgeSvg(m,`M${a} ${y}H${b}`, (a+b)/2, y-9)}<circle class="diagram-event-dot" cx="${a}" cy="${y}" r="3"/><text class="diagram-index" x="${Math.min(a,b)+8}" y="${y+19}">${m.index+1}</text></g>`;
  }).join('');
  return {width:width+90,height,pages,page,total:model.messages.length,body:headers+rows};
}

export function renderDiagram(model, options = {}) {
  const result=model.type==='overview'?overviewSvg(model,options):model.type==='sequence'?sequenceSvg(model,options):flowSvg(model,options);
  const background=`<defs><pattern id="diagram-grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" class="diagram-grid-dot"/></pattern><marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" class="diagram-arrow"/></marker></defs><rect class="diagram-surface" width="100%" height="100%" rx="18"/><rect width="100%" height="100%" fill="url(#diagram-grid)"/>`;
  return {...result,svg:`<svg id="diagram-svg" xmlns="http://www.w3.org/2000/svg" class="code-diagram" viewBox="0 0 ${result.width} ${result.height}" width="${result.width}" height="${result.height}" role="group" aria-label="${xml(model.title)}"><title>${xml(model.title)}</title>${background}${result.body}</svg>`};
}
