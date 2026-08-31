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
  /// True while a node view created after the current settings view exists —
  /// the settings would sit below it until re-raised.
  pub settings_below_node: std::sync::atomic::AtomicBool,
  pub last_bounds: Mutex<Option<SavedBounds>>,
  /// The connection currently loading in this window (desktop only): the
  /// launcher reads it on startup (restore may begin before the page's
  /// listeners attach) and the node view's on_page_load completes it.
  pub connecting: Mutex<Option<ConnectingInfo>>,
}

/// A connection in flight: the launcher shows a spinner overlay until the
/// node view's first page load lands — the alternative is seconds of
/// white/black flash while the dsh page loads.
#[derive(Clone)]
pub struct ConnectingInfo {
  pub id: String,
  pub name: String,
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
    // Start hidden; the launcher calls shell_ready once it has painted, so
    // the window never flashes white (OpenCodeUI's mark-window-ready model).
    .visible(false)
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
  // macOS: keep the native traffic lights floating over our web titlebar
  // (Overlay + hiddenTitle — the standard Tauri/Electron mac look); the
  // frontend hides its own window buttons and pads for the lights. Windows
  // and Linux stay fully frameless with the web-drawn buttons.
  #[cfg(all(desktop, not(target_os = "macos")))]
  let mut builder = builder.decorations(false);
  #[cfg(all(desktop, target_os = "macos"))]
  let mut builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
  #[cfg(not(desktop))]
  let mut builder = builder;
  match &bounds {
    Some(_b) => {
      // Geometry is applied AFTER build in physical units below — the
      // builder's inner_size/position take LOGICAL px, but SavedBounds
      // stores PHYSICAL px (outer_position/outer_size), and treating
      // physical as logical scales the window up by the DPI factor on
      // every restore (window grew / wandered each launch).
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
  if let Some(b) = &bounds {
    // SavedBounds is physical — apply it physically (DPI-scale agnostic).
    let _ = window.set_size(tauri::PhysicalSize::new(b.width, b.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(b.x, b.y));
    if b.maximized {
      let _ = window.maximize();
    }
  }
  let _ = &window;

  let windows = app.state::<Windows>();
  windows.states.lock().unwrap().insert(
    label.clone(),
    WinMeta {
      win_label: label.clone(),
      slot,
      launcher_url: String::new(),
      views: Mutex::new(HashMap::new()),
      active: Mutex::new(None),
      settings_view: Mutex::new(None),
      settings_below_node: std::sync::atomic::AtomicBool::new(false),
      last_bounds: Mutex::new(None),
      connecting: Mutex::new(None),
    },
  );

  // Pre-warm the settings overlay in the background so the first open is
  // instant too (creation needs a main-thread round trip, hence async).
  #[cfg(desktop)]
  {
    let app = app.clone();
    let label = label.clone();
    tauri::async_runtime::spawn(async move {
      let _ = ensure_settings_view(&app, &label);
    });
  }
  Ok(())
}

/// Create (hidden) the settings overlay child webview for a window, cached
/// for instant show/hide afterwards. Desktop only — mobile has no child
/// webviews (the dsh page loads in the main webview).
#[cfg(desktop)]
fn ensure_settings_view(app: &AppHandle, win_label: &str) -> Result<(), String> {
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let meta = states.get(win_label).ok_or("窗口不可用")?;
    if meta.settings_view.lock().unwrap().is_some() {
      return Ok(());
    }
  }
  let window = app.get_window(win_label).ok_or("窗口不可用")?;
  let label = format!("{win_label}-settings");
  let builder = WebviewBuilder::new(label, WebviewUrl::App("settings.html".into()))
    .on_page_load(move |webview, payload| {
      if payload.event() == tauri::webview::PageLoadEvent::Finished {
        let app = webview.app_handle();
        let tokens = app.state::<Windows>().last_theme.lock().unwrap().clone();
        if let Some(tokens) = tokens {
          let _ = app.emit_to(webview.label(), "theme:sync", tokens);
        }
      }
    });
  // `transparent` does not exist on macOS (WKWebView has no transparency
  // switch) — the settings overlay's page is opaque there anyway.
  #[cfg(not(target_os = "macos"))]
  let builder = builder.transparent(true);
  // The settings overlay spans the WHOLE window — the mask dims the
  // titlebar too, so the dialog does not look stapled onto the content
  // area. settings.html pads its body by TITLEBAR_HEIGHT to keep the
  // dialog itself in the content area.
  let (width, height) = window_logical_size(app, win_label);
  let view = window
    .add_child(
      builder,
      LogicalPosition::new(0.0, 0.0),
      LogicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
  let _ = view.hide();
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    meta.settings_below_node.store(false, std::sync::atomic::Ordering::SeqCst);
    *meta.settings_view.lock().unwrap() = Some(view);
  }
  Ok(())
}

/// Re-create the settings overlay so it sits above any node webview created
/// after it (child-webview z-order follows creation order; there is no
/// re-raise API). Runs in the background after each node view is created, so
/// opening settings over a dsh page stays instant. Desktop only.
#[cfg(desktop)]
fn re_raise_settings(app: &AppHandle, win_label: &str) {
  let old = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    states
      .get(win_label)
      .and_then(|meta| meta.settings_view.lock().unwrap().take())
  };
  // Close outside the locks — it can round-trip to the main thread.
  if let Some(old) = old {
    let _ = old.close();
  }
  let _ = ensure_settings_view(app, win_label);
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
    // The settings overlay covers the whole window (mask dims the titlebar).
    let full_rect = tauri::Rect {
      position: LogicalPosition::new(0.0, 0.0).into(),
      size: LogicalSize::new(width, logical.height).into(),
    };
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    if let Some(meta) = states.get(window.label()) {
      for view in meta.views.lock().unwrap().values() {
        let _ = view.set_bounds(rect);
      }
      if let Some(view) = meta.settings_view.lock().unwrap().as_ref() {
        let _ = view.set_bounds(full_rect);
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
    // last_bounds holds the pre-maximize geometry — its `maximized` flag
    // is false, which silently DROPPED the maximized state on every save.
    // Force the flag; fall back to a sane geometry when the window was
    // maximized from the start (no normal-bounds resize ever recorded).
    meta
      .last_bounds
      .lock()
      .unwrap()
      .clone()
      .map(|b| SavedBounds { maximized: true, ..b })
      .or(Some(SavedBounds { x: 100, y: 100, width: 1440, height: 900, maximized: true }))
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
  let Some(window) = app.get_window(win_label) else { return (0.0, 0.0) };
  let Ok(size) = window.inner_size() else { return (0.0, 0.0) };
  let scale = window.scale_factor().unwrap_or(1.0);
  let logical = size.to_logical::<f64>(scale);
  (logical.width, (logical.height - TITLEBAR_HEIGHT).max(0.0))
}

/// The whole window in logical px — the settings overlay spans it all so
/// its mask dims the titlebar as well.
#[cfg(desktop)]
fn window_logical_size(app: &AppHandle, win_label: &str) -> (f64, f64) {
  let Some(window) = app.get_window(win_label) else { return (0.0, 0.0) };
  let Ok(size) = window.inner_size() else { return (0.0, 0.0) };
  let scale = window.scale_factor().unwrap_or(1.0);
  let logical = size.to_logical::<f64>(scale);
  (logical.width, logical.height)
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
    let Some(window) = app.get_window(win_label) else {

      return Err("窗口不可用".into());
    };
    // The window's main webview shares the profile cookie store with child
    // webviews, so setting the session here covers the node view's first load.
    let main = window.webviews().into_iter().find(|w| w.label() == win_label);
    if let Some(main) = main {
      main.set_cookie(cookie).map_err(|e| format!("设置会话失败：{e}"))?;
    }
  }
  let existed = view_exists(app, win_label, id);
  let view = view_for(app, win_label, id, url)?;
  let current = view.url().ok();
  let needs_nav = current.as_ref().map(|u| u.as_str() != url).unwrap_or(true);

  if existed && !needs_nav {
    // The page is already loaded in this view — switch instantly, no
    // spinner needed.
    show_view(app, win_label, id);
    let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": name }));
    return Ok(());
  }

  // A fresh load is ahead: the launcher's spinner covers it, and the
  // view's on_page_load shows the view once the dsh page has actually
  // rendered — never a white/black flash.
  begin_connecting(app, win_label, id, name);
  if needs_nav {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if let Err(e) = view.navigate(parsed) {
      fail_connecting(app, win_label, &e.to_string());
      return Err(e.to_string());
    }
  }
  // Watchdog: a hung load must not pin the spinner forever — after 15s
  // show whatever is there (dsh's own error page beats an eternal spinner).
  let app_w = app.clone();
  let label_w = win_label.to_string();
  let id_w = id.to_string();
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    finish_connecting(&app_w, &label_w, &id_w); // no-op if the load already finished
  });
  Ok(())
}

