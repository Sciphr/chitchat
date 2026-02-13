declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriDesktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function detectRunningGame(): Promise<string | null> {
  if (!isTauriDesktop()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const detection = await invoke<
      | { kind: "none" }
      | { kind: "known"; game: string; executable: string }
    >("detect_running_game");
    if (!detection) return null;
    if (detection.kind === "known") {
      const game = detection.game.trim();
      return game.length > 0 ? game : null;
    }
    return null;
  } catch {
    return null;
  }
}
