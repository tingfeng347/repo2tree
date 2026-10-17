// ---------------------------------------------------------------- zoomable treemap
const W = 1600, H = 1000
const svg = $("#map")
const tmLayer = $("#tmLayer")
let VB = { x: 0, y: 0, w: W, h: H }
let scopeNode = ROOT
const G = new Map() // node -> {g, box, hdr, text, dot}

function squarify(items, rect) {
  // items: [{i, v}] sorted desc; returns Map i -> rect
  const out = new Map()
  const total = items.reduce((s, it) => s + it.v, 0)
  if (!total) return out
  const scale = (rect.w * rect.h) / total
  let r = { ...rect }
  let row = []
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b.a, 0)
    let max = 0, min = Infinity
    for (const it of row) { max = Math.max(max, it.a); min = Math.min(min, it.a) }
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min))
  }
  const layoutRow = (row) => {
    const s = row.reduce((a, b) => a + b.a, 0)
    if (r.w >= r.h) {
      const w = s / r.h
      let y = r.y
      for (const it of row) { const h = it.a / w; out.set(it.i, { x: r.x, y, w, h }); y += h }
      r = { x: r.x + w, y: r.y, w: r.w - w, h: r.h }
    } else {
      const h = s / r.w
      let x = r.x
      for (const it of row) { const w = it.a / h; out.set(it.i, { x, y: r.y, w, h }); x += w }
      r = { x: r.x, y: r.y + h, w: r.w, h: r.h - h }
    }
  }
  for (const it of items.map((it) => ({ i: it.i, a: it.v * scale }))) {
    const side = Math.min(r.w, r.h)
    if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it)
    else { layoutRow(row); row = [it] }
  }
  if (row.length) layoutRow(row)
  return out
}

function layout(i, rect) {
  const n = N[i]
  n.r = rect
  const cs = kids(i)
  if (!cs.length) return
  const hh = Math.min(rect.h * 0.085, rect.w * 0.05)
  const pad = Math.min(rect.w, rect.h) * 0.012
  n.hh = hh
  const inner = { x: rect.x + pad, y: rect.y + hh, w: rect.w - 2 * pad, h: rect.h - hh - pad }
  if (inner.w <= 0 || inner.h <= 0) return
  const rects = squarify(cs.map((c) => ({ i: c, v: N[c].wt })).sort((a, b) => b.v - a.v), inner)
  for (const [c, r] of rects) {
    const gap = Math.min(r.w, r.h) * 0.03
    layout(c, { x: r.x + gap / 2, y: r.y + gap / 2, w: Math.max(r.w - gap, 0.01), h: Math.max(r.h - gap, 0.01) })
  }
}

function renderTreemap() {
  layout(ROOT, { x: 0, y: 0, w: W, h: H })
  tmLayer.textContent = ""
  const draw = (i, parentG) => {
    const n = N[i]
    if (!n.r) return
    const leaf = !kids(i).length
    const g = svgEl("g", { class: `tm k-${n.k} l-${n.lang || "x"}${leaf ? " leaf" : ""}`, "data-i": i })
    const box = svgEl("rect", { class: "box", x: n.r.x, y: n.r.y, width: n.r.w, height: n.r.h, rx: Math.min(n.r.w, n.r.h) * 0.02 })
    g.appendChild(box)
    let hdr = null
    if (!leaf && n.hh) {
      hdr = svgEl("rect", { class: "hdr", x: n.r.x, y: n.r.y, width: n.r.w, height: n.hh })
      g.appendChild(hdr)
    }
    const text = svgEl("text", {})
    g.appendChild(text)
    const tip = svgEl("title")
    tip.textContent = `${n.k} · ${n.q}${n.f ? `\n${n.f}:${n.s ?? ""}` : ""}`
    g.appendChild(tip)
    parentG.appendChild(g)
    G.set(i, { g, box, hdr, text, leaf, dot: null })
    for (const c of kids(i)) draw(c, parentG)
  }
  draw(ROOT, tmLayer)
  setVB(VB)
}

function viewScale() {
  const bw = svg.clientWidth || 1, bh = svg.clientHeight || 1
  return Math.min(bw / VB.w, bh / VB.h)
}

function updateLabels() {
  const s = viewScale()
  const vx2 = VB.x + VB.w, vy2 = VB.y + VB.h
  for (const [i, el] of G) {
    const n = N[i]
    const r = n.r
    const visible = r.x < vx2 && r.x + r.w > VB.x && r.y < vy2 && r.y + r.h > VB.y && r.w * s > 1.5
    el.g.style.display = visible ? "" : "none"
    if (!visible) continue
    const fs = 12 / s
    let show, x, y, avail
    if (el.leaf) {
      show = r.w * s > 30 && r.h * s > 13
      x = r.x + 4 / s; y = r.y + Math.min(r.h / 2, 10 / s); avail = r.w * s - 8
    } else {
      show = n.hh * s >= 12 && r.w * s > 40
      x = r.x + 6 / s; y = r.y + n.hh / 2; avail = r.w * s - 12
    }
    if (!show) { el.text.textContent = ""; continue }
    const name = el.leaf ? n.n : n.k === "dir" ? `${n.n}/` : n.n
    const max = Math.max(1, Math.floor(avail / 7))
    el.text.textContent = name.length > max ? name.slice(0, Math.max(1, max - 1)) + "…" : name
    el.text.setAttribute("x", x); el.text.setAttribute("y", y); el.text.setAttribute("font-size", Math.min(fs, el.leaf ? r.h * 0.45 : n.hh * 0.72))
    if (el.dot) { el.dot.setAttribute("r", 4 / s); el.dot.setAttribute("cx", r.x + r.w - 7 / s); el.dot.setAttribute("cy", r.y + 7 / s) }
  }
  onViewChanged()
}

