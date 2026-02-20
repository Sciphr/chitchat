export interface User {
  id: string;
  username: string;
  avatar_url?: string;
  status: "online" | "offline" | "away" | "dnd";
}

export interface ServerUser {
  id: string;
  username: string;
  avatar_url: string | null;
  role_color?: string | null;
  status: "online" | "offline" | "away" | "dnd";
  about: string | null;
  activity_game?: string | null;
}

export interface Room {
  id: string;
  name: string;
  type: "text" | "voice" | "dm";
  created_by: string;
  created_at: string;
  category_id?: string | null;
  position?: number;
  is_temporary?: number;
  owner_user_id?: string | null;
  // DM-specific fields (present when type === 'dm')
  other_user_id?: string;
  other_username?: string;
  other_avatar_url?: string | null;
  other_status?: string;
  // Group DM: array of all other members (populated for group DMs)
  other_members?: Array<{
    id: string;
    username: string;
    avatar_url: string | null;
    status: string;
  }>;
}

export interface RoomCategory {
  id: string;
  name: string;
  position: number;
  enforce_type_order: number;
  created_at: string;
}

export interface VoiceControls {
  isConnected: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isNoiseSuppressionEnabled: boolean;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  toggleNoiseSuppression: () => void;
  /** Start screen share with specific quality options */
  startScreenShare: (resolution: string, fps: number) => void;
  /** Stop screen share */
  stopScreenShare: () => void;
  /** Switch active microphone device (empty = default) */
  setAudioInputDevice: (deviceId: string) => Promise<void>;
  /** Switch active speaker device (empty = default) */
  setAudioOutputDevice: (deviceId: string) => Promise<void>;
  /** Currently selected microphone device id */
  audioInputDeviceId: string;
  /** Currently selected speaker device id */
  audioOutputDeviceId: string;
  disconnect: () => void;
  /** Server-imposed media limits */
  mediaLimits: {
    maxScreenShareResolution: string;
    maxScreenShareFps: number;
  };
  /** Per-participant local volume (0–1). Keyed by participant identity. */
  participantVolumes: Record<string, number>;
  /** Set local playback volume for a participant (0–1). */
  setParticipantVolume: (participantId: string, volume: number) => void;
}

export interface Message {
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  role_color?: string | null;
  reply_to_message_id?: string | null;
  reply_to_id?: string | null;
  reply_to_username?: string | null;
  reply_to_content?: string | null;
  pinned?: boolean | number;
  client_nonce?: string;
  pending?: boolean;
  failed?: boolean;
  error?: string;
  content: string;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
  created_at: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  user_ids: string[];
}

export interface MessageAttachment {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  url: string;
}
