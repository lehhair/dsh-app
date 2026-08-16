//! All `#[tauri::command]` handlers. Sensitive commands are gated to the
//! launcher origin (the shell page); the injected dsh back button
//! (`shell_back`) and theme sampler (`theme_changed`) are deliberately
//! callable from remote dsh pages — they are cosmetic and user-initiated.

use crate::app::auth;
use crate::app::secrets::Secrets;
use crate::app::service::{self, DshService};
use crate::app::store::{SaveInstanceInput, Store};
use crate::app::update;
use crate::app::windows;
use crate::app::paths::Paths;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

fn app_origin_gate(app: &AppHandle, webview: &Webview) -> Result<String, String> {
  windows::require_launcher(app, webview)
}

// ---- platform info ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
  pub desktop: bool,
  pub version: String,
  /// The dsh runtime is launcher-managed (bundled, or the dev project
  /// fallback) — the shell can update it in place. False for the external
  /// flavor (user-provided global dsh), which hides the in-app dsh updater.
  pub bundled: bool,
  /// Host OS: "windows" | "macos" | "linux" (frontend titlebar adaptation).
  pub platform: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
  AppInfo {
    desktop: cfg!(desktop),
    version: app.package_info().version.to_string(),
    bundled: Paths::resolve(&app).bundled,
    platform: std::env::consts::OS.to_string(),
  }
}

/// Status-bar inset in CSS px (mobile; 0 on desktop — CSS env() handles iOS).
#[tauri::command]
pub fn status_bar_height(app: AppHandle) -> f64 {
  #[cfg(target_os = "android")]
  {
    let plugin = app.state::<crate::app::mobile::DshNative<tauri::Wry>>();
    return plugin.status_bar_height().unwrap_or(0.0);
  }
  #[cfg(not(target_os = "android"))]
  {
    let _ = &app;
    0.0
  }
}

/// Status-bar icon appearance following the page theme (Android; no-op
/// elsewhere). `dark` = the page is dark → light icons.
#[tauri::command]
pub fn status_bar_appearance(app: AppHandle, dark: bool) -> Result<serde_json::Value, String> {
  #[cfg(target_os = "android")]
  {
    let plugin = app.state::<crate::app::mobile::DshNative<tauri::Wry>>();
    plugin
      .set_status_bar_appearance(dark)
      .map_err(|e| e.to_string())?;
  }
  #[cfg(not(target_os = "android"))]
  {
    let _ = &app;
    let _ = dark;
  }
  Ok(serde_json::json!({ "ok": true }))
}

// ---- embedded local instance ----

#[tauri::command]
pub async fn local_start(app: AppHandle, state: State<'_, DshService>) -> Result<serde_json::Value, String> {
  // Wrapped like every other command: the frontend treats `ok` as the
  // success flag. The bare LocalInfo has no such field — callers checking
  // `result.ok` would misread a successful boot as a failure.
  let info = service::start_local(&app, &state).await?;
  Ok(serde_json::json!({
    "ok": true,
    "running": info.running,
    "starting": info.starting,
    "port": info.port,
    "url": info.url,
  }))
}

#[tauri::command]
pub fn local_stop(state: State<'_, DshService>) -> Result<serde_json::Value, String> {
  service::stop_local(&state);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn local_status(state: State<'_, DshService>) -> service::LocalInfo {
  service::local_info(&state)
}

#[tauri::command]
pub fn local_logs(state: State<'_, DshService>) -> String {
  service::logs(&state)
}

// ---- embedded dsh self-update ----

#[tauri::command]
pub fn dsh_version(app: AppHandle) -> Option<String> {
  Paths::resolve(&app).local_dsh_version()
}

#[tauri::command]
pub async fn dsh_check_update(app: AppHandle) -> Option<update::UpdateInfo> {
  update::check_update(&Paths::resolve(&app)).await
}

#[tauri::command]
pub async fn dsh_update(app: AppHandle, target: String) -> Result<update::UpdateResult, String> {
  update::update_dsh(&app, &target).await
}

// ---- launcher self-update (GitHub Releases) ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateInfo {
  pub update_available: bool,
  pub version: Option<String>,
  pub url: Option<String>,
  pub size: Option<u64>,
  pub notes: Option<String>,
}

