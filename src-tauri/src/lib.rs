use std::process::Command;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Serialize;
use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
#[serde(tag = "kind")]
enum GameDetection {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "known")]
    Known { game: String, executable: String },
}

fn game_process_catalog() -> Vec<(&'static str, &'static str)> {
    vec![
        ("haloinfinite.exe", "Halo Infinite"),
        ("mcc-win64-shipping.exe", "Halo: The Master Chief Collection"),
        ("cs2.exe", "Counter-Strike 2"),
        ("valorant-win64-shipping.exe", "VALORANT"),
        ("fortniteclient-win64-shipping.exe", "Fortnite"),
        ("r5apex.exe", "Apex Legends"),
        ("overwatch.exe", "Overwatch 2"),
        ("cod.exe", "Call of Duty"),
        ("eldenring.exe", "Elden Ring"),
        ("eldenring", "Elden Ring"),
        ("dota2.exe", "Dota 2"),
        ("dota2", "Dota 2"),
        ("league of legends.exe", "League of Legends"),
        ("rocketleague.exe", "Rocket League"),
        ("gta5.exe", "Grand Theft Auto V"),
        ("minecraft.exe", "Minecraft"),
        ("rustclient.exe", "Rust"),
        ("pubg-win64-shipping.exe", "PUBG: Battlegrounds"),
        ("rainbowsix.exe", "Rainbow Six Siege"),
        ("rainbowsix_vulkan.exe", "Rainbow Six Siege"),
        ("destiny2.exe", "Destiny 2"),
        ("wow.exe", "World of Warcraft"),
        ("ffxiv_dx11.exe", "Final Fantasy XIV"),
        ("osu!.exe", "osu!"),
    ]
}

fn process_names() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new("tasklist");
        command.args(["/fo", "csv", "/nh"]);
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                let mut names = Vec::new();
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let first_field = trimmed
                        .strip_prefix('"')
                        .and_then(|rest| rest.split("\",").next())
                        .unwrap_or(trimmed);
                    names.push(first_field.to_lowercase());
                }
                return names;
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let output = Command::new("ps").args(["-eo", "comm="]).output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                return text
                    .lines()
                    .map(|line| line.trim().to_lowercase())
                    .filter(|line| !line.is_empty())
                    .collect();
            }
        }
    }

    Vec::new()
}

#[tauri::command]
fn detect_running_game() -> GameDetection {
    let running = process_names();
    if running.is_empty() {
        return GameDetection::None;
    }

    let catalog = game_process_catalog();
    for (process_name, game_title) in catalog {
        if running.iter().any(|name| name == process_name) {
            return GameDetection::Known {
                game: game_title.to_string(),
                executable: process_name.to_string(),
            };
        }
    }

    GameDetection::None
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum RemoteControlInputEvent {
    #[serde(rename = "pointer_move")]
    PointerMove {
        #[serde(rename = "xNorm")]
        x_norm: f64,
        #[serde(rename = "yNorm")]
        y_norm: f64,
    },
    #[serde(rename = "pointer_down")]
    PointerDown { button: String },
    #[serde(rename = "pointer_up")]
    PointerUp { button: String },
    #[serde(rename = "wheel")]
    Wheel {
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    #[serde(rename = "key_down")]
    KeyDown { key: String },
    #[serde(rename = "key_up")]
    KeyUp { key: String },
}

fn to_mouse_button(name: &str) -> Option<Button> {
    match name {
        "left" => Some(Button::Left),
        "right" => Some(Button::Right),
        "middle" => Some(Button::Middle),
        _ => None,
    }
}

fn to_key(name: &str) -> Key {
    match name {
        "Enter" => Key::Return,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Space" | " " => Key::Space,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        _ => {
            if name.chars().count() == 1 {
                Key::Unicode(name.chars().next().unwrap_or(' '))
            } else {
                Key::Unicode(' ')
            }
        }
    }
}

#[tauri::command]
fn apply_remote_control_input(
    app_handle: tauri::AppHandle,
    event: RemoteControlInputEvent,
) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    match event {
        RemoteControlInputEvent::PointerMove { x_norm, y_norm } => {
            let monitor = app_handle
                .primary_monitor()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "No primary monitor available".to_string())?;
            let size = monitor.size();
            let position = monitor.position();
            let max_x = (size.width.saturating_sub(1)) as f64;
            let max_y = (size.height.saturating_sub(1)) as f64;
            let x = position.x + (x_norm.clamp(0.0, 1.0) * max_x).round() as i32;
            let y = position.y + (y_norm.clamp(0.0, 1.0) * max_y).round() as i32;
            enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| e.to_string())?;
        }
        RemoteControlInputEvent::PointerDown { button } => {
            if let Some(btn) = to_mouse_button(&button) {
                enigo
                    .button(btn, Direction::Press)
                    .map_err(|e| e.to_string())?;
            }
        }
        RemoteControlInputEvent::PointerUp { button } => {
            if let Some(btn) = to_mouse_button(&button) {
                enigo
                    .button(btn, Direction::Release)
                    .map_err(|e| e.to_string())?;
            }
        }
        RemoteControlInputEvent::Wheel { delta_y } => {
            let steps = (delta_y / 60.0).round() as i32;
            if steps != 0 {
                enigo
                    .scroll(steps, Axis::Vertical)
                    .map_err(|e| e.to_string())?;
            }
        }
        RemoteControlInputEvent::KeyDown { key } => {
            enigo
                .key(to_key(&key), Direction::Press)
                .map_err(|e| e.to_string())?;
        }
        RemoteControlInputEvent::KeyUp { key } => {
            enigo
                .key(to_key(&key), Direction::Release)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Update the system tray tooltip with the unread message count.
#[tauri::command]
fn set_tray_badge(app: tauri::AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let tooltip = if count > 0 {
            format!("ChitChat ({} unread)", count)
        } else {
            "ChitChat".to_string()
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "Quit ChitChat", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open ChitChat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("ChitChat")
                .on_menu_event(|app: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_running_game,
            apply_remote_control_input,
            set_tray_badge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
