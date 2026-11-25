use crate::state::EraseStroke;
use image::RgbaImage;

pub const SIZE: u32 = 512;
pub const MAX_BYTES: u64 = 512 * 1024;
pub const THUMB: u32 = SIZE * 4;

pub type ResizeCache = Option<(f64, RgbaImage)>;

// Python round(): banker's rounding (half to even)
fn py_round(v: f64) -> i64 {
    let f = v.floor();
    let d = v - f;
    let fi = f as i64;
    if d > 0.5 { fi + 1 }
    else if d < 0.5 { fi }
    else if fi % 2 == 0 { fi }
    else { fi + 1 }
}

// PIL ImagingBlend casts float -> int (trunc toward zero), then clips
fn clip(v: f64) -> u8 {
    (v as i32).clamp(0, 255) as u8
}

// PIL rgb->L: (R*299 + G*587 + B*114) / 1000, integer division
fn luma_rgb(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8
}

fn resize_rgba(img: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    use fast_image_resize as fr;
    let src = fr::images::Image::from_vec_u8(
        img.width(), img.height(), img.as_raw().clone(), fr::PixelType::U8x4,
    ).expect("src image");
    let mut dst = fr::images::Image::new(w, h, fr::PixelType::U8x4);
    let mut resizer = fr::Resizer::new();
    resizer.resize(
        &src, &mut dst,
        &fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3)),
    ).expect("resize");
    RgbaImage::from_raw(w, h, dst.into_vec()).expect("dst image")
}

pub fn fit(w: u32, h: u32, box_: u32) -> (u32, u32) {
    let r = (box_ as f64 / w as f64).min(box_ as f64 / h as f64);
    (
        (py_round(w as f64 * r) as u32).max(1),
        (py_round(h as f64 * r) as u32).max(1),
    )
}

pub fn thumbnail(img: &RgbaImage, box_: u32) -> RgbaImage {
    if img.width() <= box_ && img.height() <= box_ {
        return img.clone();
    }
    let (w, h) = fit(img.width(), img.height(), box_);
    resize_rgba(img, w, h)
}

// PIL-parity enhance via composed LUTs (brightness+contrast) + integer luma mix.
pub fn apply_enhance(img: &RgbaImage, b: i32, c: i32, s: i32) -> RgbaImage {
    if b == 0 && c == 0 && s == 0 {
        return img.clone();
    }
    let bf = (1.0 + b as f64 / 100.0).max(0.0);
    let cf = (1.0 + c as f64 / 100.0).max(0.0);
    let sf = (1.0 + s as f64 / 100.0).max(0.0);
    let mut lut_b = [0u8; 256];
    for v in 0..256 {
        lut_b[v] = clip(v as f64 * bf);
    }
    let mut sum: u64 = 0;
    for p in img.pixels() {
        sum += luma_rgb(lut_b[p[0] as usize], lut_b[p[1] as usize], lut_b[p[2] as usize]) as u64;
    }
    let mean = (sum as f64 / img.pixels().len() as f64 + 0.5) as i32;
    let mut lut = [0u8; 256];
    for v in 0..256 {
        let bv = lut_b[v] as f64;
        lut[v] = if c != 0 { clip(mean as f64 + (bv - mean as f64) * cf) } else { lut_b[v] };
    }
    let mut out = img.clone();
    if s == 0 {
        for p in out.pixels_mut() {
            p[0] = lut[p[0] as usize];
            p[1] = lut[p[1] as usize];
            p[2] = lut[p[2] as usize];
        }
    } else {
        for p in out.pixels_mut() {
            let r = lut[p[0] as usize];
            let g = lut[p[1] as usize];
            let bl = lut[p[2] as usize];
            let gray = luma_rgb(r, g, bl) as f64;
            p[0] = clip(gray + (r as f64 - gray) * sf);
            p[1] = clip(gray + (g as f64 - gray) * sf);
            p[2] = clip(gray + (bl as f64 - gray) * sf);
        }
    }
    out
}

