use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    version,
    about = "扫描本地代码，浏览结构并手动演示执行路径；不运行目标项目"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 读取 CodeGraph 并生成独立的项目快照
    Scan {
        #[arg(long)]
        project: PathBuf,
        #[arg(long)]
        out: Option<PathBuf>,
        /// 显式允许在目标项目建立或同步 CodeGraph 索引
        #[arg(long)]
        index: bool,
        /// 可选的 LSP 可执行文件（不经 shell）；只分析指定语言
        #[arg(long)]
        lsp_command: Option<String>,
        #[arg(long, requires = "lsp_command")]
        lsp_language: Option<String>,
        #[arg(long)]
        lsp_arg: Vec<String>,
    },
    /// 启动本机工作区；首次启动默认打开示例项目
    Serve {
        #[arg(long)]
        project: Option<PathBuf>,
        #[arg(long, default_value_t = 7331)]
        port: u16,
        #[arg(long)]
        index: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Scan {
            project,
            out,
            index,
            lsp_command,
            lsp_language,
            lsp_arg,
        } => {
            let control = std::sync::Arc::new(repo2tree::scan_job::ScanControl::default());
            let observed = control.clone();
            let progress = std::thread::spawn(move || {
                let mut previous = String::new();
                loop {
                    let state = observed.snapshot();
                    let stage = state["stage"].as_str().unwrap_or("");
                    if stage != previous {
                        eprintln!("{stage}");
                        previous = stage.to_owned();
                    }
                    if state["running"] == false {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            });
            let result = repo2tree::scan::scan_with_control(&project, index, &control);
            let error = result.as_ref().err().map(|e| format!("{e:#}"));
            control.finish(error.as_deref());
            let _ = progress.join();
            let mut graph = result?;
            if let Some(command) = lsp_command {
                if let Err(error) =
                    repo2tree::lsp::enrich(&mut graph, &command, &lsp_arg, lsp_language.as_deref())
                {
                    graph["diagnostics"].as_array_mut().unwrap().push(serde_json::json!({"adapter":"lsp","message":format!("LSP 未完成，保留已有分析：{error:#}")}));
                }
            }
            let out = out.unwrap_or_else(|| project.join(".repo2tree/project.json"));
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&out, serde_json::to_vec_pretty(&graph)?)?;
            println!(
                "{}",
                serde_json::json!({"output": out, "stats": graph["stats"], "diagnostics": graph["diagnostics"]})
            );
        }
        Command::Serve {
            project,
            port,
            index,
        } => {
            repo2tree::server::serve(project, port, index).await?;
        }
    }
    Ok(())
}
