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
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
  AppInfo {
    desktop: cfg!(desktop),
    version: app.package_info().version.to_string(),
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

// ---- embedded local instance ----

#[tauri::command]
pub async fn local_start(app: AppHandle, state: State<'_, DshService>) -> Result<service::LocalInfo, String> {
  service::start_local(&app, &state).await
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
