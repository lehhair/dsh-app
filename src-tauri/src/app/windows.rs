//! Window model, faithful to the Electron app's flat design:
//!
//! Desktop — every window is the same shell: the window's main webview is the
//! launcher page (title bar + launcher), node UIs are child webviews layered
//! below the title bar, and the settings dialog is a transparent child
//! webview re-created on open so it always sits on top. "新建窗口" opens an
//! identical peer window; connecting in a window enters THAT window.
//!
//! Mobile — a single window; connecting navigates the main webview to the
//! node URL and back (the injected back button + system back route home).

use crate::app::auth;
use crate::app::inject;
#[cfg(not(desktop))]
use crate::app::mobile;
use crate::app::service::DshService;
use crate::app::store::{SavedBounds, Store};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, WebviewBuilder};

pub const TITLEBAR_HEIGHT: f64 = 40.0;

#[derive(Default)]
pub struct Windows {
  pub states: Mutex<HashMap<String, WinMeta>>,
  pub last_theme: Mutex<Option<HashMap<String, String>>>,
}

pub struct WinMeta {
  pub win_label: String,
  pub slot: u32,
  /// URL of the shell page (app origin), for the launcher-origin gate and mobile back-nav.
  pub launcher_url: String,
  /// node id -> child webview (desktop only)
  pub views: Mutex<HashMap<String, Webview>>,
  pub active: Mutex<Option<String>>,
  pub settings_view: Mutex<Option<Webview>>,
  pub last_bounds: Mutex<Option<SavedBounds>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentInfo {
  #[serde(rename = "type")]
  pub kind: Option<String>,
  pub name: Option<String>,
  pub url: Option<String>,
  pub id: Option<String>,
}

// ---- window lifecycle ----

pub fn create_app_window(app: &AppHandle) -> Result<(), String> {
  let windows = app.state::<Windows>();
  let used: HashSet<u32> = windows.states.lock().unwrap().values().map(|m| m.slot).collect();
  let mut slot = 1u32;
  while used.contains(&slot) {
    slot += 1;
  }
  let label = if slot == 1 { "main".to_string() } else { format!("win-{slot}") };

  let saved = app.state::<Store>().win_state(slot);
  let bounds = validate_bounds(app, saved);

  let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
    .title("DeepSeek Harness")
    .resizable(true)
    .min_inner_size(800.0, 560.0)
    // The node-view init script (back button + theme sampler) also covers the
    // main webview on mobile, where dsh loads in this very webview. It is
    // inert on the launcher page (isDshPage gate) and on desktop node views
    // get their own copy via view_for.
    .initialization_script(inject::NODE_VIEW_SCRIPT)
    .on_page_load({
      let win_label = label.clone();
      move |webview, payload| {
        // Capture the shell origin from the first real page load — right
        // after build the webview is still on about:blank, so `window.url()`
        // is useless there. First load wins; remote node pages never
        // overwrite it (the guard only fills an empty slot).
        let url = payload.url().to_string();
        if url.starts_with("about:") || url.starts_with("data:") || url.starts_with("chrome-error:") {
          return;
        }
        let app = webview.app_handle();
        let windows = app.state::<Windows>();
        let mut states = windows.states.lock().unwrap();
        if let Some(meta) = states.get_mut(&win_label) {
          if meta.launcher_url.is_empty() {
            meta.launcher_url = url;
          }
        }
      }
    });
  #[cfg(desktop)]
  let mut builder = builder.decorations(false);
  #[cfg(not(desktop))]
  let mut builder = builder;
  match &bounds {
    Some(b) => {
      builder = builder.inner_size(b.width as f64, b.height as f64).position(b.x as f64, b.y as f64);
    }
    None => {
      #[cfg(desktop)]
      {
        builder = builder.inner_size(1440.0, 900.0).center();
      }
      #[cfg(not(desktop))]
      {
        builder = builder.inner_size(1440.0, 900.0);
      }
    }
  }
  let window = builder.build().map_err(|e| e.to_string())?;
  #[cfg(desktop)]
  if bounds.as_ref().map(|b| b.maximized).unwrap_or(false) {
    let _ = window.maximize();
  }
  let _ = &window;

  let windows = app.state::<Windows>();
  windows.states.lock().unwrap().insert(
    label.clone(),
    WinMeta {
      win_label: label,
      slot,
      launcher_url: String::new(),
      views: Mutex::new(HashMap::new()),
      active: Mutex::new(None),
      settings_view: Mutex::new(None),
      last_bounds: Mutex::new(None),
    },
  );
  Ok(())
}

fn validate_bounds(app: &AppHandle, saved: Option<SavedBounds>) -> Option<SavedBounds> {
  let saved = saved?;
  if saved.width < 400 || saved.height < 300 {
    return None;
  }
  let monitors = app.available_monitors().ok()?;
  let on_screen = monitors.iter().any(|monitor| {
    let pos = monitor.position();
    let size = monitor.size();
    let (ax, ay) = (pos.x, pos.y);
    let (aw, ah) = (size.width as i32, size.height as i32);
    let overlap_w = (saved.x + saved.width as i32).min(ax + aw) - saved.x.max(ax);
    let overlap_h = (saved.y + saved.height as i32).min(ay + ah) - saved.y.max(ay);
    overlap_w >= 80 && overlap_h >= 40
  });
  if !on_screen {
    return None;
  }
  Some(SavedBounds {
    width: saved.width.max(800),
    height: saved.height.max(560),
    ..saved
  })
}

pub fn relayout(window: &tauri::Window) {
  let app = window.app_handle();
  #[cfg(desktop)]
  {
    let Ok(inner) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = inner.to_logical::<f64>(scale);
    let width = logical.width;
    let height = (logical.height - TITLEBAR_HEIGHT).max(0.0);
    let rect = tauri::Rect {
      position: LogicalPosition::new(0.0, TITLEBAR_HEIGHT).into(),
      size: LogicalSize::new(width, height).into(),
    };
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    if let Some(meta) = states.get(window.label()) {
      for view in meta.views.lock().unwrap().values() {
        let _ = view.set_bounds(rect.clone());
      }
      if let Some(view) = meta.settings_view.lock().unwrap().as_ref() {
        let _ = view.set_bounds(rect);
      }
    }
  }
  // Track the normal bounds (not while maximized) for close-time persistence.
  if !window.is_maximized().unwrap_or(false) {
    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
      if size.width >= 400 && size.height >= 300 {
        let bounds = SavedBounds {
          x: pos.x,
          y: pos.y,
          width: size.width,
          height: size.height,
          maximized: false,
        };
        let windows = app.state::<Windows>();
        let states = windows.states.lock().unwrap();
        if let Some(meta) = states.get(window.label()) {
          *meta.last_bounds.lock().unwrap() = Some(bounds);
        }
      }
    }
  }
}

