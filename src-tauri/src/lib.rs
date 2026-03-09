use std::collections::VecDeque;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::JoinHandle as ThreadJoinHandle;
use std::time::Duration;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use libwebrtc::{
    audio_source::native::NativeAudioSource,
    desktop_capturer::{
        CaptureSource, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions,
    },
    prelude::{
        AudioFrame, AudioSourceOptions, I420Buffer, RtcAudioSource, RtcVideoSource, VideoFrame,
        VideoRotation,
    },
    video_source::{native::NativeVideoSource, VideoResolution},
};
use livekit::{
    options::{AudioEncoding, TrackPublishOptions, VideoCodec, VideoEncoding},
    prelude::{LocalTrack, Room, RoomOptions, TrackSource},
    track::{LocalAudioTrack, LocalVideoTrack},
};
#[cfg(target_os = "windows")]
use nnnoiseless::DenoiseState;
use serde::Deserialize;
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State, Wry,
};
use tokio::{sync::watch, task::JoinHandle};
#[cfg(target_os = "windows")]
use wasapi::{
    initialize_mta, DeviceEnumerator, Direction as AudioDirection, SampleType, StreamMode,
    WaveFormat,
};

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
        (
            "mcc-win64-shipping.exe",
            "Halo: The Master Chief Collection",
        ),
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

fn blend_pixel(rgba: &mut [u8], width: u32, height: u32, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let idx = ((y as u32 * width + x as u32) * 4) as usize;
    if idx + 3 >= rgba.len() {
        return;
    }
    let alpha = color[3] as u16;
    let inv_alpha = 255u16.saturating_sub(alpha);
    for channel in 0..3 {
        rgba[idx + channel] =
            ((color[channel] as u16 * alpha + rgba[idx + channel] as u16 * inv_alpha) / 255) as u8;
    }
    rgba[idx + 3] = 255;
}

fn fill_rect(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    left: i32,
    top: i32,
    rect_width: i32,
    rect_height: i32,
    color: [u8; 4],
) {
    for y in top..top + rect_height {
        for x in left..left + rect_width {
            blend_pixel(rgba, width, height, x, y, color);
        }
    }
}

fn fill_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: [u8; 4],
) {
    let radius_sq = radius * radius;
    for y in center_y - radius..=center_y + radius {
        for x in center_x - radius..=center_x + radius {
            let dx = x - center_x;
            let dy = y - center_y;
            if dx * dx + dy * dy <= radius_sq {
                blend_pixel(rgba, width, height, x, y, color);
            }
        }
    }
}

fn badge_glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b010, 0b010, 0b111, 0b010, 0b010],
        _ => [0, 0, 0, 0, 0],
    }
}

fn draw_badge_glyph(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    left: i32,
    top: i32,
    scale: i32,
    ch: char,
    color: [u8; 4],
) {
    let glyph = badge_glyph(ch);
    for (row_idx, row_bits) in glyph.iter().enumerate() {
        for col_idx in 0..3usize {
            if row_bits & (1 << (2 - col_idx)) != 0 {
                fill_rect(
                    rgba,
                    width,
                    height,
                    left + col_idx as i32 * scale,
                    top + row_idx as i32 * scale,
                    scale,
                    scale,
                    color,
                );
            }
        }
    }
}

fn make_badged_icon(base_icon: &Image<'_>, count: u32) -> Image<'static> {
    let mut rgba = base_icon.rgba().to_vec();
    let width = base_icon.width();
    let height = base_icon.height();
    if count == 0 {
        return Image::new_owned(rgba, width, height);
    }

    let badge_text = if count > 99 {
        "99+".to_string()
    } else {
        count.to_string()
    };
    let min_side = width.min(height) as i32;
    let scale = (min_side / 28).max(1);
    let text_width =
        (badge_text.chars().count() as i32 * 3 + (badge_text.len() as i32 - 1)) * scale;
    let text_height = 5 * scale;
    let padding = 3 * scale;
    let radius = ((text_width.max(text_height) + padding * 2) / 2).max(6 * scale);
    let center_x = width as i32 - radius - 2 * scale;
    let center_y = radius + 2 * scale;

    fill_circle(
        &mut rgba,
        width,
        height,
        center_x,
        center_y,
        radius,
        [220, 38, 38, 255],
    );

    let text_left = center_x - text_width / 2;
    let text_top = center_y - text_height / 2;
    for (idx, ch) in badge_text.chars().enumerate() {
        let glyph_left = text_left + idx as i32 * 4 * scale;
        draw_badge_glyph(
            &mut rgba,
            width,
            height,
            glyph_left,
            text_top,
            scale,
            ch,
            [255, 255, 255, 255],
        );
    }

    Image::new_owned(rgba, width, height)
}

fn apply_desktop_unread_badge(app: &tauri::AppHandle, count: u32) {
    let tooltip = if count > 0 {
        format!("ChitChat ({} unread)", count)
    } else {
        "ChitChat".to_string()
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }

    let Some(base_icon) = app.default_window_icon() else {
        return;
    };

    let next_icon = if count > 0 {
        make_badged_icon(base_icon, count)
    } else {
        base_icon.clone().to_owned()
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(next_icon.clone()));
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_icon(next_icon);
    }
}

struct DesktopTrayHandles {
    open_home: MenuItem<Wry>,
    voice_mute: CheckMenuItem<Wry>,
    voice_deafen: CheckMenuItem<Wry>,
    voice_disconnect: MenuItem<Wry>,
    status_online: CheckMenuItem<Wry>,
    status_away: CheckMenuItem<Wry>,
    status_dnd: CheckMenuItem<Wry>,
    status_offline: CheckMenuItem<Wry>,
    check_updates: MenuItem<Wry>,
}

