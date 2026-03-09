import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { Room, ScreenShareSource, VoiceControls } from "../../types";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useLocalParticipant,
  useRoomContext,
  useTracks,
  useParticipants,
  useIsSpeaking,
  isTrackReference,
} from "@livekit/components-react";
import {
  Track,
  RoomEvent,
  ConnectionState,
  AudioPresets,
  LocalAudioTrack,
  RemoteAudioTrack,
  LocalVideoTrack,
  VideoPresets,
  DefaultReconnectPolicy,
} from "livekit-client";
import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import { LiveKitRnnoiseProcessor, supportsRnnoiseProcessing } from "../../lib/rnnoiseProcessor";
import { Volume2, VolumeX } from "lucide-react";
import type { Profile, UserInfo } from "../../hooks/useAuth";
import {
  fetchLiveKitToken,
  resolveResolution,
  clampResolution,
  clampFps,
  getRecommendedScreenShareQuality,
} from "../../lib/livekit";
import type { MediaLimits } from "../../lib/livekit";
import { playJoin, playLeave, playMute, playUnmute, playDeafen, playUndeafen } from "../../lib/sounds";
import {
  isProbablyTauri,
  listNativeScreenShareSources,
  startNativeScreenShare,
  stopNativeScreenShare,
} from "../../lib/nativeScreenShare";
import {
  listNativeAudioInputDevices,
  setNativeMicrophoneMuted,
  startNativeMicrophone,
  stopNativeMicrophone,
} from "../../lib/nativeVoice";

interface VoiceChannelProps {
  room: Room;
  serverUrl: string;
  livekitUrl: string;
  authToken: string | null;
  authUser: UserInfo | null;
  authProfile: Profile;
  autoJoin?: boolean;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
  onVoiceControlsChange?: (roomId: string, controls: VoiceControls | null) => void;
  currentUserId?: string | null;
  currentParticipants?: VoiceParticipant[];
  remoteControlSession?: {
    sessionId: string;
    roomId: string;
    controllerUserId: string;
    hostUserId: string;
    expiresAt: string;
  } | null;
  remoteControlPendingHostId?: string | null;
  onRequestScreenControl?: (hostUserId: string, roomId: string) => void;
  onRevokeScreenControl?: (sessionId: string) => void;
  onSendRemoteControlInput?: (event: {
    type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
    xNorm?: number;
    yNorm?: number;
    button?: "left" | "right" | "middle";
    deltaY?: number;
    key?: string;
  }) => void;
}

interface VoiceParticipant {
  id: string;
  name: string;
  isSpeaking: boolean;
}

const NATIVE_SCREEN_SHARE_SUFFIX = "::screenshare";
const NATIVE_VOICE_SUFFIX = "::nativevoice";

function isNativeScreenShareIdentity(identity?: string | null) {
  return Boolean(identity && identity.endsWith(NATIVE_SCREEN_SHARE_SUFFIX));
}

function isNativeVoiceIdentity(identity?: string | null) {
  return Boolean(identity && identity.endsWith(NATIVE_VOICE_SUFFIX));
}

function getHostIdentityFromScreenShareIdentity(identity?: string | null) {
  if (!identity) return "";
  return isNativeScreenShareIdentity(identity)
    ? identity.slice(0, -NATIVE_SCREEN_SHARE_SUFFIX.length)
    : identity;
}

function getHostIdentityFromNativeVoiceIdentity(identity?: string | null) {
  if (!identity) return "";
  return isNativeVoiceIdentity(identity)
    ? identity.slice(0, -NATIVE_VOICE_SUFFIX.length)
    : identity;
}

function isHiddenCompanionIdentity(identity?: string | null) {
  return isNativeScreenShareIdentity(identity) || isNativeVoiceIdentity(identity);
}

function supportsNativeMicrophoneCapture() {
  if (!isProbablyTauri()) return false;
  if (typeof navigator === "undefined") return false;
  return /windows/i.test(navigator.userAgent);
}

