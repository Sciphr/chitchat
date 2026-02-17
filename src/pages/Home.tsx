import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { ChevronLeft } from "lucide-react";
import Sidebar from "../components/layout/Sidebar";
import MemberList from "../components/layout/MemberList";
import PublicProfileModal from "../components/profile/PublicProfileModal";
import AccessManagerModal from "../components/admin/AccessManagerModal";
import ChatRoom from "../components/chat/ChatRoom";
import VoiceChannel from "../components/voice/VoiceChannel";
import Settings from "./Settings";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../hooks/useAuth";
import type { Room, RoomCategory, ServerUser, VoiceControls } from "../types";
import { playDmNotification, playTextNotification } from "../lib/sounds";
import { detectRunningGame } from "../lib/gamePresence";
import { applyRemoteControlInputNative } from "../lib/remoteControlNative";

type NotificationMode = "all" | "mentions" | "mute";
type RemoteControlIncomingRequest = {
  requestId: string;
  roomId: string;
  requesterUserId: string;
  requesterUsername: string;
  expiresAt: string;
};
type RemoteControlSession = {
  sessionId: string;
  roomId: string;
  controllerUserId: string;
  hostUserId: string;
  expiresAt: string;
  token?: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUserMention(content: string, username: string) {
  if (!content || !username) return false;
  const pattern = new RegExp(`(^|\\W)@${escapeRegExp(username)}(?=\\W|$)`, "i");
  return pattern.test(content);
}

export default function Home() {
  const navigate = useNavigate();
  const {
    token,
    user,
    profile,
    loading,
    signOut,
    serverUrl,
    servers,
    switchServer,
    removeServer,
    signOutServer,
    getServerToken,
  } = useAuth();
  const { socket, isConnected, isReconnecting, reconnect } = useSocket();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [categories, setCategories] = useState<RoomCategory[]>([]);
  const [dmRooms, setDmRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [serverUsers, setServerUsers] = useState<ServerUser[]>([]);
  const [voiceParticipants, setVoiceParticipants] = useState<
    Record<string, Array<{ id: string; name: string; isSpeaking: boolean }>>
  >({});
  const [showSettings, setShowSettings] = useState(false);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [viewedProfile, setViewedProfile] = useState<ServerUser | null>(null);
  const [voiceControls, setVoiceControls] = useState<VoiceControls | null>(
    null
  );
  const [connectedVoiceRoomId, setConnectedVoiceRoomId] = useState<string | null>(
    null
  );
  const [pendingAutoJoinVoiceRoomId, setPendingAutoJoinVoiceRoomId] = useState<
    string | null
  >(null);
  const [memberListOpen, setMemberListOpen] = useState(() => {
    const saved = localStorage.getItem("chitchat-member-list-open");
    return saved !== null ? saved === "true" : true;
  });
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [mentionByRoom, setMentionByRoom] = useState<Record<string, number>>({});
  const [firstUnreadAtByRoom, setFirstUnreadAtByRoom] = useState<Record<string, string>>({});
  const [notificationModesByRoom, setNotificationModesByRoom] = useState<
    Record<string, NotificationMode>
  >({});
  const [activeCall, setActiveCall] = useState<{
    room: Room;
    ownerUserId: string;
    participantIds: string[];
  } | null>(null);
  const [serverInfo, setServerInfo] = useState<{
    name: string;
    maintenanceMode: boolean;
    userCanCreateRooms?: boolean;
    serverAnnouncement?: string;
    serverAnnouncementId?: string;
    gifsEnabled?: boolean;
  } | null>(null);
  const lastNotificationSoundAtRef = useRef(0);
  const lastDesktopNotificationAtRef = useRef(0);
  const lastNonCallRoomRef = useRef<Room | null>(null);
  const lastSentGameActivityRef = useRef<string | null>(null);
  const backgroundSocketsRef = useRef<Map<string, Socket>>(new Map());
  const [serverUnreadByUrl, setServerUnreadByUrl] = useState<Record<string, number>>({});
  const [remoteControlRequest, setRemoteControlRequest] =
    useState<RemoteControlIncomingRequest | null>(null);
  const [remoteControlSession, setRemoteControlSession] =
    useState<RemoteControlSession | null>(null);
  const [remoteControlPendingHostId, setRemoteControlPendingHostId] = useState<string | null>(
    null
  );
  const serverHasTokenByUrl = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const server of servers) {
      map[server.url] = Boolean(getServerToken(server.url));
    }
    return map;
  }, [servers, getServerToken]);

  const notificationPrefsStorageKey = useMemo(
    () => `chitchat-notifications:${serverUrl}:${user?.id ?? "anon"}`,
    [serverUrl, user?.id]
  );
  const hiddenDmsStorageKey = useMemo(
    () => `chitchat-hidden-dms:${serverUrl}:${user?.id ?? "anon"}`,
    [serverUrl, user?.id]
  );
  const selfUserIdRef = useRef<string | null>(null);
  const [hiddenDmByRoomId, setHiddenDmByRoomId] = useState<Record<string, boolean>>({});
  const hiddenDmByRoomIdRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    selfUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    hiddenDmByRoomIdRef.current = hiddenDmByRoomId;
  }, [hiddenDmByRoomId]);

  useEffect(() => {
    if (!user?.id) {
      setHiddenDmByRoomId({});
      return;
    }
    try {
      const raw = localStorage.getItem(hiddenDmsStorageKey);
      if (!raw) {
        setHiddenDmByRoomId({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      setHiddenDmByRoomId(parsed || {});
    } catch {
      setHiddenDmByRoomId({});
    }
  }, [hiddenDmsStorageKey, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(hiddenDmsStorageKey, JSON.stringify(hiddenDmByRoomId));
  }, [hiddenDmsStorageKey, hiddenDmByRoomId, user?.id]);

  const visibleDmRooms = useMemo(
    () => dmRooms.filter((room) => !hiddenDmByRoomId[room.id]),
    [dmRooms, hiddenDmByRoomId]
  );

  function toggleMemberList() {
    setMemberListOpen((prev) => {
      const next = !prev;
      localStorage.setItem("chitchat-member-list-open", String(next));
      return next;
    });
  }

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !token) {
      navigate("/login");
    }
  }, [loading, token, navigate]);

  const fetchServerInfo = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`${serverUrl}/api/server/info`, { signal });
        if (!res.ok) return;
        const data = (await res.json()) as {
          name?: string;
          maintenanceMode?: boolean;
          userCanCreateRooms?: boolean;
          serverAnnouncement?: string;
          serverAnnouncementId?: string;
          gifs?: { enabled?: boolean };
        };
        setServerInfo({
          name: data.name || "Server",
          maintenanceMode: Boolean(data.maintenanceMode),
          userCanCreateRooms: data.userCanCreateRooms,
          serverAnnouncement: data.serverAnnouncement || "",
          serverAnnouncementId: data.serverAnnouncementId || "",
          gifsEnabled: Boolean(data.gifs?.enabled),
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        setServerInfo((prev) => prev ?? { name: "Server", maintenanceMode: false });
      }
    },
    [serverUrl]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchServerInfo(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchServerInfo]);

  useEffect(() => {
    if (!token) return;

    const refresh = () => {
      void fetchServerInfo();
    };

    const intervalId = window.setInterval(refresh, 60000);
    const onFocus = () => refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [token, fetchServerInfo]);

  useEffect(() => {
    if (!isConnected) return;
    void fetchServerInfo();
  }, [isConnected, fetchServerInfo]);

  // Identify user to server when connected
  useEffect(() => {
    if (isConnected && user) {
      socket.emit("user:identify", {
        userId: user.id,
        username: profile.username,
        avatarUrl: profile.avatarUrl || undefined,
      });
    }
  }, [isConnected, user, profile.username, profile.avatarUrl, socket]);

  // Listen for room list updates from server
  useEffect(() => {
    if (!isConnected) return;

    function onRooms(serverRooms: Room[]) {
      if (serverRooms.length > 0) {
        setRooms(serverRooms);
        setCategories((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  id: "default",
                  name: "Channels",
                  position: 0,
                  enforce_type_order: 1,
                  created_at: new Date(0).toISOString(),
                },
              ]
        );
        setActiveRoom((prev) => {
          if (prev?.is_temporary) return prev;
          if (prev && serverRooms.some((room) => room.id === prev.id))
            return prev;
          // Don't auto-select if currently viewing a DM
          if (prev?.type === "dm") return prev;
          return serverRooms[0];
        });
      }
    }

    function onStructure(payload: { categories: RoomCategory[]; rooms: Room[] }) {
      if (!payload?.rooms) return;
      const serverRooms = payload.rooms;
      setCategories(payload.categories || []);
      setRooms(serverRooms);
      if (serverRooms.length > 0) {
        setActiveRoom((prev) => {
          if (prev?.is_temporary) return prev;
          if (prev && serverRooms.some((room) => room.id === prev.id))
            return prev;
          if (prev?.type === "dm") return prev;
          return serverRooms[0];
        });
      }
    }

    socket.on("rooms:list", onRooms);
    socket.on("rooms:structure", onStructure);
    socket.emit("rooms:get");

    return () => {
      socket.off("rooms:list", onRooms);
      socket.off("rooms:structure", onStructure);
    };
  }, [isConnected, socket]);

  // Listen for presence updates
  useEffect(() => {
    if (!isConnected) return;

    function onUsersList(users: ServerUser[]) {
      setServerUsers(users);
    }

    socket.on("users:list", onUsersList);

    return () => {
      socket.off("users:list", onUsersList);
    };
  }, [isConnected, socket]);

  // Listen for DM room events
  useEffect(() => {
    if (!isConnected) return;

    function onDmList(dms: Room[]) {
      setDmRooms(dms);
    }

    function onDmNew(room: Room) {
      setHiddenDmByRoomId((prev) => {
        if (!prev[room.id]) return prev;
        const next = { ...prev };
        delete next[room.id];
        return next;
      });
      setDmRooms((prev) => {
        if (prev.some((r) => r.id === room.id)) return prev;
        return [room, ...prev];
      });
    }

    socket.on("dm:list", onDmList);
    socket.on("dm:new", onDmNew);
    socket.emit("dm:get");

    return () => {
      socket.off("dm:list", onDmList);
      socket.off("dm:new", onDmNew);
    };
  }, [isConnected, socket]);

  function handleCreateRoom(
    name: string,
    type: "text" | "voice",
    categoryId?: string
  ) {
    socket.emit("room:create", { name, type, categoryId });
  }

  function handleCreateCategory(name: string) {
    socket.emit("category:create", { name });
  }

  function handleLayoutUpdate(payload: {
    categories: Array<{ id: string; position: number; enforceTypeOrder: boolean }>;
    rooms: Array<{ id: string; categoryId: string; position: number }>;
  }) {
    socket.emit("layout:update", payload);
  }

  function handleRenameRoom(roomId: string, name: string) {
    socket.emit("room:rename", { roomId, name });
  }

  function handleRenameCategory(categoryId: string, name: string) {
    socket.emit("category:rename", { categoryId, name });
  }

  function handleDeleteRoom(roomId: string) {
    socket.emit(
      "room:delete",
      { roomId },
      (ack?: { ok: boolean; error?: string }) => {
        if (!ack?.ok) {
          console.warn("Failed to delete room:", ack?.error || "unknown error");
        }
      }
    );
  }

  function handleDeleteCategory(categoryId: string) {
    socket.emit(
      "category:delete",
      { categoryId },
      (ack?: { ok: boolean; error?: string }) => {
        if (!ack?.ok) {
          console.warn("Failed to delete category:", ack?.error || "unknown error");
        }
      }
    );
  }

  function handleStartCall(targetUser: ServerUser) {
    if (!targetUser || targetUser.id === user?.id) return;
    socket.emit(
      "call:start",
      { targetUserId: targetUser.id },
      (ack?: { ok: boolean; room?: Room }) => {
        if (!ack?.ok || !ack.room) return;
        setActiveCall((prev) => ({
          room: ack.room as Room,
          ownerUserId: user?.id || "",
          participantIds: prev?.participantIds || [user?.id || "", targetUser.id].filter(Boolean),
        }));
        setActiveRoom(ack.room);
        setPendingAutoJoinVoiceRoomId(ack.room.id);
      }
    );
  }

  function handleAddToCall(targetUser: ServerUser) {
    if (!activeCall) return;
    socket.emit("call:addParticipant", { roomId: activeCall.room.id, userId: targetUser.id });
  }

  function handleRemoveFromCall(targetUser: ServerUser) {
    if (!activeCall) return;
    socket.emit("call:removeParticipant", { roomId: activeCall.room.id, userId: targetUser.id });
  }

  function handleEndCall() {
    if (!activeCall) return;
    socket.emit("call:end", { roomId: activeCall.room.id });
  }

  function handleLeaveCall() {
    if (!activeCall) return;
    socket.emit("call:leave", { roomId: activeCall.room.id });
  }

  const handleParticipantsChange = useCallback(
    (
      roomId: string,
      participants: Array<{ id: string; name: string; isSpeaking: boolean }>
    ) => {
      setVoiceParticipants((prev) => {
        const nextParticipants = participants.filter((participant) =>
          Boolean(participant.id?.trim())
        );
        const prevParticipants = prev[roomId] ?? [];
        const isSameLength = prevParticipants.length === nextParticipants.length;
        const isSameSnapshot =
          isSameLength &&
          prevParticipants.every((participant, index) => {
            const next = nextParticipants[index];
            return (
              participant.id === next.id &&
              participant.name === next.name &&
              participant.isSpeaking === next.isSpeaking
            );
          });
        if (isSameSnapshot) return prev;
        return { ...prev, [roomId]: nextParticipants };
      });
    },
    []
  );

  const handleOpenDM = useCallback(
    (targetUser: ServerUser) => {
      if (!targetUser || targetUser.id === user?.id) return;
      socket.emit(
        "dm:open",
        { targetUserId: targetUser.id },
        (ack: { room: Room | null }) => {
          if (ack?.room) {
            setHiddenDmByRoomId((prev) => {
              if (!prev[ack.room!.id]) return prev;
              const next = { ...prev };
              delete next[ack.room!.id];
              return next;
            });
            setDmRooms((prev) => {
              if (prev.some((r) => r.id === ack.room!.id)) return prev;
              return [ack.room!, ...prev];
            });
            setActiveRoom(ack.room);
          }
        }
      );
    },
    [socket, user?.id]
  );

  async function handleSignOut() {
    // Disconnect from voice channel first if connected
    if (voiceControls) {
      voiceControls.disconnect();
      setVoiceControls(null);
      setConnectedVoiceRoomId(null);
    }
    await signOut();
    navigate("/login", { replace: true });
  }

  useEffect(() => {
    if (!user?.id) {
      setNotificationModesByRoom({});
      return;
    }
    try {
      const raw = localStorage.getItem(notificationPrefsStorageKey);
      if (!raw) {
        setNotificationModesByRoom({});
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, NotificationMode>;
      setNotificationModesByRoom(parsed || {});
    } catch {
      setNotificationModesByRoom({});
    }
  }, [notificationPrefsStorageKey, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(
      notificationPrefsStorageKey,
      JSON.stringify(notificationModesByRoom)
    );
  }, [notificationModesByRoom, notificationPrefsStorageKey, user?.id]);

  const setRoomNotificationMode = useCallback(
    (roomId: string, mode: NotificationMode) => {
      setNotificationModesByRoom((prev) => ({ ...prev, [roomId]: mode }));
      if (isConnected) {
        socket.emit(
          "notifications:set",
          { roomId, mode },
          (ack?: { ok: boolean; error?: string }) => {
            if (!ack?.ok) {
              console.warn(
                "Failed to save notification mode:",
                ack?.error || "unknown error"
              );
            }
          }
        );
      }
    },
    [isConnected, socket]
  );

  useEffect(() => {
    if (!isConnected || !user?.id) return;
    socket.emit(
      "notifications:get",
      (ack?: {
        ok: boolean;
        modes?: Record<string, NotificationMode>;
        error?: string;
      }) => {
        if (!ack?.ok || !ack.modes) return;
        setNotificationModesByRoom(ack.modes);
      }
    );
  }, [isConnected, socket, user?.id]);

  useEffect(() => {
    if (!isConnected || !user?.id) return;
    socket.emit(
      "remote-control:list",
      (ack?: {
        ok: boolean;
        sessions?: RemoteControlSession[];
      }) => {
        if (!ack?.ok || !ack.sessions?.length) {
          setRemoteControlSession(null);
          return;
        }
        setRemoteControlSession(ack.sessions[0] ?? null);
      }
    );
  }, [isConnected, socket, user?.id]);

  useEffect(() => {
    if (!isConnected) return;

    function onRemoteControlRequest(payload: RemoteControlIncomingRequest) {
      setRemoteControlRequest(payload);
    }
    function onRemoteControlRequestCancelled(payload: { requestId: string }) {
      setRemoteControlRequest((prev) =>
        prev?.requestId === payload.requestId ? null : prev
      );
    }
    function onRemoteControlRequestDenied() {
      setRemoteControlPendingHostId(null);
      window.alert("Remote control request was denied or expired.");
    }
    function onRemoteControlSessionStarted(payload: RemoteControlSession) {
      setRemoteControlSession(payload);
      setRemoteControlPendingHostId(null);
      if (payload.controllerUserId === user?.id) {
        window.alert("Remote control access granted.");
      }
    }
    function onRemoteControlSessionEnded(payload: {
      sessionId: string;
      reason: string;
    }) {
      setRemoteControlSession((prev) =>
        prev?.sessionId === payload.sessionId ? null : prev
      );
      if (payload.reason === "expired") {
        window.alert("Remote control session expired.");
      }
    }
    async function onRemoteControlInput(payload: {
      sessionId: string;
      token: string;
      event: {
        type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
        xNorm?: number;
        yNorm?: number;
        button?: "left" | "right" | "middle";
        deltaY?: number;
        key?: string;
      };
      fromUserId: string;
    }) {
      if (!payload?.sessionId || !payload?.event) return;
      const current = remoteControlSession;
      if (!current || current.sessionId !== payload.sessionId) return;
      if (current.hostUserId !== user?.id) return;
      if (current.token && payload.token !== current.token) return;
      try {
        await applyRemoteControlInputNative(payload.event);
      } catch {
        // Ignore injection errors on unsupported host platforms.
      }
    }

    socket.on("remote-control:request", onRemoteControlRequest);
    socket.on("remote-control:request-cancelled", onRemoteControlRequestCancelled);
    socket.on("remote-control:request-denied", onRemoteControlRequestDenied);
    socket.on("remote-control:session-started", onRemoteControlSessionStarted);
    socket.on("remote-control:session-ended", onRemoteControlSessionEnded);
    socket.on("remote-control:input", onRemoteControlInput);
    return () => {
      socket.off("remote-control:request", onRemoteControlRequest);
      socket.off("remote-control:request-cancelled", onRemoteControlRequestCancelled);
      socket.off("remote-control:request-denied", onRemoteControlRequestDenied);
      socket.off("remote-control:session-started", onRemoteControlSessionStarted);
      socket.off("remote-control:session-ended", onRemoteControlSessionEnded);
      socket.off("remote-control:input", onRemoteControlInput);
    };
  }, [isConnected, socket, user?.id, remoteControlSession]);

  const requestScreenControl = useCallback(
    (hostUserId: string, roomId: string) => {
      if (!roomId) return;
      setRemoteControlPendingHostId(hostUserId);
      socket.emit(
        "remote-control:request",
        { roomId, targetUserId: hostUserId },
        (ack?: { ok: boolean; error?: string }) => {
          if (!ack?.ok) {
            setRemoteControlPendingHostId(null);
            window.alert(ack?.error || "Failed to request control");
          }
        }
      );
    },
    [socket]
  );

  const respondScreenControl = useCallback(
    (approve: boolean) => {
      if (!remoteControlRequest) return;
      socket.emit(
        "remote-control:respond",
        { requestId: remoteControlRequest.requestId, approve },
        (ack?: { ok: boolean; error?: string }) => {
          if (!ack?.ok) {
            window.alert(ack?.error || "Failed to respond to request");
          }
          setRemoteControlRequest(null);
        }
      );
    },
    [remoteControlRequest, socket]
  );

  const revokeScreenControl = useCallback(
    (sessionId: string) => {
      socket.emit(
        "remote-control:revoke",
        { sessionId },
        (ack?: { ok: boolean; error?: string }) => {
          if (!ack?.ok) {
            window.alert(ack?.error || "Failed to revoke control session");
          }
        }
      );
    },
    [socket]
  );

  const sendRemoteControlInput = useCallback(
    (event: {
      type: "pointer_move" | "pointer_down" | "pointer_up" | "wheel" | "key_down" | "key_up";
      xNorm?: number;
      yNorm?: number;
      button?: "left" | "right" | "middle";
      deltaY?: number;
      key?: string;
    }) => {
      if (!remoteControlSession?.sessionId || !remoteControlSession?.token) return;
      socket.emit("remote-control:input", {
        sessionId: remoteControlSession.sessionId,
        token: remoteControlSession.token,
        event,
      });
    },
    [socket, remoteControlSession]
  );

  const handleSelectRoom = useCallback(
    (room: Room) => {
      if (
        room.type === "voice" &&
        voiceControls &&
        connectedVoiceRoomId &&
        connectedVoiceRoomId !== room.id
      ) {
        setPendingAutoJoinVoiceRoomId(room.id);
        voiceControls.disconnect();
        setVoiceControls(null);
        setConnectedVoiceRoomId(null);
      } else if (room.type !== "voice") {
        setPendingAutoJoinVoiceRoomId(null);
      }
      setActiveRoom(room);
    },
    [voiceControls, connectedVoiceRoomId]
  );

  useEffect(() => {
    if (!activeRoom?.is_temporary) {
      lastNonCallRoomRef.current = activeRoom;
    }
  }, [activeRoom]);

  useEffect(() => {
    if (!isConnected) return;

    function onCallState(payload: {
      room: Room;
      ownerUserId: string;
      participantIds: string[];
    }) {
      if (!payload?.room?.id) return;
      setActiveCall({
        room: payload.room,
        ownerUserId: payload.ownerUserId,
        participantIds: payload.participantIds || [],
      });
      if (payload.participantIds?.includes(user?.id || "")) {
        setActiveRoom((prev) => {
          if (prev?.id === payload.room.id) return prev;
          if (prev && !prev.is_temporary) lastNonCallRoomRef.current = prev;
          return payload.room;
        });
        setPendingAutoJoinVoiceRoomId(payload.room.id);
      }
    }

    function onCallEnded(payload: { roomId: string }) {
      if (!payload?.roomId) return;
      setActiveCall((prev) => (prev?.room.id === payload.roomId ? null : prev));
      setPendingAutoJoinVoiceRoomId((prev) => (prev === payload.roomId ? null : prev));
      setConnectedVoiceRoomId((prev) => (prev === payload.roomId ? null : prev));
      setActiveRoom((prev) => {
        if (prev?.id !== payload.roomId) return prev;
        return lastNonCallRoomRef.current;
      });
    }

    function onCallRemoved(payload: { roomId: string }) {
      onCallEnded(payload);
    }

    socket.on("call:state", onCallState);
    socket.on("call:ended", onCallEnded);
    socket.on("call:removed", onCallRemoved);
    return () => {
      socket.off("call:state", onCallState);
      socket.off("call:ended", onCallEnded);
      socket.off("call:removed", onCallRemoved);
    };
  }, [isConnected, socket, user?.id]);

  const handleVoiceControlsChange = useCallback(
    (roomId: string, controls: VoiceControls | null) => {
      setVoiceControls(controls);
      if (controls) {
        setConnectedVoiceRoomId((prev) => (prev === roomId ? prev : roomId));
        setPendingAutoJoinVoiceRoomId((prev) => (prev === roomId ? null : prev));
      } else {
        setConnectedVoiceRoomId((prev) => (prev === roomId ? null : prev));
      }
    },
    []
  );

  const markRoomRead = useCallback((roomId: string) => {
    setUnreadByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
    setMentionByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
    setFirstUnreadAtByRoom((prev) => {
      if (!prev[roomId]) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
  }, []);

  // Track unread and mention badges for rooms that are not currently active.
  useEffect(() => {
    if (!isConnected) return;

    function onMessageNotify(payload: {
      room_id: string;
      user_id: string;
      content: string;
      created_at: string;
    }) {
      if (!payload?.room_id) return;
      if (payload.user_id === user?.id) return;
      if (activeRoom?.id === payload.room_id) return;

      const room =
        rooms.find((entry) => entry.id === payload.room_id) ||
        dmRooms.find((entry) => entry.id === payload.room_id);
      if (room?.type === "dm" && hiddenDmByRoomIdRef.current[payload.room_id]) {
        setHiddenDmByRoomId((prev) => {
          if (!prev[payload.room_id]) return prev;
          const next = { ...prev };
          delete next[payload.room_id];
          return next;
        });
      }
      const notificationMode = notificationModesByRoom[payload.room_id] ?? "all";
      const mentioned = hasUserMention(payload.content, profile.username);
      const shouldNotifyByRoom =
        notificationMode === "all" ||
        (notificationMode === "mentions" && mentioned);
      const shouldPlaySound = shouldNotifyByRoom;
      const shouldDesktopNotifyByProfile =
        !profile.desktopNotificationsMentionsOnly || mentioned || room?.type === "dm";
      const canDesktopNotify =
        shouldNotifyByRoom &&
        profile.desktopNotificationsEnabled &&
        shouldDesktopNotifyByProfile &&
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        document.visibilityState !== "visible";

      if (shouldPlaySound) {
        const now = Date.now();
        if (now - lastNotificationSoundAtRef.current > 550) {
          if (room?.type === "dm") playDmNotification();
          else playTextNotification();
          lastNotificationSoundAtRef.current = now;
        }
      }

      if (canDesktopNotify) {
        const now = Date.now();
        if (now - lastDesktopNotificationAtRef.current > 750) {
          const title = room?.type === "dm" ? "New direct message" : `#${room?.name || "channel"}`;
          const body = `${payload.content || "(attachment)"}`.trim().slice(0, 180);
          const notification = new Notification(title, {
            body,
            tag: `room:${payload.room_id}`,
          });
          notification.onclick = () => {
            try {
              window.focus();
            } catch {
              // no-op
            }
          };
          lastDesktopNotificationAtRef.current = now;
        }
      }

      setUnreadByRoom((prev) => ({
        ...prev,
        [payload.room_id]: (prev[payload.room_id] ?? 0) + 1,
      }));

      setFirstUnreadAtByRoom((prev) => {
        if (prev[payload.room_id]) return prev;
        return { ...prev, [payload.room_id]: payload.created_at };
      });

      if (mentioned) {
        setMentionByRoom((prev) => ({
          ...prev,
          [payload.room_id]: (prev[payload.room_id] ?? 0) + 1,
        }));
      }
    }

    socket.on("message:notify", onMessageNotify);
    return () => {
      socket.off("message:notify", onMessageNotify);
    };
  }, [
    isConnected,
    socket,
    activeRoom?.id,
    profile.username,
    user?.id,
    rooms,
    dmRooms,
    notificationModesByRoom,
    profile.desktopNotificationsEnabled,
    profile.desktopNotificationsMentionsOnly,
  ]);

  const handleHideDM = useCallback(
    (roomId: string) => {
      setHiddenDmByRoomId((prev) => ({ ...prev, [roomId]: true }));
      setActiveRoom((prev) => {
        if (prev?.id !== roomId) return prev;
        return rooms[0] ?? null;
      });
    },
    [rooms]
  );

  useEffect(() => {
    if (!isConnected || !user?.id) return;

    let cancelled = false;
    const emitIfChanged = async () => {
      const detectedGame = await detectRunningGame();
      if (cancelled) return;
      const nextGame = detectedGame?.trim() || null;
      if (nextGame === lastSentGameActivityRef.current) {
        return;
      }
      lastSentGameActivityRef.current = nextGame;
      socket.emit("user:activity", { game: nextGame });
    };

    void emitIfChanged();
    const timer = window.setInterval(() => {
      void emitIfChanged();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (lastSentGameActivityRef.current !== null) {
        socket.emit("user:activity", { game: null });
        lastSentGameActivityRef.current = null;
      }
    };
  }, [isConnected, socket, user?.id]);

  useEffect(() => {
    // Clearing active server badge on switch keeps focus on inactive server notifications.
    setServerUnreadByUrl((prev) => {
      if (!prev[serverUrl]) return prev;
      return { ...prev, [serverUrl]: 0 };
    });
  }, [serverUrl]);

  useEffect(() => {
    const sockets = backgroundSocketsRef.current;
    const desired = new Set<string>();

    for (const server of servers) {
      const url = (server.url || "").trim().replace(/\/+$/, "");
      if (!url || url === serverUrl) continue;
      const tokenForServer = getServerToken(url);
      if (!tokenForServer) continue;
      desired.add(url);

      let bgSocket = sockets.get(url);
      if (!bgSocket) {
        bgSocket = io(url, {
          autoConnect: false,
          transports: ["websocket", "polling"],
          auth: { token: tokenForServer },
        });
        bgSocket.on("message:notify", (payload: { user_id?: string }) => {
          if (payload?.user_id === selfUserIdRef.current) return;
          setServerUnreadByUrl((prev) => ({
            ...prev,
            [url]: (prev[url] ?? 0) + 1,
          }));
        });
        sockets.set(url, bgSocket);
      }

      bgSocket.auth = { token: tokenForServer };
      if (!bgSocket.connected) {
        bgSocket.connect();
      }
    }

    for (const [url, bgSocket] of sockets.entries()) {
      if (!desired.has(url)) {
        bgSocket.removeAllListeners();
        bgSocket.disconnect();
        sockets.delete(url);
      }
    }

    return () => {
      // Keep long-lived background sockets while this screen is mounted.
    };
  }, [servers, serverUrl, getServerToken]);

  useEffect(() => {
    return () => {
      for (const socketEntry of backgroundSocketsRef.current.values()) {
        socketEntry.removeAllListeners();
        socketEntry.disconnect();
      }
      backgroundSocketsRef.current.clear();
    };
  }, []);

  const activeVoiceRoom =
    activeRoom && activeRoom.type === "voice" ? activeRoom : null;
  const connectedVoiceRoom = useMemo(() => {
    if (!connectedVoiceRoomId) return null;
    if (activeVoiceRoom?.id === connectedVoiceRoomId) return activeVoiceRoom;
    return rooms.find((room) => room.type === "voice" && room.id === connectedVoiceRoomId) ?? null;
  }, [connectedVoiceRoomId, activeVoiceRoom, rooms]);
  const voiceSessionRoom = connectedVoiceRoom || activeVoiceRoom;
  const mentionableUsernames = useMemo(() => {
    const set = new Set<string>();
    for (const serverUser of serverUsers) {
      if (serverUser.username?.trim()) set.add(serverUser.username.trim());
    }
    if (profile.username?.trim()) set.add(profile.username.trim());
    for (const dm of dmRooms) {
      if (dm.other_username?.trim()) set.add(dm.other_username.trim());
    }
    return Array.from(set);
  }, [serverUsers, profile.username, dmRooms]);
  const canManageRoles = Boolean(user?.permissions.canManageRoles || user?.isAdmin);
  const canManageChannels = Boolean(user?.permissions.canManageChannels || user?.isAdmin);
  const canKickMembers = Boolean(user?.permissions.canKickMembers || user?.isAdmin);
  const canBanMembers = Boolean(user?.permissions.canBanMembers || user?.isAdmin);
  const canTimeoutMembers = Boolean(user?.permissions.canTimeoutMembers || user?.isAdmin);
  const canModerateVoice = Boolean(user?.permissions.canModerateVoice || user?.isAdmin);
  const canPinMessages = Boolean(user?.permissions.canPinMessages || user?.isAdmin);
  const canManageMessages = Boolean(user?.permissions.canManageMessages || user?.isAdmin);
  const canUseEmojis = Boolean(user?.permissions.canUseEmojis ?? true);
  const canCreateRooms = Boolean(
    canManageChannels || serverInfo?.userCanCreateRooms !== false
  );
  const announcementId = serverInfo?.serverAnnouncementId || "";
  const announcementText = (serverInfo?.serverAnnouncement || "").trim();
  const announcementStorageKey = `chitchat-announcement-dismissed:${serverUrl}:${announcementId}`;
  const [announcementDismissed, setAnnouncementDismissed] = useState(false);

  useEffect(() => {
    if (!announcementId) {
      setAnnouncementDismissed(false);
      return;
    }
    const dismissed = localStorage.getItem(announcementStorageKey) === "1";
    setAnnouncementDismissed(dismissed);
  }, [announcementId, announcementStorageKey]);

  if (loading || !token) {
    return (
      <div className="flex items-center justify-center flex-1 bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 bg-[var(--bg-primary)]">
      <div className="absolute inset-0 app-bg" />

      <div className="relative z-10 flex w-full h-full p-4 gap-5">
        <Sidebar
          rooms={rooms}
          categories={categories}
          dmRooms={visibleDmRooms}
          onHideDM={handleHideDM}
          activeRoom={activeRoom}
          onSelectRoom={handleSelectRoom}
          onCreateRoom={handleCreateRoom}
          onCreateCategory={handleCreateCategory}
          onRenameRoom={handleRenameRoom}
          onRenameCategory={handleRenameCategory}
          onDeleteRoom={handleDeleteRoom}
          onDeleteCategory={handleDeleteCategory}
          onUpdateLayout={handleLayoutUpdate}
          username={profile.username}
          status={profile.status}
          avatarUrl={profile.avatarUrl}
          voiceParticipants={voiceParticipants}
          onOpenSettings={() => setShowSettings(true)}
          onOpenAccessManager={() => setShowAccessManager(true)}
          onSignOut={handleSignOut}
          voiceControls={voiceControls}
          unreadByRoom={unreadByRoom}
          mentionByRoom={mentionByRoom}
          serverName={serverInfo?.name || "Server"}
          serverProfiles={servers}
          activeServerUrl={serverUrl}
          onSwitchServer={switchServer}
          onAddServer={switchServer}
          onRemoveServer={removeServer}
          onSignOutServer={signOutServer}
          serverHasTokenByUrl={serverHasTokenByUrl}
          serverUnreadByUrl={serverUnreadByUrl}
          isServerConnected={isConnected}
          isServerReconnecting={isReconnecting}
          serverMaintenanceMode={Boolean(serverInfo?.maintenanceMode)}
          canCreateRooms={canCreateRooms}
          canManageChannels={canManageChannels}
          canManageRoles={canManageRoles}
        />

        {/* Main content area */}
        <main className="flex-1 flex flex-col min-w-0">
          {!isConnected && token && (
            <div className="reconnect-banner">
              <span>
                {isReconnecting
                  ? "Connection lost. Reconnecting..."
                  : "Disconnected from server."}
              </span>
              <button
                type="button"
                className="reconnect-banner-btn"
                onClick={reconnect}
              >
                Retry now
              </button>
            </div>
          )}
          <div className="flex-1 flex flex-col rounded-2xl panel overflow-hidden">
            {announcementText && !announcementDismissed && (
              <div className="server-announcement-banner">
                <span>{announcementText}</span>
                <button
                  type="button"
                  className="server-announcement-close"
                  onClick={() => {
                    setAnnouncementDismissed(true);
                    localStorage.setItem(announcementStorageKey, "1");
                  }}
                >
                  x
                </button>
              </div>
            )}
            {activeRoom ? (
              activeRoom.type === "text" || activeRoom.type === "dm" ? (
                <ChatRoom
                  room={activeRoom}
                  socket={socket}
                  isConnected={isConnected}
                  currentUserId={user?.id ?? null}
                  currentUsername={profile.username}
                  currentAvatarUrl={profile.avatarUrl}
                  isAdmin={user?.isAdmin ?? false}
                  canManageMessages={canManageMessages}
                  canPinMessages={canPinMessages}
                  canUseEmojis={canUseEmojis}
                  canUseGifs={Boolean(serverInfo?.gifsEnabled)}
                  unreadCount={unreadByRoom[activeRoom.id] ?? 0}
                  firstUnreadAt={firstUnreadAtByRoom[activeRoom.id]}
                  onMarkRead={markRoomRead}
                  notificationMode={notificationModesByRoom[activeRoom.id] ?? "all"}
                  onNotificationModeChange={(mode) =>
                    setRoomNotificationMode(activeRoom.id, mode)
                  }
                  mentionableUsernames={mentionableUsernames}
                />
              ) : null
            ) : (
              <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
                Select a channel to get started
              </div>
            )}
            {voiceSessionRoom && (
              <div
                className="flex-1 flex flex-col"
                style={{ display: activeRoom?.type === "voice" ? undefined : "none" }}
              >
                <VoiceChannel
                  key={voiceSessionRoom.id}
                  room={voiceSessionRoom}
                  onParticipantsChange={handleParticipantsChange}
                  autoJoin={pendingAutoJoinVoiceRoomId === voiceSessionRoom.id}
                  onVoiceControlsChange={handleVoiceControlsChange}
                  currentUserId={user?.id ?? null}
                  remoteControlSession={
                    remoteControlSession?.roomId === voiceSessionRoom.id
                      ? remoteControlSession
                      : null
                  }
                  remoteControlPendingHostId={remoteControlPendingHostId}
                  onRequestScreenControl={requestScreenControl}
                  onRevokeScreenControl={revokeScreenControl}
                  onSendRemoteControlInput={sendRemoteControlInput}
                />
              </div>
            )}
          </div>
        </main>

        {/* Right sidebar: Member list */}
        {memberListOpen ? (
          <MemberList
            socket={socket}
            isConnected={isConnected}
            users={serverUsers}
            voiceParticipants={voiceParticipants}
            currentUserId={user?.id ?? null}
            onUserClick={handleOpenDM}
            onViewProfile={setViewedProfile}
            activeCall={
              activeCall
                ? {
                    roomId: activeCall.room.id,
                    ownerUserId: activeCall.ownerUserId,
                    participantIds: activeCall.participantIds,
                  }
                : null
            }
            onStartCall={handleStartCall}
            onAddToCall={handleAddToCall}
            onRemoveFromCall={handleRemoveFromCall}
            onEndCall={handleEndCall}
            onLeaveCall={handleLeaveCall}
            onToggle={toggleMemberList}
            canManageRoles={canManageRoles}
            canKickMembers={canKickMembers}
            canBanMembers={canBanMembers}
            canTimeoutMembers={canTimeoutMembers}
            canModerateVoice={canModerateVoice}
          />
        ) : (
          <div className="member-list-collapsed">
            <button
              onClick={toggleMemberList}
              className="member-list-toggle"
              title="Show members"
              aria-label="Show members"
            >
              <ChevronLeft size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Connection status indicator */}
      <div
        className={`fixed bottom-2 right-2 px-2 py-1 text-xs rounded ${
          isConnected
            ? "bg-[var(--success)]/20 text-[var(--success)]"
            : "bg-[var(--danger)]/20 text-[var(--danger)]"
        }`}
      >
        {isConnected ? "Connected" : "Disconnected"}
      </div>

      {showSettings && (
        <Settings onClose={() => setShowSettings(false)} />
      )}
      {showAccessManager && (
        <AccessManagerModal
          socket={socket}
          isConnected={isConnected}
          users={serverUsers}
          rooms={rooms}
          canManageRoles={canManageRoles}
          onClose={() => setShowAccessManager(false)}
        />
      )}
      {viewedProfile && (
        <PublicProfileModal
          user={viewedProfile}
          onClose={() => setViewedProfile(null)}
          onOpenDM={
            viewedProfile.id === user?.id
              ? undefined
              : (targetUser) => {
                  handleOpenDM(targetUser);
                  setViewedProfile(null);
                }
          }
        />
      )}
      {remoteControlRequest && (
        <div className="public-profile-backdrop">
          <div className="public-profile-modal" style={{ maxWidth: 460 }}>
            <div className="public-profile-header">
              <h2>Remote Control Request</h2>
            </div>
            <div className="public-profile-body" style={{ gap: 14 }}>
              <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                <strong>{remoteControlRequest.requesterUsername}</strong> is requesting
                control of your shared screen.
              </p>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>
                Only approve if you trust this user. You can stop control anytime with Kill
                Switch.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="profile-button secondary"
                  onClick={() => respondScreenControl(false)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="profile-button"
                  onClick={() => respondScreenControl(true)}
                >
                  Allow
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
