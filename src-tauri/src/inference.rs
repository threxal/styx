use crate::imaging as im;
use image::RgbaImage;
use ort::session::Session;
use std::sync::{Arc, Mutex};

pub type Engine = Arc<Mutex<Option<Session>>>;

fn resize_gray(img: &RgbaImage, w: u32, h: u32) -> Vec<u8> {
    use fast_image_resize as fr;
    let src = fr::images::Image::from_vec_u8(
        img.width(), img.height(), img.as_raw().clone(), fr::PixelType::U8x4,
    ).expect("src");
    let mut dst = fr::images::Image::new(w, h, fr::PixelType::U8x4);
    let mut r = fr::Resizer::new();
    r.resize(&src, &mut dst, &fr::ResizeOptions::new()
        .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3))).expect("resize");
    dst.into_vec()
}

fn resize_mask(data: Vec<u8>, w: u32, h: u32, tw: u32, th: u32) -> Vec<u8> {
    use fast_image_resize as fr;
    let src = fr::images::Image::from_vec_u8(w, h, data, fr::PixelType::U8).expect("mask src");
    let mut dst = fr::images::Image::new(tw, th, fr::PixelType::U8);
    let mut r = fr::Resizer::new();
    r.resize(&src, &mut dst, &fr::ResizeOptions::new()
        .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3))).expect("mask resize");
    dst.into_vec()
}

// rembg bria-rmbg parity: RGB -> 1024 LANCZOS, divide by max RGB pixel,
// ImageNet mean/std, CHW f32; mask minmax -> u8 -> LANCZOS to original size.
pub fn remove_background(orig: &RgbaImage, engine: &Engine, path: &std::path::Path, cancel: &std::sync::atomic::AtomicBool, run_options: &ort::session::RunOptions<ort::session::NoSelectedOutputs>) -> Result<RgbaImage, String> {
    let mut guard = engine.lock().unwrap();
    if guard.is_none() {
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(4)
            .map_err(|e| e.to_string())?
            .with_execution_providers([
                // Arena off. ORT keeps freed activation blocks in its own pool;
                // macOS then compresses/swaps that dead pool and the next pass
                // thrashes on page-ins. Measured on M1 8GB, same photo,
                // 2 runs x 3 passes each (examples/mem_probe.rs):
                //   swap growth   +4.5 GB -> +0.3 GB
                //   passes 2-3    ~26/22 s -> ~16/15 s
                //   session init  1710 MB -> 1340 MB
                //   idle RSS      1189 MB -> 45 MB
                //   alpha hash    identical (7a92cc5727e4de3f) => mask unchanged
                ort::execution_providers::CPUExecutionProvider::default()
                    .with_arena_allocator(false)
                    .build(),
            ])
            .map_err(|e| e.to_string())?
            .commit_from_file(path)
            .map_err(|e| e.to_string())?;
        *guard = Some(session);
    }
    let session = guard.as_mut().unwrap();
    let side = 1024u32;
    let rgba = resize_gray(orig, side, side);
    if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err("cancelled".into()); }
    let mut maxv: u8 = 0;
    for (i, v) in rgba.iter().enumerate() {
        if i % 4 != 3 && *v > maxv { maxv = *v; }
    }
    let denom = (maxv as f64).max(1e-6);
    let mean = [0.485f64, 0.456, 0.406];
    let std = [0.229f64, 0.224, 0.225];
    let mut data = vec![0f32; (3 * side * side) as usize];
    for y in 0..side as usize {
        for x in 0..side as usize {
            let i = (y * side as usize + x) * 4;
            for c in 0..3 {
                let v = rgba[i + c] as f64 / denom;
                data[c * (side * side) as usize + y * side as usize + x] =
                    ((v - mean[c]) / std[c]) as f32;
            }
        }
    }
    let input_name = session.inputs[0].name.clone();
    let tensor = ort::value::Tensor::from_array((vec![1i64, 3, side as i64, side as i64], data))
        .map_err(|e| e.to_string())?;
    let outputs = match session
        .run_with_options(ort::inputs![input_name.as_str() => tensor], run_options)
    {
        Ok(o) => o,
        Err(e) => {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            return Err(e.to_string());
        }
    };
    let (_shape, raw) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if cancel.load(std::sync::atomic::Ordering::SeqCst) { return Err("cancelled".into()); }
    let n = (side * side) as usize;
    let slice = &raw[..n.min(raw.len())];
    let mut mi = f32::INFINITY;
    let mut ma = f32::NEG_INFINITY;
    for v in slice {
        if *v < mi { mi = *v; }
        if *v > ma { ma = *v; }
    }
    let span = (ma - mi).max(1e-8);
    let mask: Vec<u8> = slice.iter().map(|v| (((v - mi) / span) * 255.0) as u8).collect();
    let mask_full = resize_mask(mask, side, side, orig.width(), orig.height());
    let mut out = orig.clone();
    for (i, p) in out.pixels_mut().enumerate() {
        p[3] = mask_full[i];
    }
    Ok(out)
}

pub fn preview_of(img: &RgbaImage) -> RgbaImage {
    im::thumbnail(img, im::THUMB)
}
