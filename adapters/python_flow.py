"""Parse source text only. Never import or execute the scanned project."""
import ast
import json
import sys
from collections import defaultdict

payload = json.load(sys.stdin)
nodes, flows, routes, diagnostics = [], {}, [], []
original = payload["nodes"]
original_by_path = defaultdict(list)
original_by_name = defaultdict(list)
original_ids = set()
added_by_id = {}
for symbol in original:
    original_by_path[symbol["path"]].append(symbol)
    original_by_name[(symbol["path"], symbol["name"])].append(symbol)
    original_ids.add(symbol["id"])


def text(n):
    try:
        return ast.unparse(n)
    except Exception:
        return type(n).__name__


def name(n):
    if isinstance(n, ast.Name):
        return n.id
    if isinstance(n, ast.Attribute):
        return name(n.value) + "." + n.attr
    return ""


class Extractor:
    def __init__(self, path, source):
        self.path, self.source = path, source
        self.lines = source.splitlines()
        self.tree = ast.parse(source)
        self.ids = {}
        self.parents = {child: parent for parent in ast.walk(self.tree) for child in ast.iter_child_nodes(parent)}
        self.file = next((n["id"] for n in original_by_path[path] if n["kind"] == "file"), f"ast:file:{path}")
        if self.file not in original_ids:
            nodes.append(dict(id=self.file, kind="file", name=path.rsplit("/", 1)[-1], path=path,
                              language="python", line=1, endLine=len(source.splitlines()), origin="ast"))
        self.qnames = {}
        self.register(self.tree, self.file, "")

    def register(self, node, parent, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                label = getattr(child, "name", f"<lambda@{child.lineno}:{child.col_offset}>")
                p = self.parents.get(child)
                if isinstance(child, ast.Lambda) and isinstance(p, (ast.Assign, ast.AnnAssign)):
                    target = p.targets[0] if isinstance(p, ast.Assign) else p.target
                    label = name(target) or label
                earliest = min([child.lineno] + [d.lineno for d in getattr(child, "decorator_list", [])])
                candidates = [n for n in original_by_name[(self.path, label)]
                              if earliest <= n["line"] <= child.lineno]
                match = next((n for n in candidates if n.get("column", child.col_offset) == child.col_offset), candidates[0] if len(candidates) == 1 else None)
                sid = match["id"] if match else f"ast:{self.path}:{child.lineno}:{child.col_offset}:{label}"
                self.ids[child] = sid
                q = prefix + label
                self.qnames[sid] = q
                parent_node = added_by_id.get(parent)
                kind = "class" if isinstance(child, ast.ClassDef) else "lambda" if isinstance(child, ast.Lambda) else "method" if parent_node and parent_node["kind"] == "class" else "function"
                nodes.append(dict(id=sid, kind=kind, name=label, qualifiedName=q, path=self.path,
                                  language="python", line=child.lineno, endLine=child.end_lineno,
                                  column=child.col_offset, endColumn=child.end_col_offset,
                                  parent=parent, origin="codegraph+ast" if match else "ast"))
                added_by_id[sid] = nodes[-1]
                if isinstance(child, ast.AsyncFunctionDef):
                    nodes[-1]["executionKind"] = "coroutine"
                elif isinstance(child, (ast.FunctionDef, ast.Lambda)):
                    def has_yield(n):
                        if n is not child and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                            return False
                        return isinstance(n, (ast.Yield, ast.YieldFrom)) or any(has_yield(c) for c in ast.iter_child_nodes(n))
                    if has_yield(child):
                        nodes[-1]["executionKind"] = "generator"
                self.register(child, sid, q + ".")
            else:
                self.register(child, parent, prefix)

    def item(self, node, kind, **kw):
        def utf16(line, offset):
            value = self.lines[line - 1] if line <= len(self.lines) else ""
            return len(value.encode("utf-8")[:offset].decode("utf-8", errors="replace").encode("utf-16-le")) // 2
        line = getattr(node, "lineno", 1)
        site = {}
        if isinstance(node, ast.Call):
            callee = node.func
            site_line = getattr(callee, "end_lineno", line) if isinstance(callee, ast.Attribute) else getattr(callee, "lineno", line)
            site_col = callee.end_col_offset - len(callee.attr.encode("utf-8")) if isinstance(callee, ast.Attribute) else getattr(callee, "col_offset", 0)
            site = dict(sl=site_line, sc=utf16(site_line, site_col))
        return dict(t=kind, l=line, col=utf16(line, getattr(node, "col_offset", 0)), **site,
                    le=getattr(node, "end_lineno", 1), x=text(node)[:300], **kw)

    def expr(self, n):
        if n is None or isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return []
        if isinstance(n, ast.BoolOp):
            def parts(values):
                if len(values) == 1:
                    return self.expr(values[0])
                label = text(values[0]) + (" 为真，继续求值" if isinstance(n.op, ast.And) else " 为假，继续求值")
                return self.expr(values[0]) + [self.item(values[0], "if", arms=[
                    dict(c=label, b=parts(values[1:])), dict(c="短路，停止求值", b=[])])]
            return parts(n.values)
        if isinstance(n, ast.IfExp):
            return self.expr(n.test) + [self.item(n, "if", arms=[
                dict(c=text(n.test) + " 为真", b=self.expr(n.body)), dict(c="否则", b=self.expr(n.orelse))])]
        if isinstance(n, ast.Compare) and len(n.comparators) > 1:
            def rest(index):
                evaluated = self.expr(n.comparators[index])
                if index == len(n.comparators) - 1:
                    return evaluated
                return evaluated + [self.item(n.comparators[index], "if", arms=[dict(c="前一段比较成立，继续链式比较", b=rest(index + 1)), dict(c="比较失败，短路退出", b=[])])]
            return self.expr(n.left) + rest(0)
        if isinstance(n, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            inner = self.expr(n.key) + self.expr(n.value) if isinstance(n, ast.DictComp) else self.expr(n.elt)
            for gen in reversed(n.generators):
                for guard in reversed(gen.ifs):
                    inner = self.expr(guard) + [self.item(guard, "if", arms=[dict(c=text(guard) + " 为真", b=inner), dict(c="过滤当前元素", b=[])])]
                inner = self.expr(gen.iter) + [self.item(gen.iter, "loop", b=inner)]
            if isinstance(n, ast.GeneratorExp):
                return [self.item(n, "cb", arms=[dict(c="假设生成器被消费", b=inner), dict(c="只创建生成器，不消费", b=[])])]
            return inner
        if isinstance(n, ast.Await):
            return self.expr(n.value) + [self.item(n, "await")]
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            return self.expr(n.value) + [self.item(n, "await")]
        if isinstance(n, ast.Call):
            out = self.expr(n.func)
            for a in n.args:
                out += self.expr(a)
            for kw in n.keywords:
                out += self.expr(kw.value)
            return out + [self.item(n, "call", n=name(n.func))]
        return [item for child in ast.iter_child_nodes(n) for item in self.expr(child)]

    def block(self, stmts):
        return [op for s in stmts for op in self.stmt(s)]

    def stmt(self, s):
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)):
            return []
        if isinstance(s, ast.If):
            return self.expr(s.test) + [self.item(s, "if", arms=[
                dict(c=text(s.test) + " 为真", b=self.block(s.body)), dict(c="否则", b=self.block(s.orelse))])]
        if isinstance(s, (ast.For, ast.AsyncFor, ast.While)):
            head = s.test if isinstance(s, ast.While) else s.iter
            # While condition calls belong to each iteration, not a once-only prefix.
            return [self.item(s, "loop", b=self.block(s.body), el=self.block(s.orelse),
                              pre=self.expr(head), whileLoop=isinstance(s, ast.While))]
        if isinstance(s, ast.Try):
            return [self.item(s, "try", b=self.block(s.body), el=self.block(s.orelse), f=self.block(s.finalbody),
                              h=[dict(c="except " + (text(h.type) if h.type else "*"), b=self.block(h.body)) for h in s.handlers])]
        if isinstance(s, getattr(ast, "TryStar", type(None))):
            return [self.item(s, "opaque", reason="异常组 except* 需要并行分派，本版不模拟")]
        if isinstance(s, (ast.With, ast.AsyncWith)):
            diagnostics.append(dict(path=self.path, line=s.lineno, message="with 的 __enter__/__exit__ 是隐式调用，未模拟；仅展开显式主体"))
            return [op for w in s.items for op in self.expr(w.context_expr)] + [self.item(s, "opaque", reason="隐式上下文协议未解析")] + self.block(s.body)
        if isinstance(s, ast.Match):
            arms = [dict(c="case " + text(c.pattern) + (" if " + text(c.guard) if c.guard else ""), b=self.expr(c.guard) + self.block(c.body)) for c in s.cases]
            if not any(isinstance(c.pattern, ast.MatchAs) and c.pattern.pattern is None and c.guard is None for c in s.cases):
                arms.append(dict(c="无模式匹配", b=[]))
            return self.expr(s.subject) + [self.item(s, "if", arms=arms)]
        if isinstance(s, ast.Assert):
            return self.expr(s.test) + [self.item(s, "if", arms=[dict(c="断言通过", b=[]), dict(c="断言失败", b=self.expr(s.msg) + [self.item(s, "raise")])])]
        if isinstance(s, ast.Return):
            return self.expr(s.value) + [self.item(s, "ret")]
        if isinstance(s, ast.Raise):
            return self.expr(s.exc) + self.expr(s.cause) + [self.item(s, "raise")]
        if isinstance(s, ast.Break):
            return [self.item(s, "break")]
        if isinstance(s, ast.Continue):
            return [self.item(s, "continue")]
        return self.expr(s) + [self.item(s, "stmt")]

    def extract(self):
        for n, sid in self.ids.items():
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                flows[sid] = self.block(n.body)
                for dec in n.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
                        method = dec.func.attr.upper()
                        if method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                            routes.append(dict(method=method, path=dec.args[0].value, node=sid, owner=name(dec.func.value), file=self.path))
                        elif method == "COMMAND":
                            # CLI entries are still available as functions; no HTTP route is fabricated.
                            pass
            elif isinstance(n, ast.Lambda):
                flows[sid] = self.expr(n.body) + [self.item(n.body, "ret")]
        flows[self.file] = self.block(self.tree.body)


