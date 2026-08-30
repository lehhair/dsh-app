//! Runtime paths for the embedded dsh runtime and bundled tooling.
//!
//! Resolution order per artifact: bundled resource dir first (installed
//! app: `<exe>/resources/…`), then the dev project root (`src-tauri/..`),
//! then environment fallbacks. Dev never needs a copy step — the project
//! root already holds `.dsh-runtime/` and `node_modules/npm`.
//!
//! The dsh runtime itself resolves: bundled resources → dev project root →
//! `DSH_RUNTIME` env → the user's global npm install (`npm root -g`, the
//! external flavor). `Paths::bundled` reports whether the runtime is
//! launcher-owned (bundled or dev) and therefore updatable in place.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct Paths {
  /// Official Node executable (bundled `resources/node.exe`, `DSH_NODE`, or `node` on PATH).
  pub node_exe: PathBuf,
  /// `@deepseek-ai/dsh` CLI entry (`lib/bin.js`).
  pub dsh_bin: PathBuf,
  /// `@deepseek-ai/dsh` package.json (for the installed version).
  pub dsh_pkg: PathBuf,
  /// npm project dir owning the dsh runtime (bundled/dev/DSH_RUNTIME), or
  /// the global node_modules dir (external flavor).
  pub dsh_runtime: PathBuf,
  /// Bundled npm CLI (`node_modules/npm/bin/npm-cli.js`).
  pub npm_cli: PathBuf,
  /// Overlay that disables the remote-gateway plugin for the embedded instance.
  pub overlay: PathBuf,
  /// The dsh runtime is launcher-managed (bundled resources or the dev
  /// project fallback) — the shell may update it in place. False for the
  /// external flavor, where the user's own npm owns the runtime.
  pub bundled: bool,
}

impl Paths {
  pub fn resolve(app: &AppHandle) -> Self {
    let res = app.path().resource_dir().unwrap_or_default();
    let proj = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let user = app.path().app_data_dir().unwrap_or_else(|_| res.clone());

    // Bundled Node binary name: node.exe on Windows, node elsewhere.
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node_exe = {
      let in_res = res.join("resources").join(node_name);
      if in_res.exists() {
        in_res
      } else {
        let in_proj = proj.join("resources").join(node_name);
        if in_proj.exists() {
          in_proj
        } else {
          std::env::var("DSH_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("node"))
        }
      }
    };

    let npm_cli = {
      let in_res = res.join("resources").join("node_modules").join("npm").join("bin").join("npm-cli.js");
      if in_res.exists() {
        in_res
      } else {
        let in_proj = proj.join("node_modules").join("npm").join("bin").join("npm-cli.js");
        if in_proj.exists() {
          in_proj
        } else {
          in_res
        }
      }
    };

    let ships_node = res.join("resources").join(node_name).exists()
      || res.join("resources").join("node_modules/npm/bin/npm-cli.js").exists();
    let (runtime_root, managed_runtime) = resolve_runtime(&res, &proj, &user, ships_node);

    // The shell "manages" dsh when a launcher-owned runtime exists (bundled /
    // user-data / dev project), OR this install ships node + npm (bundled
    // flavor) and can install/manage one on demand — even before any runtime
    // is installed, so the UI offers 安装 dsh instead of the external message.
    let bundled = managed_runtime || ships_node;

    // The embedded-run overlay is materialized from the CURRENT exe's compiled
    // copy into the user-data dir, NOT read from the install-time resources:
    // launcher self-update replaces only the exe, so a resources file would
    // stay stale forever. Re-write whenever the content differs (e.g. after
    // an update changed it).
    let overlay = materialize_overlay(&user);

    // The dsh package lives under `node_modules` of the runtime root — EXCEPT
    // for the external flavor, where `global_npm_root()` already IS the global
    // `node_modules` dir. Joining `node_modules` again yields a path that can
    // never exist (`...\npm\node_modules\node_modules\@deepseek-ai\dsh\...`),
    // which made the external flavor report 未找到全局 dsh even though the
    // global install was present. Detect by suffix: a runtime root that ends
    // in `node_modules` is the global dir itself, not a project dir.
    let pkg_dir = if runtime_root.ends_with("node_modules") {
      runtime_root.clone()
    } else {
      runtime_root.join("node_modules")
    };

    Paths {
      dsh_runtime: runtime_root.clone(),
      dsh_bin: pkg_dir
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js"),
      dsh_pkg: pkg_dir.join("@deepseek-ai").join("dsh").join("package.json"),
      overlay,
      node_exe,
      npm_cli,
      bundled,
    }
  }

  /// Installed dsh version from `.dsh-runtime`, or None when absent.
  pub fn local_dsh_version(&self) -> Option<String> {
    let text = std::fs::read_to_string(&self.dsh_pkg).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
  }
}

/// The embedded-run overlay content, compiled into THIS exe. It lives in the
/// repo root (`embedded-overlay.yml`) and is patched into dsh at start via
/// `--patch`. It must follow the exe across launcher self-updates, so it is
/// embedded here rather than shipped as an install-time resources file.
const EMBEDDED_OVERLAY: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../embedded-overlay.yml"
));

