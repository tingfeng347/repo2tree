"""Scan lifecycle regression: real HTTP, parser process, cancellation and retry.

Run: python3 tests/scan_http.py [path/to/repo2tree]
Only the Python parser is held to simulate a slow project; no source is executed.
"""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = str(Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/repo2tree").resolve())
with tempfile.TemporaryDirectory(prefix="repo2tree-http-") as folder:
    root = Path(folder)
    project = root / "fixture"
    (project / ".codegraph").mkdir(parents=True)
    (project / "app.py").write_text("def hello():\n    return 1\n")
    db = sqlite3.connect(project / ".codegraph/codegraph.db")
    db.executescript("""
CREATE TABLE nodes(id TEXT,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER,signature TEXT);
CREATE TABLE edges(id INTEGER,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,provenance TEXT);
CREATE TABLE unresolved_refs(id INTEGER,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,line INTEGER,col INTEGER);
CREATE TABLE project_metadata(key TEXT,value TEXT);
CREATE TABLE files(path TEXT,content_hash TEXT);
INSERT INTO nodes VALUES('file','file','app.py','app.py','app.py','python',1,2,0,0,'');
INSERT INTO nodes VALUES('hello','function','hello','hello','app.py','python',1,2,0,0,'');
""")
    db.commit()
    db.close()
    tools = root / "tools"
    tools.mkdir()
    parser = tools / "python3"
    parser.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(30)\n")
    parser.chmod(0o755)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    base = f"http://127.0.0.1:{port}"

    def request(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=8) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def wait_for(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                value = predicate()
                if value:
                    return value
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.025)
        raise AssertionError("scan state failed to advance within five seconds")

    env = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"]}
    with open(root / "server.log", "w") as log:
        server = subprocess.Popen([binary, "serve", "--port", str(port)], env=env, stdout=log, stderr=log)
        try:
            wait_for(lambda: request("/api/project")[0] == 200)
            original = request("/api/project")[1]["snapshot"]["id"]
            with concurrent.futures.ThreadPoolExecutor() as pool:
                scan = pool.submit(request, "/api/scan", {"path": str(project)})
                wait_for(lambda: request("/api/scan/status")[1].get("stage") == "解析 Python 控制流")
                assert request("/api/scan", {"path": str(project)})[0] == 409
                assert request("/api/demo", {})[0] == 409
                started = time.monotonic()
                assert request("/api/scan/cancel", {})[0] == 200
                status, body = scan.result(timeout=3)
                assert status == 400 and "取消" in body["error"], body
                assert time.monotonic() - started < 3
            assert request("/api/project")[1]["snapshot"]["id"] == original
            assert request("/api/scan/status")[1]["running"] is False

            # A disconnected caller cannot release the scan guard while its work runs.
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            connection.request("POST", "/api/scan", json.dumps({"path": str(project)}), {"Content-Type": "application/json"})
            wait_for(lambda: request("/api/scan/status")[1].get("running"))
            connection.close()
            assert request("/api/scan", {"path": str(project)})[0] == 409
            request("/api/scan/cancel", {})
            wait_for(lambda: not request("/api/scan/status")[1].get("running"))

            parser.write_text(f"#!{sys.executable}\nimport os,sys\nos.execv({sys.executable!r}, [{sys.executable!r}] + sys.argv[1:])\n")
            status, graph = request("/api/scan", {"path": str(project)})
            assert status == 200, graph
            assert graph["project"]["name"] == "fixture"
            assert graph["stats"]["structuredFunctions"] == 1
            assert request("/api/scan/status")[1]["error"] is None
            assert request("/api/scan", {"path": str(root / "missing")})[0] == 400
            assert request("/api/project")[1]["snapshot"]["id"] == graph["snapshot"]["id"]
            print("PASS: progress, cancellation, exclusive scans, disconnect, retry, error preservation")
        finally:
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
