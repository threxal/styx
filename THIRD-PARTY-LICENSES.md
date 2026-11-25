# Third-Party Licenses

## BRIA RMBG 2.0 (model weights)
Background removal is powered by the BRIA RMBG 2.0 model.
License: Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0).
Commercial use requires a separate agreement with BRIA.
https://huggingface.co/briaai/RMBG-2.0
https://creativecommons.org/licenses/by-nc/4.0/

## ONNX Runtime (via `ort`)
Inference runtime for the ONNX model. MIT License.
https://github.com/microsoft/onnxruntime
https://github.com/pykeio/ort

## rembg
The model session semantics (pre/post-processing) follow rembg.
MIT License. https://github.com/danielgatis/rembg

## Tauri
Application shell (Rust + WebView). MIT / Apache-2.0.
https://github.com/tauri-apps/tauri

## Rust crates
image (MIT), fast_image_resize (MIT), oxipng (MIT),
serde / serde_json (MIT / Apache-2.0), reqwest (MIT / Apache-2.0),
sha2 (MIT / Apache-2.0), kamadak-exif (BSD-2-Clause).

## Frontend
No external JS runtime dependencies beyond @tauri-apps/* (MIT / Apache-2.0).

## HEIC / HEIF decoding
HEIC and HEIF files are decoded by the macOS system image converter
(`sips` / ImageIO). No third-party HEVC codec is bundled or
redistributed with this application; decoding relies on codecs
licensed and shipped by Apple as part of macOS.

## Bundled Fonts (SIL Open Font License 1.1)

The following fonts are bundled with Styx under the SIL Open Font License, Version 1.1:
- **Montserrat** by Julieta Ulanovsky, Sol Matas, Juan Pablo del Peral
- **Oswald** (Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont))
- **Lora** by Cyreal
- **Comfortaa** by Johan Aakerlund, Cyreal
- **Caveat** by Impallari Type
- **Lobster** by Pablo Impallari
- **Poiret One** (Copyright 2011 The Poiret One Project Authors (https://github.com/alexeiva/poiretone))
- **Press Start 2P** (Copyright 2012 The Press Start 2P Project Authors (cody@zone38.net), with Reserved Font Name "Press Start 2P".)

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the OFL-1.1 license terms.
