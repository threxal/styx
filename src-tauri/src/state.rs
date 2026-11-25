use crate::config::Config;
use crate::imaging::ResizeCache;
use image::RgbaImage;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Deserialize)]
pub struct EraseStroke {
    pub points: Vec<[f64; 2]>,
    pub radius: f64,
    pub opacity: f64,
    pub hardness: f64,
}

pub struct Loaded {
    pub initial_path: PathBuf,
    pub orig: RgbaImage,
    pub nobg: Option<RgbaImage>,
    pub preview_src: RgbaImage,
    pub preview_masked: RgbaImage,
    pub erase_strokes: Vec<EraseStroke>,
    pub cache: ResizeCache,
    pub use_nobg: bool,
}

impl Loaded {
    pub fn active_full(&self) -> &RgbaImage {
        if self.use_nobg { self.nobg.as_ref().unwrap_or(&self.orig) } else { &self.orig }
    }
}

pub struct AppState {
    pub loaded: Option<Loaded>,
    pub config: Config,
}

impl AppState {
    pub fn new() -> Self {
        Self { loaded: None, config: Config::load() }
    }
}
