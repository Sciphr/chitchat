import {
  isPermissionGranted as isTauriNotificationPermissionGranted,
  requestPermission as requestTauriNotificationPermission,
  sendNotification as sendTauriNotification,
} from "@tauri-apps/plugin-notification";
import { isProbablyTauri } from "./nativeScreenShare";

export type DesktopNotificationPermission =
  | NotificationPermission
  | "unsupported";

export async function getDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (isProbablyTauri()) {
    try {
      return (await isTauriNotificationPermissionGranted())
        ? "granted"
        : "default";
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (isProbablyTauri()) {
    try {
      return await requestTauriNotificationPermission();
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }

  return Notification.requestPermission();
}

export async function sendDesktopNotification(options: {
  title: string;
  body?: string;
  tag?: string;
}): Promise<boolean> {
  const permission = await getDesktopNotificationPermission();
  if (permission !== "granted") {
    return false;
  }

  if (isProbablyTauri()) {
    sendTauriNotification({
      title: options.title,
      body: options.body,
    });
    return true;
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  new Notification(options.title, {
    body: options.body,
    tag: options.tag,
  });
  return true;
}