#[derive(Default)]
struct DesktopTrayState {
    handles: Mutex<Option<DesktopTrayHandles>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrayVoiceState {
    connected: bool,
    muted: bool,
    deafened: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrayStatusState {
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrayHomeServerState {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrayUpdateState {
    label: String,
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTrayActionPayload {
    action: String,
    value: Option<String>,
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn emit_desktop_tray_action(app: &tauri::AppHandle, action: &str, value: Option<&str>) {
    let payload = DesktopTrayActionPayload {
        action: action.to_string(),
        value: value.map(|entry| entry.to_string()),
    };
    let _ = app.emit("desktop-tray-action", payload);
}

fn with_desktop_tray_handles<F>(tray_state: &State<DesktopTrayState>, mut apply: F)
where
    F: FnMut(&DesktopTrayHandles),
{
    if let Ok(guard) = tray_state.handles.lock() {
        if let Some(handles) = guard.as_ref() {
            apply(handles);
        }
    }
}

/// Update the desktop unread indicator with the unread message count.
#[tauri::command]
fn set_desktop_unread_badge(app: tauri::AppHandle, count: u32) {
    apply_desktop_unread_badge(&app, count);
}

#[tauri::command]
fn set_desktop_tray_voice_state(tray_state: State<DesktopTrayState>, state: DesktopTrayVoiceState) {
    with_desktop_tray_handles(&tray_state, |handles| {
        let _ = handles.voice_mute.set_enabled(state.connected);
        let _ = handles
            .voice_mute
            .set_checked(state.connected && state.muted);
        let _ = handles.voice_deafen.set_enabled(state.connected);
        let _ = handles
            .voice_deafen
            .set_checked(state.connected && state.deafened);
        let _ = handles.voice_disconnect.set_enabled(state.connected);
    });
}

#[tauri::command]
fn set_desktop_tray_status_state(
    tray_state: State<DesktopTrayState>,
    state: DesktopTrayStatusState,
) {
    with_desktop_tray_handles(&tray_state, |handles| {
        let normalized = state.status.trim().to_lowercase();
        let _ = handles.status_online.set_checked(normalized == "online");
        let _ = handles.status_away.set_checked(normalized == "away");
        let _ = handles.status_dnd.set_checked(normalized == "dnd");
        let _ = handles.status_offline.set_checked(normalized == "offline");
    });
}

#[tauri::command]
fn set_desktop_tray_home_server(
    tray_state: State<DesktopTrayState>,
    state: DesktopTrayHomeServerState,
) {
    with_desktop_tray_handles(&tray_state, |handles| {
        let trimmed = state.name.trim();
        let label = if trimmed.is_empty() {
            "Open Home Server".to_string()
        } else {
            format!("Open {}", trimmed)
        };
        let _ = handles.open_home.set_text(label);
    });
}

#[tauri::command]
fn set_desktop_tray_update_state(
    tray_state: State<DesktopTrayState>,
    state: DesktopTrayUpdateState,
) {
    with_desktop_tray_handles(&tray_state, |handles| {
        let label = if state.label.trim().is_empty() {
            "Check for Updates".to_string()
        } else {
            state.label.clone()
        };
        let _ = handles.check_updates.set_text(label);
        let _ = handles.check_updates.set_enabled(state.enabled);
    });
}

#[derive(Clone, Serialize)]
struct NativeScreenShareSource {
    id: u64,
    kind: String,
    title: String,
}

#[derive(Clone, Deserialize)]
struct NativeScreenShareSourceSelection {
    id: u64,
    kind: String,
}

#[derive(Clone, Deserialize)]
struct NativeScreenShareStartOptions {
    #[serde(rename = "livekitUrl")]
    livekit_url: String,
    token: String,
    source: Option<NativeScreenShareSourceSelection>,
    resolution: String,
    fps: u32,
}

#[derive(Clone, Serialize)]
struct NativeAudioInputDevice {
    id: String,
    label: String,
}

#[derive(Clone, Deserialize)]
struct NativeMicrophoneStartOptions {
    #[serde(rename = "livekitUrl")]
    livekit_url: String,
    token: String,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "noiseSuppressionMode")]
    noise_suppression_mode: String,
    #[serde(rename = "inputSensitivity")]
    input_sensitivity: f32,
    #[serde(rename = "startMuted")]
    start_muted: bool,
}

#[derive(Clone)]
struct CapturedFrame {
    width: u32,
    height: u32,
    stride: usize,
    data: Vec<u8>,
}

impl CapturedFrame {
    fn to_video_frame(&self, out_width: u32, out_height: u32) -> VideoFrame<I420Buffer> {
        let mut buffer = I420Buffer::new(out_width, out_height);
        fill_i420_from_bgra_scaled(
            &self.data,
            self.width,
            self.height,
            self.stride,
            out_width,
            out_height,
            &mut buffer,
        );
        VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: 0,
            buffer,
        }
    }
}

struct NativeScreenShareSession {
    room: Room,
    capture_task: JoinHandle<()>,
    audio_task: Option<JoinHandle<()>>,
    audio_thread: Option<ThreadJoinHandle<()>>,
    stop_tx: watch::Sender<bool>,
}

#[derive(Default)]
struct NativeScreenShareManager {
    session: Mutex<Option<NativeScreenShareSession>>,
}

struct NativeMicrophoneSession {
    room: Room,
    track: LocalAudioTrack,
    audio_task: JoinHandle<()>,
    capture_thread: ThreadJoinHandle<()>,
    stop_tx: watch::Sender<bool>,
    muted: Arc<AtomicBool>,
}

#[derive(Default)]
struct NativeMicrophoneManager {
    session: Mutex<Option<NativeMicrophoneSession>>,
}

fn clamp_byte(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn sample_bgra(
    data: &[u8],
    stride: usize,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> (u8, u8, u8) {
    let src_x = x.min(width.saturating_sub(1)) as usize;
    let src_y = y.min(height.saturating_sub(1)) as usize;
    let offset = src_y
        .saturating_mul(stride)
        .saturating_add(src_x.saturating_mul(4));
    if offset + 2 >= data.len() {
        return (0, 0, 0);
    }
    let b = data[offset];
    let g = data[offset + 1];
    let r = data[offset + 2];
    (r, g, b)
}

fn rgb_to_y(r: u8, g: u8, b: u8) -> u8 {
    clamp_byte(((66 * r as i32 + 129 * g as i32 + 25 * b as i32 + 128) >> 8) + 16)
}

fn rgb_to_u(r: u8, g: u8, b: u8) -> u8 {
    clamp_byte(((-38 * r as i32 - 74 * g as i32 + 112 * b as i32 + 128) >> 8) + 128)
}

fn rgb_to_v(r: u8, g: u8, b: u8) -> u8 {
    clamp_byte(((112 * r as i32 - 94 * g as i32 - 18 * b as i32 + 128) >> 8) + 128)
}

fn fill_i420_from_bgra_scaled(
    data: &[u8],
    src_width: u32,
    src_height: u32,
    src_stride: usize,
    dst_width: u32,
    dst_height: u32,
    buffer: &mut I420Buffer,
) {
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (dst_y, dst_u, dst_v) = buffer.data_mut();

    for y in 0..dst_height {
        let src_y = ((y as f64 + 0.5) * src_height as f64 / dst_height as f64).floor() as u32;
        let y_row = y as usize * stride_y as usize;
        for x in 0..dst_width {
            let src_x = ((x as f64 + 0.5) * src_width as f64 / dst_width as f64).floor() as u32;
            let (r, g, b) = sample_bgra(data, src_stride, src_width, src_height, src_x, src_y);
            dst_y[y_row + x as usize] = rgb_to_y(r, g, b);
        }
    }

    let chroma_width = dst_width.div_ceil(2);
    let chroma_height = dst_height.div_ceil(2);
    for y in 0..chroma_height {
        let u_row = y as usize * stride_u as usize;
        let v_row = y as usize * stride_v as usize;
        for x in 0..chroma_width {
            let mut r_sum = 0i32;
            let mut g_sum = 0i32;
            let mut b_sum = 0i32;
            let mut samples = 0i32;

            for dy in 0..2 {
                for dx in 0..2 {
                    let dst_px = (x * 2 + dx).min(dst_width.saturating_sub(1));
                    let dst_py = (y * 2 + dy).min(dst_height.saturating_sub(1));
                    let src_x = ((dst_px as f64 + 0.5) * src_width as f64 / dst_width as f64)
                        .floor() as u32;
                    let src_y = ((dst_py as f64 + 0.5) * src_height as f64 / dst_height as f64)
                        .floor() as u32;
                    let (r, g, b) =
                        sample_bgra(data, src_stride, src_width, src_height, src_x, src_y);
                    r_sum += r as i32;
                    g_sum += g as i32;
                    b_sum += b as i32;
                    samples += 1;
                }
            }

            let r = (r_sum / samples) as u8;
            let g = (g_sum / samples) as u8;
            let b = (b_sum / samples) as u8;
            dst_u[u_row + x as usize] = rgb_to_u(r, g, b);
            dst_v[v_row + x as usize] = rgb_to_v(r, g, b);
        }
    }
}

fn resolution_bounds(preset: &str) -> (u32, u32) {
    match preset {
        "360p" => (640, 360),
        "480p" => (854, 480),
        "720p" => (1280, 720),
        "1080p" => (1920, 1080),
        "1440p" => (2560, 1440),
        "4k" => (3840, 2160),
        _ => (1280, 720),
    }
}

fn normalize_even(value: u32) -> u32 {
    let value = value.max(2);
    if value % 2 == 0 {
        value
    } else {
        value - 1
    }
}

fn fit_capture_dimensions(src_width: u32, src_height: u32, preset: &str) -> (u32, u32) {
    let (max_width, max_height) = resolution_bounds(preset);
    let scale = f64::min(
        1.0,
        f64::min(
            max_width as f64 / src_width.max(1) as f64,
            max_height as f64 / src_height.max(1) as f64,
        ),
    );
    let fitted_width = normalize_even((src_width as f64 * scale).round() as u32);
    let fitted_height = normalize_even((src_height as f64 * scale).round() as u32);
    (fitted_width.max(2), fitted_height.max(2))
}

fn native_screenshare_bitrate(preset: &str, fps: u32) -> u64 {
    let motion_heavy = fps >= 45;
    match (preset, motion_heavy) {
        ("360p", true) => 1_800_000,
        ("480p", true) => 2_800_000,
        ("720p", true) => 5_500_000,
        ("1080p", true) => 10_000_000,
        ("1440p", true) => 16_000_000,
        ("4k", true) => 28_000_000,
        ("360p", false) => 800_000,
        ("480p", false) => 1_400_000,
        ("720p", false) => 2_500_000,
        ("1080p", false) => 5_000_000,
        ("1440p", false) => 8_000_000,
        ("4k", false) => 14_000_000,
        _ if motion_heavy => 5_500_000,
        _ => 2_500_000,
    }
}

#[cfg(target_os = "windows")]
fn list_native_audio_input_devices_inner() -> Result<Vec<NativeAudioInputDevice>, String> {
    initialize_mta().ok().map_err(|err| err.to_string())?;
    let enumerator = DeviceEnumerator::new().map_err(|err| err.to_string())?;
    let devices = enumerator
        .get_device_collection(&AudioDirection::Capture)
        .map_err(|err| err.to_string())?;
    let mut result = Vec::new();
    for device in (&devices).into_iter().flatten() {
        result.push(NativeAudioInputDevice {
            id: device.get_id().map_err(|err| err.to_string())?,
            label: device.get_friendlyname().map_err(|err| err.to_string())?,
        });
    }
    Ok(result)
}

#[cfg(not(target_os = "windows"))]
fn list_native_audio_input_devices_inner() -> Result<Vec<NativeAudioInputDevice>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn resolve_capture_device(
    enumerator: &DeviceEnumerator,
    device_id: Option<&str>,
) -> Result<wasapi::Device, String> {
    if let Some(device_id) = device_id {
        if !device_id.is_empty() {
            if let Ok(device) = enumerator.get_device(device_id) {
                return Ok(device);
            }
        }
    }
    enumerator
        .get_default_device(&AudioDirection::Capture)
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn start_native_microphone_capture(
    rtc_source: NativeAudioSource,
    mode: String,
    input_sensitivity: f32,
    device_id: Option<String>,
    muted: Arc<AtomicBool>,
    stop_rx: watch::Receiver<bool>,
) -> Result<(JoinHandle<()>, ThreadJoinHandle<()>), String> {
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u32 = 1;
    const SAMPLES_PER_CHANNEL: usize = 480;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    let mut task_stop_rx = stop_rx.clone();
    let audio_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = task_stop_rx.changed() => {
                    if changed.is_err() || *task_stop_rx.borrow() {
                        break;
                    }
                }
                maybe_chunk = rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break; };
                    let frame = AudioFrame {
                        data: chunk.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: CHANNELS,
                        samples_per_channel: SAMPLES_PER_CHANNEL as u32,
                    };
                    let _ = rtc_source.capture_frame(&frame).await;
                }
            }
        }
    });