#[cfg(desktop)]
fn view_for(app: &AppHandle, win_label: &str, id: &str, url: &str) -> Result<Webview, String> {
  // Never hold the states/views locks across add_child's main-thread round
  // trip — the main thread can need them (resize relayout) and would deadlock
  // against this worker while it waits for the round trip.
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let meta = states.get(win_label).ok_or("窗口不可用")?;
    let views = meta.views.lock().unwrap();
    if let Some(view) = views.get(id) {
      return Ok(view.clone());
    }
  }
  let window = app.get_window(win_label).ok_or("窗口不可用")?;
  let label = format!("{win_label}-view-{id}");
  let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
  let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
    .initialization_script(inject::NODE_VIEW_SCRIPT);
  // The first REAL page load completes any pending connection: the view
  // stays hidden until the dsh page has rendered, so the user watches the
  // launcher's spinner instead of a blank view. about:blank fires too (the
  // pre-created local view) and must NOT complete a connection.
  let app_load = app.clone();
  let label_load = win_label.to_string();
  let id_load = id.to_string();
  let builder = builder.on_page_load(move |webview, payload| {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
      return;
    }
    let real_page = webview.url().map(|u| u.as_str() != "about:blank").unwrap_or(false);
    if real_page {
      finish_connecting(&app_load, &label_load, &id_load);
    }
  });
  let (width, height) = content_size(app, win_label);
  let view = window
    .add_child(
      builder,
      LogicalPosition::new(0.0, TITLEBAR_HEIGHT),
      LogicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
  let _ = view.hide();
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let Some(meta) = states.get(win_label) else {
      return Err("窗口不可用".into());
    };
    let mut views = meta.views.lock().unwrap();
    views.insert(id.to_string(), view.clone());
    // The new node view sits above the (older) settings overlay — mark it and
    // re-raise the settings in the background so opening it stays instant.
    meta.settings_below_node.store(true, std::sync::atomic::Ordering::SeqCst);
  }
  let app = app.clone();
  let win_label = win_label.to_string();
  tauri::async_runtime::spawn(async move {
    re_raise_settings(&app, &win_label);
  });
  Ok(view)
}

