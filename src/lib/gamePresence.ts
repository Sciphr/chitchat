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
      | { kind: "unknown"; executable: string; suggested_name: string }
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

export type GameDetectionResult =
  | { kind: "none" }
  | { kind: "known"; game: string; executable: string }
  | { kind: "unknown"; executable: string; suggestedName: string };

export async function detectGameDetails(): Promise<GameDetectionResult> {
  if (!isTauriDesktop()) return { kind: "none" };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const detection = await invoke<
      | { kind: "none" }
      | { kind: "known"; game: string; executable: string }
      | { kind: "unknown"; executable: string; suggested_name: string }
    >("detect_running_game");
    if (!detection || detection.kind === "none") return { kind: "none" };
    if (detection.kind === "known") {
      return {
        kind: "known",
        game: detection.game,
        executable: detection.executable,
      };
    }
    return {
      kind: "unknown",
      executable: detection.executable,
      suggestedName: detection.suggested_name,
    };
  } catch {
    return { kind: "none" };
  }
}
