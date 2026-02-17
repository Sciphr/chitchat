import { getServerUrl, getToken } from "./api";

const LIVEKIT_URLS_BY_SERVER_KEY = "chitchat_livekit_urls_by_server";
const LEGACY_LIVEKIT_URL_KEY = "chitchat_livekit_url";

function normalizeServerUrl(url: string) {
  return (url || "").trim().replace(/\/+$/, "").toLowerCase();
}

function readLiveKitUrlsByServer(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LIVEKIT_URLS_BY_SERVER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, string> = {};
    for (const [serverUrl, livekitUrl] of Object.entries(parsed)) {
      const normalizedServerUrl = normalizeServerUrl(serverUrl);
      const normalizedLivekitUrl = (livekitUrl || "").trim();
      if (!normalizedServerUrl || !normalizedLivekitUrl) continue;
      next[normalizedServerUrl] = normalizedLivekitUrl;
    }
    return next;
  } catch {
    return {};
  }
}

function writeLiveKitUrlsByServer(next: Record<string, string>) {
  localStorage.setItem(LIVEKIT_URLS_BY_SERVER_KEY, JSON.stringify(next));
}

export function getLiveKitUrl(serverUrl = getServerUrl()): string {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const byServer = readLiveKitUrlsByServer();
  if (normalizedServerUrl && byServer[normalizedServerUrl]) {
    return byServer[normalizedServerUrl];
  }
  if (normalizedServerUrl) {
    // For known servers, avoid falling back to legacy global URL (prevents cross-server leakage).
    return import.meta.env.VITE_LIVEKIT_URL || "";
  }

  // Backward compatibility: use legacy global value if present.
  return localStorage.getItem(LEGACY_LIVEKIT_URL_KEY) || import.meta.env.VITE_LIVEKIT_URL || "";
}

export function setLiveKitUrl(url: string, serverUrl = getServerUrl()) {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  if (!normalizedServerUrl) return;

  const byServer = readLiveKitUrlsByServer();
  const trimmedUrl = (url || "").trim();
  if (!trimmedUrl) {
    delete byServer[normalizedServerUrl];
  } else {
    byServer[normalizedServerUrl] = trimmedUrl;
  }
  writeLiveKitUrlsByServer(byServer);

  // Keep legacy key for old clients and manual inspection.
  if (trimmedUrl) {
    localStorage.setItem(LEGACY_LIVEKIT_URL_KEY, trimmedUrl);
  }
}

export interface MediaLimits {
  maxScreenShareResolution: string;
  maxScreenShareFps: number;
}

/** All resolution presets in ascending order */
export const VIDEO_RESOLUTIONS = [
  { id: "360p", label: "360p", width: 640, height: 360 },
  { id: "480p", label: "480p", width: 854, height: 480 },
  { id: "720p", label: "720p", width: 1280, height: 720 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
] as const;

export const FPS_OPTIONS = [5, 15, 24, 30, 60] as const;

/** Get the index of a resolution preset (for comparison) */
function resIndex(id: string): number {
  const i = VIDEO_RESOLUTIONS.findIndex((r) => r.id === id);
  return i === -1 ? 2 : i; // default to 720p index
}

/** Filter resolution presets up to (and including) a max preset */
export function getResolutionsUpTo(maxPreset: string) {
  const maxIdx = resIndex(maxPreset);
  return VIDEO_RESOLUTIONS.filter((_, i) => i <= maxIdx);
}

/** Filter FPS options up to (and including) a max FPS */
export function getFpsUpTo(maxFps: number) {
  return FPS_OPTIONS.filter((fps) => fps <= maxFps);
}

/** Clamp a user's resolution preference to the server max */
export function clampResolution(userPref: string, serverMax: string): string {
  const userIdx = resIndex(userPref);
  const maxIdx = resIndex(serverMax);
  return userIdx <= maxIdx ? userPref : serverMax;
}

/** Clamp a user's FPS preference to the server max */
export function clampFps(userPref: number, serverMax: number): number {
  return userPref <= serverMax ? userPref : serverMax;
}

/** Map a resolution preset string to width/height */
export function resolveResolution(preset: string): { width: number; height: number } {
  switch (preset) {
    case "360p":
      return { width: 640, height: 360 };
    case "480p":
      return { width: 854, height: 480 };
    case "720p":
      return { width: 1280, height: 720 };
    case "1080p":
      return { width: 1920, height: 1080 };
    case "1440p":
      return { width: 2560, height: 1440 };
    case "4k":
      return { width: 3840, height: 2160 };
    default:
      return { width: 1280, height: 720 };
  }
}

export async function fetchLiveKitToken(params: {
  room: string;
  userId: string;
  username: string;
}): Promise<{ token: string; mediaLimits: MediaLimits }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authToken = getToken();
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${getServerUrl()}/api/livekit/token`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch LiveKit token");
  }

  const data = (await res.json()) as {
    token?: string;
    mediaLimits?: MediaLimits;
  };
  if (!data.token) {
    throw new Error("Token missing from response");
  }

  return {
    token: data.token,
    mediaLimits: data.mediaLimits ?? {
      maxScreenShareResolution: "1080p",
      maxScreenShareFps: 30,
    },
  };
}