/// Materialize the overlay into the user-data dir and return the path to
/// pass as `--patch`. The file is USER-EDITABLE: an update refreshes it ONLY
/// when the file still matches the previously materialized default (i.e. the
/// user has not touched it). A `.overlay-default` snapshot records what this
/// exe last wrote, so a customized file survives launcher updates untouched.
///
/// A file with no YAML content at all (comments only) is INVALID — dsh's
/// loader requires a top-level array and crashes on null — so it is treated
/// like a missing file and rewritten from the default.
fn materialize_overlay(user: &Path) -> PathBuf {
  let dir = user.join("overlay");
  let path = dir.join("embedded-overlay.yml");
  let snapshot = dir.join(".overlay-default");
  let _ = std::fs::create_dir_all(&dir);

  let existing = std::fs::read_to_string(&path).unwrap_or_default();
  let last_default = std::fs::read_to_string(&snapshot).unwrap_or_default();

  // Comments-only = no patch entries = null in YAML = loader crash.
  let has_content = existing
    .lines()
    .any(|line| !line.trim_start().starts_with('#') && !line.trim().is_empty());

  if !has_content {
    // Missing, deleted, or an invalid comment-only stub — write the default.
    let _ = crate::app::store::write_atomic(&path, EMBEDDED_OVERLAY);
    let _ = crate::app::store::write_atomic(&snapshot, EMBEDDED_OVERLAY);
  } else if existing == EMBEDDED_OVERLAY {
    // Already the current default — nothing to refresh, align the snapshot.
    let _ = crate::app::store::write_atomic(&snapshot, EMBEDDED_OVERLAY);
  } else if existing == last_default {
    // Untouched previous default; an update changed it — adopt the new one.
    let _ = crate::app::store::write_atomic(&path, EMBEDDED_OVERLAY);
    let _ = crate::app::store::write_atomic(&snapshot, EMBEDDED_OVERLAY);
  } else {
    // User-customized file — keep it, just record the new default baseline.
    let _ = crate::app::store::write_atomic(&snapshot, EMBEDDED_OVERLAY);
  }
  path
}

