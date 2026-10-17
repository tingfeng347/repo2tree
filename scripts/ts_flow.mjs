// Extract per-function control flow from TS/JS files with the TypeScript compiler API.
// stdin: {ts, files:[{path, abs, fileId, funcs:[{id,start,end,name}]}]}
// stdout: {flows:{id: items}, routes:[{methods, path, handler, file}], warnings:[]}
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

const input = JSON.parse(readFileSync(0, "utf8"))
const ts = createRequire(import.meta.url)(input.ts)
const MAX = 140
// callbacks these callees run synchronously (or right after render); others are deferred
const EAGER = new Set(["map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "some", "every", "sort", "flatMap", "useMemo", "useEffect", "useLayoutEffect", "useState", "then", "catch", "finally", "call", "apply", "run", "Promise", "from"])
const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options"])
const flows = {}
const routes = []
const warnings = []

const clip = (s) => {
  s = s.replace(/\s+/g, " ").trim()
  return s.length <= MAX ? s : s.slice(0, MAX - 1) + "…"
}

function kindFor(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n)

function declName(n) {
  if (n.name && ts.isIdentifier(n.name)) return n.name.text
  if (ts.isConstructorDeclaration(n)) return "constructor"
  const p = n.parent
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text
  return ""
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    const base = calleeName(expr.expression)
    return base ? `${base}.${expr.name.text}` : expr.name.text
  }
  if (ts.isCallExpression(expr)) return calleeName(expr.expression)
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return calleeName(expr.expression)
  return ""
}

function urlOf(arg) {
  if (!arg) return null
  let text = null
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) text = arg.text
  else if (ts.isTemplateExpression(arg)) text = arg.head.text + arg.templateSpans.map((s) => "{*}" + s.literal.text).join("")
  if (text == null) return null
  return /^(\/|https?:\/\/)/.test(text) ? text : null
}

function methodOf(call, name) {
  const tail = name.split(".").pop().toLowerCase()
  if (HTTP.has(tail) && name.includes(".")) return tail.toUpperCase()
  const init = call.arguments[1]
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const p of init.properties) {
      if (ts.isPropertyAssignment(p) && p.name && p.name.getText() === "method" && ts.isStringLiteralLike(p.initializer)) {
        return p.initializer.text.toUpperCase()
      }
    }
  }
  return "GET"
}

