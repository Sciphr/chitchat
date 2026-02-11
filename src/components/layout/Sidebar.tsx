import { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Room, VoiceControls } from "../../types";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  MonitorUp,
  PhoneOff,
} from "lucide-react";

interface SidebarProps {
  rooms: Room[];
  activeRoom: Room | null;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (name: string, type: "text" | "voice") => void;
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  voiceParticipants: Record<
    string,
    Array<{ id: string; name: string; isSpeaking: boolean }>
  >;
  onOpenSettings: () => void;
  onSignOut: () => void;
  voiceControls: VoiceControls | null;
}

export default function Sidebar({
  rooms,
  activeRoom,
  onSelectRoom,
  onCreateRoom,
  username,
  status,
  avatarUrl,
  voiceParticipants,
  onOpenSettings,
  onSignOut,
  voiceControls,
}: SidebarProps) {
  const [newRoomName, setNewRoomName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<"text" | "voice">("text");

  const textRooms = rooms.filter((r) => r.type === "text");
  const voiceRooms = rooms.filter((r) => r.type === "voice");

  // Track departing voice participants so we can animate them out
  type VPart = { id: string; name: string; isSpeaking: boolean };
  const prevParticipantsRef = useRef<Record<string, VPart[]>>({});
  const [leavingParticipants, setLeavingParticipants] = useState<
    Record<string, VPart[]>
  >({});

  useEffect(() => {
    const prev = prevParticipantsRef.current;
    const newLeaving: Record<string, VPart[]> = {};

    for (const roomId of Object.keys(prev)) {
      const currIds = voiceParticipants[roomId]?.map((p) => p.id) ?? [];
      const departed = prev[roomId]?.filter((p) => !currIds.includes(p.id)) ?? [];
      if (departed.length > 0) {
        newLeaving[roomId] = departed;
      }
    }

    if (Object.keys(newLeaving).length > 0) {
      setLeavingParticipants((prev) => {
        const merged = { ...prev };
        for (const [roomId, parts] of Object.entries(newLeaving)) {
          merged[roomId] = [...(merged[roomId] ?? []), ...parts];
        }
        return merged;
      });

      // Remove them after the animation completes
      setTimeout(() => {
        setLeavingParticipants((prev) => {
          const cleaned = { ...prev };
          for (const roomId of Object.keys(newLeaving)) {
            const leavingIds = newLeaving[roomId].map((p) => p.id);
            cleaned[roomId] = (cleaned[roomId] ?? []).filter(
              (p) => !leavingIds.includes(p.id)
            );
            if (cleaned[roomId].length === 0) delete cleaned[roomId];
          }
          return cleaned;
        });
      }, 300);
    }

    prevParticipantsRef.current = { ...voiceParticipants };
  }, [voiceParticipants]);

  const statusMap: Record<string, { label: string; color: string }> = {
    online: { label: "Online", color: "var(--success)" },
    away: { label: "Away", color: "#f59e0b" },
    dnd: { label: "Do not disturb", color: "var(--danger)" },
    offline: { label: "Offline", color: "var(--text-muted)" },
  };

  const currentStatus = statusMap[status] || statusMap.online;

  function openCreateModal() {
    setCreateType("text");
    setShowCreate(true);
  }

  function closeCreateModal() {
    setShowCreate(false);
    setNewRoomName("");
  }

  function handleCreate() {
    if (newRoomName.trim()) {
      onCreateRoom(newRoomName.trim(), createType);
      closeCreateModal();
    }
  }

  return (
    <>
      <aside className="flex flex-col w-72 h-full sidebar-panel">
        {/* Server header */}
        <div className="sidebar-header">
          <div className="sidebar-header-row">
            <div className="sidebar-header-brand">
              <div className="sidebar-header-logo">
                <span className="heading-font">CC</span>
              </div>
              <div>
                <h1 className="sidebar-header-title heading-font">ChitChat</h1>
                <div className="sidebar-header-subtitle">
                  <span className="sidebar-header-dot" />
                  <p className="sidebar-header-label">Self-hosted</p>
                </div>
              </div>
            </div>
            <button
              onClick={openCreateModal}
              className="sidebar-create-btn"
              title="Create channel"
            >
              +
            </button>
          </div>
        </div>

      {/* Create channel modal */}
      {showCreate && (
        <div
          className="create-modal-backdrop"
          onClick={closeCreateModal}
        >
          <div
            className="create-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="create-modal-title">Create Channel</div>
            <p className="create-modal-subtitle">
              Give your new channel a name and choose its type.
            </p>
            <div className="create-toggle" role="group" aria-label="Channel type">
              <button
                type="button"
                className={`create-toggle-option ${
                  createType === "text" ? "active" : ""
                }`}
                onClick={() => setCreateType("text")}
              >
                Text
              </button>
              <button
                type="button"
                className={`create-toggle-option ${
                  createType === "voice" ? "active" : ""
                }`}
                onClick={() => setCreateType("voice")}
              >
                Voice
              </button>
            </div>
            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="channel-name"
              className="w-full px-3 py-3 mb-4 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg outline-none focus:border-[var(--accent)]"
            />
            <div className="create-modal-actions">
              <button
                type="button"
                onClick={closeCreateModal}
                className="profile-button secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                className="profile-button"
              >
                Create channel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Room lists */}
      <div className="sidebar-rooms">
        {/* Text channels */}
        <div className="sidebar-section-title heading-font">Text Channels</div>
        <AnimatePresence initial={false}>
        {textRooms.map((room) => (
          <motion.button
            key={room.id}
            layout
            initial={{ opacity: 0, x: -20, height: 0 }}
            animate={{ opacity: 1, x: 0, height: "auto" }}
            exit={{ opacity: 0, x: -20, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            onClick={() => onSelectRoom(room)}
            className={`sidebar-channel ${
              activeRoom?.id === room.id ? "active" : ""
            }`}
          >
            # {room.name}
          </motion.button>
        ))}
        </AnimatePresence>

        {/* Voice channels */}
        <div className="sidebar-section-title heading-font">Voice Channels</div>
        <AnimatePresence initial={false}>
        {voiceRooms.map((room) => (
          <motion.div
            key={room.id}
            layout
            initial={{ opacity: 0, x: -20, height: 0 }}
            animate={{ opacity: 1, x: 0, height: "auto" }}
            exit={{ opacity: 0, x: -20, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <button
              onClick={() => onSelectRoom(room)}
              className={`sidebar-channel ${
                activeRoom?.id === room.id ? "active" : ""
              }`}
            >
              [V] {room.name}
            </button>
            {(voiceParticipants[room.id]?.length || leavingParticipants[room.id]?.length) ? (
              <div className="sidebar-voice-participants">
                {voiceParticipants[room.id]?.map((participant) => (
                  <div
                    key={`${room.id}-${participant.id}`}
                    className={`sidebar-voice-participant ${
                      participant.isSpeaking ? "speaking" : ""
                    }`}
                  >
                    <span className="sidebar-voice-dot" />
                    <span className="sidebar-voice-name">
                      {participant.name}
                    </span>
                  </div>
                ))}
                {leavingParticipants[room.id]?.map((participant) => (
                  <div
                    key={`${room.id}-${participant.id}-leaving`}
                    className="sidebar-voice-participant leaving"
                  >
                    <span className="sidebar-voice-dot" />
                    <span className="sidebar-voice-name">
                      {participant.name}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </motion.div>
        ))}
        </AnimatePresence>
      </div>

      {/* Voice controls (when connected) */}
      {voiceControls && (
        <div className="sidebar-voice-controls">
          <div className="sidebar-voice-controls-label">Voice Connected</div>
          <div className="sidebar-voice-controls-buttons">
            <button
              onClick={voiceControls.toggleMute}
              className={`sidebar-vc-btn ${voiceControls.isMuted ? "active" : ""}`}
              title={voiceControls.isMuted ? "Unmute" : "Mute"}
            >
              {voiceControls.isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleDeafen}
              className={`sidebar-vc-btn ${voiceControls.isDeafened ? "active" : ""}`}
              title={voiceControls.isDeafened ? "Undeafen" : "Deafen"}
            >
              {voiceControls.isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleVideo}
              className={`sidebar-vc-btn ${voiceControls.isCameraOn ? "active" : ""}`}
              title={voiceControls.isCameraOn ? "Turn off camera" : "Turn on camera"}
            >
              {voiceControls.isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleScreenShare}
              className={`sidebar-vc-btn ${voiceControls.isScreenSharing ? "active" : ""}`}
              title={voiceControls.isScreenSharing ? "Stop sharing" : "Share screen"}
            >
              <MonitorUp size={18} />
            </button>
          </div>
          <button
            onClick={voiceControls.disconnect}
            className="sidebar-vc-btn danger"
            style={{ width: "100%" }}
            title="Disconnect"
          >
            <PhoneOff size={16} />
            <span>Disconnect</span>
          </button>
        </div>
      )}

      {/* User panel at bottom */}
      <div className="sidebar-user-panel">
        <div
          className="sidebar-user"
          style={{ display: "flex", alignItems: "center", gap: "12px", cursor: "pointer" }}
          role="button"
          tabIndex={0}
          onClick={onOpenSettings}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenSettings();
            }
          }}
          title="Edit profile"
        >
          <div className="sidebar-user-avatar">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={username}
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  e.currentTarget.parentElement!.textContent = username.charAt(0).toUpperCase();
                }}
              />
            ) : (
              username.charAt(0).toUpperCase()
            )}
          </div>
          <div className="sidebar-user-info">
            <div className="sidebar-user-name">{username}</div>
            <div className="sidebar-user-status">
              <span
                className="sidebar-user-status-dot"
                style={{ background: currentStatus.color }}
              />
              <span className="sidebar-user-status-label">
                {currentStatus.label}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onSignOut}
          className="sidebar-signout"
          title="Sign out"
        >
          Sign out
        </button>
      </div>
      </aside>
    </>
  );
}
