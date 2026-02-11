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
import { Track, RoomEvent, RemoteAudioTrack } from "livekit-client";
import { useAuth } from "../../hooks/useAuth";
import { fetchLiveKitToken, getLiveKitUrl } from "../../lib/livekit";
import { playJoin, playLeave, playMute, playUnmute, playDeafen, playUndeafen } from "../../lib/sounds";

interface VoiceChannelProps {
  room: Room;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
  onVoiceControlsChange?: (controls: VoiceControls | null) => void;
}

interface VoiceParticipant {
  id: string;
  name: string;
  isSpeaking: boolean;
}

function VoiceRoomContent({
  onLeave,
  pushToTalkEnabled,
  pushToTalkKey,
  roomId,
  onParticipantsChange,
  onVoiceControlsChange,
}: {
  onLeave: () => void;
  pushToTalkEnabled: boolean;
  pushToTalkKey: string;
  roomId: string;
  onParticipantsChange?: (roomId: string, participants: VoiceParticipant[]) => void;
  onVoiceControlsChange?: (controls: VoiceControls | null) => void;
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

  const formattedKey = useMemo(() => {
    if (!pushToTalkKey) return "Space";
    if (pushToTalkKey === "Space") return "Space";
    if (pushToTalkKey.startsWith("Key")) return pushToTalkKey.replace("Key", "");
    if (pushToTalkKey.startsWith("Digit")) return pushToTalkKey.replace("Digit", "");
    return pushToTalkKey;
  }, [pushToTalkKey]);

  // Mic enable/disable based on mute/deafen/PTT
  useEffect(() => {
    if (!room) return;

    if (pushToTalkEnabled) {
      room.localParticipant.setMicrophoneEnabled(false);
      if (manualMute || deafened) {
        room.localParticipant.setMicrophoneEnabled(false);
      }
      return;
    }

    room.localParticipant.setMicrophoneEnabled(!manualMute && !deafened);
  }, [room, pushToTalkEnabled, manualMute, deafened]);

  // Deafen volume control
  useEffect(() => {
    if (!room) return;

    function applyVolume(volume: number) {
      room.remoteParticipants.forEach((participant) => {
        participant.getTrackPublications().forEach((pub) => {
          if (pub.track instanceof RemoteAudioTrack) {
            pub.track.setVolume(volume);
          }
        });
      });
    }

    const volume = deafened ? 0 : 1;
    applyVolume(volume);

    function onTrackSubscribed(track: Track) {
      if (track instanceof RemoteAudioTrack) {
        track.setVolume(volume);
      }
    }

    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, deafened]);

  // Push-to-talk keyboard handler
  useEffect(() => {
    if (!room || !pushToTalkEnabled) return;

    function isTypingTarget(target: EventTarget | null) {
      if (!target || !(target as HTMLElement).tagName) return false;
      const tag = (target as HTMLElement).tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || (target as HTMLElement).isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (deafened || manualMute) return;
      if (isTypingTarget(e.target)) return;
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        room.localParticipant.setMicrophoneEnabled(true);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === pushToTalkKey || e.key === pushToTalkKey) {
        room.localParticipant.setMicrophoneEnabled(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [room, pushToTalkEnabled, pushToTalkKey, manualMute, deafened]);

  // Report participants upward + play join/leave sounds for remote participants
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (!onParticipantsChange) return;
    const mapped = participants.map((participant) => ({
      id: participant.identity,
      name: participant.name || participant.identity,
      isSpeaking: participant.isSpeaking ?? false,
    }));
    onParticipantsChange(roomId, mapped);

    const prevCount = prevCountRef.current;
    const newCount = participants.length;
    if (newCount > prevCount) playJoin();
    else if (newCount < prevCount) playLeave();
    prevCountRef.current = newCount;
  }, [participants, onParticipantsChange, roomId]);

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
    room.localParticipant.setCameraEnabled(!isCameraEnabled);
  }, [room, isCameraEnabled]);

  const toggleDeafen = useCallback(() => {
    setDeafened((prev) => {
      if (prev) playUndeafen();
      else playDeafen();
      return !prev;
    });
  }, []);

  const toggleScreenShare = useCallback(async () => {
    try {
      const newValue = !isScreenSharing;
      await room.localParticipant.setScreenShareEnabled(newValue);
      setIsScreenSharing(newValue);
    } catch {
      // User cancelled the screen picker dialog
      setIsScreenSharing(false);
    }
  }, [room, isScreenSharing]);

  const handleLeave = useCallback(() => {
    playLeave();
    room.disconnect();
    onLeave();
  }, [room, onLeave]);

  // Report voice controls upward for the Sidebar
  useEffect(() => {
    if (!onVoiceControlsChange) return;
    onVoiceControlsChange({
      isMuted: manualMute,
      isDeafened: deafened,
      isCameraOn: isCameraEnabled ?? false,
      isScreenSharing,
      toggleMute,
      toggleDeafen,
      toggleVideo,
      toggleScreenShare,
      disconnect: handleLeave,
    });
  }, [
    manualMute,
    deafened,
    isCameraEnabled,
    isScreenSharing,
    toggleMute,
    toggleDeafen,
    toggleVideo,
    toggleScreenShare,
    handleLeave,
    onVoiceControlsChange,
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

  return (
    <div className="voice-room">
      <RoomAudioRenderer />

      {focusedTile ? (
        /* Focused layout: one big tile + strip at bottom */
        <>
          <div className="voice-focused-main" onClick={() => handleTileClick(focusedTile.key)}>
            <TileContent tile={focusedTile} />
          </div>
          {otherTiles.length > 0 && (
            <div className="voice-focused-strip">
              {otherTiles.map((tile) => (
                <div
                  key={tile.key}
                  className="voice-focused-strip-item"
                  onClick={() => handleTileClick(tile.key)}
                >
                  <TileContent tile={tile} />
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
              className="voice-tile-wrapper"
              onClick={() => handleTileClick(tile.key)}
            >
              <TileContent tile={tile} />
            </div>
          ))}
        </div>
      )}

      {pushToTalkEnabled && (
        <div className="voice-ptt">Hold {formattedKey} to talk</div>
      )}
    </div>
  );
}

/** Renders the inside of a tile — either a participant camera or a screen share */
function TileContent({
  tile,
}: {
  tile:
    | { kind: "participant"; participant: ReturnType<typeof useParticipants>[number]; key: string }
    | { kind: "screen"; trackRef: any; participant: ReturnType<typeof useParticipants>[number]; key: string };
}) {
  if (tile.kind === "screen") {
    const name = tile.participant.name || tile.participant.identity;
    return (
      <div className="voice-tile screen">
        <VideoTrack trackRef={tile.trackRef} className="voice-tile-video" />
        <div className="voice-tile-name">{name}'s screen</div>
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
  const name = participant.name || participant.identity;
  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const isCameraOn = cameraPub?.isSubscribed && !cameraPub.isMuted;

  return (
    <div className={`voice-tile ${isSpeaking ? "speaking" : ""}`}>
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
      {isSpeaking && <div className="voice-tile-speaking-ring" />}
    </div>
  );
}

export default function VoiceChannel({ room, onParticipantsChange, onVoiceControlsChange }: VoiceChannelProps) {
  const { user, profile } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const livekitUrl = getLiveKitUrl();

  useEffect(() => {
    return () => {
      onParticipantsChange?.(room.id, []);
      onVoiceControlsChange?.(null);
    };
  }, [onParticipantsChange, onVoiceControlsChange, room.id]);

  async function handleJoin() {
    if (!user) return;
    if (!livekitUrl) {
      setError("LiveKit URL is not configured.");
      return;
    }

    try {
      setError(null);
      setConnecting(true);
      const nextToken = await fetchLiveKitToken({
        room: room.id,
        userId: user.id,
        username: profile.username,
      });
      setToken(nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join channel");
    } finally {
      setConnecting(false);
    }
  }

  function handleLeave() {
    setToken(null);
    onParticipantsChange?.(room.id, []);
    onVoiceControlsChange?.(null);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-10 py-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[var(--text-muted)] mr-2">[V]</span>
        <h2 className="text-base font-semibold heading-font">{room.name}</h2>
        <span className="ml-3 text-xs text-[var(--text-muted)]">Voice channel</span>
      </div>

      <div className="flex-1 flex flex-col bg-[var(--bg-primary)]/20 px-10 py-8">
        {!token ? (
          <div className="voice-join">
            <div className="voice-join-card">
              <div className="voice-join-title">Join channel</div>
              <p className="voice-join-subtitle">
                Connect to voice chat.
              </p>
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
          >
            <VoiceRoomContent
              onLeave={handleLeave}
              pushToTalkEnabled={profile.pushToTalkEnabled}
              pushToTalkKey={profile.pushToTalkKey}
              roomId={room.id}
              onParticipantsChange={onParticipantsChange}
              onVoiceControlsChange={onVoiceControlsChange}
            />
          </LiveKitRoom>
        )}
      </div>
    </div>
  );
}