/// Diagnostics for the runtime-resolution chain — surfaced in the launcher
/// UI when the external flavor cannot find a global dsh, so a user can report
/// exactly which probe failed instead of a bare 未找到全局 dsh.
pub fn resolve_diagnostics(app: &AppHandle) -> String {
  let res = app.path().resource_dir().unwrap_or_default();
  let proj = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
  let user = app.path().app_data_dir().unwrap_or_else(|_| res.clone());
  let mut lines = Vec::new();
  lines.push(format!("resource_dir: {}", res.display()));
  lines.push(format!("app_data_dir: {}", user.display()));
  lines.push(format!("APPDATA env: {:?}", std::env::var_os("APPDATA")));
  lines.push(format!("DSH_RUNTIME env: {:?}", std::env::var_os("DSH_RUNTIME")));
  let ships_node = res.join("resources").join(if cfg!(windows) { "node.exe" } else { "node" }).exists()
    || res.join("resources").join("node_modules/npm/bin/npm-cli.js").exists();
  lines.push(format!("ships_node: {ships_node}"));
  for (label, path) in [
    ("resources/.dsh-runtime", res.join("resources").join(".dsh-runtime").join("node_modules/@deepseek-ai/dsh/lib/bin.js")),
    ("proj/.dsh-runtime", proj.join(".dsh-runtime").join("node_modules/@deepseek-ai/dsh/lib/bin.js")),
    ("app_data/dsh-runtime", user.join("dsh-runtime").join("node_modules/@deepseek-ai/dsh/lib/bin.js")),
  ] {
    lines.push(format!("{label}: {} -> {}", path.display(), path.exists()));
  }
  #[cfg(windows)]
  if let Some(appdata) = std::env::var_os("APPDATA") {
    let default = PathBuf::from(appdata).join("npm").join("node_modules");
    lines.push(format!("default global root: {}", default.display()));
    lines.push(format!("  @deepseek-ai/dsh/lib/bin.js exists: {}", default.join("@deepseek-ai/dsh/lib/bin.js").exists()));
  }
  if let Some(root) = global_npm_root() {
    lines.push(format!("global_npm_root() -> {}", root.display()));
    lines.push(format!("  bin.js exists: {}", root.join("@deepseek-ai/dsh/lib/bin.js").exists()));
  } else {
    lines.push("global_npm_root() -> None".to_string());
  }
  // Final resolved dsh binary the launcher would spawn (the actual failure
  // point: an extra `node_modules` join made this path never exist).
  let paths = Paths::resolve(app);
  lines.push(format!("resolved dsh_bin: {} -> {}", paths.dsh_bin.display(), paths.dsh_bin.exists()));
  lines.push(format!("resolved dsh_pkg: {} -> {}", paths.dsh_pkg.display(), paths.dsh_pkg.exists()));
  lines.push(format!("overlay: {} -> {}", paths.overlay.display(), paths.overlay.exists()));
  lines.push(format!("bundled: {}", paths.bundled));
  lines.join("\n")
}

/// Where the dsh runtime lives. Returns the dir that owns
/// `node_modules/@deepseek-ai/dsh` plus whether the launcher manages it.
/// `managed_only` = this install ships node+npm (bundled flavor) — only
/// launcher-owned runtimes are used; the user's own dsh is never picked up.
fn resolve_runtime(res: &Path, proj: &Path, user: &Path, managed_only: bool) -> (PathBuf, bool) {
  let bundled_res = res.join("resources").join(".dsh-runtime");
  if bundled_res.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
    return (bundled_res, true);
  }
  let proj_runtime = proj.join(".dsh-runtime");
  if proj_runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
    return (proj_runtime, true);
  }
  // The shell's on-demand install target (writable user-data dir). Checked
  // before the user's own dsh so a bundled install keeps using the runtime
  // the app itself installed.
  let user_runtime = user.join("dsh-runtime");
  if user_runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
    return (user_runtime, true);
  }
  if managed_only {
    // Nothing found — the bundled install installs on demand; point at the
    // user-data target so a missing runtime reads as 未安装 (not the user's
    // global dsh).
    return (user_runtime, false);
  }
  if let Ok(env_dir) = std::env::var("DSH_RUNTIME") {
    return (PathBuf::from(env_dir), false);
  }
  if let Some(global) = global_npm_root_cached() {
    if global.join("@deepseek-ai/dsh/lib/bin.js").exists() {
      return (global, false);
    }
  }
  // Nothing found — point at the bundled path so spawn errors are descriptive.
  (bundled_res, false)
}

/// `global_npm_root`, caching successes: the fallback spawns `npm root -g`
/// (a cmd.exe round trip on Windows) and Paths::resolve runs once per
/// command. Only Some is cached — a None re-probes, so a dsh installed
/// mid-session (`npm i -g`) is still picked up without an app restart.
fn global_npm_root_cached() -> Option<PathBuf> {
  static CACHE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
  if let Some(root) = CACHE.get() {
    return Some(root.clone());
  }
  let root = global_npm_root()?;
  let _ = CACHE.set(root.clone());
  Some(root)
}