#[cfg(desktop)]
fn view_exists(app: &AppHandle, win_label: &str, id: &str) -> bool {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  states
    .get(win_label)
    .map(|meta| meta.views.lock().unwrap().contains_key(id))
    .unwrap_or(false)
}

/// Mark a connection as loading — the launcher shows the spinner overlay
/// until the node view's first page load completes it.
#[cfg(desktop)]
pub fn begin_connecting(app: &AppHandle, win_label: &str, id: &str, name: &str) {
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    if let Some(meta) = states.get(win_label) {
      *meta.connecting.lock().unwrap() = Some(ConnectingInfo { id: id.into(), name: name.into() });
    }
  }
  let _ = app.emit_to(win_label, "shell:connecting", serde_json::json!({ "name": name }));
}

/// The node view's first load landed (or the watchdog fired): show it and
/// clear the loading state. No-op when `id` is not the pending connection.
#[cfg(desktop)]
fn finish_connecting(app: &AppHandle, win_label: &str, id: &str) {
  let name = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let Some(meta) = states.get(win_label) else { return };
    let mut connecting = meta.connecting.lock().unwrap();
    match connecting.as_ref() {
      Some(c) if c.id == id => {
        let name = c.name.clone();
        *connecting = None;
        name
      }
      _ => return,
    }
  };
  show_view(app, win_label, id);
  let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": name }));
}

/// The connection failed before any page load: clear the loading state and
/// drop the launcher's spinner.
#[cfg(desktop)]
pub fn fail_connecting(app: &AppHandle, win_label: &str, error: &str) {
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    if let Some(meta) = states.get(win_label) {
      *meta.connecting.lock().unwrap() = None;
    }
  }
  let _ = app.emit_to(win_label, "shell:connect-failed", serde_json::json!({ "error": error }));
}