function setVB(v) {
  VB = v
  svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`)
  updateLabels()
}

let vbAnim = 0
function fitRect(r, margin = 0.04) {
  const bw = svg.clientWidth || W, bh = svg.clientHeight || H
  let w = r.w * (1 + margin * 2), h = r.h * (1 + margin * 2)
  const aspect = bw / bh
  if (w / h > aspect) h = w / aspect; else w = h * aspect
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
}
function zoomTo(i, ms = 650) {
  scopeNode = i
  renderCrumbs()
  animateVB(fitRect(N[i].r), ms)
}
function animateVB(target, ms) {
  const from = { ...VB }
  const t0 = performance.now()
  const id = ++vbAnim
  if (ms <= 0 || !state.opts.anim) { setVB(target); return }
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const tick = (now) => {
    if (id !== vbAnim) return
    const t = Math.min(1, (now - t0) / ms)
    const e = ease(t)
    setVB({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e })
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
function isRectVisible(r) {
  return r.x >= VB.x - 1 && r.y >= VB.y - 1 && r.x + r.w <= VB.x + VB.w + 1 && r.y + r.h <= VB.y + VB.h + 1 && r.w * viewScale() > 20
}

// pan / zoom / click
let drag = null
svg.addEventListener("wheel", (e) => {
  e.preventDefault()
  vbAnim++
  const pt = clientToSvg(e.clientX, e.clientY)
  const f = Math.exp(e.deltaY * 0.0015)
  const w = Math.min(W * 3, Math.max(W / 4000, VB.w * f)), h = VB.h * (w / VB.w)
  setVB({ x: pt.x - (pt.x - VB.x) * (w / VB.w), y: pt.y - (pt.y - VB.y) * (h / VB.h), w, h })
}, { passive: false })
svg.addEventListener("pointerdown", (e) => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY, vb: { ...VB }, moved: false }; svg.setPointerCapture(e.pointerId) } })
svg.addEventListener("pointermove", (e) => {
  if (!drag) return
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; svg.classList.add("drag") }
  if (!drag.moved) return
  vbAnim++
  const s = viewScale()
  setVB({ ...drag.vb, x: drag.vb.x - dx / s, y: drag.vb.y - dy / s })
})
svg.addEventListener("pointerup", (e) => {
  const d = drag
  drag = null
  svg.classList.remove("drag")
  if (d && !d.moved) {
    const i = hitTest(e.clientX, e.clientY)
    if (i != null) selectNode(i, { zoom: false })
  }
})
svg.addEventListener("dblclick", (e) => {
  const i = hitTest(e.clientX, e.clientY)
  if (i == null) return
  const target = kids(i).length ? i : N[i].p ?? ROOT
  zoomTo(target)
})
svg.addEventListener("contextmenu", (e) => {
  const i = hitTest(e.clientX, e.clientY)
  if (i != null && hasFlow(i)) { e.preventDefault(); toggleFnBreakpoint(i) }
})
function clientToSvg(cx, cy) {
  const p = svg.createSVGPoint(); p.x = cx; p.y = cy
  return p.matrixTransform(svg.getScreenCTM().inverse())
}
function hitTest(cx, cy) {
  const pt = clientToSvg(cx, cy)
  let best = null
  for (const [i, el] of G) {
    const r = N[i].r
    if (el.g.style.display === "none") continue
    if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
      if (best == null || ancestors(i).includes(best)) best = i
    }
  }
  return best
}
// refit whenever the stage changes size: window resize or a panel collapsing/expanding
let refitFrame = 0
new ResizeObserver(() => {
  cancelAnimationFrame(refitFrame)
  refitFrame = requestAnimationFrame(() => { if (N[scopeNode].r) setVB(fitRect(N[scopeNode].r)) })
}).observe(svg)

function renderCrumbs() {
  const nav = $("#crumbs")
  nav.textContent = ""
  const chain = ancestors(scopeNode).reverse()
  chain.forEach((i, idx) => {
    if (idx) { const s = document.createElement("span"); s.textContent = " › "; nav.appendChild(s) }
    const b = document.createElement("button")
    b.textContent = i === ROOT ? DATA.meta.project : N[i].n
    b.onclick = () => zoomTo(i)
    nav.appendChild(b)
  })
}

// anchor point for flow edges: leaf centre, or container header
function anchor(i) {
  const r = N[i].r
  if (!r) return { x: 0, y: 0 }
  if (!kids(i).length) return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  return { x: r.x + r.w / 2, y: r.y + (N[i].hh || r.h * 0.05) / 2 }
}
function curve(a, b, bend = 0.22) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) {
    const r = N[state.focus ?? ROOT]?.r?.w * 0.02 || 10
    return `M${a.x},${a.y} c${r * 3},${-r * 3} ${r * 3},${r * 3} 0,0`
  }
  return `M${a.x},${a.y} Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`
}
