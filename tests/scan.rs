use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

fn database(
    root: &Path,
    files: &[(&str, &str)],
    symbols: &[(&str, &str, &str, &str, i64, i64)],
) -> Connection {
    std::fs::create_dir(root.join(".codegraph")).unwrap();
    let conn = Connection::open(root.join(".codegraph/codegraph.db")).unwrap();
    conn.execute_batch("CREATE TABLE nodes(id TEXT,kind TEXT,name TEXT,qualified_name TEXT,file_path TEXT,language TEXT,start_line INTEGER,end_line INTEGER,start_column INTEGER,end_column INTEGER,signature TEXT);CREATE TABLE edges(id INTEGER,source TEXT,target TEXT,kind TEXT,line INTEGER,col INTEGER,provenance TEXT);CREATE TABLE unresolved_refs(id INTEGER,from_node_id TEXT,reference_name TEXT,reference_kind TEXT,line INTEGER,col INTEGER);CREATE TABLE project_metadata(key TEXT,value TEXT);CREATE TABLE files(path TEXT,content_hash TEXT);INSERT INTO project_metadata VALUES('indexed_with_version','1.6.0');").unwrap();
    for (path, source) in files {
        std::fs::write(root.join(path), source).unwrap();
    }
    for (id, kind, name, path, line, end) in symbols {
        let lang = if path.ends_with(".py") {
            "python"
        } else if path.ends_with(".rs") {
            "rust"
        } else {
            "tsx"
        };
        conn.execute(
            "INSERT INTO nodes VALUES(?1,?2,?3,?3,?4,?5,?6,?7,0,0,'')",
            params![id, kind, name, path, lang, line, end],
        )
        .unwrap();
    }
    conn
}
fn find<'a>(graph: &'a Value, name: &str) -> &'a Value {
    graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == name)
        .unwrap()
}

