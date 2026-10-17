//! Optional stdio LSP enrichment. A language server is an executable, never a shell command.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

struct Client {
    child: Child,
    input: ChildStdin,
    messages: Receiver<Value>,
    next: u64,
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Client {
    fn start(command: &str, args: &[String]) -> Result<Self> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("启动 LSP 失败")?;
        let input = child.stdin.take().context("LSP stdin")?;
        let output = child.stdout.take().context("LSP stdout")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut length = 0;
                let mut header = String::new();
                loop {
                    header.clear();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        return;
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some((k, v)) = header.split_once(':') {
                        if k.eq_ignore_ascii_case("Content-Length") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
                if length == 0 || length > 16 * 1024 * 1024 {
                    return;
                }
                let mut body = vec![0; length];
                if reader.read_exact(&mut body).is_err() {
                    return;
                }
                if let Ok(v) = serde_json::from_slice(&body) {
                    if tx.send(v).is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            messages: rx,
            next: 0,
        })
    }
    fn send(&mut self, v: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&v)?;
        write!(self.input, "Content-Length: {}\r\n\r\n", bytes.len())?;
        self.input.write_all(&bytes)?;
        self.input.flush()?;
        Ok(())
    }
    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"jsonrpc":"2.0","method":method,"params":params}))
    }
    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = until.saturating_duration_since(Instant::now());
            let v = self
                .messages
                .recv_timeout(remaining)
                .context("LSP 请求超时或服务已退出")?;
            if v["id"] == id && v.get("method").is_none() {
                if !v["error"].is_null() {
                    bail!("LSP {method}: {}", v["error"]);
                }
                return Ok(v["result"].clone());
            }
            if v.get("id").is_some() && v.get("method").is_some() {
                let result = if v["method"] == "workspace/configuration" {
                    json!(
                        v["params"]["items"]
                            .as_array()
                            .unwrap_or(&vec![])
                            .iter()
                            .map(|_| Value::Null)
                            .collect::<Vec<_>>()
                    )
                } else {
                    Value::Null
                };
                self.send(json!({"jsonrpc":"2.0","id":v["id"],"result":result}))?;
            }
        }
    }
}

fn uri(path: &str) -> String {
    let mut out = "file://".to_owned();
    for b in path.as_bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(b) {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn enrich(
    graph: &mut Value,
    command: &str,
    args: &[String],
    language: Option<&str>,
) -> Result<()> {
    let mut client = Client::start(command, args)?;
    let root = graph["project"]["path"]
        .as_str()
        .context("project path")?
        .to_owned();
    let root_uri = uri(&root);
    let initialized=client.request("initialize",json!({"processId":std::process::id(),"rootUri":root_uri,"capabilities":{"textDocument":{"callHierarchy":{"dynamicRegistration":false}}},"workspaceFolders":[{"uri":root_uri,"name":graph["project"]["name"]}]}))?;
    client.notify("initialized", json!({}))?;
    if initialized["capabilities"]["callHierarchyProvider"].is_null()
        || initialized["capabilities"]["callHierarchyProvider"] == false
    {
        bail!("该 LSP 未声明 callHierarchyProvider；保留 CodeGraph/AST 结果");
    }
    let nodes = graph["nodes"].as_array().unwrap().clone();
    let mut opened = std::collections::HashSet::new();
    let mut count = 0;
    for node in nodes
        .iter()
        .filter(|n| crate::scan::is_function(n) && language.is_none_or(|l| n["language"] == l))
    {
        let Some(path) = node["path"].as_str() else {
            continue;
        };
        let Some(source) = graph["sources"][path].as_str() else {
            continue;
        };
        let doc_uri = uri(&format!("{root}/{path}"));
        if opened.insert(path.to_owned()) {
            let lang = match node["language"].as_str().unwrap_or("") {
                "tsx" => "typescriptreact",
                "jsx" => "javascriptreact",
                l => l,
            };
            client.notify(
                "textDocument/didOpen",
                json!({"textDocument":{"uri":doc_uri,"languageId":lang,"version":1,"text":source}}),
            )?;
        }
        let line = node["line"].as_u64().unwrap_or(1).saturating_sub(1);
        let name = node["name"].as_str().unwrap_or("");
        let column = source
            .lines()
            .nth(line as usize)
            .and_then(|s| s.find(name))
            .map(|c| {
                source.lines().nth(line as usize).unwrap()[..c]
                    .encode_utf16()
                    .count() as u64
            })
            .unwrap_or_else(|| node["column"].as_u64().unwrap_or(0));
        let result = (|| -> Result<()> {
            let items = client.request(
                "textDocument/prepareCallHierarchy",
                json!({"textDocument":{"uri":doc_uri},"position":{"line":line,"character":column}}),
            )?;
            for item in items.as_array().unwrap_or(&vec![]) {
                let outgoing =
                    client.request("callHierarchy/outgoingCalls", json!({"item":item}))?;
                for call in outgoing.as_array().unwrap_or(&vec![]) {
                    let to = &call["to"];
                    let target = nodes.iter().find(|n| {
                        n["path"].as_str().is_some_and(|p| {
                            uri(&format!("{root}/{p}")) == to["uri"].as_str().unwrap_or("")
                        }) && n["line"].as_u64().unwrap_or(1).saturating_sub(1)
                            <= to["selectionRange"]["start"]["line"].as_u64().unwrap_or(0)
                            && n["endLine"].as_u64().unwrap_or(0)
                                > to["selectionRange"]["start"]["line"].as_u64().unwrap_or(0)
                            && n["name"] == to["name"]
                    });
                    if let Some(target) = target {
                        for range in call["fromRanges"].as_array().unwrap_or(&vec![]) {
                            graph["edges"].as_array_mut().unwrap().push(json!({"id":format!("lsp:{count}"),"source":node["id"],"target":target["id"],"kind":"calls","line":range["start"]["line"].as_u64().unwrap_or(0)+1,"column":range["start"]["character"],"origin":"lsp","status":"indexed"}));
                            count += 1;
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            graph["diagnostics"]
                .as_array_mut()
                .unwrap()
                .push(json!({"symbol":node["id"],"message":format!("LSP 未完成：{e}")}));
        }
    }
    // Refresh candidates using the enriched callsites; never interpret semantic edges as runtime events.
    fn clear(ops: &mut Value) {
        for op in ops.as_array_mut().unwrap() {
            if op["kind"] == "call" {
                if let Some(targets) = op["targets"].as_array_mut() {
                    targets.retain(|t| t["origin"] == "ast");
                }
            }
            for k in [
                "body",
                "elseBody",
                "finallyBody",
                "conditionBody",
                "incrementBody",
            ] {
                if op[k].is_array() {
                    clear(&mut op[k]);
                }
            }
            for k in ["arms", "handlers"] {
                if let Some(a) = op[k].as_array_mut() {
                    for arm in a {
                        clear(&mut arm["body"]);
                    }
                }
            }
        }
    }
    for ops in graph["flows"].as_object_mut().unwrap().values_mut() {
        clear(ops);
    }
    crate::scan::resolve_flows(graph);
    graph["stats"]["lspEdges"] = json!(count);
    graph["stats"]["edges"] = json!(graph["edges"].as_array().unwrap().len());
    graph["snapshot"]["id"] = Value::Null;
    graph["snapshot"]["id"] = json!(format!("{:x}", Sha256::digest(serde_json::to_vec(graph)?)));
    let _ = client.request("shutdown", Value::Null);
    let _ = client.notify("exit", Value::Null);
    Ok(())
}
