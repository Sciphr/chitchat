import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type VoiceState = {
  connected: boolean;
  muted: boolean;
  deafened: boolean;
};

export type DesktopTrayAction = {
  action: string;
  value?: string | null;
};

const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function listenForDesktopTrayActions(
  handler: (action: DesktopTrayAction) => void
): Promise<UnlistenFn> {
  if (!isDesktop) {
    return () => {};
  }
  return listen<DesktopTrayAction>("desktop-tray-action", (event) => {
    handler(event.payload);
  });
}

export async function syncDesktopTrayVoiceState(state: VoiceState) {
  if (!isDesktop) return;
  await invoke("set_desktop_tray_voice_state", { state });
}

export async function syncDesktopTrayStatus(status: string) {
  if (!isDesktop) return;
  await invoke("set_desktop_tray_status_state", { state: { status } });
}

export async function syncDesktopTrayHomeServer(name: string) {
  if (!isDesktop) return;
  await invoke("set_desktop_tray_home_server", { state: { name } });
}

export async function syncDesktopTrayUpdateState(label: string, enabled: boolean) {
  if (!isDesktop) return;
  await invoke("set_desktop_tray_update_state", {
    state: { label, enabled },
  });
}
