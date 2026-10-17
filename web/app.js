import { Player, allDecisions } from './engine.js';
import { buildPresentation, eventNames, eventTone } from './presentation.js';
import { highlightCode, sourceDocument, clearSyntaxCache } from './syntax.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const functionKinds = new Set(['function', 'method', 'constructor', 'lambda', 'closure']);
const kindNames = { project: '项目', directory: '目录', file: '模块', module: '模块', class: '类', struct: '结构体', function: '函数', method: '方法', constructor: '构造', lambda: '匿名函数', interface: '接口' };
const code = (text, id) => { const node = nodes?.get(id); return highlightCode(text, node?.path, node?.language); };
let graph, player, nodes, children, visualEdges, selected, scope, view = 'journey', panel = 'step', callsAnchor;
let journeyEvent = '';
const journeyDetails = new Set();
let entryLimit = 80, mapPage = 0, sourceKey = '', saved = [], saveCoverage = new Map();
let playing = false, playToken = 0, resumePlayback = false, projectBusy = false;
let box = { x: 0, y: 0, w: 1100, h: 660 };
const svgNS = 'http://www.w3.org/2000/svg';

function notify(message, error = false) {
  $('#notice').hidden = !message; $('#notice').textContent = message;
  $('#notice').classList.toggle('error-text', error);
}
function localGet(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function localSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notify('浏览器存储空间不足；可导出场景文件保存。'); } }
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('#theme-label').textContent = light ? '暗色' : '亮色';
  $('#theme-toggle').setAttribute('aria-label', light ? '切换到暗色模式' : '切换到亮色模式');
  $('#theme-toggle').title = light ? '切换到暗色模式' : '切换到亮色模式';
}
applyTheme(document.documentElement.dataset.theme);
$('#theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  try { localStorage.setItem('repo2tree:theme', theme); } catch { /* theme remains usable without storage */ }
};
window.addEventListener('storage', event => { if (event.key === 'repo2tree:theme') applyTheme(event.newValue); });
const projectKey = () => `repo2tree:v1:${graph.snapshot.id}`;
const label = id => nodes.get(id)?.qualifiedName || nodes.get(id)?.name || id || '';
const isFunction = id => functionKinds.has(nodes.get(id)?.kind);
const structuralKinds = new Set(['project', 'directory', 'file', 'module', 'namespace', 'class', 'struct', 'interface', 'enum', ...functionKinds]);
const ancestors = id => player.ancestors(id);
function walk(ops, fn) { for (const op of ops || []) { fn(op); for (const k of ['body', 'elseBody', 'finallyBody', 'conditionBody', 'incrementBody']) walk(op[k], fn); for (const k of ['arms', 'handlers']) for (const arm of op[k] || []) walk(arm.body, fn); } }

function loadGraph(data) {
  if (data.schemaVersion !== 1 || !Array.isArray(data.nodes) || !data.flows || typeof data.snapshot?.id !== 'string' || !Array.isArray(data.edges) || !Array.isArray(data.entries) || !Array.isArray(data.diagnostics) || !data.stats || !data.sources || typeof data.project?.name !== 'string' || !data.nodes.some(n => n.id === data.root) || data.nodes.some(n => typeof n.id !== 'string' || typeof n.name !== 'string' || typeof n.kind !== 'string') || Object.values(data.flows).some(flow => !Array.isArray(flow))) throw new Error('项目快照格式不支持；请用 repo2tree scan 重新生成。');
  pause(); resumePlayback = false; journeyDetails.clear(); view = 'journey'; clearSyntaxCache(); graph = data; player = new Player(graph); nodes = player.nodes; children = new Map();
  for (const n of graph.nodes.filter(n => structuralKinds.has(n.kind))) {
    const parent = player.ancestors(n.parent).find(id => structuralKinds.has(nodes.get(id)?.kind)) || n.parent;
    if (!children.has(parent)) children.set(parent, []); children.get(parent).push(n.id);
  }
  for (const ids of children.values()) ids.sort((a, b) => {
    const rank = id => (children.get(id)?.length ? 0 : isFunction(id) ? 1 : 2);
    return rank(a) - rank(b) || label(a).localeCompare(label(b));
  });
  const seen = new Map();
  for (const e of graph.edges || []) if (['calls', 'instantiates'].includes(e.kind) && nodes.has(e.source) && nodes.has(e.target)) seen.set(`${e.source}:${e.target}`, e);
  for (const [id, ops] of Object.entries(graph.flows)) walk(ops, op => { for (const t of op.targets || []) seen.set(`${id}:${t.id}`, { source: id, target: t.id, kind: op.kind, status: t.status, origin: t.origin, line: op.line }); });
  visualEdges = [...seen.values()];
  scope = graph.root; selected = graph.root; callsAnchor = graph.root; mapPage = 0; sourceKey = ''; box = { x: 0, y: 0, w: 1100, h: 660 };
  const bp = localGet(projectKey() + ':breakpoints', {});
  player.breakpoints = new Set(Array.isArray(bp.functions) ? bp.functions : []);
  player.lineBreakpoints = new Set(Array.isArray(bp.lines) ? bp.lines : []);
  saved = localGet(projectKey() + ':scenarios', []); if (!Array.isArray(saved)) saved = [];
  saved = saved.filter(s => s.snapshot === graph.snapshot.id).slice(0, 30); saveCoverage.clear();
  $('#project-name').textContent = graph.project.name;
  $('#project-path').value = graph.project.path;
  $('#snapshot-label').textContent = graph.snapshot.id.slice(0, 7);
  $('#summary').textContent = `${graph.stats.files} 文件 · ${graph.stats.functions} 函数 · ${graph.stats.structuredFunctions} 已提取控制流`;
  $('#symbol-count').textContent = `${graph.nodes.length} 符号`;
  $('#scenario-title').value = '正常流程';
  $('#scenario-input').value = '{}';
  $('#search').value = ''; $('#entry-filter').value = 'all'; entryLimit = 80;
  renderEntries(); renderTree(); renderScenarios(); render();

}

function renderEntries() {
  const query = $('#search').value.trim().toLowerCase(), filter = $('#entry-filter').value;
  const entries = (graph.entries || []).filter(e => (filter === 'all' || e.kind === filter) && `${e.label} ${nodes.get(e.id)?.path}`.toLowerCase().includes(query));
  $('#entries').innerHTML = entries.length ? entries.slice(0, entryLimit).map(e => `<button class="entry ${player.entry === e.id ? 'selected' : ''}" data-entry="${escape(e.id)}" title="${escape(nodes.get(e.id)?.path)}"><small class="${e.kind}">${e.kind === 'api' ? 'API' : e.kind === 'frontend' ? 'UI' : 'fn'}</small><span class="entry-label">${escape(e.label)}</span></button>`).join('') + (entries.length > entryLimit ? `<button class="more-button" id="more-entries">再显示 80 项（共 ${entries.length}）</button>` : `<div class="entry-count">${entries.length} 个入口，均可单独演示</div>`) : '<p class="empty">没有匹配的入口。可切换“全部入口”或更换搜索词。</p>';
}
function treeNode(id) {
  const n = nodes.get(id); if (!n) return '';
  const button = `<button role="treeitem" class="${selected === id ? 'selected' : ''}" data-symbol="${escape(id)}" title="${escape(n.path)}"><span class="kind ${escape(n.kind)}">${escape(kindNames[n.kind] || n.kind)}</span><span>${escape(n.name)}</span>${player.breakpoints.has(id) ? '<span class="bp-dot">●</span>' : ''}</button>`;
  return children.get(id)?.length ? `<details data-tree="${escape(id)}"><summary>${button}</summary><div class="tree-children"></div></details>` : button;
}
function renderTree() {
  $('#tree').innerHTML = (children.get(graph.root) || []).map(treeNode).join('') || '<p class="empty">索引中没有子符号。</p>';
}
$('#tree').addEventListener('toggle', e => {
  if (e.target.tagName !== 'DETAILS' || !e.target.open || e.target.dataset.loaded) return;
  const ids = children.get(e.target.dataset.tree) || [];
  e.target.querySelector('.tree-children').innerHTML = ids.slice(0, 300).map(treeNode).join('') + (ids.length > 300 ? `<button data-more-tree="${escape(e.target.dataset.tree)}" data-offset="300">继续显示（还有 ${ids.length - 300}）</button>` : '');
  e.target.dataset.loaded = 'true';
}, true);

