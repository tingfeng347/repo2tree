// ---------------------------------------------------------------- rendering & panels
const flowLayer = $("#flowLayer")
const trailLayer = $("#trailLayer")
const staticLayer = $("#staticLayer")
let shownSource = { fid: null }
state.selected = null
state.viewFrame = null

function onViewChanged() {
  const s = viewScale()
  for (const p of flowLayer.querySelectorAll("circle.particle")) p.setAttribute("r", 5 / s)
}

function markTreemap() {
  const onStack = new Set(state.stack.map((f) => f.fid))
  const cur = top()?.fid
  for (const [i, el] of G) {
    const c = el.g.classList
    c.toggle("cur", i === cur)
    c.toggle("stk", onStack.has(i) && i !== cur)
    c.toggle("vis", state.visited.has(i) && el.leaf)
    c.toggle("sel", i === state.selected)
    const bp = state.bpFn.has(i)
    if (bp && !el.dot) { el.dot = svgEl("circle", { class: "bpdot" }); el.g.appendChild(el.dot) }
    if (!bp && el.dot) { el.dot.remove(); el.dot = null }
  }
  updateLabels()
}

function edgeKind(t) { return t === "http" ? "http" : t === "ret" ? "ret" : t === "exc" ? "exc" : "call" }

function drawStackTrail() {
  trailLayer.textContent = ""
  for (let j = 1; j < state.stack.length; j++) {
    const a = state.stack[j - 1].fid, b = state.stack[j].fid
    const kind = state.stack[j].callItem?.t === "http" ? "http" : "call"
    trailLayer.appendChild(svgEl("path", { class: `edge trail ${kind}`, d: curve(anchor(a), anchor(b)) }))
  }
}

function animateEdge(e) {
  flowLayer.textContent = ""
  if (e.from == null || e.to == null) return
  const kind = edgeKind(e.type)
  const back = kind === "ret" || kind === "exc"
  const path = svgEl("path", { class: `edge active ${kind}`, d: back ? curve(anchor(e.to), anchor(e.from)) : curve(anchor(e.from), anchor(e.to)) })
  if (back) path.setAttribute("style", "marker-end:none;marker-start:url(#arrow)")
  flowLayer.appendChild(path)
  if (!state.opts.anim) return
  const dot = svgEl("circle", { class: `particle ${kind}`, r: 5 / viewScale() })
  flowLayer.appendChild(dot)
  const len = path.getTotalLength()
  const dur = Math.min(900, Math.max(220, delay() * 0.9))
  const t0 = performance.now()
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / dur)
    const p = path.getPointAtLength(back ? len * (1 - t) : len * t)
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y)
    if (t < 1 && dot.isConnected) requestAnimationFrame(tick)
    else if (e.flash) setTimeout(() => { if (path.isConnected) path.remove() }, 300)
  }
  requestAnimationFrame(tick)
}

function followCamera(ev) {
  if (!state.opts.follow) return
  const e = [...ev].reverse().find((x) => x.from != null && x.to != null)
  let target
  if (e) {
    target = lca(e.from, e.to)
    if (!kids(target).length) target = N[target].p ?? ROOT
  } else if (top()) {
    const r = N[top().fid].r
    if (r && isRectVisible(r)) return
    target = N[top().fid].p ?? ROOT
  }
  if (target != null && target !== scopeNode) zoomTo(target, 600)
}

function render(ev = []) {
  markTreemap()
  drawStackTrail()
  const edge = [...ev].reverse().find((x) => x.from != null)
  if (edge) animateEdge(edge)
  else if (!state.stack.length) flowLayer.textContent = ""
  followCamera(ev)
  renderStep()
  renderStack()
  renderSourceForPosition()
  renderTrace()
  if ($("#tab-cov").classList.contains("on")) renderCoverage()
  updateTreeMarks()
  updateControls()
}

