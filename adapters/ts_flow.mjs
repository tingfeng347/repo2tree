// Extract per-function control flow from TS/JS files with the TypeScript compiler API.
// stdin: {ts, files:[{path, abs, fileId, funcs:[{id,start,end,name}]}]}
// stdout: {flows:{id: items}, routes:[{methods, path, handler, file}], warnings:[]}
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

const payload = JSON.parse(readFileSync(0, "utf8"))
if (!payload.typescript) {
  process.stdout.write(JSON.stringify({ nodes: [], flows: {}, routes: [], diagnostics: [{message:"未找到 TypeScript 编译器：TS/JS 保留索引结构，控制流未提取；运行 npm install 或设置 REPO2TREE_TYPESCRIPT"}] }))
  process.exit(0)
}
const input = { files: Object.keys(payload.sources).filter(p => /\.[cm]?[jt]sx?$/.test(p)).map(path => ({
  path, abs: path, source: payload.sources[path],
  fileId: payload.nodes.find(n => n.path === path && n.kind === "file")?.id || `ast:file:${path}`,
  funcs: payload.nodes.filter(n => n.path === path && ["function","method","constructor","lambda"].includes(n.kind)).map(n => ({...n,start:n.line,end:n.endLine}))
})) }
const ts = createRequire(process.cwd() + "/package.json")(payload.typescript)
const addedNodes = []
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
  const text = f.source
  const sf = ts.createSourceFile(f.abs, text, ts.ScriptTarget.Latest, true, kindFor(f.path))
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const endLine = (n) => sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1
  const src = (n) => clip(n.getText(sf))

  const owned = new Map()
  const column = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).character
  function register(n, parent = f.fileId, prefix = "") {
    let current = parent, qualified = prefix
    const isClass = ts.isClassDeclaration(n) || ts.isClassExpression(n)
    if (isFn(n) || isClass) {
      const label = declName(n) || n.name?.getText(sf) || `<callback@${line(n)}:${column(n)}>`
      const candidates = payload.nodes.filter(g => g.path === f.path && g.name === label && Math.abs(g.line - line(n)) <= 2)
      const match = candidates.find(g => g.line === line(n) && g.column === column(n)) || (candidates.length === 1 ? candidates[0] : null)
      current = match?.id || `ast:${f.path}:${line(n)}:${column(n)}:${label}`
      qualified = prefix + label + "."
      addedNodes.push({id:current,parent,kind:isClass?"class":ts.isMethodDeclaration(n)?"method":ts.isConstructorDeclaration(n)?"constructor":"function",name:label,qualifiedName:prefix+label,path:f.path,language:f.path.endsWith(".tsx")?"tsx":f.path.endsWith(".jsx")?"jsx":/\.[cm]?js$/.test(f.path)?"javascript":"typescript",line:line(n),endLine:endLine(n),column:column(n),endColumn:sf.getLineAndCharacterOfPosition(n.getEnd()).character,origin:match?"codegraph+ast":"ast",executionKind:n.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)?"async":undefined})
      if (isFn(n)) owned.set(n,current)
    }
    ts.forEachChild(n,ch => register(ch,current,qualified))
  }
  register(sf)
  for (const error of sf.parseDiagnostics) warnings.push(`${f.path}: TypeScript 语法诊断 ${ts.flattenDiagnosticMessageText(error.messageText," ")}；该文件的提取可能不完整`)

  let k = 0
  const key = () => ++k

  // ---- expressions: ordered list of items (calls, jsx renders, conditional arms, callbacks)
  function expr(node, ctx = {}) {
    const out = []
    const visit = (n, c) => {
      if (!n) return
      if (isFn(n)) {
        if (owned.has(n)) {
          // Definition/registration never implies execution. The user may trigger a callback explicitly.
          if (c.callee || c.attr || c.prop) out.push({t:"cb",l:line(n),col:column(n),x:`${c.attr || c.prop || c.callee} 回调`,arms:[
            {c:"假设本次回调被触发",b:[{t:"call",l:line(n),col:column(n),x:declName(n)||"匿名回调",n:declName(n),target:owned.get(n)}]},
            {c:"仅注册，不触发",b:[]}
          ]})
          return
        }
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
      if (ts.isIdentifier(n) && c.attr && /^on[A-Z]/.test(c.attr)) {
        out.push({t:"cb",l:line(n),col:column(n),x:`事件 ${c.attr}`,arms:[
          {c:`假设 ${c.attr} 被触发`,b:[{t:"call",l:line(n),col:column(n),n:n.text,x:n.text+"(…)"}]},
          {c:"仅绑定事件，不触发",b:[]}
        ]}); return
      }
      if (ts.isIdentifier(n) && c.callee && addedNodes.some(g=>g.path===f.path&&g.name===n.text&&g.kind!=="class")) {
        out.push({t:"cb",l:line(n),col:column(n),x:`传给 ${c.callee} 的函数 ${n.text}`,arms:[
          {c:"假设本次调用该回调",b:[{t:"call",l:line(n),col:column(n),n:n.text,x:n.text+"(…)"}]},
          {c:"仅传递函数引用，不调用",b:[]}
        ]}); return
      }
      if (ts.isAwaitExpression(n)) { visit(n.expression,{});out.push({t:"await",l:line(n),x:src(n)});return }
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
        const deferred = []
        for (const a of n.arguments || []) {
          const before = out.length
          visit(a, { callee: name.split(".").pop() })
          const argumentItems = out.splice(before)
          out.push(...argumentItems.filter(it => it.t !== "cb"))
          deferred.push(...argumentItems.filter(it => it.t === "cb"))
        }
        const site = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression
        const item = { t: "call", l: line(n), col: column(n), sl:line(site), sc:column(site), le: endLine(n), n: name, x: src(n) }
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
        out.push(...deferred)
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
      return [...expr(st.expression),{t:"if",l:line(st),x:`if (${clip(st.expression.getText(sf))})`,arms:[
        {c:`${clip(st.expression.getText(sf))} 为真`,l:line(st.thenStatement),b:body(st.thenStatement)},
        {c:"否则",l:st.elseStatement?line(st.elseStatement):line(st),b:body(st.elseStatement)}
      ]}]
    }
    if (ts.isSwitchStatement(st)) {
      const clauses = [...st.caseBlock.clauses]
      const arms = clauses.map((c,i) => {
        const stmts=[]
        // JavaScript switch falls through until a real break/return/throw.
        for(let j=i;j<clauses.length;j++) stmts.push(...clauses[j].statements)
        return {c:ts.isCaseClause(c)?`case ${clip(c.expression.getText(sf))}`:"default",l:line(c),b:block(stmts)}
      })
      if(!clauses.some(ts.isDefaultClause)) arms.push({c:"无 case 匹配",b:[]})
      return [...expr(st.expression),{t:"switch",l:line(st),x:src(st.expression),arms}]
    }
    if (ts.isForStatement(st) || ts.isForOfStatement(st) || ts.isForInStatement(st) || ts.isWhileStatement(st) || ts.isDoStatement(st)) {
      const init = ts.isForStatement(st) ? expr(st.initializer) : []
      const cond = ts.isForStatement(st) ? expr(st.condition) : ts.isWhileStatement(st)||ts.isDoStatement(st) ? expr(st.expression) : expr(st.expression)
      const increment = ts.isForStatement(st) ? expr(st.incrementor) : []
      const b = body(st.statement)
      return [...init,{t:"loop",l:line(st),x:clip(st.getText(sf).split("{")[0]),b,pre:cond,whileLoop:ts.isForStatement(st)||ts.isWhileStatement(st)||ts.isDoStatement(st),minIterations:ts.isDoStatement(st)?1:0,increment}]
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
    if (ts.isBreakStatement(st)) return [{t:st.label?"opaque":"break",l:line(st),x:src(st),reason:st.label?"带标签的 break 未模拟":undefined}]
    if (ts.isContinueStatement(st)) return [{t:st.label?"opaque":"continue",l:line(st),x:src(st),reason:st.label?"带标签的 continue 未模拟":undefined}]
    if (ts.isLabeledStatement(st)) return [{t:"opaque",l:line(st),x:src(st),reason:"带标签控制流未模拟"}]
    return [...expr(st),{t:"stmt",l:line(st),x:src(st)}]
  }

  for (const [node, id] of owned) {
    k = 0
    const b = node.body
    if (!b) { continue }
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
process.stdout.write(JSON.stringify({nodes:addedNodes,flows,routes:routes.flatMap(r=>r.methods.map(method=>({method,path:r.path,node:addedNodes.find(n=>n.path===r.file&&n.name===r.handler)?.id,file:r.file}))).filter(r=>r.node),diagnostics:warnings.map(message=>({message}))}))
