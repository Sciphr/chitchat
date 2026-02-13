use std::process::Command;
use serde::Serialize;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![detect_running_game])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