// ---------------------------------------------------------------- step card & choices
function loc(fid, line) { return `${N[fid].f}:${line ?? N[fid].s}` }
function renderStep() {
  const card = $("#stepCard")
  const box = $("#choices")
  box.textContent = ""
  const fr = top()
  if (!state.entry) {
    card.innerHTML = `<div class="kind done">就绪</div><div>从左侧选择一个入口（API / 前端组件 / 命令 / 函数），然后用 <b>进入</b>、<b>跳过</b>、<b>跳出</b> 或 <b>继续</b> 逐步观察执行流向。</div>`
    return
  }
  if (!fr) {
    card.innerHTML = state.status === "uncaught"
      ? `<div class="kind exc">未捕获异常</div><code>${esc(state.uncaught)}</code><div class="loc">${DATA.entries.some((e) => e.g === "http" && e.node === state.entry) ? "异常离开路由处理函数，Web 框架通常会把它转换为 HTTP 错误响应。" : ""}点 ⟲ 重启，或在分支处改选其他路径</div>`
      : `<div class="kind done">执行完成</div><div>入口 ${esc(label(state.entry))} 已返回。可点 ✚ 走下一条未覆盖路径。</div>`
    return
  }
  const it = settle(fr)
  if (!it) {
    card.innerHTML = `<div class="kind ret">函数结束</div><div>${esc(label(fr.fid))} 执行到末尾，下一步返回调用方。</div><div class="loc">${esc(loc(fr.fid, N[fr.fid].e))}</div>`
    return
  }
  const KIND = { call: ["call", "调用"], http: ["http", "HTTP 请求"], if: ["branch", "条件分支"], cb: ["branch", "回调 / 事件"], loop: ["branch", "循环"], try: ["branch", "try 异常处理"], ret: ["ret", "返回"], raise: ["exc", "抛出异常"] }
  const [cls, name] = KIND[it.t] || ["call", it.t]
  let extra = ""
  if (it.t === "call") {
    const t = enterTarget(it)
    if (t != null) extra = `<div>目标：<span class="linkish" data-sel="${t}">${esc(label(t))}</span>${it.g ? ' <span class="warn small">（按名称推断）</span>' : ""}</div>`
    else if (it.to?.length) extra = `<div>目标：${esc(label(it.to[0]))}（无可执行体）</div>`
    else extra = `<div class="muted small">外部 / 库调用</div>`
  }
  if (it.t === "http") {
    const t = enterTarget(it)
    extra = t != null ? `<div>路由：<code>${esc(it.route)}</code><br>后端处理：<span class="linkish" data-sel="${t}">${esc(label(t))}</span></div>` : `<div class="warn small">未匹配到本项目后端路由（外部 API 或动态 URL）</div>`
  }
  card.innerHTML = `<div class="kind ${cls}">${name}</div><code>${esc(it.x)}</code>${extra}<div class="loc">${esc(label(fr.fid))} · ${esc(loc(fr.fid, it.l))}</div>`
  const opts = optionsFor(it)
  if (!opts.length) return
  const sel = pickOf(fr, it)
  const head = document.createElement("div")
  head.className = "muted small"
  head.textContent = it.k != null ? "本次走哪条路径？（✓ = 已覆盖）" : "调用结果："
  box.appendChild(head)
  opts.forEach((text, a) => {
    const lab = document.createElement("label")
    lab.className = "choice" + (a === sel ? " sel" : "") + (it.k != null && state.cov.has(covKey(fr.fid, it, a)) ? " covered" : "")
    lab.innerHTML = `<input type="radio" name="choice" ${a === sel ? "checked" : ""}><span class="lab">${esc(text)}</span>`
    lab.querySelector("input").onchange = () => { fr.pick.set(it, a); renderStep() }
    box.appendChild(lab)
  })
}

