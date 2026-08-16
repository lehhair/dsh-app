//! Application assembly: plugin registration, state management, window
//! events, and the desktop/mobile startup flows.

pub mod auth;
pub mod commands;
pub mod inject;
pub mod mobile;
pub mod paths;
pub mod secrets;
pub mod service;
pub mod store;
pub mod update;
pub mod windows;

use service::DshService;
use store::Store;
use tauri::Manager;
use windows::Windows;

pub fn run() {
  let builder = tauri::Builder::default()
    .manage(Windows::default())
    .manage(DshService::default());

  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    None,
  ));

  #[cfg(mobile)]
  let builder = builder.plugin(
    tauri::plugin::Builder::new("dsh-native")
      .setup(|app: &tauri::AppHandle, api: tauri::plugin::PluginApi<tauri::Wry, ()>| {
        #[cfg(target_os = "android")]
        {
          let handle = api.register_android_plugin("com.dshapp.app", "DshNativePlugin")?;
          app.manage(mobile::DshNative::<tauri::Wry>(handle));
        }
        Ok(())
      })
      .build(),
  );

  let builder = builder
    .invoke_handler(tauri::generate_handler![
      commands::app_info,
      commands::status_bar_height,
      commands::status_bar_appearance,
      commands::local_start,
      commands::local_stop,
      commands::local_status,
      commands::local_logs,
      commands::dsh_version,
      commands::dsh_check_update,
      commands::dsh_update,
      commands::check_launcher_update,
      commands::launcher_update,
      commands::shell_connect,
      commands::remote_connect,
      commands::shell_back,
      commands::shell_new_window,
      commands::shell_ready,
      commands::open_devtools,
      commands::view_reload,
      commands::remote_disconnect,
      commands::remote_list,
      commands::remote_save,
      commands::remote_remove,
      commands::remote_health,
      commands::settings_open,
      commands::settings_close,
      commands::settings_current,
      commands::settings_get_login_item,
      commands::settings_set_login_item,
      commands::settings_get_restore,
      commands::settings_set_restore,
      commands::settings_get_auto_local,
      commands::settings_set_auto_local,
      commands::theme_changed,
    ])
    .setup(|app| {
      let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
      std::fs::create_dir_all(&config_dir).ok();
      app.manage(Store::new(config_dir.clone()));
      #[cfg(desktop)]
      app.manage(secrets::Secrets::new());
      #[cfg(not(desktop))]
      app.manage(secrets::Secrets::new(config_dir));

      windows::create_app_window(app.handle())?;

      #[cfg(desktop)]
      {
        // Kill embedded dsh nodes orphaned by a crashed / force-killed shell
        // session (kill-on-exit cannot run then). The command line carries
        // the embedded overlay marker, so unrelated node processes (dev
        // servers, the harness itself) are untouched. Without this, every
        // crash leaks an instance that keeps running — the accumulating load
        // and port pressure eventually trip the 90s boot health timeout.
        cleanup_stale_embedded();
        run_startup_flows(app.handle());
      }
      Ok(())
    })
    .on_window_event(|window, event| match event {
      tauri::WindowEvent::CloseRequested { .. } => {
        windows::save_window_state(window);
      }
      tauri::WindowEvent::Destroyed => {
        windows::on_window_destroyed(window);
      }
      tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
        windows::relayout(window);
      }
      _ => {}
    });

  let app = builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let tauri::RunEvent::Exit = event {
      if let Some(service) = app_handle.try_state::<DshService>() {
        service::stop_local(&service);
      }
    }
  });
}