pub fn save_window_state(window: &tauri::Window) {
  let app = window.app_handle();
  let store = app.state::<Store>();
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  let Some(meta) = states.get(window.label()) else { return };
  let maximized = window.is_maximized().unwrap_or(false);
  let bounds = if maximized {
    meta.last_bounds.lock().unwrap().clone()
  } else if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
    if size.width >= 400 && size.height >= 300 {
      Some(SavedBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: false,
      })
    } else {
      meta.last_bounds.lock().unwrap().clone()
    }
  } else {
    meta.last_bounds.lock().unwrap().clone()
  };
  if let Some(bounds) = bounds {
    store.save_win_state(meta.slot, &bounds);
  }
}

pub fn on_window_destroyed(window: &tauri::Window) {
  save_window_state(window);
  let windows = window.app_handle().state::<Windows>();
  windows
    .states
    .lock()
    .unwrap()
    .remove(window.label());
}

// ---- launcher-origin gate ----

/// The invoking webview must be on the shell origin (launcher or settings
/// page); remote dsh pages get rejected. Returns the window label.
pub fn require_launcher(app: &AppHandle, webview: &Webview) -> Result<String, String> {
  let win_label = webview.window().label().to_string();
  let windows = app.state::<Windows>();
  let launcher = windows
    .states
    .lock()
    .unwrap()
    .get(&win_label)
    .map(|m| m.launcher_url.clone());
  // Fallback when `url()` is temporarily unavailable (e.g. mid-navigation):
  // a webview whose label equals its window label can only be the shell page
  // (the launcher or the settings overlay) — both live on the app origin.
  let Ok(url) = webview.url() else {
    if webview.label() == win_label {
      return Ok(win_label);
    }
    return Err("窗口不可用".into());
  };
  if let Some(launcher) = launcher {
    if same_origin(url.as_str(), &launcher) {
      return Ok(win_label);
    }
  }
  Err("仅启动页可执行此操作".into())
}

fn same_origin(a: &str, b: &str) -> bool {
  match (url::Url::parse(a), url::Url::parse(b)) {
    (Ok(x), Ok(y)) => x.origin() == y.origin(),
    _ => false,
  }
}

/// Window label for the webview that invoked a command (node view, settings view, or shell).
pub fn label_of(webview: &Webview) -> String {
  webview.window().label().to_string()
}