// ---------------------------------------------------------------- call stack
function renderStack() {
  const ol = $("#stack")
  ol.textContent = ""
  for (let j = state.stack.length - 1; j >= 0; j--) {
    const fr = state.stack[j]
    const line = j === state.stack.length - 1 ? settle(fr)?.l : state.stack[j + 1].callItem?.l
    const li = document.createElement("li")
    li.className = j === state.stack.length - 1 ? "top" : ""
    li.innerHTML = `<span>${esc(label(fr.fid))}</span><span class="where">${esc(N[fr.fid].f.split("/").pop())}:${line ?? ""}</span>`
    li.onclick = () => { state.viewFrame = j; renderSourceForPosition(); zoomTo(N[fr.fid].p ?? ROOT) }
    ol.appendChild(li)
  }
}

// ---------------------------------------------------------------- source view
const PY_KW = "def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|raise|await|async|yield|lambda|pass|break|continue|in|not|and|or|is|None|True|False|self|match|case"
const TS_KW = "function|const|let|var|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|new|class|extends|import|from|export|await|async|typeof|instanceof|in|of|null|undefined|true|false|this|type|interface"
function highlight(line, lang) {
  const py = lang === "python"
  const re = new RegExp(`(${py ? "#.*$" : "\\/\\/.*$"})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${py ? PY_KW : TS_KW})\\b`, "g")
  let out = "", last = 0, m
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index))
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "n" : "k"
    out += `<span class="tok-${cls}">${esc(m[0])}</span>`
    last = re.lastIndex
  }
  return out + esc(line.slice(last))
}

function itemLines(fid) {
  const set = new Set()
  if (hasFlow(fid)) walkItems(N[fid].flow, (it) => { if (!skippable(it)) set.add(it.l) })
  return set
}

function showSource(fid, curLine, preview = false) {
  const n = N[fid]
  const pre = $("#src")
  $("#srcTitle").textContent = `${label(fid)}${preview ? "（预览）" : ""}`
  $("#srcLoc").textContent = `${n.f}${n.s ? `:${n.s}-${n.e}` : ""}`
  const text = DATA.src[n.f]
  if (shownSource.fid !== fid || shownSource.ext !== state.opts.ext) {
    pre.textContent = ""
    if (text == null) { pre.textContent = "（未内嵌源码：生成时使用了 --no-source）"; shownSource = { fid, rows: new Map() }; return }
    const lines = text.split("\n")
    const fileView = n.k === "file"
    const from = fileView ? 1 : Math.max(1, n.s - 2), to = fileView ? lines.length : Math.min(lines.length, n.e + 2)
    const steps = itemLines(fid)
    const rows = new Map()
    const frag = document.createDocumentFragment()
    for (let ln = from; ln <= to; ln++) {
      const row = document.createElement("div")
      row.className = "row" + (!fileView && (ln < n.s || ln > n.e) ? " out" : "") + (steps.has(ln) ? " step" : "")
      row.innerHTML = `<span class="gut" title="切换行断点">${ln}</span><span>${highlight(lines[ln - 1] ?? "", n.lang)}</span>`
      row.firstChild.onclick = () => toggleLineBreakpoint(fid, ln)
      rows.set(ln, row)
      frag.appendChild(row)
    }
    pre.appendChild(frag)
    shownSource = { fid, rows, ext: state.opts.ext }
  }
  for (const [ln, row] of shownSource.rows) {
    row.classList.toggle("cur", ln === curLine)
    row.classList.toggle("bp", state.bpLine.has(`${fid}:${ln}`))
  }
  const curRow = shownSource.rows.get(curLine)
  if (curRow) curRow.scrollIntoView({ block: "nearest" })
}

function renderSourceForPosition() {
  if (!state.stack.length) { if (state.selected != null && hasFlow(state.selected)) showSource(state.selected, null, true); return }
  let j = state.viewFrame ?? state.stack.length - 1
  if (j >= state.stack.length) j = state.stack.length - 1
  const fr = state.stack[j]
  const line = j === state.stack.length - 1 ? settle(fr)?.l ?? N[fr.fid].e : state.stack[j + 1].callItem?.l
  showSource(fr.fid, line)
}

