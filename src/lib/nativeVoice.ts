import { invoke } from "@tauri-apps/api/core";
import type { AudioInputDeviceOption } from "../types";
import { isProbablyTauri } from "./nativeScreenShare";

export type NativeMicrophoneStartOptions = {
  livekitUrl: string;
  token: string;
  deviceId?: string;
  noiseSuppressionMode: "off" | "standard" | "aggressive" | "rnnoise";
  inputSensitivity: number;
  startMuted: boolean;
};

export async function listNativeAudioInputDevices(): Promise<AudioInputDeviceOption[]> {
  if (!isProbablyTauri()) return [];
  return invoke<AudioInputDeviceOption[]>("list_native_audio_input_devices");
}

export async function startNativeMicrophone(
  options: NativeMicrophoneStartOptions
): Promise<void> {
  if (!isProbablyTauri()) {
    throw new Error("Native microphone processing is unavailable in the browser.");
  }
  await invoke("start_native_microphone", { options });
}

export async function stopNativeMicrophone(): Promise<void> {
  if (!isProbablyTauri()) return;
  await invoke("stop_native_microphone");
}

export async function setNativeMicrophoneMuted(muted: boolean): Promise<void> {
  if (!isProbablyTauri()) return;
  await invoke("set_native_microphone_muted", { muted });
}