function selectNode(id, locate = false) {
  if (!nodes.has(id)) return;
  selected = id; callsAnchor = id; sourceKey = '';
  if (locate) setScope(children.get(id)?.length ? id : nodes.get(id)?.parent || graph.root);
  for (const button of $$('#tree [data-symbol]')) button.classList.toggle('selected', button.dataset.symbol === selected);
  render();
}
function setScope(id) { scope = id; mapPage = 0; box = { x: 0, y: 0, w: 1100, h: 660 }; }
function start(id) {
  pause(); resumePlayback = false;
  player.options.maxDepth = Number($('#max-depth').value);
  player.start(id); selected = id; callsAnchor = id; view = 'journey'; journeyDetails.clear();
  setScope(player.scope(id, 'file') || graph.root); sourceKey = '';
  renderEntries(); render();
}

function svgElement(tag, attrs = {}, text) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

function renderJourney(model) {
  const e = model.event;
  const decisionList = () => model.decisions.map(d => `<button data-seek="${d.choiceIndex ?? d.index}" class="journey-decision"><span>${escape(nodes.get(d.symbol)?.name)}${d.line ? ` · L${d.line}` : ''}</span><strong>${escape(d.text)}</strong><small>回到此处改选</small></button>`).join('');
  if (!e) {
    const preferred = graph.entries.filter(entry => ['api', 'frontend'].includes(entry.kind));
    const starters = (preferred.length ? preferred : graph.entries).slice(0, 6);
    $('#journey-view').innerHTML = `<section class="journey-welcome"><h2>从哪里开始讲解？</h2><p>已打开 ${escape(graph.project.name)}。先选择入口，再沿调用向下阅读，在分支处手动决定本次路径。</p><div class="journey-starts">${starters.map(entry => `<button data-entry="${escape(entry.id)}"><span class="tone-badge" data-tone="call">${entry.kind === 'api' ? 'API' : entry.kind === 'frontend' ? 'UI' : '函数'}</span><strong>${escape(entry.label)}</strong><small>${escape(nodes.get(entry.id)?.path)}</small></button>`).join('')}</div><p>${graph.entries.length ? '更多入口可在左侧搜索；所有已识别函数均可单独演示。' : '当前没有可演示函数。请检查“分析缺口”，或打开另一个项目。'}</p><ol class="journey-how"><li><strong>选择入口</strong><span>API、页面组件或函数</span></li><li><strong>跟进调用</strong><span>查看当前语句与上下游</span></li><li><strong>选择并复盘</strong><span>手动选分支，回退比较路径</span></li></ol></section>`;
    return;
  }
  if (e.type === 'done') {
    $('#journey-view').innerHTML = `<section class="journey-finish"><span class="tone-badge" data-tone="${model.exceptional ? 'exception' : 'return'}">演示结束</span><h2>${escape(model.guidance.title)}</h2><p>${escape(e.text)}</p><p>从 ${escape(model.entry?.label || label(player.entry))} 出发，共进入 ${model.summary.calls} 次函数，作出 ${model.summary.decisions} 次选择，最深 ${model.summary.maxDepth} 层调用。</p><div class="journey-inline-actions"><button data-save-current="true" class="primary">保存本次场景</button><button data-command="restart">从此入口重新演示</button></div>${model.decisions.length ? `<h3>回到选择点，比较另一条路径</h3><div class="journey-decisions">${decisionList()}</div>` : ''}<p class="journey-caveat">这里记录的是手动选择的假设路径，目标项目没有运行。</p></section>`;
    return;
  }
  if (!model.focus) return;
  const token = `${graph.snapshot.id}:${player.cursor}:${e.type}:${e.symbol}:${e.op}`;
  const animate = token !== journeyEvent; journeyEvent = token;
  const node = (role, title, detail, status, id, css = '') => `<article class="journey-node ${css}"><div class="journey-node-role">${escape(role)}</div><strong>${id ? `<button data-symbol="${escape(id)}">${escape(title)}</button>` : escape(title)}</strong><span class="journey-node-detail">${escape(detail || '')}</span><span class="journey-node-status">${escape(status)}</span></article>`;
  const connector = (kind, text, slot = 'incoming') => {
    const returning = kind === 'return' || kind === 'pending-return';
    const path = returning ? 'M94 30H6' : 'M6 30H94';
    const moving = animate && ['call', 'return'].includes(kind);
    return `<div class="journey-link ${kind} ${model.exceptional ? 'exception' : ''}" aria-label="${escape(text)}"><span>${escape(text)}</span><svg viewBox="0 0 100 60" aria-hidden="true"><defs><marker id="journey-arrow-${slot}-${kind}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" stroke-width="1.5"/></marker></defs><path class="journey-wire" d="${path}" marker-end="url(#journey-arrow-${slot}-${kind})"/>${moving ? `<circle class="journey-particle" r="3.8"><animateMotion dur=".65s" repeatCount="1" fill="freeze" path="${path}"/></circle>` : ''}</svg></div>`;
  };
  const current = model.focus;
  const from = model.caller
    ? node('调用者', model.caller.name, model.caller.path, '当前调用栈中的上游', model.caller.id, 'caller')
    : node('演示入口', model.entry?.kind === 'api' ? model.entry.label : '从函数入口开始', graph.project.name, '静态教学 · 目标项目未运行', null, 'caller entry-node');
  const fn = node('当前函数', current.name, current.qualifiedName !== current.name ? current.qualifiedName : current.path,
    `#${e.stack.at(-1)?.invocation || '—'} 调用帧${e.line ? ` · L${e.line}` : ''}`, current.id, `current ${model.exceptional ? 'exception' : ''}`);
  const next = node(model.next.role, model.next.title, model.next.detail, model.next.status, model.next.node?.id, `next ${model.direction === 'pending' ? 'candidate' : ''}`);
  const incoming = model.direction === 'return' ? model.exceptional ? '异常退出' : '返回' : model.direction === 'pending-return' ? '待返回' : model.caller ? '调用中' : '入口';
  const chain = model.stack.map((f, i) => `${i ? '<span class="chain-arrow" aria-hidden="true">→</span>' : ''}<button data-symbol="${escape(f.symbol)}" class="${i === model.stack.length - 1 ? 'current' : ''}" title="${escape(f.node?.path)}">${escape(f.node?.name || f.symbol)}<small>#${f.invocation}</small></button>`).join('');
  const choices = e.type === 'choice'
    ? `<div class="journey-choices" role="group" aria-label="在演示区选择路径">${e.choices.map((choice, i) => `<button data-choice="${i}"><span class="choice-number">${i + 1}</span>${escape(choice)}</button>`).join('')}</div><p class="journey-next-note">${escape(model.guidance.continuation || (resumePlayback ? '选择后恢复连续播放' : '选择会记入本次场景，再继续下一步。'))}</p>`
    : `<div class="journey-inline-actions"><button data-command="into" class="primary">${escape(model.guidance.action)}</button>${['call', 'http'].includes(e.type) ? '<button data-command="over">跳过此调用</button>' : ''}<button data-command="play">${playing ? '暂停播放' : '连续播放'}</button></div>`;
  const expression = e.text || label(current.id);
  const excerpt = expression.length > 420 ? expression.slice(0, 420) + '…' : expression;
  $('#journey-view').innerHTML = `<header class="journey-heading"><div><h2>${escape(model.entry?.label || label(player.entry))}</h2><div class="journey-stats"><span>第 <b>${model.summary.events}</b> 步</span><span><b>${model.summary.calls}</b>次进入</span><span><b>${model.summary.decisions}</b>次选择</span></div></div><span data-tone="${eventTone(e.type)}" class="journey-phase ${e.type === 'choice' ? 'waiting' : ''}">${escape(eventNames[e.type] || e.type)}</span></header>
    <section class="journey-explanation"><div class="journey-explanation-head"><h3>${escape(model.guidance.title)}</h3><button data-symbol="${escape(current.id)}" data-show-source="true">查看源码</button></div><code class="journey-expression syntax">${code(excerpt, current.id)}</code><p>${escape(model.guidance.hint)}</p>${choices}</section>
    <div class="journey-chain" aria-label="当前活动调用链">${chain || '<span>当前调用栈已清空</span>'}</div>
    <div class="journey-diagram">${from}${connector(model.direction === 'pending-return' ? 'pending-return' : model.direction === 'return' ? 'return' : model.direction === 'call' ? 'call' : model.caller ? 'context' : 'none', incoming)}${fn}${connector(model.direction === 'pending' ? 'pending' : 'none', model.direction === 'pending' ? '尚未进入' : model.exceptional ? '待处理' : '流程说明', 'outgoing')}${next}</div>
    ${model.decisions.length ? `<section class="journey-decisions"><h3>本次选择 <small>最近 ${model.decisions.length} 次</small></h3>${decisionList()}</section>` : ''}
    <details class="journey-reference" data-journey-detail="source" ${journeyDetails.has('source') ? 'open' : ''}><summary>源码结构参考 <span>仅预览，不代表本次执行顺序</span></summary><section class="journey-steps"><div class="journey-explanation-head"><h3>当前调用帧的经过情况</h3><button data-view="flow" data-symbol="${escape(current.id)}">完整函数流程</button></div><ol>${model.steps.map(step => `<li class="${step.current ? 'current' : step.visited ? 'visited' : ''}"><span class="step-marker" aria-hidden="true"></span><div><span class="journey-step-kind tone-badge" data-tone="${eventTone(step.kind)}">${escape(eventNames[step.kind] || step.kind)} · L${step.line}</span><code class="syntax">${code(step.text.replace(/\s+/g, ' ').slice(0, 160), current.id)}</code></div><span class="journey-step-state">${step.current ? '当前' : step.visited ? '本帧经过' : '本帧未经过'}</span></li>`).join('') || '<li class="journey-no-flow">该函数尚无结构化流程，可在调用关系中查看已索引目标。</li>'}</ol></section></details>
    <details class="journey-reference" data-journey-detail="calls" ${journeyDetails.has('calls') ? 'open' : ''}><summary>本次调用记录 <span>最近 ${model.trace.length} 次进入</span></summary><section class="journey-records"><div>${model.trace.map(item => `<button data-seek="${item.index}" class="${item.state}" title="${escape(item.node?.path)}"><small>#${item.invocation}</small><strong>${escape(item.node?.name || item.symbol)}</strong><span>${item.state === 'active' ? '栈内' : item.state === 'exception' ? '异常退出' : '已返回'}</span></button>`).join('')}</div></section></details>`;
  if (animate) $('#journey-view').scrollTop = 0;
}
$('#journey-view').addEventListener('toggle', e => {
  const name = e.target.dataset.journeyDetail;
  if (name && e.target.isConnected) e.target.open ? journeyDetails.add(name) : journeyDetails.delete(name);
}, true);