// ---------------------------------------------------------------- tabs
function renderTrace() {
  const pane = $("#tab-trace")
  if (!pane.classList.contains("on")) return
  const evs = state.trace.slice(-500)
  pane.innerHTML = evs.map((e, k) => `<div class="ev ${e.type}${k === evs.length - 1 ? " last" : ""}" style="padding-left:${4 + e.depth * 12}px" data-sel="${e.to ?? e.fid ?? ""}">${esc(e.text)}</div>`).join("") || '<div class="muted">尚无执行记录</div>'
  pane.scrollTop = pane.scrollHeight
}

function renderCoverage() {
  const pane = $("#tab-cov")
  if (state.entry == null) { pane.innerHTML = '<div class="muted">选择入口后显示该入口可达范围内的分支覆盖情况。</div>'; return }
  const fns = [...reachable(state.entry)]
  let total = 0, done = 0
  const rows = []
  for (const fid of fns) {
    const items = branchItems(fid)
    if (!items.length) continue
    const arms = []
    for (const it of items) armsOf(it).forEach((a, k) => {
      const ok = state.cov.has(covKey(fid, it, k))
      total++; if (ok) done++
      arms.push(`<div class="covarm${ok ? " ok" : ""}">${ok ? "✓" : "○"} L${it.l} ${esc(it.x)} ⇒ ${esc(a)}</div>`)
    })
    rows.push(`<div class="covfn" data-sel="${fid}">${esc(label(fid))}</div>${arms.join("")}`)
  }
  const pct = total ? Math.round((done / total) * 100) : 100
  pane.innerHTML = `<div>可达函数 ${fns.length} 个 · 分支 ${done}/${total}（${pct}%）</div><div class="covbar"><i style="width:${pct}%"></i></div>
    <button id="covReset">清空覆盖记录</button> <button id="covGuide">✚ 下一条未覆盖路径</button>${rows.join("") || '<div class="muted">可达范围内没有分支。</div>'}`
  $("#covReset").onclick = () => { state.cov.clear(); saveCov(); renderCoverage(); renderStep() }
  $("#covGuide").onclick = () => $("#btnGuide").click()
}

function renderBreakpoints() {
  const pane = $("#tab-bps")
  const rows = [
    ...[...state.bpFn].filter((f) => N[f]).map((f) => `<div class="covfn"><button data-rmfn="${f}" aria-label="删除断点">✕</button> <span class="linkish" style="display:inline" data-sel="${f}">ƒ ${esc(label(f))}</span></div>`),
    ...[...state.bpLine].map((k) => { const [f, l] = k.split(":"); return N[f] ? `<div class="covfn"><button data-rmline="${k}" aria-label="删除断点">✕</button> <span class="linkish" style="display:inline" data-sel="${f}">${esc(label(+f))}:${l}</span></div>` : "" }),
  ]
  pane.innerHTML = `<div class="muted small">右键树图中的函数 = 函数断点；点击源码行号 = 行断点。</div>${rows.join("") || '<div class="muted">暂无断点</div>'}${rows.length ? '<button id="bpClear">清空全部</button>' : ""}`
  for (const b of pane.querySelectorAll("[data-rmfn]")) b.onclick = () => { state.bpFn.delete(+b.dataset.rmfn); saveBps(); refreshBps() }
  for (const b of pane.querySelectorAll("[data-rmline]")) b.onclick = () => { state.bpLine.delete(b.dataset.rmline); saveBps(); refreshBps() }
  const clear = $("#bpClear")
  if (clear) clear.onclick = () => { state.bpFn.clear(); state.bpLine.clear(); saveBps(); refreshBps() }
}
function refreshBps() { renderBreakpoints(); markTreemap(); updateTreeMarks(); if (shownSource.fid != null) { shownSource.fid = null; renderSourceForPosition() } }
function toggleFnBreakpoint(i) { state.bpFn.has(i) ? state.bpFn.delete(i) : state.bpFn.add(i); saveBps(); refreshBps() }
// like a real debugger, a breakpoint on a non-step line snaps to the next step line
function toggleLineBreakpoint(fid, ln) {
  if (!state.bpLine.has(`${fid}:${ln}`)) {
    const steps = [...itemLines(fid)].filter((l) => l >= ln).sort((a, b) => a - b)
    if (!steps.length) return
    ln = steps[0]
  }
  const k = `${fid}:${ln}`
  state.bpLine.has(k) ? state.bpLine.delete(k) : state.bpLine.add(k)
  saveBps(); refreshBps()
}

