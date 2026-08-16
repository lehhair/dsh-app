//! Persistence for the shell: remote-node registry (`instances.json`),
//! shell behavior KV (`shell.json`), and per-window geometry (`winState.N`).
//! Secrets never live here — see [`crate::app::secrets`].

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Instance {
  pub id: String,
  pub name: String,
  pub url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SaveInstanceInput {
  pub id: Option<String>,
  pub name: String,
  pub url: String,
  #[serde(default)]
  pub key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedBounds {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
}

pub struct Store {
  dir: PathBuf,
}

impl Store {
  pub fn new(dir: PathBuf) -> Self {
    Self { dir }
  }

  fn file(&self, name: &str) -> PathBuf {
    self.dir.join(name)
  }

  fn read_json(&self, name: &str) -> Value {
    std::fs::read_to_string(self.file(name))
      .ok()
      .and_then(|text| serde_json::from_str(&text).ok())
      .unwrap_or(Value::Null)
  }

  fn write_json(&self, name: &str, value: &Value) {
    let file = self.file(name);
    if let Some(parent) = file.parent() {
      let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(value) {
      let _ = std::fs::write(file, text);
    }
  }

  // ---- remote node registry ----

  pub fn instances(&self) -> Vec<Instance> {
    self
      .read_json("instances.json")
      .get("instances")
      .and_then(|v| serde_json::from_value(v.clone()).ok())
      .unwrap_or_default()
  }

  pub fn find_instance(&self, id: &str) -> Option<Instance> {
    self.instances().into_iter().find(|i| i.id == id)
  }

  /// Create or update an instance. Returns the saved public fields.
  pub fn save_instance(&self, input: &SaveInstanceInput) -> Result<Instance, String> {
    let name = input.name.trim();
    if name.is_empty() {
      return Err("名称不能为空".into());
    }
    if !valid_instance_url(&input.url) {
      return Err("地址无效，形如 http://192.168.1.233:8443".into());
    }

    let mut instances = self.instances();
    let existing = input.id.as_deref().and_then(|id| instances.iter().position(|i| i.id == id));
    let instance = match existing {
      Some(index) => {
        instances[index].name = name.to_string();
        instances[index].url = input.url.trim().to_string();
        instances[index].clone()
      }
      None => {
        let instance = Instance {
          id: uuid::Uuid::new_v4().to_string(),
          name: name.to_string(),
          url: input.url.trim().to_string(),
        };
        instances.push(instance.clone());
        instance
      }
    };
    self.write_json("instances.json", &json!({ "instances": instances }));
    Ok(instance)
  }

  pub fn remove_instance(&self, id: &str) {
    let instances: Vec<Instance> = self.instances().into_iter().filter(|i| i.id != id).collect();
    self.write_json("instances.json", &json!({ "instances": instances }));
  }

  // ---- shell behavior KV ----

  pub fn shell_get(&self, key: &str) -> Option<Value> {
    self.read_json("shell.json").get(key).cloned()
  }

  pub fn shell_set(&self, key: &str, value: Value) {
    let mut doc = self.read_json("shell.json");
    if !doc.is_object() {
      doc = json!({});
    }
    if let Some(map) = doc.as_object_mut() {
      map.insert(key.to_string(), value);
      self.write_json("shell.json", &doc);
    }
  }

  pub fn shell_bool(&self, key: &str) -> bool {
    self.shell_get(key).and_then(|v| v.as_bool()).unwrap_or(false)
  }

  // ---- window geometry (per slot) ----

  pub fn win_state(&self, slot: u32) -> Option<SavedBounds> {
    self
      .shell_get(&format!("winState.{slot}"))
      .and_then(|v| serde_json::from_value(v).ok())
  }

  pub fn save_win_state(&self, slot: u32, bounds: &SavedBounds) {
    self.shell_set(&format!("winState.{slot}"), serde_json::to_value(bounds).unwrap_or(Value::Null));
  }
}

fn valid_instance_url(url: &str) -> bool {
  let rest = url
    .strip_prefix("http://")
    .or_else(|| url.strip_prefix("https://"))
    .unwrap_or("");
  !rest.is_empty() && !rest.contains('/')
}
