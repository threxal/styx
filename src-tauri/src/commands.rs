fn decode_b64(s: &str) -> Option<Vec<u8>> {
    let mut table = [255u8; 256];
    for (i, &b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().enumerate() {
        table[b as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in s.as_bytes() {
        if b == b'=' || b.is_ascii_whitespace() { continue; }
        let val = table[b as usize];
        if val == 255 { return None; }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}
use crate::imaging as im;
use crate::state::{AppState, EraseStroke, Loaded};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

#[derive(Deserialize)]
pub struct Params {
    #[serde(default)] pub brightness: i32,
    #[serde(default)] pub contrast: i32,
    #[serde(default)] pub saturation: i32,
    #[serde(default = "default_scale")] pub scale: f64,
    #[serde(default)] pub offset_x: f64,
    #[serde(default)] pub offset_y: f64,
    #[serde(default)] pub rotation: f64,
    pub text_overlay: Option<String>,
}
fn default_scale() -> f64 { 100.0 }

// Cargo.toml must be full semver (1.0.0); the UI shows major.minor only.
pub(crate) fn display_version() -> String {
    let v = env!("CARGO_PKG_VERSION");
    let mut it = v.split('.');
    match (it.next(), it.next()) {
        (Some(maj), Some(min)) => format!("{maj}.{min}"),
        _ => v.to_string(),
    }
}

#[tauri::command]
pub fn initial_state(state: State<Mutex<AppState>>) -> serde_json::Value {
    let s = state.lock().unwrap();
    serde_json::json!({
        "brightness": s.config.brightness,
        "contrast": s.config.contrast,
        "saturation": s.config.saturation,
        "output_dir": s.config.output_dir,
        "theme": s.config.theme,
        "version": display_version(),
    })
}

#[tauri::command]
pub fn load_image(state: State<Mutex<AppState>>, path: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    let img = {
        let reader = image::ImageReader::open(&p).map_err(|e| e.to_string())?;
        let reader = reader.with_guessed_format().map_err(|e| e.to_string())?;
        match reader.decode() {
            Ok(d) => d.to_rgba8(),
            Err(_) => system_decode(&p)?,
        }
    };
    let img = im::apply_orientation(img, im::exif_orientation(&p));
    let preview = im::thumbnail(&img, im::THUMB);
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (w, h) = (img.width(), img.height());
    let (fit_w, fit_h) = im::fit(w, h, im::SIZE);
    let preview_masked = preview.clone();
    let mut s = state.lock().unwrap();
    s.loaded = Some(Loaded {
        initial_path: p,
        orig: img,
        nobg: None,
        preview_src: preview,
        preview_masked,
        erase_strokes: Vec::new(),
        cache: None,
        use_nobg: false,
    });
    Ok(serde_json::json!({ "name": name, "width": w, "height": h, "fit_w": fit_w, "fit_h": fit_h }))
}

#[tauri::command]
pub fn render_preview(state: State<Mutex<AppState>>, p: Params) -> Result<tauri::ipc::Response, String> {
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    let t0 = std::time::Instant::now();
    let canvas = im::render_sticker(
        &loaded.preview_masked, &mut loaded.cache,
        p.brightness, p.contrast, p.saturation,
        p.scale / 100.0, p.offset_x, p.offset_y, p.rotation,
    );
    if cfg!(debug_assertions) {
        eprintln!("render_preview: {} ms", t0.elapsed().as_millis());
    }
    Ok(tauri::ipc::Response::new(canvas.into_raw()))
}

// HEIC/HEIF and other exotic formats: delegate to the macOS system
// converter (ImageIO codecs licensed by Apple). Nothing is bundled.
// The temp file lives only between create and read, then is removed.
fn system_decode(path: &std::path::Path) -> Result<image::RgbaImage, String> {
    if !cfg!(target_os = "macos") {
        return Err("HEIC/HEIF is supported on macOS only (system codecs). Convert to JPG/PNG.".into());
    }
    let tmp = std::env::temp_dir().join(format!("styx_decode_{}.png", std::process::id()));
    let out = std::process::Command::new("sips")
        .args(["-s", "format", "png", "--out"])
        .arg(&tmp)
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("Unsupported or corrupt image".into());
    }
    let img = image::open(&tmp).map_err(|e| e.to_string())?.to_rgba8();
    let _ = std::fs::remove_file(&tmp);
    Ok(img)
}

fn unique_path(dir: &std::path::Path, stem: &str, suffix: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}{suffix}.png"));
    if !p.exists() { return p; }
    let mut n = 1;
    loop {
        p = dir.join(format!("{stem}{suffix} ({n}).png"));
        if !p.exists() { return p; }
        n += 1;
    }
}

fn out_dir_for(s: &AppState) -> PathBuf {
    let loaded = s.loaded.as_ref().unwrap();
    if !s.config.output_dir.is_empty() {
        PathBuf::from(&s.config.output_dir)
    } else {
        loaded.initial_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
    }
}

fn stem_of(s: &AppState) -> String {
    s.loaded.as_ref().unwrap().initial_path.file_stem()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "sticker".into())
}

#[tauri::command]
pub fn save_sticker(state: State<Mutex<AppState>>, p: Params) -> Result<String, String> {
    let mut s = state.lock().unwrap();
    if s.loaded.is_none() { return Err("no image".into()); }
    let dir = out_dir_for(&s);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = stem_of(&s);
    let mut canvas = {
        let loaded = s.loaded.as_mut().unwrap();
        im::render_sticker(
            &loaded.preview_masked, &mut loaded.cache,
            p.brightness, p.contrast, p.saturation,
            p.scale / 100.0, p.offset_x, p.offset_y, p.rotation,
        )
    };
    if let Some(ref b64) = p.text_overlay {
        if let Some(raw) = decode_b64(b64) {
            if let Ok(overlay) = image::load_from_memory(&raw) {
                im::composite_overlay(&mut canvas, &overlay.to_rgba8());
            }
        }
    }
    let mut bytes = im::encode_png(&canvas)?;
    if bytes.len() as u64 > im::MAX_BYTES {
        bytes = im::shrink_to_limit(&canvas)?;
    }
    let path = unique_path(&dir, &stem, "_sticker");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    s.config.save_adjustments(p.brightness, p.contrast, p.saturation);
    Ok(path.file_name().unwrap().to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_original(state: State<Mutex<AppState>>, p: Params) -> Result<String, String> {
    let s = state.lock().unwrap();
    let loaded = s.loaded.as_ref().ok_or("no image")?;
    let dir = out_dir_for(&s);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = stem_of(&s);
    let img = if loaded.erase_strokes.is_empty() {
        im::apply_enhance(loaded.active_full(), p.brightness, p.contrast, p.saturation)
    } else {
        let mut base = loaded.active_full().clone();
        im::apply_erase_strokes(&mut base, &loaded.erase_strokes);
        im::apply_enhance(&base, p.brightness, p.contrast, p.saturation)
    };
    let img = im::rotate_rgba(&img, p.rotation);
    let bytes = im::encode_png(&img)?;
    let path = unique_path(&dir, &stem, "_original");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.file_name().unwrap().to_string_lossy().to_string())
}

#[tauri::command]
pub fn model_status() -> serde_json::Value {
    crate::model::status()
}

#[tauri::command]
pub async fn download_model(app: tauri::AppHandle, cancel: tauri::State<'_, crate::model::DlCancel>) -> Result<String, String> {
    let token = cancel.0.clone();
    tauri::async_runtime::spawn_blocking(move || crate::model::download(app, token))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_download(cancel: tauri::State<'_, crate::model::DlCancel>) {
    cancel.0.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_remove(cancel: State<'_, crate::model::RmCancel>, active_run: State<'_, crate::model::ActiveRun>) {
    cancel.0.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(ro) = active_run.0.lock().unwrap().as_ref() {
        let _ = ro.terminate();
    }
}

#[tauri::command]
pub fn restore_bg(state: State<Mutex<AppState>>) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    loaded.use_nobg = false;
    loaded.preview_src = crate::inference::preview_of(&loaded.orig);
    loaded.preview_masked = loaded.preview_src.clone();
    im::apply_erase_strokes(&mut loaded.preview_masked, &loaded.erase_strokes);
    loaded.cache = None;
    Ok(())
}

#[tauri::command]
pub async fn remove_bg(
    state: State<'_, Mutex<AppState>>,
    engine: State<'_, crate::inference::Engine>,
    cancel: State<'_, crate::model::RmCancel>,
    active_run: State<'_, crate::model::ActiveRun>,
) -> Result<String, String> {
    cancel.0.store(false, std::sync::atomic::Ordering::SeqCst);
    let token = cancel.0.clone();
    let (orig, path, cached) = {
        let s = state.lock().unwrap();
        let loaded = s.loaded.as_ref().ok_or("no image")?;
        let path = crate::model::find_model().ok_or("model missing")?;
        (loaded.orig.clone(), path, loaded.nobg.is_some())
    };
    if cached {
        let mut s = state.lock().unwrap();
        let loaded = s.loaded.as_mut().ok_or("no image")?;
        loaded.use_nobg = true;
        loaded.preview_src = crate::inference::preview_of(loaded.nobg.as_ref().unwrap());
        loaded.preview_masked = loaded.preview_src.clone();
        im::apply_erase_strokes(&mut loaded.preview_masked, &loaded.erase_strokes);
        loaded.cache = None;
        return Ok("cached".into());
    }
    if token.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let engine = engine.inner().clone();
    let token_inner = token.clone();
    let run_options = std::sync::Arc::new(
        ort::session::RunOptions::new().map_err(|e| e.to_string())?
    );
    {
        let mut slot = active_run.0.lock().unwrap();
        *slot = Some(run_options.clone());
    }
    let ro_inner = run_options.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        crate::inference::remove_background(&orig, &engine, &path, &*token_inner, &*ro_inner)
    });
    let raw = join.await;
    {
        let mut slot = active_run.0.lock().unwrap();
        *slot = None;
    }
    let result = raw.map_err(|e| e.to_string())?;
    if token.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("cancelled".into());
    }
    let nobg = result?;
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    loaded.preview_src = crate::inference::preview_of(&nobg);
    loaded.preview_masked = loaded.preview_src.clone();
    im::apply_erase_strokes(&mut loaded.preview_masked, &loaded.erase_strokes);
    loaded.nobg = Some(nobg);
    loaded.use_nobg = true;
    loaded.cache = None;
    Ok("done".into())
}