function renderInfo(i) {
  const pane = $("#tab-info")
  const n = N[i]
  const list = (set) => [...(set || [])].map((t) => `<span class="linkish" data-sel="${t}">${esc(label(t))}</span>`).join("") || '<span class="muted">无</span>'
  const branches = branchItems(i).length
  pane.innerHTML = `<dl class="kv"><dt>类型</dt><dd>${n.k}${n.a ? " · async" : ""}</dd><dt>名称</dt><dd>${esc(n.q)}</dd>
    <dt>位置</dt><dd>${esc(n.f)}${n.s ? `:${n.s}-${n.e}` : ""}</dd>${n.sig ? `<dt>签名</dt><dd>${esc(n.sig)}</dd>` : ""}
    ${n.doc ? `<dt>说明</dt><dd>${esc(n.doc)}</dd>` : ""}${hasFlow(i) ? `<dt>步骤</dt><dd>${itemLines(i).size} 处 · 分支点 ${branches}</dd>` : ""}</dl>
    ${hasFlow(i) ? `<p><button id="infoRun">▶ 从这里开始</button> <button id="infoBp">${state.bpFn.has(i) ? "移除" : "设置"}函数断点</button></p>` : ""}
    <h2>调用方</h2>${list(CALLERS.get(i))}<h2 style="margin-top:8px">被调用</h2>${list(CALLEES.get(i))}
    ${kids(i).length ? `<h2 style="margin-top:8px">包含</h2>${kids(i).map((c) => `<span class="linkish" data-sel="${c}">${esc(N[c].k === "dir" ? N[c].n + "/" : N[c].n)}</span>`).join("")}` : ""}`
  const runBtn = $("#infoRun")
  if (runBtn) runBtn.onclick = () => restart(i)
  const bpBtn = $("#infoBp")
  if (bpBtn) bpBtn.onclick = () => { toggleFnBreakpoint(i); renderInfo(i) }
}

function drawStatic(i) {
  staticLayer.textContent = ""
  for (const t of CALLEES.get(i) || []) staticLayer.appendChild(svgEl("path", { class: "edge static", d: curve(anchor(i), anchor(t)) }))
  for (const t of CALLERS.get(i) || []) staticLayer.appendChild(svgEl("path", { class: "edge static", d: curve(anchor(t), anchor(i)) }))
}

function selectNode(i, { zoom = true } = {}) {
  state.selected = i
  state.viewFrame = null
  markTreemap()
  drawStatic(i)
  renderInfo(i)
  switchTab("info")
  revealInTree(i)
  if (zoom) zoomTo(kids(i).length ? i : N[i].p ?? ROOT)
  if (hasFlow(i) && !state.stack.some((f) => f.fid === i)) showSource(i, null, true)
  else renderSourceForPosition()
}

