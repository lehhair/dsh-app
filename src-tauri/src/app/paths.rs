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

    let pick = |rel: &str| {
      let in_res = res.join("resources").join(rel);
      if in_res.exists() {
        in_res
      } else {
        let in_proj = proj.join(rel);
        if in_proj.exists() {
          in_proj
        } else {
          in_res
        }
      }
    };

    let node_exe = {
      let in_res = res.join("resources").join("node.exe");
      if in_res.exists() {
        in_res
      } else {
        let in_proj = proj.join("resources").join("node.exe");
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

    let (runtime_root, bundled) = resolve_runtime(&res, &proj);

    Paths {
      dsh_runtime: runtime_root.clone(),
      dsh_bin: runtime_root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js"),
      dsh_pkg: runtime_root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json"),
      overlay: pick("embedded-overlay.yml"),
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

/// Where the dsh runtime lives. Returns the dir that owns
/// `node_modules/@deepseek-ai/dsh` plus whether the launcher manages it.
fn resolve_runtime(res: &Path, proj: &Path) -> (PathBuf, bool) {
  let bundled_res = res.join("resources").join(".dsh-runtime");
  if bundled_res.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
    return (bundled_res, true);
  }
  let proj_runtime = proj.join(".dsh-runtime");
  if proj_runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js").exists() {
    return (proj_runtime, true);
  }
  if let Ok(env_dir) = std::env::var("DSH_RUNTIME") {
    return (PathBuf::from(env_dir), false);
  }
  if let Some(global) = global_npm_root() {
    if global.join("@deepseek-ai/dsh/lib/bin.js").exists() {
      return (global, false);
    }
  }
  // Nothing found — point at the bundled path so spawn errors are descriptive.
  (bundled_res, false)
}

/// The user's global npm node_modules dir (`npm root -g`), used by the
/// external flavor to find a globally installed `@deepseek-ai/dsh`.
fn global_npm_root() -> Option<PathBuf> {
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