function VoiceRoomContent({
  onLeave,
  pushToTalkEnabled,
  pushToMuteEnabled,
  pushToTalkKey,
  audioInputSensitivity,
  noiseSuppressionMode,
  videoBackgroundMode,
  videoBackgroundImageUrl,
  preferredAudioInputId,
  preferredAudioOutputId,
  roomId,
  serverUrl,
  authToken,
  livekitUrl,
  mediaLimits,
  onParticipantsChange,
  onVoiceControlsChange,
  currentUserId,
  remoteControlSession,
  remoteControlPendingHostId,
  onRequestScreenControl,
  onRevokeScreenControl,
  onSendRemoteControlInput,
}: {
  onLeave: () => void;
  pushToTalkEnabled: boolean;
  pushToMuteEnabled: boolean;
  pushToTalkKey: string;
  audioInputSensitivity: number;
  noiseSuppressionMode: "off" | "standard" | "aggressive" | "rnnoise";
  videoBackgroundMode: "off" | "blur" | "image";
  videoBackgroundImageUrl: string;
  preferredAudioInputId: string;
  preferredAudioOutputId: string;
  roomId: string;
  serverUrl: string;
  authToken: string | null;
  livekitUrl: string;
  mediaLimits: MediaLimits;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
  onVoiceControlsChange?: (roomId: string, controls: VoiceControls | null) => void;
  currentUserId?: string | null;
  remoteControlSession?: {
    sessionId: string;
    roomId: string;
    controllerUserId: string;
    hostUserId: string;
    expiresAt: string;
  } | null;
  remoteControlPendingHostId?: string | null;
  onRequestScreenControl?: (hostUserId: string, roomId: string) => void;
  onRevokeScreenControl?: (sessionId: string) => void;
  onSendRemoteControlInput?: (event: {
    type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
    xNorm?: number;
    yNorm?: number;
    button?: "left" | "right" | "middle";
    deltaY?: number;
    key?: string;
  }) => void;
}) {
  const room = useRoomContext();
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const [manualMute, setManualMute] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isConnected, setIsConnected] = useState(
    room.state === ConnectionState.Connected
  );
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(
    noiseSuppressionMode !== "off"
  );
  const [audioInputDeviceId, setAudioInputDeviceId] = useState("");
  const [audioOutputDeviceId, setAudioOutputDeviceId] = useState("");
  const [participantVolumes, setParticipantVolumes] = useState<
    Record<string, number>
  >({});
  const [screenShareVolumes, setScreenShareVolumes] = useState<Record<string, number>>({});
  const [screenShareMuted, setScreenShareMuted] = useState<Record<string, boolean>>({});
  const [screenShareMode, setScreenShareMode] = useState<"browser" | "native" | null>(null);
  const backgroundProcessorRef = useRef<ReturnType<typeof BackgroundProcessor> | null>(null);
  const rnnoiseProcessorRef = useRef<LiveKitRnnoiseProcessor | null>(null);
  const rnnoiseAudioContextRef = useRef<AudioContext | null>(null);

  const localIdentity = room.localParticipant.identity;
  const usesNativeMicrophone = supportsNativeMicrophoneCapture();
  const visibleParticipants = useMemo(() => {
    const deduped = new Map<string, (typeof participants)[number] | typeof localParticipant>();
    participants.forEach((participant) => {
      if (isHiddenCompanionIdentity(participant.identity)) return;
      deduped.set(participant.identity, participant);
    });
    if (localParticipant?.identity && !isHiddenCompanionIdentity(localParticipant.identity)) {
      deduped.set(localParticipant.identity, localParticipant);
    }
    return Array.from(deduped.values());
  }, [localParticipant, participants]);
  const nativeVoiceParticipants = useMemo(
    () =>
      participants.filter((participant) =>
        isNativeVoiceIdentity(participant.identity)
      ),
    [participants]
  );
  const remoteParticipants = useMemo(
    () => visibleParticipants.filter((participant) => participant.identity !== localIdentity),
    [visibleParticipants, localIdentity]
  );
  const speakingStateByIdentity = useMemo(() => {
    const next = new Map<string, boolean>();
    visibleParticipants.forEach((participant) => {
      next.set(
        participant.identity,
        (participant.audioLevel ?? 0) > 0.02 || Boolean(participant.isSpeaking)
      );
    });
    nativeVoiceParticipants.forEach((participant) => {
      const hostIdentity = getHostIdentityFromNativeVoiceIdentity(participant.identity);
      if (!hostIdentity) return;
      if ((participant.audioLevel ?? 0) > 0.02 || participant.isSpeaking) {
        next.set(hostIdentity, true);
      }
    });
    return next;
  }, [visibleParticipants, nativeVoiceParticipants]);

  const formattedKey = useMemo(() => {
    if (!pushToTalkKey) return "Space";
    if (pushToTalkKey === "Space") return "Space";
    if (pushToTalkKey.startsWith("Key")) return pushToTalkKey.replace("Key", "");
    if (pushToTalkKey.startsWith("Digit")) return pushToTalkKey.replace("Digit", "");
    return pushToTalkKey;
  }, [pushToTalkKey]);

  useEffect(() => {
    setNoiseSuppressionEnabled(noiseSuppressionMode !== "off");
  }, [noiseSuppressionMode]);

  const activeNoiseSuppressionMode = useMemo<"off" | "standard" | "aggressive" | "rnnoise">(
    () => (noiseSuppressionEnabled ? noiseSuppressionMode === "off" ? "standard" : noiseSuppressionMode : "off"),
    [noiseSuppressionEnabled, noiseSuppressionMode]
  );

  const micCaptureOptions = useMemo(
    () => ({
      noiseSuppression:
        activeNoiseSuppressionMode === "standard" ||
        activeNoiseSuppressionMode === "aggressive",
      // Keep echo cancellation on for all processed paths; it helps more than it hurts
      // for typical laptop/headset use, and RNNoise still runs as a separate processor.
      echoCancellation: activeNoiseSuppressionMode !== "off",
      // Auto gain tends to create more pumping artifacts than it solves here.
      autoGainControl: false,
      channelCount:
        activeNoiseSuppressionMode === "aggressive" ||
        activeNoiseSuppressionMode === "rnnoise"
          ? 1
          : undefined,
    }),
    [activeNoiseSuppressionMode]
  );

  useEffect(() => {
    setIsConnected(room.state === ConnectionState.Connected);
    function onConnectionStateChanged(nextState: ConnectionState) {
      setIsConnected(nextState === ConnectionState.Connected);
    }
    room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
    };
  }, [room]);

  // Mic enable/disable + RNNoise processing (merged to avoid race condition).
  // setMicrophoneEnabled must complete before we can get the track to attach a processor.
  useEffect(() => {
    if (!room) return;
    if (usesNativeMicrophone) return;
    if (room.state !== ConnectionState.Connected) return;

    async function applyMicState() {
      if (pushToTalkEnabled || manualMute || deafened) {
        await room.localParticipant.setMicrophoneEnabled(false);
        return;
      }

      await room.localParticipant.setMicrophoneEnabled(true, micCaptureOptions);

      const micPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const micTrack = micPublication?.track;
      if (!(micTrack instanceof LocalAudioTrack)) return;

      const wantsRnnoise =
        activeNoiseSuppressionMode === "rnnoise" && supportsRnnoiseProcessing();

      if (wantsRnnoise) {
        try {
          if (!rnnoiseAudioContextRef.current || rnnoiseAudioContextRef.current.state === "closed") {
            rnnoiseAudioContextRef.current = new AudioContext();
          }
          const ctx = rnnoiseAudioContextRef.current;
          micTrack.setAudioContext(ctx);
          if (!rnnoiseProcessorRef.current) {
            rnnoiseProcessorRef.current = new LiveKitRnnoiseProcessor();
          }
          await micTrack.setProcessor(rnnoiseProcessorRef.current as any);
          return;
        } catch {
          // If RNNoise setup fails on this platform, continue with regular capture.
        }
      }

      try {
        await micTrack.stopProcessor();
      } catch {
        // No-op when no processor is attached.
      }
    }

    void applyMicState().catch(() => {
      // Connection can drop while applying; ignore transient publish errors.
    });
  }, [
    room,
    usesNativeMicrophone,
    pushToTalkEnabled,
    manualMute,
    deafened,
    micCaptureOptions,
    activeNoiseSuppressionMode,
  ]);

  // Open-mic input sensitivity gate: auto-mute the mic when below the threshold.
  useEffect(() => {
    if (!room) return;
    if (usesNativeMicrophone) return;
    if (room.state !== ConnectionState.Connected) return;
    if (pushToTalkEnabled || pushToMuteEnabled || manualMute || deafened) return;

    let disposed = false;
    let rafId: number | null = null;
    let monitorStream: MediaStream | null = null;
    let monitorAudioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphoneOpen = true;
    let belowSince = 0;

    // Sensitivity is stored as a 0-1 threshold; keep the practical gate window narrow.
    const baseThreshold = Math.min(0.12, Math.max(0.004, audioInputSensitivity));
    const openThreshold = baseThreshold * 1.2;
    const closeThreshold = baseThreshold;
    const closeDelayMs = 180;

    async function setMicEnabled(nextEnabled: boolean) {
      if (disposed || microphoneOpen === nextEnabled) return;
      microphoneOpen = nextEnabled;
      try {
        if (nextEnabled) {
          await room.localParticipant.setMicrophoneEnabled(true, micCaptureOptions);
        } else {
          await room.localParticipant.setMicrophoneEnabled(false);
        }
      } catch {
        // Ignore transient failures during reconnect/device switch.
      }
    }

    async function startMonitor() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: preferredAudioInputId
            ? { deviceId: { ideal: preferredAudioInputId } }
            : true,
          video: false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        monitorStream = stream;
        monitorAudioCtx = new AudioContext();
        const source = monitorAudioCtx.createMediaStreamSource(stream);
        analyser = monitorAudioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);

        const tick = (timestamp: number) => {
          if (!analyser || disposed) return;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const centered = (data[i] - 128) / 128;
            sum += centered * centered;
          }
          const rms = Math.sqrt(sum / data.length);
          if (rms >= openThreshold) {
            belowSince = 0;
            void setMicEnabled(true);
          } else if (rms <= closeThreshold) {
            if (!belowSince) belowSince = timestamp;
            if (timestamp - belowSince >= closeDelayMs) {
              void setMicEnabled(false);
            }
          }
          rafId = window.requestAnimationFrame(tick);
        };

        rafId = window.requestAnimationFrame(tick);
      } catch {
        // If we cannot create a monitor stream, keep regular open mic behavior.
      }
    }

    void startMonitor();

    return () => {
      disposed = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      if (monitorStream) {
        monitorStream.getTracks().forEach((t) => t.stop());
      }
      if (monitorAudioCtx) {
        void monitorAudioCtx.close();
      }
    };
  }, [
    room,
    usesNativeMicrophone,
    pushToTalkEnabled,
    pushToMuteEnabled,
    manualMute,
    deafened,
    audioInputSensitivity,
    preferredAudioInputId,
    micCaptureOptions,
  ]);

  const restartNativeMicrophone = useCallback(async (requestedDeviceId?: string) => {
    if (!usesNativeMicrophone || room.state !== ConnectionState.Connected || !livekitUrl) {
      return;
    }

    const availableDevices = await listNativeAudioInputDevices().catch(() => []);
    const resolvedDeviceId =
      requestedDeviceId && availableDevices.some((device) => device.id === requestedDeviceId)
        ? requestedDeviceId
        : "";

    const nativeToken = await fetchLiveKitToken({
      room: roomId,
      userId: room.localParticipant.identity,
      username: room.localParticipant.name || room.localParticipant.identity,
      purpose: "native_voice",
      serverUrl,
      authToken,
    });

    await startNativeMicrophone({
      livekitUrl,
      token: nativeToken.token,
      deviceId: resolvedDeviceId || undefined,
      noiseSuppressionMode: activeNoiseSuppressionMode,
      inputSensitivity: audioInputSensitivity,
      startMuted: manualMute || deafened || pushToTalkEnabled,
    });

    setAudioInputDeviceId(resolvedDeviceId);
  }, [
    usesNativeMicrophone,
    room,
    livekitUrl,
    roomId,
    serverUrl,
    authToken,
    activeNoiseSuppressionMode,
    audioInputSensitivity,
    manualMute,
    deafened,
    pushToTalkEnabled,
  ]);

  useEffect(() => {
    if (!usesNativeMicrophone) return;
    if (room.state !== ConnectionState.Connected) {
      void stopNativeMicrophone().catch(() => {});
      return;
    }

    let cancelled = false;
    void restartNativeMicrophone(preferredAudioInputId).catch((err) => {
      if (cancelled) return;
      console.error("Failed to start native microphone", err);
    });

    return () => {
      cancelled = true;
      void stopNativeMicrophone().catch(() => {});
    };
  }, [
    usesNativeMicrophone,
    room.state,
    restartNativeMicrophone,
    preferredAudioInputId,
  ]);

  useEffect(() => {
    if (!usesNativeMicrophone || room.state !== ConnectionState.Connected) return;
    void setNativeMicrophoneMuted(
      manualMute || deafened || pushToTalkEnabled
    ).catch(() => {
      // Ignore transient native control failures during reconnects.
    });
  }, [usesNativeMicrophone, room.state, manualMute, deafened, pushToTalkEnabled]);

  // Apply per-user volume (and deafen override) to all remote audio tracks.
  // Microphone and screen share audio are controlled independently.
  useEffect(() => {
    if (!room) return;

    function getMicVolume(participantId: string) {
      if (deafened) return 0;
      return participantVolumes[getHostIdentityFromNativeVoiceIdentity(participantId)] ?? 1;
    }

    function getScreenShareAudioVolume(participantId: string) {
      const hostParticipantId = getHostIdentityFromScreenShareIdentity(participantId);
      if (deafened) return 0;
      if (screenShareMuted[hostParticipantId]) return 0;
      return screenShareVolumes[hostParticipantId] ?? 1;
    }

    function applyVolumes() {
      room.remoteParticipants.forEach((participant) => {
        participant.getTrackPublications().forEach((pub) => {
          if (pub.track instanceof RemoteAudioTrack) {
            if (pub.source === Track.Source.ScreenShareAudio) {
              pub.track.setVolume(getScreenShareAudioVolume(participant.identity));
            } else {
              pub.track.setVolume(getMicVolume(participant.identity));
            }
          }
        });
      });
    }

    applyVolumes();

    function onTrackSubscribed(
      track: Track,
      publication: { source?: Track.Source },
      participant?: { identity: string }
    ) {
      if (track instanceof RemoteAudioTrack) {
        if (deafened) {
          track.setVolume(0);
          return;
        }
        if (publication?.source === Track.Source.ScreenShareAudio) {
          track.setVolume(participant ? getScreenShareAudioVolume(participant.identity) : 1);
        } else {
          track.setVolume(participant ? getMicVolume(participant.identity) : 1);
        }
      }
    }

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, deafened, participantVolumes, screenShareVolumes, screenShareMuted]);

  // Remove stale per-user volume entries when participants leave.
  useEffect(() => {
    const activeIds = new Set(remoteParticipants.map((p) => p.identity));
    function pruneRecord<T>(prev: Record<string, T>): Record<string, T> {
      const next: Record<string, T> = {};
      let changed = false;
      for (const [id, val] of Object.entries(prev)) {
        if (activeIds.has(id)) { next[id] = val; } else { changed = true; }
      }
      return changed ? next : prev;
    }
    setParticipantVolumes(pruneRecord);
    setScreenShareVolumes(pruneRecord);
    setScreenShareMuted(pruneRecord);
  }, [remoteParticipants]);

  // Apply preferred audio devices when joining room
  useEffect(() => {
    let cancelled = false;
    async function applyPreferredDevices() {
      try {
        if (!usesNativeMicrophone && preferredAudioInputId) {
          await room.switchActiveDevice("audioinput", preferredAudioInputId);
          if (!cancelled) setAudioInputDeviceId(preferredAudioInputId);
        }
      } catch {
        // Keep default device if preferred is unavailable
      }
      try {
        if (preferredAudioOutputId) {
          await room.switchActiveDevice("audiooutput", preferredAudioOutputId);
          if (!cancelled) setAudioOutputDeviceId(preferredAudioOutputId);
        }
      } catch {
        // Keep default output if preferred is unavailable
      }
    }
    applyPreferredDevices();
    return () => {
      cancelled = true;
    };
  }, [room, preferredAudioInputId, preferredAudioOutputId, usesNativeMicrophone]);

  // Push-to-talk / push-to-mute keyboard handler
  useEffect(() => {
    if (
      !room ||
      (!pushToTalkEnabled && !pushToMuteEnabled) ||
      room.state !== ConnectionState.Connected
    ) {
      return;
    }

    function isTypingTarget(target: EventTarget | null) {
      if (!target || !(target as HTMLElement).tagName) return false;
      const tag = (target as HTMLElement).tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || (target as HTMLElement).isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (deafened || manualMute) return;
      if (isTypingTarget(e.target)) return;
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        if (usesNativeMicrophone) {
          void setNativeMicrophoneMuted(pushToMuteEnabled);
          return;
        }
        if (pushToTalkEnabled) {
          room.localParticipant.setMicrophoneEnabled(true, micCaptureOptions).catch(() => {
            // Ignore publish race while reconnecting.
          });
        } else if (pushToMuteEnabled) {
          room.localParticipant.setMicrophoneEnabled(false).catch(() => {
            // Ignore publish race while reconnecting.
          });
        }
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        if (usesNativeMicrophone) {
          void setNativeMicrophoneMuted(pushToTalkEnabled || manualMute || deafened);
          return;
        }
        if (pushToTalkEnabled) {
          room.localParticipant.setMicrophoneEnabled(false).catch(() => {
            // Ignore publish race while reconnecting.
          });
        } else if (pushToMuteEnabled && !manualMute && !deafened) {
          room.localParticipant.setMicrophoneEnabled(true, micCaptureOptions).catch(() => {
            // Ignore publish race while reconnecting.
          });
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    room,
    pushToTalkEnabled,
    pushToMuteEnabled,
    pushToTalkKey,
    manualMute,
    deafened,
    micCaptureOptions,
    usesNativeMicrophone,
  ]);

  // Report participants upward + play join/leave sounds for remote participants
  const prevCountRef = useRef(0);
  const participantsRef = useRef(visibleParticipants);
  participantsRef.current = visibleParticipants;

  useEffect(() => {
    if (!onParticipantsChange) return;
    const dedupedById = new Map<string, VoiceParticipant>();
    for (const participant of visibleParticipants) {
      const id = participant.identity?.trim();
      if (!id) continue;
      const mappedParticipant: VoiceParticipant = {
        id,
        name: participant.name || id,
        isSpeaking: speakingStateByIdentity.get(id) ?? false,
      };
      dedupedById.set(id, mappedParticipant);
    }
    const mapped = Array.from(dedupedById.values());
    onParticipantsChange(roomId, mapped);

    const prevCount = prevCountRef.current;
    const newCount = remoteParticipants.length;
    if (newCount > prevCount) playJoin();
    else if (newCount < prevCount) playLeave();
    prevCountRef.current = newCount;
  }, [
    visibleParticipants,
    remoteParticipants.length,
    onParticipantsChange,
    roomId,
    speakingStateByIdentity,
  ]);

  // Fast speaking indicator: fire immediately on ActiveSpeakersChanged event
  // instead of waiting for useParticipants() to re-render.
  useEffect(() => {
    if (!onParticipantsChange) return;
    const _onParticipantsChange = onParticipantsChange;
    function onActiveSpeakersChanged(speakers: { identity: string }[]) {
      const speakingIds = new Set(
        speakers
          .map((speaker) => {
            if (isNativeScreenShareIdentity(speaker.identity)) return "";
            return getHostIdentityFromNativeVoiceIdentity(speaker.identity);
          })
          .filter(Boolean)
      );
      const dedupedById = new Map<string, VoiceParticipant>();
      for (const participant of participantsRef.current) {
        const id = participant.identity?.trim();
        if (!id) continue;
        dedupedById.set(id, {
          id,
          name: participant.name || id,
          isSpeaking: speakingIds.has(id) || speakingStateByIdentity.get(id) || false,
        });
      }
      _onParticipantsChange(roomId, Array.from(dedupedById.values()));
    }
    room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
    };
  }, [room, onParticipantsChange, roomId, speakingStateByIdentity]);

  // Sync screen share state when user stops sharing via browser UI
  useEffect(() => {
    if (!room) return;
    function onTrackUnpublished(publication: { source?: Track.Source }) {
      if (publication.source === Track.Source.ScreenShare && screenShareMode === "browser") {
        setIsScreenSharing(false);
        setScreenShareMode(null);
      }
    }
    room.localParticipant.on("localTrackUnpublished", onTrackUnpublished);
    return () => {
      room.localParticipant.off("localTrackUnpublished", onTrackUnpublished);
    };
  }, [room, screenShareMode]);

  const toggleMute = useCallback(() => {
    setManualMute((prev) => {
      if (prev) playUnmute();
      else playMute();
      return !prev;
    });
  }, []);

  const toggleVideo = useCallback(() => {
    if (room.state !== ConnectionState.Connected) return;
    if (!isCameraEnabled) {
      // Fixed camera quality profile for predictable behavior with lower
      // encode load when someone is also sharing their screen.
      const defaultRes = "720p";
      const defaultFps = 30;
      const dims = resolveResolution(defaultRes);
      // Map to a VideoPreset for appropriate encoding bitrate
      const presetMap: Record<string, typeof VideoPresets.h720> = {
        "360p": VideoPresets.h360,
        "480p": VideoPresets.h540,
        "720p": VideoPresets.h720,
        "1080p": VideoPresets.h1080,
        "1440p": VideoPresets.h1440,
      };
      const preset = presetMap[defaultRes] || VideoPresets.h720;
      room.localParticipant.setCameraEnabled(
        true,
        {
          resolution: { width: dims.width, height: dims.height, frameRate: defaultFps },
        },
        {
          videoCodec: "h264",
          backupCodec: false,
          videoEncoding: { maxBitrate: preset.encoding.maxBitrate, maxFramerate: defaultFps },
          simulcast: false,
        },
      );
    } else {
      room.localParticipant.setCameraEnabled(false);
    }
  }, [room, isCameraEnabled]);

  const applyVideoBackgroundEffect = useCallback(async () => {
    if (room.state !== ConnectionState.Connected) return;
    const cameraPublication = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const cameraTrack = cameraPublication?.track;
    if (!(cameraTrack instanceof LocalVideoTrack)) return;
    if (!supportsBackgroundProcessors()) return;

    if (!backgroundProcessorRef.current) {
      const processor = BackgroundProcessor({ mode: "disabled" });
      await cameraTrack.setProcessor(processor);
      backgroundProcessorRef.current = processor;
    }

    const processor = backgroundProcessorRef.current;
    if (!processor) return;
    if (videoBackgroundMode === "blur") {
      await processor.switchTo({ mode: "background-blur", blurRadius: 12 });
      return;
    }
    if (videoBackgroundMode === "image" && videoBackgroundImageUrl.trim()) {
      await processor.switchTo({
        mode: "virtual-background",
        imagePath: videoBackgroundImageUrl.trim(),
      });
      return;
    }
    await processor.switchTo({ mode: "disabled" });
  }, [room, videoBackgroundMode, videoBackgroundImageUrl]);

  useEffect(() => {
    if (!isCameraEnabled) return;
    void applyVideoBackgroundEffect().catch(() => {
      // Keep camera published even if background processing is not supported.
    });
  }, [isCameraEnabled, applyVideoBackgroundEffect]);

  useEffect(() => {
    return () => {
      backgroundProcessorRef.current = null;
      if (rnnoiseProcessorRef.current) {
        void rnnoiseProcessorRef.current.destroy();
      }
      rnnoiseProcessorRef.current = null;
      if (rnnoiseAudioContextRef.current) {
        void rnnoiseAudioContextRef.current.close();
      }
      rnnoiseAudioContextRef.current = null;
    };
  }, []);

  const toggleDeafen = useCallback(() => {
    setDeafened((prev) => {
      if (prev) playUndeafen();
      else playDeafen();
      return !prev;
    });
  }, []);

  const toggleNoiseSuppression = useCallback(() => {
    setNoiseSuppressionEnabled((prev) => {
      if (prev) return false;
      return noiseSuppressionMode !== "off";
    });
  }, [noiseSuppressionMode]);

  const listScreenShareSources = useCallback(async (): Promise<ScreenShareSource[]> => {
    if (!isProbablyTauri()) return [];
    return listNativeScreenShareSources();
  }, []);

  const startScreenShare = useCallback(async (
    resolution: string,
    fps: number,
    source?: ScreenShareSource
  ) => {
    if (room.state !== ConnectionState.Connected) {
      setIsScreenSharing(false);
      setScreenShareMode(null);
      return;
    }
    try {
      // Clamp to server limits
      const clampedRes = clampResolution(resolution, mediaLimits.maxScreenShareResolution);
      const clampedFps = clampFps(fps, mediaLimits.maxScreenShareFps);
      if (isProbablyTauri() && livekitUrl) {
        const nativeToken = await fetchLiveKitToken({
          room: roomId,
          userId: room.localParticipant.identity,
          username: room.localParticipant.name || room.localParticipant.identity,
          purpose: "native_screenshare",
          serverUrl,
          authToken,
        });
        await startNativeScreenShare({
          livekitUrl,
          token: nativeToken.token,
          source,
          resolution: clampedRes,
          fps: clampedFps,
        });
        setScreenShareMode("native");
        setIsScreenSharing(true);
        return;
      }

      const dims = resolveResolution(clampedRes);
      const motionHeavyShare = clampedFps >= 45;
      const screenShareBitrateByRes: Record<string, number> = motionHeavyShare
        ? {
            "360p": 1_800_000,
            "480p": 2_800_000,
            "720p": 5_500_000,
            "1080p": 10_000_000,
            "1440p": 16_000_000,
            "4k": 28_000_000,
          }
        : {
            "360p": 800_000,
            "480p": 1_400_000,
            "720p": 2_500_000,
            "1080p": 5_000_000,
            "1440p": 8_000_000,
            "4k": 14_000_000,
          };
      const useSimulcast = !motionHeavyShare;
      const maxBitrate = screenShareBitrateByRes[clampedRes] ?? (motionHeavyShare ? 5_500_000 : 2_500_000);
      const screenShareSimulcastLayers =
        !useSimulcast
          ? undefined
          : clampedRes === "4k"
            ? [VideoPresets.h360, VideoPresets.h1080]
            : clampedRes === "1440p" || clampedRes === "1080p"
              ? [VideoPresets.h360, VideoPresets.h720]
              : clampedRes === "720p"
                ? [VideoPresets.h180, VideoPresets.h360]
                : clampedRes === "480p"
                ? [VideoPresets.h180]
                  : undefined;
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          resolution: {
            width: dims.width,
            height: dims.height,
            frameRate: clampedFps,
          },
          contentHint: motionHeavyShare ? "motion" : "detail",
          // Let the browser decide which share-audio modes are supported for the
          // selected surface. Custom audio constraints here can cause display
          // capture to either drop the audio track or fail to start entirely.
          audio: true,
        },
        {
          audioPreset: AudioPresets.musicHighQualityStereo,
          dtx: false,
          forceStereo: true,
          videoCodec: "h264",
          backupCodec: false,
          degradationPreference: motionHeavyShare ? "maintain-framerate" : "maintain-resolution",
          simulcast: useSimulcast,
          videoEncoding: {
            maxBitrate,
            maxFramerate: clampedFps,
          },
          screenShareSimulcastLayers,
        },
      );
      setScreenShareMode("browser");
      setIsScreenSharing(true);
    } catch (err) {
      setIsScreenSharing(false);
      setScreenShareMode(null);
      if (screenShareMode === "native") {
        void stopNativeScreenShare().catch(() => {});
      }
      if (err instanceof Error) {
        throw err;
      }
    }
  }, [room, roomId, mediaLimits, livekitUrl, screenShareMode, serverUrl, authToken]);

  const stopScreenShare = useCallback(async () => {
    try {
      if (screenShareMode === "native") {
        await stopNativeScreenShare();
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
      }
      setIsScreenSharing(false);
      setScreenShareMode(null);
    } catch {
      setIsScreenSharing(false);
      setScreenShareMode(null);
    }
  }, [room, screenShareMode]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      await stopScreenShare();
    } else {
      const recommended = getRecommendedScreenShareQuality(
        mediaLimits.maxScreenShareResolution,
        mediaLimits.maxScreenShareFps
      );
      await startScreenShare(recommended.resolution, recommended.fps);
    }
  }, [isScreenSharing, stopScreenShare, startScreenShare, mediaLimits]);

  useEffect(() => {
    return () => {
      if (screenShareMode === "native") {
        void stopNativeScreenShare().catch(() => {});
      }
    };
  }, [screenShareMode]);

  const setAudioInputDevice = useCallback(
    async (deviceId: string) => {
      const prevDeviceId = audioInputDeviceId;
      setAudioInputDeviceId(deviceId);
      if (usesNativeMicrophone) {
        try {
          await restartNativeMicrophone(deviceId);
        } catch (err) {
          setAudioInputDeviceId(prevDeviceId);
          throw err;
        }
        return;
      }
      if (deviceId) {
        try {
          await room.switchActiveDevice("audioinput", deviceId, true);
        } catch (err) {
          setAudioInputDeviceId(prevDeviceId);
          throw err;
        }
      } else {
        // Empty id means "system default"; non-exact constraints allow fallback.
        try {
          await room.switchActiveDevice("audioinput", "", false);
        } catch (err) {
          setAudioInputDeviceId(prevDeviceId);
          throw err;
        }
      }
    },
    [room, audioInputDeviceId, usesNativeMicrophone, restartNativeMicrophone]
  );

  const setAudioOutputDevice = useCallback(
    async (deviceId: string) => {
      const prevDeviceId = audioOutputDeviceId;
      setAudioOutputDeviceId(deviceId);
      if (deviceId) {
        try {
          await room.switchActiveDevice("audiooutput", deviceId, true);
        } catch (err) {
          setAudioOutputDeviceId(prevDeviceId);
          throw err;
        }
      } else {
        // Empty id means "system default"; non-exact constraints allow fallback.
        try {
          await room.switchActiveDevice("audiooutput", "", false);
        } catch (err) {
          setAudioOutputDeviceId(prevDeviceId);
          throw err;
        }
      }
    },
    [room, audioOutputDeviceId]
  );

  const handleLeave = useCallback(() => {
    playLeave();
    if (usesNativeMicrophone) {
      void stopNativeMicrophone().catch(() => {});
    }
    if (screenShareMode === "native") {
      void stopNativeScreenShare().catch(() => {});
    }
    room.disconnect();
    onLeave();
  }, [room, onLeave, screenShareMode, usesNativeMicrophone]);

  // Report voice controls upward for the Sidebar
  useEffect(() => {
    if (!onVoiceControlsChange) return;
    onVoiceControlsChange(roomId, {
      isConnected,
      isMuted: manualMute,
      isDeafened: deafened,
      isCameraOn: isCameraEnabled ?? false,
      isScreenSharing,
      isNoiseSuppressionEnabled: noiseSuppressionEnabled,
      usesNativeAudioInput: usesNativeMicrophone,
      toggleMute,
      toggleDeafen,
      toggleVideo,
      toggleScreenShare,
      toggleNoiseSuppression,
      startScreenShare,
      stopScreenShare,
      listScreenShareSources,
      listAudioInputDevices: usesNativeMicrophone ? listNativeAudioInputDevices : undefined,
      setAudioInputDevice,
      setAudioOutputDevice,
      audioInputDeviceId,
      audioOutputDeviceId,
      disconnect: handleLeave,
      mediaLimits: {
        maxScreenShareResolution: mediaLimits.maxScreenShareResolution,
        maxScreenShareFps: mediaLimits.maxScreenShareFps,
      },
      participantVolumes,
      setParticipantVolume: (participantId: string, volume: number) => {
        const clamped = Math.min(Math.max(volume, 0), 2);
        setParticipantVolumes((prev) => ({ ...prev, [participantId]: clamped }));
      },
    });
  }, [
    isConnected,
    manualMute,
    deafened,
    isCameraEnabled,
    isScreenSharing,
    noiseSuppressionEnabled,
    toggleMute,
    toggleDeafen,
    toggleVideo,
    toggleScreenShare,
    toggleNoiseSuppression,
    startScreenShare,
    stopScreenShare,
    listScreenShareSources,
    usesNativeMicrophone,
    setAudioInputDevice,
    setAudioOutputDevice,
    audioInputDeviceId,
    audioOutputDeviceId,
    handleLeave,
    onVoiceControlsChange,
    mediaLimits,
    participantVolumes,
    roomId,
  ]);

  // Filter screen share tracks (only actual track references, not placeholders)
  const screenShareTracks = tracks
    .filter((t) => t.source === Track.Source.ScreenShare)
    .filter(isTrackReference);

  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  // Build unified tile list: participant cameras + screen shares
  type TileItem =
    | {
        kind: "participant";
        participant: (typeof visibleParticipants)[number];
        key: string;
        isSpeaking: boolean;
      }
    | {
        kind: "screen";
        trackRef: (typeof screenShareTracks)[number];
        participant: (typeof visibleParticipants)[number];
        hostUserId: string;
        key: string;
      };

  const tiles: TileItem[] = [];
  visibleParticipants.forEach((p) => {
    tiles.push({
      kind: "participant",
      participant: p,
      key: `cam-${p.identity}`,
      isSpeaking: speakingStateByIdentity.get(p.identity) ?? false,
    });
  });
  screenShareTracks.forEach((t) => {
    const hostUserId = getHostIdentityFromScreenShareIdentity(t.participant.identity);
    const p = visibleParticipants.find((pp) => pp.identity === hostUserId);
    if (p) {
      tiles.push({
        kind: "screen",
        trackRef: t,
        participant: p,
        hostUserId,
        key: `screen-${hostUserId}`,
      });
    }
  });

  // Clear focus if the focused tile no longer exists
  useEffect(() => {
    if (focusedKey && !tiles.some((t) => t.key === focusedKey)) {
      setFocusedKey(null);
    }
  }, [tiles.length, focusedKey]);

  function handleTileClick(key: string) {
    setFocusedKey((prev) => (prev === key ? null : key));
  }

  const focusedTile = focusedKey ? tiles.find((t) => t.key === focusedKey) : null;
  const otherTiles = focusedKey ? tiles.filter((t) => t.key !== focusedKey) : [];

  // Grid columns for equal-size mode
  const tileCount = tiles.length;
  const columns = tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : tileCount <= 9 ? 3 : 4;
  const isController =
    Boolean(remoteControlSession) &&
    remoteControlSession!.controllerUserId === currentUserId;

  useEffect(() => {
    if (!isController || !onSendRemoteControlInput) return;
    const sendInput = onSendRemoteControlInput;
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      sendInput({ type: "key_down", key: event.key });
    }
    function onKeyUp(event: KeyboardEvent) {
      sendInput({ type: "key_up", key: event.key });
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [isController, onSendRemoteControlInput]);

  return (
    <div className="voice-room">
      <RoomAudioRenderer />
      {remoteControlSession && (
        <div className="voice-ptt" style={{ marginBottom: 8 }}>
          Remote control active (
          {remoteControlSession.hostUserId === currentUserId ? "you are sharing control" : "you have control access"})
          <button
            type="button"
            className="voice-btn danger"
            style={{ marginLeft: 10, padding: "4px 8px", fontSize: 12 }}
            onClick={() => onRevokeScreenControl?.(remoteControlSession.sessionId)}
          >
            Kill Switch
          </button>
        </div>
      )}

      {focusedTile ? (
        /* Focused layout: one big tile + strip at bottom */
        <>
          <div className="voice-focused-main" onClick={() => handleTileClick(focusedTile.key)}>
            <TileContent
              tile={focusedTile}
              currentUserId={currentUserId}
              remoteControlSession={remoteControlSession}
              remoteControlPendingHostId={remoteControlPendingHostId}
              roomId={roomId}
              onRequestScreenControl={onRequestScreenControl}
              onRevokeScreenControl={onRevokeScreenControl}
              onSendRemoteControlInput={onSendRemoteControlInput}
              screenShareVolumes={screenShareVolumes}
              screenShareMuted={screenShareMuted}
              onScreenShareVolumeChange={(id, vol) => setScreenShareVolumes((prev) => ({ ...prev, [id]: vol }))}
              onScreenShareMuteToggle={(id) => setScreenShareMuted((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))}
            />
          </div>
          {otherTiles.length > 0 && (
            <div className="voice-focused-strip">
              {otherTiles.map((tile) => (
                <div
                  key={tile.key}
                  className="voice-focused-strip-item"
                  onClick={() => handleTileClick(tile.key)}
                >
                  <TileContent
                    tile={tile}
                    currentUserId={currentUserId}
                    remoteControlSession={remoteControlSession}
                    remoteControlPendingHostId={remoteControlPendingHostId}
                    roomId={roomId}
                    onRequestScreenControl={onRequestScreenControl}
                    onRevokeScreenControl={onRevokeScreenControl}
                    onSendRemoteControlInput={onSendRemoteControlInput}
                    screenShareVolumes={screenShareVolumes}
                    screenShareMuted={screenShareMuted}
                    onScreenShareVolumeChange={(id, vol) => setScreenShareVolumes((prev) => ({ ...prev, [id]: vol }))}
                    onScreenShareMuteToggle={(id) => setScreenShareMuted((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        /* Equal grid layout */
        <div
          className="voice-tile-grid"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {tiles.map((tile) => (
            <div
              key={tile.key}
              className={`voice-tile-wrapper ${tileCount === 1 ? "no-enter" : ""}`}
              onClick={() => handleTileClick(tile.key)}
            >
              <TileContent
                tile={tile}
                currentUserId={currentUserId}
                remoteControlSession={remoteControlSession}
                remoteControlPendingHostId={remoteControlPendingHostId}
                roomId={roomId}
                onRequestScreenControl={onRequestScreenControl}
                onRevokeScreenControl={onRevokeScreenControl}
                onSendRemoteControlInput={onSendRemoteControlInput}
                screenShareVolumes={screenShareVolumes}
                screenShareMuted={screenShareMuted}
                onScreenShareVolumeChange={(id, vol) => setScreenShareVolumes((prev) => ({ ...prev, [id]: vol }))}
                onScreenShareMuteToggle={(id) => setScreenShareMuted((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))}
              />
            </div>
          ))}
        </div>
      )}


      {pushToTalkEnabled && (
        <div className="voice-ptt">Hold {formattedKey} to talk</div>
      )}
      {pushToMuteEnabled && !pushToTalkEnabled && (
        <div className="voice-ptt">Hold {formattedKey} to mute</div>
      )}
    </div>
  );
}

/** Renders the inside of a tile — either a participant camera or a screen share */
function TileContent({
  tile,
  currentUserId,
  remoteControlSession,
  remoteControlPendingHostId,
  roomId,
  onRequestScreenControl,
  onRevokeScreenControl,
  onSendRemoteControlInput,
  screenShareVolumes,
  screenShareMuted,
  onScreenShareVolumeChange,
  onScreenShareMuteToggle,
}: {
  tile:
    | {
        kind: "participant";
        participant: ReturnType<typeof useParticipants>[number];
        key: string;
        isSpeaking: boolean;
      }
    | {
        kind: "screen";
        trackRef: any;
        participant: ReturnType<typeof useParticipants>[number];
        hostUserId: string;
        key: string;
      };
  currentUserId?: string | null;
  remoteControlSession?: {
    sessionId: string;
    roomId: string;
    controllerUserId: string;
    hostUserId: string;
    expiresAt: string;
  } | null;
  remoteControlPendingHostId?: string | null;
  roomId: string;
  onRequestScreenControl?: (hostUserId: string, roomId: string) => void;
  onRevokeScreenControl?: (sessionId: string) => void;
  onSendRemoteControlInput?: (event: {
    type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
    xNorm?: number;
    yNorm?: number;
    button?: "left" | "right" | "middle";
    deltaY?: number;
    key?: string;
  }) => void;
  screenShareVolumes?: Record<string, number>;
  screenShareMuted?: Record<string, boolean>;
  onScreenShareVolumeChange?: (participantId: string, vol: number) => void;
  onScreenShareMuteToggle?: (participantId: string) => void;
}) {
  if (tile.kind === "screen") {
    const name = tile.participant.name || tile.participant.identity;
    const hostUserId = tile.hostUserId;
    const isHost = currentUserId === hostUserId;
    const hasActiveSessionForHost =
      remoteControlSession &&
      remoteControlSession.hostUserId === hostUserId;
    const isControllerForHost =
      hasActiveSessionForHost &&
      remoteControlSession!.controllerUserId === currentUserId;
    const pending = remoteControlPendingHostId === hostUserId;
    const canSendInput = Boolean(isControllerForHost && onSendRemoteControlInput);
    const ssVolume = screenShareVolumes?.[hostUserId] ?? 1;
    const ssMuted = screenShareMuted?.[hostUserId] ?? false;
    return (
      <div className="voice-tile screen">
        <VideoTrack trackRef={tile.trackRef} className="voice-tile-video" />
        <div className="voice-tile-name">{name}'s screen</div>
        {canSendInput && (
          <div
            style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
            onMouseMove={(e) => {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const xNorm = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
              const yNorm = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
              onSendRemoteControlInput?.({
                type: "pointer_move",
                xNorm: Math.min(1, Math.max(0, xNorm)),
                yNorm: Math.min(1, Math.max(0, yNorm)),
              });
            }}
            onMouseDown={(e) => {
              const button =
                e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
              onSendRemoteControlInput?.({ type: "pointer_down", button });
            }}
            onMouseUp={(e) => {
              const button =
                e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
              onSendRemoteControlInput?.({ type: "pointer_up", button });
            }}
            onWheel={(e) => {
              onSendRemoteControlInput?.({ type: "wheel", deltaY: e.deltaY });
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
        {!isHost && (
          <>
            <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 6 }}>
              {isControllerForHost ? (
                <button
                  type="button"
                  className="voice-btn danger"
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRevokeScreenControl?.(remoteControlSession!.sessionId);
                  }}
                >
                  Stop Control
                </button>
              ) : (
                <button
                  type="button"
                  className="voice-btn primary"
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  disabled={pending || Boolean(hasActiveSessionForHost)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestScreenControl?.(hostUserId, roomId);
                  }}
                >
                  {pending ? "Requesting..." : "Request Control"}
                </button>
              )}
            </div>
            <div
              style={{
                position: "absolute",
                bottom: 28,
                right: 8,
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "rgba(0,0,0,0.55)",
                borderRadius: 6,
                padding: "3px 7px",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                style={{ background: "none", border: "none", cursor: "pointer", color: "white", display: "flex", alignItems: "center", padding: 0 }}
                onClick={() => onScreenShareMuteToggle?.(hostUserId)}
                title={ssMuted ? "Unmute stream" : "Mute stream"}
              >
                {ssMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                className="voice-ctx-volume-slider"
                style={{ width: 60 }}
                value={ssMuted ? 0 : Math.round(ssVolume * 100)}
                onChange={(e) => {
                  const val = Number(e.target.value) / 100;
                  if (val > 0 && ssMuted) onScreenShareMuteToggle?.(hostUserId);
                  onScreenShareVolumeChange?.(hostUserId, val);
                }}
              />
            </div>
          </>
        )}
      </div>
    );
  }
  return <ParticipantTileCard participant={tile.participant} isSpeakingOverride={tile.isSpeaking} />;
}

function ParticipantTileCard({
  participant,
  isSpeakingOverride = false,
}: {
  participant: ReturnType<typeof useParticipants>[number];
  isSpeakingOverride?: boolean;
}) {
  const isSpeaking = useIsSpeaking(participant) || isSpeakingOverride;
  const fastSpeaking = (participant.audioLevel ?? 0) > 0.02 || isSpeakingOverride;
  const name = participant.name || participant.identity;
  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const isCameraOn = cameraPub?.isSubscribed && !cameraPub.isMuted;

  return (
    <div className={`voice-tile ${isSpeaking || fastSpeaking ? "speaking" : ""}`}>
      {isCameraOn && cameraPub?.videoTrack ? (
        <VideoTrack
          trackRef={{
            participant,
            publication: cameraPub,
            source: Track.Source.Camera,
          }}
          className="voice-tile-video"
        />
      ) : (
        <div className="voice-tile-avatar">
          <span className="voice-tile-initial">
            {name.charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <div className="voice-tile-name">{name}</div>
      {(isSpeaking || fastSpeaking) && <div className="voice-tile-speaking-ring" />}
    </div>
  );
}

const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxScreenShareResolution: "1080p",
  maxScreenShareFps: 30,
};

const LIVEKIT_RECONNECT_POLICY = new DefaultReconnectPolicy([
  0,
  300,
  1200,
  2700,
  4800,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
]);

export default function VoiceChannel({
  room,
  serverUrl,
  livekitUrl,
  authToken,
  authUser,
  authProfile,
  autoJoin = false,
  onParticipantsChange,
  onVoiceControlsChange,
  currentUserId,
  currentParticipants,
  remoteControlSession,
  remoteControlPendingHostId,
  onRequestScreenControl,
  onRevokeScreenControl,
  onSendRemoteControlInput,
}: VoiceChannelProps) {
  const [token, setToken] = useState<string | null>(null);
  const [mediaLimits, setMediaLimits] = useState<MediaLimits>(DEFAULT_MEDIA_LIMITS);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoJoinAttemptedRef = useRef(false);

  const usesNativeMicrophone = supportsNativeMicrophoneCapture();

  useEffect(() => {
    autoJoinAttemptedRef.current = false;
  }, [room.id]);

  useEffect(() => {
    return () => {
      onParticipantsChange?.(room.id, []);
      onVoiceControlsChange?.(room.id, null);
    };
  }, [onParticipantsChange, onVoiceControlsChange, room.id]);

  const handleJoin = useCallback(async () => {
    if (!authUser) return;
    if (!livekitUrl) {
      setError("LiveKit URL is not configured.");
      return;
    }

    try {
      setError(null);
      setConnecting(true);
      const result = await fetchLiveKitToken({
        room: room.id,
        userId: authUser.id,
        username: authProfile.username,
        serverUrl,
        authToken,
      });
      setToken(result.token);
      setMediaLimits(result.mediaLimits);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join channel");
    } finally {
      setConnecting(false);
    }
  }, [authUser, livekitUrl, room.id, authProfile.username, serverUrl, authToken]);

  const handleLeave = useCallback(() => {
    setToken(null);
    onParticipantsChange?.(room.id, []);
    onVoiceControlsChange?.(room.id, null);
  }, [onParticipantsChange, onVoiceControlsChange, room.id]);

  useEffect(() => {
    if (!autoJoin || token || connecting || autoJoinAttemptedRef.current) return;
    autoJoinAttemptedRef.current = true;
    void handleJoin();
  }, [autoJoin, token, connecting, handleJoin]);

  return (
    <div className="flex flex-col h-full">
      <div className="room-header">
        <span className="room-header-icon" aria-hidden="true">
          <Volume2 size={16} />
        </span>
        <h2 className="room-header-title heading-font">{room.name}</h2>
      </div>

      <div className="flex-1 flex flex-col bg-[var(--bg-primary)]/20 px-10 py-8">
        {!token ? (
          <div className="voice-join">
            <div className="voice-join-card">
              <div className="voice-join-title">Join channel</div>
              {currentParticipants && currentParticipants.length > 0 ? (
                <div className="voice-join-participants">
                  <div className="voice-join-participants-label">
                    {currentParticipants.length === 1
                      ? "1 person in this channel"
                      : `${currentParticipants.length} people in this channel`}
                  </div>
                  <div className="voice-join-participants-list">
                    {currentParticipants.map((p) => (
                      <div key={p.id} className={`voice-join-participant${p.isSpeaking ? " speaking" : ""}`}>
                        <span className="voice-join-dot" />
                        <span className="voice-join-participant-name">{p.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="voice-join-subtitle">No one is here yet.</p>
              )}
              {error && <div className="voice-error">{error}</div>}
              <button
                onClick={handleJoin}
                className="voice-btn primary"
                disabled={connecting}
              >
                {connecting ? "Connecting..." : "Join"}
              </button>
            </div>
          </div>
        ) : (
          <LiveKitRoom
            token={token}
            serverUrl={livekitUrl}
            connect
            onDisconnected={handleLeave}
            data-lk-theme="default"
            audio={!usesNativeMicrophone}
            video={false}
            options={{
              adaptiveStream: true,
              dynacast: true,
              reconnectPolicy: LIVEKIT_RECONNECT_POLICY,
            }}
            connectOptions={{
              maxRetries: 3,
              peerConnectionTimeout: 20_000,
              websocketTimeout: 20_000,
            }}
          >
            <VoiceRoomContent
              onLeave={handleLeave}
              pushToTalkEnabled={authProfile.pushToTalkEnabled}
              pushToMuteEnabled={authProfile.pushToMuteEnabled}
              pushToTalkKey={authProfile.pushToTalkKey}
              audioInputSensitivity={authProfile.audioInputSensitivity}
              noiseSuppressionMode={authProfile.noiseSuppressionMode}
              videoBackgroundMode={authProfile.videoBackgroundMode}
              videoBackgroundImageUrl={authProfile.videoBackgroundImageUrl}
              preferredAudioInputId={authProfile.audioInputId}
              preferredAudioOutputId={authProfile.audioOutputId}
              roomId={room.id}
              serverUrl={serverUrl}
              authToken={authToken}
              livekitUrl={livekitUrl}
              mediaLimits={mediaLimits}
              onParticipantsChange={onParticipantsChange}
              onVoiceControlsChange={onVoiceControlsChange}
              currentUserId={currentUserId}
              remoteControlSession={remoteControlSession}
              remoteControlPendingHostId={remoteControlPendingHostId}
              onRequestScreenControl={onRequestScreenControl}
              onRevokeScreenControl={onRevokeScreenControl}
              onSendRemoteControlInput={onSendRemoteControlInput}
            />
          </LiveKitRoom>
        )}
      </div>
    </div>
  );
}