/// The name of the connection currently loading in this window — the
/// launcher queries it on startup (restore may begin before listeners).
pub fn connecting_name(app: &AppHandle, win_label: &str) -> Option<String> {
  #[cfg(desktop)]
  {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    return states
      .get(win_label)
      .and_then(|meta| meta.connecting.lock().unwrap().clone())
      .map(|c| c.name);
  }
  #[cfg(not(desktop))]
  {
    let _ = (app, win_label);
    None
  }
}

#[cfg(desktop)]
fn show_view(app: &AppHandle, win_label: &str, id: &str) {
  // Collect the views first, then show/hide without holding the locks (the
  // calls can round-trip to the main thread).
  let views: Vec<(String, Webview)> = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let Some(meta) = states.get(win_label) else { return };
    let views = meta.views.lock().unwrap();
    views.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
  };
  for (key, view) in views {
    if key == id {
      let _ = view.show();
    } else {
      let _ = view.hide();
    }
  }
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    *meta.active.lock().unwrap() = Some(id.to_string());
  }
}

#[cfg(desktop)]
pub fn prepare_local_view(app: &AppHandle, win_label: &str) {
  // Pre-create the local view (blank, HIDDEN) so the booted instance's
  // first navigation starts rendering sooner; it stays hidden until that
  // load lands — the launcher's spinner covers the boot instead of a
  // blank white/black page.
  let _ = view_for(app, win_label, "local", "about:blank");
}

#[cfg(desktop)]
pub fn back_to_launcher(app: &AppHandle, win_label: &str) {
  // Collect then hide outside the locks (hide can round-trip to the main
  // thread, which must not wait on a lock we hold).
  let views: Vec<Webview> = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    let Some(meta) = states.get(win_label) else {
      let _ = app.emit_to(win_label, "shell:backed", ());
      let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": "DeepSeek Harness" }));
      return;
    };
    let views = meta.views.lock().unwrap();
    views.values().cloned().collect()
  };
  for view in views {
    let _ = view.hide();
  }
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  if let Some(meta) = states.get(win_label) {
    *meta.active.lock().unwrap() = None;
  }
  let _ = app.emit_to(win_label, "shell:backed", ());
  let _ = app.emit_to(win_label, "connection:changed", serde_json::json!({ "name": "DeepSeek Harness" }));
}

#[cfg(desktop)]
pub fn open_settings(app: &AppHandle, win_label: &str) -> Result<(), String> {
  use std::sync::atomic::Ordering;
  // The cached overlay sits above the dsh page thanks to the background
  // re-raise after each connect; if a node view was created meanwhile (the
  // brief window before the re-raise finishes), re-raise now.
  let stale = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    states
      .get(win_label)
      .map(|meta| meta.settings_below_node.load(Ordering::SeqCst))
      .unwrap_or(false)
  };
  if stale || !settings_ready(app, win_label) {
    re_raise_settings(app, win_label);
  }
  let show: Option<Webview> = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    states
      .get(win_label)
      .and_then(|meta| meta.settings_view.lock().unwrap().as_ref().cloned())
  };
  if let Some(view) = show {
    let _ = view.show();
  }
  // The cached dialog read its state once at pre-warm — ask it to re-read
  // current connection + local instance whenever it becomes visible.
  let _ = app.emit_to(format!("{win_label}-settings"), "settings:refresh", ());
  Ok(())
}

fn settings_ready(app: &AppHandle, win_label: &str) -> bool {
  let windows = app.state::<Windows>();
  let states = windows.states.lock().unwrap();
  states
    .get(win_label)
    .map(|meta| meta.settings_view.lock().unwrap().is_some())
    .unwrap_or(false)
}

#[cfg(desktop)]
pub fn close_settings(app: &AppHandle, win_label: &str) {
  let hide: Option<Webview> = {
    let windows = app.state::<Windows>();
    let states = windows.states.lock().unwrap();
    states
      .get(win_label)
      .and_then(|meta| meta.settings_view.lock().unwrap().as_ref().cloned())
  };
  if let Some(view) = hide {
    let _ = view.hide();
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
