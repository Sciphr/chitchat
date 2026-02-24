import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import type { Room, VoiceControls } from "../../types";
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
  LocalAudioTrack,
  RemoteAudioTrack,
  LocalVideoTrack,
  VideoPresets,
  DefaultReconnectPolicy,
} from "livekit-client";
import { BackgroundProcessor, supportsBackgroundProcessors } from "@livekit/track-processors";
import { LiveKitRnnoiseProcessor, supportsRnnoiseProcessing } from "../../lib/rnnoiseProcessor";
import { Volume2 } from "lucide-react";
import { useAuth } from "../../hooks/useAuth";
import { fetchLiveKitToken, getLiveKitUrl, resolveResolution, clampResolution, clampFps } from "../../lib/livekit";
import type { MediaLimits } from "../../lib/livekit";
import { playJoin, playLeave, playMute, playUnmute, playDeafen, playUndeafen } from "../../lib/sounds";

interface VoiceChannelProps {
  room: Room;
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
  const { isCameraEnabled } = useLocalParticipant();
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
  const backgroundProcessorRef = useRef<ReturnType<typeof BackgroundProcessor> | null>(null);
  const rnnoiseProcessorRef = useRef<LiveKitRnnoiseProcessor | null>(null);
  const rnnoiseAudioContextRef = useRef<AudioContext | null>(null);

  const localIdentity = room.localParticipant.identity;
  const remoteParticipants = useMemo(
    () => participants.filter((participant) => participant.identity !== localIdentity),
    [participants, localIdentity]
  );

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
      echoCancellation: activeNoiseSuppressionMode !== "rnnoise",
      autoGainControl:
        activeNoiseSuppressionMode === "aggressive" ||
        activeNoiseSuppressionMode === "rnnoise",
      channelCount: activeNoiseSuppressionMode === "aggressive" ? 1 : undefined,
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