function switchTab(name) {
  for (const b of document.querySelectorAll(".tabbar button[data-tab]")) b.classList.toggle("on", b.dataset.tab === name)
  for (const p of document.querySelectorAll(".tabpane")) p.classList.toggle("on", p.id === `tab-${name}`)
  if (name === "trace") renderTrace()
  if (name === "cov") renderCoverage()
  if (name === "bps") renderBreakpoints()
  if (name === "info" && state.selected != null) renderInfo(state.selected)
}
for (const b of document.querySelectorAll(".tabbar button[data-tab]")) b.onclick = () => switchTab(b.dataset.tab)
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-sel]")
  if (t && t.dataset.sel !== "") selectNode(+t.dataset.sel)
})

// ---------------------------------------------------------------- entries
const GROUPS = [["http", "HTTP API"], ["ui", "前端组件"], ["cli", "命令行"], ["main", "模块入口"], ["root", "未被调用的函数（候选入口）"], ["all", "全部可执行函数"]]
function renderEntries() {
  const q = $("#entrySearch").value.trim().toLowerCase()
  const box = $("#entryList")
  box.textContent = ""
  const items = DATA.entries.map((e) => ({ ...e }))
  if (q) {
    const used = new Set(items.map((e) => e.node))
    for (let i = 0; i < N.length; i++) if (isFunc(i) && hasFlow(i) && !used.has(i)) items.push({ g: "all", label: `${N[i].q}  · ${N[i].f.split("/").slice(-2).join("/")}`, node: i })
  }
  for (const [g, title] of GROUPS) {
    const list = items.filter((e) => e.g === g && (!q || e.label.toLowerCase().includes(q) || N[e.node].q.toLowerCase().includes(q)))
    if (!list.length) continue
    const h = document.createElement("div")
    h.className = "grp"
    h.textContent = `${title} · ${list.length}`
    box.appendChild(h)
    for (const e of list.slice(0, 300)) {
      const b = document.createElement("button")
      b.className = "entry" + (state.entry === e.node ? " on" : "")
      b.title = `${e.label}\n→ ${N[e.node].q}`
      if (g === "http") {
        const [m, ...rest] = e.label.split(" ")
        b.innerHTML = `<span class="m m-${esc(m.split("/")[0])}">${esc(m)}</span>${esc(rest.join(" "))}`
      } else b.textContent = e.label
      b.onclick = () => { restart(e.node); renderEntries(); switchTab("trace") }
      box.appendChild(b)
    }
  }
}
$("#entrySearch").addEventListener("input", renderEntries)

// ---------------------------------------------------------------- tree explorer
const treeRows = new Map()
const expanded = new Set([ROOT])
const ICON = { dir: "▤", file: "◧", class: "C", function: "ƒ", method: "m" }
function renderTree() {
  const box = $("#tree")
  box.textContent = ""
  treeRows.clear()
  const add = (i, depth) => {
    const n = N[i]
    const cs = kids(i)
    const row = document.createElement("div")
    row.className = "tnode"
    row.setAttribute("role", "treeitem")
    row.tabIndex = 0
    row.style.paddingLeft = `${4 + depth * 12}px`
    if (cs.length) row.setAttribute("aria-expanded", expanded.has(i))
    row.innerHTML = `<span class="tw">${cs.length ? (expanded.has(i) ? "▾" : "▸") : ""}</span><span class="ic k-${n.k}">${ICON[n.k] || "·"}</span><span class="nm">${esc(i === ROOT ? DATA.meta.project : n.n)}</span>`
    row.onclick = (e) => {
      if (cs.length && (e.target.classList.contains("tw") || state.selected === i)) { expanded.has(i) ? expanded.delete(i) : expanded.add(i); renderTree() }
      selectNode(i)
    }
    row.ondblclick = () => { if (hasFlow(i)) { restart(i); switchTab("trace") } }
    row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(e) }
    box.appendChild(row)
    treeRows.set(i, row)
    if (expanded.has(i)) for (const c of [...cs].sort((a, b) => (N[a].k === "dir") === (N[b].k === "dir") ? (N[a].s || 0) - (N[b].s || 0) || N[a].n.localeCompare(N[b].n) : N[a].k === "dir" ? -1 : 1)) add(c, depth + 1)
  }
  add(ROOT, 0)
  updateTreeMarks()
}
function revealInTree(i) {
  let changed = false
  for (const a of ancestors(i).slice(1)) if (!expanded.has(a)) { expanded.add(a); changed = true }
  if (changed) renderTree()
  const row = treeRows.get(i)
  if (row) row.scrollIntoView({ block: "nearest" })
}
function updateTreeMarks() {
  for (const [i, row] of treeRows) {
    row.classList.toggle("sel", i === state.selected)
    row.classList.toggle("vis", state.visited.has(i))
    row.classList.toggle("bpOn", state.bpFn.has(i))
  }
}

