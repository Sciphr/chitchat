import { invoke } from "@tauri-apps/api/core";

type RemoteControlInputEvent = {
  type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
  xNorm?: number;
  yNorm?: number;
  button?: "left" | "right" | "middle";
  deltaY?: number;
  key?: string;
};

function isProbablyTauri() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export async function applyRemoteControlInputNative(
  event: RemoteControlInputEvent
): Promise<void> {
  if (!isProbablyTauri()) return;
  await invoke("apply_remote_control_input", { event });
}