pub fn render_sticker(
    src: &RgbaImage, cache: &mut ResizeCache,
    b: i32, c: i32, s: i32, scale: f64, ox: f64, oy: f64, rot: f64,
) -> RgbaImage {
    let stale = match cache {
        Some((sc, _)) => (*sc - scale).abs() > 1e-9,
        None => true,
    };
    if stale {
        let (bw, bh) = fit(src.width(), src.height(), SIZE);
        let fw = (py_round(bw as f64 * scale) as u32).max(1);
        let fh = (py_round(bh as f64 * scale) as u32).max(1);
        *cache = Some((scale, resize_rgba(src, fw, fh)));
    }
    let resized = &cache.as_ref().unwrap().1;
    let img = rotate_rgba(&apply_enhance(resized, b, c, s), rot);
    let (fw, fh) = (img.width(), img.height());
    let mut canvas = RgbaImage::new(SIZE, SIZE);
    let ox = ox.clamp(-(SIZE as f64 / 2.0), SIZE as f64 / 2.0);
    let oy = oy.clamp(-(SIZE as f64 / 2.0), SIZE as f64 / 2.0);
    let cx = SIZE as i64 / 2 + py_round(ox);
    let cy = SIZE as i64 / 2 + py_round(oy);
    let x0 = cx - fw as i64 / 2;
    let y0 = cy - fh as i64 / 2;
    // FIX vs beta: PIL paste with self-mask squared alpha on semi-transparent
    // pixels. Over an empty canvas the correct result is the source pixel as-is.
    let xs = x0.max(0);
    let xe = (x0 + fw as i64).min(SIZE as i64);
    let ys = y0.max(0);
    let ye = (y0 + fh as i64).min(SIZE as i64);
    for dy in ys..ye {
        let sy = (dy - y0) as u32;
        for dx in xs..xe {
            let sx = (dx - x0) as u32;
            canvas.put_pixel(dx as u32, dy as u32, *img.get_pixel(sx, sy));
        }
    }
    canvas
}

pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let enc = image::codecs::png::PngEncoder::new_with_quality(
        &mut buf,
        image::codecs::png::CompressionType::Best,
        image::codecs::png::FilterType::Adaptive,
    );
    image::ImageEncoder::write_image(enc, img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    let opts = oxipng::Options::from_preset(4);
    oxipng::optimize_from_memory(&buf, &opts).map_err(|e| e.to_string())
}

// Median cut over RGB (all pixels, like PIL), alpha reattached untouched.
fn quantize(img: &RgbaImage, colors: usize) -> RgbaImage {
    let px: Vec<[u8; 3]> = img.pixels().map(|p| [p[0], p[1], p[2]]).collect();
    let mut boxes: Vec<Vec<usize>> = vec![(0..px.len()).collect()];
    while boxes.len() < colors {
        let mut best: Option<(usize, usize, u32)> = None;
        for (bi, b) in boxes.iter().enumerate() {
            if b.len() < 2 { continue; }
            for ch in 0..3 {
                let lo = b.iter().map(|&i| px[i][ch]).min().unwrap();
                let hi = b.iter().map(|&i| px[i][ch]).max().unwrap();
                let range = (hi - lo) as u32;
                if best.map_or(true, |(_, _, r)| range > r) {
                    best = Some((bi, ch, range));
                }
            }
        }
        let (bi, ch, _range) = match best {
            Some(v) if v.2 > 0 => v,
            _ => break,
        };
        let mut b = boxes.remove(bi);
        b.sort_by_key(|&i| px[i][ch]);
        let mid = b.len() / 2;
        let right = b.split_off(mid);
        boxes.push(b);
        boxes.push(right);
    }
    let palette: Vec<[u8; 3]> = boxes
        .iter()
        .map(|b| {
            let n = b.len().max(1) as u64;
            let mut s = [0u64; 3];
            for &i in b {
                for k in 0..3 { s[k] += px[i][k] as u64; }
            }
            [(s[0] / n) as u8, (s[1] / n) as u8, (s[2] / n) as u8]
        })
        .collect();
    let mut out = img.clone();
    for (i, p) in out.pixels_mut().enumerate() {
        let src = px[i];
        let mut bi = 0;
        let mut bd = u32::MAX;
        for (j, c) in palette.iter().enumerate() {
            let d: u32 = (0..3)
                .map(|k| {
                    let d = src[k] as i32 - c[k] as i32;
                    (d * d) as u32
                })
                .sum();
            if d < bd { bd = d; bi = j; }
        }
        let c = palette[bi];
        p[0] = c[0];
        p[1] = c[1];
        p[2] = c[2];
    }
    out
}

