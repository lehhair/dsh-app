//! Embedded dsh self-update via the bundled official Node driving the
//! bundled npm CLI (`node_modules/npm/bin/npm-cli.js`) — no system node/npm
//! required. npm traffic honors the user's registry config (~/.npmrc) like a
//! normal `npm install`.

use crate::app::paths::Paths;
use crate::app::service::{self, DshService};
use crate::app::windows;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};

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

// ---- shared process plumbing ----

/// Child stdio: no input, output piped for collection/streaming.
fn piped(command: &mut Command) -> &mut Command {
  command
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
}

/// Never flash a console window on Windows (GUI app spawning CLI tools).
fn no_window(command: &mut Command) {
  #[cfg(windows)]
  {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
}

/// Collect a spawned child's combined stdout+stderr and exit code.
async fn wait_output(child: Child) -> (i32, String) {
  match child.wait_with_output().await {
    Ok(output) => {
      let code = output.status.code().unwrap_or(-1);
      let text = String::from_utf8_lossy(&output.stdout).into_owned()
        + &String::from_utf8_lossy(&output.stderr);
      (code, text)
    }
    Err(e) => (-1, format!("{e}")),
  }
}

/// The system npm (`npm` on PATH) — used by the external flavor, which has
/// no bundled node/npm. Windows npm is a .cmd shim that CreateProcess cannot
/// run directly, so wrap it in `cmd.exe /C`.
fn system_npm_command(args: &[&str]) -> Command {
  #[cfg(windows)]
  {
    let mut command = Command::new("cmd.exe");
    command.arg("/C").arg("npm.cmd").args(args);
    command
  }
  #[cfg(not(windows))]
  {
    let mut command = Command::new("npm");
    command.args(args);
    command
  }
}

/// Run a quick npm query (no streaming, no cancel) and return (code, output).
async fn run_npm_quiet(mut command: Command) -> (i32, String) {
  piped(&mut command);
  no_window(&mut command);
  match command.spawn() {
    Ok(child) => wait_output(child).await,
    Err(e) => (-1, format!("无法启动 npm：{e}")),
  }
}

/// The command that installs `@deepseek-ai/dsh@<version>` into `target_dir`.
///
/// Bundled flavor: the shipped node drives the bundled npm CLI. A package
/// that shipped without them (broken build — resources missing) falls back
/// to the user's own npm with `--prefix`, installing into the SAME dir so
/// the launcher still manages the result. The external flavor instead
/// updates the user's global dsh in place (`npm i -g`) — pass
/// `target_dir = None` for that.
fn install_command(paths: &Paths, version: &str, target_dir: Option<&std::path::Path>) -> Command {
  let package = format!("@deepseek-ai/dsh@{version}");
  let npm_args = ["--no-audit", "--no-fund", "--loglevel", "error"];
  if paths.npm_cli.exists() {
    // Bundled flavor: the shipped node drives the bundled npm CLI into the
    // launcher-owned runtime dir (cwd).
    let mut command = Command::new(&paths.node_exe);
    command
      .arg(&paths.npm_cli)
      .arg("install")
      .arg(&package)
      .args(npm_args);
    if let Some(dir) = target_dir {
      command.current_dir(dir);
    }
    command
  } else if let Some(dir) = target_dir {
    // Launcher-managed runtime without bundled npm (broken package): use the
    // user's own npm, never the global install.
    let mut command = system_npm_command(&[]);
    command
      .arg("install")
      .arg("--prefix")
      .arg(dir)
      .arg(&package)
      .args(npm_args);
    command
  } else {
    // External flavor: the user's own npm owns the global dsh — update it in
    // place.
    let mut command = system_npm_command(&[]);
    command.arg("install").arg("-g").arg(&package).args(npm_args);
    command
  }
}

/// npm resolves the install prefix by CLIMBING to the nearest ancestor that
/// has a package.json / node_modules — without one in the runtime dir, an
/// install could land in a parent directory the resolver never looks at.
fn ensure_package_json(dir: &std::path::Path) -> Result<(), String> {
  let pkg = dir.join("package.json");
  if !pkg.exists() {
    std::fs::write(&pkg, "{\"name\":\"dsh-runtime\",\"private\":true}\n")
      .map_err(|e| format!("无法初始化运行时目录：{e}"))?;
  }
  Ok(())
}

/// How a cancellable npm install ended.
enum InstallOutcome {
  /// npm exited with this code.
  Completed(i32),
  /// The user cancelled; the npm tree was killed.
  Cancelled,
}

/// Spawn an npm install, stream its output lines to every shell window, and
/// let `dsh_update_cancel` abort it (kills the npm process tree).
async fn run_install(app: &AppHandle, service: &DshService, mut command: Command) -> Result<InstallOutcome, String> {
  piped(&mut command);
  no_window(&mut command);

  let mut child = command
    .spawn()
    .map_err(|e| format!("无法启动 npm 安装进程：{e}"))?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  // Register a cancel signal so the user can abort this install.
  let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
  service::set_update_cancel(service, Some(cancel.clone()));
  if let Some(out) = stdout {
    tokio::spawn(stream_lines(out, app.clone()));
  }
  if let Some(err) = stderr {
    tokio::spawn(stream_lines(err, app.clone()));
  }

  let status = tokio::select! {
    s = child.wait() => s.map_err(|e| format!("npm 进程异常：{e}"))?,
    _ = cancel.notified() => {
      #[cfg(windows)]
      if let Some(pid) = child.id() {
        service::kill_tree(pid);
      }
      let _ = child.kill().await;
      let _ = child.wait().await;
      service::set_update_cancel(service, None);
      return Ok(InstallOutcome::Cancelled);
    }
  };
  service::set_update_cancel(service, None);
  Ok(InstallOutcome::Completed(status.code().unwrap_or(-1)))
}

// ---- version check ----

/// Latest published version on the registry, or None on failure. Uses the
/// bundled npm when this install ships node+npm, the system npm otherwise
/// (external flavor — the user's own npm owns the global dsh).
pub async fn check_update(paths: &Paths) -> Option<UpdateInfo> {
  let view = ["view", "@deepseek-ai/dsh", "version"];
  let (code, out) = if paths.npm_cli.exists() {
    // No cwd: `npm view` is project-independent, and the runtime dir may not
    // exist yet (pre-install) — an invalid cwd fails the spawn outright.
    let mut command = Command::new(&paths.node_exe);
    command.arg(&paths.npm_cli).args(view);
    run_npm_quiet(command).await
  } else {
    run_npm_quiet(system_npm_command(&view)).await
  };
  // npm may print warnings (e.g. unsupported Node version) AFTER the version
  // token — take the FIRST token that starts with a digit, not the last.
  let latest = out
    .split_whitespace()
    .find(|token| token.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
    .unwrap_or("")
    .to_string();
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

// ---- update / install ----

/// Update dsh to `target` (exact version). Bundled installs (ships
/// node+npm) install into the launcher-managed runtime via the bundled npm
/// CLI; the external flavor has no bundled tooling, so the user's own npm
/// updates their global dsh (`npm i -g`). Either way: stop the local
/// instance first (files are locked while running), install, then restart it
/// if it was running. Progress lines stream to every shell window.
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

  // External flavor has no launcher-owned runtime (target_dir = None → npm -g).
  let target_dir = paths.bundled.then_some(paths.dsh_runtime.as_path());
  if let Some(dir) = target_dir {
    ensure_package_json(dir)?;
  }
  let command = install_command(&paths, target, target_dir);
  match run_install(app, &service, command).await? {
    InstallOutcome::Cancelled => {
      notify("已取消更新");
      if was_running {
        let _ = service::start_local(app, &service).await;
      }
      return Ok(UpdateResult { ok: false, version: None, error: Some("已取消".into()) });
    }
    InstallOutcome::Completed(code) if code != 0 => {
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
    InstallOutcome::Completed(_) => {}
  }

  let installed = paths.local_dsh_version();
  notify(&format!("安装完成：v{}", installed.as_deref().unwrap_or(target)));
  if was_running {
    if let Ok(info) = service::start_local(app, &service).await {
      if let Some(url) = info.url {
        windows::reconnect_local_windows(app, &url).await;
      }
    }
  }
  Ok(UpdateResult { ok: true, version: installed, error: None })
}

/// `npm ci` from the shipped lockfile seed, when both the bundled npm and
/// the seed exist. Resolving dsh's ~250 same-version cross-linked packages
/// from scratch pegs one core for 10+ minutes; with the seed's lockfile the
/// same install takes seconds (npm's replace-registry-host rewrites the
/// locked npmjs.org URLs to the user's configured mirror).
fn seed_ci_command(app: &AppHandle, paths: &Paths, target: &std::path::Path) -> Option<Command> {
  if !paths.npm_cli.exists() {
    return None;
  }
  let seed = [
    app.path().resource_dir().ok().map(|r| r.join("resources").join("dsh-runtime-seed")),
    Some(
      std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("resources")
        .join("dsh-runtime-seed"),
    ),
  ]
  .into_iter()
  .flatten()
  .find(|p| p.join("package-lock.json").exists())?;
  std::fs::copy(seed.join("package.json"), target.join("package.json")).ok()?;
  std::fs::copy(seed.join("package-lock.json"), target.join("package-lock.json")).ok()?;
  let mut command = Command::new(&paths.node_exe);
  command
    .arg(&paths.npm_cli)
    .args(["ci", "--no-audit", "--no-fund", "--loglevel", "error"])
    .current_dir(target);
  Some(command)
}

/// Install (or reinstall) the latest dsh into the user-data runtime dir the
/// shell manages. The bundled installer ships node + npm only — the runtime
/// is installed here on demand, then resolved like any other managed runtime.
pub async fn install_dsh(app: &AppHandle) -> Result<UpdateResult, String> {
  let service = app.state::<DshService>();
  let target = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("无法定位数据目录：{e}"))?
    .join("dsh-runtime");
  std::fs::create_dir_all(&target).map_err(|e| format!("无法创建运行时目录：{e}"))?;

  let notify = |line: &str| {
    log::info!("[install] {line}");
    let _ = app.emit("dsh:update-log", line);
  };

  notify("正在安装 @deepseek-ai/dsh（最新版）…");

  let paths = Paths::resolve(app);
  let command = match seed_ci_command(app, &paths, &target) {
    Some(command) => {
      notify("使用内置锁文件快速安装…");
      command
    }
    None => {
      ensure_package_json(&target)?;
      install_command(&paths, "latest", Some(&target))
    }
  };
  match run_install(app, &service, command).await? {
    InstallOutcome::Cancelled => {
      notify("已取消安装");
      return Ok(UpdateResult { ok: false, version: None, error: Some("已取消".into()) });
    }
    InstallOutcome::Completed(code) if code != 0 => {
      notify(&format!("安装失败（npm 退出码 {code}）"));
      return Ok(UpdateResult {
        ok: false,
        version: None,
        error: Some(format!("npm 退出码 {code}")),
      });
    }
    InstallOutcome::Completed(_) => {}
  }

  let installed = Paths::resolve(app).local_dsh_version();
  notify(&format!("安装完成：v{}", installed.as_deref().unwrap_or("?")));
  Ok(UpdateResult { ok: true, version: installed, error: None })
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

/// Compare semver strings; >0 = a newer, <0 = a older, 0 = equal. Parse
/// failures compare equal (no update offered) — a malformed registry answer
/// must not trigger a downgrade.
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

#[cfg(test)]
mod tests {
  use super::compare_versions;

  #[test]
  fn version_compare_basic() {
    assert_eq!(compare_versions("0.2.0", "0.2.0"), 0);
    assert_eq!(compare_versions("0.2.1", "0.2.0"), 1);
    assert_eq!(compare_versions("0.2.0", "0.2.1"), -1);
    assert_eq!(compare_versions("1.0.0", "0.9.9"), 1);
    assert_eq!(compare_versions("0.10.0", "0.9.0"), 1);
  }

  #[test]
  fn version_compare_prefix_and_prerelease() {
    // Tags carry a leading v; prereleases sort before their release.
    assert_eq!(compare_versions("v0.3.0", "0.2.9"), 1);
    assert_eq!(compare_versions("0.3.0-rc.1", "0.3.0"), -1);
    assert_eq!(compare_versions("0.3.0", "0.3.0-rc.1"), 1);
    assert_eq!(compare_versions("0.3.0-rc.2", "0.3.0-rc.1"), 1);
  }

  #[test]
  fn version_compare_garbage_is_equal() {
    // A malformed registry answer must not trigger an "update".
    assert_eq!(compare_versions("garbage", "0.2.0"), 0);
    assert_eq!(compare_versions("0.2.0", ""), 0);
  }
}