#[test]
fn preserves_every_symbol_and_nested_function_without_running_the_source() {
    let tmp = tempfile::tempdir().unwrap();
    let source = "open('EXECUTED', 'w').write('bad')\nclass Service:\n    def run(self):\n        def nested():\n            return 4\n        predicate = lambda x: x > 0\n        return nested()\n";
    let _db = database(
        tmp.path(),
        &[("app.py", source), ("extra.rs", "fn foreign() {}")],
        &[
            ("f", "file", "app.py", "app.py", 1, 7),
            ("s", "class", "Service", "app.py", 2, 7),
            ("r", "method", "run", "app.py", 3, 7),
            ("x", "function", "foreign", "extra.rs", 1, 1),
            ("v", "variable", "not_callable", "extra.rs", 1, 1),
        ],
    );
    let graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    for id in ["f", "s", "r", "x", "v"] {
        assert!(
            graph["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["id"] == id)
        );
    }
    assert_eq!(find(&graph, "nested")["parent"], "r");
    assert_eq!(find(&graph, "predicate")["parent"], "r");
    assert_eq!(find(&graph, "foreign")["flowStatus"], "unsupported");
    assert!(!tmp.path().join("EXECUTED").exists());
    let second = repo2tree::scan::scan(tmp.path(), false).unwrap();
    assert_eq!(
        graph["snapshot"], second["snapshot"],
        "snapshot IDs must be deterministic"
    );
    assert_eq!(graph["stats"]["indexedSymbols"], 5);
}

#[test]
fn python_short_circuit_and_finally_are_structured_in_source_order() {
    let tmp = tempfile::tempdir().unwrap();
    let source = "def work(flag):\n    flag and consume()\n    try:\n        return consume()\n    finally:\n        cleanup()\n";
    let _db = database(
        tmp.path(),
        &[("app.py", source)],
        &[
            ("f", "file", "app.py", "app.py", 1, 6),
            ("w", "function", "work", "app.py", 1, 6),
        ],
    );
    let graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    let flow = graph["flows"]["w"].as_array().unwrap();
    let cond = flow.iter().find(|o| o["kind"] == "if").unwrap();
    assert_eq!(cond["arms"][0]["body"][0]["name"], "consume");
    assert_eq!(cond["arms"][1]["body"], json!([]));
    let tri = flow.iter().find(|o| o["kind"] == "try").unwrap();
    assert_eq!(tri["body"][1]["kind"], "ret");
    assert_eq!(tri["finallyBody"][0]["name"], "cleanup");
}

#[test]
fn ts_callbacks_are_symbols_and_not_implicitly_called_during_render() {
    let tmp = tempfile::tempdir().unwrap();
    let source = "export function Page() {\n const onClick = () => save()\n return <button onClick={onClick}>Save</button>\n}\nfunction save() { return 1 }\n";
    let _db = database(
        tmp.path(),
        &[("Page.tsx", source)],
        &[
            ("f", "file", "Page.tsx", "Page.tsx", 1, 5),
            ("p", "function", "Page", "Page.tsx", 1, 4),
            ("save", "function", "save", "Page.tsx", 5, 5),
        ],
    );
    let graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    assert_eq!(find(&graph, "onClick")["parent"], "p");
    let ops = graph["flows"]["p"].as_array().unwrap();
    let cb = ops.iter().find(|o| o["kind"] == "cb").unwrap();
    assert_eq!(cb["arms"][0]["body"][0]["name"], "onClick");
    assert_eq!(cb["arms"][1]["body"], json!([]));
    assert!(!ops.iter().any(|o| o["name"] == "save"));
}

#[test]
fn missing_index_is_actionable_and_does_not_create_one_implicitly() {
    let tmp = tempfile::tempdir().unwrap();
    let e = repo2tree::scan::scan(tmp.path(), false)
        .unwrap_err()
        .to_string();
    assert!(e.contains("--index"));
    assert!(!tmp.path().join(".codegraph").exists());
}

#[test]
fn javascript_symbols_keep_their_language_for_lsp_selection() {
    let tmp = tempfile::tempdir().unwrap();
    let _db = database(
        tmp.path(),
        &[("app.js", "function main() { return 1; }")],
        &[
            ("f", "file", "app.js", "app.js", 1, 1),
            ("main", "function", "main", "app.js", 1, 1),
        ],
    );
    let graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    assert_eq!(find(&graph, "main")["language"], "javascript");
    assert_eq!(find(&graph, "main")["flowStatus"], "structured");
}

#[cfg(unix)]
#[test]
fn indexed_symlinks_outside_the_project_are_not_read() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    std::fs::write(external.path().join("secret.py"), "SECRET=1").unwrap();
    std::os::unix::fs::symlink(
        external.path().join("secret.py"),
        root.path().join("leak.py"),
    )
    .unwrap();
    let _db = database(
        root.path(),
        &[],
        &[("leak", "file", "leak.py", "leak.py", 1, 1)],
    );
    let graph = repo2tree::scan::scan(root.path(), false).unwrap();
    assert!(graph["sources"]["leak.py"].is_null());
    assert!(
        graph["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["path"] == "leak.py")
    );
}

#[test]
fn stale_index_edges_are_demoted_and_reported() {
    let tmp = tempfile::tempdir().unwrap();
    let db = database(
        tmp.path(),
        &[(
            "app.py",
            "def caller():\n    callee()\ndef callee():\n    return 1\n",
        )],
        &[
            ("file", "file", "app.py", "app.py", 1, 4),
            ("caller", "function", "caller", "app.py", 1, 2),
            ("callee", "function", "callee", "app.py", 3, 4),
        ],
    );
    db.execute("INSERT INTO files VALUES('app.py','old-hash')", [])
        .unwrap();
    db.execute(
        "INSERT INTO edges VALUES(1,'caller','callee','calls',2,4,NULL)",
        [],
    )
    .unwrap();
    let graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    assert_eq!(
        graph["flows"]["caller"][0]["targets"][0]["status"],
        "candidate"
    );
    assert!(
        graph["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["message"].as_str().unwrap_or("").contains("索引过期"))
    );
}

#[test]
fn stdio_lsp_enrichment_resolves_an_alias_by_callsite_and_keeps_snapshot_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let _db = database(
        tmp.path(),
        &[(
            "app.py",
            "def caller():\n    alias()\ndef callee():\n    pass\n",
        )],
        &[
            ("file", "file", "app.py", "app.py", 1, 4),
            ("caller", "function", "caller", "app.py", 1, 2),
            ("callee", "function", "callee", "app.py", 3, 4),
        ],
    );
    let mut graph = repo2tree::scan::scan(tmp.path(), false).unwrap();
    let previous = graph["snapshot"].clone();
    assert_eq!(graph["flows"]["caller"][0]["resolution"], "unresolved");
    let args = vec![format!("{}/tests/fake_lsp.py", env!("CARGO_MANIFEST_DIR"))];
    repo2tree::lsp::enrich(&mut graph, "python3", &args, Some("python")).unwrap();
    assert_eq!(graph["flows"]["caller"][0]["targets"][0]["id"], "callee");
    assert_eq!(graph["flows"]["caller"][0]["targets"][0]["origin"], "lsp");
    assert_eq!(graph["stats"]["lspEdges"], 1);
    assert_ne!(graph["snapshot"], previous);
}

#[test]
fn resolves_large_call_graph_without_scanning_every_symbol_for_every_edge() {
    // CodeGraph may emit edges without locations. They must not match every
    // call whose optional siteLine is also absent (the real large-project hang).
    let nodes: Vec<_> = (0..1500).map(|i| json!({"id":format!("n{i}"),"kind":"function","name":format!("f{i}"),"path":"app.py"})).collect();
    let edges: Vec<_> = (1..1000).map(|i| json!({"source":"n0","target":format!("n{i}"),"kind":"calls","line":null,"origin":"codegraph"})).collect();
    let calls: Vec<_> = (1..120)
        .map(
            |i| json!({"kind":"call","name":format!("f{i}"),"line":i,"siteLine":null,"targets":[]}),
        )
        .collect();
    let mut graph = json!({"nodes":nodes,"edges":edges,"routes":[],"flows":{"n0":calls}});
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        repo2tree::scan::resolve_flows(&mut graph);
        let _ = sender.send(graph);
    });
    let graph = receiver
        .recv_timeout(std::time::Duration::from_secs(3))
        .expect("call resolution stalled on a graph with unlocated edges");
    assert_eq!(graph["flows"]["n0"][0]["targets"][0]["id"], "n1");
    assert_eq!(
        graph["flows"]["n0"][0]["resolution"], "candidate",
        "an edge without a call location cannot prove this call target"
    );
}
