use std::process::Command;
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind")]
enum GameDetection {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "known")]
    Known { game: String, executable: String },
    #[serde(rename = "unknown")]
    Unknown { executable: String, suggested_name: String },
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

fn unknown_game_hints() -> Vec<&'static str> {
    vec![
        "shipping",
        "game",
        "client",
        "battle",
        "racing",
        "shooter",
        "survivor",
        "quest",
        "halo",
        "cod",
        "cs2",
        "valorant",
        "fortnite",
        "apex",
        "elden",
        "rocket",
        "league",
        "dota",
        "gta",
        "destiny",
        "minecraft",
        "rainbow",
        "overwatch",
        "wow",
        "ffxiv",
        "pubg",
    ]
}

fn non_game_processes() -> Vec<&'static str> {
    vec![
        "system",
        "registry",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "services.exe",
        "lsass.exe",
        "svchost.exe",
        "dwm.exe",
        "explorer.exe",
        "taskhostw.exe",
        "searchhost.exe",
        "shellexperiencehost.exe",
        "runtimebroker.exe",
        "startmenuexperiencehost.exe",
        "powershell.exe",
        "cmd.exe",
        "conhost.exe",
        "wmiapsrv.exe",
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "opera.exe",
        "discord.exe",
        "slack.exe",
        "teams.exe",
        "notion.exe",
        "spotify.exe",
        "code.exe",
        "devenv.exe",
        "idea64.exe",
        "webstorm64.exe",
        "node.exe",
        "python.exe",
        "pythonw.exe",
        "git.exe",
        "steam.exe",
        "steamwebhelper.exe",
        "epicgameslauncher.exe",
        "riotclientservices.exe",
        "riotclientux.exe",
        "battle.net.exe",
        "ubisoftconnect.exe",
        "eadesktop.exe",
        "updater.exe",
        "launcher.exe",
        "chitchat-temp.exe",
        "chitchat.exe",
    ]
}

fn clean_executable_name(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn to_title_case(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn suggested_name_from_executable(executable: &str) -> String {
    let without_ext = executable.trim_end_matches(".exe");
    let normalized = without_ext
        .replace('-', " ")
        .replace('_', " ")
        .replace('.', " ")
        .replace("win64", "")
        .replace("win32", "")
        .replace("shipping", "")
        .replace("client", "")
        .replace("launcher", "")
        .replace("game", "")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    let candidate = normalized.trim();
    if candidate.is_empty() {
        "Unknown Game".to_string()
    } else {
        to_title_case(candidate)
    }
}

fn detect_unknown_game(running: &[String], known_processes: &[String]) -> Option<String> {
    let non_game = non_game_processes();
    let hints = unknown_game_hints();
    for name in running {
        let executable = clean_executable_name(name);
        if !executable.ends_with(".exe") {
            continue;
        }
        if known_processes.iter().any(|known| known == &executable) {
            continue;
        }
        if non_game.iter().any(|skip| executable == *skip) {
            continue;
        }
        if executable.contains("helper")
            || executable.contains("service")
            || executable.contains("host")
            || executable.contains("webview")
            || executable.contains("crash")
            || executable.contains("report")
            || executable.contains("updater")
            || executable.contains("installer")
        {
            continue;
        }
        if hints.iter().any(|hint| executable.contains(hint)) {
            return Some(executable);
        }
    }
    None
}

fn process_names() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("tasklist")
            .args(["/fo", "csv", "/nh"])
            .output();
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
    let known_processes = catalog
        .iter()
        .map(|(process_name, _)| process_name.to_string())
        .collect::<Vec<String>>();

    for (process_name, game_title) in catalog {
        if running.iter().any(|name| name == process_name) {
            return GameDetection::Known {
                game: game_title.to_string(),
                executable: process_name.to_string(),
            };
        }
    }

    if let Some(executable) = detect_unknown_game(&running, &known_processes) {
        return GameDetection::Unknown {
            suggested_name: suggested_name_from_executable(&executable),
            executable,
        };
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