    let audio_thread = std::thread::Builder::new()
        .name("native-microphone-capture".to_string())
        .spawn(move || {
            if initialize_mta().is_err() {
                return;
            }

            let enumerator = match DeviceEnumerator::new() {
                Ok(value) => value,
                Err(_) => return,
            };
            let device = match resolve_capture_device(&enumerator, device_id.as_deref()) {
                Ok(value) => value,
                Err(_) => return,
            };
            let mut audio_client = match device.get_iaudioclient() {
                Ok(value) => value,
                Err(_) => return,
            };
            let desired_format = WaveFormat::new(
                32,
                32,
                &SampleType::Float,
                SAMPLE_RATE as usize,
                CHANNELS as usize,
                None,
            );
            let (_, min_time) = match audio_client.get_device_period() {
                Ok(value) => value,
                Err(_) => return,
            };
            let mode_config = StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time,
            };
            if audio_client
                .initialize_client(&desired_format, &AudioDirection::Capture, &mode_config)
                .is_err()
            {
                return;
            }

            let h_event = match audio_client.set_get_eventhandle() {
                Ok(value) => value,
                Err(_) => return,
            };
            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(value) => value,
                Err(_) => return,
            };
            if audio_client.start_stream().is_err() {
                return;
            }

            let mut local_stop_rx = stop_rx;
            let mut byte_queue: VecDeque<u8> = VecDeque::new();
            let chunk_bytes = SAMPLES_PER_CHANNEL * 4;
            let mut denoiser = DenoiseState::new();
            let mut rnnoise_output = [0.0f32; DenoiseState::FRAME_SIZE];
            let close_threshold = input_sensitivity.clamp(0.004, 0.12);
            let open_threshold = close_threshold * 1.2;
            let close_frames = 18usize;
            let use_rnnoise = mode == "rnnoise";
            let mut gate_open = true;
            let mut below_frames = 0usize;

