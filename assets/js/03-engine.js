// ---------------------------------------------------------------- debugger engine
// A frame walks one function's flow tree. levels is a stack of blocks being
// executed (function body, chosen branch arm, loop body, try body, handler).
const MAX_DEPTH = 64
const PROJECT_KEY = `codeflow:${DATA.meta.root}`
const state = {
  entry: null, stack: [], status: "idle", focus: null,
  visited: new Set(), cov: new Set(JSON.parse(localStorage.getItem(PROJECT_KEY + ":cov") || "[]")),
  trace: [], guide: false, running: false, runId: 0,
  bpFn: new Set(), bpLine: new Set(),
  opts: { anim: true, follow: true, ext: false, speed: 55 },
}
try {
  const bp = JSON.parse(localStorage.getItem(PROJECT_KEY + ":bp") || "{}")
  for (const f of bp.fn || []) state.bpFn.add(f)
  for (const l of bp.line || []) state.bpLine.add(l)
} catch { /* corrupt storage: start without breakpoints */ }
const saveBps = () => localStorage.setItem(PROJECT_KEY + ":bp", JSON.stringify({ fn: [...state.bpFn], line: [...state.bpLine] }))
const saveCov = () => localStorage.setItem(PROJECT_KEY + ":cov", JSON.stringify([...state.cov]))
const covKey = (fid, it, arm) => `${fid}:${it.l}:${it.k}:${arm}`

function newFrame(fid, callItem = null) {
  return { fid, levels: [{ items: N[fid].flow, i: 0, kind: "body" }], pick: new Map(), callItem }
}
const top = () => state.stack[state.stack.length - 1]

function skippable(it) {
  return it.t === "call" && it.ext && !state.opts.ext
}

// advance past finished blocks; returns the next item or null when the frame ends
function settle(fr) {
  while (fr.levels.length) {
    const L = fr.levels[fr.levels.length - 1]
    while (L.i < L.items.length && skippable(L.items[L.i])) L.i++
    if (L.i < L.items.length) return L.items[L.i]
    fr.levels.pop()
    if (L.kind === "try") {
      state.cov.add(covKey(fr.fid, L.item, 0))
      if (L.item.f) fr.levels.push({ items: L.item.f, i: 0, kind: "block" })
      if (L.item.el) fr.levels.push({ items: L.item.el, i: 0, kind: "block" })
    } else if (L.kind === "handler" && L.item.f) {
      fr.levels.push({ items: L.item.f, i: 0, kind: "block" })
    }
  }
  return null
}
const current = () => (top() ? settle(top()) : null)

// options offered at an item, and the selected index
function optionsFor(it) {
  if (it.t === "call" || it.t === "http") {
    const enter = enterTarget(it)
    return [enter != null ? `正常执行（可进入 ${label(enter)}）` : "正常执行", "模拟此调用抛出异常"]
  }
  return armsOf(it)
}
function firstUncovered(fid, it) {
  const n = armsOf(it).length
  for (let a = 0; a < n; a++) if (!state.cov.has(covKey(fid, it, a))) return a
  return null
}
function pickOf(fr, it) {
  if (fr.pick.has(it)) return fr.pick.get(it)
  if (it.k != null && state.guide) {
    const a = firstUncovered(fr.fid, it)
    if (a != null) return a
  }
  return defaultArm(it)
}
// happy path first: avoid arms that immediately raise when another arm exists
function defaultArm(it) {
  if (it.d != null) return it.d
  if (it.t !== "if") return 0
  // skip error arms (raise) and guard clauses (`if (!x) return`) when a fall-through arm exists
  const bad = (a) => a.b.some((x) => x.t === "raise") || (a.b.length <= 2 && a.b.at(-1)?.t === "ret" && !a.imp)
  const ok = it.arms.findIndex((a) => !bad(a))
  return ok < 0 ? 0 : ok
}
function enterTarget(it) {
  return (it.to || []).find((t) => hasFlow(t)) ?? null
}

