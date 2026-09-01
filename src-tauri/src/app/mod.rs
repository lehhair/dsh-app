//! Application assembly: plugin registration, state management, window
//! events, and the desktop/mobile startup flows.

pub mod auth;
pub mod commands;
pub mod inject;
pub mod mobile;
pub mod paths;
pub mod registry;
pub mod secrets;
pub mod service;
pub mod store;
pub mod update;
pub mod windows;

use service::DshService;
use store::Store;
use tauri::Manager;
use windows::Windows;

/// Process start time, for the launch-duration log line in `shell_ready`.
pub fn launch_start() -> &'static std::time::Instant {
  static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
  START.get_or_init(std::time::Instant::now)
}

pub fn run() {
  let _ = launch_start(); // start the clock before anything else
  let builder = tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::new()
        // Without this every log::info!/error! in the app is a silent no-op.
        // Logdir gives users a file to attach when reporting boot failures.
        .level(log::LevelFilter::Info)
        .targets([
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
          tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("dsh-app".into()),
          }),
        ])
        .build(),
    )
    .plugin(tauri_plugin_opener::init())
    .manage(Windows::default())
    .manage(DshService::default());

  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    None,
  ));

  // Single instance: double-clicking the desktop icon (or launching again
  // from anywhere) must NOT spawn a second process — each process would boot
  // its own local dsh backend. The second launch is forwarded here, into the
  // first process, which opens a peer window exactly like the title-bar
  // 新建窗口 button (same backend, same shell).
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    if let Err(e) = windows::create_app_window(app) {
      log::error!("[single-instance] new window failed: {e}");
    }
  }));

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
      commands::dsh_diagnose,
      commands::dsh_check_update,
      commands::dsh_update,
      commands::dsh_update_cancel,
      commands::dsh_install,
      commands::check_launcher_update,
      commands::launcher_update,
      commands::shell_connect,
      commands::remote_connect,
      commands::shell_back,
      commands::shell_new_window,
      commands::shell_ready,
      commands::open_devtools,
      commands::view_reload,
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
      commands::registry_get,
      commands::registry_set,
      commands::theme_changed,
      commands::settings_get_close_behavior,
      commands::settings_set_close_behavior,
      commands::settings_reset_close_behavior,
      commands::window_close_confirm,
      commands::window_close_to_tray,
      commands::window_close_cancel,
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
        cleanup_stale_updater_files();
        run_startup_flows(app.handle());
      }
      Ok(())
    })
    .on_window_event(|window, event| match event {
      tauri::WindowEvent::CloseRequested { api, .. } => {
        // Desktop: intercept according to the configured close action (ask /
        // direct / tray). Mobile keeps the plain close. `api` is consumed by
        // on_close_requested on desktop — it must be the last use of the
        // borrow, so mobile's fallthrough lives in the cfg branch shape below.
        #[cfg(desktop)]
        {
          windows::on_close_requested(window, api);
        }
        #[cfg(not(desktop))]
        {
          let _ = api;
          windows::save_window_state(window);
        }
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

/// Delete self-update leftovers next to the exe (`dsh-app.exe.new`,
/// `dsh-app-update.cmd`) — a failed or interrupted update would otherwise
/// leave them forever.
#[cfg(desktop)]
fn cleanup_stale_updater_files() {
  #[cfg(windows)]
  {
    if let Ok(exe) = std::env::current_exe() {
      if let Some(dir) = exe.parent() {
        for stale in ["dsh-app.exe.new", "dsh-app-update.cmd"] {
          if std::fs::remove_file(dir.join(stale)).is_ok() {
            log::info!("[update] removed stale updater file: {stale}");
          }
        }
      }
    }
  }
}

/// Kill embedded dsh node processes from earlier shell sessions (see the
/// call site in `setup`). Runs synchronously before any fresh start: a
/// background sweep could race the boot's own spawn and kill the new node
/// (it matches the same command-line marker).
///
/// Fast path: a `tasklist` probe (milliseconds) checks whether any node.exe
/// is running at all — the PowerShell process sweep (cold start ~1-3 s) only
/// runs when there is something to sweep. Clean startups never touch
/// PowerShell, which is what makes app launch feel instant.
#[cfg(desktop)]
fn cleanup_stale_embedded() {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let probe = std::process::Command::new("tasklist")
      .args(["/FI", "IMAGENAME eq node.exe", "/NH"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::piped())
      .stderr(std::process::Stdio::null())
      .output();
    let any_node = matches!(probe, Ok(out) if String::from_utf8_lossy(&out.stdout).contains("node.exe"));
    if !any_node {
      return;
    }
    // The embedded overlay marker is unique to this app's dsh spawns.
    let script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*embedded-overlay.yml*' } | ForEach-Object { $_.ProcessId }";
    let output = std::process::Command::new("powershell")
      .args(["-NoProfile", "-NonInteractive", "-Command", script])
      .creation_flags(CREATE_NO_WINDOW)
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
              .creation_flags(CREATE_NO_WINDOW)
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
    // Only kill node processes whose command line carries the overlay — a
    // bare `-f embedded-overlay.yml` would also match an editor with the
    // file open or a grep running against it.
    let _ = std::process::Command::new("pkill")
      .args(["-9", "-f", "node.*embedded-overlay\\.yml"])
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn();
  }
}

/// Boot dsh and connect, with the launcher's spinner covering the boot and
/// the first page load (never a blank view).
#[cfg(desktop)]
async fn enter_local(app: &tauri::AppHandle, win_label: &str) {
  windows::begin_connecting(app, win_label, "local", "DeepSeek Harness");
  windows::prepare_local_view(app, win_label);
  let service = app.state::<DshService>();
  match service::start_local(app, &service).await {
    Ok(info) => {
      if let Some(url) = info.url {
        let _ = windows::connect_into_window(app, win_label, "local", &url, "DeepSeek Harness", None).await;
      } else {
        windows::fail_connecting(app, win_label, "本机实例未就绪");
      }
    }
    Err(error) => {
      log::error!("[local] start failed: {error}");
      windows::fail_connecting(app, win_label, &error);
      windows::back_to_launcher(app, win_label);
    }
  }
}
