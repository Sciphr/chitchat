import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  apiFetch,
  getToken,
  setToken,
  getServerUrl,
  setServerUrl as _setServerUrl,
} from "../lib/api";
import { resetSocket } from "../lib/socket";

export interface UserInfo {
  id: string;
  email: string;
  isAdmin: boolean;
  permissions: {
    canManageChannels: boolean;
    canManageRoles: boolean;
    canManageServer: boolean;
    canKickMembers: boolean;
    canBanMembers: boolean;
    canTimeoutMembers: boolean;
    canModerateVoice: boolean;
    canPinMessages: boolean;
    canManageMessages: boolean;
    canUploadFiles: boolean;
    canUseEmojis: boolean;
    canStartVoice: boolean;
  };
}

export interface Profile {
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  about: string;
  desktopNotificationsEnabled: boolean;
  desktopNotificationsMentionsOnly: boolean;
  pushToTalkEnabled: boolean;
  pushToMuteEnabled: boolean;
  pushToTalkKey: string;
  audioInputSensitivity: number;
  noiseSuppressionMode: "off" | "standard" | "aggressive" | "rnnoise";
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
  videoBackgroundMode: "off" | "blur" | "image";
  videoBackgroundImageUrl: string;
  twoFactorEnabled: boolean;
}

interface AuthContext {
  token: string | null;
  user: UserInfo | null;
  username: string;
  profile: Profile;
  loading: boolean;
  serverUrl: string;
  setServerUrl: (url: string, nameHint?: string) => void;
  servers: SavedServer[];
  homeServerUrl: string;
  setHomeServer: (url: string) => void;
  serverSessionStateByUrl: Record<string, SavedServerSessionState>;
  serverDirectoryByUrl: Record<string, SavedServerDirectoryEntry>;
  switchServer: (url: string) => void;
  saveServer: (url: string, nameHint?: string) => void;
  removeServer: (url: string) => void;
  signOutServer: (url: string) => void;
  getServerToken: (url: string) => string | null;
  signInWithPassword: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; requiresTwoFactor?: boolean; challengeToken?: string }>;
  signInToSavedServerWithPassword: (
    serverUrl: string,
    email: string,
    password: string
  ) => Promise<{ error: string | null; requiresTwoFactor?: boolean; challengeToken?: string }>;
  signInWithTwoFactor: (
    challengeToken: string,
    code: string
  ) => Promise<{ error: string | null }>;
  signInToSavedServerWithTwoFactor: (
    serverUrl: string,
    challengeToken: string,
    code: string
  ) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    username: string,
    inviteCode?: string
  ) => Promise<{ error: string | null }>;
  requestPasswordReset: (email: string) => Promise<{ error: string | null; message?: string }>;
  confirmPasswordReset: (
    token: string,
    newPassword: string
  ) => Promise<{ error: string | null }>;
  updateProfile: (profile: Profile) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const DEFAULT_PROFILE: Profile = {
  username: "Anonymous",
  status: "online",
  avatarUrl: "",
  about: "",
  desktopNotificationsEnabled: false,
  desktopNotificationsMentionsOnly: true,
  pushToTalkEnabled: false,
  pushToMuteEnabled: false,
  pushToTalkKey: "Space",
  audioInputSensitivity: 0.06,
  noiseSuppressionMode: "standard",
  audioInputId: "",
  audioOutputId: "",
  videoInputId: "",
  videoBackgroundMode: "off",
  videoBackgroundImageUrl: "",
  twoFactorEnabled: false,
};

export interface SavedServer {
  url: string;
  name: string;
  lastUsedAt: string;
}

export type SavedServerSessionState =
  | "ready"
  | "checking"
  | "login_required"
  | "unreachable";

export interface SavedServerDirectoryEntry {
  name?: string;
  description?: string;
  iconUrl?: string;
  reachable: boolean;
}

const SERVERS_STORAGE_KEY = "chitchat_servers";
const TOKENS_BY_SERVER_STORAGE_KEY = "chitchat_tokens_by_server";
const HOME_SERVER_STORAGE_KEY = "chitchat_home_server_url";

