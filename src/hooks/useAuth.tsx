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

interface UserInfo {
  id: string;
  email: string;
  isAdmin: boolean;
}

interface Profile {
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  about: string;
  pushToTalkEnabled: boolean;
  pushToTalkKey: string;
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
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
  switchServer: (url: string) => void;
  saveServer: (url: string, nameHint?: string) => void;
  removeServer: (url: string) => void;
  getServerToken: (url: string) => string | null;
  signInWithPassword: (
    email: string,
    password: string
  ) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    username: string,
    inviteCode?: string
  ) => Promise<{ error: string | null }>;
  updateProfile: (profile: Profile) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const DEFAULT_PROFILE: Profile = {
  username: "Anonymous",
  status: "online",
  avatarUrl: "",
  about: "",
  pushToTalkEnabled: false,
  pushToTalkKey: "Space",
  audioInputId: "",
  audioOutputId: "",
  videoInputId: "",
};

export interface SavedServer {
  url: string;
  name: string;
  lastUsedAt: string;
}

const SERVERS_STORAGE_KEY = "chitchat_servers";
const TOKENS_BY_SERVER_STORAGE_KEY = "chitchat_tokens_by_server";

const AuthContext = createContext<AuthContext | null>(null);

function mapServerProfile(data: Record<string, any>): Profile {
  return {
    username: data.username || "Anonymous",
    status: (data.status as Profile["status"]) || "online",
    avatarUrl: data.avatar_url || "",
    about: data.about || "",
    pushToTalkEnabled: Boolean(data.push_to_talk_enabled),
    pushToTalkKey: data.push_to_talk_key || "Space",
    audioInputId: data.audio_input_id || "",
    audioOutputId: data.audio_output_id || "",
    videoInputId: data.video_input_id || "",
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

function readSavedServers(activeServerUrl: string): SavedServer[] {
  try {
    const raw = localStorage.getItem(SERVERS_STORAGE_KEY);
    if (!raw) {
      if (!activeServerUrl) return [];
      return [
        {
          url: activeServerUrl,
          name: hostFromUrl(activeServerUrl),
          lastUsedAt: new Date().toISOString(),
        },
      ];
    }
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const initialServerUrl = normalizeServerUrl(getServerUrl());
  const [servers, setServers] = useState<SavedServer[]>(() =>
    readSavedServers(initialServerUrl)
  );
  const [tokensByServer, setTokensByServer] = useState<Record<string, string>>(() =>
    readTokensByServer(initialServerUrl)
  );
  const [token, setTokenState] = useState<string | null>(
    () => tokensByServer[initialServerUrl] || null
  );
  const [user, setUser] = useState<UserInfo | null>(null);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrlState] = useState(initialServerUrl);

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

  function switchToServer(url: string, nameHint?: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;
    upsertServer(normalized, nameHint);
    _setServerUrl(normalized);
    setServerUrlState(normalized);
    const nextToken = tokensByServer[normalized] || null;
    setToken(nextToken);
    setTokenState(nextToken);
    setUser(null);
    setProfile(DEFAULT_PROFILE);
    setLoading(true);
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
    apiFetch("/api/auth/me")
      .then((res) => {
        if (!res.ok) throw new Error("Invalid token");
        return res.json();
      })
      .then((data) => {
        setUser({ id: data.id, email: data.email, isAdmin: data.isAdmin || false });
        setProfile(mapServerProfile(data));
      })
      .catch(() => {
        const nextTokens = { ...tokensByServer };
        delete nextTokens[serverUrl];
        setTokens(nextTokens);
        setToken(null);
        setTokenState(null);
        setUser(null);
        setProfile(DEFAULT_PROFILE);
      })
      .finally(() => setLoading(false));
  }, [serverUrl, token, tokensByServer]);

  async function signInWithPassword(email: string, password: string) {
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        return { error: data.error || "Login failed" };
      }

      const nextTokens = { ...tokensByServer, [serverUrl]: data.token };
      setTokens(nextTokens);
      setToken(data.token);
      setTokenState(data.token);
      setUser({ id: data.user.id, email: data.user.email, isAdmin: data.user.isAdmin || false });
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
      setUser({ id: data.user.id, email: data.user.email, isAdmin: data.user.isAdmin || false });
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
          push_to_talk_enabled: update.pushToTalkEnabled ? 1 : 0,
          push_to_talk_key: update.pushToTalkKey.trim() || "Space",
          audio_input_id: update.audioInputId || null,
          audio_output_id: update.audioOutputId || null,
          video_input_id: update.videoInputId || null,
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
    const nextTokens = { ...tokensByServer };
    delete nextTokens[serverUrl];
    setTokens(nextTokens);
    setToken(null);
    setTokenState(null);
    setUser(null);
    setProfile(DEFAULT_PROFILE);
    setLoading(false);
    resetSocket();
  }

  function handleSetServerUrl(url: string, nameHint?: string) {
    switchToServer(url, nameHint);
  }

  function saveServer(url: string, nameHint?: string) {
    upsertServer(url, nameHint);
  }

  function removeServer(url: string) {
    const normalized = normalizeServerUrl(url);
    if (!normalized) return;

    setServers((prev) => {
      const next = prev.filter((entry) => entry.url !== normalized);
      writeSavedServers(next);
      return next;
    });
    const nextTokens = { ...tokensByServer };
    delete nextTokens[normalized];
    setTokens(nextTokens);

    if (serverUrl === normalized) {
      const fallback = servers.find((entry) => entry.url !== normalized)?.url || "";
      if (fallback) {
        switchToServer(fallback);
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
  }

  function getServerToken(url: string): string | null {
    const normalized = normalizeServerUrl(url);
    return tokensByServer[normalized] || null;
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
        setServerUrl: handleSetServerUrl,
        switchServer: switchToServer,
        saveServer,
        removeServer,
        getServerToken,
        signInWithPassword,
        signUp,
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
