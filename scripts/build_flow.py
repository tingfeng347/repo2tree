#!/usr/bin/env python3
"""Build an interactive code-flow debugger HTML from a CodeGraph index.

Reads <project>/.codegraph/codegraph.db (read-only), extracts per-function
control flow (calls / branches / loops / try / return / raise) with Python's
ast and the TypeScript compiler API, links frontend HTTP calls to backend
route handlers, and embeds everything into assets/viewer.html.
"""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
UNIT_KINDS = ("file", "class", "function", "method")
CALL_EDGE_KINDS = ("calls", "instantiates")
PY_LANGS = {"python"}
TS_LANGS = {"typescript", "tsx", "javascript", "jsx"}
HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")
TEST_RE = re.compile(r"(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]*\.py$|_test\.py$")
MAX_TEXT = 140


def clip(text: str, limit: int = MAX_TEXT) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# --------------------------------------------------------------------------- graph


class Graph:
    def __init__(self, db_path: Path, include_tests: bool):
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        marks = ",".join("?" * len(UNIT_KINDS))
        rows = con.execute(
            f"select id, kind, name, qualified_name, file_path, language, start_line, end_line,"
            f" docstring, signature, is_async, is_exported from nodes where kind in ({marks})",
            UNIT_KINDS,
        ).fetchall()
        self.nodes = {
            r["id"]: dict(r) for r in rows if include_tests or not TEST_RE.search(r["file_path"])
        }
        self.parent: dict[str, str] = {}
        for src, tgt in con.execute("select source, target from edges where kind='contains'"):
            if src in self.nodes and tgt in self.nodes:
                self.parent[tgt] = src
        self.calls: dict[str, list[dict]] = defaultdict(list)
        marks = ",".join("?" * len(CALL_EDGE_KINDS))
        for r in con.execute(
            f"select source, target, kind, line, metadata from edges where kind in ({marks})",
            CALL_EDGE_KINDS,
        ):
            if r["source"] in self.nodes and r["target"] in self.nodes:
                self.calls[r["source"]].append(
                    {"to": r["target"], "line": r["line"] or 0, "name": self.nodes[r["target"]]["name"]}
                )
        self.version = dict(con.execute("select key, value from project_metadata").fetchall()).get(
            "indexed_with_version", "?"
        )
        con.close()
        self.by_name: dict[str, list[str]] = defaultdict(list)
        for nid, n in self.nodes.items():
            if n["kind"] in ("function", "method", "class"):
                self.by_name[n["name"]].append(nid)
        self.used: dict[str, set[int]] = defaultdict(set)

    def resolve(self, fid: str, name: str, line: int, line_end: int) -> tuple[list[str], bool]:
        """Map a syntactic call to graph targets: edge match first, unique-name guess second."""
        edges = self.calls.get(fid, [])
        tail = name.split(".")[-1]
        for want_name in (True, False):
            for idx, e in enumerate(edges):
                if idx in self.used[fid] or not (line <= e["line"] <= max(line, line_end)):
                    continue
                if want_name and e["name"] != tail:
                    continue
                self.used[fid].add(idx)
                return [e["to"]], False
        cands = self.by_name.get(tail, [])
        if not cands or tail in ("__init__", "get", "set", "run", "main"):
            return [], False
        same_file = [c for c in cands if self.nodes[c]["file_path"] == self.nodes[fid]["file_path"]]
        pick = same_file or cands
        if len(pick) == 1:
            return pick, True
        return [], False

    def unused_edges(self, fid: str) -> list[dict]:
        return [e for i, e in enumerate(self.calls.get(fid, [])) if i not in self.used[fid]]


# --------------------------------------------------------------------------- python flow


