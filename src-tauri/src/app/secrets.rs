//! Gateway-key storage.
//!
//! Desktop: OS keychain (Windows Credential Manager via `keyring`), matching
//! the old Electron safeStorage (DPAPI) secrecy level. Mobile: plaintext JSON
//! file, same as the previous Capacitor Preferences storage — the phone's app
//! sandbox is the only boundary, and the auth flow itself is unchanged.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
  const SERVICE: &str = "dsh-app";

  pub struct Secrets;

  impl Secrets {
    pub fn new() -> Self {
      Self
    }

    pub fn get(&self, id: &str) -> Option<String> {
      keyring::Entry::new(SERVICE, id).ok()?.get_password().ok()
    }

    pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
      let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
      entry
        .set_password(value)
        .map_err(|e| format!("系统密钥存储不可用：{e}"))
    }

    pub fn remove(&self, id: &str) {
      if let Ok(entry) = keyring::Entry::new(SERVICE, id) {
        let _ = entry.delete_credential();
      }
    }
  }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
  use serde_json::{json, Value};
  use std::path::PathBuf;

  pub struct Secrets {
    file: PathBuf,
  }

  impl Secrets {
    pub fn new(dir: PathBuf) -> Self {
      Self { file: dir.join("secrets.json") }
    }

    fn read(&self) -> Value {
      std::fs::read_to_string(&self.file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}))
    }

    fn write(&self, doc: &Value) {
      if let Some(parent) = self.file.parent() {
        let _ = std::fs::create_dir_all(parent);
      }
      if let Ok(text) = serde_json::to_string_pretty(doc) {
        let _ = std::fs::write(&self.file, text);
      }
    }

    pub fn get(&self, id: &str) -> Option<String> {
      self.read().get(id)?.as_str().map(str::to_string)
    }

    pub fn set(&self, id: &str, value: &str) -> Result<(), String> {
      let mut doc = self.read();
      if let Some(map) = doc.as_object_mut() {
        map.insert(id.to_string(), json!(value));
        self.write(&doc);
      }
      Ok(())
    }

    pub fn remove(&self, id: &str) {
      let mut doc = self.read();
      if let Some(map) = doc.as_object_mut() {
        map.remove(id);
        self.write(&doc);
      }
    }
  }
}

pub use imp::Secrets;
