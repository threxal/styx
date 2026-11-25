mod commands;
mod inference;
mod model;
mod config;
mod imaging;
mod state;

use std::sync::Mutex;
use state::AppState;
#[cfg(target_os = "macos")]
use tauri::Emitter;

#[tauri::command]
fn app_version() -> String {
    commands::display_version()
}

pub fn run() {
    model::cleanup_partial();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState::new()))
        .manage(std::sync::Arc::new(Mutex::new(None::<ort::session::Session>)))
        .manage(model::DlCancel(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))))
        .manage(model::RmCancel(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))))
        .manage(model::ActiveRun(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            app_version,
            commands::initial_state,
            commands::load_image,
            commands::render_preview,
            commands::save_sticker,
            commands::export_original,
            commands::clear_image,
            commands::set_output_dir,
            commands::set_theme,
            commands::model_status,
            commands::download_model,
            commands::cancel_download,
            commands::remove_bg,
            commands::restore_bg,
            commands::cancel_remove,
            commands::erase_stroke,
            commands::erase_undo,
            commands::erase_reset,
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            let about = MenuItem::with_id(app, "about", "About Styx", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings\u{2026}", true, None::<&str>)?;
            let help = MenuItem::with_id(app, "help", "Styx Help", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;
            let hide = PredefinedMenuItem::hide(app, None::<&str>)?;
            let hide_others = PredefinedMenuItem::hide_others(app, None::<&str>)?;
            let show_all = PredefinedMenuItem::show_all(app, None::<&str>)?;
            let quit = PredefinedMenuItem::quit(app, None::<&str>)?;
            let app_menu = Submenu::with_items(app, "Styx", true, &[
                &about, &sep1, &settings, &sep2, &hide, &hide_others, &show_all, &sep3, &quit,
            ])?;
            let minimize = PredefinedMenuItem::minimize(app, None::<&str>)?;
            let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;
            let close = PredefinedMenuItem::close_window(app, None::<&str>)?;
            let fullscreen = PredefinedMenuItem::fullscreen(app, None::<&str>)?;
            let wsep1 = PredefinedMenuItem::separator(app)?;
            let wsep2 = PredefinedMenuItem::separator(app)?;
            let window_menu = Submenu::with_items(app, "Window", true, &[
                &minimize, &zoom, &wsep1, &close, &wsep2, &fullscreen,
            ])?;
            let help_menu = Submenu::with_items(app, "Help", true, &[&help])?;
            Menu::with_items(app, &[&app_menu, &window_menu, &help_menu])
        })
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "about" => { let _ = app.emit("menu://action", "about"); }
                "settings" => { let _ = app.emit("menu://action", "settings"); }
                "help" => { let _ = app.emit("menu://action", "help"); }
                _ => {}
            }
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Styx");
}
