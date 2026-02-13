import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { ChevronLeft } from "lucide-react";
import Sidebar from "../components/layout/Sidebar";
import MemberList from "../components/layout/MemberList";
import PublicProfileModal from "../components/profile/PublicProfileModal";
import ChatRoom from "../components/chat/ChatRoom";
import VoiceChannel from "../components/voice/VoiceChannel";
import Settings from "./Settings";
import { useSocket } from "../hooks/useSocket";
import { useAuth } from "../hooks/useAuth";
import type { Room, RoomCategory, ServerUser, VoiceControls } from "../types";
import { playDmNotification, playTextNotification } from "../lib/sounds";
import { detectGameDetails } from "../lib/gamePresence";

type NotificationMode = "all" | "mentions" | "mute";

type StoredGamePresenceRules = {
  aliases: Record<string, string>;
  ignoredExecutables: string[];
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
  } | null>(null);
  const lastNotificationSoundAtRef = useRef(0);
  const lastNonCallRoomRef = useRef<Room | null>(null);
  const lastSentGameActivityRef = useRef<string | null>(null);
  const backgroundSocketsRef = useRef<Map<string, Socket>>(new Map());
  const [serverUnreadByUrl, setServerUnreadByUrl] = useState<Record<string, number>>({});
  const dismissedUnknownGamesRef = useRef<Set<string>>(new Set());
  const [gamePresenceRules, setGamePresenceRules] = useState<StoredGamePresenceRules>({
    aliases: {},
    ignoredExecutables: [],
  });
  const [pendingUnknownGame, setPendingUnknownGame] = useState<{
    executable: string;
    suggestedName: string;
  } | null>(null);
  const [unknownGameLabelInput, setUnknownGameLabelInput] = useState("");

  const notificationPrefsStorageKey = useMemo(
    () => `chitchat-notifications:${serverUrl}:${user?.id ?? "anon"}`,
    [serverUrl, user?.id]
  );
  const gamePresenceRulesStorageKey = useMemo(
    () => `chitchat-game-presence-rules:${serverUrl}:${user?.id ?? "anon"}`,
    [serverUrl, user?.id]
  );
  const selfUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    selfUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

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

  useEffect(() => {
    let cancelled = false;
    async function loadServerInfo() {
      try {
        const res = await fetch(`${serverUrl}/api/server/info`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          name?: string;
          maintenanceMode?: boolean;
          userCanCreateRooms?: boolean;
        };
        if (cancelled) return;
        setServerInfo({
          name: data.name || "Server",
          maintenanceMode: Boolean(data.maintenanceMode),
          userCanCreateRooms: data.userCanCreateRooms,
        });
      } catch {
        if (!cancelled) {
          setServerInfo((prev) => prev ?? { name: "Server", maintenanceMode: false });
        }
      }
    }
    void loadServerInfo();
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

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
    if (!user?.id) {
      setGamePresenceRules({ aliases: {}, ignoredExecutables: [] });
      return;
    }
    try {
      const raw = localStorage.getItem(gamePresenceRulesStorageKey);
      if (!raw) {
        setGamePresenceRules({ aliases: {}, ignoredExecutables: [] });
        return;
      }
      const parsed = JSON.parse(raw) as Partial<StoredGamePresenceRules>;
      setGamePresenceRules({
        aliases: parsed.aliases || {},
        ignoredExecutables: Array.isArray(parsed.ignoredExecutables)
          ? parsed.ignoredExecutables
          : [],
      });
    } catch {
      setGamePresenceRules({ aliases: {}, ignoredExecutables: [] });
    }
  }, [gamePresenceRulesStorageKey, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(
      notificationPrefsStorageKey,
      JSON.stringify(notificationModesByRoom)
    );
  }, [notificationModesByRoom, notificationPrefsStorageKey, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(
      gamePresenceRulesStorageKey,
      JSON.stringify(gamePresenceRules)
    );
  }, [gamePresenceRules, gamePresenceRulesStorageKey, user?.id]);

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
      const notificationMode = notificationModesByRoom[payload.room_id] ?? "all";
      const mentioned = hasUserMention(payload.content, profile.username);
      const shouldPlaySound =
        notificationMode === "all" ||
        (notificationMode === "mentions" && mentioned);

      if (shouldPlaySound) {
        const now = Date.now();
        if (now - lastNotificationSoundAtRef.current > 550) {
          if (room?.type === "dm") playDmNotification();
          else playTextNotification();
          lastNotificationSoundAtRef.current = now;
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
  ]);

  useEffect(() => {
    if (!isConnected || !user?.id) return;

    let cancelled = false;
    const emitIfChanged = async () => {
      const detection = await detectGameDetails();
      if (cancelled) return;
      if (detection.kind === "known") {
        const nextGame = detection.game.trim();
        if (!nextGame) return;
        if (nextGame === lastSentGameActivityRef.current) return;
        lastSentGameActivityRef.current = nextGame;
        socket.emit("user:activity", { game: nextGame });
        setPendingUnknownGame(null);
        return;
      }

      if (detection.kind === "unknown") {
        const exe = detection.executable.toLowerCase();
        const mappedName = gamePresenceRules.aliases[exe];
        const ignored =
          gamePresenceRules.ignoredExecutables.includes(exe) ||
          dismissedUnknownGamesRef.current.has(exe);

        if (mappedName && mappedName.trim()) {
          const nextGame = mappedName.trim();
          if (nextGame !== lastSentGameActivityRef.current) {
            lastSentGameActivityRef.current = nextGame;
            socket.emit("user:activity", { game: nextGame });
          }
          return;
        }

        if (!ignored) {
          setPendingUnknownGame((prev) => {
            if (prev?.executable === exe) return prev;
            setUnknownGameLabelInput(detection.suggestedName || "Unknown Game");
            return {
              executable: exe,
              suggestedName: detection.suggestedName || "Unknown Game",
            };
          });
        }

        if (lastSentGameActivityRef.current !== null) {
          lastSentGameActivityRef.current = null;
          socket.emit("user:activity", { game: null });
        }
        return;
      }

      if (lastSentGameActivityRef.current !== null) {
        lastSentGameActivityRef.current = null;
        socket.emit("user:activity", { game: null });
      }
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
  }, [isConnected, socket, user?.id, gamePresenceRules]);

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

  function handleSaveUnknownGame() {
    if (!pendingUnknownGame) return;
    const label = unknownGameLabelInput.trim();
    if (!label) return;
    const exe = pendingUnknownGame.executable.toLowerCase();
    setGamePresenceRules((prev) => {
      const nextIgnored = prev.ignoredExecutables.filter((entry) => entry !== exe);
      return {
        aliases: { ...prev.aliases, [exe]: label },
        ignoredExecutables: nextIgnored,
      };
    });
    dismissedUnknownGamesRef.current.delete(exe);
    setPendingUnknownGame(null);
    setUnknownGameLabelInput("");
    if (label !== lastSentGameActivityRef.current) {
      lastSentGameActivityRef.current = label;
      socket.emit("user:activity", { game: label });
    }
  }

  function handleIgnoreUnknownGame() {
    if (!pendingUnknownGame) return;
    const exe = pendingUnknownGame.executable.toLowerCase();
    setGamePresenceRules((prev) => ({
      aliases: prev.aliases,
      ignoredExecutables: prev.ignoredExecutables.includes(exe)
        ? prev.ignoredExecutables
        : [...prev.ignoredExecutables, exe],
    }));
    setPendingUnknownGame(null);
    setUnknownGameLabelInput("");
    if (lastSentGameActivityRef.current !== null) {
      lastSentGameActivityRef.current = null;
      socket.emit("user:activity", { game: null });
    }
  }

  function handleDismissUnknownGame() {
    if (!pendingUnknownGame) return;
    dismissedUnknownGamesRef.current.add(pendingUnknownGame.executable.toLowerCase());
    setPendingUnknownGame(null);
  }

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
          dmRooms={dmRooms}
          activeRoom={activeRoom}
          onSelectRoom={handleSelectRoom}
          onCreateRoom={handleCreateRoom}
          onCreateCategory={handleCreateCategory}
          onRenameRoom={handleRenameRoom}
          onRenameCategory={handleRenameCategory}
          onUpdateLayout={handleLayoutUpdate}
          username={profile.username}
          status={profile.status}
          avatarUrl={profile.avatarUrl}
          voiceParticipants={voiceParticipants}
          onOpenSettings={() => setShowSettings(true)}
          onSignOut={handleSignOut}
          voiceControls={voiceControls}
          unreadByRoom={unreadByRoom}
          mentionByRoom={mentionByRoom}
          serverName={serverInfo?.name || "Server"}
          serverProfiles={servers}
          activeServerUrl={serverUrl}
          onSwitchServer={switchServer}
          onManageServers={() => navigate("/login?manageServers=1")}
          serverUnreadByUrl={serverUnreadByUrl}
          isServerConnected={isConnected}
          isServerReconnecting={isReconnecting}
          serverMaintenanceMode={Boolean(serverInfo?.maintenanceMode)}
          canCreateRooms={Boolean(
            user?.isAdmin || serverInfo?.userCanCreateRooms !== false
          )}
          canManageChannels={Boolean(user?.isAdmin)}
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
                />
              </div>
            )}
          </div>
        </main>

        {/* Right sidebar: Member list */}
        {memberListOpen ? (
          <MemberList
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
      {pendingUnknownGame && (
        <div
          className="create-modal-backdrop"
          onClick={handleDismissUnknownGame}
        >
          <div className="create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="create-modal-title">Unknown Game Detected</div>
            <p className="create-modal-subtitle">
              We found an unrecognized game process. Set how it should appear in your status.
            </p>
            <div className="game-presence-exe">
              Executable: <code>{pendingUnknownGame.executable}</code>
            </div>
            <label className="create-modal-field-label" htmlFor="unknown-game-label">
              Display Name
            </label>
            <input
              id="unknown-game-label"
              type="text"
              value={unknownGameLabelInput}
              onChange={(event) => setUnknownGameLabelInput(event.target.value)}
              placeholder={pendingUnknownGame.suggestedName || "Game name"}
              className="w-full px-3 py-3 mb-4 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg outline-none focus:border-[var(--accent)]"
            />
            <div className="create-modal-actions">
              <button
                type="button"
                className="profile-button secondary"
                onClick={handleIgnoreUnknownGame}
              >
                Not a game
              </button>
              <button
                type="button"
                className="profile-button secondary"
                onClick={handleDismissUnknownGame}
              >
                Later
              </button>
              <button
                type="button"
                className="profile-button"
                onClick={handleSaveUnknownGame}
                disabled={!unknownGameLabelInput.trim()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