function processFile(f) {
  const text = readFileSync(f.abs, "utf8")
  const sf = ts.createSourceFile(f.abs, text, ts.ScriptTarget.Latest, true, kindFor(f.path))
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const endLine = (n) => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1
  const src = (n) => clip(n.getText(sf))

  const fnNodes = []
  const walk = (n) => { if (isFn(n)) fnNodes.push(n); ts.forEachChild(n, walk) }
  walk(sf)
  const owned = new Map() // ts node -> graph id
  for (const fn of f.funcs) {
    const cands = fnNodes.filter((n) => { const l = line(n); return l >= fn.start && l <= Math.min(fn.start + 2, fn.end) })
    if (!cands.length) continue
    const named = cands.filter((n) => declName(n) === fn.name)
    const pool = named.length ? named : cands
    pool.sort((a, b) => (b.getEnd() - b.getStart(sf)) - (a.getEnd() - a.getStart(sf)))
    if (!owned.has(pool[0])) owned.set(pool[0], fn.id)
  }

  let k = 0
  const key = () => ++k

  // ---- expressions: ordered list of items (calls, jsx renders, conditional arms, callbacks)
  function expr(node, ctx = {}) {
    const out = []
    const visit = (n, c) => {
      if (!n) return
      if (isFn(n)) {
        if (owned.has(n)) return
        const body = ts.isBlock(n.body) ? block(n.body.statements) : expr(n.body)
        if (!body.length) return
        let label = "回调"; let d = 1
        if (c.attr) label = `事件 ${c.attr}`
        else if (c.prop) label = `${c.prop} 回调`
        else if (c.callee) { label = `${c.callee} 回调`; d = EAGER.has(c.callee) ? 0 : 1 }
        out.push({ t: "cb", k: key(), l: line(n), x: label, d, arms: [
          { c: d ? `触发 ${label}（事件/异步发生时）` : `执行 ${label}`, l: line(n), b: body },
          { c: d ? "不触发（跳过）" : "不执行（跳过）", l: line(n), b: [], imp: 1 },
        ] })
        return
      }
      if (ts.isPropertyAssignment(n) && n.name) {
        visit(n.initializer, { prop: n.name.getText(sf) })
        return
      }
      if (ts.isConditionalExpression(n)) {
        const pre = expr(n.condition)
        const a = expr(n.whenTrue); const b = expr(n.whenFalse)
        out.push(...pre)
        if (a.length || b.length) {
          out.push({ t: "if", k: key(), l: line(n), x: `${clip(n.condition.getText(sf))} ?`, arms: [
            { c: `${clip(n.condition.getText(sf))} 为真`, l: line(n.whenTrue), b: a },
            { c: "否则", l: line(n.whenFalse), b: b },
          ] })
        }
        return
      }
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) {
        out.push(...expr(n.left))
        const right = expr(n.right)
        if (right.length) {
          const op = n.operatorToken.getText(sf)
          const cond = clip(n.left.getText(sf))
          const label = op === "&&" ? `${cond} 为真` : op === "||" ? `${cond} 为假` : `${cond} 为 null/undefined`
          out.push({ t: "if", k: key(), l: line(n), x: `${cond} ${op} …`, arms: [
            { c: label, l: line(n.right), b: right },
            { c: "否则（短路跳过）", l: line(n), b: [], imp: 1 },
          ] })
        }
        return
      }
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
        const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null
        if (open) {
          const tag = open.tagName.getText(sf)
          if (/^[A-Z]/.test(tag.split(".").pop())) {
            out.push({ t: "call", l: line(open), le: line(open), n: tag, x: clip(`<${tag}${open.attributes.properties.length ? " …" : ""}>`), jsx: 1 })
          }
          for (const attr of open.attributes.properties) {
            if (ts.isJsxAttribute(attr) && attr.initializer) visit(attr.initializer, { attr: attr.name.getText(sf) })
            else if (ts.isJsxSpreadAttribute(attr)) visit(attr.expression, {})
          }
        }
        const kids = ts.isJsxSelfClosingElement(n) ? [] : n.children
        for (const ch of kids) visit(ch, {})
        return
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const name = calleeName(n.expression)
        visit(n.expression, {})
        for (const a of n.arguments || []) visit(a, { callee: name.split(".").pop() })
        const item = { t: "call", l: line(n), le: endLine(n), n: name, x: src(n) }
        if (ts.isCallExpression(n)) {
          const url = urlOf(n.arguments[0])
          if (url) item.http = { m: methodOf(n, name), p: url, via: name }
          const tail = name.split(".").pop()
          const obj = name.split(".").slice(-2, -1)[0] || ""
          if (HTTP.has(tail) && /^(app|router|server|api|routes?)$/i.test(obj) && url && url.startsWith("/") && n.arguments.length >= 2) {
            const h = n.arguments[n.arguments.length - 1]
            if (ts.isIdentifier(h) || ts.isPropertyAccessExpression(h)) routes.push({ methods: [tail.toUpperCase()], path: url, handler: calleeName(h), file: f.path })
          }
        }
        out.push(item)
        return
      }
      ts.forEachChild(n, (ch) => visit(ch, c.attr ? c : {}))
    }
    visit(node, ctx)
    return out
  }

  // ---- statements
  function block(stmts) {
    const out = []
    for (const st of stmts) out.push(...stmt(st))
    return out
  }
  function body(st) { return st ? (ts.isBlock(st) ? block(st.statements) : stmt(st)) : [] }

  function stmt(st) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      return owned.has(st) || !ts.isFunctionDeclaration(st) ? [] : []
    }
    if (ts.isBlock(st)) return block(st.statements)
    if (ts.isIfStatement(st)) {
      const pre = expr(st.expression)
      const arms = []
      let cur = st; let first = true
      while (cur && ts.isIfStatement(cur)) {
        arms.push({ c: `${first ? "if" : "else if"} (${clip(cur.expression.getText(sf))})`, l: line(cur), b: [...(first ? [] : expr(cur.expression)), ...body(cur.thenStatement)] })
        first = false
        const e = cur.elseStatement
        if (e && ts.isIfStatement(e)) { cur = e; continue }
        if (e) arms.push({ c: "else", l: line(e), b: body(e) })
        else arms.push({ c: "条件均不成立（跳过）", l: line(st), b: [], imp: 1 })
        cur = null
      }
      return [...pre, { t: "if", k: key(), l: line(st), x: arms[0].c, arms }]
    }
    if (ts.isSwitchStatement(st)) {
      const arms = st.caseBlock.clauses.map((c) => ({
        c: ts.isCaseClause(c) ? `case ${clip(c.expression.getText(sf))}` : "default",
        l: line(c), b: block(c.statements),
      }))
      if (!st.caseBlock.clauses.some(ts.isDefaultClause)) arms.push({ c: "无 case 匹配（跳过）", l: line(st), b: [], imp: 1 })
      return [...expr(st.expression), { t: "if", k: key(), l: line(st), x: `switch (${clip(st.expression.getText(sf))})`, arms }]
    }
    if (ts.isForStatement(st) || ts.isForOfStatement(st) || ts.isForInStatement(st) || ts.isWhileStatement(st) || ts.isDoStatement(st)) {
      const head = ts.isForStatement(st) ? [st.initializer, st.condition] : [st.expression]
      const pre = head.filter(Boolean).flatMap((h) => expr(h))
      const label = clip(st.getText(sf).split("{")[0])
      return [...pre, { t: "loop", k: key(), l: line(st), x: label, b: body(st.statement) }]
    }
    if (ts.isTryStatement(st)) {
      const item = { t: "try", k: key(), l: line(st), x: "try", b: block(st.tryBlock.statements), h: [] }
      if (st.catchClause) {
        const v = st.catchClause.variableDeclaration
        item.h.push({ c: `catch${v ? ` (${v.getText(sf)})` : ""}`, l: line(st.catchClause), b: block(st.catchClause.block.statements) })
      }
      if (st.finallyBlock) item.f = block(st.finallyBlock.statements)
      return [item]
    }
    if (ts.isReturnStatement(st)) return [...expr(st.expression), { t: "ret", l: line(st), x: src(st) }]
    if (ts.isThrowStatement(st)) return [...expr(st.expression), { t: "raise", l: line(st), x: src(st) }]
    if (ts.isLabeledStatement(st)) return stmt(st.statement)
    return expr(st)
  }

  for (const [node, id] of owned) {
    k = 0
    const b = node.body
    if (!b) { flows[id] = []; continue }
    flows[id] = ts.isBlock(b) ? block(b.statements) : [...expr(b), { t: "ret", l: line(b), x: clip("return " + b.getText(sf)) }]
  }
  if (f.fileId) {
    k = 0
    const top = sf.statements.filter((s) => !ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s) && !ts.isImportDeclaration(s))
    flows[f.fileId] = block(top)
  }
}

for (const f of input.files) {
  try { processFile(f) } catch (err) { warnings.push(`${f.path}: TS 解析失败 (${err.message})`) }
}
process.stdout.write(JSON.stringify({ flows, routes, warnings }))