function trace(type, text, extra = {}) {
  state.trace.push({ type, text, depth: Math.max(0, state.stack.length - 1), fid: top()?.fid, ...extra })
  if (state.trace.length > 3000) state.trace.splice(0, 500)
}

// execute exactly one item in the top frame; returns visual events
function exec(mode = "into") {
  const fr = top()
  if (!fr) return []
  const it = settle(fr)
  if (!it) return doReturn(fr, "end")
  const L = fr.levels[fr.levels.length - 1]
  const ev = []
  switch (it.t) {
    case "call":
    case "http": {
      L.i++
      if (pickOf(fr, it) === 1) {
        trace("exc", `✗ ${it.n || it.x} 抛出异常（模拟）`, { line: it.l })
        return raise(`${it.n || it.x} 抛出异常`)
      }
      const target = enterTarget(it)
      const recursion = state.stack.filter((f) => f.fid === target).length >= 2
      const kind = it.t === "http" ? "http" : "call"
      if (mode === "into" && target != null && state.stack.length < MAX_DEPTH && !recursion) {
        trace(kind, `${kind === "http" ? "⇢ " + (it.route || it.x) + " → " : "→ "}${label(target)}`, { line: it.l, to: target })
        state.stack.push(newFrame(target, it))
        state.visited.add(target)
        ev.push({ type: kind, from: fr.fid, to: target })
      } else {
        const t = (it.to || [])[0]
        trace(kind, `· ${it.x}${recursion ? "（递归，已折叠）" : ""}`, { line: it.l, to: t })
        if (t != null) { state.visited.add(t); ev.push({ type: kind, from: fr.fid, to: t, flash: true }) }
      }
      return ev
    }
    case "if":
    case "cb":
    case "loop": {
      L.i++
      const a = pickOf(fr, it)
      state.cov.add(covKey(fr.fid, it, a))
      trace("br", it.t === "if" ? `◇ ${armsOf(it)[a]}` : `◇ ${it.x} ⇒ ${armsOf(it)[a]}`, { line: it.l })
      if (it.t === "loop") {
        if (a === 0) fr.levels.push({ items: it.b, i: 0, kind: "loop" })
        else if (it.el) fr.levels.push({ items: it.el, i: 0, kind: "block" })
      } else {
        fr.levels.push({ items: it.arms[a].b, i: 0, kind: it.t === "cb" ? "cbarm" : "arm" })
      }
      return [{ type: "branch", fid: fr.fid }]
    }
    case "try": {
      L.i++
      const a = pickOf(fr, it)
      if (a > 0) {
        state.cov.add(covKey(fr.fid, it, a))
        trace("exc", `✗ try 体内模拟异常 ⇒ ${it.h[a - 1].c}`, { line: it.l })
        fr.levels.push({ items: it.h[a - 1].b, i: 0, kind: "handler", item: it })
      } else {
        trace("br", "◇ 进入 try", { line: it.l })
        fr.levels.push({ items: it.b, i: 0, kind: "try", item: it })
      }
      return [{ type: "branch", fid: fr.fid }]
    }
    case "ret": {
      L.i++
      // a return inside an inline callback only leaves that callback
      const cb = fr.levels.map((l) => l.kind).lastIndexOf("cbarm")
      if (cb > 0) {
        fr.levels.length = cb
        trace("ret", `↩ 回调返回 ${it.x}`, { line: it.l })
        return [{ type: "branch", fid: fr.fid }]
      }
      return doReturn(fr, "return", it)
    }
    case "raise":
      L.i++
      trace("exc", `✗ ${it.x}`, { line: it.l })
      return raise(it.x)
  }
  L.i++
  return ev
}

function doReturn(fr, how, it) {
  state.stack.pop()
  const caller = top()
  trace("ret", `← ${label(fr.fid)} ${how === "return" ? "返回" : "结束"}${it ? "  " + it.x : ""}`)
  if (!caller) { state.status = "done"; return [{ type: "done" }] }
  return [{ type: "ret", from: fr.fid, to: caller.fid }]
}

