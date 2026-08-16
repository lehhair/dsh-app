//! Native bridge for mobile. Android: a small `@TauriPlugin` Kotlin class
//! (`DshNativePlugin`) that sets cookies on the app-global WebView
//! `CookieManager` (wry's own `set_cookie` is a no-op on Android) and reads
//! the real status-bar inset (WebView < 140 reports wrong env() safe-area
//! values under edge-to-edge). iOS has no native part: the shared
//! WKWebsiteDataStore accepts cookies through the standard
//! `WebviewWindow::set_cookie`.

use serde::Deserialize;
use tauri::{plugin::PluginHandle, Runtime};

pub struct DshNative<R: Runtime>(pub PluginHandle<R>);

#[derive(Deserialize)]
pub struct StatusBarHeight {
  pub height: f64,
}

#[cfg(target_os = "android")]
impl<R: Runtime> DshNative<R> {
  /// Set `name=value; …` on `origin` in the app-global WebView cookie store.
  pub fn set_cookie(&self, origin: String, cookie: String) -> Result<(), String> {
    self
      .0
      .run_mobile_plugin::<()>("setCookie", serde_json::json!({ "origin": origin, "cookie": cookie }))
      .map_err(|e| e.to_string())
  }

  /// Status-bar inset in CSS pixels.
  pub fn status_bar_height(&self) -> Result<f64, String> {
    let result: StatusBarHeight = self
      .0
      .run_mobile_plugin("getStatusBarHeight", serde_json::json!({}))
      .map_err(|e| e.to_string())?;
    Ok(result.height)
  }
}
