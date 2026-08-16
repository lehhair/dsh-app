//! Runtime paths for the embedded dsh runtime and bundled tooling.
//!
//! Resolution order per artifact: bundled resource dir first (installed
//! app: `<exe>/resources/…`), then the dev project root (`src-tauri/..`),
//! then environment fallbacks. Dev never needs a copy step — the project
//! root already holds `.dsh-runtime/` and `node_modules/npm`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct Paths {
  /// Official Node executable (bundled `resources/node.exe`, `DSH_NODE`, or `node` on PATH).
  pub node_exe: PathBuf,
  /// `@deepseek-ai/dsh` CLI entry (`lib/bin.js`).
  pub dsh_bin: PathBuf,
  /// `@deepseek-ai/dsh` package.json (for the installed version).
  pub dsh_pkg: PathBuf,
  /// `.dsh-runtime` npm project dir (cwd for npm runs).
  pub dsh_runtime: PathBuf,
  /// Bundled npm CLI (`node_modules/npm/bin/npm-cli.js`).
  pub npm_cli: PathBuf,
  /// Overlay that disables the remote-gateway plugin for the embedded instance.
  pub overlay: PathBuf,
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

    Paths {
      dsh_runtime: pick(".dsh-runtime"),
      dsh_bin: pick(".dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      dsh_pkg: pick(".dsh-runtime/node_modules/@deepseek-ai/dsh/package.json"),
      overlay: pick("embedded-overlay.yml"),
      node_exe,
      npm_cli,
    }
  }

  /// Installed dsh version from `.dsh-runtime`, or None when absent.
  pub fn local_dsh_version(&self) -> Option<String> {
    let text = std::fs::read_to_string(&self.dsh_pkg).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
  }
}