            loop {
                if *local_stop_rx.borrow() {
                    let _ = audio_client.stop_stream();
                    break;
                }

                let new_frames = match capture_client.get_next_packet_size() {
                    Ok(Some(value)) => value,
                    Ok(None) => 0,
                    Err(_) => {
                        let _ = audio_client.stop_stream();
                        break;
                    }
                };
                if new_frames > 0 {
                    let additional = (new_frames as usize * 4)
                        .saturating_sub(byte_queue.capacity().saturating_sub(byte_queue.len()));
                    byte_queue.reserve(additional);
                    if capture_client
                        .read_from_device_to_deque(&mut byte_queue)
                        .is_err()
                    {
                        let _ = audio_client.stop_stream();
                        break;
                    }
                }

                while byte_queue.len() >= chunk_bytes {
                    let mut processed = vec![0.0f32; SAMPLES_PER_CHANNEL];
                    for sample in &mut processed {
                        let b0 = byte_queue.pop_front().unwrap_or_default();
                        let b1 = byte_queue.pop_front().unwrap_or_default();
                        let b2 = byte_queue.pop_front().unwrap_or_default();
                        let b3 = byte_queue.pop_front().unwrap_or_default();
                        *sample = f32::from_le_bytes([b0, b1, b2, b3]).clamp(-1.0, 1.0);
                    }
                    let rms = processed.iter().map(|sample| sample * sample).sum::<f32>()
                        / (SAMPLES_PER_CHANNEL as f32);
                    let rms = rms.sqrt();

                    if rms >= open_threshold {
                        gate_open = true;
                        below_frames = 0;
                    } else if rms <= close_threshold {
                        below_frames = below_frames.saturating_add(1);
                        if below_frames >= close_frames {
                            gate_open = false;
                        }
                    } else {
                        below_frames = 0;
                    }

                    let mut pcm = vec![0i16; SAMPLES_PER_CHANNEL];
                    if !muted.load(Ordering::Relaxed) && gate_open {
                        if use_rnnoise {
                            let mut rnnoise_input = [0.0f32; DenoiseState::FRAME_SIZE];
                            for (index, sample) in
                                processed.iter().enumerate().take(SAMPLES_PER_CHANNEL)
                            {
                                rnnoise_input[index] = sample.clamp(-1.0, 1.0) * 32768.0;
                            }
                            denoiser.process_frame(&mut rnnoise_output, &rnnoise_input);
                            for (index, out_sample) in rnnoise_output.iter().enumerate() {
                                pcm[index] = out_sample.clamp(-32768.0, 32767.0) as i16;
                            }
                        } else {
                            for (index, sample) in
                                processed.iter().enumerate().take(SAMPLES_PER_CHANNEL)
                            {
                                pcm[index] = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
                            }
                        }
                    }

                    if tx.send(pcm).is_err() {
                        let _ = audio_client.stop_stream();
                        return;
                    }
                }

                if h_event.wait_for_event(1000).is_err() {
                    let _ = audio_client.stop_stream();
                    break;
                }
                if local_stop_rx.has_changed().unwrap_or(false) {
                    let _ = local_stop_rx.borrow_and_update();
                }
            }
        })
        .map_err(|err| err.to_string())?;

    Ok((audio_task, audio_thread))
}

