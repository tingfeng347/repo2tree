use crate::scan_job::{ScanControl, run_command};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub fn inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let p = root.join(relative).canonicalize().ok()?;
    p.starts_with(root).then_some(p)
}

fn adapter(program: &str, script: &str, payload: &Value, control: &ScanControl) -> Result<Value> {
    let mut command = Command::new(program);
    if program == "node" {
        command.args(["--input-type=module", "-e", script]);
    } else {
        command.args(["-c", script]);
    }
    let output = run_command(
        &mut command,
        serde_json::to_vec(payload)?,
        control,
        Duration::from_secs(120),
    )
    .with_context(|| format!("{program} 解析未完成"))?;
    if !output.status.success() {
        bail!(
            "{}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(1600)
                .collect::<String>()
        );
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn typescript(root: &Path) -> Option<PathBuf> {
    let mut paths = vec![
        PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        root.to_path_buf(),
    ];
    paths.extend(root.ancestors().map(Path::to_path_buf));
    for sub in ["web", "frontend", "client", "apps/web"] {
        paths.push(root.join(sub));
    }
    if let Ok(p) = std::env::var("REPO2TREE_TYPESCRIPT") {
        if Path::new(&p).is_file() {
            return Some(p.into());
        }
    }
    paths
        .into_iter()
        .map(|p| p.join("node_modules/typescript/lib/typescript.js"))
        .find(|p| p.is_file())
}

pub fn is_function(n: &Value) -> bool {
    matches!(
        n["kind"].as_str().unwrap_or(""),
        "function" | "method" | "constructor" | "lambda" | "closure"
    )
}

pub fn scan(project: &Path, index: bool) -> Result<Value> {
    scan_with_control(project, index, &ScanControl::default())
}

pub fn scan_with_control(project: &Path, index: bool, control: &ScanControl) -> Result<Value> {
    control.stage("检查项目目录", 0, 0)?;
    let root = project
        .canonicalize()
        .with_context(|| format!("目录不存在：{}", project.display()))?;
    if !root.is_dir() {
        bail!("项目路径必须是目录");
    }
    let db = root.join(".codegraph/codegraph.db");
    if index {
        let action = if db.exists() { "sync" } else { "init" };
        let mut cmd = Command::new("codegraph");
        cmd.arg(action).arg(&root);
        if action == "init" {
            cmd.arg("--yes");
        }
        control.stage("建立／同步 CodeGraph 索引", 0, 0)?;
        let output = run_command(&mut cmd, vec![], control, Duration::from_secs(600))
            .context("无法启动 codegraph；请安装 CodeGraph CLI")?;
        if !output.status.success() {
            bail!(
                "CodeGraph {action} 失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    if !db.is_file() {
        bail!(
            "未找到 {}。勾选“建立/同步索引”，或运行 repo2tree scan --project <目录> --index。",
            db.display()
        );
    }
    control.stage("读取 CodeGraph 符号与调用关系", 0, 0)?;
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("BEGIN DEFERRED TRANSACTION")?;
    let mut nodes: Vec<Value> = conn.prepare("SELECT id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,signature FROM nodes ORDER BY file_path,start_line,start_column,id")?
        .query_map([], |r| Ok(json!({
            "id": r.get::<_, String>(0)?, "kind": r.get::<_, String>(1)?, "name": r.get::<_, String>(2)?,
            "qualifiedName": r.get::<_, String>(3)?, "path": r.get::<_, String>(4)?, "language": r.get::<_, String>(5)?,
            "line": r.get::<_, i64>(6)?, "endLine": r.get::<_, i64>(7)?, "column": r.get::<_, i64>(8)?,
            "endColumn": r.get::<_, i64>(9)?, "signature": r.get::<_, Option<String>>(10)?.unwrap_or_default(),
            "origin": "codegraph"
        })))?.collect::<rusqlite::Result<_>>()?;
    let mut edges: Vec<Value> = conn.prepare("SELECT id,source,target,kind,line,col,provenance FROM edges ORDER BY id")?
        .query_map([], |r| Ok(json!({"id": format!("cg:{}", r.get::<_, i64>(0)?), "source":r.get::<_,String>(1)?, "target":r.get::<_,String>(2)?, "kind":r.get::<_,String>(3)?, "line":r.get::<_,Option<i64>>(4)?, "column":r.get::<_,Option<i64>>(5)?, "origin":"codegraph", "detail":r.get::<_,Option<String>>(6)?, "status":"indexed"})))?.collect::<rusqlite::Result<_>>()?;
    let unresolved: Vec<Value> = conn.prepare("SELECT from_node_id,reference_name,reference_kind,line,col FROM unresolved_refs ORDER BY id")?
        .query_map([], |r| Ok(json!({"source":r.get::<_,String>(0)?, "name":r.get::<_,String>(1)?, "kind":r.get::<_,String>(2)?, "line":r.get::<_,i64>(3)?, "column":r.get::<_,i64>(4)?})))?.collect::<rusqlite::Result<_>>()?;
    let version: String = conn
        .query_row(
            "SELECT value FROM project_metadata WHERE key='indexed_with_version'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "unknown".into());
    let hashes: HashMap<String, String> = conn
        .prepare("SELECT path,content_hash FROM files")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    conn.execute_batch("COMMIT")?;
    let indexed_count = nodes.len();
    let mut sources = json!({});
    let mut diagnostics: Vec<Value> = vec![];
    let paths: HashSet<String> = nodes
        .iter()
        .filter_map(|n| n["path"].as_str().map(str::to_owned))
        .collect();
    let mut stale = HashSet::new();
    let path_count = paths.len();
    for (i, rel) in paths.into_iter().enumerate() {
        control.stage("读取源码", i + 1, path_count)?;
        if let Some(p) = inside(&root, &rel) {
            match std::fs::read_to_string(p) {
                Ok(text) => {
                    let actual = format!("{:x}", Sha256::digest(text.as_bytes()));
                    if hashes.get(&rel).is_some_and(|h| h != &actual) {
                        stale.insert(rel.clone());
                        diagnostics.push(json!({"path":rel,"message":"源码已变化，CodeGraph 索引过期；相关索引调用边降级为候选。请勾选同步索引后重新扫描。"}));
                    }
                    sources[&rel] = json!(text);
                }
                Err(e) => {
                    diagnostics.push(json!({"path":rel,"message":format!("源码无法读取：{e}")}))
                }
            }
        } else {
            diagnostics.push(
                json!({"path":rel,"message":"文件已删除或位于项目目录之外，保留符号但不读取源码"}),
            );
        }
    }
    let stale_ids: HashSet<_> = nodes
        .iter()
        .filter(|n| n["path"].as_str().is_some_and(|p| stale.contains(p)))
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    for e in &mut edges {
        if e["source"]
            .as_str()
            .is_some_and(|id| stale_ids.contains(id))
            || e["target"]
                .as_str()
                .is_some_and(|id| stale_ids.contains(id))
        {
            e["status"] = json!("candidate");
            e["detail"] = json!("stale-index");
        }
    }
    let mut raw_flows = json!({});
    let mut routes = vec![];
    let payload =
        json!({"project":root, "nodes":nodes, "sources": sources, "typescript":typescript(&root)});
    let mut node_positions: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| Some((n["id"].as_str()?.to_owned(), i)))
        .collect();
    for (program, script) in [
        ("python3", include_str!("../adapters/python_flow.py")),
        ("node", include_str!("../adapters/ts_flow.mjs")),
    ] {
        control.stage(
            if program == "python3" {
                "解析 Python 控制流"
            } else {
                "解析 JavaScript／TypeScript 控制流"
            },
            0,
            0,
        )?;
        match adapter(program, script, &payload, control) {
            Ok(data) => {
                if let Some(additions) = data["nodes"].as_array() {
                    for node in additions {
                        if let Some(position) = node["id"]
                            .as_str()
                            .and_then(|id| node_positions.get(id))
                            .copied()
                        {
                            let existing = &mut nodes[position];
                            for (k, v) in node.as_object().context("adapter node must be object")? {
                                existing[k] = v.clone();
                            }
                        } else {
                            if let Some(id) = node["id"].as_str() {
                                node_positions.insert(id.to_owned(), nodes.len());
                            }
                            nodes.push(node.clone());
                        }
                    }
                }
                if let Some(flows) = data["flows"].as_object() {
                    for (id, flow) in flows {
                        raw_flows[id] = flow.clone();
                    }
                }
                if let Some(rs) = data["routes"].as_array() {
                    routes.extend(rs.clone());
                }
                if let Some(ds) = data["diagnostics"].as_array() {
                    diagnostics.extend(ds.clone());
                }
            }
            Err(e) => diagnostics.push(json!({"adapter":program,"message":e.to_string()})),
        }
    }
    control.stage("整理模块、类与函数层级", 0, 0)?;
    // Preserve every CodeGraph symbol, including unsupported kinds and orphans.
    let mut parents: HashMap<String, String> = edges
        .iter()
        .filter(|e| e["kind"] == "contains")
        .filter_map(|e| Some((e["target"].as_str()?.into(), e["source"].as_str()?.into())))
        .collect();
    let files: HashMap<String, String> = nodes
        .iter()
        .filter(|n| n["kind"] == "file")
        .filter_map(|n| Some((n["path"].as_str()?.into(), n["id"].as_str()?.into())))
        .collect();
    let root_id = "repo2tree:root";
    let mut dirs: HashMap<String, String> = HashMap::from([(String::new(), root_id.into())]);
    for node in &mut nodes {
        let id = node["id"].as_str().unwrap().to_owned();
        if let Some(p) = node["parent"].as_str() {
            parents.insert(id.clone(), p.into());
        }
        if node["kind"] == "file" {
            let rel = node["path"].as_str().unwrap_or("");
            let parent = Path::new(rel).parent().unwrap_or_else(|| Path::new(""));
            for ancestor in parent.ancestors() {
                let path = ancestor.to_string_lossy().into_owned();
                dirs.entry(path.clone())
                    .or_insert_with(|| format!("dir:{path}"));
            }
            node["parent"] = json!(
                dirs.get(&parent.to_string_lossy().into_owned())
                    .unwrap_or(&root_id.into())
            );
        } else {
            node["parent"] = json!(
                parents
                    .get(&id)
                    .or_else(|| node["path"].as_str().and_then(|p| files.get(p)))
                    .cloned()
                    .unwrap_or_else(|| root_id.into())
            );
        }
        node["flowStatus"] = json!(if raw_flows.get(&id).is_some() {
            "structured"
        } else if is_function(node) {
            "unsupported"
        } else {
            "container"
        });
    }
    let name = root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    for (path, id) in &dirs {
        let parent = if path.is_empty() {
            Value::Null
        } else {
            json!(
                dirs.get(
                    &Path::new(path)
                        .parent()
                        .unwrap_or_else(|| Path::new(""))
                        .to_string_lossy()
                        .into_owned()
                )
                .unwrap_or(&root_id.into())
            )
        };
        nodes.push(json!({"id":id,"kind":if path.is_empty(){"project"}else{"directory"},"name":if path.is_empty(){name.clone()}else{Path::new(path).file_name().unwrap_or_default().to_string_lossy().into_owned()},"path":path,"parent":parent,"origin":"hierarchy","flowStatus":"container"}));
    }
    // Repair broken containment and cycles without dropping entities.
    let ids: HashSet<String> = nodes
        .iter()
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    let pm: HashMap<String, String> = nodes
        .iter()
        .filter_map(|n| Some((n["id"].as_str()?.into(), n["parent"].as_str()?.into())))
        .collect();
    for n in &mut nodes {
        let id = n["id"].as_str().unwrap();
        let mut at = id;
        let mut seen = HashSet::new();
        let mut broken = false;
        while let Some(p) = pm.get(at) {
            if !seen.insert(at) || !ids.contains(p) {
                broken = true;
                break;
            }
            at = p;
        }
        if broken {
            diagnostics.push(json!({"symbol":id,"message":"原索引归属缺失或成环，已挂至项目根"}));
            n["parent"] = json!(root_id);
        }
    }
    nodes.sort_by_key(|n| n["id"].as_str().unwrap_or("").to_owned());
    diagnostics.sort_by_key(Value::to_string);
    let mut graph = json!({"schemaVersion":1,"root":root_id,"project":{"name":name,"path":root,"codegraphVersion":version},"nodes":nodes,"edges":edges,"unresolvedReferences":unresolved,"sources":sources,"routes":routes,"flows":{},"diagnostics":diagnostics});
    let mut counter = 0;
    if let Some(flows) = raw_flows.as_object() {
        for (id, ops) in flows {
            graph["flows"][id] = normalize(ops, id, &mut counter);
        }
    }
    resolve_flows_controlled(&mut graph, control)?;
    control.stage("生成项目快照", 0, 0)?;
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&graph)?);
    graph["snapshot"] =
        json!({"id": format!("{:x}",hasher.finalize()),"kind":"static","inputsEvaluated":false});
    graph["stats"] = json!({"indexedSymbols":indexed_count,"symbols":graph["nodes"].as_array().unwrap().len(),"functions":graph["nodes"].as_array().unwrap().iter().filter(|n|is_function(n)).count(),"structuredFunctions":graph["nodes"].as_array().unwrap().iter().filter(|n|is_function(n)&&n["flowStatus"]=="structured").count(),"files":graph["sources"].as_object().unwrap().len(),"edges":graph["edges"].as_array().unwrap().len(),"unresolvedReferences":graph["unresolvedReferences"].as_array().unwrap().len()});
    Ok(graph)
}

fn normalize(ops: &Value, owner: &str, counter: &mut usize) -> Value {
    json!(ops.as_array().unwrap_or(&vec![]).iter().map(|raw| {
        *counter+=1;
        let mut op=json!({"id":format!("{owner}:{}:{}:{}",raw["l"],raw["col"].as_u64().unwrap_or(0),*counter),"kind":raw["t"],"line":raw["l"],"column":raw["col"].as_u64().unwrap_or(0),"siteLine":raw["sl"],"siteColumn":raw["sc"],"text":raw["x"].as_str().unwrap_or(""),"name":raw["n"],"http":raw["http"],"targets":[]});
        for (a,b) in [("b","body"),("el","elseBody"),("f","finallyBody"),("pre","conditionBody"),("increment","incrementBody")] { if raw.get(a).is_some(){op[b]=normalize(&raw[a],owner,counter);} }
        for key in ["whileLoop","minIterations","reason"] { if raw.get(key).is_some(){op[key]=raw[key].clone();} }
        for (a,b) in [("arms","arms"),("h","handlers")] { if let Some(arms)=raw[a].as_array(){op[b]=json!(arms.iter().map(|arm|json!({"label":arm["c"],"line":arm["l"],"body":normalize(&arm["b"],owner,counter)})).collect::<Vec<_>>());} }
        if let Some(target) = raw["target"].as_str() { op["targets"]=json!([{"id":target,"origin":"ast","status":"indexed"}]); }
        op
    }).collect::<Vec<_>>())
}

pub fn resolve_flows(graph: &mut Value) {
    // Used by optional LSP enrichment after the initial scan.
    resolve_flows_controlled(graph, &ScanControl::default()).expect("uncancelled resolution");
}

fn resolve_flows_controlled(graph: &mut Value, control: &ScanControl) -> Result<()> {
    let nodes = graph["nodes"].as_array().unwrap().clone();
    let edges = graph["edges"].as_array().unwrap().clone();
    let routes = graph["routes"].as_array().unwrap().clone();
    let lookup = CallIndex::new(&nodes, &edges);
    let mut flows = graph["flows"].take();
    let total = flows.as_object().unwrap().len();
    for (i, (owner, ops)) in flows.as_object_mut().unwrap().iter_mut().enumerate() {
        control.stage("解析函数调用关系", i + 1, total)?;
        resolve_ops(ops, owner, &lookup, &routes, control)?;
    }
    graph["flows"] = flows;
    // Route entries remain explicit; every function is additionally searchable as an entry.
    let mut entries:Vec<Value>=routes.iter().map(|r|json!({"id":r["node"],"kind":"api","label":format!("{} {}",r["method"].as_str().unwrap_or("GET"),r["path"].as_str().unwrap_or("/"))})).collect();
    for n in nodes.iter().filter(|n| is_function(n)) {
        entries.push(json!({"id":n["id"],"kind":if n["path"].as_str().unwrap_or("").ends_with(".tsx")&&n["name"].as_str().unwrap_or("").starts_with(char::is_uppercase){"frontend"}else{"function"},"label":n["qualifiedName"].as_str().or(n["name"].as_str()).unwrap_or("")}));
    }
    graph["entries"] = json!(entries);
    Ok(())
}

// Build once per snapshot. Missing locations are not call sites: matching two
// JSON nulls here previously caused a symbols × edges × calls traversal.
struct CallIndex<'a> {
    nodes: HashMap<&'a str, &'a Value>,
    names: HashMap<&'a str, Vec<&'a Value>>,
    sites: HashMap<(&'a str, u64, &'a str), Vec<&'a Value>>,
    lsp_sites: HashMap<(&'a str, u64), Vec<&'a Value>>,
}

impl<'a> CallIndex<'a> {
    fn new(nodes: &'a [Value], edges: &'a [Value]) -> Self {
        let mut lookup = Self {
            nodes: HashMap::new(),
            names: HashMap::new(),
            sites: HashMap::new(),
            lsp_sites: HashMap::new(),
        };
        for node in nodes {
            if let Some(id) = node["id"].as_str() {
                lookup.nodes.insert(id, node);
            }
            if is_function(node) {
                if let Some(name) = node["name"].as_str() {
                    lookup.names.entry(name).or_default().push(node);
                }
            }
        }
        for edge in edges {
            if matches!(edge["kind"].as_str(), Some("calls" | "instantiates")) {
                if let (Some(owner), Some(line)) = (edge["source"].as_str(), edge["line"].as_u64())
                {
                    if let Some(target) =
                        edge["target"].as_str().and_then(|id| lookup.nodes.get(id))
                    {
                        if edge["origin"] == "lsp" {
                            lookup
                                .lsp_sites
                                .entry((owner, line))
                                .or_default()
                                .push(edge);
                        } else if let Some(name) = target["name"].as_str() {
                            lookup
                                .sites
                                .entry((owner, line, name))
                                .or_default()
                                .push(edge);
                        }
                    }
                }
            }
        }
        lookup
    }
}

fn resolve_ops(
    ops: &mut Value,
    owner: &str,
    lookup: &CallIndex<'_>,
    routes: &[Value],
    control: &ScanControl,
) -> Result<()> {
    let caller = lookup.nodes.get(owner);
    for op in ops.as_array_mut().unwrap() {
        control.check()?;
        if op["kind"] == "call" && op["targets"].as_array().is_none_or(|a| a.is_empty()) {
            let name = op["name"].as_str().unwrap_or("");
            let tail = name.rsplit('.').next().unwrap_or(name);
            let mut targets = vec![];
            let mut lines = vec![];
            for key in ["line", "siteLine"] {
                if let Some(line) = op[key].as_u64() {
                    if !lines.contains(&line) {
                        lines.push(line);
                    }
                }
            }
            for line in lines {
                // Bundled/minified files may put thousands of calls on one line.
                // Index the callee name too, while LSP aliases keep position-based matching.
                let named = lookup.sites.get(&(owner, line, tail)).into_iter().flatten();
                let semantic = lookup.lsp_sites.get(&(owner, line)).into_iter().flatten();
                for e in named.chain(semantic) {
                    if e["origin"] == "lsp"
                        && !(e["column"].is_number()
                            && (e["column"] == op["column"] || e["column"] == op["siteColumn"]))
                    {
                        continue;
                    }
                    if e["target"]
                        .as_str()
                        .and_then(|id| lookup.nodes.get(id))
                        .is_some_and(|n| n["name"] == tail || e["origin"] == "lsp")
                    {
                        targets.push(json!({"id":e["target"],"origin":e["origin"],"status":e["status"].as_str().unwrap_or("indexed")}));
                    }
                }
            }
            if targets.is_empty() && !tail.is_empty() {
                if let Some(candidates) = lookup.names.get(tail) {
                    let local: Vec<_> = candidates
                        .iter()
                        .copied()
                        .filter(|n| caller.is_some_and(|c| n["path"] == c["path"]))
                        .collect();
                    for n in if local.is_empty() {
                        candidates.as_slice()
                    } else {
                        local.as_slice()
                    } {
                        targets.push(
                            json!({"id":n["id"],"origin":"name-candidate","status":"candidate"}),
                        );
                    }
                }
            }
            if let (Some(url), Some(method)) = (op["http"]["p"].as_str(), op["http"]["m"].as_str())
            {
                let candidates: Vec<_> = routes
                    .iter()
                    .filter(|r| {
                        r["method"] == method && route_match(url, r["path"].as_str().unwrap_or(""))
                    })
                    .collect();
                if !candidates.is_empty() {
                    targets=candidates.iter().map(|r|json!({"id":r["node"],"origin":"http-route-match","status":"candidate"})).collect();
                    op["kind"] = json!("http");
                }
            }
            targets.sort_by_key(|t| t["id"].as_str().unwrap_or("").to_owned());
            targets.dedup_by(|a, b| a["id"] == b["id"]);
            op["resolution"] = json!(if targets.is_empty() {
                "unresolved"
            } else if targets.len() > 1 || targets.iter().any(|t| t["status"] == "candidate") {
                "candidate"
            } else {
                "indexed"
            });
            op["targets"] = json!(targets);
        }
        for key in [
            "body",
            "elseBody",
            "finallyBody",
            "conditionBody",
            "incrementBody",
        ] {
            if op[key].is_array() {
                resolve_ops(&mut op[key], owner, lookup, routes, control)?;
            }
        }
        for key in ["arms", "handlers"] {
            if let Some(arms) = op[key].as_array_mut() {
                for arm in arms {
                    resolve_ops(&mut arm["body"], owner, lookup, routes, control)?;
                }
            }
        }
    }
    Ok(())
}

fn route_match(url: &str, route: &str) -> bool {
    // A full URL must retain its host as an unresolved boundary; never join by path alone.
    if !url.starts_with('/') || url.starts_with("//") {
        return false;
    }
    let a: Vec<_> = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_matches('/')
        .split('/')
        .collect();
    let b: Vec<_> = route.trim_matches('/').split('/').collect();
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| *x == y || x.starts_with('{') || y.starts_with('{') || y.starts_with(':'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_do_not_merge_hosts_or_methods() {
        assert!(route_match("/api/items/{*}", "/api/items/{id}"));
        assert!(!route_match(
            "https://elsewhere.test/api/items/a",
            "/api/items/{id}"
        ));
        assert!(!route_match("/api/items/a/x", "/api/items/{id}"));
    }
    #[test]
    fn same_line_calls_are_not_reassigned_by_order() {
        let mut g = json!({"nodes":[{"id":"f","path":"x.py","kind":"function"},{"id":"a","name":"a","kind":"function"},{"id":"b","name":"b","kind":"function"}],"edges":[{"source":"f","target":"b","kind":"calls","line":2,"origin":"codegraph"}],"routes":[],"flows":{"f":[{"kind":"call","name":"a","line":2,"targets":[]}]}});
        resolve_flows(&mut g);
        assert_eq!(g["flows"]["f"][0]["targets"][0]["id"], "a");
        assert_eq!(g["flows"]["f"][0]["resolution"], "candidate");
    }
    #[test]
    fn lsp_calls_on_the_same_line_must_match_the_callee_position() {
        let mut g = json!({"nodes":[{"id":"f","path":"x.py","kind":"function"},{"id":"a","name":"a","kind":"function"},{"id":"b","name":"b","kind":"function"}],"edges":[{"source":"f","target":"b","kind":"calls","line":2,"column":5,"origin":"lsp"}],"routes":[],"flows":{"f":[{"kind":"call","name":"a","line":2,"column":0,"targets":[]},{"kind":"call","name":"alias","line":2,"column":5,"targets":[]}]}});
        resolve_flows(&mut g);
        assert_eq!(g["flows"]["f"][0]["targets"][0]["id"], "a");
        assert_eq!(g["flows"]["f"][0]["resolution"], "candidate");
        assert_eq!(g["flows"]["f"][1]["targets"][0]["id"], "b");
    }
}