function squarify(ids, rect) {
  const weight = id => {
    const n = nodes.get(id);
    return Math.max(5, (n.endLine || 0) - (n.line || 0) + 1, (children.get(id)?.length || 0) * 6);
  };
  let pending = ids.map(id => ({ id, w: weight(id) })).sort((a, b) => b.w - a.w);
  const total = pending.reduce((a, b) => a + b.w, 0), result = new Map();
  pending = pending.map(n => ({ ...n, area: n.w / total * rect.w * rect.h }));
  let r = { ...rect }, row = [];
  const worst = items => { const side = Math.min(r.w, r.h), sum = items.reduce((a, b) => a + b.area, 0); return Math.max(side * side * Math.max(...items.map(i => i.area)) / sum ** 2, sum ** 2 / (side * side * Math.min(...items.map(i => i.area)))); };
  const flush = () => {
    const area = row.reduce((a, b) => a + b.area, 0);
    if (r.w >= r.h) { const width = area / r.h; let y = r.y; for (const item of row) { const h = item.area / width; result.set(item.id, { x: r.x, y, w: width, h }); y += h; } r.x += width; r.w -= width; }
    else { const height = area / r.w; let x = r.x; for (const item of row) { const w = item.area / height; result.set(item.id, { x, y: r.y, w, h: height }); x += w; } r.y += height; r.h -= height; }
    row = [];
  };
  for (const item of pending) { if (row.length && worst([...row, item]) > worst(row)) flush(); row.push(item); }
  if (row.length) flush(); return result;
}
function renderMap(model = buildPresentation(graph, player)) {
  $('#atlas').toggleAttribute('hidden', !['map', 'calls'].includes(view)); $('#flow-view').hidden = view !== 'flow'; $('#journey-view').hidden = view !== 'journey';
  $('.legend').hidden = view === 'journey';
  $('#fit').disabled = !['map', 'calls'].includes(view);
  if (view === 'journey') { renderJourney(model); $('#map-page').innerHTML = ''; return; }
  if (view === 'flow') { renderFlow(); $('#map-page').innerHTML = ''; return; }
  const svg = $('#atlas'); svg.replaceChildren();
  const scale = Math.max(.12, Math.min(svg.clientWidth / box.w, svg.clientHeight / box.h));
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  const defs = svgElement('defs');
  const marker = svgElement('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--edge-color)' })); defs.append(marker); svg.append(defs);
  const edgeLayer = svgElement('g'), nodeLayer = svgElement('g');
  if (view === 'map') svg.append(nodeLayer, edgeLayer); else svg.append(edgeLayer, nodeLayer);
  const rects = new Map(), events = player.history.slice(0, player.cursor + 1);
  const visited = new Set(events.filter(e => e.type === 'enter').map(e => e.symbol));
  const current = player.current?.stack?.at(-1)?.symbol;
  let pages = 1, count = 0;
  function draw(id, r, preview = false, proxy = false) {
    if (r.w < 12 || r.h < 12) return;
    rects.set(id, r); const n = nodes.get(id), isActive = current && ancestors(current).includes(id), wasVisited = [...visited].some(v => ancestors(v).includes(id));
    const classes = ['atlas-node', n.kind, children.get(id)?.length ? 'container' : '', selected === id ? 'selected' : '', isActive ? 'active' : '', wasVisited ? 'visited' : ''].join(' ');
    const g = svgElement('g', { class: classes, 'data-symbol': id, role: 'button', tabindex: 0, 'aria-label': `${kindNames[n.kind] || n.kind} ${n.name}，双击进入` });
    g.append(svgElement('rect', { class: 'box', x: r.x + 3, y: r.y + 3, width: r.w - 6, height: r.h - 6, rx: 5 }));
    const maxChars = Math.max(2, Math.floor((r.w - 28) * scale / 7.5));
    if (r.h * scale > 25 && r.w * scale > 65) g.append(svgElement('text', { x: r.x + 13, y: r.y + (preview ? r.h / 2 + 4 / scale : 24 / scale), style: `font-size:${12 / scale}px` }, n.name.length > maxChars ? n.name.slice(0, maxChars - 1) + '…' : n.name));
    if (!preview && r.h * scale > 85 && r.w * scale > 145) g.append(svgElement('text', { class: 'subtext', x: r.x + 13, y: r.y + 44 / scale, style: `font-size:${12 / scale}px` }, `${proxy ? '跨层级 · ' : ''}${kindNames[n.kind] || n.kind}${children.get(id)?.length ? ` · ${children.get(id).length} 子项` : n.line ? ` · L${n.line}` : ''}`));
    if (player.breakpoints.has(id)) g.append(svgElement('circle', { class: 'bp', cx: r.x + r.w - 12, cy: r.y + 14, r: 4 }));
    g.append(svgElement('title', {}, `${label(id)}\n${n.path || ''}:${n.line || ''}\n控制流：${n.flowStatus || 'container'}`));
    nodeLayer.append(g);
    if (!preview && children.get(id)?.length && r.w * scale > 145 && r.h * scale > 150) {
      const header = 62 / scale;
      const kids = children.get(id).slice(0, 6), boxes = squarify(kids, { x: r.x + 9, y: r.y + header, w: r.w - 18, h: r.h - header - 9 });
      for (const [kid, childRect] of boxes) draw(kid, childRect, true);
    }
  }
  if (view === 'calls') {
    const center = nodes.has(callsAnchor) ? callsAnchor : player.entry || selected;
    const relevant = visualEdges.filter(e => e.source === center || e.target === center);
    const left = [...new Set(relevant.filter(e => e.target === center).map(e => e.source))].filter(id => id !== center);
    const right = [...new Set(relevant.filter(e => e.source === center).map(e => e.target))].filter(id => id !== center);
    count = left.length + right.length + 1; pages = Math.max(1, Math.ceil(Math.max(left.length, right.length) / 8)); mapPage = Math.min(mapPage, pages - 1);
    draw(center, { x: 390, y: 250, w: 320, h: 110 }, true);
    for (const [list, x] of [[left, 35], [right, 795]]) list.slice(mapPage * 8, (mapPage + 1) * 8).forEach((id, i, a) => draw(id, { x, y: 35 + i * Math.min(69, 540 / a.length), w: 270, h: 58 }, true));
    svg.append(svgElement('text', { x: 35, y: 22, fill: 'var(--muted)', 'font-size': 12 }, `调用者 ${left.length}`));
    svg.append(svgElement('text', { x: 795, y: 22, fill: 'var(--muted)', 'font-size': 12 }, `被调用者 ${right.length}`));
  } else {
    const ids = children.get(scope)?.length ? children.get(scope) : [scope];
    count = ids.length; pages = Math.max(1, Math.ceil(ids.length / 40)); mapPage = Math.min(mapPage, pages - 1);
    for (const [id, r] of squarify(ids.slice(mapPage * 40, (mapPage + 1) * 40), { x: 18, y: 15, w: 1064, h: 535 })) draw(id, r);
  }
  const visible = id => ancestors(id).find(a => rects.has(a));
  const activeStack = player.current?.stack || [];
  const activePair = activeStack.length > 1 ? [activeStack.at(-2).symbol, activeStack.at(-1).symbol] : [];
  const pendingCall = ['call', 'http'].includes(player.current?.type) ? [player.current.symbol, player.current.targets?.[0]?.id] : [];
  const pair = pendingCall[1] ? pendingCall : activePair;
  if (pair[0] && pair[1]) {
    $('#scope-description').textContent = `${label(pair[0])} → ${label(pair[1])}`;
    $('#scope-description').title = $('#scope-description').textContent;
  }
  if (view === 'map') {
    const outside = [...new Set(pair.filter(id => id && !visible(id)))].slice(0, 3);
    outside.forEach((id, i) => draw(id, { x: 18 + i * 350, y: 561, w: 334, h: 60 }, true, true));
  }
  const merged = new Map();
  for (const e of visualEdges) {
    const from = visible(e.source), to = visible(e.target);
    if (!from || !to || from === to) continue;
    const key = `${from}:${to}`;
    const previous = merged.get(key), active = e.source === pair[0] && e.target === pair[1];
    if (!previous || active) merged.set(key, { ...e, from, to, active });
  }
  if (pair[0] && pair[1]) {
    const from = visible(pair[0]), to = visible(pair[1]);
    if (from && to && from !== to) merged.set(`${from}:${to}`, { from, to, active: true });
  }
  let drawn = 0;
  for (const e of [...merged.values()].sort((a, b) => Number(b.active) - Number(a.active))) {
    if (view === 'map' && !e.active) continue;
    if (++drawn > 130) break;
    const a = rects.get(e.from), b = rects.get(e.to), right = b.x + b.w / 2 >= a.x + a.w / 2;
    const x1 = right ? a.x + a.w - 4 : a.x + 4, x2 = right ? b.x + 4 : b.x + b.w - 4, y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2), sign = right ? 1 : -1;
    const d = `M${x1},${y1} C${x1 + sign * bend},${y1} ${x2 - sign * bend},${y2} ${x2},${y2}`;
    if (view === 'map' && e.active) edgeLayer.append(svgElement('path', { d, fill:'none', stroke:'var(--bg)', 'stroke-width':7, 'vector-effect':'non-scaling-stroke', 'pointer-events':'none' }));
    const path = svgElement('path', { d, class: `atlas-edge${e.status === 'candidate' ? ' candidate' : ''}${e.active ? ' active' : ''}`, 'marker-end': 'url(#arrow)' });
    path.append(svgElement('title', {}, `${label(e.source || pair[0])} → ${label(e.target || pair[1])}\n${e.origin || '本场景经过'} · ${e.status || '假设路径'}`)); edgeLayer.append(path);
    if (e.active) { const dot = svgElement('circle', { r: 4, class: 'flow-dot' }); dot.append(svgElement('animateMotion', { dur: '.75s', repeatCount: 1, fill: 'freeze', path: d })); edgeLayer.append(dot); }
  }
  $('#map-page').innerHTML = pages > 1 ? `<button data-page="-1" ${mapPage === 0 ? 'disabled' : ''}>上一页</button><span>${mapPage + 1} / ${pages} · 共 ${count} 项</span><button data-page="1" ${mapPage === pages - 1 ? 'disabled' : ''}>下一页</button>` : `<span>${count} 项</span>`;
}