const AuthContext = createContext<AuthContext | null>(null);

function mapPermissions(data: Record<string, any>) {
  const source = (data.permissions as Record<string, any> | undefined) || {};
  return {
    canManageChannels: Boolean(source.canManageChannels),
    canManageRoles: Boolean(source.canManageRoles),
    canManageServer: Boolean(source.canManageServer),
    canKickMembers: Boolean(source.canKickMembers),
    canBanMembers: Boolean(source.canBanMembers),
    canTimeoutMembers: Boolean(source.canTimeoutMembers),
    canModerateVoice: Boolean(source.canModerateVoice),
    canPinMessages: Boolean(source.canPinMessages),
    canManageMessages: Boolean(source.canManageMessages),
    canUploadFiles: source.canUploadFiles !== false,
    canUseEmojis: source.canUseEmojis !== false,
    canStartVoice: source.canStartVoice !== false,
  };
}

function mapServerProfile(data: Record<string, any>): Profile {
  return {
    username: data.username || "Anonymous",
    status: (data.status as Profile["status"]) || "online",
    avatarUrl: data.avatar_url || "",
    about: data.about || "",
    desktopNotificationsEnabled: Boolean(data.desktop_notifications_enabled),
    desktopNotificationsMentionsOnly:
      data.desktop_notifications_mentions_only === undefined
        ? true
        : Boolean(data.desktop_notifications_mentions_only),
    pushToTalkEnabled: Boolean(data.push_to_talk_enabled),
    pushToMuteEnabled: Boolean(data.push_to_mute_enabled),
    pushToTalkKey: data.push_to_talk_key || "Space",
    audioInputSensitivity:
      typeof data.audio_input_sensitivity === "number"
        ? Math.min(Math.max(data.audio_input_sensitivity, 0), 1)
        : 0.06,
    noiseSuppressionMode:
      data.noise_suppression_mode === "off" ||
      data.noise_suppression_mode === "aggressive" ||
      data.noise_suppression_mode === "rnnoise"
        ? data.noise_suppression_mode
        : "standard",
    audioInputId: data.audio_input_id || "",
    audioOutputId: data.audio_output_id || "",
    videoInputId: data.video_input_id || "",
    videoBackgroundMode:
      data.video_background_mode === "blur" || data.video_background_mode === "image"
        ? data.video_background_mode
        : "off",
    videoBackgroundImageUrl: data.video_background_image_url || "",
    twoFactorEnabled: Boolean(data.two_factor_enabled),
  };
}

function normalizeServerUrl(url: string) {
  return (url || "").trim().replace(/\/+$/, "");
}

function hostFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

function readSavedServers(): SavedServer[] {
  try {
    const raw = localStorage.getItem(SERVERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedServer[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        url: normalizeServerUrl(entry.url),
        name: entry.name || hostFromUrl(entry.url),
        lastUsedAt: entry.lastUsedAt || new Date(0).toISOString(),
      }))
      .filter((entry) => Boolean(entry.url));
  } catch {
    return [];
  }
}

function writeSavedServers(servers: SavedServer[]) {
  localStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(servers));
}

function readHomeServerUrl() {
  return normalizeServerUrl(localStorage.getItem(HOME_SERVER_STORAGE_KEY) || "");
}

function writeHomeServerUrl(url: string) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) {
    localStorage.removeItem(HOME_SERVER_STORAGE_KEY);
    return;
  }
  localStorage.setItem(HOME_SERVER_STORAGE_KEY, normalized);
}