// unwind to the nearest try with handlers, across frames
function raise(msg) {
  const ev = []
  while (state.stack.length) {
    const fr = top()
    while (fr.levels.length) {
      const L = fr.levels.pop()
      if (L.kind === "try" && L.item.h.length) {
        const pick = fr.pick.get(L.item)
        const h = pick > 0 ? pick - 1 : 0
        state.cov.add(covKey(fr.fid, L.item, h + 1))
        trace("exc", `⤷ 被 ${L.item.h[h].c} 捕获（${label(fr.fid)}）`, { line: L.item.h[h].l })
        fr.levels.push({ items: L.item.h[h].b, i: 0, kind: "handler", item: L.item })
        ev.push({ type: "caught", fid: fr.fid })
        return ev
      }
    }
    state.stack.pop()
    const caller = top()
    if (caller) {
      trace("exc", `⇠ 异常从 ${label(fr.fid)} 向上抛到 ${label(caller.fid)}`)
      ev.push({ type: "exc", from: fr.fid, to: caller.fid })
    }
  }
  state.status = "uncaught"
  state.uncaught = msg
  trace("exc", `✗ 未捕获异常，执行终止：${msg}`)
  ev.push({ type: "done" })
  return ev
}

function atBreakpoint(justEntered) {
  const fr = top()
  if (!fr) return false
  if (justEntered && state.bpFn.has(fr.fid)) return true
  const it = settle(fr)
  return !!it && state.bpLine.has(`${fr.fid}:${it.l}`)
}

function restart(fid, { guide = false } = {}) {
  stopRun()
  state.entry = fid
  state.guide = guide
  state.stack = [newFrame(fid)]
  state.status = "paused"
  state.trace = []
  state.visited = new Set([fid])
  state.uncaught = null
  trace("call", `▶ 入口 ${label(fid)}`, { to: fid })
  render([{ type: "enter", to: fid }])
}

function stopRun() { state.running = false; state.runId++ }
const delay = () => 60 + (100 - state.opts.speed) * 14
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// run steps until `done(depthBefore)` says stop; breakpoints always stop
async function run(done, { animate }) {
  if (!state.stack.length) return
  stopRun()
  const id = state.runId
  state.running = true
  updateControls()
  let budget = 20000
  while (state.running && id === state.runId && state.stack.length && budget-- > 0) {
    const before = state.stack.length
    const ev = exec("into")
    const entered = state.stack.length > before
    const stop = !state.stack.length || done() || atBreakpoint(entered)
    if (animate) { render(ev); await sleep(delay()) }
    if (stop) break
  }
  if (budget <= 0) trace("br", "⚠ 运行步数达到上限，已暂停")
  state.running = false
  saveCov()
  render([])
}

const cmd = {
  into() { stopRun(); if (!top()) return; render(exec("into")); saveCov() },
  over() {
    stopRun()
    const d0 = state.stack.length
    if (!d0) return
    const ev = exec("into")
    if (state.stack.length > d0 && !atBreakpoint(true)) {
      // the call was entered: finish it instantly, honouring breakpoints
      run(() => state.stack.length <= d0, { animate: false })
    } else { render(ev); saveCov() }
  },
  out() { const d0 = state.stack.length; run(() => state.stack.length < d0, { animate: state.opts.anim }) },
  outScope(scopeOf) {
    const fr = top()
    if (!fr) return
    const s = scopeOf(fr.fid)
    if (s == null) return cmd.out()
    let j = state.stack.length - 1
    while (j > 0 && scopeOf(state.stack[j - 1].fid) === s) j--
    run(() => state.stack.length <= j, { animate: state.opts.anim })
  },
  cont() { run(() => false, { animate: state.opts.anim }) },
  pause() { stopRun(); render([]) },
}
