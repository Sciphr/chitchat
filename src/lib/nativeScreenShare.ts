import { invoke } from "@tauri-apps/api/core";
import type { ScreenShareSource } from "../types";

export type NativeScreenShareStartOptions = {
  livekitUrl: string;
  token: string;
  source?: ScreenShareSource;
  resolution: string;
  fps: number;
};

export function isProbablyTauri() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export async function listNativeScreenShareSources(): Promise<ScreenShareSource[]> {
  if (!isProbablyTauri()) return [];
  return invoke<ScreenShareSource[]>("list_native_screen_share_sources");
}

export async function startNativeScreenShare(
  options: NativeScreenShareStartOptions
): Promise<void> {
  if (!isProbablyTauri()) {
    throw new Error("Native screen sharing is unavailable in the browser.");
  }
  await invoke("start_native_screen_share", { options });
}

export async function stopNativeScreenShare(): Promise<void> {
  if (!isProbablyTauri()) return;
  await invoke("stop_native_screen_share");
}