/// Update channel: `DSH_UPDATE_OWNER` / `DSH_UPDATE_REPO` (empty disables).
fn launcher_repo() -> (String, String) {
  (
    std::env::var("DSH_UPDATE_OWNER").unwrap_or_default(),
    std::env::var("DSH_UPDATE_REPO").unwrap_or_default(),
  )
}

/// Dotted-semver compare: `a > b`.
fn version_gt(a: &str, b: &str) -> bool {
  let pa: Vec<u64> = a.split('.').filter_map(|s| s.parse().ok()).collect();
  let pb: Vec<u64> = b.split('.').filter_map(|s| s.parse().ok()).collect();
  for i in 0..pa.len().max(pb.len()) {
    let x = pa.get(i).copied().unwrap_or(0);
    let y = pb.get(i).copied().unwrap_or(0);
    if x != y {
      return x > y;
    }
  }
  false
}

#[tauri::command]
pub async fn check_launcher_update(app: AppHandle) -> Result<LauncherUpdateInfo, String> {
  let none = || LauncherUpdateInfo {
    update_available: false,
    version: None,
    url: None,
    size: None,
    notes: None,
  };
  let (owner, repo) = launcher_repo();
  if owner.is_empty() || repo.is_empty() {
    return Ok(none());
  }
  let client = reqwest::Client::builder()
    .user_agent("dsh-app")
    .timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .get(format!("https://api.github.com/repos/{owner}/{repo}/releases/latest"))
    .send()
    .await
    .map_err(|e| format!("无法连接 GitHub：{e}"))?;
  if !resp.status().is_success() {
    // 404 = no release yet; treat any failure as "no update".
    return Ok(none());
  }
  let text = resp.text().await.map_err(|e| e.to_string())?;
  let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
  let Some(tag) = json.get("tag_name").and_then(|t| t.as_str()) else {
    return Ok(none());
  };
  let latest = tag.trim_start_matches('v');
  let current = app.package_info().version.to_string();
  if !version_gt(latest, &current) {
    return Ok(none());
  }
  let assets = json.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
  let asset = assets.iter().find(|a| {
    a.get("name")
      .and_then(|n| n.as_str())
      .is_some_and(|n| n.ends_with(".exe"))
  });
  let url = asset
    .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()).map(str::to_string))
    .ok_or("发布资产中没有找到 exe 下载")?;
  let size = asset.and_then(|a| a.get("size").and_then(|s| s.as_u64()));
  let notes = json.get("body").and_then(|b| b.as_str()).map(str::to_string);
  Ok(LauncherUpdateInfo {
    update_available: true,
    version: Some(latest.to_string()),
    url: Some(url),
    size,
    notes,
  })
}

