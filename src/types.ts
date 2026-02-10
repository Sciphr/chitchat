export interface User {
  id: string;
  username: string;
  avatar_url?: string;
  status: "online" | "offline" | "away" | "dnd";
}

export interface Room {
  id: string;
  name: string;
  type: "text" | "voice";
  created_by: string;
  created_at: string;
}

export interface VoiceControls {
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  disconnect: () => void;
}

export interface Message {
  id: string;
  room_id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  client_nonce?: string;
  pending?: boolean;
  content: string;
  created_at: string;
}