// ---------------------------------------------------------------- controls
function updateControls() {
  const can = state.stack.length > 0
  for (const id of ["btnInto", "btnOver", "btnOut", "btnOutClass", "btnOutModule", "btnContinue"]) $("#" + id).disabled = !can || state.running
  $("#btnPause").disabled = !state.running
  $("#btnRestart").disabled = state.entry == null
  $("#btnGuide").disabled = state.entry == null
}
$("#btnInto").onclick = () => cmd.into()
$("#btnOver").onclick = () => cmd.over()
$("#btnOut").onclick = () => cmd.out()
$("#btnOutClass").onclick = () => cmd.outScope(classOf)
$("#btnOutModule").onclick = () => cmd.outScope(fileOf)
$("#btnContinue").onclick = () => cmd.cont()
$("#btnPause").onclick = () => cmd.pause()
$("#btnRestart").onclick = () => restart(state.entry)
$("#btnGuide").onclick = () => { restart(state.entry, { guide: true }); trace("br", "✚ 覆盖引导：分支优先选择未覆盖的路径"); renderTrace() }
$("#speed").oninput = (e) => { state.opts.speed = +e.target.value }
$("#optAnim").onchange = (e) => { state.opts.anim = e.target.checked }
$("#optFollow").onchange = (e) => { state.opts.follow = e.target.checked }
$("#optExt").onchange = (e) => { state.opts.ext = e.target.checked; shownSource.fid = null; render([]) }
$("#btnTheme").onclick = () => {
  const root = document.documentElement
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"
  localStorage.setItem("codeflow:theme", root.dataset.theme)
}
document.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.matches("input[type=search]")) return
  const map = { F8: () => cmd.cont(), F5: () => cmd.cont(), F10: () => cmd.over(), F11: () => (e.shiftKey ? cmd.out() : cmd.into()), Escape: () => cmd.pause() }
  const fn = map[e.key]
  if (fn) { e.preventDefault(); if (e.key === "Escape" || !$("#btnInto").disabled) fn() }
})

// ---------------------------------------------------------------- boot
;(function boot() {
  const theme = localStorage.getItem("codeflow:theme")
  if (theme) document.documentElement.dataset.theme = theme
  const s = DATA.meta.stats
  $("#projName").textContent = DATA.meta.project
  $("#projMeta").title = ` ${s.files} 文件 · ${s.classes} 类 · ${s.functions} 函数 · ${s.routes} API · 生成于 ${DATA.meta.generated}`
  $("#projMeta").textContent = `${s.functions} 函数 · ${s.routes} API`
  document.title = `${DATA.meta.project} · Code Flow Debugger`
  renderTreemap()
  setVB(fitRect(N[ROOT].r, 0.01))
  renderCrumbs()
  renderEntries()
  renderTree()
  render([])
  const warn = DATA.meta.warnings || []
  $("#tab-info").innerHTML = `<p>静态分析生成：调用关系来自 CodeGraph ${esc(DATA.meta.codegraph)}，分支来自源码语法树。分支选择表示“假设这次输入走这条路”，并非真实运行。</p>` +
    (warn.length ? `<h2>提示</h2>${warn.map((w) => `<div class="warn small">${esc(w)}</div>`).join("")}` : "")
})()