#[tauri::command]
pub async fn launcher_update(app: AppHandle, url: String) -> Result<serde_json::Value, String> {
  let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径：{e}"))?;
  let dir = exe.parent().ok_or("程序路径异常")?.to_path_buf();
  let new_path = dir.join("dsh-app.exe.new");

  let client = reqwest::Client::builder()
    .user_agent("dsh-app")
    .timeout(std::time::Duration::from_secs(300))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .get(&url)
    .send()
    .await
    .map_err(|e| format!("下载失败：{e}"))?;
  resp.error_for_status_ref().map_err(|e| format!("下载失败：{e}"))?;
  let bytes = resp.bytes().await.map_err(|e| format!("下载失败：{e}"))?;
  if bytes.is_empty() {
    return Err("下载内容为空".into());
  }
  std::fs::write(&new_path, &bytes).map_err(|e| format!("写入更新文件失败：{e}"))?;

  // A running exe cannot be replaced on Windows, so hand the swap to a
  // detached .cmd: wait for this process to exit (it will, right after this
  // command returns), swap the exe, and relaunch.
  let exe_name = exe.file_name().and_then(|n| n.to_str()).unwrap_or("dsh-app.exe");
  let script = format!(
    "@echo off\r\ntimeout /t 3 /nobreak >nul\r\n:wait\r\ntasklist /FI \"IMAGENAME eq {name}\" 2>nul | find /I \"{name}\" >nul\r\nif not errorlevel 1 (\r\n  timeout /t 1 /nobreak >nul\r\n  goto wait\r\n)\r\nmove /Y \"{new}\" \"{exe}\"\r\nstart \"\" \"{exe}\"\r\n",
    name = exe_name,
    new = new_path.display(),
    exe = exe.display(),
  );
  let script_path = dir.join("dsh-app-update.cmd");
  std::fs::write(&script_path, script).map_err(|e| format!("写入更新脚本失败：{e}"))?;
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
      .arg("/C")
      .arg(&script_path)
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
  #[cfg(not(windows))]
  {
    let _ = std::process::Command::new("sh")
      .arg("-c")
      .arg(format!("sleep 3; while kill -0 {} 2>/dev/null; do sleep 1; done; mv '{}' '{}'; exec '{}'", std::process::id(), new_path.display(), exe.display(), exe.display()))
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
  // Exit now; the detached script swaps the exe and relaunches.
  app.exit(0);
  Ok(serde_json::json!({ "ok": true }))
}

// ---- connect / navigate ----

#[tauri::command]
pub async fn shell_connect(app: AppHandle, webview: Webview, url: String) -> Result<serde_json::Value, String> {
  let win_label = app_origin_gate(&app, &webview)?;
  let url = String::from(url.trim());
  windows::connect_into_window(&app, &win_label, "local", &url, "DeepSeek Harness", None).await?;
  app.state::<Store>().shell_set("lastNode", serde_json::json!({ "type": "local" }));
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn remote_connect(app: AppHandle, webview: Webview, id: String) -> Result<serde_json::Value, String> {
  let win_label = app_origin_gate(&app, &webview)?;
  let store = app.state::<Store>();
  let instance = store.find_instance(&id).ok_or("实例不存在")?;
  let key = app.state::<Secrets>().get(&id);
  let key = key.ok_or("未保存访问密钥，请编辑实例补全")?;
  windows::connect_into_window(&app, &win_label, &instance.id, &instance.url, &instance.name, Some(&key)).await?;
  store.shell_set("lastNode", serde_json::json!({ "type": "remote", "id": instance.id }));
  log::info!("[connect] ok {}", instance.url);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn shell_back(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  // Allowed from dsh pages (the injected back button) and the launcher.
  let win_label = windows::label_of(&webview);
  windows::back_to_launcher(&app, &win_label);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn shell_new_window(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  // Async: window creation needs a main-thread round trip (same trap as
  // settings_open) — a sync command would deadlock the event loop.
  let _ = app_origin_gate(&app, &webview)?;
  windows::create_app_window(&app)?;
  Ok(serde_json::json!({ "ok": true }))
}

/// The shell page has painted — reveal the window (created hidden to avoid a
/// white flash, the OpenCodeUI mark-window-ready model).
#[tauri::command]
pub fn shell_ready(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  let win_label = windows::label_of(&webview);
  if let Some(window) = app.get_window(&win_label) {
    let _ = window.show();
    let _ = window.set_focus();
  }
  Ok(serde_json::json!({ "ok": true }))
}

/// Open DevTools for the invoking window (debug builds only; F12 from the
/// shell page — the Electron app's behavior, no auto-open).
#[tauri::command]
pub fn open_devtools(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  let win_label = app_origin_gate(&app, &webview)?;
  #[cfg(debug_assertions)]
  if let Some(window) = app.get_window(&win_label) {
    let main = window.webviews().into_iter().find(|w| w.label() == win_label);
    if let Some(main) = main {
      let _ = main.open_devtools();
    }
  }
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn view_reload(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  let win_label = app_origin_gate(&app, &webview)?;
  windows::reload_active(&app, &win_label);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn remote_disconnect() -> Result<serde_json::Value, String> {
  Ok(serde_json::json!({ "ok": true }))
}

// ---- remote node registry ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
  pub id: String,
  pub name: String,
  pub url: String,
  pub key_configured: bool,
}

#[tauri::command]
pub fn remote_list(app: AppHandle) -> Vec<InstanceView> {
  let store = app.state::<Store>();
  let secrets = app.state::<Secrets>();
  store
    .instances()
    .into_iter()
    .map(|instance| InstanceView {
      key_configured: secrets.get(&instance.id).is_some(),
      id: instance.id,
      name: instance.name,
      url: instance.url,
    })
    .collect()
}

#[tauri::command]
pub fn remote_save(app: AppHandle, input: SaveInstanceInput) -> Result<serde_json::Value, String> {
  let store = app.state::<Store>();
  let instance = store.save_instance(&input)?;
  if let Some(key) = input.key.as_deref() {
    if !key.is_empty() {
      app.state::<Secrets>().set(&instance.id, key)?;
    }
  }
  let key_configured = app.state::<Secrets>().get(&instance.id).is_some();
  Ok(serde_json::json!({
    "ok": true,
    "instance": {
      "id": instance.id,
      "name": instance.name,
      "url": instance.url,
      "keyConfigured": key_configured,
    }
  }))
}

#[tauri::command]
pub fn remote_remove(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
  let store = app.state::<Store>();
  store.remove_instance(&id);
  app.state::<Secrets>().remove(&id);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn remote_health(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
  let store = app.state::<Store>();
  let Some(instance) = store.find_instance(&id) else {
    return Ok(serde_json::json!({ "status": "offline" }));
  };
  let key = app.state::<Secrets>().get(&id);
  let Some(key) = key else {
    return Ok(serde_json::json!({ "status": "unauthorized" }));
  };
  let status = auth::check_remote_health(&instance.url, Some(&key)).await;
  Ok(serde_json::json!({ "status": status }))
}

// ---- settings dialog ----

#[tauri::command]
pub async fn settings_open(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  #[cfg(desktop)]
  {
    let win_label = app_origin_gate(&app, &webview)?;
    windows::open_settings(&app, &win_label)?;
  }
  #[cfg(not(desktop))]
  {
    let _ = (&app, &webview);
  }
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn settings_close(app: AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
  #[cfg(desktop)]
  {
    let win_label = app_origin_gate(&app, &webview)?;
    windows::close_settings(&app, &win_label);
  }
  let _ = (&app, &webview);
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn settings_current(app: AppHandle, webview: Webview) -> windows::CurrentInfo {
  let win_label = windows::label_of(&webview);
  windows::current_for(&app, &win_label)
}

#[tauri::command]
pub fn settings_get_login_item(app: AppHandle) -> bool {
  #[cfg(desktop)]
  {
    use tauri_plugin_autostart::ManagerExt;
    return app.autolaunch().is_enabled().unwrap_or(false);
  }
  #[cfg(not(desktop))]
  {
    let _ = &app;
    false
  }
}

#[tauri::command]
pub fn settings_set_login_item(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  #[cfg(desktop)]
  {
    use tauri_plugin_autostart::ManagerExt;
    let result = if enabled {
      app.autolaunch().enable()
    } else {
      app.autolaunch().disable()
    };
    result.map_err(|e| e.to_string())?;
  }
  #[cfg(not(desktop))]
  {
    let _ = (&app, enabled);
  }
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn settings_get_restore(app: AppHandle) -> bool {
  app.state::<Store>().shell_bool("restoreLastNode")
}

#[tauri::command]
pub fn settings_set_restore(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  app
    .state::<Store>()
    .shell_set("restoreLastNode", serde_json::json!(enabled));
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn settings_get_auto_local(app: AppHandle) -> bool {
  app.state::<Store>().shell_bool("autoStartLocal")
}

#[tauri::command]
pub fn settings_set_auto_local(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
  app
    .state::<Store>()
    .shell_set("autoStartLocal", serde_json::json!(enabled));
  Ok(serde_json::json!({ "ok": true }))
}

// ---- live theme sync (from the connected dsh page) ----

#[tauri::command]
pub fn theme_changed(app: AppHandle, tokens: HashMap<String, String>) -> Result<(), String> {
  *app.state::<windows::Windows>().last_theme.lock().unwrap() = Some(tokens.clone());
  let _ = app.emit("theme:sync", tokens);
  Ok(())
}