pub fn current_for(app: &AppHandle, win_label: &str) -> CurrentInfo {
  let windows = app.state::<Windows>();
  let active = windows
    .states
    .lock()
    .unwrap()
    .get(win_label)
    .and_then(|m| m.active.lock().unwrap().clone());
  match active.as_deref() {
    Some("local") => {
      let service = app.state::<DshService>();
      let url = service.running.lock().unwrap().as_ref().map(|r| r.url.clone());
      CurrentInfo {
        kind: Some("local".into()),
        name: Some("本机实例".into()),
        url,
        id: None,
      }
    }
    Some(id) => match app.state::<Store>().find_instance(id) {
      Some(instance) => CurrentInfo {
        kind: Some("remote".into()),
        name: Some(instance.name),
        url: Some(instance.url),
        id: Some(instance.id),
      },
      None => CurrentInfo { kind: None, name: None, url: None, id: None },
    },
    None => CurrentInfo { kind: None, name: None, url: None, id: None },
  }
}

pub async fn reconnect_local_windows(app: &AppHandle, url: &str) {
  let labels: Vec<String> = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    states
      .iter()
      .filter(|(_, meta)| meta.active.lock().unwrap().as_deref() == Some("local"))
      .map(|(label, _)| label.clone())
      .collect()
  };
  for label in labels {
    let _ = connect_into_window(app, &label, "local", url, "DeepSeek Harness", None).await;
  }
}

fn content_size(app: &AppHandle, win_label: &str) -> (f64, f64) {
  let Some(window) = app.get_webview_window(win_label) else { return (0.0, 0.0) };
  let Ok(size) = window.inner_size() else { return (0.0, 0.0) };
  let scale = window.scale_factor().unwrap_or(1.0);
  let logical = size.to_logical::<f64>(scale);
  (logical.width, (logical.height - TITLEBAR_HEIGHT).max(0.0))
}

// ================= desktop (child-webview model) =================

#[cfg(desktop)]
pub async fn connect_into_window(
  app: &AppHandle,
  win_label: &str,
  id: &str,
  url: &str,
  name: &str,
  key: Option<&str>,
) -> Result<(), String> {
  if let Some(key) = key {
    let value = auth::ensure_gateway_session(url, key).await?;
    let cookie = auth::build_cookie(url, &value)?;
    let Some(window) = app.get_webview_window(win_label) else {
      return Err("窗口不可用".into());
    };
    // The window's main webview shares the profile cookie store with child
    // webviews, so setting the session here covers the node view's first load.
    let main = window
      .as_ref()
      .window()
      .webviews()
      .into_iter()
      .find(|w| w.label() == win_label);
    if let Some(main) = main {
      main.set_cookie(cookie).map_err(|e| format!("设置会话失败：{e}"))?;
    }
  }
  let view = view_for(app, win_label, id, url)?;
  show_view(app, win_label, id);
  let current = view.url().ok();
  if current.as_ref().map(|u| u.as_str() != url).unwrap_or(true) {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    view.navigate(parsed).map_err(|e| e.to_string())?;
  }
  let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": name }));
  Ok(())
}

#[cfg(desktop)]
fn view_for(app: &AppHandle, win_label: &str, id: &str, url: &str) -> Result<Webview, String> {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  let meta = states.get(win_label).ok_or("窗口不可用")?;
  let mut views = meta.views.lock().unwrap();
  if let Some(view) = views.get(id) {
    return Ok(view.clone());
  }
  let window = app.get_webview_window(win_label).ok_or("窗口不可用")?;
  let label = format!("{win_label}-view-{id}");
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
    .initialization_script(inject::NODE_VIEW_SCRIPT);
  let (width, height) = content_size(app, win_label);
  let view = window
    .as_ref()
    .window()
    .add_child(
      builder,
      LogicalPosition::new(0.0, TITLEBAR_HEIGHT),
      LogicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
  let _ = view.hide();
  views.insert(id.to_string(), view.clone());
  Ok(view)
}

#[cfg(desktop)]
fn show_view(app: &AppHandle, win_label: &str, id: &str) {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    let views = meta.views.lock().unwrap();
    for (key, view) in views.iter() {
      if key == id {
        let _ = view.show();
      } else {
        let _ = view.hide();
      }
    }
    *meta.active.lock().unwrap() = Some(id.to_string());
  }
}

#[cfg(desktop)]
pub fn show_local_view(app: &AppHandle, win_label: &str) {
  // Pre-create the local view (blank) so restoring the local instance never
  // sits on the launcher while dsh boots.
  if let Ok(_view) = view_for(app, win_label, "local", "about:blank") {
    show_view(app, win_label, "local");
  }
}

