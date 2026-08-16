fn main() {
  // Generate `allow-<command>`/`deny-<command>` permissions for the app's
  // own commands so capabilities can grant them (required for remote dsh
  // webviews, which must pass the ACL, unlike local app pages).
  let manifest = tauri_build::AppManifest::new().commands(&[
    "app_info",
    "status_bar_height",
    "status_bar_appearance",
    "local_start",
    "local_stop",
    "local_status",
    "local_logs",
    "dsh_version",
    "dsh_check_update",
    "dsh_update",
    "dsh_install",
    "check_launcher_update",
    "launcher_update",
    "shell_connect",
    "remote_connect",
    "shell_back",
    "shell_new_window",
    "shell_ready",
    "open_devtools",
    "view_reload",
    "remote_disconnect",
    "remote_list",
    "remote_save",
    "remote_remove",
    "remote_health",
    "settings_open",
    "settings_close",
    "settings_current",
    "settings_get_login_item",
    "settings_set_login_item",
    "settings_get_restore",
    "settings_set_restore",
    "settings_get_auto_local",
    "settings_set_auto_local",
    "theme_changed",
  ]);
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    .expect("failed to run tauri-build");
}