  // Mic enable/disable based on mute/deafen/PTT/noise suppression
  useEffect(() => {
    if (!room) return;
    if (room.state !== ConnectionState.Connected) return;

    async function applyMicState() {
      if (pushToTalkEnabled || manualMute || deafened) {
        await room.localParticipant.setMicrophoneEnabled(false);
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(true, micCaptureOptions);
    }

    void applyMicState().catch(() => {
      // Connection can drop while applying; ignore transient publish errors.
    });
  }, [room, pushToTalkEnabled, manualMute, deafened, micCaptureOptions]);

  // Optional RNNoise processing on the published microphone track.
  useEffect(() => {
    if (!room || room.state !== ConnectionState.Connected) return;

    async function applyAudioProcessor() {
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

    void applyAudioProcessor();
  }, [room, activeNoiseSuppressionMode]);

  // Open-mic input sensitivity gate: auto-mute the mic when below the threshold.
  useEffect(() => {
    if (!room) return;
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
    pushToTalkEnabled,
    pushToMuteEnabled,
    manualMute,
    deafened,
    audioInputSensitivity,
    preferredAudioInputId,
    micCaptureOptions,
  ]);

  // Apply per-user volume (and deafen override) to all remote audio tracks.
  useEffect(() => {
    if (!room) return;

    function getEffectiveVolume(participantId: string) {
      if (deafened) return 0;
      return participantVolumes[participantId] ?? 1;
    }

    function applyVolumes() {
      room.remoteParticipants.forEach((participant) => {
        const effectiveVolume = getEffectiveVolume(participant.identity);
        participant.getTrackPublications().forEach((pub) => {
          if (pub.track instanceof RemoteAudioTrack) {
            pub.track.setVolume(effectiveVolume);
          }
        });
      });
    }

    applyVolumes();

    function onTrackSubscribed(
      track: Track,
      _publication: unknown,
      participant?: { identity: string }
    ) {
      if (track instanceof RemoteAudioTrack) {
        const effectiveVolume = participant
          ? getEffectiveVolume(participant.identity)
          : deafened
            ? 0
            : 1;
        track.setVolume(effectiveVolume);
      }
    }

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, deafened, participantVolumes]);

  // Remove stale per-user volume entries when participants leave.
  useEffect(() => {
    const activeIds = new Set(remoteParticipants.map((p) => p.identity));
    setParticipantVolumes((prev) => {
      const next: Record<string, number> = {};
      let changed = false;
      for (const [participantId, volume] of Object.entries(prev)) {
        if (activeIds.has(participantId)) {
          next[participantId] = volume;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [remoteParticipants]);

  // Apply preferred audio devices when joining room
  useEffect(() => {
    let cancelled = false;
    async function applyPreferredDevices() {
      try {
        if (preferredAudioInputId) {
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
  }, [room, preferredAudioInputId, preferredAudioOutputId]);

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
  ]);

  // Report participants upward + play join/leave sounds for remote participants
  const prevCountRef = useRef(0);
  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  useEffect(() => {
    if (!onParticipantsChange) return;
    const dedupedById = new Map<string, VoiceParticipant>();
    for (const participant of participants) {
      const id = participant.identity?.trim();
      if (!id) continue;
      const mappedParticipant: VoiceParticipant = {
        id,
        name: participant.name || id,
        isSpeaking:
          (participant.audioLevel ?? 0) > 0.02 ||
          (participant.isSpeaking ?? false),
      };
      dedupedById.set(id, mappedParticipant);
    }
    const mapped = Array.from(dedupedById.values());
    onParticipantsChange(roomId, mapped);

    const prevCount = prevCountRef.current;
    const newCount = participants.length;
    if (newCount > prevCount) playJoin();
    else if (newCount < prevCount) playLeave();
    prevCountRef.current = newCount;
  }, [participants, onParticipantsChange, roomId]);

  // Fast speaking indicator: fire immediately on ActiveSpeakersChanged event
  // instead of waiting for useParticipants() to re-render.
  useEffect(() => {
    if (!onParticipantsChange) return;
    const _onParticipantsChange = onParticipantsChange;
    function onActiveSpeakersChanged(speakers: { identity: string }[]) {
      const speakingIds = new Set(speakers.map((s) => s.identity));
      const dedupedById = new Map<string, VoiceParticipant>();
      for (const participant of participantsRef.current) {
        const id = participant.identity?.trim();
        if (!id) continue;
        dedupedById.set(id, {
          id,
          name: participant.name || id,
          isSpeaking: speakingIds.has(id) || (participant.audioLevel ?? 0) > 0.02,
        });
      }
      _onParticipantsChange(roomId, Array.from(dedupedById.values()));
    }
    room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged);
    };
  }, [room, onParticipantsChange, roomId]);

  // Sync screen share state when user stops sharing via browser UI
  useEffect(() => {
    if (!room) return;
    function onTrackUnpublished(publication: { source?: Track.Source }) {
      if (publication.source === Track.Source.ScreenShare) {
        setIsScreenSharing(false);
      }
    }
    room.localParticipant.on("localTrackUnpublished", onTrackUnpublished);
    return () => {
      room.localParticipant.off("localTrackUnpublished", onTrackUnpublished);
    };
  }, [room]);

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
      // Fixed camera quality profile for predictable behavior.
      const defaultRes = "720p";
      const defaultFps = 60;
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

  const startScreenShare = useCallback(async (resolution: string, fps: number) => {
    if (room.state !== ConnectionState.Connected) {
      setIsScreenSharing(false);
      return;
    }
    try {
      // Clamp to server limits
      const clampedRes = clampResolution(resolution, mediaLimits.maxScreenShareResolution);
      const clampedFps = clampFps(fps, mediaLimits.maxScreenShareFps);
      const dims = resolveResolution(clampedRes);
      await room.localParticipant.setScreenShareEnabled(true, {
        resolution: {
          width: dims.width,
          height: dims.height,
          frameRate: clampedFps,
        },
      });
      setIsScreenSharing(true);
    } catch {
      // User cancelled the screen picker dialog
      setIsScreenSharing(false);
    }
  }, [room, mediaLimits]);

  const stopScreenShare = useCallback(async () => {
    try {
      await room.localParticipant.setScreenShareEnabled(false);
      setIsScreenSharing(false);
    } catch {
      setIsScreenSharing(false);
    }
  }, [room]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      await stopScreenShare();
    } else {
      // Default: use server max limits (backward compat for sidebar button)
      await startScreenShare(mediaLimits.maxScreenShareResolution, mediaLimits.maxScreenShareFps);
    }
  }, [isScreenSharing, stopScreenShare, startScreenShare, mediaLimits]);

  const setAudioInputDevice = useCallback(
    async (deviceId: string) => {
      const prevDeviceId = audioInputDeviceId;
      setAudioInputDeviceId(deviceId);
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
    [room, audioInputDeviceId]
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
    room.disconnect();
    onLeave();
  }, [room, onLeave]);

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
      toggleMute,
      toggleDeafen,
      toggleVideo,
      toggleScreenShare,
      toggleNoiseSuppression,
      startScreenShare,
      stopScreenShare,
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
        setParticipantVolumes((prev) => ({ ...prev, [participantId]: volume }));
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
    | { kind: "participant"; participant: (typeof participants)[number]; key: string }
    | { kind: "screen"; trackRef: (typeof screenShareTracks)[number]; participant: (typeof participants)[number]; key: string };

  const tiles: TileItem[] = [];
  participants.forEach((p) => {
    tiles.push({ kind: "participant", participant: p, key: `cam-${p.identity}` });
  });
  screenShareTracks.forEach((t) => {
    const p = participants.find((pp) => pp.identity === t.participant.identity);
    if (p) tiles.push({ kind: "screen", trackRef: t, participant: p, key: `screen-${t.participant.identity}` });
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
}: {
  tile:
    | { kind: "participant"; participant: ReturnType<typeof useParticipants>[number]; key: string }
    | { kind: "screen"; trackRef: any; participant: ReturnType<typeof useParticipants>[number]; key: string };
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
}) {
  if (tile.kind === "screen") {
    const name = tile.participant.name || tile.participant.identity;
    const hostUserId = tile.participant.identity;
    const isHost = currentUserId === hostUserId;
    const hasActiveSessionForHost =
      remoteControlSession &&
      remoteControlSession.hostUserId === hostUserId;
    const isControllerForHost =
      hasActiveSessionForHost &&
      remoteControlSession!.controllerUserId === currentUserId;
    const pending = remoteControlPendingHostId === hostUserId;
    const canSendInput = Boolean(isControllerForHost && onSendRemoteControlInput);
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
        )}
      </div>
    );
  }
  return <ParticipantTileCard participant={tile.participant} />;
}

function ParticipantTileCard({
  participant,
}: {
  participant: ReturnType<typeof useParticipants>[number];
}) {
  const isSpeaking = useIsSpeaking(participant);
  const fastSpeaking = (participant.audioLevel ?? 0) > 0.02;
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
  const { user, profile } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [mediaLimits, setMediaLimits] = useState<MediaLimits>(DEFAULT_MEDIA_LIMITS);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoJoinAttemptedRef = useRef(false);

  const livekitUrl = getLiveKitUrl();

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
    if (!user) return;
    if (!livekitUrl) {
      setError("LiveKit URL is not configured.");
      return;
    }

    try {
      setError(null);
      setConnecting(true);
      const result = await fetchLiveKitToken({
        room: room.id,
        userId: user.id,
        username: profile.username,
      });
      setToken(result.token);
      setMediaLimits(result.mediaLimits);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join channel");
    } finally {
      setConnecting(false);
    }
  }, [user, livekitUrl, room.id, profile.username]);

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
            audio
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
              pushToTalkEnabled={profile.pushToTalkEnabled}
              pushToMuteEnabled={profile.pushToMuteEnabled}
              pushToTalkKey={profile.pushToTalkKey}
              audioInputSensitivity={profile.audioInputSensitivity}
              noiseSuppressionMode={profile.noiseSuppressionMode}
              videoBackgroundMode={profile.videoBackgroundMode}
              videoBackgroundImageUrl={profile.videoBackgroundImageUrl}
              preferredAudioInputId={profile.audioInputId}
              preferredAudioOutputId={profile.audioOutputId}
              roomId={room.id}
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