class PyFlow:
    """Turn a Python function body into flow items with lines and branch arms."""

    def __init__(self, lines: list[str]):
        self.lines = lines
        self.k = 0

    def key(self) -> int:
        self.k += 1
        return self.k

    def text(self, node: ast.AST) -> str:
        try:
            return clip(ast.unparse(node))
        except Exception:  # noqa: BLE001 - unparse fails only on exotic nodes; fall back to raw line
            return clip(self.lines[node.lineno - 1]) if getattr(node, "lineno", 0) else ""

    def calls_in(self, node: ast.AST | None) -> list[dict]:
        out: list[dict] = []

        def visit(n: ast.AST) -> None:
            if isinstance(n, (ast.Lambda, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                return
            for child in ast.iter_child_nodes(n):
                visit(child)
            if isinstance(n, ast.Call):
                out.append(
                    {
                        "t": "call",
                        "l": n.lineno,
                        "le": getattr(n, "end_lineno", n.lineno) or n.lineno,
                        "n": call_name(n.func),
                        "x": self.text(n),
                    }
                )

        if node is not None:
            visit(node)
        return out

    def block(self, stmts: list[ast.stmt]) -> list[dict]:
        out: list[dict] = []
        for st in stmts:
            out.extend(self.stmt(st))
        return out

    def stmt(self, st: ast.stmt) -> list[dict]:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)):
            return []
        if isinstance(st, ast.If):
            pre = self.calls_in(st.test)
            arms = []
            cur: ast.stmt | None = st
            first = True
            while isinstance(cur, ast.If):
                label = ("if " if first else "elif ") + self.text(cur.test)
                pre_arm = [] if first else self.calls_in(cur.test)
                arms.append({"c": label, "l": cur.lineno, "b": pre_arm + self.block(cur.body)})
                first = False
                nxt = cur.orelse
                if len(nxt) == 1 and isinstance(nxt[0], ast.If):
                    cur = nxt[0]
                else:
                    if nxt:
                        arms.append({"c": "else", "l": nxt[0].lineno, "b": self.block(nxt)})
                    else:
                        arms.append({"c": "条件均不成立（跳过）", "l": st.lineno, "b": [], "imp": 1})
                    cur = None
            return pre + [{"t": "if", "k": self.key(), "l": st.lineno, "x": arms[0]["c"], "arms": arms}]
        if isinstance(st, (ast.For, ast.AsyncFor, ast.While)):
            head = st.iter if not isinstance(st, ast.While) else st.test
            label = (
                f"for {self.text(st.target)} in {self.text(st.iter)}"
                if not isinstance(st, ast.While)
                else f"while {self.text(st.test)}"
            )
            item = {"t": "loop", "k": self.key(), "l": st.lineno, "x": clip(label), "b": self.block(st.body)}
            if st.orelse:
                item["el"] = self.block(st.orelse)
            return self.calls_in(head) + [item]
        if isinstance(st, (ast.Try, getattr(ast, "TryStar", ast.Try))):
            handlers = [
                {
                    "c": "except " + (self.text(h.type) if h.type else "*") + (f" as {h.name}" if h.name else ""),
                    "l": h.lineno,
                    "b": self.block(h.body),
                }
                for h in st.handlers
            ]
            item = {"t": "try", "k": self.key(), "l": st.lineno, "x": "try", "b": self.block(st.body), "h": handlers}
            if st.orelse:
                item["el"] = self.block(st.orelse)
            if st.finalbody:
                item["f"] = self.block(st.finalbody)
            return [item]
        if isinstance(st, (ast.With, ast.AsyncWith)):
            pre: list[dict] = []
            for w in st.items:
                pre.extend(self.calls_in(w.context_expr))
            return pre + self.block(st.body)
        if isinstance(st, ast.Match):
            arms = [
                {
                    "c": "case " + self.text(c.pattern) + (f" if {self.text(c.guard)}" if c.guard else ""),
                    "l": c.pattern.lineno,
                    "b": self.block(c.body),
                }
                for c in st.cases
            ]
            arms.append({"c": "无 case 匹配（跳过）", "l": st.lineno, "b": [], "imp": 1})
            return self.calls_in(st.subject) + [
                {"t": "if", "k": self.key(), "l": st.lineno, "x": "match " + self.text(st.subject), "arms": arms}
            ]
        if isinstance(st, ast.Return):
            return self.calls_in(st.value) + [
                {"t": "ret", "l": st.lineno, "x": clip(self.lines[st.lineno - 1].strip())}
            ]
        if isinstance(st, ast.Raise):
            return self.calls_in(st.exc) + [
                {"t": "raise", "l": st.lineno, "x": clip(self.lines[st.lineno - 1].strip())}
            ]
        return self.calls_in(st)


