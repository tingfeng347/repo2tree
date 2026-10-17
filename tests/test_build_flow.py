"""End-to-end test: index the fixture with codegraph, build the HTML, inspect embedded data."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "build_flow.py"
# TS extraction needs the typescript package; point CODEFLOW_TS at a typescript.js to exercise it
TS = os.environ.get("CODEFLOW_TS")


def load_data(html: str) -> dict:
    start = html.index("window.__CODEFLOW__ = ") + len("window.__CODEFLOW__ = ")
    end = html.index(";</script>", start)
    return json.loads(html[start:end].replace("<\\/", "</"))


@unittest.skipUnless(shutil.which("codegraph"), "codegraph CLI not installed")
class BuildFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="codeflow-test-"))
        proj = cls.tmp / "proj"
        shutil.copytree(HERE / "fixture", proj)
        subprocess.run(["codegraph", "init", str(proj)], check=True, capture_output=True, timeout=300)
        out = cls.tmp / "out.html"
        cmd = [sys.executable, str(SCRIPT), "--project", str(proj), "--out", str(out)]
        if TS:
            cmd += ["--typescript", TS]
        proc = subprocess.run(cmd,
                              check=True, capture_output=True, text=True, timeout=300)
        cls.meta = json.loads(proc.stdout)
        cls.html = out.read_text(encoding="utf-8")
        cls.data = load_data(cls.html)
        cls.by_name = {}
        for i, n in enumerate(cls.data["nodes"]):
            cls.by_name.setdefault(n["n"], i)

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["codegraph", "daemon", "stop"], capture_output=True)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def node(self, name):
        return self.data["nodes"][self.by_name[name]]

    def test_routes_include_router_prefixes(self):
        labels = {e["label"] for e in self.data["entries"] if e["g"] == "http"}
        self.assertIn("GET /api/items/{key}", labels)
        self.assertIn("POST /api/items/{key}", labels)

    def test_hierarchy_reaches_methods_through_class(self):
        get = self.node("get")
        parent = self.data["nodes"][get["p"]]
        self.assertEqual((get["k"], parent["k"], parent["n"]), ("method", "class", "Store"))

    def test_python_try_branch_and_resolved_call(self):
        flow = self.node("read_item")["flow"]
        tri = next(it for it in flow if it["t"] == "try")
        self.assertEqual(tri["h"][0]["c"], "except KeyError")
        call = next(it for it in tri["b"] if it["t"] == "call")
        self.assertEqual(self.data["nodes"][call["to"][0]]["n"], "get")
        self.assertEqual(tri["h"][0]["b"][-1]["t"], "raise")

    def test_python_if_has_implicit_else_and_loop(self):
        get_flow = self.node("get")["flow"]
        branch = next(it for it in get_flow if it["t"] == "if")
        self.assertEqual([a.get("imp", 0) for a in branch["arms"]], [0, 1])
        put_flow = self.node("put")["flow"]
        loop = next(it for it in put_flow if it["t"] == "loop")
        self.assertTrue(any(it.get("to") for it in loop["b"]))

    @unittest.skipUnless(TS, "set CODEFLOW_TS=<path to typescript.js>")
    def test_frontend_fetch_links_to_backend_handler(self):
        flow = self.node("loadItem")["flow"]
        http = next(it for it in flow if it["t"] == "http")
        self.assertEqual(self.data["nodes"][http["to"][0]]["n"], "read_item")
        save = next(it for it in self.node("saveItem")["flow"] if it["t"] == "http")
        self.assertEqual(self.data["nodes"][save["to"][0]]["n"], "write_item")

    @unittest.skipUnless(TS, "set CODEFLOW_TS=<path to typescript.js>")
    def test_ts_conditional_and_callbacks(self):
        flow = self.node("Panel")["flow"]
        cond = next(it for it in flow if it["t"] == "if")
        cb = next(it for it in cond["arms"][0]["b"] if it["t"] == "cb")
        self.assertEqual(cb["d"], 0)  # map callback runs eagerly

    def test_ts_without_compiler_degrades_with_warning(self):
        if TS:
            self.skipTest("typescript provided")
        self.assertTrue(any("typescript" in w for w in self.meta["warnings"]))
        self.assertIn("flow", self.node("loadItem"))

    def test_viewer_assembled(self):
        self.assertNotIn("/*__CODEFLOW_JS__*/", self.html)
        self.assertNotIn("/*__CODEFLOW_CSS__*/", self.html)
        self.assertIn("app.py", " ".join(self.data["src"]))


if __name__ == "__main__":
    unittest.main()