function renderFlow() {
  const id = isFunction(selected) || graph.flows[selected] ? selected : player.current?.symbol || player.entry;
  const n = nodes.get(id);
  if (!n) { $('#flow-view').innerHTML = '<p class="empty">选择函数查看内部流程。</p>'; return; }
  const format = ops => (ops || []).map(op => `<article class="flow-op ${player.current?.op === op.id ? 'active' : ''}" data-op="${escape(op.id)}"><header><span class="op-kind tone-badge" data-tone="${eventTone(op.kind)}">${escape(eventNames[op.kind] || op.kind)}</span><span class="op-line">L${op.line}</span><code class="syntax">${code(op.text.length > 220 ? op.text.slice(0, 220) + '…' : op.text, id)}</code></header>${op.targets?.length ? `<div class="flow-targets">${op.targets.map(t => `<button data-symbol="${escape(t.id)}">${escape(label(t.id))}</button> <span>${escape(t.origin)}${t.status === 'candidate' ? ' · 候选' : ''}</span>`).join('')}</div>` : op.kind === 'call' ? '<p class="flow-targets">调用目标未解析，保留边界</p>' : ''}${['conditionBody', 'body', 'incrementBody', 'elseBody', 'finallyBody'].map(k => op[k]?.length ? `<div class="flow-arms"><div class="flow-arm-label">${{ conditionBody: '循环条件／可迭代对象', body: '主体', incrementBody: '每轮更新', elseBody: '正常结束后', finallyBody: 'finally · 退出时仍执行' }[k]}</div>${format(op[k])}</div>` : '').join('')}${['arms', 'handlers'].map(k => (op[k] || []).map(a => `<div class="flow-arms"><div class="flow-arm-label">${escape(a.label)}</div>${format(a.body) || '<p class="muted">空分支，继续后续步骤</p>'}</div>`).join('')).join('')}</article>`).join('');
  $('#flow-view').innerHTML = `<div class="flow-heading"><strong>${escape(label(id))}</strong><small>${escape(n.flowStatus)}</small></div>${Object.hasOwn(graph.flows, id) ? format(graph.flows[id]) || '<p class="empty">函数主体没有可展开步骤。</p>' : '<p class="empty">该语言或语法的控制流尚未适配。可在“调用关系”浏览全部已索引关系；本页不会按行号编造执行次序。</p>'}`;
}
function renderSource() {
  const n = nodes.get(selected), path = n?.path, source = graph.sources[path];
  $('#source-path').textContent = path ? `${path}${n.line ? ':' + n.line : ''}` : '选择一个函数查看源码';
  $('#start-selected').disabled = !isFunction(selected); $('#breakpoint-selected').disabled = !isFunction(selected);
  $('#breakpoint-selected').textContent = player.breakpoints.has(selected) ? '移除函数断点' : '设置函数断点';
  const e = player.current, activePath = nodes.get(e?.symbol)?.path;
  const key = `${selected}:${activePath === path ? e?.line : ''}:${[...player.lineBreakpoints].join('|')}`;
  if (key === sourceKey) return; sourceKey = key;
  if (typeof source !== 'string') { $('#source-language').textContent = ''; $('#source-language').title = ''; $('#source').innerHTML = '<p class="empty">当前项没有内嵌源码。进入模块或选择函数查看。</p>'; return; }
  const sourceView = sourceDocument(source, path, n.language);
  $('#source-language').textContent = sourceView.highlighted || !sourceView.language ? sourceView.label : `${sourceView.label} · 纯文本`;
  $('#source-language').title = sourceView.note;
  const lines = sourceView.lines, center = activePath === path && e?.line ? e.line : n.line || 1;
  const offset = lines.length > 2000 ? Math.max(0, center - 200) : 0;
  const visible = lines.length > 2000 ? lines.slice(offset, offset + 500) : lines;
  $('#source').innerHTML = (lines.length > 2000 ? `<p class="muted">大文件按当前定位显示 L${offset + 1}–${offset + visible.length}，完整源码保留在项目快照中。</p>` : '') + visible.map((line, i) => {
    const number = offset + i + 1, bp = player.lineBreakpoints.has(`${path}:${number}`), active = path === activePath && e?.line === number;
    return `<div class="source-line ${active ? 'active' : number >= n.line && number <= n.endLine ? 'in-range' : ''}" data-line="${number}"><button data-line-bp="${number}" aria-label="${bp ? '移除' : '设置'}第 ${number} 行断点" class="${bp ? 'has-bp' : ''}">${bp ? '●' : ''}${number}</button><code class="syntax">${line || ' '}</code></div>`;
  }).join('');
  const line = $('#source').querySelector(`[data-line="${center}"]`);
  if (line) $('#source').scrollTop = Math.max(0, line.offsetTop - $('#source').offsetTop - 60);
}
function renderStep(model) {
  const e = player.current;
  const names = { idle: '准备', paused: '已暂停', waiting: '等待选择', done: '已结束', breakpoint: '命中断点', budget: '已达本轮事件上限' };
  $('#status').textContent = playing ? '播放中' : names[player.status] || player.status;
  $('#status').className = `status ${player.status}`;
  $('#session-entry').textContent = player.entry ? label(player.entry) : '选择一个入口开始';
  $('#current-step').innerHTML = e ? `<div class="event-kind tone-badge" data-tone="${eventTone(e.type)}">${escape(eventNames[e.type] || e.type)}</div><h3 class="inspector-guidance">${escape(model.guidance.title)}</h3><div class="step-text syntax">${code(e.text || label(e.symbol), e.symbol)}</div><div class="step-location">${escape(nodes.get(e.symbol)?.path || '')}${e.line ? ' · L' + e.line : ''}${e.resolution ? ' · ' + escape(e.resolution === 'unresolved' ? '目标未解析' : e.resolution === 'candidate' ? '调用候选待选择' : '索引关系') : ''}</div>` : '<p class="empty">从左侧选择一个入口。</p>';
  $('#choices').innerHTML = e?.type === 'choice' ? '<p class="choice-prompt">为这个场景明确选择一条路径</p>' + e.choices.map((c, i) => `<button data-choice="${i}">${i + 1}. ${escape(c)}</button>`).join('') : '';
  $('#inject-error').hidden = !['call', 'http'].includes(e?.type);
  $('#panel-stack').innerHTML = e?.stack.length ? [...e.stack].reverse().map((f, i) => `<button class="stack-frame" data-symbol="${escape(f.symbol)}">${escape(label(f.symbol))}<span>#${f.invocation} · ${i === 0 ? '当前帧' : '调用者'} · ${escape(nodes.get(f.symbol)?.path)}</span></button>`).join('') : '<p class="empty">当前没有活动调用帧。</p>';
  for (const b of $$('[data-command]')) b.disabled = !e || (player.status === 'done' && !['restart', 'back'].includes(b.dataset.command)) || (e.type === 'choice' && !['restart', 'back', 'play'].includes(b.dataset.command)) || (b.dataset.command === 'back' && player.cursor < 1);
  $('#play').innerHTML = `<svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true">${playing ? '<path d="M7 4v12M13 4v12"/>' : '<path d="m7 4 9 6-9 6Z"/>'}</svg><span>${playing ? '暂停' : '连续播放'}</span>`;
  const events = player.history.slice(Math.max(0, player.cursor - 199), player.cursor + 1), offset = Math.max(0, player.cursor - 199);
  $('#timeline-count').textContent = e ? `第 ${player.cursor + 1} 个事件 · 点击回看` : '选择入口后开始记录';
  $('#scenario-save').disabled = $('#scenario-export').disabled = !player.entry;
  $('#timeline').innerHTML = events.map((item, i) => `<button data-tone="${eventTone(item.type)}" data-seek="${offset + i}" class="${item.type === 'choice' ? 'choice' : ''} ${offset + i === player.cursor ? 'current' : ''}" title="${escape(item.text)}">${offset + i + 1} ${escape(eventNames[item.type] || item.type)}${item.type === 'enter' ? ' ' + escape(nodes.get(item.symbol)?.name) : ''}</button>`).join('');
  $('#timeline').scrollLeft = $('#timeline').scrollWidth;
}
function aggregateCoverage() {
  const total = new Map([...player.coverage()].map(([key, set]) => [key, new Set(set)]));
  for (const scenario of saved.filter(s => s.entry === player.entry)) {
    const cacheKey = JSON.stringify([scenario.entry, scenario.title, scenario.options, scenario.responses]);
    if (!saveCoverage.has(cacheKey)) {
      try { const p = new Player(graph); p.import(scenario); saveCoverage.set(cacheKey, p.coverage()); }
      catch { saveCoverage.set(cacheKey, new Map()); }
    }
    for (const [key, set] of saveCoverage.get(cacheKey)) { if (!total.has(key)) total.set(key, new Set()); for (const s of set) total.get(key).add(s); }
  }
  return total;
}
function renderCoverage() {
  const decisions = allDecisions(graph, player.entry), coverage = aggregateCoverage();
  const count = decisions.reduce((s, d) => s + d.count, 0), explored = decisions.reduce((s, d) => s + Math.min(d.count, coverage.get(d.key)?.size || 0), 0);
  $('#panel-coverage').innerHTML = `<h3>入口候选可达分支</h3><div class="coverage-summary">${explored} / ${count} <small>累计已探索分支出口</small></div><div class="coverage-track"><div style="width:${count ? Math.round(explored / count * 100) : 0}%"></div></div><p class="muted">包含当前路径及同入口已保存场景。候选调用会扩大分母；未知调用内部不在分母中。分支可行性未验证，不能推导“所有输入已覆盖”。</p>${decisions.map(d => `<div class="coverage-row"><button data-symbol="${escape(d.symbol)}">${escape(label(d.symbol))} · L${d.op.line}</button><p>${escape(d.op.text.slice(0, 120))}</p><div class="coverage-arms">${Array.from({ length: d.count }, (_, i) => `<span class="${coverage.get(d.key)?.has(i) ? 'seen' : ''}">${i + 1} ${coverage.get(d.key)?.has(i) ? '已探索' : '未探索'}</span>`).join('')}</div></div>`).join('') || '<p class="empty">该入口没有已提取的条件分支。未知或未适配控制流仍需检查“分析缺口”。</p>'}`;
}
function renderDiagnostics() {
  const unsupported = graph.nodes.filter(n => isFunction(n.id) && n.flowStatus !== 'structured');
  let unresolved = 0, candidate = 0;
  for (const ops of Object.values(graph.flows)) walk(ops, op => { if (op.kind === 'call' && !op.targets?.length) unresolved++; if (op.resolution === 'candidate') candidate++; });
  $('#panel-diagnostics').innerHTML = `<h3>分析完整性</h3><div class="diagnostic-row">${graph.stats.functions} 个函数 · ${graph.stats.structuredFunctions} 个已提取控制流<p>完整性以当前索引和解析器识别的符号为范围；不代表所有动态分派均可静态判定。</p></div><div class="diagnostic-row">${unresolved} 个未解析调用点 · ${candidate} 个候选调用点<p>未解析调用保留为边界，不会被当成不存在。</p></div><h3 class="diagnostic-heading">断点</h3>${[...player.breakpoints].map(id => `<div class="breakpoint-row"><span>${escape(label(id))}</span><button data-remove-bp="${escape(id)}">移除</button></div>`).join('')}${[...player.lineBreakpoints].map(key => `<div class="breakpoint-row"><span>${escape(key)}</span><button data-remove-line="${escape(key)}">移除</button></div>`).join('') || ''}${!player.breakpoints.size && !player.lineBreakpoints.size ? '<p class="muted">选择函数或点击源码行号设置。</p>' : ''}<h3 class="diagnostic-heading">诊断 ${graph.diagnostics.length}</h3>${graph.diagnostics.map(d => `<div class="diagnostic-row"><p>${escape(d.path || d.symbol || d.adapter || '')}</p>${escape(d.message)}</div>`).join('') || '<p class="muted">本次扫描没有产生解析器诊断。</p>'}<h3 class="diagnostic-heading">未适配控制流 ${unsupported.length}</h3>${unsupported.slice(0, 150).map(n => `<div class="diagnostic-row"><button data-symbol="${escape(n.id)}">${escape(label(n.id))}</button><p>${escape(n.language)} · ${escape(n.path)}</p></div>`).join('')}${unsupported.length > 150 ? '<p class="muted">其余函数可通过左侧搜索查找。</p>' : ''}`;
}
function renderScenarios() {
  $('#scenarios').innerHTML = saved.map((s, i) => `<div class="saved-scenario"><button data-scenario="${i}" title="${escape(label(s.entry))}">${escape(s.title)}</button><button data-delete-scenario="${i}" aria-label="删除场景 ${escape(s.title)}">移除</button></div>`).join('') || '<p class="muted">保存不同分支，累计比较探索缺口。</p>';
}
function render() {
  if (!graph) return;
  $('#breadcrumbs').innerHTML = ancestors(scope).reverse().map((id, i) => `${i ? '<span>/</span>' : ''}<button data-scope="${escape(id)}">${escape(nodes.get(id)?.name || id)}</button>`).join('');
  $('#scope-description').textContent = view === 'journey' ? '跟随调用、分支与返回 · 在中央直接选择路径' : view === 'calls' ? '函数邻域 · 保留边的分析来源' : view === 'flow' ? '函数内步骤 · 分支按源码嵌套' : '双击进入 · 滚轮缩放 · 拖动画布';
  const model = buildPresentation(graph, player);
  renderMap(model); renderStep(model); renderSource();
  if (panel === 'coverage') renderCoverage();
  if (panel === 'diagnostics') renderDiagnostics();
  for (const b of $$('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const b of $$('[data-panel]')) b.setAttribute('aria-selected', String(b.dataset.panel === panel));
  for (const section of $$('.inspector-panel')) section.hidden = section.id !== 'panel-' + panel;
}
function followCurrent() {
  if ($('#follow').checked && player.current?.symbol) {
    selected = player.current.symbol;
    if (!ancestors(selected).includes(scope)) setScope(player.scope(selected, 'file') || graph.root);
  }
}
function pause() { playing = false; playToken++; }
async function play() {
  if (playing) { pause(); render(); return; }
  if (!player.current || player.status === 'done') return;
  if (player.current.type === 'choice') { resumePlayback = true; panel = 'step'; render(); notify('播放已暂停：请先选择当前场景路径。'); return; }
  playing = true; const token = ++playToken; let budget = 3000;
  while (playing && token === playToken && budget-- > 0) {
    player.step(); followCurrent();
    if (player.atBreakpoint()) { player.status = 'breakpoint'; pause(); }
    if (player.status === 'waiting') { resumePlayback = true; pause(); panel = 'step'; }
    if (player.status === 'done') pause();
    render();
    if (playing) await new Promise(r => setTimeout(r, Number($('#speed').value)));
  }
  if (budget <= 0) { pause(); notify('本轮已演示 3000 个事件，暂停供检查；可继续播放。'); render(); }
}
function command(mode) {
  if (!player) return;
  notify(''); resumePlayback = false;
  if (mode === 'play') { play(); return; }
  pause();
  if (mode === 'restart') return start(player.entry);
  if (mode === 'back') player.back();
  else { const reason = player.command(mode); if (reason === 'choice') panel = 'step'; if (reason === 'budget') notify('已达本轮 5000 事件上限，已暂停；可继续。'); }
  followCurrent(); render();
}
function choosePath(selection) {
  if (!player || player.current?.type !== 'choice') return;
  const resume = resumePlayback;
  if (!player.choose(selection)) return;
  notify(''); resumePlayback = false;
  followCurrent(); render();
  if (resume && !['breakpoint', 'done', 'budget'].includes(player.status)) play();
}
function persistBreakpoints() { localSet(projectKey() + ':breakpoints', { functions: [...player.breakpoints], lines: [...player.lineBreakpoints] }); sourceKey = ''; render(); }
function inputs() { try { return JSON.parse($('#scenario-input').value); } catch { throw new Error('场景输入不是有效 JSON，请先修正。'); } }
function exportFile(filename, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function readFile(input) { const file = input.files[0]; if (!file) return null; if (file.size > 100 * 1024 * 1024) throw new Error('文件超过 100 MB，请使用本地扫描服务打开。'); return JSON.parse(await file.text()); }
function loadScenario(scenario) { const restored = new Player(graph); restored.import(scenario); restored.breakpoints = player.breakpoints; restored.lineBreakpoints = player.lineBreakpoints; pause(); resumePlayback = false; player = restored; view = 'journey'; journeyDetails.clear(); const depth=String(player.options.maxDepth); if (![...$('#max-depth').options].some(o=>o.value===depth)) $('#max-depth').add(new Option(depth,depth)); $('#max-depth').value=depth; $('#scenario-input').value = JSON.stringify(scenario.inputs, null, 2); $('#scenario-title').value = scenario.title; callsAnchor = player.entry; followCurrent(); renderEntries(); render(); }

document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !graph) return;
  if (b.dataset.entry) start(b.dataset.entry);
  if (b.dataset.saveCurrent) $('#scenario-save').click();
  if (b.dataset.command) { b.closest('.mobile-commands,.jump-commands')?.removeAttribute('open'); command(b.dataset.command); }
  if (b.dataset.injectError) { pause(); player.step({ throw: true }); followCurrent(); render(); }
  if (b.dataset.symbol) { e.preventDefault(); selectNode(b.dataset.symbol, !!b.closest('#tree')); }
  if (b.dataset.showSource && document.body.classList.contains('no-source')) toggleSource();
  if (b.dataset.scope) { setScope(b.dataset.scope); render(); }
  if (b.dataset.view) { view = b.dataset.view; box = { x: 0, y: 0, w: 1100, h: 660 }; render(); }
  if (b.dataset.panel) { panel = b.dataset.panel; render(); }
  if (b.dataset.choice != null) choosePath(Number(b.dataset.choice));
  if (b.dataset.page) { mapPage += Number(b.dataset.page); renderMap(); }
  if (b.dataset.seek != null) { pause(); resumePlayback = false; player.seek(Number(b.dataset.seek)); followCurrent(); render(); }
  if (b.dataset.lineBp) { const key = `${nodes.get(selected)?.path}:${b.dataset.lineBp}`; player.lineBreakpoints.has(key) ? player.lineBreakpoints.delete(key) : player.lineBreakpoints.add(key); persistBreakpoints(); }
  if (b.dataset.removeBp) { player.breakpoints.delete(b.dataset.removeBp); persistBreakpoints(); }
  if (b.dataset.removeLine) { player.lineBreakpoints.delete(b.dataset.removeLine); persistBreakpoints(); }
  if (b.dataset.scenario != null) { try { loadScenario(saved[Number(b.dataset.scenario)]); } catch (error) { notify(error.message, true); } }
  if (b.dataset.deleteScenario != null) { saved.splice(Number(b.dataset.deleteScenario), 1); localSet(projectKey() + ':scenarios', saved); saveCoverage.clear(); renderScenarios(); render(); }
  if (b.id === 'more-entries') { entryLimit += 80; renderEntries(); }
  if (b.dataset.moreTree) { const ids = children.get(b.dataset.moreTree) || [], offset = Number(b.dataset.offset); b.insertAdjacentHTML('beforebegin', ids.slice(offset, offset + 300).map(treeNode).join('')); if (offset + 300 < ids.length) { b.dataset.offset = offset + 300; b.textContent = `继续显示（还有 ${ids.length - offset - 300}）`; } else b.remove(); }
});
$('#atlas').addEventListener('click', e => { const id = e.target.closest('[data-symbol]')?.dataset.symbol; if (id) selectNode(id); });
$('#atlas').addEventListener('dblclick', e => {
  const id = e.target.closest('[data-symbol]')?.dataset.symbol; if (!id) return;
  selected = id; callsAnchor = id; if (children.get(id)?.length) setScope(id); else if (isFunction(id)) view = 'flow'; render();
});
$('#atlas').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const id = e.target.closest('[data-symbol]')?.dataset.symbol; if (!id) return;
  e.preventDefault(); selected = id; callsAnchor = id; if (children.get(id)?.length) setScope(id); else view = 'flow'; render();
});
$('#search').addEventListener('input', () => { entryLimit = 80; renderEntries(); });
$('#entry-filter').addEventListener('change', () => { entryLimit = 80; renderEntries(); });
$('#start-selected').onclick = () => { if (isFunction(selected)) start(selected); };
$('#breakpoint-selected').onclick = () => { if (!isFunction(selected)) return; player.breakpoints.has(selected) ? player.breakpoints.delete(selected) : player.breakpoints.add(selected); persistBreakpoints(); };
$('#inject-error').onclick = () => { pause(); player.step({ throw: true }); followCurrent(); render(); };
$('#scenario-save').onclick = () => {
  try { if (!player.entry) return; const scenario = player.export(inputs(), $('#scenario-title').value.trim() || '未命名场景'); const existing = saved.findIndex(s => s.title === scenario.title && s.entry === scenario.entry); if (existing >= 0) saved[existing] = scenario; else saved.unshift(scenario); saved = saved.slice(0, 30); localSet(projectKey() + ':scenarios', saved); saveCoverage.clear(); renderScenarios(); render(); notify('场景已保存到当前浏览器；导出文件可跨浏览器保存。'); } catch (error) { notify(error.message, true); }
};
$('#scenario-export').onclick = () => { try { if (player.entry) exportFile('repo2tree-scenario.json', player.export(inputs(), $('#scenario-title').value.trim() || '未命名场景')); } catch (error) { notify(error.message, true); } };
$('#scenario-import').onchange = async e => { try { const s = await readFile(e.target); if (s) loadScenario(s); } catch (error) { notify(error.message, true); } finally { e.target.value = ''; } };
$('#project-import').onchange = async e => { try { const g = await readFile(e.target); if (g) { loadGraph(g); notify('已在浏览器中打开项目快照。'); } } catch (error) { notify(error.message, true); } finally { e.target.value = ''; } };
$('#max-depth').onchange = () => { if (player?.entry) { start(player.entry); notify('展开深度已更改，当前路径已重置，确保保存场景可以准确回放。'); } };

