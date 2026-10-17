"use strict"
// ---------------------------------------------------------------- data model
const DATA = window.__CODEFLOW__
const N = DATA.nodes
const ROOT = DATA.root
const $ = (sel, el = document) => el.querySelector(sel)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const SVGNS = "http://www.w3.org/2000/svg"
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}
const isFunc = (i) => N[i].k === "function" || N[i].k === "method"
const hasFlow = (i) => Array.isArray(N[i].flow)
const kids = (i) => N[i].c.filter((c) => !N[c].dead)

function ancestors(i) {
  const out = []
  while (i != null) { out.push(i); i = N[i].p }
  return out
}
function lca(a, b) {
  const A = new Set(ancestors(a))
  for (const x of ancestors(b)) if (A.has(x)) return x
  return ROOT
}
function fileOf(i) { return ancestors(i).find((x) => N[x].k === "file") ?? null }
function classOf(i) { return ancestors(i).find((x) => x !== i && N[x].k === "class") ?? null }
function label(i) {
  const n = N[i]
  if (n.k === "file") return `${n.n}（模块）`
  const c = classOf(i)
  return c != null ? `${N[c].n}.${n.n}` : n.n
}

// walk every item of a flow tree
function walkItems(items, fn) {
  for (const it of items || []) {
    fn(it)
    for (const k of ["b", "el", "f"]) if (it[k]) walkItems(it[k], fn)
    for (const k of ["arms", "h"]) for (const a of it[k] || []) walkItems(a.b, fn)
  }
}

// static call graph from flows
const CALLEES = new Map()
const CALLERS = new Map()
for (let i = 0; i < N.length; i++) {
  if (!hasFlow(i)) continue
  walkItems(N[i].flow, (it) => {
    for (const t of it.to || []) {
      if (!CALLEES.has(i)) CALLEES.set(i, new Set())
      CALLEES.get(i).add(t)
      if (!CALLERS.has(t)) CALLERS.set(t, new Set())
      CALLERS.get(t).add(i)
    }
  })
}

// treemap weights: lines of code for leaves, sum for containers
function weigh(i) {
  const n = N[i]
  const cs = kids(i)
  if (!cs.length) { n.wt = Math.max(3, (n.e || 0) - (n.s || 0) + 1); return n.wt }
  n.wt = cs.reduce((s, c) => s + weigh(c), 0) + (n.k === "file" ? 2 : 0)
  return n.wt
}
weigh(ROOT)

// branch-arm bookkeeping used by coverage and choice UI
function armsOf(it) {
  if (it.t === "if" || it.t === "cb") return it.arms.map((a) => a.c)
  if (it.t === "loop") return ["进入循环体（演示一次迭代）", "跳过循环（0 次迭代）"]
  if (it.t === "try") return ["try 体正常完成", ...it.h.map((h) => `异常 → ${h.c}`)]
  return []
}
function branchItems(i) {
  const out = []
  if (hasFlow(i)) walkItems(N[i].flow, (it) => { if (it.k != null) out.push(it) })
  return out
}
function reachable(start) {
  const seen = new Set([start])
  const q = [start]
  while (q.length) {
    const i = q.pop()
    for (const t of CALLEES.get(i) || []) if (!seen.has(t) && hasFlow(t)) { seen.add(t); q.push(t) }
  }
  return seen
}
