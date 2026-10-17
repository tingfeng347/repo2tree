//! Shared scan progress and cooperative cancellation, including parser subprocesses.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    process::{Command, Output, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub struct ScanControl {
    cancelled: AtomicBool,
    progress: Mutex<Value>,
    started: Instant,
}
impl Default for ScanControl {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            started: Instant::now(),
            progress: Mutex::new(
                json!({"running":true,"stage":"准备扫描","completed":0,"total":0}),
            ),
        }
    }
}
impl ScanControl {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            bail!("扫描已取消");
        }
        Ok(())
    }
    pub fn stage(&self, name: &str, completed: usize, total: usize) -> Result<()> {
        self.check()?;
        *self.progress.lock().unwrap() =
            json!({"running":true,"stage":name,"completed":completed,"total":total});
        Ok(())
    }
    pub fn finish(&self, error: Option<&str>) {
        let mut progress = self.progress.lock().unwrap();
        progress["running"] = json!(false);
        progress["stage"] = json!(if error.is_some() {
            "扫描未完成"
        } else {
            "扫描完成"
        });
        progress["error"] = json!(error);
    }
    pub fn snapshot(&self) -> Value {
        let mut progress = self.progress.lock().unwrap().clone();
        progress["elapsedSeconds"] = json!(self.started.elapsed().as_secs());
        progress["cancelling"] = json!(self.cancelled.load(Ordering::Relaxed));
        progress
    }
}

// Drain all pipes concurrently: a large parser result must not fill a pipe
// while the parent is still writing the source snapshot to stdin.
pub(crate) fn run_command(
    command: &mut Command,
    input: Vec<u8>,
    control: &ScanControl,
    timeout: Duration,
) -> Result<Output> {
    control.check()?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().context("scan stdin")?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child.stdout.take().context("scan stdout")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = vec![];
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child.stderr.take().context("scan stderr")?;
    let errors = std::thread::spawn(move || {
        let mut bytes = vec![];
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let mut exited = None;
    let result = loop {
        if let Err(error) = control.check() {
            break Err(error);
        }
        if started.elapsed() > timeout {
            break Err(anyhow::anyhow!(
                "分析子进程超时（{} 秒）；请检查工具或缩小扫描范围",
                timeout.as_secs()
            ));
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(status) => exited = status,
                Err(error) => break Err(error.into()),
            }
        }
        if let Some(status) = exited {
            if writer.is_finished() && reader.is_finished() && errors.is_finished() {
                break Ok(status);
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if result.is_err() {
        // The process has its own group; terminate only this scan's descendants.
        #[cfg(unix)]
        {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", child.id())])
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let written = writer
        .join()
        .map_err(|_| anyhow::anyhow!("扫描输入线程异常"))?;
    let stdout = reader
        .join()
        .map_err(|_| anyhow::anyhow!("扫描输出线程异常"))??;
    let stderr = errors
        .join()
        .map_err(|_| anyhow::anyhow!("扫描错误线程异常"))??;
    let status = result?;
    if status.success() {
        written?;
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn cancellation_stops_the_actual_parser_process() {
        let control = Arc::new(ScanControl::default());
        let cancel = control.clone();
        let worker = std::thread::spawn(move || {
            run_command(
                Command::new("python3").args(["-c", "import time; time.sleep(30)"]),
                vec![],
                &control,
                Duration::from_secs(60),
            )
        });
        std::thread::sleep(Duration::from_millis(100));
        let start = Instant::now();
        cancel.cancel();
        assert!(
            worker
                .join()
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("已取消")
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn parser_deadline_terminates_the_process() {
        let result = run_command(
            Command::new("python3").args(["-c", "import time; time.sleep(30)"]),
            vec![],
            &ScanControl::default(),
            Duration::from_millis(100),
        );
        assert!(result.unwrap_err().to_string().contains("超时"));
    }
    #[test]
    fn deadline_also_stops_descendants_that_keep_the_output_pipe_open() {
        let started = Instant::now();
        let result = run_command(
            Command::new("python3").args(["-c", "import subprocess,sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])"]),
            vec![], &ScanControl::default(), Duration::from_millis(300));
        assert!(result.unwrap_err().to_string().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
