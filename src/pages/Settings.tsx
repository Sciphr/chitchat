import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import { apiFetch } from "../lib/api";

const THEMES = [
  { id: "midnight", label: "Midnight", accent: "#7c6aff", bg: "#0f0f17" },
  { id: "ember",    label: "Ember",    accent: "#f97316", bg: "#1a0f0b" },
  { id: "ocean",    label: "Ocean",    accent: "#06b6d4", bg: "#0b1420" },
  { id: "forest",   label: "Forest",   accent: "#22c55e", bg: "#0b150e" },
  { id: "rose",     label: "Rose",     accent: "#ec4899", bg: "#160b14" },
  { id: "slate",    label: "Slate",    accent: "#8b8cf8", bg: "#121418" },
  { id: "sunset",   label: "Sunset",   accent: "#f59e0b", bg: "#181008" },
  { id: "arctic",   label: "Arctic",   accent: "#3b82f6", bg: "#f0f4f8" },
] as const;

function getTheme(): string {
  return localStorage.getItem("chitchat-theme") || "midnight";
}

function setTheme(id: string) {
  localStorage.setItem("chitchat-theme", id);
  document.documentElement.dataset.theme = id;
}

const STATUS_OPTIONS = [
  { value: "online", label: "Online" },
  { value: "away", label: "Away" },
  { value: "dnd", label: "Do not disturb" },
  { value: "offline", label: "Offline" },
] as const;

const STATUS_STYLES: Record<
  "online" | "away" | "dnd" | "offline",
  { color: string; glow: string }
> = {
  online: { color: "var(--success)", glow: "rgba(52,211,153,0.6)" },
  away: { color: "#f59e0b", glow: "rgba(245,158,11,0.6)" },
  dnd: { color: "var(--danger)", glow: "rgba(248,113,113,0.6)" },
  offline: { color: "var(--text-muted)", glow: "rgba(148,163,184,0.35)" },
};

type SettingsProps = {
  onClose?: () => void;
  soundEnabled?: boolean;
  onSoundEnabledChange?: (v: boolean) => void;
  inAppToastsEnabled?: boolean;
  onInAppToastsEnabledChange?: (v: boolean) => void;
  inAppToastsMentionsOnly?: boolean;
  onInAppToastsMentionsOnlyChange?: (v: boolean) => void;
};