def call_name(func: ast.AST) -> str:
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        base = call_name(func.value)
        return f"{base}.{func.attr}" if base else func.attr
    if isinstance(func, ast.Call):
        return call_name(func.func)
    return ""


def python_file(path: Path, rel: str, funcs: list[dict], file_id: str | None) -> tuple[dict, list[dict], list[tuple]]:
    """Return ({node_id: flow}, routes, include_router prefixes) for one Python file."""
    source = path.read_text(encoding="utf-8", errors="replace")
    tree = ast.parse(source)
    lines = source.splitlines()
    defs: dict[int, ast.AST] = {}
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs[n.lineno] = n
    flows: dict[str, list] = {}
    routes: list[dict] = []
    for f in funcs:
        node = defs.get(f["start_line"])
        if node is None:
            node = next(
                (d for ln, d in defs.items() if abs(ln - f["start_line"]) <= 3 and d.name == f["name"]), None
            )
        if node is None:
            continue
        flows[f["id"]] = PyFlow(lines).block(node.body)
        for dec in node.decorator_list:
            route = py_route(dec) or cli_command(dec, f["name"])
            if route:
                routes.append({**route, "node": f["id"], "file": rel})
    if file_id:
        top = [st for st in tree.body if not isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        flows[file_id] = PyFlow(lines).block(top)
    prefixes = []  # (router var, prefix) declared in this file and include_router(expr, prefix)
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call) and len(n.targets) == 1:
            ctor = call_name(n.value.func).split(".")[-1]
            if ctor in ("APIRouter", "Blueprint") and isinstance(n.targets[0], ast.Name):
                pre = kwarg_str(n.value, "prefix" if ctor == "APIRouter" else "url_prefix")
                prefixes.append(("router", rel, n.targets[0].id, pre or ""))
        if isinstance(n, ast.Call) and call_name(n.func).endswith(("include_router", "register_blueprint")) and n.args:
            pre = kwarg_str(n, "prefix") or kwarg_str(n, "url_prefix") or ""
            prefixes.append(("include", rel, ast.unparse(n.args[0]), pre))
    return flows, routes, prefixes


def kwarg_str(call: ast.Call, name: str) -> str | None:
    for kw in call.keywords:
        if kw.arg == name and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
            return kw.value.value
    return None


def cli_command(dec: ast.AST, fn_name: str) -> dict | None:
    """typer/click `@app.command()` / `@cli.command("name")` become CLI entries."""
    func = dec.func if isinstance(dec, ast.Call) else dec
    if not isinstance(func, ast.Attribute) or func.attr != "command":
        return None
    name = fn_name.replace("_", "-")
    if isinstance(dec, ast.Call) and dec.args and isinstance(dec.args[0], ast.Constant):
        name = str(dec.args[0].value)
    return {"methods": ["CLI"], "path": name, "owner": call_name(func.value)}


def py_route(dec: ast.AST) -> dict | None:
    if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
        return None
    attr = dec.func.attr.lower()
    owner = call_name(dec.func.value)
    if not dec.args or not isinstance(dec.args[0], ast.Constant) or not isinstance(dec.args[0].value, str):
        return None
    path = dec.args[0].value
    if attr in HTTP_METHODS:
        return {"methods": [attr.upper()], "path": path, "owner": owner}
    if attr in ("route", "api_route", "websocket"):
        methods = ["GET"]
        for kw in dec.keywords:
            if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                methods = [e.value.upper() for e in kw.value.elts if isinstance(e, ast.Constant)]
        return {"methods": methods if attr != "websocket" else ["WS"], "path": path, "owner": owner}
    return None