$('#project-toggle').onclick = () => { const open = $('#project-bar').hidden; $('#project-bar').hidden = !open; $('#project-toggle').setAttribute('aria-expanded', String(open)); };
async function request(url, body) { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`); return data; }
function setScanBusy(busy) {
  projectBusy = busy;
  $('#scan-button').disabled = busy;
  $('#scan-button').textContent = busy ? '正在分析…' : '扫描项目';
  $('#scan-cancel').hidden = !busy;
  $('#scan-cancel').disabled = false;
  $('#scan-cancel').textContent = '取消扫描';
  for (const id of ['demo-button', 'project-import', 'project-path', 'index-allow']) $(`#${id}`).disabled = busy;
  $('#scan-form').setAttribute('aria-busy', String(busy));
}
async function scanStatus() {
  const response = await fetch('/api/scan/status');
  if (!response.ok) throw new Error('无法读取扫描进度，请检查本地服务。');
  return response.json();
}
function showScanStatus(state) {
  if (!state.running) return;
  const count = state.total ? ` · ${state.completed} / ${state.total}` : '';
  notify(`${state.cancelling ? '正在取消扫描' : state.stage}${count} · 已用 ${state.elapsedSeconds} 秒。完成后会打开新项目。`);
}
$('#scan-cancel').onclick = async () => {
  $('#scan-cancel').disabled = true; $('#scan-cancel').textContent = '正在取消…';
  try { await request('/api/scan/cancel', {}); notify('正在停止扫描，当前项目仍可保留。'); }
  catch (error) { notify(error.message, true); $('#scan-cancel').disabled = false; }
};
$('#scan-form').onsubmit = async e => {
  e.preventDefault(); if (projectBusy) return; pause();
  const body = { path: $('#project-path').value.trim(), index: $('#index-allow').checked };
  setScanBusy(true);
  notify('准备扫描项目，正在连接本地分析服务…');
  let finished = false;
  const monitor = async () => {
    if (finished) return;
    try { const state = await scanStatus(); if (!finished) showScanStatus(state); }
    catch (error) { if (!finished) notify(error.message, true); }
    if (!finished) setTimeout(monitor, 500);
  };
  setTimeout(monitor, 250);
  try {
    const data = await request('/api/scan', body);
    finished = true;
    notify('扫描完成，正在打开项目地图…');
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    loadGraph(data);
    notify(`已打开 ${data.project.name}：${data.stats.files} 个文件，${data.stats.functions} 个函数。分析缺口可在右侧查看。`);
  }
  catch (error) { notify(error.message, true); }
  finally { finished = true; setScanBusy(false); }
};
$('#demo-button').onclick = async () => { try { loadGraph(await request('/api/demo', {})); notify('已打开随应用提供的源码示例；路径为本项目的静态教学数据。'); } catch (error) { notify(error.message, true); } };

