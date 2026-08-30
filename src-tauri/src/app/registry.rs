//! npm registry (源) management. The bundled npm CLI and the user's own npm
//! both read `~/.npmrc`, so rewriting the `registry=` line there steers every
//! dsh install/update the shell runs — no npm spawn needed, the file is the
//! API. Other lines (auth tokens, scoped registries, noproxy…) are preserved.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";

fn npmrc_path(app: &AppHandle) -> Result<PathBuf, String> {
  let home = app
    .path()
    .home_dir()
    .map_err(|e| format!("无法定位用户目录：{e}"))?;
  Ok(home.join(".npmrc"))
}

/// The effective registry from ~/.npmrc (exact `registry=` key — not scoped
/// `@ns:registry` or `//host/:_auth` lines), or the npm default.
pub fn get(app: &AppHandle) -> String {
  let text = npmrc_path(app)
    .ok()
    .and_then(|path| std::fs::read_to_string(path).ok())
    .unwrap_or_default();
  parse_registry(&text).unwrap_or_else(|| DEFAULT_REGISTRY.to_string())
}

/// Validate and write the registry into ~/.npmrc (atomic), preserving all
/// other lines.
pub fn set(app: &AppHandle, url: &str) -> Result<(), String> {
  if !valid_registry(url) {
    return Err("源地址无效，形如 https://registry.npmmirror.com".into());
  }
  let path = npmrc_path(app)?;
  let text = std::fs::read_to_string(&path).unwrap_or_default();
  let rewritten = rewrite_npmrc(&text, url);
  crate::app::store::write_atomic(&path, &rewritten).map_err(|e| format!("写入 .npmrc 失败：{e}"))
}

fn parse_registry(text: &str) -> Option<String> {
  for line in text.lines() {
    let line = line.trim();
    if line.starts_with('#') || line.starts_with(';') {
      continue;
    }
    if let Some(value) = line.strip_prefix("registry=") {
      let value = value.trim();
      if !value.is_empty() {
        return Some(value.to_string());
      }
    }
  }
  None
}

fn rewrite_npmrc(text: &str, url: &str) -> String {
  let mut replaced = false;
  let mut out = String::new();
  for line in text.lines() {
    let trimmed = line.trim();
    if !replaced && !trimmed.starts_with('#') && !trimmed.starts_with(';') && trimmed.starts_with("registry=") {
      out.push_str(&format!("registry={url}\n"));
      replaced = true;
    } else {
      out.push_str(line);
      out.push('\n');
    }
  }
  if !replaced {
    out.push_str(&format!("registry={url}\n"));
  }
  out
}

fn valid_registry(url: &str) -> bool {
  url::Url::parse(url)
    .map(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_finds_plain_registry_only() {
    assert_eq!(parse_registry("registry=https://a.com/\n"), Some("https://a.com/".into()));
    // Scoped registries and auth lines are NOT the default registry.
    assert_eq!(parse_registry("@ns:registry=https://b.com/\n//c.com/:_auth=x\n"), None);
    assert_eq!(parse_registry("# registry=https://c.com/\n"), None);
    assert_eq!(parse_registry(""), None);
  }

  #[test]
  fn rewrite_replaces_and_preserves() {
    let before = "registry=https://old.com/\nnoproxy=registry.npmmirror.com\n@ns:registry=https://ns.com/\n";
    let after = rewrite_npmrc(before, "https://new.com/");
    assert_eq!(parse_registry(&after), Some("https://new.com/".into()));
    assert!(after.contains("noproxy=registry.npmmirror.com"));
    assert!(after.contains("@ns:registry=https://ns.com/"));
  }

  #[test]
  fn rewrite_appends_when_missing() {
    let after = rewrite_npmrc("noproxy=x\n", "https://new.com/");
    assert!(after.contains("noproxy=x\n"));
    assert_eq!(parse_registry(&after), Some("https://new.com/".into()));
  }

  #[test]
  fn registry_urls_are_validated() {
    assert!(valid_registry("https://registry.npmmirror.com"));
    assert!(valid_registry("http://192.168.1.2:4873/"));
    assert!(!valid_registry("registry.npmmirror.com"));
    assert!(!valid_registry("ftp://x.com"));
    assert!(!valid_registry(""));
  }
}