def apply_router_prefixes(routes: list[dict], prefixes: list[tuple]) -> list[dict]:
    """FastAPI/Flask: router-level prefix plus include_router(prefix) from the app module."""
    own = {(rel, var): pre for kind, rel, var, pre in prefixes if kind == "router"}
    includes = [(expr, pre) for kind, _rel, expr, pre in prefixes if kind == "include"]
    out = []
    for r in routes:
        owner = r["owner"].split(".")[-1]
        base = own.get((r["file"], owner))
        if base is None:
            out.append({**r, "full": r["path"]})
            continue
        stem = Path(r["file"]).stem
        outer = [pre for expr, pre in includes if expr in (f"{stem}.{owner}", owner) or expr.endswith(f".{stem}.{owner}")]
        for pre in outer or [""]:
            out.append({**r, "full": join_url(pre, base, r["path"])})
    return out


def join_url(*parts: str) -> str:
    joined = "/".join(p.strip("/") for p in parts if p and p.strip("/"))
    return "/" + joined


# --------------------------------------------------------------------------- typescript flow


def find_typescript(project: Path, explicit: str | None) -> Path | None:
    cands = [Path(explicit)] if explicit else []
    for base in [project, *[p for p in project.iterdir() if p.is_dir()]]:
        cands.append(base / "node_modules" / "typescript" / "lib" / "typescript.js")
    npm = shutil.which("npm")
    if npm:
        try:
            root = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=20).stdout.strip()
            cands.append(Path(root) / "typescript" / "lib" / "typescript.js")
        except (OSError, subprocess.SubprocessError):
            pass
    return next((c for c in cands if c.is_file()), None)


