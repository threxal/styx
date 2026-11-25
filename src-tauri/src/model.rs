use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const URL: &str = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/bria-rmbg-2.0.onnx";
pub const SHA256: &str = "5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958";

pub struct DlCancel(pub Arc<AtomicBool>);
pub struct RmCancel(pub Arc<AtomicBool>);

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

// Единый корень данных. macOS - путь не изменился ни на байт.
// Windows: %LOCALAPPDATA%/com.threxal.styx - именно эту папку деинсталлятор
// Tauri удаляет целиком по галочке "Delete app data".
pub fn data_root() -> PathBuf {
    const ID: &str = "com.threxal.styx";
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support").join(ID)
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData/Local"))
            .join(ID)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"))
            .join(ID)
    }
}

pub fn own_dir() -> PathBuf {
    data_root().join("models")
}

pub fn find_model() -> Option<PathBuf> {
    let candidates = [
        home().join(".rembg/models/bria-rmbg/bria-rmbg.onnx"),
        home().join(".u2net/bria-rmbg.onnx"),
        own_dir().join("bria-rmbg.onnx"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}


pub fn status() -> serde_json::Value {
    match find_model() {
        Some(p) => {
            let mb = fs::metadata(&p).map(|m| m.len() / 1_048_576).unwrap_or(0);
            serde_json::json!({ "present": true, "size_mb": mb, "path": p.to_string_lossy() })
        }
        None => serde_json::json!({ "present": false, "size_mb": 0, "path": "" }),
    }
}

pub fn download(app: AppHandle, cancel: Arc<AtomicBool>) -> Result<String, String> {
    cancel.store(false, Ordering::SeqCst);
    let dir = own_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join("bria-rmbg.onnx.part");
    let final_path = dir.join("bria-rmbg.onnx");
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(URL).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total: u64 = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut buf = [0u8; 65536];
    let mut last_emit = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("cancelled".into());
        }
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        use std::io::Write;
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if received - last_emit > 262_144 {
            last_emit = received;
            let pct = if total > 0 { (received * 100 / total) as u32 } else { 0 };
            let _ = app.emit("model://progress", serde_json::json!({
                "pct": pct, "received": received, "total": total
            }));
        }
    }
    drop(file);
    let hash = format!("{:x}", hasher.finalize());
    if hash != SHA256 {
        let _ = fs::remove_file(&part);
        return Err("checksum mismatch".into());
    }
    fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
    let _ = app.emit("model://progress", serde_json::json!({
        "pct": 100, "received": received, "total": total
    }));
    Ok(final_path.to_string_lossy().to_string())
}

// Осколок недокачанной модели не должен висеть между запусками.
pub fn cleanup_partial() {
    let dir = own_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().extension().map(|x| x == "part").unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

// Текущий RunOptions удаляемого прохода: cancel_remove дёргает terminate()
// на нём из другого потока. Новый объект на каждый запуск => флаг отмены
// не может отравить следующий прогон (unterminate не нужен).
pub struct ActiveRun(
    pub std::sync::Mutex<
        std::option::Option<std::sync::Arc<ort::session::RunOptions<ort::session::NoSelectedOutputs>>>,
    >,
);