pub fn shrink_to_limit(img: &RgbaImage) -> Result<Vec<u8>, String> {
    for colors in [256usize, 128, 64, 32, 16] {
        let bytes = encode_png(&quantize(img, colors))?;
        if bytes.len() as u64 <= MAX_BYTES {
            return Ok(bytes);
        }
    }
    encode_png(&quantize(img, 16))
}

// ---- free rotation: bilinear sampling in premultiplied alpha ----
fn sample_premult(src: &[u8], w: u32, h: u32, x: f64, y: f64) -> [f64; 4] {
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let mut acc = [0.0f64; 4];
    for j in 0..2i64 {
        for i in 0..2i64 {
            let px = x0 + i;
            let py = y0 + j;
            if px < 0 || py < 0 || px >= w as i64 || py >= h as i64 { continue; }
            let wgt = (if i == 0 { 1.0 - fx } else { fx }) * (if j == 0 { 1.0 - fy } else { fy });
            let o = ((py as u32) * w + px as u32) as usize * 4;
            let a = src[o + 3] as f64 / 255.0;
            acc[0] += src[o] as f64 * a * wgt;
            acc[1] += src[o + 1] as f64 * a * wgt;
            acc[2] += src[o + 2] as f64 * a * wgt;
            acc[3] += a * wgt;
        }
    }
    acc
}