/// The user's global npm node_modules dir (`npm root -g`), used by the
/// external flavor to find a globally installed `@deepseek-ai/dsh`.
///
/// Pure path probing comes first — zero processes spawned, so this never
/// flashes a console, never depends on the working directory or a spawn
/// succeeding, and never adds startup latency. `npm root -g` remains as a
/// fallback for non-default prefixes (custom `npm config prefix`).
fn global_npm_root() -> Option<PathBuf> {
  let probe = |root: &Path| root.join("@deepseek-ai/dsh/lib/bin.js").exists();

  // 1. npm's default global root: %APPDATA%\npm\node_modules on Windows,
  // /usr/local/lib/node_modules on Unix. Zero processes spawned — no console
  // flash, no working-directory dependence, no startup latency.
  #[cfg(windows)]
  if let Some(appdata) = std::env::var_os("APPDATA") {
    let default = PathBuf::from(appdata).join("npm").join("node_modules");
    if probe(&default) {
      return Some(default);
    }
  }
  #[cfg(not(windows))]
  {
    for default in [
      PathBuf::from("/usr/local/lib/node_modules"),
      PathBuf::from("/usr/lib/node_modules"),
    ] {
      if probe(&default) {
        return Some(default);
      }
    }
  }

  // 2. `npm root -g` output, for non-default prefixes. Never fatal — a
  // failure here returns None, it does not hide anything.
  npm_root_command().filter(|root| probe(root))
}

/// Run `npm root -g` and return the first line. Windows npm is a .cmd batch
/// shim that CreateProcess cannot run directly — wrap it in `cmd.exe /C`
/// (OpenCodeUI's pattern for .cmd/.bat binaries) with CREATE_NO_WINDOW so no
/// console flashes. Any failure returns None (callers fall back to the
/// default-root probes).
fn npm_root_command() -> Option<PathBuf> {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("cmd.exe")
      .args(["/C", "npm.cmd", "root", "-g"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .output()
      .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let root = text.trim();
    if root.is_empty() {
      None
    } else {
      Some(PathBuf::from(root))
    }
  }
  #[cfg(not(windows))]
  {
    let output = std::process::Command::new("npm")
      .args(["root", "-g"])
      .stdin(Stdio::null())
      .stdout(Stdio::piped())
      .stderr(Stdio::null())
      .output()
      .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let root = text.trim();
    if root.is_empty() {
      None
    } else {
      Some(PathBuf::from(root))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_user_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dsh-app-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn overlay_files(user: &Path) -> (PathBuf, PathBuf) {
    let dir = user.join("overlay");
    (dir.join("embedded-overlay.yml"), dir.join(".overlay-default"))
  }

  #[test]
  fn overlay_missing_file_gets_default() {
    let user = temp_user_dir("missing");
    let path = materialize_overlay(&user);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), EMBEDDED_OVERLAY);
    let (_, snapshot) = overlay_files(&user);
    assert_eq!(std::fs::read_to_string(snapshot).unwrap(), EMBEDDED_OVERLAY);
    let _ = std::fs::remove_dir_all(&user);
  }

  #[test]
  fn overlay_user_customization_survives() {
    let user = temp_user_dir("custom");
    let (path, snapshot) = overlay_files(&user);
    // First run materializes the default, then the user edits the file.
    materialize_overlay(&user);
    std::fs::write(&path, "# my tweaks\n- custom: entry\n").unwrap();
    materialize_overlay(&user);
    // Untouched-by-update user content is kept; the snapshot still advances.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "# my tweaks\n- custom: entry\n");
    assert_eq!(std::fs::read_to_string(snapshot).unwrap(), EMBEDDED_OVERLAY);
    let _ = std::fs::remove_dir_all(&user);
  }

  #[test]
  fn overlay_stale_default_is_refreshed() {
    let user = temp_user_dir("stale");
    let (path, snapshot) = overlay_files(&user);
    // The file still matches what the PREVIOUS exe wrote (user never
    // touched it) — an update must replace it with the new default.
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "- old: default\n").unwrap();
    std::fs::write(&snapshot, "- old: default\n").unwrap();
    materialize_overlay(&user);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), EMBEDDED_OVERLAY);
    let _ = std::fs::remove_dir_all(&user);
  }

  #[test]
  fn overlay_comments_only_is_rewritten() {
    let user = temp_user_dir("comments");
    let (path, _) = overlay_files(&user);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "# only a comment\n\n").unwrap();
    materialize_overlay(&user);
    // A comments-only file parses as null and crashes dsh's loader.
    assert_eq!(std::fs::read_to_string(&path).unwrap(), EMBEDDED_OVERLAY);
    let _ = std::fs::remove_dir_all(&user);
  }
}