#[cfg(desktop)]
pub fn back_to_launcher(app: &AppHandle, win_label: &str) {
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    if let Some(meta) = states.get(win_label) {
      let views = meta.views.lock().unwrap();
      for view in views.values() {
        let _ = view.hide();
      }
      *meta.active.lock().unwrap() = None;
    }
  }
  let _ = app.emit_to(win_label, "shell:backed", ());
  let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": "DeepSeek Harness" }));
}

#[cfg(desktop)]
pub fn open_settings(app: &AppHandle, win_label: &str) -> Result<(), String> {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  let meta = states.get(win_label).ok_or("窗口不可用")?;
  let mut slot = meta.settings_view.lock().unwrap();
  // Re-create so the settings view always sits on top of any node views.
  if let Some(view) = slot.take() {
    let _ = view.close();
  }
  drop(slot);
  drop(states);
  let window = app.get_webview_window(win_label).ok_or("窗口不可用")?;
  let label = format!("{win_label}-settings");
  let builder = WebviewBuilder::new(label, WebviewUrl::App("settings.html".into()))
    .transparent(true)
    .on_page_load(move |webview, payload| {
      if payload.event() == tauri::webview::PageLoadEvent::Finished {
        let app = webview.app_handle();
        let tokens = app.state::<Windows>().last_theme.lock().unwrap().clone();
        if let Some(tokens) = tokens {
          let _ = app.emit_to(webview.label(), "theme:sync", tokens);
        }
      }
    });
  let (width, height) = content_size(app, win_label);
  let view = window
    .as_ref()
    .window()
    .add_child(
      builder,
      LogicalPosition::new(0.0, TITLEBAR_HEIGHT),
      LogicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    *meta.settings_view.lock().unwrap() = Some(view);
  }
  Ok(())
}

#[cfg(desktop)]
pub fn close_settings(app: &AppHandle, win_label: &str) {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    if let Some(view) = meta.settings_view.lock().unwrap().as_ref() {
      let _ = view.hide();
    }
  }
}

#[cfg(desktop)]
pub fn reload_active(app: &AppHandle, win_label: &str) {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    let active = meta.active.lock().unwrap().clone();
    if let Some(id) = active {
      if let Some(view) = meta.views.lock().unwrap().get(&id) {
        let _ = view.reload();
      }
    }
  }
}

// ================= mobile (navigate-the-main-webview model) =================

#[cfg(not(desktop))]
pub async fn connect_into_window(
  app: &AppHandle,
  win_label: &str,
  id: &str,
  url: &str,
  name: &str,
  key: Option<&str>,
) -> Result<(), String> {
  if let Some(key) = key {
    let value = auth::ensure_gateway_session(url, key).await?;
    let cookie = auth::build_cookie(url, &value)?;
    set_mobile_cookie(app, url, &cookie)?;
  }
  let Some(window) = app.get_webview_window(win_label) else {
    return Err("窗口不可用".into());
  };
  let current = window.url().ok();
  if current.as_ref().map(|u| u.as_str() != url).unwrap_or(true) {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    window.navigate(parsed).map_err(|e| e.to_string())?;
  }
  let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": name }));
  let _ = id;
  Ok(())
}

#[cfg(target_os = "android")]
fn set_mobile_cookie(app: &AppHandle, origin: &str, cookie: &cookie::Cookie<'static>) -> Result<(), String> {
  let cookie_string = cookie.to_string();
  let plugin = app.state::<mobile::DshNative<tauri::Wry>>();
  plugin
    .set_cookie(origin.to_string(), cookie_string)
    .map_err(|e| format!("设置会话失败：{e}"))
}

#[cfg(target_os = "ios")]
fn set_mobile_cookie(app: &AppHandle, origin: &str, cookie: &cookie::Cookie<'static>) -> Result<(), String> {
  let Some(window) = app.get_webview_window("main") else {
    return Err("窗口不可用".into());
  };
  window.set_cookie(cookie.clone()).map_err(|e| format!("设置会话失败：{e}"))
}

#[cfg(not(desktop))]
pub fn reload_active(app: &AppHandle, win_label: &str) {
  if let Some(window) = app.get_webview_window(win_label) {
    let _ = window.reload();
  }
}

#[cfg(not(desktop))]
pub fn back_to_launcher(app: &AppHandle, win_label: &str) {
  let launcher_url = app
    .state::<Windows>()
    .states
    .lock()
    .unwrap()
    .get(win_label)
    .map(|m| m.launcher_url.clone());
  if let Some(launcher) = launcher_url {
    if let Ok(parsed) = url::Url::parse(&launcher) {
      if let Some(window) = app.get_webview_window(win_label) {
        let _ = window.navigate(parsed);
      }
    }
  }
}