// Positive degrees = clockwise on screen.
pub fn rotate_rgba(img: &RgbaImage, deg: f64) -> RgbaImage {
    if deg.abs() < 1e-9 { return img.clone(); }
    let (w, h) = (img.width(), img.height());
    let th = deg.to_radians();
    let (s, c) = th.sin_cos();
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
    let mut minx = f64::INFINITY; let mut maxx = f64::NEG_INFINITY;
    let mut miny = f64::INFINITY; let mut maxy = f64::NEG_INFINITY;
    for (x, y) in [(-cx, -cy), (cx, -cy), (cx, cy), (-cx, cy)] {
        let rx = x * c - y * s;
        let ry = x * s + y * c;
        minx = minx.min(rx); maxx = maxx.max(rx);
        miny = miny.min(ry); maxy = maxy.max(ry);
    }
    let ow = (maxx - minx).ceil().max(1.0) as u32;
    let oh = (maxy - miny).ceil().max(1.0) as u32;
    let (ocx, ocy) = (ow as f64 / 2.0, oh as f64 / 2.0);
    let src = img.as_raw();
    let mut out = RgbaImage::new(ow, oh);
    for dy in 0..oh {
        let y = dy as f64 + 0.5 - ocy;
        for dx in 0..ow {
            let x = dx as f64 + 0.5 - ocx;
            let sx = x * c + y * s + cx - 0.5;
            let sy = -x * s + y * c + cy - 0.5;
            let a = sample_premult(src, w, h, sx, sy);
            let p = out.get_pixel_mut(dx, dy);
            if a[3] > 1e-6 {
                p[0] = (a[0] / a[3]).clamp(0.0, 255.0) as u8;
                p[1] = (a[1] / a[3]).clamp(0.0, 255.0) as u8;
                p[2] = (a[2] / a[3]).clamp(0.0, 255.0) as u8;
                p[3] = (a[3] * 255.0).clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

// ---- EXIF orientation: all formats behave like Preview / HEIC ----
pub fn exif_orientation(path: &std::path::Path) -> u32 {
    use std::io::BufReader;
    let f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return 1 };
    let r = exif::Reader::new();
    let e = match r.read_from_container(&mut BufReader::new(f)) { Ok(e) => e, Err(_) => return 1 };
    e.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1)
}

pub fn apply_orientation(img: RgbaImage, o: u32) -> RgbaImage {
    match o {
        2 => image::imageops::flip_horizontal(&img),
        3 => rotate_rgba(&img, 180.0),
        4 => image::imageops::flip_vertical(&img),
        5 => image::imageops::flip_horizontal(&rotate_rgba(&img, 90.0)),
        6 => rotate_rgba(&img, 90.0),
        7 => image::imageops::flip_vertical(&rotate_rgba(&img, 90.0)),
        8 => rotate_rgba(&img, -90.0),
        _ => img,
    }
}



// ---- eraser mask engine ----
fn dist_to_segment_sq(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let vx = bx - ax;
    let vy = by - ay;
    let wx = px - ax;
    let wy = py - ay;
    let len_sq = vx * vx + vy * vy;
    if len_sq <= 1e-12 {
        return wx * wx + wy * wy;
    }
    let t = ((wx * vx + wy * vy) / len_sq).clamp(0.0, 1.0);
    let dx = px - (ax + t * vx);
    let dy = py - (ay + t * vy);
    dx * dx + dy * dy
}

pub fn apply_erase_stroke(img: &mut RgbaImage, stroke: &EraseStroke) {
    if stroke.points.is_empty() || stroke.opacity <= 0.0 || stroke.radius <= 0.0 {
        return;
    }
    let (w, h) = (img.width(), img.height());
    let r_px = (stroke.radius * w as f64).max(0.5);
    let r_sq = r_px * r_px;
    let inner = (r_px * stroke.hardness.clamp(0.0, 1.0)).min((r_px - 1.0).max(0.0));
    let span = (r_px - inner).max(1e-6);
    let opacity = stroke.opacity.clamp(0.0, 1.0);

    let pts: Vec<[f64; 2]> = stroke.points.iter()
        .map(|p| [p[0] * w as f64, p[1] * h as f64])
        .collect();

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in &pts {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    let x0 = (min_x - r_px - 1.0).floor().max(0.0) as u32;
    let x1 = (max_x + r_px + 1.0).ceil().min((w - 1) as f64) as u32;
    let y0 = (min_y - r_px - 1.0).floor().max(0.0) as u32;
    let y1 = (max_y + r_px + 1.0).ceil().min((h - 1) as f64) as u32;
    if x0 > x1 || y0 > y1 {
        return;
    }

    for py in y0..=y1 {
        let fy = py as f64 + 0.5;
        for px in x0..=x1 {
            let fx = px as f64 + 0.5;
            let mut min_d2 = f64::INFINITY;
            if pts.len() == 1 {
                let dx = fx - pts[0][0];
                let dy = fy - pts[0][1];
                min_d2 = dx * dx + dy * dy;
            } else {
                for seg in pts.windows(2) {
                    let d2 = dist_to_segment_sq(fx, fy, seg[0][0], seg[0][1], seg[1][0], seg[1][1]);
                    if d2 < min_d2 {
                        min_d2 = d2;
                    }
                }
            }
            if min_d2 >= r_sq {
                continue;
            }
            let d = min_d2.sqrt();
            let cov = if d <= inner {
                1.0
            } else {
                let t = ((d - inner) / span).clamp(0.0, 1.0);
                0.5 * (1.0 + (t * std::f64::consts::PI).cos())
            };
            let factor = (1.0 - opacity * cov).clamp(0.0, 1.0);
            let p = img.get_pixel_mut(px, py);
            let new_a = (p[3] as f64 * factor).round() as u8;
            if new_a == 0 {
                p[0] = 0;
                p[1] = 0;
                p[2] = 0;
            }
            p[3] = new_a;
        }
    }
}

pub fn apply_erase_strokes(img: &mut RgbaImage, strokes: &[EraseStroke]) {
    for st in strokes {
        apply_erase_stroke(img, st);
    }
}

pub fn composite_overlay(base: &mut RgbaImage, overlay: &RgbaImage) {
    let (w, h) = (base.width().min(overlay.width()), base.height().min(overlay.height()));
    for y in 0..h {
        for x in 0..w {
            let op = *overlay.get_pixel(x, y);
            let oa = op[3] as u32;
            if oa == 0 { continue; }
            let p = base.get_pixel_mut(x, y);
            if oa == 255 {
                *p = op;
            } else {
                let ba = p[3] as u32;
                let inv = 255 - oa;
                let a = oa * 255 + ba * inv;
                if a > 0 {
                    p[0] = ((op[0] as u32 * oa * 255 + p[0] as u32 * ba * inv) / a) as u8;
                    p[1] = ((op[1] as u32 * oa * 255 + p[1] as u32 * ba * inv) / a) as u8;
                    p[2] = ((op[2] as u32 * oa * 255 + p[2] as u32 * ba * inv) / a) as u8;
                    p[3] = (a / 255) as u8;
                }
            }
        }
    }
}