def typescript_files(project: Path, files: dict[str, list[dict]], file_ids: dict[str, str], ts_path: Path) -> dict:
    payload = {
        "ts": str(ts_path),
        "files": [
            {
                "path": rel,
                "abs": str(project / rel),
                "fileId": file_ids.get(rel),
                "funcs": [{"id": f["id"], "start": f["start_line"], "end": f["end_line"], "name": f["name"]} for f in funcs],
            }
            for rel, funcs in files.items()
        ],
    }
    proc = subprocess.run(
        ["node", str(SKILL_DIR / "scripts" / "ts_flow.mjs")],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ts_flow.mjs failed: {proc.stderr.strip()[:2000]}")
    return json.loads(proc.stdout)


# --------------------------------------------------------------------------- http linking


PARAM_RE = re.compile(r"\{[^}]*\}|:[A-Za-z_]\w*|<[^>]+>")
HTTP_CLIENT_RE = re.compile(r"(^|\.)(fetch|request|axios|ky|got|http|ajax|\$http|api)$|^axios\.|^http\.|^ky\.", re.I)


def url_segments(path: str) -> list[str]:
    path = re.sub(r"^https?://[^/]+", "", path).split("?")[0].split("#")[0]
    return [("*" if PARAM_RE.fullmatch(seg) else seg) for seg in path.strip("/").split("/") if seg]


def match_route(method: str, url: str, routes: list[dict]) -> dict | None:
    """Segment-wise match: route params and client template holes match any segment."""
    client = url_segments(url)
    best, best_score = None, -1
    for r in routes:
        if method not in r["methods"] and not (method == "GET" and "WS" in r["methods"]):
            continue
        segs = r["segs"]
        if len(segs) != len(client):
            continue
        score = 0
        for a, b in zip(segs, client):
            if a == "*" or b == "*":
                continue
            if a != b:
                break
            score += 1
        else:
            if score > best_score:
                best, best_score = r, score
    return best


# --------------------------------------------------------------------------- assembly


def finish_items(items: list[dict], g: Graph, fid: str, routes: list[dict], stats: dict) -> list[dict]:
    """Resolve call names to node ids and expand frontend HTTP calls into http items."""
    out: list[dict] = []
    for it in items:
        t = it["t"]
        if t == "call":
            to, guess = g.resolve(fid, it.get("n", ""), it["l"], it.get("le", it["l"]))
            item = {"t": "call", "l": it["l"], "x": it["x"], "n": it.get("n", "")}
            if to:
                item["to"] = to
                stats["resolved"] += 1
                if guess:
                    item["g"] = 1
            else:
                item["ext"] = 1
                stats["external"] += 1
            if it.get("jsx"):
                item["jsx"] = 1
            out.append(item)
            http = it.get("http")
            r = match_route(http["m"], http["p"], routes) if http else None
            if http and (r or HTTP_CLIENT_RE.search(http.get("via", ""))):
                h = {"t": "http", "l": it["l"], "x": f'{http["m"]} {http["p"]}', "m": http["m"]}
                if r:
                    h["to"] = [r["node"]]
                    h["route"] = f'{http["m"]} {r["full"]}'
                    stats["http_linked"] += 1
                else:
                    stats["http_unlinked"] += 1
                out.append(h)
            continue
        new = {k: v for k, v in it.items() if k not in ("b", "arms", "h", "el", "f")}
        if "b" in it:
            new["b"] = finish_items(it["b"], g, fid, routes, stats)
        if "el" in it:
            new["el"] = finish_items(it["el"], g, fid, routes, stats)
        if "f" in it:
            new["f"] = finish_items(it["f"], g, fid, routes, stats)
        if "arms" in it:
            new["arms"] = [{**a, "b": finish_items(a["b"], g, fid, routes, stats)} for a in it["arms"]]
        if "h" in it:
            new["h"] = [{**a, "b": finish_items(a["b"], g, fid, routes, stats)} for a in it["h"]]
        out.append(new)
    return out


def merge_leftover_edges(items: list[dict], leftovers: list[dict], g: Graph) -> list[dict]:
    """Graph edges the parser did not see (decorators, odd syntax) become top-level calls by line."""
    if not leftovers:
        return items
    extra = [
        {"t": "call", "l": e["line"], "x": f'{e["name"]}(…)', "n": e["name"], "to": [e["to"]], "edge": 1}
        for e in leftovers
    ]
    merged = sorted(items + extra, key=lambda it: it.get("l", 0))
    return merged


def is_runnable_flow(items: list[dict]) -> bool:
    return any(it["t"] in ("call", "http", "if", "loop", "try", "cb") for it in items)


def has_internal(items: list[dict]) -> bool:
    for it in items:
        if it.get("to"):
            return True
        nested = [it.get(k, []) for k in ("b", "el", "f")] + [a["b"] for a in it.get("arms", []) + it.get("h", [])]
        if any(has_internal(b) for b in nested):
            return True
    return False


def build(project: Path, out: Path, include_tests: bool, embed_source: bool, ts_explicit: str | None) -> dict:
    db = project / ".codegraph" / "codegraph.db"
    if not db.is_file():
        raise SystemExit(f"未找到 {db}。先在项目根运行 `codegraph init` 建立索引。")
    g = Graph(db, include_tests)
    nodes = g.nodes

    # ids: compact integers for the viewer
    order = sorted(nodes, key=lambda i: (nodes[i]["file_path"], nodes[i]["start_line"], nodes[i]["kind"] != "file"))
    file_ids = {nodes[i]["file_path"]: i for i in order if nodes[i]["kind"] == "file"}

    # parent: nested functions are flattened to their nearest class/file container
    def container(nid: str) -> str | None:
        p = g.parent.get(nid)
        while p and nodes[p]["kind"] in ("function", "method"):
            p = g.parent.get(p)
        if p is None and nodes[nid]["kind"] != "file":
            p = file_ids.get(nodes[nid]["file_path"])
        return p

    funcs_by_file: dict[str, list[dict]] = defaultdict(list)
    for nid in order:
        n = nodes[nid]
        if n["kind"] in ("function", "method"):
            funcs_by_file[n["file_path"]].append(n)

    flows: dict[str, list] = {}
    routes: list[dict] = []
    prefixes: list[tuple] = []
    warnings: list[str] = []
    py_files = [f for f in file_ids if nodes[file_ids[f]]["language"] in PY_LANGS]
    ts_files = [f for f in file_ids if nodes[file_ids[f]]["language"] in TS_LANGS]
    for rel in py_files:
        try:
            fl, rt, px = python_file(project / rel, rel, funcs_by_file.get(rel, []), file_ids.get(rel))
        except (OSError, SyntaxError, ValueError) as exc:
            warnings.append(f"{rel}: Python 解析失败 ({exc})，该文件函数退化为按调用边排序")
            continue
        flows.update(fl)
        routes.extend(rt)
        prefixes.extend(px)
    routes = apply_router_prefixes(routes, prefixes)

    ts_result: dict = {"flows": {}, "routes": [], "warnings": []}
    if ts_files:
        ts_path = find_typescript(project, ts_explicit)
        if ts_path and shutil.which("node"):
            ts_result = typescript_files(project, {f: funcs_by_file.get(f, []) for f in ts_files}, file_ids, ts_path)
        else:
            warnings.append("未找到 node 或 typescript 包：TS/JS 函数退化为按调用边排序（无分支信息）。可用 --typescript 指定 typescript.js")
    flows.update(ts_result["flows"])
    warnings.extend(ts_result.get("warnings", []))
    for r in ts_result.get("routes", []):
        name = r["handler"].split(".")[-1]
        cands = [c for c in g.by_name.get(name, []) if nodes[c]["file_path"] == r["file"]] or g.by_name.get(name, [])
        if len(cands) == 1:
            routes.append({**r, "node": cands[0], "full": r["path"]})
    for r in routes:
        r["segs"] = url_segments(r["full"])

    stats = defaultdict(int)
    final_flows: dict[str, list] = {}
    for nid in order:
        n = nodes[nid]
        if n["kind"] not in ("function", "method", "file"):
            continue
        raw = flows.get(nid)
        if raw is None:
            if n["kind"] == "file":
                continue
            stats["fallback"] += 1
            raw = []
        items = finish_items(raw, g, nid, routes, stats)
        items = merge_leftover_edges(items, g.unused_edges(nid), g)
        if n["kind"] == "file" and not has_internal(items):
            continue
        final_flows[nid] = items

    idx = {nid: i for i, nid in enumerate(order)}

    def remap(items: list[dict]) -> list[dict]:
        for it in items:
            if "to" in it:
                it["to"] = [idx[t] for t in it["to"] if t in idx]
            for key in ("b", "el", "f"):
                if key in it:
                    remap(it[key])
            for key in ("arms", "h"):
                for arm in it.get(key, []):
                    remap(arm["b"])
        return items

    # hierarchy with directory nodes
    out_nodes: list[dict] = []
    for nid in order:
        n = nodes[nid]
        out_nodes.append(
            {
                "k": n["kind"],
                "n": n["name"] if n["kind"] != "file" else Path(n["file_path"]).name,
                "q": n["qualified_name"],
                "f": n["file_path"],
                "lang": n["language"],
                "s": n["start_line"],
                "e": n["end_line"],
                "sig": n["signature"] or "",
                "doc": clip(n["docstring"] or "", 400),
                "a": n["is_async"] or 0,
                "c": [],
            }
        )
    dir_index: dict[str, int] = {}

    def dir_node(path: str) -> int:
        if path in dir_index:
            return dir_index[path]
        out_nodes.append(
            {"k": "dir", "n": Path(path).name if path else project.name, "q": path or ".", "f": path, "c": []}
        )
        dir_index[path] = len(out_nodes) - 1
        if path:
            parent = dir_node(str(Path(path).parent) if str(Path(path).parent) != "." else "")
            out_nodes[dir_index[path]]["p"] = parent
            out_nodes[parent]["c"].append(dir_index[path])
        return dir_index[path]

    root = dir_node("")
    for nid in order:
        i = idx[nid]
        if nodes[nid]["kind"] == "file":
            parent_dir = str(Path(nodes[nid]["file_path"]).parent)
            p = dir_node("" if parent_dir == "." else parent_dir)
        else:
            c = container(nid)
            if c is None or c not in idx:
                continue
            p = idx[c]
        out_nodes[i]["p"] = p
        out_nodes[p]["c"].append(i)
    for nid, items in final_flows.items():
        out_nodes[idx[nid]]["flow"] = remap(items)

    # collapse single-child directory chains (backend/src/pkg -> one node)
    def collapse(i: int) -> None:
        n = out_nodes[i]
        while n["k"] == "dir" and len(n["c"]) == 1 and out_nodes[n["c"][0]]["k"] == "dir" and i != root:
            child = out_nodes[n["c"][0]]
            n["n"] = f'{n["n"]}/{child["n"]}'
            n["q"] = child["q"]
            n["c"] = child["c"]
            for gc in n["c"]:
                out_nodes[gc]["p"] = i
            child["dead"] = 1
        for c in n["c"]:
            collapse(c)

    collapse(root)

    # entries
    entries = []
    seen_routes = set()
    for r in routes:
        key = (tuple(r["methods"]), r["full"], r["node"])
        if key in seen_routes or r["node"] not in idx:
            continue
        seen_routes.add(key)
        if r["methods"] == ["CLI"]:
            entries.append({"g": "cli", "label": f'$ {r["path"]}  ({r["file"]})', "node": idx[r["node"]]})
        else:
            entries.append({"g": "http", "label": f'{"/".join(r["methods"])} {r["full"]}', "node": idx[r["node"]]})
    route_nodes = {r["node"] for r in routes}
    called = {e["to"] for es in g.calls.values() for e in es}
    for nid in order:
        n = nodes[nid]
        i = idx[nid]
        if "flow" not in out_nodes[i] or nid in route_nodes:
            continue
        if n["kind"] == "file":
            entries.append({"g": "main", "label": f'{n["file_path"]}（模块顶层）', "node": i})
        elif n["language"] in TS_LANGS and n["file_path"].endswith((".tsx", ".jsx")) and n["name"][:1].isupper():
            entries.append({"g": "ui", "label": f'<{n["name"]}/>  {n["file_path"]}', "node": i})
        elif nid not in called and n["kind"] in ("function", "method") and is_runnable_flow(out_nodes[i]["flow"]):
            short = "/".join(n["file_path"].split("/")[-2:])
            entries.append({"g": "root", "label": f'{n["qualified_name"]}  · {short}', "node": i})

    sources = {}
    if embed_source:
        for rel in file_ids:
            try:
                sources[rel] = (project / rel).read_text(encoding="utf-8", errors="replace")
            except OSError:
                warnings.append(f"{rel}: 无法读取源码")

    data = {
        "meta": {
            "project": project.name,
            "root": str(project),
            "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "codegraph": g.version,
            "stats": {
                "files": len(file_ids),
                "functions": sum(1 for n in nodes.values() if n["kind"] in ("function", "method")),
                "classes": sum(1 for n in nodes.values() if n["kind"] == "class"),
                "routes": len([e for e in entries if e["g"] == "http"]),
                "cli": len([e for e in entries if e["g"] == "cli"]),
                **stats,
            },
            "warnings": warnings,
        },
        "root": root,
        "nodes": out_nodes,
        "entries": entries,
        "src": sources,
    }
    assets = SKILL_DIR / "assets"
    template = (assets / "viewer.html").read_text(encoding="utf-8")
    js = "\n".join(p.read_text(encoding="utf-8") for p in sorted((assets / "js").glob("*.js")))
    js = "(() => {\n" + js + "\n})()"  # private scope: avoids clashes with window globals
    template = template.replace("/*__CODEFLOW_CSS__*/", (assets / "viewer.css").read_text(encoding="utf-8"))
    template = template.replace("/*__CODEFLOW_JS__*/", js.replace("</script", "<\\/script"))
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = template.replace("/*__CODEFLOW_DATA__*/null", blob)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return data["meta"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", default=".", help="项目根目录（含 .codegraph/）")
    ap.add_argument("--out", help="输出 HTML 路径，默认 <project>/.codeflow/codeflow-<时间>.html")
    ap.add_argument("--include-tests", action="store_true", help="包含测试文件")
    ap.add_argument("--no-source", action="store_true", help="不内嵌源码（体积更小，源码面板为空）")
    ap.add_argument("--typescript", help="typescript.js 路径（默认自动查找项目 node_modules 与全局）")
    ap.add_argument("--sync", action="store_true", help="先运行 codegraph sync 刷新索引")
    args = ap.parse_args()
    project = Path(args.project).resolve()
    if args.sync:
        subprocess.run(["codegraph", "sync", str(project)], check=True)
    out = Path(args.out) if args.out else project / ".codeflow" / f"codeflow-{dt.datetime.now():%Y%m%d-%H%M%S}.html"
    meta = build(project, out.resolve(), args.include_tests, not args.no_source, args.typescript)
    print(json.dumps({"output": str(out.resolve()), **meta}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