#[cfg(not(target_os = "windows"))]
fn start_native_microphone_capture(
    _rtc_source: NativeAudioSource,
    _mode: String,
    _input_sensitivity: f32,
    _device_id: Option<String>,
    _muted: Arc<AtomicBool>,
    _stop_rx: watch::Receiver<bool>,
) -> Result<(JoinHandle<()>, ThreadJoinHandle<()>), String> {
    Err("Native microphone processing is currently available on Windows only".to_string())
}

#[cfg(target_os = "windows")]
fn start_loopback_audio_capture(
    rtc_source: NativeAudioSource,
    stop_rx: watch::Receiver<bool>,
) -> Result<(JoinHandle<()>, ThreadJoinHandle<()>), String> {
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u32 = 2;
    const SAMPLES_PER_CHANNEL: usize = 480;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    let mut task_stop_rx = stop_rx.clone();
    let audio_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = task_stop_rx.changed() => {
                    if changed.is_err() || *task_stop_rx.borrow() {
                        break;
                    }
                }
                maybe_chunk = rx.recv() => {
                    let Some(chunk) = maybe_chunk else { break; };
                    let frame = AudioFrame {
                        data: chunk.into(),
                        sample_rate: SAMPLE_RATE,
                        num_channels: CHANNELS,
                        samples_per_channel: SAMPLES_PER_CHANNEL as u32,
                    };
                    let _ = rtc_source.capture_frame(&frame).await;
                }
            }
        }
    });

    let thread_stop_rx = stop_rx;
    let audio_thread = std::thread::Builder::new()
        .name("native-screen-share-audio".to_string())
        .spawn(move || {
            if initialize_mta().is_err() {
                return;
            }

            let enumerator = match DeviceEnumerator::new() {
                Ok(value) => value,
                Err(_) => return,
            };
            let device = match enumerator.get_default_device(&AudioDirection::Render) {
                Ok(value) => value,
                Err(_) => return,
            };
            let mut audio_client = match device.get_iaudioclient() {
                Ok(value) => value,
                Err(_) => return,
            };
            let desired_format = WaveFormat::new(
                16,
                16,
                &SampleType::Int,
                SAMPLE_RATE as usize,
                CHANNELS as usize,
                None,
            );
            let (_, min_time) = match audio_client.get_device_period() {
                Ok(value) => value,
                Err(_) => return,
            };
            let mode = StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time,
            };
            if audio_client
                .initialize_client(&desired_format, &AudioDirection::Capture, &mode)
                .is_err()
            {
                return;
            }

            let h_event = match audio_client.set_get_eventhandle() {
                Ok(value) => value,
                Err(_) => return,
            };
            let capture_client = match audio_client.get_audiocaptureclient() {
                Ok(value) => value,
                Err(_) => return,
            };
            if audio_client.start_stream().is_err() {
                return;
            }

            let mut byte_queue: VecDeque<u8> = VecDeque::new();
            let chunk_bytes = SAMPLES_PER_CHANNEL * CHANNELS as usize * 2;
            loop {
                if *thread_stop_rx.borrow() {
                    let _ = audio_client.stop_stream();
                    break;
                }

                let new_frames = match capture_client.get_next_packet_size() {
                    Ok(Some(value)) => value,
                    Ok(None) => 0,
                    Err(_) => {
                        let _ = audio_client.stop_stream();
                        break;
                    }
                };
                if new_frames > 0 {
                    let additional = (new_frames as usize * 2 * CHANNELS as usize)
                        .saturating_sub(byte_queue.capacity().saturating_sub(byte_queue.len()));
                    byte_queue.reserve(additional);
                    if capture_client
                        .read_from_device_to_deque(&mut byte_queue)
                        .is_err()
                    {
                        let _ = audio_client.stop_stream();
                        break;
                    }
                }

                while byte_queue.len() >= chunk_bytes {
                    let mut pcm = Vec::with_capacity(SAMPLES_PER_CHANNEL * CHANNELS as usize);
                    for _ in 0..(SAMPLES_PER_CHANNEL * CHANNELS as usize) {
                        let lo = byte_queue.pop_front().unwrap_or_default();
                        let hi = byte_queue.pop_front().unwrap_or_default();
                        pcm.push(i16::from_le_bytes([lo, hi]));
                    }
                    if tx.send(pcm).is_err() {
                        let _ = audio_client.stop_stream();
                        return;
                    }
                }

                if h_event.wait_for_event(1000).is_err() {
                    let _ = audio_client.stop_stream();
                    break;
                }
            }
        })
        .map_err(|err| err.to_string())?;

    Ok((audio_task, audio_thread))
}

