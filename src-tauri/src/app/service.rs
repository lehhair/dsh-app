//! Embedded local dsh instance: spawn the bundled official Node running
//! `@deepseek-ai/dsh`'s `bin.js` (never Electron's patched Node kernel — dsh
//! needs Node's internal `getOrInitializeCascadedLoader`), wait for health,
//! keep a bounded log ring, and watch for exits.

use crate::app::paths::Paths;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::{oneshot, Mutex as TokioMutex};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const LOG_CAP: usize = 5000;

#[derive(Default)]
pub struct DshService {
  pub running: Arc<Mutex<Option<Running>>>,
  pub logs: Arc<Mutex<VecDeque<String>>>,
  /// Serializes `start_local`: two concurrent callers (e.g. the boot
  /// auto-start and a manual start) must not each spawn a node.
  pub lock: TokioMutex<()>,
}

pub struct Running {
  pub pid: u32,
  pub port: u16,
  pub url: String,
  pub ready: bool,
  pub exited: oneshot::Receiver<Option<i32>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
  pub running: bool,
  pub starting: bool,
  pub port: Option<u16>,
  pub url: Option<String>,
}

pub async fn start_local(app: &AppHandle, service: &DshService) -> Result<LocalInfo, String> {
  // Serialize concurrent starts — the second caller waits for the first to
  // finish booting and then sees the settled state, instead of spawning a
  // second node (which would orphan one instance).
  let _guard = service.lock.lock().await;

  let existing = {
    let running = service.running.lock().unwrap();
    running.as_ref().map(|r| (r.ready, r.port, r.url.clone()))
  };
  if let Some((ready, port, url)) = existing {
    if ready && is_healthy(&url).await {
      return Ok(LocalInfo {
        running: true,
        starting: false,
        port: Some(port),
        url: Some(url),
      });
    }
    // Stale (died or never became healthy) — restart below.
  }

  let paths = Paths::resolve(app);
  // Bundled installs ship node + npm but not the dsh runtime — give a clear
  // instruction instead of spawning node against a missing bin.js. External
  // installs resolve the user's own global dsh; when it is missing, say so
  // instead of pointing at the bundled installer.
  if !paths.dsh_bin.exists() {
    return Err(if paths.bundled {
      "dsh 运行时未安装 —— 请先点击「安装 dsh」".into()
    } else {
      "未找到全局 dsh（npm i -g @deepseek-ai/dsh）".into()
    });
  }
  let port = pick_free_port().map_err(|e| format!("无法分配端口：{e}"))?;
  let url = format!("http://127.0.0.1:{port}/");

  let mut command = TokioCommand::new(&paths.node_exe);
  command
    .arg(&paths.dsh_bin)
    .arg("--patch")
    .arg(&paths.overlay)
    .arg("--profile")
    .arg("web")
    .arg("--port")
    .arg(port.to_string())
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
  #[cfg(windows)]
  {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  let mut child = command
    .spawn()
    .map_err(|e| format!("无法启动 node（{}）：{}", paths.node_exe.display(), e))?;
  let pid = child.id().unwrap_or(0);

  let logs = service.logs.clone();
  if let Some(stdout) = child.stdout.take() {
    tokio::spawn(read_lines(stdout, logs));
  }
  if let Some(stderr) = child.stderr.take() {
    tokio::spawn(read_lines(stderr, service.logs.clone()));
  }

  let (exit_tx, exit_rx) = oneshot::channel();
  let app_for_watcher = app.clone();
  let service_for_watcher = service.running.clone();
  tokio::spawn(async move {
    let status = child.wait().await;
    let code = status.ok().and_then(|s| s.code());
    let _ = exit_tx.send(code);
    log::info!("[dsh] exited code={code:?}");
    let mut running = service_for_watcher.lock().unwrap();
    if running.as_ref().map(|r| r.pid) == Some(pid) {
      running.take();
    }
    let _ = app_for_watcher.emit("local:exited", serde_json::json!({ "code": code }));
  });

  service.running.lock().unwrap().replace(Running {
    pid,
    port,
    url: url.clone(),
    ready: false,
    exited: exit_rx,
  });

  // Health loop: GET the root until 200, up to HEALTH_TIMEOUT.
  let deadline = Instant::now() + HEALTH_TIMEOUT;
  loop {
    if is_healthy(&url).await {
      break;
    }
    if Instant::now() > deadline {
      stop_local(service);
      return Err(format!("dsh 未在 90 秒内就绪：\n{}", tail_logs(service)));
    }
    {
      let mut running = service.running.lock().unwrap();
      match running.as_mut() {
        Some(r) => {
          if exited(&mut r.exited) {
            running.take();
            return Err(format!("dsh 启动时退出：\n{}", tail_logs(service)));
          }
        }
        None => return Err("dsh 启动失败".into()),
      }
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
  }

  // Settle: give the server a beat past first-200, then confirm it is alive.
  tokio::time::sleep(Duration::from_millis(1000)).await;
  {
    let mut running = service.running.lock().unwrap();
    match running.as_mut() {
      Some(r) => {
        if exited(&mut r.exited) {
          running.take();
          return Err(format!("dsh 启动时退出：\n{}", tail_logs(service)));
        }
        r.ready = true;
      }
      None => return Err("dsh 启动失败".into()),
    }
  }

  Ok(LocalInfo {
    running: true,
    starting: false,
    port: Some(port),
    url: Some(url),
  })
}

pub fn stop_local(service: &DshService) {
  let pid = service.running.lock().unwrap().take().map(|r| r.pid);
  if let Some(pid) = pid {
    kill_tree(pid);
  }
}

pub fn local_info(service: &DshService) -> LocalInfo {
  let running = service.running.lock().unwrap();
  match running.as_ref() {
    Some(r) if r.ready => LocalInfo {
      running: true,
      starting: false,
      port: Some(r.port),
      url: Some(r.url.clone()),
    },
    Some(r) => LocalInfo {
      running: false,
      starting: true,
      port: Some(r.port),
      url: Some(r.url.clone()),
    },
    None => LocalInfo {
      running: false,
      starting: false,
      port: None,
      url: None,
    },
  }
}

pub fn logs(service: &DshService) -> String {
  service.logs.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n")
}

fn tail_logs(service: &DshService) -> String {
  let all = logs(service);
  let bytes = all.len();
  if bytes > 4000 {
    all.chars().skip(bytes.saturating_sub(4000)).collect()
  } else {
    all
  }
}

async fn read_lines<R>(reader: R, logs: std::sync::Arc<Mutex<VecDeque<String>>>)
where
  R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
  let mut lines = tokio::io::BufReader::new(reader).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    let mut ring = logs.lock().unwrap();
    if ring.len() >= LOG_CAP {
      ring.pop_front();
    }
    ring.push_back(line);
  }
}

fn exited(receiver: &mut oneshot::Receiver<Option<i32>>) -> bool {
  match receiver.try_recv() {
    Ok(_) => true,
    Err(oneshot::error::TryRecvError::Closed) => true,
    Err(oneshot::error::TryRecvError::Empty) => false,
  }
}

async fn is_healthy(url: &str) -> bool {
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(2))
    .build()
    .unwrap_or_default();
  matches!(client.get(url).send().await, Ok(response) if response.status() == reqwest::StatusCode::OK)
}

fn pick_free_port() -> std::io::Result<u16> {
  let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
  Ok(listener.local_addr()?.port())
}

fn kill_tree(pid: u32) {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
  #[cfg(not(windows))]
  {
    let _ = std::process::Command::new("kill")
      .args(["-9", &pid.to_string()])
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
}