function readTokensByServer(activeServerUrl: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(TOKENS_BY_SERVER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const normalized: Record<string, string> = {};
    for (const [url, token] of Object.entries(parsed || {})) {
      const normalizedUrl = normalizeServerUrl(url);
      if (!normalizedUrl || typeof token !== "string" || token.length === 0) continue;
      normalized[normalizedUrl] = token;
    }

    // Migration from legacy single-token storage.
    const legacyToken = getToken();
    if (legacyToken && activeServerUrl && !normalized[activeServerUrl]) {
      normalized[activeServerUrl] = legacyToken;
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeTokensByServer(tokensByServer: Record<string, string>) {
  localStorage.setItem(
    TOKENS_BY_SERVER_STORAGE_KEY,
    JSON.stringify(tokensByServer)
  );
}

function choosePreferredServerUrl(params: {
  storedServerUrl: string;
  homeServerUrl: string;
  servers: SavedServer[];
  tokensByServer: Record<string, string>;
}) {
  const savedUrls = new Set(params.servers.map((entry) => entry.url));
  const hasSavedServer = (url: string) => savedUrls.has(url);
  const hasSavedToken = (url: string) => Boolean(params.tokensByServer[url]);

  if (
    params.homeServerUrl &&
    (hasSavedToken(params.homeServerUrl) || hasSavedServer(params.homeServerUrl))
  ) {
    return params.homeServerUrl;
  }

  if (
    params.storedServerUrl &&
    (hasSavedToken(params.storedServerUrl) || hasSavedServer(params.storedServerUrl))
  ) {
    return params.storedServerUrl;
  }

  const firstAuthenticatedServer = params.servers.find((entry) =>
    hasSavedToken(entry.url)
  );
  if (firstAuthenticatedServer) {
    return firstAuthenticatedServer.url;
  }

  return params.servers[0]?.url || params.storedServerUrl || params.homeServerUrl || "";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const storedServerUrl = normalizeServerUrl(getServerUrl());
  const initialServers = readSavedServers();
  const initialTokensByServer = readTokensByServer(storedServerUrl);
  const storedHomeServerUrl = readHomeServerUrl();
  const preferredInitialServerUrl = choosePreferredServerUrl({
    storedServerUrl,
    homeServerUrl: storedHomeServerUrl,
    servers: initialServers,
    tokensByServer: initialTokensByServer,
  });

  const [servers, setServers] = useState<SavedServer[]>(() => initialServers);
  const [tokensByServer, setTokensByServer] = useState<Record<string, string>>(
    () => initialTokensByServer
  );
  const [homeServerUrl, setHomeServerUrlState] = useState<string>(
    () => storedHomeServerUrl || preferredInitialServerUrl
  );
  const [token, setTokenState] = useState<string | null>(
    () => initialTokensByServer[preferredInitialServerUrl] || null
  );
  const [user, setUser] = useState<UserInfo | null>(null);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrlState] = useState(preferredInitialServerUrl);
  const [serverSessionStateByUrl, setServerSessionStateByUrl] = useState<
    Record<string, SavedServerSessionState>
  >(() => {
    const next: Record<string, SavedServerSessionState> = {};
    for (const server of initialServers) {
      next[server.url] = initialTokensByServer[server.url]
        ? "checking"
        : "login_required";
    }
    return next;
  });
  const [serverDirectoryByUrl, setServerDirectoryByUrl] = useState<
    Record<string, SavedServerDirectoryEntry>
  >({});

  useEffect(() => {
    if (serverUrl) {
      _setServerUrl(serverUrl);
    }
    setToken(token);
  }, [serverUrl, token]);

  useEffect(() => {
    if (servers.length > 0) return;
    const tokenUrls = Object.keys(tokensByServer);
    if (tokenUrls.length === 0) return;
    const now = new Date().toISOString();
    const restored = tokenUrls.map((url) => ({
      url,
      name: hostFromUrl(url),
      lastUsedAt: now,
    }));
    setServers(restored);
    writeSavedServers(restored);
  }, [servers.length, tokensByServer]);

  useEffect(() => {
    if (homeServerUrl) {
      writeHomeServerUrl(homeServerUrl);
      return;
    }
    const fallbackHome =
      choosePreferredServerUrl({
        storedServerUrl: serverUrl,
        homeServerUrl: "",
        servers,
        tokensByServer,
      }) || "";
    if (!fallbackHome) {
      writeHomeServerUrl("");
      return;
    }
    setHomeServerUrlState(fallbackHome);
  }, [homeServerUrl, serverUrl, servers, tokensByServer]);

  useEffect(() => {
    let disposed = false;
    const controllers = new Map<string, AbortController>();

    async function loadServerDirectoryEntry(url: string) {
      const controller = new AbortController();
      controllers.set(url, controller);
      try {
        const res = await fetch(`${url}/api/server/info`, {
          signal: controller.signal,
        });
        if (disposed) return;
        if (!res.ok) {
          setServerDirectoryByUrl((prev) => ({
            ...prev,
            [url]: {
              ...(prev[url] || {}),
              reachable: false,
            },
          }));
          return;
        }
        const data = (await res.json()) as {
          name?: string;
          description?: string;
          iconUrl?: string;
        };
        setServerDirectoryByUrl((prev) => ({
          ...prev,
          [url]: {
            name: data.name || prev[url]?.name || hostFromUrl(url),
            description: data.description || "",
            iconUrl: data.iconUrl || "",
            reachable: true,
          },
        }));
        if (data.name?.trim()) {
          setServers((prev) => {
            let changed = false;
            const next = prev.map((entry) => {
              if (entry.url !== url || entry.name === data.name) return entry;
              changed = true;
              return { ...entry, name: data.name! };
            });
            if (changed) writeSavedServers(next);
            return changed ? next : prev;
          });
        }
      } catch {
        if (disposed) return;
        setServerDirectoryByUrl((prev) => ({
          ...prev,
          [url]: {
            ...(prev[url] || {}),
            reachable: false,
          },
        }));
      } finally {
        controllers.delete(url);
      }
    }

    for (const server of servers) {
      void loadServerDirectoryEntry(server.url);
    }

    return () => {
      disposed = true;
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [servers]);

  useEffect(() => {
    if (token) return;
    const preferredUrl = choosePreferredServerUrl({
      storedServerUrl: serverUrl,
      homeServerUrl,
      servers,
      tokensByServer,
    });
    const fallback = servers.find((entry) => entry.url === preferredUrl)
      || servers.find((entry) => Boolean(tokensByServer[entry.url]));
    if (!fallback || fallback.url === serverUrl) return;
    switchToServer(fallback.url, fallback.name);
  }, [token, servers, tokensByServer, serverUrl, homeServerUrl]);

  function upsertServer(url: string, nameHint?: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;
    setServers((prev) => {
      const now = new Date().toISOString();
      const existing = prev.find((entry) => entry.url === normalized);
      const nextName =
        nameHint?.trim() || existing?.name || hostFromUrl(normalized);
      const next = existing
        ? prev.map((entry) =>
            entry.url === normalized
              ? { ...entry, name: nextName, lastUsedAt: now }
              : entry
          )
        : [{ url: normalized, name: nextName, lastUsedAt: now }, ...prev];
      next.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
      writeSavedServers(next);
      return next;
    });
  }

  function setTokens(next: Record<string, string>) {
    setTokensByServer(next);
    writeTokensByServer(next);
  }

  function setHomeServer(url: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;
    setHomeServerUrlState(normalized);
    upsertServer(normalized);
  }

  function switchToServer(url: string, nameHint?: string, persist = true) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;
    if (persist) {
      upsertServer(normalized, nameHint);
    }
    const nextToken = tokensByServer[normalized] || null;
    const sameServer = normalized === serverUrl;
    const sameToken = nextToken === token;
    if (sameServer && sameToken) {
      // No auth context change; avoid forcing loading=true and getting stuck.
      return;
    }
    _setServerUrl(normalized);
    setServerUrlState(normalized);
    setToken(nextToken);
    setTokenState(nextToken);
    setUser(null);
    setProfile(DEFAULT_PROFILE);
    setLoading(Boolean(nextToken));
    resetSocket();
  }

  useEffect(() => {
    const activeToken = token;
    if (!activeToken) {
      setUser(null);
      setProfile(DEFAULT_PROFILE);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    apiFetch("/api/auth/me", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Invalid token");
        return res.json();
      })
      .then((data) => {
        setUser({
          id: data.id,
          email: data.email,
          isAdmin: data.isAdmin || false,
          permissions: mapPermissions(data),
        });
        setProfile(mapServerProfile(data));
        setServerSessionStateByUrl((prev) => ({
          ...prev,
          [serverUrl]: "ready",
        }));
      })
      .catch(() => {
        const nextTokens = { ...tokensByServer };
        delete nextTokens[serverUrl];
        setTokens(nextTokens);
        setToken(null);
        setTokenState(null);
        setUser(null);
        setProfile(DEFAULT_PROFILE);
        setServerSessionStateByUrl((prev) => ({
          ...prev,
          [serverUrl]: "login_required",
        }));
      })
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });
  }, [serverUrl, token, tokensByServer]);

  useEffect(() => {
    const nextBaseState: Record<string, SavedServerSessionState> = {};
    for (const server of servers) {
      nextBaseState[server.url] = tokensByServer[server.url]
        ? serverSessionStateByUrl[server.url] === "ready"
          ? "ready"
          : "checking"
        : "login_required";
    }
    setServerSessionStateByUrl(nextBaseState);

    const controllers = new Map<string, AbortController>();
    let disposed = false;

    async function validateServerSession(url: string, authToken: string) {
      const controller = new AbortController();
      controllers.set(url, controller);
      const timeout = window.setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${url}/api/auth/me`, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });
        if (disposed) return;
        setServerSessionStateByUrl((prev) => ({
          ...prev,
          [url]:
            res.ok
              ? "ready"
              : res.status === 401 || res.status === 403
              ? "login_required"
              : "unreachable",
        }));
      } catch {
        if (disposed) return;
        setServerSessionStateByUrl((prev) => ({
          ...prev,
          [url]: "unreachable",
        }));
      } finally {
        window.clearTimeout(timeout);
        controllers.delete(url);
      }
    }

    for (const server of servers) {
      const authToken = tokensByServer[server.url];
      if (!authToken) continue;
      void validateServerSession(server.url, authToken);
    }

    return () => {
      disposed = true;
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, [servers, tokensByServer]);

  async function signInWithPassword(email: string, password: string) {
    try {
      const versionHeaders: Record<string, string> = {};
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        try {
          const { getVersion } = await import("@tauri-apps/api/app");
          versionHeaders["X-Client-Version"] = await getVersion();
        } catch {
          // Not fatal — version header is optional
        }
      }
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
        headers: versionHeaders,
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Login failed" };
      }

      if (data.requiresTwoFactor && data.challengeToken) {
        return {
          error: null,
          requiresTwoFactor: true,
          challengeToken: data.challengeToken,
        };
      }

      const nextTokens = { ...tokensByServer, [serverUrl]: data.token };
      setTokens(nextTokens);
      setToken(data.token);
      setTokenState(data.token);
      setUser({
        id: data.user.id,
        email: data.user.email,
        isAdmin: data.user.isAdmin || false,
        permissions: mapPermissions(data.user),
      });
      upsertServer(serverUrl);

      // Fetch full profile
      const profileRes = await apiFetch("/api/auth/me");
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        setProfile(mapServerProfile(profileData));
      }

      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function signInWithTwoFactor(challengeToken: string, code: string) {
    try {
      const versionHeaders: Record<string, string> = {};
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        try {
          const { getVersion } = await import("@tauri-apps/api/app");
          versionHeaders["X-Client-Version"] = await getVersion();
        } catch {
          // Not fatal — version header is optional
        }
      }
      const res = await apiFetch("/api/auth/login/2fa", {
        method: "POST",
        body: JSON.stringify({ challengeToken, code }),
        headers: versionHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "2FA verification failed" };
      }

      const nextTokens = { ...tokensByServer, [serverUrl]: data.token };
      setTokens(nextTokens);
      setToken(data.token);
      setTokenState(data.token);
      setUser({
        id: data.user.id,
        email: data.user.email,
        isAdmin: data.user.isAdmin || false,
        permissions: mapPermissions(data.user),
      });
      upsertServer(serverUrl);

      const profileRes = await apiFetch("/api/auth/me");
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        setProfile(mapServerProfile(profileData));
      }

      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function signUp(email: string, password: string, username: string, inviteCode?: string) {
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, username, inviteCode }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Registration failed" };
      }

      const nextTokens = { ...tokensByServer, [serverUrl]: data.token };
      setTokens(nextTokens);
      setToken(data.token);
      setTokenState(data.token);
      setUser({
        id: data.user.id,
        email: data.user.email,
        isAdmin: data.user.isAdmin || false,
        permissions: mapPermissions(data.user),
      });
      upsertServer(serverUrl);
      setProfile({
        ...DEFAULT_PROFILE,
        username: data.user.username || username,
      });

      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function requestPasswordReset(email: string) {
    try {
      const res = await apiFetch("/api/auth/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Failed to request password reset" };
      }
      return { error: null, message: data.message || "" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function confirmPasswordReset(resetToken: string, newPassword: string) {
    try {
      const res = await apiFetch("/api/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token: resetToken, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Failed to reset password" };
      }
      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function updateProfileFn(update: Profile) {
    if (!user) {
      return { error: "Not authenticated." };
    }

    try {
      const res = await apiFetch("/api/auth/profile", {
        method: "PUT",
        body: JSON.stringify({
          username: update.username.trim(),
          status: update.status,
          avatar_url: update.avatarUrl.trim(),
          about: update.about.trim(),
          desktop_notifications_enabled: update.desktopNotificationsEnabled ? 1 : 0,
          desktop_notifications_mentions_only: update.desktopNotificationsMentionsOnly ? 1 : 0,
          push_to_talk_enabled: update.pushToTalkEnabled ? 1 : 0,
          push_to_mute_enabled: update.pushToMuteEnabled ? 1 : 0,
          push_to_talk_key: update.pushToTalkKey.trim() || "Space",
          audio_input_sensitivity: Math.min(
            Math.max(update.audioInputSensitivity, 0),
            1
          ),
          noise_suppression_mode: update.noiseSuppressionMode,
          audio_input_id: update.audioInputId || null,
          audio_output_id: update.audioOutputId || null,
          video_input_id: update.videoInputId || null,
          video_background_mode: update.videoBackgroundMode,
          video_background_image_url: update.videoBackgroundImageUrl.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Update failed" };
      }

      setProfile(mapServerProfile(data));
      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function signOut() {
    // Sign out of the active in-memory session but keep saved server tokens.
    // Use signOutServer(url) when the user explicitly wants to remove saved login.
    setToken(null);
    setTokenState(null);
    setUser(null);
    setProfile(DEFAULT_PROFILE);
    setLoading(false);
    resetSocket();
  }

  function handleSetServerUrl(url: string, nameHint?: string) {
    switchToServer(url, nameHint, false);
  }

  function saveServer(url: string, nameHint?: string) {
    upsertServer(url, nameHint);
  }

  function removeServer(url: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;

    let fallbackServerUrl = "";
    setServers((prev) => {
      const next = prev.filter((entry) => entry.url !== normalized);
      fallbackServerUrl = next[0]?.url || "";
      writeSavedServers(next);
      return next;
    });
    const nextTokens = { ...tokensByServer };
    delete nextTokens[normalized];
    setTokens(nextTokens);

    if (serverUrl === normalized) {
      if (fallbackServerUrl) {
        switchToServer(fallbackServerUrl);
      } else {
        _setServerUrl("");
        setServerUrlState("");
        setToken(null);
        setTokenState(null);
        setUser(null);
        setProfile(DEFAULT_PROFILE);
        setLoading(false);
        resetSocket();
      }
    }
    if (homeServerUrl === normalized) {
      const nextHome = fallbackServerUrl || "";
      setHomeServerUrlState(nextHome);
      writeHomeServerUrl(nextHome);
    }
  }

  function signOutServer(url: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;
    if (!tokensByServer[normalized]) return;

    const nextTokens = { ...tokensByServer };
    delete nextTokens[normalized];
    setTokens(nextTokens);

    if (serverUrl === normalized) {
      setToken(null);
      setTokenState(null);
      setUser(null);
      setProfile(DEFAULT_PROFILE);
      setLoading(false);
      resetSocket();
    }
    if (homeServerUrl === normalized) {
      const fallbackHome =
        servers.find((entry) => entry.url !== normalized && Boolean(nextTokens[entry.url]))?.url ||
        servers.find((entry) => entry.url !== normalized)?.url ||
        "";
      setHomeServerUrlState(fallbackHome);
      writeHomeServerUrl(fallbackHome);
    }
  }

  function getServerToken(url: string): string | null {
    const normalized = normalizeServerUrl(url);
    return tokensByServer[normalized] || null;
  }

  async function buildClientVersionHeaders() {
    const versionHeaders: Record<string, string> = {};
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        versionHeaders["X-Client-Version"] = await getVersion();
      } catch {
        // Not fatal — version header is optional
      }
    }
    return versionHeaders;
  }

  async function loginToSavedServerWithPassword(
    targetServerUrl: string,
    email: string,
    password: string
  ) {
    const normalizedServerUrl = normalizeServerUrl(targetServerUrl);
    if (!normalizedServerUrl) {
      return { error: "Server address is required" };
    }
    try {
      const versionHeaders = await buildClientVersionHeaders();
      const res = await fetch(`${normalizedServerUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...versionHeaders,
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Login failed" };
      }
      if (data.requiresTwoFactor && data.challengeToken) {
        return {
          error: null,
          requiresTwoFactor: true,
          challengeToken: data.challengeToken,
        };
      }

      const nextTokens = { ...tokensByServer, [normalizedServerUrl]: data.token };
      setTokens(nextTokens);
      upsertServer(
        normalizedServerUrl,
        serverDirectoryByUrl[normalizedServerUrl]?.name || hostFromUrl(normalizedServerUrl)
      );
      setServerSessionStateByUrl((prev) => ({
        ...prev,
        [normalizedServerUrl]: "ready",
      }));
      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  async function loginToSavedServerWithTwoFactor(
    targetServerUrl: string,
    challengeToken: string,
    code: string
  ) {
    const normalizedServerUrl = normalizeServerUrl(targetServerUrl);
    if (!normalizedServerUrl) {
      return { error: "Server address is required" };
    }
    try {
      const versionHeaders = await buildClientVersionHeaders();
      const res = await fetch(`${normalizedServerUrl}/api/auth/login/2fa`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...versionHeaders,
        },
        body: JSON.stringify({ challengeToken, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "2FA verification failed" };
      }

      const nextTokens = { ...tokensByServer, [normalizedServerUrl]: data.token };
      setTokens(nextTokens);
      upsertServer(
        normalizedServerUrl,
        serverDirectoryByUrl[normalizedServerUrl]?.name || hostFromUrl(normalizedServerUrl)
      );
      setServerSessionStateByUrl((prev) => ({
        ...prev,
        [normalizedServerUrl]: "ready",
      }));
      return { error: null };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        username: profile.username,
        profile,
        loading,
        serverUrl,
        servers,
        homeServerUrl,
        setHomeServer,
        serverSessionStateByUrl,
        serverDirectoryByUrl,
        setServerUrl: handleSetServerUrl,
        switchServer: switchToServer,
        saveServer,
        removeServer,
        signOutServer,
        getServerToken,
        signInWithPassword,
        signInToSavedServerWithPassword: loginToSavedServerWithPassword,
        signInWithTwoFactor,
        signInToSavedServerWithTwoFactor: loginToSavedServerWithTwoFactor,
        signUp,
        requestPasswordReset,
        confirmPasswordReset,
        updateProfile: updateProfileFn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