fn capture_sources_for(kind: DesktopCaptureSourceType) -> Vec<NativeScreenShareSource> {
    let options = DesktopCapturerOptions::new(kind);
    let Some(capturer) = DesktopCapturer::new(options) else {
        return Vec::new();
    };
    let source_kind = match kind {
        DesktopCaptureSourceType::Screen => "screen",
        DesktopCaptureSourceType::Window => "window",
        #[allow(unreachable_patterns)]
        _ => "screen",
    };
    capturer
        .get_source_list()
        .into_iter()
        .map(|source| NativeScreenShareSource {
            id: source.id(),
            kind: source_kind.to_string(),
            title: source.title(),
        })
        .collect()
}

fn find_capture_source(kind: DesktopCaptureSourceType, source_id: u64) -> Option<CaptureSource> {
    let options = DesktopCapturerOptions::new(kind);
    let capturer = DesktopCapturer::new(options)?;
    capturer
        .get_source_list()
        .into_iter()
        .find(|source| source.id() == source_id)
}

async fn stop_native_screen_share_inner(manager: &NativeScreenShareManager) -> Result<(), String> {
    let existing = {
        let mut guard = manager
            .session
            .lock()
            .map_err(|_| "Native screen share lock poisoned")?;
        guard.take()
    };
    if let Some(session) = existing {
        let _ = session.stop_tx.send(true);
        let _ = session.capture_task.await;
        if let Some(audio_task) = session.audio_task {
            let _ = audio_task.await;
        }
        if let Some(audio_thread) = session.audio_thread {
            let _ = audio_thread.join();
        }
        session.room.close().await.map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_native_screen_share_sources() -> Vec<NativeScreenShareSource> {
    let mut sources = capture_sources_for(DesktopCaptureSourceType::Screen);
    sources.extend(capture_sources_for(DesktopCaptureSourceType::Window));
    sources
}

#[tauri::command]
async fn start_native_screen_share(
    options: NativeScreenShareStartOptions,
    manager: State<'_, NativeScreenShareManager>,
) -> Result<(), String> {
    stop_native_screen_share_inner(&manager).await?;

    let selected = options
        .source
        .clone()
        .or_else(|| {
            capture_sources_for(DesktopCaptureSourceType::Screen)
                .into_iter()
                .next()
                .map(|source| NativeScreenShareSourceSelection {
                    id: source.id,
                    kind: source.kind,
                })
        })
        .ok_or_else(|| "No screen share sources are available".to_string())?;

    let source_type = if selected.kind == "window" {
        DesktopCaptureSourceType::Window
    } else {
        DesktopCaptureSourceType::Screen
    };
    let capture_source = find_capture_source(source_type, selected.id)
        .ok_or_else(|| "Selected capture source is unavailable".to_string())?;

    let mut capturer = DesktopCapturer::new(DesktopCapturerOptions::new(source_type))
        .ok_or_else(|| "Failed to initialize the native screen capturer".to_string())?;

    let (first_frame_tx, first_frame_rx) = mpsc::channel::<CapturedFrame>();
    let first_frame_tx = Arc::new(Mutex::new(Some(first_frame_tx)));
    let native_source = Arc::new(Mutex::new(None::<NativeVideoSource>));
    let output_resolution = Arc::new(Mutex::new(None::<(u32, u32)>));

    let native_source_for_callback = Arc::clone(&native_source);
    let output_resolution_for_callback = Arc::clone(&output_resolution);
    let first_frame_for_callback = Arc::clone(&first_frame_tx);
    capturer.start_capture(Some(capture_source), move |result| {
        let Ok(frame) = result else {
            return;
        };
        let captured = CapturedFrame {
            width: frame.width().max(1) as u32,
            height: frame.height().max(1) as u32,
            stride: frame.stride() as usize,
            data: frame.data().to_vec(),
        };
        if let Ok(mut sender_guard) = first_frame_for_callback.lock() {
            if let Some(sender) = sender_guard.take() {
                let _ = sender.send(captured.clone());
            }
        }
        let maybe_source = native_source_for_callback
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let maybe_resolution = output_resolution_for_callback
            .lock()
            .ok()
            .and_then(|guard| *guard);
        if let (Some(source), Some((out_width, out_height))) = (maybe_source, maybe_resolution) {
            let video_frame = captured.to_video_frame(out_width, out_height);
            source.capture_frame(&video_frame);
        }
    });

    capturer.capture_frame();
    let first_frame = first_frame_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timed out while starting native screen capture".to_string())?;

    let (out_width, out_height) =
        fit_capture_dimensions(first_frame.width, first_frame.height, &options.resolution);
    {
        let mut guard = output_resolution
            .lock()
            .map_err(|_| "Native screen share resolution lock poisoned")?;
        *guard = Some((out_width, out_height));
    }

    let rtc_source = NativeVideoSource::new(
        VideoResolution {
            width: out_width,
            height: out_height,
        },
        true,
    );
    {
        let mut guard = native_source
            .lock()
            .map_err(|_| "Native video source lock poisoned")?;
        *guard = Some(rtc_source.clone());
    }

    let (room, _events) =
        Room::connect(&options.livekit_url, &options.token, RoomOptions::default())
            .await
            .map_err(|err| err.to_string())?;

    let track = LocalVideoTrack::create_video_track(
        "screen-share",
        RtcVideoSource::Native(rtc_source.clone()),
    );
    let mut publish_options = TrackPublishOptions::default();
    publish_options.source = TrackSource::Screenshare;
    publish_options.video_codec = VideoCodec::H264;
    publish_options.simulcast = options.fps < 45;
    publish_options.video_encoding = Some(VideoEncoding {
        max_bitrate: native_screenshare_bitrate(&options.resolution, options.fps),
        max_framerate: options.fps.max(1) as f64,
    });

    room.local_participant()
        .publish_track(LocalTrack::Video(track), publish_options)
        .await
        .map_err(|err| err.to_string())?;

    let (stop_tx, mut stop_rx) = watch::channel(false);
    #[cfg(target_os = "windows")]
    let (audio_task, audio_thread) = {
        let audio_rtc_source =
            NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 2, 500);
        let audio_track = LocalAudioTrack::create_audio_track(
            "screen-share-audio",
            RtcAudioSource::Native(audio_rtc_source.clone()),
        );
        let mut audio_publish_options = TrackPublishOptions::default();
        audio_publish_options.source = TrackSource::ScreenshareAudio;
        audio_publish_options.dtx = false;
        audio_publish_options.simulcast = false;
        audio_publish_options.audio_encoding = Some(AudioEncoding {
            max_bitrate: 128_000,
        });
        room.local_participant()
            .publish_track(LocalTrack::Audio(audio_track), audio_publish_options)
            .await
            .map_err(|err| err.to_string())?;

        let (task, thread) = start_loopback_audio_capture(audio_rtc_source, stop_tx.subscribe())?;
        (Some(task), Some(thread))
    };
    #[cfg(not(target_os = "windows"))]
    let (audio_task, audio_thread): (Option<JoinHandle<()>>, Option<ThreadJoinHandle<()>>) =
        (None, None);

    let initial_frame = first_frame.to_video_frame(out_width, out_height);
    rtc_source.capture_frame(&initial_frame);

    let fps = options.fps.max(1).min(60) as u64;
    let capture_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis((1000 / fps).max(16)));
        loop {
            tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
                _ = interval.tick() => {
                    capturer.capture_frame();
                }
            }
        }
    });

    let session = NativeScreenShareSession {
        room,
        capture_task,
        audio_task,
        audio_thread,
        stop_tx,
    };
    let mut guard = manager
        .session
        .lock()
        .map_err(|_| "Native screen share lock poisoned".to_string())?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