extractors = []
for path, source in payload["sources"].items():
    if path.endswith((".py", ".pyi")):
        try:
            e = Extractor(path, source)
            e.extract()
            extractors.append(e)
        except (SyntaxError, ValueError) as exc:
            diagnostics.append(dict(path=path, message=f"Python 解析失败，保留结构：{exc}"))

# Router prefixes: keep all plausible registrations instead of choosing the first.
prefixes = {}
mounts = []
for e in extractors:
    for n in ast.walk(e.tree):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.value, ast.Call):
            if name(n.value.func).rsplit(".", 1)[-1] in ("APIRouter", "Blueprint"):
                prefix = next((kw.value.value for kw in n.value.keywords if kw.arg in ("prefix", "url_prefix") and isinstance(kw.value, ast.Constant)), "")
                prefixes[e.path, name(n.targets[0])] = prefix
        if isinstance(n, ast.Call) and name(n.func).endswith(("include_router", "register_blueprint")) and n.args:
            prefix = next((kw.value.value for kw in n.keywords if kw.arg in ("prefix", "url_prefix") and isinstance(kw.value, ast.Constant)), "")
            mounts.append((e.path, name(n.args[0]), prefix))
expanded = []
for r in routes:
    base = prefixes.get((r["file"], r["owner"]), "")
    outer = [p for file, owner, p in mounts if file == r["file"] and owner == r["owner"]] or [""]
    for p in outer:
        expanded.append({**r, "path": "/" + "/".join(str(v).strip("/") for v in (p, base, r["path"]) if v)})
json.dump(dict(nodes=nodes, flows=flows, routes=expanded, diagnostics=diagnostics), sys.stdout, ensure_ascii=False)