export default function Settings({
  onClose,
  soundEnabled = true,
  onSoundEnabledChange,
  inAppToastsEnabled = true,
  onInAppToastsEnabledChange,
  inAppToastsMentionsOnly = false,
  onInAppToastsMentionsOnlyChange,
}: SettingsProps) {
  const { user, profile, updateProfile } = useAuth();
  const isModal = Boolean(onClose);

  const [form, setForm] = useState({
    username: profile.username,
    status: profile.status,
    avatarUrl: profile.avatarUrl,
    about: profile.about,
    desktopNotificationsEnabled: profile.desktopNotificationsEnabled,
    desktopNotificationsMentionsOnly: profile.desktopNotificationsMentionsOnly,
    pushToTalkEnabled: profile.pushToTalkEnabled,
    pushToMuteEnabled: profile.pushToMuteEnabled,
    pushToTalkKey: profile.pushToTalkKey,
    audioInputSensitivity: profile.audioInputSensitivity,
    noiseSuppressionMode: profile.noiseSuppressionMode,
    audioInputId: profile.audioInputId,
    audioOutputId: profile.audioOutputId,
    videoInputId: profile.videoInputId,
    videoBackgroundMode: profile.videoBackgroundMode,
    videoBackgroundImageUrl: profile.videoBackgroundImageUrl,
    twoFactorEnabled: profile.twoFactorEnabled,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    return Notification.permission;
  });
  const [capturingKey, setCapturingKey] = useState(false);
  const [activeTheme, setActiveTheme] = useState(getTheme);
  const [activeTab, setActiveTab] = useState<"settings" | "public-profile">(
    "settings"
  );
  const [activeSettingsSection, setActiveSettingsSection] = useState<
    "identity" | "appearance" | "notifications" | "voice" | "security" | "about"
  >("identity");
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [videoPreviewActive, setVideoPreviewActive] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState<string | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(profile.twoFactorEnabled);
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);
  const [twoFactorError, setTwoFactorError] = useState("");
  const [twoFactorMessage, setTwoFactorMessage] = useState("");
  const [twoFactorSetup, setTwoFactorSetup] = useState<{
    secret: string;
    qrDataUrl: string;
    expiresAt: string;
  } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [micTestActive, setMicTestActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestAudioCtxRef = useRef<AudioContext | null>(null);
  const micTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const micTestRafRef = useRef<number | null>(null);
  const videoPreviewElRef = useRef<HTMLVideoElement | null>(null);
  const videoPreviewTrackRef = useRef<LocalVideoTrack | null>(null);
  const videoPreviewProcessorRef = useRef<ReturnType<typeof BackgroundProcessor> | null>(null);
  const statusStyle =
    STATUS_STYLES[form.status] || STATUS_STYLES.online;
  const publicStatusStyle =
    STATUS_STYLES[profile.status] || STATUS_STYLES.online;

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    setNotificationPermission(Notification.permission);
  }, []);

  useEffect(() => {
    setTwoFactorEnabled(profile.twoFactorEnabled);
  }, [profile.twoFactorEnabled]);

  useEffect(() => {
    setForm({
      username: profile.username,
      status: profile.status,
      avatarUrl: profile.avatarUrl,
      about: profile.about,
      desktopNotificationsEnabled: profile.desktopNotificationsEnabled,
      desktopNotificationsMentionsOnly: profile.desktopNotificationsMentionsOnly,
      pushToTalkEnabled: profile.pushToTalkEnabled,
      pushToMuteEnabled: profile.pushToMuteEnabled,
      pushToTalkKey: profile.pushToTalkKey,
      audioInputSensitivity: profile.audioInputSensitivity,
      noiseSuppressionMode: profile.noiseSuppressionMode,
      audioInputId: profile.audioInputId,
      audioOutputId: profile.audioOutputId,
      videoInputId: profile.videoInputId,
      videoBackgroundMode: profile.videoBackgroundMode,
      videoBackgroundImageUrl: profile.videoBackgroundImageUrl,
      twoFactorEnabled: profile.twoFactorEnabled,
    });
  }, [
    profile.username,
    profile.status,
    profile.avatarUrl,
    profile.about,
    profile.desktopNotificationsEnabled,
    profile.desktopNotificationsMentionsOnly,
    profile.pushToTalkEnabled,
    profile.pushToMuteEnabled,
    profile.pushToTalkKey,
    profile.audioInputSensitivity,
    profile.noiseSuppressionMode,
    profile.audioInputId,
    profile.audioOutputId,
    profile.videoInputId,
    profile.videoBackgroundMode,
    profile.videoBackgroundImageUrl,
    profile.twoFactorEnabled,
  ]);

  async function saveProfile() {
    setError("");
    setSuccess("");

    const trimmed = form.username.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("Username must be 2-24 characters.");
      return;
    }

    setSaving(true);
    const result = await updateProfile({
      username: trimmed,
      status: form.status,
      avatarUrl: form.avatarUrl,
      about: form.about,
      desktopNotificationsEnabled: form.desktopNotificationsEnabled,
      desktopNotificationsMentionsOnly: form.desktopNotificationsMentionsOnly,
      pushToTalkEnabled: form.pushToTalkEnabled,
      pushToMuteEnabled: form.pushToMuteEnabled,
      pushToTalkKey: form.pushToTalkKey,
      audioInputSensitivity: form.audioInputSensitivity,
      noiseSuppressionMode: form.noiseSuppressionMode,
      audioInputId: form.audioInputId,
      audioOutputId: form.audioOutputId,
      videoInputId: form.videoInputId,
      videoBackgroundMode: form.videoBackgroundMode,
      videoBackgroundImageUrl: form.videoBackgroundImageUrl,
      twoFactorEnabled: form.twoFactorEnabled,
    });
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setSuccess("Profile updated.");
  }

  async function beginTwoFactorSetup() {
    setTwoFactorLoading(true);
    setTwoFactorError("");
    setTwoFactorMessage("");
    try {
      const res = await apiFetch("/api/auth/2fa/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setTwoFactorError(data.error || "Failed to start 2FA setup");
        return;
      }
      setTwoFactorSetup({
        secret: data.secret || "",
        qrDataUrl: data.qrDataUrl || "",
        expiresAt: data.expiresAt || "",
      });
      setTwoFactorCode("");
    } catch (err) {
      setTwoFactorError(err instanceof Error ? err.message : "Failed to start 2FA setup");
    } finally {
      setTwoFactorLoading(false);
    }
  }

  async function enableTwoFactor() {
    const code = twoFactorCode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setTwoFactorError("Enter a valid 6-digit code.");
      return;
    }
    setTwoFactorLoading(true);
    setTwoFactorError("");
    setTwoFactorMessage("");
    try {
      const res = await apiFetch("/api/auth/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTwoFactorError(data.error || "Failed to enable 2FA");
        return;
      }
      setTwoFactorEnabled(true);
      setTwoFactorSetup(null);
      setTwoFactorCode("");
      setTwoFactorMessage("Two-factor authentication enabled.");
    } catch (err) {
      setTwoFactorError(err instanceof Error ? err.message : "Failed to enable 2FA");
    } finally {
      setTwoFactorLoading(false);
    }
  }

  async function disableTwoFactor() {
    const code = twoFactorCode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setTwoFactorError("Enter your current 6-digit code to disable 2FA.");
      return;
    }
    setTwoFactorLoading(true);
    setTwoFactorError("");
    setTwoFactorMessage("");
    try {
      const res = await apiFetch("/api/auth/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTwoFactorError(data.error || "Failed to disable 2FA");
        return;
      }
      setTwoFactorEnabled(false);
      setTwoFactorSetup(null);
      setTwoFactorCode("");
      setTwoFactorMessage("Two-factor authentication disabled.");
    } catch (err) {
      setTwoFactorError(err instanceof Error ? err.message : "Failed to disable 2FA");
    } finally {
      setTwoFactorLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await saveProfile();
  }

  async function requestDesktopNotificationPermission(): Promise<
    NotificationPermission | "unsupported"
  > {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setError("Desktop notifications are not supported on this platform.");
      return "unsupported";
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== "granted") {
        setForm((prev) => ({ ...prev, desktopNotificationsEnabled: false }));
        setError(
          permission === "denied"
            ? "Desktop notifications are blocked by your system/browser. Allow notifications for ChitChat and try again."
            : "Desktop notification permission was not granted."
        );
      } else {
        setError("");
        setSuccess("Desktop notification permission granted.");
      }
      return permission;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request notification permission");
      return "denied";
    }
  }

  async function handleDesktopNotificationsToggle() {
    const nextEnabled = !form.desktopNotificationsEnabled;
    if (!nextEnabled) {
      setForm((prev) => ({ ...prev, desktopNotificationsEnabled: false }));
      return;
    }

    if (notificationPermission !== "granted") {
      const permission = await requestDesktopNotificationPermission();
      if (permission !== "granted") {
        setForm((prev) => ({ ...prev, desktopNotificationsEnabled: false }));
        return;
      }
    }

    setForm((prev) => ({ ...prev, desktopNotificationsEnabled: true }));
    setError("");
  }

  function handleReset() {
    setForm({
      username: profile.username,
      status: profile.status,
      avatarUrl: profile.avatarUrl,
      about: profile.about,
      desktopNotificationsEnabled: profile.desktopNotificationsEnabled,
      desktopNotificationsMentionsOnly: profile.desktopNotificationsMentionsOnly,
      pushToTalkEnabled: profile.pushToTalkEnabled,
      pushToMuteEnabled: profile.pushToMuteEnabled,
      pushToTalkKey: profile.pushToTalkKey,
      audioInputSensitivity: profile.audioInputSensitivity,
      noiseSuppressionMode: profile.noiseSuppressionMode,
      audioInputId: profile.audioInputId,
      audioOutputId: profile.audioOutputId,
      videoInputId: profile.videoInputId,
      videoBackgroundMode: profile.videoBackgroundMode,
      videoBackgroundImageUrl: profile.videoBackgroundImageUrl,
      twoFactorEnabled: profile.twoFactorEnabled,
    });
    setError("");
    setSuccess("");
  }

  async function loadDevices(requestPermissions = false) {
    setDeviceError(null);
    try {
      async function primeMediaPermissions() {
        if (!navigator.mediaDevices?.getUserMedia) return;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
          });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          // Fallback to audio-only; some systems reject combined A/V prompts.
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          stream.getTracks().forEach((track) => track.stop());
        }
      }

      if (requestPermissions) {
        await primeMediaPermissions();
      }

      let devices = await navigator.mediaDevices.enumerateDevices();
      let audioIn = devices.filter((d) => d.kind === "audioinput");
      let audioOut = devices.filter((d) => d.kind === "audiooutput");
      let videoIn = devices.filter((d) => d.kind === "videoinput");

      setAudioInputs(audioIn);
      setAudioOutputs(audioOut);
      setVideoInputs(videoIn);
      if (audioIn.length <= 1 && audioOut.length <= 1) {
        setDeviceError("Only default devices are currently exposed. Try Refresh devices.");
      } else {
        setDeviceError(null);
      }
    } catch (err) {
      setDeviceError(
        err instanceof Error ? err.message : "Unable to load devices",
      );
    }
  }

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    void loadDevices(false);
    function onDeviceChange() {
      void loadDevices(false);
    }
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  function labelDevice(device: MediaDeviceInfo, index: number) {
    if (device.label) return device.label;
    switch (device.kind) {
      case "audioinput":
        return `Microphone ${index + 1}`;
      case "audiooutput":
        return `Speaker ${index + 1}`;
      default:
        return `Camera ${index + 1}`;
    }
  }

  useEffect(() => {
    if (!capturingKey) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setCapturingKey(false);
        return;
      }

      setForm((prev) => ({
        ...prev,
        pushToTalkKey: e.code || e.key,
      }));
      setCapturingKey(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capturingKey]);

  function formatKey(value: string) {
    if (!value) return "Space";
    if (value === "Space") return "Space";
    if (value.startsWith("Key")) return value.replace("Key", "");
    if (value.startsWith("Digit")) return value.replace("Digit", "");
    return value;
  }

  async function playSpeakerTest() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.04;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      window.setTimeout(() => {
        osc.stop();
        void ctx.close();
      }, 350);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Unable to play test tone");
    }
  }

  function stopMicTest() {
    if (micTestRafRef.current !== null) {
      window.cancelAnimationFrame(micTestRafRef.current);
      micTestRafRef.current = null;
    }
    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach((track) => track.stop());
      micTestStreamRef.current = null;
    }
    if (micTestAudioCtxRef.current) {
      void micTestAudioCtxRef.current.close();
      micTestAudioCtxRef.current = null;
    }
    micTestAnalyserRef.current = null;
    setMicLevel(0);
    setMicTestActive(false);
  }

  async function startMicTest() {
    try {
      stopMicTest();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: form.audioInputId
          ? { deviceId: { ideal: form.audioInputId } }
          : true,
        video: false,
      });
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      micTestStreamRef.current = stream;
      micTestAudioCtxRef.current = audioCtx;
      micTestAnalyserRef.current = analyser;
      setMicTestActive(true);

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!micTestAnalyserRef.current) return;
        micTestAnalyserRef.current.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicLevel(Math.min(1, rms * 3.2));
        micTestRafRef.current = window.requestAnimationFrame(tick);
      };
      micTestRafRef.current = window.requestAnimationFrame(tick);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Unable to start microphone test");
      stopMicTest();
    }
  }

  useEffect(() => {
    return () => {
      stopMicTest();
      const track = videoPreviewTrackRef.current;
      if (track) {
        try {
          track.detach();
        } catch {
          // no-op
        }
        track.stop();
      }
      videoPreviewTrackRef.current = null;
      videoPreviewProcessorRef.current = null;
    };
  }, []);

  async function applyPreviewBackground() {
    const track = videoPreviewTrackRef.current;
    if (!track) return;
    if (!supportsBackgroundProcessors()) return;

    if (!videoPreviewProcessorRef.current) {
      const processor = BackgroundProcessor({ mode: "disabled" });
      await track.setProcessor(processor);
      videoPreviewProcessorRef.current = processor;
    }

    const processor = videoPreviewProcessorRef.current;
    if (!processor) return;
    if (form.videoBackgroundMode === "blur") {
      await processor.switchTo({ mode: "background-blur", blurRadius: 12 });
      return;
    }
    if (
      form.videoBackgroundMode === "image" &&
      form.videoBackgroundImageUrl.trim()
    ) {
      await processor.switchTo({
        mode: "virtual-background",
        imagePath: form.videoBackgroundImageUrl.trim(),
      });
      return;
    }
    await processor.switchTo({ mode: "disabled" });
  }

  async function stopVideoPreview() {
    const track = videoPreviewTrackRef.current;
    if (track) {
      try {
        await track.stopProcessor();
      } catch {
        // ignore when no processor is attached
      }
      track.detach();
      track.stop();
    }
    videoPreviewTrackRef.current = null;
    videoPreviewProcessorRef.current = null;
    setVideoPreviewActive(false);
  }

  async function startVideoPreview() {
    setVideoPreviewError(null);
    try {
      await stopVideoPreview();
      const track = await createLocalVideoTrack(
        form.videoInputId ? { deviceId: form.videoInputId } : undefined
      );
      videoPreviewTrackRef.current = track;
      await applyPreviewBackground();
      setVideoPreviewActive(true);
    } catch (err) {
      setVideoPreviewError(
        err instanceof Error ? err.message : "Unable to start camera preview"
      );
      await stopVideoPreview();
    }
  }

  useEffect(() => {
    if (!videoPreviewActive) return;
    void startVideoPreview();
    // Recreate preview when selected camera changes.
  }, [form.videoInputId]);

  useEffect(() => {
    if (!videoPreviewActive) return;
    void applyPreviewBackground().catch(() => {
      setVideoPreviewError("Background preview is not supported on this device/browser.");
    });
  }, [videoPreviewActive, form.videoBackgroundMode, form.videoBackgroundImageUrl]);

  useEffect(() => {
    if (!videoPreviewActive) return;
    const track = videoPreviewTrackRef.current;
    const el = videoPreviewElRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [videoPreviewActive]);

  function handleBack() {
    if (onClose) {
      onClose();
      return;
    }
    window.history.back();
  }


  const content = (
    <div className="panel rounded-3xl profile-shell">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-xl md:text-3xl font-bold heading-font">
                Profile Studio
              </h1>
              <p className="text-sm text-[var(--text-muted)]">
                Shape how you appear across ChitChat.
              </p>
            </div>
            <div className="profile-actions" style={{ marginTop: 0 }}>
              <button
                type="button"
                onClick={handleBack}
                className="profile-button secondary"
              >
                {isModal ? "Close" : "Back"}
              </button>
              <button
                type="button"
                onClick={() => void saveProfile()}
                disabled={saving}
                className="profile-button"
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Profile tabs">
            <button
              type="button"
              className={`settings-tab ${activeTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveTab("settings")}
              role="tab"
              aria-selected={activeTab === "settings"}
            >
              Settings
            </button>
            <button
              type="button"
              className={`settings-tab ${activeTab === "public-profile" ? "active" : ""}`}
              onClick={() => setActiveTab("public-profile")}
              role="tab"
              aria-selected={activeTab === "public-profile"}
            >
              Public Profile
            </button>
          </div>

          <div className="grid gap-10 md:grid-cols-[280px_1fr] settings-layout-grid">
            <div className="space-y-6 settings-sidebar-pane">
              <div className="profile-card">
                <div className="profile-card-media">
                  {form.avatarUrl ? (
                    <img
                      src={form.avatarUrl}
                      alt={form.username}
                      className="profile-card-avatar"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        const span = document.createElement("span");
                        span.className = "profile-card-initial";
                        span.textContent = form.username.charAt(0).toUpperCase();
                        e.currentTarget.parentElement!.appendChild(span);
                      }}
                    />
                  ) : (
                    <span className="profile-card-initial">
                      {form.username.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="profile-card-body">
                  <div className="text-lg font-semibold heading-font">
                    {form.username || "Anonymous"}
                  </div>
                  <div className="profile-card-row">
                    <span
                      className="profile-status-dot"
                      style={{
                        background: statusStyle.color,
                        boxShadow: `0 0 10px ${statusStyle.glow}`,
                      }}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {
                        STATUS_OPTIONS.find((s) => s.value === form.status)
                          ?.label
                      }
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-secondary)] break-all">
                    {user?.email || ""}
                  </div>
                </div>
              </div>

              <div className="profile-side-card">
                <h3 className="profile-side-title">Quick Info</h3>
                <div className="profile-side-item">
                  <span className="text-[var(--text-muted)] text-xs">
                    User ID
                  </span>
                  <span className="text-xs text-[var(--text-secondary)] font-mono">
                    {user?.id || ""}
                  </span>
                </div>
                <div className="profile-side-item">
                  <span className="text-[var(--text-muted)] text-xs">
                    Email
                  </span>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {user?.email || ""}
                  </span>
                </div>
              </div>
            </div>

            {activeTab === "settings" ? (
              <form onSubmit={handleSave} className="space-y-6 settings-content-pane">
                <div className="settings-section-nav" role="tablist" aria-label="Settings sections">
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "identity" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("identity")}
                  >
                    Identity
                  </button>
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "appearance" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("appearance")}
                  >
                    Appearance
                  </button>
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "notifications" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("notifications")}
                  >
                    Notifications
                  </button>
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "voice" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("voice")}
                  >
                    Voice & Video
                  </button>
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "security" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("security")}
                  >
                    Security
                  </button>
                  <button
                    type="button"
                    className={`settings-tab ${activeSettingsSection === "about" ? "active" : ""}`}
                    onClick={() => setActiveSettingsSection("about")}
                  >
                    About
                  </button>
                </div>
                <div className="settings-content-body">
                {activeSettingsSection === "identity" && (
                <div className="profile-section">
                  <div className="profile-section-title">Identity</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Username</label>
                      <input
                        className="profile-input"
                        value={form.username}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            username: e.target.value,
                          }))
                        }
                        placeholder="Your handle"
                      />
                    </div>
                    <div>
                      <label className="profile-label">Status</label>
                      <select
                        className="profile-select"
                        value={form.status}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            status: e.target.value as
                              | "online"
                              | "offline"
                              | "away"
                              | "dnd",
                          }))
                        }
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                )}

                {activeSettingsSection === "appearance" && (
                <div className="profile-section">
                  <div className="profile-section-title">Appearance</div>
                  <div>
                    <label className="profile-label">Avatar URL</label>
                    <input
                      className="profile-input"
                      value={form.avatarUrl}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          avatarUrl: e.target.value,
                        }))
                      }
                      placeholder="https://..."
                    />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">Theme</label>
                    <div className="theme-picker">
                      {THEMES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`theme-swatch ${activeTheme === t.id ? "active" : ""}`}
                          onClick={() => { setTheme(t.id); setActiveTheme(t.id); }}
                          title={t.label}
                        >
                          <div
                            className="theme-swatch-preview"
                            style={{ background: t.bg, borderColor: activeTheme === t.id ? t.accent : "transparent" }}
                          >
                            <div className="theme-swatch-accent" style={{ background: t.accent }} />
                          </div>
                          <span className="theme-swatch-label">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                )}

                {activeSettingsSection === "notifications" && (
                <div className="profile-section">
                  <div className="profile-section-title">Notifications</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Desktop notifications</label>
                      <button
                        type="button"
                        onClick={() => void handleDesktopNotificationsToggle()}
                        className={`ptt-toggle ${
                          form.desktopNotificationsEnabled ? "active" : ""
                        }`}
                      >
                        {form.desktopNotificationsEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div>
                      <label className="profile-label">Desktop notify mode</label>
                      <select
                        className="profile-select"
                        value={form.desktopNotificationsMentionsOnly ? "mentions" : "all"}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            desktopNotificationsMentionsOnly: e.target.value === "mentions",
                          }))
                        }
                      >
                        <option value="mentions">Mentions + DMs</option>
                        <option value="all">All messages + DMs</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">OS permission</label>
                    <div className="profile-device-row">
                      <span className="text-xs text-[var(--text-muted)]">
                        {notificationPermission === "unsupported"
                          ? "Not supported on this platform"
                          : notificationPermission === "granted"
                            ? "Granted"
                            : notificationPermission === "denied"
                              ? "Denied"
                              : "Not requested"}
                      </span>
                      <button
                        type="button"
                        className="profile-button secondary"
                        onClick={() => void requestDesktopNotificationPermission()}
                        disabled={notificationPermission === "unsupported"}
                      >
                        Request permission
                      </button>
                    </div>
                  </div>

                  {/* In-app notification settings (no OS permission needed) */}
                  <div className="profile-section-title" style={{ marginTop: 20 }}>In-App Notifications</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Sound notifications</label>
                      <button
                        type="button"
                        className={`ptt-toggle ${soundEnabled ? "active" : ""}`}
                        onClick={() => onSoundEnabledChange?.(!soundEnabled)}
                      >
                        {soundEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div>
                      <label className="profile-label">In-app popups</label>
                      <button
                        type="button"
                        className={`ptt-toggle ${inAppToastsEnabled ? "active" : ""}`}
                        onClick={() => onInAppToastsEnabledChange?.(!inAppToastsEnabled)}
                      >
                        {inAppToastsEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    {inAppToastsEnabled && (
                      <div>
                        <label className="profile-label">Popup notify mode</label>
                        <select
                          className="profile-select"
                          value={inAppToastsMentionsOnly ? "mentions" : "all"}
                          onChange={(e) =>
                            onInAppToastsMentionsOnlyChange?.(e.target.value === "mentions")
                          }
                        >
                          <option value="all">All messages + DMs</option>
                          <option value="mentions">Mentions + DMs only</option>
                        </select>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-(--text-muted)" style={{ marginTop: 8 }}>
                    In-app popups appear when the app is in the background. No OS permission required.
                  </p>
                </div>
                )}

                {activeSettingsSection === "voice" && (
                <div className="profile-section">
                  <div className="profile-section-title">Voice & Video</div>
                  <div className="profile-grid">
                    <div>
                      <label className="profile-label">Push-to-talk</label>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            pushToTalkEnabled: !prev.pushToTalkEnabled,
                            pushToMuteEnabled: !prev.pushToTalkEnabled ? false : prev.pushToMuteEnabled,
                          }))
                        }
                        className={`ptt-toggle ${
                          form.pushToTalkEnabled ? "active" : ""
                        }`}
                      >
                        {form.pushToTalkEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div>
                      <label className="profile-label">Push-to-mute</label>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            pushToMuteEnabled: !prev.pushToMuteEnabled,
                            pushToTalkEnabled: !prev.pushToMuteEnabled ? false : prev.pushToTalkEnabled,
                          }))
                        }
                        className={`ptt-toggle ${
                          form.pushToMuteEnabled ? "active" : ""
                        }`}
                      >
                        {form.pushToMuteEnabled ? "Enabled" : "Disabled"}
                      </button>
                    </div>
                    <div>
                      <label className="profile-label">PTT Key</label>
                      <button
                        type="button"
                        onClick={() => setCapturingKey(true)}
                        className="ptt-key"
                      >
                        {capturingKey
                          ? "Press any key..."
                          : formatKey(form.pushToTalkKey)}
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">
                      Input sensitivity ({Math.round(form.audioInputSensitivity * 100)}%)
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(form.audioInputSensitivity * 100)}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          audioInputSensitivity: Number(e.target.value) / 100,
                        }))
                      }
                      className="voice-mix-slider"
                    />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">Noise suppression</label>
                    <select
                      className="profile-select"
                      value={form.noiseSuppressionMode}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          noiseSuppressionMode: e.target.value as
                            | "off"
                            | "standard"
                            | "aggressive"
                            | "rnnoise",
                        }))
                      }
                    >
                      <option value="off">Off</option>
                      <option value="standard">Standard</option>
                      <option value="aggressive">Aggressive</option>
                      <option value="rnnoise">RNNoise (High)</option>
                    </select>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">Video background</label>
                    <select
                      className="profile-select"
                      value={form.videoBackgroundMode}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          videoBackgroundMode: e.target.value as "off" | "blur" | "image",
                        }))
                      }
                    >
                      <option value="off">Off</option>
                      <option value="blur">Blur</option>
                      <option value="image">Image</option>
                    </select>
                  </div>
                  {form.videoBackgroundMode === "image" && (
                    <div style={{ marginTop: 12 }}>
                      <label className="profile-label">Background image URL</label>
                      <input
                        className="profile-input"
                        value={form.videoBackgroundImageUrl}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            videoBackgroundImageUrl: e.target.value,
                          }))
                        }
                        placeholder="https://..."
                      />
                    </div>
                  )}
                  <div className="profile-grid profile-grid--three">
                    <div>
                      <label className="profile-label">Microphone</label>
                      <select
                        className="profile-select"
                        value={form.audioInputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            audioInputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {audioInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="profile-label">Speakers</label>
                      <select
                        className="profile-select"
                        value={form.audioOutputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            audioOutputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {audioOutputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="profile-label">Camera</label>
                      <select
                        className="profile-select"
                        value={form.videoInputId}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            videoInputId: e.target.value,
                          }))
                        }
                      >
                        <option value="">System default</option>
                        {videoInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {labelDevice(device, index)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <label className="profile-label">Video background preview</label>
                    <div
                      style={{
                        width: "100%",
                        maxWidth: 420,
                        aspectRatio: "16 / 9",
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        overflow: "hidden",
                        background: "var(--bg-secondary)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {videoPreviewActive ? (
                        <video
                          ref={videoPreviewElRef}
                          autoPlay
                          muted
                          playsInline
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <span className="text-xs text-[var(--text-muted)]">
                          Camera preview is off
                        </span>
                      )}
                    </div>
                    <div className="profile-device-row" style={{ marginTop: 8 }}>
                      {videoPreviewActive ? (
                        <button
                          type="button"
                          className="profile-button secondary"
                          onClick={() => void stopVideoPreview()}
                        >
                          Stop preview
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="profile-button secondary"
                          onClick={() => void startVideoPreview()}
                        >
                          Start preview
                        </button>
                      )}
                      {videoPreviewError && (
                        <span className="text-xs text-[var(--danger)]">
                          {videoPreviewError}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="profile-device-row">
                    <button
                      type="button"
                      className="profile-button secondary"
                      onClick={() => loadDevices(true)}
                    >
                      Refresh devices
                    </button>
                    <button
                      type="button"
                      className="profile-button secondary"
                      onClick={() => void playSpeakerTest()}
                    >
                      Test speakers
                    </button>
                    {micTestActive ? (
                      <button
                        type="button"
                        className="profile-button secondary"
                        onClick={stopMicTest}
                      >
                        Stop mic test
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="profile-button secondary"
                        onClick={() => void startMicTest()}
                      >
                        Test microphone
                      </button>
                    )}
                    {deviceError && (
                      <span className="text-xs text-[var(--danger)]">
                        {deviceError}
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <label className="profile-label">Mic level</label>
                    <div className="chat-upload-progress-track">
                      <div
                        className="chat-upload-progress-fill"
                        style={{ width: `${Math.round(micLevel * 100)}%` }}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]" style={{ marginTop: 8 }}>
                    Screen share quality is chosen when you start sharing.
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    Hold your key to transmit (PTT) or to mute (PTM).
                  </p>
                </div>
                )}

                {activeSettingsSection === "security" && (
                <div className="profile-section">
                  <div className="profile-section-title">Security</div>
                  <div className="text-xs text-[var(--text-muted)]" style={{ marginBottom: 10 }}>
                    Two-factor authentication (authenticator app)
                  </div>
                  <div className="profile-device-row">
                    {!twoFactorEnabled ? (
                      <button
                        type="button"
                        className="profile-button secondary"
                        onClick={() => void beginTwoFactorSetup()}
                        disabled={twoFactorLoading}
                      >
                        {twoFactorLoading ? "Preparing..." : "Set up 2FA"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="profile-button secondary"
                        onClick={() => void disableTwoFactor()}
                        disabled={twoFactorLoading}
                      >
                        {twoFactorLoading ? "Saving..." : "Disable 2FA"}
                      </button>
                    )}
                    <span className="text-xs text-[var(--text-muted)]">
                      Status: {twoFactorEnabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  {twoFactorSetup && !twoFactorEnabled && (
                    <div style={{ marginTop: 12 }}>
                      <div className="text-xs text-[var(--text-muted)]" style={{ marginBottom: 8 }}>
                        Scan QR in Google Authenticator, 1Password, Authy, etc.
                      </div>
                      {twoFactorSetup.qrDataUrl ? (
                        <img
                          src={twoFactorSetup.qrDataUrl}
                          alt="2FA QR code"
                          style={{
                            width: 180,
                            height: 180,
                            borderRadius: 8,
                            border: "1px solid var(--border)",
                            background: "#fff",
                            padding: 6,
                          }}
                        />
                      ) : null}
                      <div className="text-xs text-[var(--text-muted)]" style={{ marginTop: 8 }}>
                        Manual key: <span className="font-mono">{twoFactorSetup.secret}</span>
                      </div>
                      <div className="text-xs text-[var(--text-muted)]" style={{ marginTop: 4 }}>
                        Expires: {new Date(twoFactorSetup.expiresAt).toLocaleString()}
                      </div>
                      <div style={{ marginTop: 10, maxWidth: 280 }}>
                        <label className="profile-label">Authenticator code</label>
                        <input
                          className="profile-input"
                          value={twoFactorCode}
                          onChange={(e) => setTwoFactorCode(e.target.value)}
                          placeholder="123456"
                          inputMode="numeric"
                        />
                      </div>
                      <div className="profile-device-row" style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          className="profile-button"
                          onClick={() => void enableTwoFactor()}
                          disabled={twoFactorLoading}
                        >
                          {twoFactorLoading ? "Verifying..." : "Enable 2FA"}
                        </button>
                        <button
                          type="button"
                          className="profile-button secondary"
                          onClick={() => {
                            setTwoFactorSetup(null);
                            setTwoFactorCode("");
                            setTwoFactorError("");
                          }}
                          disabled={twoFactorLoading}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {twoFactorEnabled && (
                    <div style={{ marginTop: 10, maxWidth: 280 }}>
                      <label className="profile-label">Code to disable</label>
                      <input
                        className="profile-input"
                        value={twoFactorCode}
                        onChange={(e) => setTwoFactorCode(e.target.value)}
                        placeholder="123456"
                        inputMode="numeric"
                      />
                    </div>
                  )}
                  {twoFactorError && (
                    <div className="text-sm text-[var(--danger)]" style={{ marginTop: 10 }}>
                      {twoFactorError}
                    </div>
                  )}
                  {twoFactorMessage && (
                    <div className="text-sm text-[var(--success)]" style={{ marginTop: 10 }}>
                      {twoFactorMessage}
                    </div>
                  )}
                </div>
                )}

                {activeSettingsSection === "about" && (
                <div className="profile-section">
                  <div className="profile-section-title">About</div>
                  <textarea
                    className="profile-textarea"
                    value={form.about}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, about: e.target.value }))
                    }
                    placeholder="A short bio or what you are working on"
                  />
                </div>
                )}

                {error && (
                  <div className="text-sm text-[var(--danger)]">{error}</div>
                )}
                {success && (
                  <div className="text-sm text-[var(--success)]">{success}</div>
                )}

                <div className="profile-actions">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="profile-button secondary"
                  >
                    Reset
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="profile-button"
                  >
                    {saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
                </div>
              </form>
            ) : (
              <div className="profile-public-pane settings-content-pane">
                <div className="profile-section">
                  <div className="profile-section-title">Public Profile</div>
                  <div className="profile-public-name heading-font">
                    {profile.username || "Anonymous"}
                  </div>
                  <div className="profile-card-row">
                    <span
                      className="profile-status-dot"
                      style={{
                        background: publicStatusStyle.color,
                        boxShadow: `0 0 10px ${publicStatusStyle.glow}`,
                      }}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {STATUS_OPTIONS.find((s) => s.value === profile.status)?.label}
                    </span>
                  </div>
                  <div className="profile-public-about">
                    {profile.about?.trim() || "No bio provided."}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
  );

  if (isModal) {
    return (
      <div className="settings-modal-backdrop" onClick={handleBack}>
        <div
          className="settings-modal-window"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="settings-modal-scroll">
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[var(--bg-primary)] profile-page">
      <div className="absolute inset-0 app-bg" />
      <div className="relative z-10 w-full min-h-screen flex items-center justify-center py-12">
        {content}
      </div>
    </div>
  );
}