async fn stop_native_screen_share(
    manager: State<'_, NativeScreenShareManager>,
) -> Result<(), String> {
    stop_native_screen_share_inner(&manager).await
}

async fn stop_native_microphone_inner(manager: &NativeMicrophoneManager) -> Result<(), String> {
    let existing = {
        let mut guard = manager
            .session
            .lock()
            .map_err(|_| "Native microphone lock poisoned")?;
        guard.take()
    };
    if let Some(session) = existing {
        let _ = session.stop_tx.send(true);
        let _ = session.audio_task.await;
        let _ = session.capture_thread.join();
        session.room.close().await.map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_native_audio_input_devices() -> Result<Vec<NativeAudioInputDevice>, String> {
    list_native_audio_input_devices_inner()
}

#[tauri::command]
async fn start_native_microphone(
    options: NativeMicrophoneStartOptions,
    manager: State<'_, NativeMicrophoneManager>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = options;
        let _ = manager;
        return Err(
            "Native microphone processing is currently available on Windows only".to_string(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        stop_native_microphone_inner(&manager).await?;

        let (room, _events) =
            Room::connect(&options.livekit_url, &options.token, RoomOptions::default())
                .await
                .map_err(|err| err.to_string())?;

        let rtc_source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 0);
        let track = LocalAudioTrack::create_audio_track(
            "native-microphone",
            RtcAudioSource::Native(rtc_source.clone()),
        );
        let mut publish_options = TrackPublishOptions::default();
        publish_options.source = TrackSource::Microphone;
        publish_options.simulcast = false;
        publish_options.dtx = false;
        publish_options.audio_encoding = Some(AudioEncoding {
            max_bitrate: 96_000,
        });
        room.local_participant()
            .publish_track(LocalTrack::Audio(track.clone()), publish_options)
            .await
            .map_err(|err| err.to_string())?;

        let (stop_tx, stop_rx) = watch::channel(false);
        let muted = Arc::new(AtomicBool::new(options.start_muted));
        if options.start_muted {
            track.mute();
        }

        let (audio_task, capture_thread) = start_native_microphone_capture(
            rtc_source,
            options.noise_suppression_mode.clone(),
            options.input_sensitivity,
            options.device_id.clone(),
            Arc::clone(&muted),
            stop_rx,
        )?;

        let session = NativeMicrophoneSession {
            room,
            track,
            audio_task,
            capture_thread,
            stop_tx,
            muted,
        };
        let mut guard = manager
            .session
            .lock()
            .map_err(|_| "Native microphone lock poisoned".to_string())?;
        *guard = Some(session);
        Ok(())
    }
}

#[tauri::command]
async fn stop_native_microphone(manager: State<'_, NativeMicrophoneManager>) -> Result<(), String> {
    stop_native_microphone_inner(&manager).await
}

#[tauri::command]
fn set_native_microphone_muted(
    muted: bool,
    manager: State<'_, NativeMicrophoneManager>,
) -> Result<(), String> {
    let guard = manager
        .session
        .lock()
        .map_err(|_| "Native microphone lock poisoned".to_string())?;
    if let Some(session) = guard.as_ref() {
        session.muted.store(muted, Ordering::Relaxed);
        if muted {
            session.track.mute();
        } else {
            session.track.unmute();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeScreenShareManager::default())
        .manage(NativeMicrophoneManager::default())
        .manage(DesktopTrayState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let open_home =
                MenuItem::with_id(app, "open_home", "Open Home Server", true, None::<&str>)?;
            let voice_mute = CheckMenuItem::with_id(
                app,
                "voice_mute",
                "Mute microphone",
                false,
                false,
                None::<&str>,
            )?;
            let voice_deafen = CheckMenuItem::with_id(
                app,
                "voice_deafen",
                "Deafen audio",
                false,
                false,
                None::<&str>,
            )?;
            let voice_disconnect = MenuItem::with_id(
                app,
                "voice_disconnect",
                "Disconnect from Voice",
                false,
                None::<&str>,
            )?;
            let status_online =
                CheckMenuItem::with_id(app, "status_online", "Online", true, true, None::<&str>)?;
            let status_away =
                CheckMenuItem::with_id(app, "status_away", "Away", true, false, None::<&str>)?;
            let status_dnd = CheckMenuItem::with_id(
                app,
                "status_dnd",
                "Do Not Disturb",
                true,
                false,
                None::<&str>,
            )?;
            let status_offline = CheckMenuItem::with_id(
                app,
                "status_offline",
                "Invisible",
                true,
                false,
                None::<&str>,
            )?;
            let status_menu = Submenu::with_id_and_items(
                app,
                "status_menu",
                "Set Status",
                true,
                &[&status_online, &status_away, &status_dnd, &status_offline],
            )?;
            let voice_menu = Submenu::with_id_and_items(
                app,
                "voice_menu",
                "Voice",
                true,
                &[&voice_mute, &voice_deafen, &voice_disconnect],
            )?;
            let updates = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit ChitChat", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open ChitChat", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show,
                    &open_home,
                    &PredefinedMenuItem::separator(app)?,
                    &voice_menu,
                    &status_menu,
                    &updates,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            if let Ok(mut tray_state) = app.state::<DesktopTrayState>().handles.lock() {
                *tray_state = Some(DesktopTrayHandles {
                    open_home: open_home.clone(),
                    voice_mute: voice_mute.clone(),
                    voice_deafen: voice_deafen.clone(),
                    voice_disconnect: voice_disconnect.clone(),
                    status_online: status_online.clone(),
                    status_away: status_away.clone(),
                    status_dnd: status_dnd.clone(),
                    status_offline: status_offline.clone(),
                    check_updates: updates.clone(),
                });
            }

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("ChitChat")
                .on_menu_event(
                    |app: &tauri::AppHandle, event: tauri::menu::MenuEvent| match event.id.as_ref()
                    {
                        "quit" => app.exit(0),
                        "show" => {
                            show_main_window(app);
                        }
                        "open_home" => {
                            show_main_window(app);
                            emit_desktop_tray_action(app, "open_home_server", None);
                        }
                        "voice_mute" => {
                            emit_desktop_tray_action(app, "toggle_mute", None);
                        }
                        "voice_deafen" => {
                            emit_desktop_tray_action(app, "toggle_deafen", None);
                        }
                        "voice_disconnect" => {
                            emit_desktop_tray_action(app, "disconnect_voice", None);
                        }
                        "status_online" => {
                            emit_desktop_tray_action(app, "set_status", Some("online"));
                        }
                        "status_away" => {
                            emit_desktop_tray_action(app, "set_status", Some("away"));
                        }
                        "status_dnd" => {
                            emit_desktop_tray_action(app, "set_status", Some("dnd"));
                        }
                        "status_offline" => {
                            emit_desktop_tray_action(app, "set_status", Some("offline"));
                        }
                        "check_updates" => {
                            show_main_window(app);
                            emit_desktop_tray_action(app, "check_updates", None);
                        }
                        _ => {}
                    },
                )
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event: TrayIconEvent| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(&tray.app_handle());
                    }
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            apply_desktop_unread_badge(&app_handle, 0);

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
            set_desktop_unread_badge,
            set_desktop_tray_voice_state,
            set_desktop_tray_status_state,
            set_desktop_tray_home_server,
            set_desktop_tray_update_state,
            list_native_screen_share_sources,
            start_native_screen_share,
            stop_native_screen_share,
            list_native_audio_input_devices,
            start_native_microphone,
            stop_native_microphone,
            set_native_microphone_muted,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