#[tauri::command]
pub fn set_output_dir(state: State<Mutex<AppState>>, path: String) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    s.config.output_dir = path;
    s.config.persist();
    Ok(())
}

#[tauri::command]
pub fn set_theme(state: State<Mutex<AppState>>, theme: String) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    s.config.theme = if theme == "light" { "light".into() } else { "dark".into() };
    s.config.persist();
    Ok(())
}

#[tauri::command]
pub fn clear_image(state: State<Mutex<AppState>>) {
    state.lock().unwrap().loaded = None;
}

#[tauri::command]
pub fn erase_stroke(state: State<Mutex<AppState>>, stroke: EraseStroke) -> Result<usize, String> {
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    im::apply_erase_stroke(&mut loaded.preview_masked, &stroke);
    loaded.erase_strokes.push(stroke);
    loaded.cache = None;
    Ok(loaded.erase_strokes.len())
}

#[tauri::command]
pub fn erase_undo(state: State<Mutex<AppState>>) -> Result<usize, String> {
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    loaded.erase_strokes.pop();
    loaded.preview_masked = loaded.preview_src.clone();
    im::apply_erase_strokes(&mut loaded.preview_masked, &loaded.erase_strokes);
    loaded.cache = None;
    Ok(loaded.erase_strokes.len())
}

#[tauri::command]
pub fn erase_reset(state: State<Mutex<AppState>>) -> Result<usize, String> {
    let mut s = state.lock().unwrap();
    let loaded = s.loaded.as_mut().ok_or("no image")?;
    loaded.erase_strokes.clear();
    loaded.preview_masked = loaded.preview_src.clone();
    loaded.cache = None;
    Ok(0)
}