/// Launch behavior: `DSH_AUTOSTART=1` (external autostart), else the shell's
/// autoStartLocal / restoreLastNode settings. Desktop only — mobile has no
/// embedded instance and no auto-launch.
#[cfg(desktop)]
fn run_startup_flows(app: &tauri::AppHandle) {
  if std::env::var("DSH_AUTOSTART").as_deref() == Ok("1") {
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        if let Ok(url) = std::env::var("DSH_REMOTE_URL") {
          let key = std::env::var("DSH_REMOTE_KEY").unwrap_or_default();
          let name = url::Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| "dsh".into());
          let key = if key.is_empty() { None } else { Some(key.as_str()) };
          let _ = windows::connect_into_window(&app, "main", "adhoc", &url, &name, key).await;
        } else {
          enter_local(&app, "main").await;
        }
      });
      return;
    }

    let store = app.state::<Store>();
    let last = store.shell_get("lastNode");
    let restore_kind = last
      .as_ref()
      .and_then(|v| v.get("type"))
      .and_then(|t| t.as_str())
      .map(str::to_string);
    // When the restore target is the local instance, enter_local boots and
    // connects it — auto-starting here too would spawn a second node (the
    // start_local mutex serializes them, but the extra boot is wasted).
    if store.shell_bool("autoStartLocal") && restore_kind.as_deref() != Some("local") {
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        let service = app.state::<DshService>();
        let _ = service::start_local(&app, &service).await;
      });
    }

    if store.shell_bool("restoreLastNode") {
      match restore_kind.as_deref() {
        Some("remote") => {
          let id = last
            .as_ref()
            .and_then(|v| v.get("id"))
            .and_then(|i| i.as_str())
            .map(str::to_string);
          if let Some(id) = id {
            if let Some(instance) = store.find_instance(&id) {
              let key = app.state::<secrets::Secrets>().get(&id);
              if let Some(key) = key {
                let app = app.clone();
                let url = instance.url.clone();
                let name = instance.name.clone();
                tauri::async_runtime::spawn(async move {
                  let _ =
                    windows::connect_into_window(&app, "main", &instance.id, &url, &name, Some(&key)).await;
                });
              }
            }
          }
        }
        Some("local") => {
          let app = app.clone();
          tauri::async_runtime::spawn(async move {
            enter_local(&app, "main").await;
          });
        }
        _ => {}
      }
    }
  }

/// Kill embedded dsh node processes from earlier shell sessions (see the
/// call site in `setup`). Runs synchronously before any fresh start: a
/// background sweep could race the boot's own spawn and kill the new node
/// (it matches the same command-line marker).
#[cfg(desktop)]
fn cleanup_stale_embedded() {
  #[cfg(windows)]
  {
    // The embedded overlay marker is unique to this app's dsh spawns.
    let script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*embedded-overlay.yml*' } | ForEach-Object { $_.ProcessId }";
    let output = std::process::Command::new("powershell")
      .args(["-NoProfile", "-NonInteractive", "-Command", script])
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::null())
      .output();
    if let Ok(output) = output {
      let Ok(text) = String::from_utf8(output.stdout) else { return };
      for line in text.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
          if pid > 0 {
            let _ = std::process::Command::new("taskkill")
              .args(["/PID", &pid.to_string(), "/T", "/F"])
              .stdin(std::process::Stdio::null())
              .stdout(std::process::Stdio::null())
              .stderr(std::process::Stdio::null())
              .spawn();
          }
        }
      }
    }
  }
  #[cfg(not(windows))]
  {
    let _ = std::process::Command::new("pkill")
      .args(["-9", "-f", "embedded-overlay.yml"])
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
}

/// Show the local view immediately (dark loading ground), boot dsh, connect.
#[cfg(desktop)]
async fn enter_local(app: &tauri::AppHandle, win_label: &str) {
  windows::show_local_view(app, win_label);
  let service = app.state::<DshService>();
  match service::start_local(app, &service).await {
    Ok(info) => {
      if let Some(url) = info.url {
        let _ = windows::connect_into_window(app, win_label, "local", &url, "DeepSeek Harness", None).await;
      }
    }
    Err(error) => {
      log::error!("[local] start failed: {error}");
      windows::back_to_launcher(app, win_label);
    }
  }
}