function saveLayout() { localSet('repo2tree:layout', { left: document.body.classList.contains('no-left'), right: document.body.classList.contains('no-right'), source: document.body.classList.contains('no-source'), height: document.documentElement.style.getPropertyValue('--source') }); }
function overlaySide(side) { return matchMedia(side === 'left' ? '(max-width:950px)' : '(max-width:620px)').matches; }
function syncPanelControls() {
  for (const side of ['left', 'right']) {
    const expanded = overlaySide(side) ? document.body.classList.contains(`mobile-${side}`) : !document.body.classList.contains(`no-${side}`) && !(side === 'right' && matchMedia('(max-width:950px)').matches && document.body.classList.contains('mobile-left'));
    $(`#${side}-toggle`).setAttribute('aria-expanded', String(expanded));
    $(`#${side}-toggle`).setAttribute('aria-label', `${expanded ? '折叠' : '展开'}${side === 'left' ? '入口' : '步骤'}面板`);
  }
}
function toggleSide(side, force) {
  if (overlaySide(side)) {
    document.body.classList.toggle(`mobile-${side}`, force);
    document.body.classList.remove(`mobile-${side === 'left' ? 'right' : 'left'}`);
  } else {
    document.body.classList.toggle('no-' + side, force);
    if (side === 'right' && matchMedia('(max-width:950px)').matches) document.body.classList.remove('mobile-left');
  }
  syncPanelControls(); saveLayout();
}
for (const side of ['left', 'right']) {
  $(`#${side}-toggle`).onclick = () => toggleSide(side);
  $(`#${side}-restore`).onclick = () => toggleSide(side, overlaySide(side));
}
window.addEventListener('resize', syncPanelControls);
function toggleSource() { const collapsed = document.body.classList.toggle('no-source'); $('#source-toggle').textContent = collapsed ? '展开源码' : '收起源码'; $('#source-toggle').setAttribute('aria-expanded', String(!collapsed)); saveLayout(); }
$('#source-toggle').onclick = toggleSource;
let beforeFocus = null;
$('#focus-toggle').onclick = () => { if (!beforeFocus) { beforeFocus = [document.body.classList.contains('no-left'), document.body.classList.contains('no-right'), document.body.classList.contains('no-source')]; document.body.classList.add('no-left', 'no-right', 'no-source'); $('#focus-toggle').textContent = '恢复布局'; } else { ['no-left', 'no-right', 'no-source'].forEach((cls, i) => document.body.classList.toggle(cls, beforeFocus[i])); beforeFocus = null; $('#focus-toggle').textContent = '专注'; } syncPanelControls(); saveLayout(); };
$('#locate').onclick = () => { if (selected) { setScope(children.get(selected)?.length ? selected : nodes.get(selected)?.parent || graph.root); render(); } };
$('#fit').onclick = () => { box = { x: 0, y: 0, w: 1100, h: 660 }; renderMap(); };
$('#atlas').addEventListener('wheel', e => { e.preventDefault(); const ratio = Math.max(.2, Math.min(4, box.w / 1100 * (e.deltaY > 0 ? 1.12 : .89))), rect = $('#atlas').getBoundingClientRect(), fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height, w = 1100 * ratio, h = 660 * ratio; box = { x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h }; $('#atlas').setAttribute('viewBox', `${box.x} ${box.y} ${w} ${h}`); }, { passive: false });
let pan;
$('#atlas').addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('[data-symbol]')) return; pan = { x: e.clientX, y: e.clientY, box: { ...box } }; $('#atlas').setPointerCapture(e.pointerId); $('#atlas').classList.add('dragging'); });
$('#atlas').addEventListener('pointermove', e => { if (!pan) return; const rect = $('#atlas').getBoundingClientRect(); box.x = pan.box.x - (e.clientX - pan.x) / rect.width * box.w; box.y = pan.box.y - (e.clientY - pan.y) / rect.height * box.h; $('#atlas').setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`); });
const endPan = () => { pan = null; $('#atlas').classList.remove('dragging'); };
$('#atlas').addEventListener('pointerup', endPan); $('#atlas').addEventListener('pointercancel', endPan);
let sourceDrag;
$('#source-grip').addEventListener('pointerdown', e => { sourceDrag = { y: e.clientY, height: $('.source-panel').getBoundingClientRect().height }; $('#source-grip').setPointerCapture(e.pointerId); });
function sourceHeight(height) { const room=$('.center-pane').clientHeight-$('.map-head').clientHeight-$('.map-tools').clientHeight-$('.timeline-panel').clientHeight-160; document.documentElement.style.setProperty('--source', `${Math.max(90, Math.min(innerHeight * .6,Math.max(90,room),height))}px`); }
$('#source-grip').addEventListener('pointermove', e => { if (sourceDrag) sourceHeight(sourceDrag.height + sourceDrag.y - e.clientY); });
$('#source-grip').addEventListener('pointerup', () => { sourceDrag = null; saveLayout(); });
$('#source-grip').addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); sourceHeight($('.source-panel').clientHeight + (e.key === 'ArrowUp' ? 24 : -24)); saveLayout(); } });
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const commands = { F11: e.shiftKey ? 'out' : 'into', F10: 'over', F8: 'play' };
  if (commands[e.key]) { e.preventDefault(); command(commands[e.key]); }
  if (e.key === 'Escape') { pause(); resumePlayback = false; render(); }
  if (e.key === '[') toggleSide('left'); if (e.key === ']') toggleSide('right');
  if (e.key.toLowerCase() === 'f') $('#focus-toggle').click();
  if (/^[1-9]$/.test(e.key) && player?.current?.type === 'choice') $(`[data-choice="${Number(e.key) - 1}"]`)?.click();
});

const layout = localGet('repo2tree:layout', {});
// Give the teaching stage room on first use; preserve explicitly saved layouts.
if (typeof layout.source !== 'boolean') layout.source = true;
for (const [k, cls] of [['left', 'no-left'], ['right', 'no-right'], ['source', 'no-source']]) if (layout[k]) document.body.classList.add(cls);
if (layout.height && /^\d+(\.\d+)?px$/.test(layout.height)) sourceHeight(parseFloat(layout.height));
$('#source-toggle').textContent = layout.source ? '展开源码' : '收起源码';
$('#source-toggle').setAttribute('aria-expanded', String(!layout.source));
syncPanelControls();
fetch('/api/project').then(r => { if (!r.ok) throw new Error(`服务响应 ${r.status}`); return r.json(); }).then(loadGraph).catch(error => { notify(`无法打开项目：${error.message}`, true); $('#project-name').textContent = '项目加载失败'; $('#project-bar').hidden = false; });

async function reconnectScan() {
  try {
    let state = await scanStatus();
    if (!state.running || projectBusy) return;
    pause(); setScanBusy(true); $('#project-bar').hidden = false;
    $('#project-toggle').setAttribute('aria-expanded', 'true');
    const poll = async () => {
      try {
        state = await scanStatus();
        if (state.running) { showScanStatus(state); setTimeout(poll, 500); return; }
        if (state.error) notify(state.error, true);
        else { const response = await fetch('/api/project'); if (!response.ok) throw new Error('无法打开扫描结果'); loadGraph(await response.json()); notify('项目扫描完成，已恢复扫描结果。'); }
      } catch (error) { notify(error.message, true); }
      setScanBusy(false);
    };
    poll();
  } catch { /* Normal page loading reports connection errors separately. */ }
}
reconnectScan();
