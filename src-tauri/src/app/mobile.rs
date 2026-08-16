//! Native bridge for mobile. Android: a small `@TauriPlugin` Kotlin class
//! (`DshNativePlugin`) that sets cookies on the app-global WebView
//! `CookieManager` — wry's own `set_cookie` is a no-op on Android. iOS has no
//! native part: the shared WKWebsiteDataStore accepts cookies through the
//! standard `WebviewWindow::set_cookie`.

use tauri::{plugin::PluginHandle, Runtime};

pub struct DshNative<R: Runtime>(pub PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> DshNative<R> {
  /// Set `name=value; …` on `origin` in the app-global WebView cookie store.
  pub fn set_cookie(&self, origin: String, cookie: String) -> Result<(), tauri::Error> {
    self.0.run_mobile_plugin(
      "setCookie",
      serde_json::json!({ "origin": origin, "cookie": cookie }),
    )
  }
}