//! Embedded dsh self-update via the bundled official Node driving the
//! bundled npm CLI (`node_modules/npm/bin/npm-cli.js`) — no system node/npm
//! required. npm traffic honors the user's registry config (~/.npmrc) like a
//! normal `npm install`.

use crate::app::paths::Paths;
use crate::app::service::{self, DshService};
use crate::app::windows;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
  pub current: Option<String>,
  pub latest: String,
  pub update_available: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
  pub ok: bool,
  pub version: Option<String>,
  pub error: Option<String>,
}

/// Run the bundled npm CLI under the bundled node. Returns (exit code, output).
async fn run_npm(paths: &Paths, args: &[&str]) -> (i32, String) {
  let mut command = tokio::process::Command::new(&paths.node_exe);
  command
    .arg(&paths.npm_cli)
    .args(args)
    .current_dir(&paths.dsh_runtime)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
  #[cfg(windows)]
  {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  match command.spawn() {
    Ok(child) => match child.wait_with_output().await {
      Ok(output) => {
        let code = output.status.code().unwrap_or(-1);
        let text = String::from_utf8_lossy(&output.stdout).into_owned()
          + &String::from_utf8_lossy(&output.stderr);
        (code, text)
      }
      Err(e) => (-1, format!("{e}")),
    },
    Err(e) => (-1, format!("无法启动 node：{e}")),
  }
}

/// Latest published version on the registry, or None on failure.
pub async fn check_update(paths: &Paths) -> Option<UpdateInfo> {
  let (code, out) = run_npm(paths, &["view", "@deepseek-ai/dsh", "version"]).await;
  let latest = out.trim().split_whitespace().next_back().unwrap_or("").to_string();
  if code != 0 || !latest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
    return None;
  }
  let current = paths.local_dsh_version();
  Some(UpdateInfo {
    update_available: compare_versions(&latest, current.as_deref().unwrap_or("0")) > 0,
    current,
    latest,
  })
}

/// Update the embedded dsh to `target` (exact version). Stops the local
/// instance first (files are locked while running), installs, then restarts
/// it if it was running. Progress lines stream to every shell window.
pub async fn update_dsh(app: &AppHandle, target: &str) -> Result<UpdateResult, String> {
  let paths = Paths::resolve(app);
  let service = app.state::<DshService>();
  let was_running = service.running.lock().unwrap().is_some();
  service::stop_local(&service);

  let notify = |line: &str| {
    log::info!("[update] {line}");
    let _ = app.emit("dsh:update-log", line);
  };

  notify(&format!("正在安装 @deepseek-ai/dsh@{target} …"));

  let mut command = tokio::process::Command::new(&paths.node_exe);
  command
    .arg(&paths.npm_cli)
    .args(["install", &format!("@deepseek-ai/dsh@{target}"), "--no-audit", "--no-fund", "--loglevel", "error"])
    .current_dir(&paths.dsh_runtime)
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
    .map_err(|e| format!("无法启动 node：{e}"))?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let app_for_lines = app.clone();
  if let Some(out) = stdout {
    tokio::spawn(stream_lines(out, app_for_lines.clone()));
  }
  if let Some(err) = stderr {
    tokio::spawn(stream_lines(err, app_for_lines));
  }

  let status = child
    .wait()
    .await
    .map_err(|e| format!("npm 进程异常：{e}"))?;
  let code = status.code().unwrap_or(-1);

  if code != 0 {
    notify(&format!("安装失败（npm 退出码 {code}）"));
    if was_running {
      let _ = service::start_local(app, &service).await;
    }
    return Ok(UpdateResult {
      ok: false,
      version: None,
      error: Some(format!("npm 退出码 {code}")),
    });
  }

  let installed = paths.local_dsh_version();
  notify(&format!("安装完成：v{}", installed.as_deref().unwrap_or(target)));
  if was_running {
    let result = service::start_local(app, &service).await;
    if let Ok(info) = result {
      if let Some(url) = info.url {
        windows::reconnect_local_windows(app, &url).await;
      }
    }
  }
  Ok(UpdateResult {
    ok: true,
    version: installed,
    error: None,
  })
}

async fn stream_lines<R>(reader: R, app: AppHandle)
where
  R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
  use tokio::io::AsyncBufReadExt;
  let mut lines = tokio::io::BufReader::new(reader).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    log::info!("[update] {line}");
    let _ = app.emit("dsh:update-log", line);
  }
}

/// Compare semver strings; >0 = a newer, <0 = a older, 0 = equal.
pub fn compare_versions(a: &str, b: &str) -> i32 {
  fn parse(v: &str) -> Option<(u32, u32, u32, Option<String>)> {
    let v = v.trim().trim_start_matches('v');
    let mut parts = v.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    let (patch, pre) = match rest.split_once('-') {
      Some((p, pre)) => (p.parse().ok()?, Some(pre.to_string())),
      None => (rest.parse().ok()?, None),
    };
    Some((major, minor, patch, pre))
  }
  let (Some(pa), Some(pb)) = (parse(a), parse(b)) else { return 0 };
  for (x, y) in [(pa.0, pb.0), (pa.1, pb.1), (pa.2, pb.2)] {
    if x != y {
      return if x > y { 1 } else { -1 };
    }
  }
  match (&pa.3, &pb.3) {
    (None, None) => 0,
    (None, Some(_)) => 1,
    (Some(_), None) => -1,
    (Some(x), Some(y)) => {
      if x == y {
        0
      } else if x > y {
        1
      } else {
        -1
      }
    }
  }
}
