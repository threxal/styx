use serde_json::{json, Value};
use std::path::PathBuf;

pub struct Config {
    pub brightness: i32,
    pub contrast: i32,
    pub saturation: i32,
    pub output_dir: String,
    pub theme: String,
}

fn path() -> PathBuf {
    crate::model::data_root().join("config.json")
}


fn read_json() -> Value {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}))
}

impl Config {
    pub fn load() -> Self {
        let v = read_json();
        let get = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0).clamp(-100, 100) as i32;
        Self {
            brightness: get("brightness"),
            contrast: get("contrast"),
            saturation: get("saturation"),
            output_dir: v.get("output_dir").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            theme: v.get("theme").and_then(|x| x.as_str()).unwrap_or("dark").to_string(),
        }
    }

    pub fn persist(&self) {
        let mut v = read_json();
        if !v.is_object() {
            v = json!({});
        }
        v["brightness"] = json!(self.brightness);
        v["contrast"] = json!(self.contrast);
        v["saturation"] = json!(self.saturation);
        v["output_dir"] = json!(self.output_dir);
        v["theme"] = json!(self.theme);
        if let Some(parent) = path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path(), serde_json::to_string_pretty(&v).unwrap_or_default());
    }

    pub fn save_adjustments(&mut self, b: i32, c: i32, s: i32) {
        self.brightness = b;
        self.contrast = c;
        self.saturation = s;
        self.persist();
    }
}
