import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Room, RoomCategory, VoiceControls } from "../../types";
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  MonitorUp,
  PhoneOff,
  Wind,
  MessageSquare,
  Volume2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { getResolutionsUpTo, getFpsUpTo } from "../../lib/livekit";
import { getServerUrl } from "../../lib/api";

interface SidebarProps {
  rooms: Room[];
  categories: RoomCategory[];
  dmRooms: Room[];
  onHideDM: (roomId: string) => void;
  activeRoom: Room | null;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (name: string, type: "text" | "voice", categoryId?: string) => void;
  onCreateCategory: (name: string) => void;
  onRenameRoom: (roomId: string, name: string) => void;
  onRenameCategory: (categoryId: string, name: string) => void;
  onDeleteRoom: (roomId: string) => void;
  onDeleteCategory: (categoryId: string) => void;
  onUpdateLayout: (payload: {
    categories: Array<{ id: string; position: number; enforceTypeOrder: boolean }>;
    rooms: Array<{ id: string; categoryId: string; position: number }>;
  }) => void;
  username: string;
  status: "online" | "offline" | "away" | "dnd";
  avatarUrl: string;
  onChangeStatus: (status: "online" | "offline" | "away" | "dnd") => void;
  voiceParticipants: Record<
    string,
    Array<{ id: string; name: string; isSpeaking: boolean }>
  >;
  onOpenSettings: () => void;
  onOpenAccessManager: () => void;
  onSignOut: () => void;
  voiceControls: VoiceControls | null;
  unreadByRoom: Record<string, number>;
  mentionByRoom: Record<string, number>;
  serverName: string;
  serverProfiles: Array<{ url: string; name: string }>;
  activeServerUrl: string;
  onSwitchServer: (url: string) => void;
  onAddServer: (url: string) => void;
  onRemoveServer: (url: string) => void;
  onSignOutServer: (url: string) => void;
  serverHasTokenByUrl: Record<string, boolean>;
  serverUnreadByUrl: Record<string, number>;
  isServerConnected: boolean;
  isServerReconnecting: boolean;
  serverMaintenanceMode: boolean;
  canCreateRooms: boolean;
  canManageChannels: boolean;
  canManageRoles: boolean;
  onVoiceParticipantContextMenu?: (participantId: string, x: number, y: number) => void;
  onStartGroupDM?: (room: Room) => void;
}

export default function Sidebar({
  rooms,
  categories,
  dmRooms,
  onHideDM,
  activeRoom,
  onSelectRoom,
  onCreateRoom,
  onCreateCategory,
  onRenameRoom,
  onRenameCategory,
  onDeleteRoom,
  onDeleteCategory,
  onUpdateLayout,
  username,
  status,
  avatarUrl,
  onChangeStatus,
  voiceParticipants,
  onOpenSettings,
  onOpenAccessManager,
  onSignOut,
  voiceControls,
  unreadByRoom,
  mentionByRoom,
  serverName,
  serverProfiles,
  activeServerUrl,
  onSwitchServer,
  onAddServer,
  onRemoveServer,
  onSignOutServer,
  serverHasTokenByUrl,
  serverUnreadByUrl,
  isServerConnected,
  isServerReconnecting,
  serverMaintenanceMode,
  canCreateRooms,
  canManageChannels,
  canManageRoles,
  onVoiceParticipantContextMenu,
  onStartGroupDM,
}: SidebarProps) {
  type SidebarContextMenu = {
    x: number;
    y: number;
    scope: "sidebar" | "category" | "room" | "server" | "server-bar";
    categoryId?: string;
    serverUrl?: string;
    renameKind?: "room" | "category";
    renameId?: string;
    renameName?: string;
  };

  const [newRoomName, setNewRoomName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createEntity, setCreateEntity] = useState<"channel" | "category">("channel");
  const [createType, setCreateType] = useState<"text" | "voice">("text");
  const [createCategoryId, setCreateCategoryId] = useState("default");
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameTarget, setRenameTarget] = useState<{
    kind: "room" | "category";
    id: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "room" | "category";
    id: string;
    name: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const [showSharePicker, setShowSharePicker] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [addServerUrl, setAddServerUrl] = useState("");
  const [addServerError, setAddServerError] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});
  const [expandingCategories, setExpandingCategories] = useState<Record<string, boolean>>({});
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [devicePickerError, setDevicePickerError] = useState<string | null>(null);
  const [shareRes, setShareRes] = useState("1080p");
  const [shareFps, setShareFps] = useState(30);
  const sharePickerRef = useRef<HTMLDivElement>(null);
  const [pickerLimits, setPickerLimits] = useState<{
    maxScreenShareResolution: string;
    maxScreenShareFps: number;
  } | null>(null);
  const [pickerPos, setPickerPos] = useState<{ bottom: number; left: number }>({
    bottom: 0,
    left: 0,
  });
  const [draggedRoomId, setDraggedRoomId] = useState<string | null>(null);
  const [draggedCategoryId, setDraggedCategoryId] = useState<string | null>(null);
  type DropIndicator =
    | { type: "room"; id: string; position: "before" | "after"; categoryId: string }
    | { type: "room-end"; categoryId: string }
    | { type: "category"; id: string; position: "before" | "after" }
    | null;
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);
  const [dmContextMenu, setDmContextMenu] = useState<{ x: number; y: number; room: Room } | null>(null);
  const dmContextMenuRef = useRef<HTMLDivElement | null>(null);
  const roomsListRef = useRef<HTMLDivElement | null>(null);
  const [activeRoomPill, setActiveRoomPill] = useState({
    top: 0,
    height: 0,
    visible: false,
  });
  const draggedRoomIdRef = useRef<string | null>(null);
  const draggedCategoryIdRef = useRef<string | null>(null);
  const draggedRoomCandidateIdRef = useRef<string | null>(null);
  const draggedCategoryCandidateIdRef = useRef<string | null>(null);
  const lastCategoryDragAtRef = useRef(0);
  const CONTEXT_MENU_MARGIN = 8;
  const ROOM_DRAG_MIME = "application/x-chitchat-room";
  const CATEGORY_DRAG_MIME = "application/x-chitchat-category";

  const channelRooms = rooms.filter((r) => r.type === "text" || r.type === "voice");
  const canReorderLayout = canManageChannels;

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

  // Close picker when clicking outside
  useEffect(() => {
    if (!showSharePicker) return;
    function handleClick(e: MouseEvent) {
      if (sharePickerRef.current && !sharePickerRef.current.contains(e.target as Node)) {
        setShowSharePicker(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showSharePicker]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(event: MouseEvent) {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(event.target as Node)
      ) {
        setContextMenu(null);
      }
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", onEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!dmContextMenu) return;
    function handleClick(event: MouseEvent) {
      if (!dmContextMenuRef.current?.contains(event.target as Node)) setDmContextMenu(null);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setDmContextMenu(null);
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", onEscape);
    };
  }, [dmContextMenu]);

  useEffect(() => {
    if (!showStatusMenu) return;
    function handleClick(event: MouseEvent) {
      if (statusMenuRef.current?.contains(event.target as Node)) return;
      setShowStatusMenu(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setShowStatusMenu(false);
    }
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", onEscape);
    };
  }, [showStatusMenu]);

  useEffect(() => {
    function clearDragCandidates() {
      draggedRoomCandidateIdRef.current = null;
      draggedCategoryCandidateIdRef.current = null;
    }
    window.addEventListener("mouseup", clearDragCandidates);
    window.addEventListener("dragend", clearDragCandidates);
    return () => {
      window.removeEventListener("mouseup", clearDragCandidates);
      window.removeEventListener("dragend", clearDragCandidates);
    };
  }, []);

  // Prevent "no-drop" cursor flash when the cursor briefly passes over an element
  // that doesn't have its own dragover handler (e.g. gaps between room wrappers).
  useEffect(() => {
    function handleGlobalDragOver(e: DragEvent) {
      if (!draggedRoomIdRef.current && !draggedCategoryIdRef.current) return;
      e.preventDefault();
    }
    document.addEventListener("dragover", handleGlobalDragOver);
    return () => document.removeEventListener("dragover", handleGlobalDragOver);
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - CONTEXT_MENU_MARGIN;
    const maxY = window.innerHeight - CONTEXT_MENU_MARGIN;
    let nextX = contextMenu.x;
    let nextY = contextMenu.y;
    if (rect.right > maxX) nextX -= rect.right - maxX;
    if (rect.bottom > maxY) nextY -= rect.bottom - maxY;
    if (rect.left < CONTEXT_MENU_MARGIN) nextX += CONTEXT_MENU_MARGIN - rect.left;
    if (rect.top < CONTEXT_MENU_MARGIN) nextY += CONTEXT_MENU_MARGIN - rect.top;
    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((prev) =>
        prev ? { ...prev, x: nextX, y: nextY } : prev
      );
    }
  }, [contextMenu]);

  // Close picker if sharing starts or voice disconnects
  useEffect(() => {
    if (!voiceControls || voiceControls.isScreenSharing) {
      setShowSharePicker(false);
    }
  }, [voiceControls?.isScreenSharing, voiceControls]);

  // Load quick device picker options when voice controls are available
  useEffect(() => {
    if (!voiceControls) return;
    let cancelled = false;

    async function primeMediaPermissions() {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Keep going; we'll still show any devices that are available.
      }
    }

    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let audioIn = devices.filter((d) => d.kind === "audioinput");
        let audioOut = devices.filter((d) => d.kind === "audiooutput");

        if (
          (audioIn.length <= 1 || audioOut.length <= 1) &&
          typeof navigator.mediaDevices?.getUserMedia === "function"
        ) {
          await primeMediaPermissions();
          devices = await navigator.mediaDevices.enumerateDevices();
          audioIn = devices.filter((d) => d.kind === "audioinput");
          audioOut = devices.filter((d) => d.kind === "audiooutput");
        }

        if (cancelled) return;
        setAudioInputs(audioIn);
        setAudioOutputs(audioOut);
        if (audioIn.length <= 1 && audioOut.length <= 1) {
          setDevicePickerError("Only default devices are currently available.");
        } else {
          setDevicePickerError(null);
        }
      } catch (err) {
        if (cancelled) return;
        setDevicePickerError(
          err instanceof Error ? err.message : "Unable to load devices"
        );
      }
    }

    void loadDevices();
    function onDeviceChange() {
      void loadDevices();
    }
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, [Boolean(voiceControls)]);

  const statusMap: Record<string, { label: string; color: string }> = {
    online: { label: "Online", color: "var(--success)" },
    away: { label: "Away", color: "#f59e0b" },
    dnd: { label: "Do not disturb", color: "var(--danger)" },
    offline: { label: "Offline", color: "var(--text-muted)" },
  };

  const currentStatus = statusMap[status] || statusMap.online;
  const statusOptions = (["online", "away", "dnd", "offline"] as const).map(
    (value) => ({
      value,
      ...statusMap[value],
    })
  );
  const serverStatusLabel = serverMaintenanceMode
    ? "Maintenance mode"
    : isServerConnected
      ? "Connected"
      : isServerReconnecting
        ? "Reconnecting..."
        : "Disconnected";
  const serverStatusClass = serverMaintenanceMode
    ? "warn"
    : isServerConnected
      ? "online"
      : "offline";

  const orderedCategories = (() => {
    if (categories.length > 0) {
      return [...categories].sort((a, b) => a.position - b.position);
    }
    return [
      {
        id: "default",
        name: "Channels",
        position: 0,
        enforce_type_order: 1,
        created_at: new Date(0).toISOString(),
      },
    ] as RoomCategory[];
  })();
  const categoryOrderKey = orderedCategories
    .map((category) => `${category.id}:${category.position}`)
    .join("|");
  const roomOrderKey = channelRooms
    .map((room) => `${room.id}:${room.category_id || "default"}:${room.position ?? 0}`)
    .join("|");
  const dmOrderKey = dmRooms.map((room) => room.id).join("|");

  useEffect(() => {
    if (!showCreate || createEntity !== "channel") return;
    if (orderedCategories.some((category) => category.id === createCategoryId)) return;
    setCreateCategoryId(orderedCategories[0]?.id || "default");
  }, [showCreate, createEntity, createCategoryId, orderedCategories]);

  function sortRoomsForCategory(cat: RoomCategory, categoryRooms: Room[]) {
    const enforce = cat.enforce_type_order === 1;
    return [...categoryRooms].sort((a, b) => {
      if (enforce) {
        const aRank = a.type === "text" ? 0 : 1;
        const bRank = b.type === "text" ? 0 : 1;
        if (aRank !== bRank) return aRank - bRank;
      }
      return (a.position ?? 0) - (b.position ?? 0);
    });
  }

  function getCategoryRooms(categoryId: string, allRooms: Room[] = channelRooms) {
    return allRooms.filter((room) => (room.category_id || "default") === categoryId);
  }

  function updateLayoutAfterMove(
    movingRoomId: string,
    targetCategoryId: string,
    targetIndex: number
  ) {
    const movingRoom = channelRooms.find((room) => room.id === movingRoomId);
    if (!movingRoom) return;

    const nextCategories = orderedCategories.map((cat) => ({ ...cat }));
    const roomByCategory = new Map<string, Room[]>();

    for (const category of orderedCategories) {
      roomByCategory.set(
        category.id,
        sortRoomsForCategory(category, getCategoryRooms(category.id))
      );
    }

    for (const [categoryId, list] of roomByCategory.entries()) {
      const idx = list.findIndex((room) => room.id === movingRoomId);
      if (idx !== -1) {
        list.splice(idx, 1);
        roomByCategory.set(categoryId, list);
      }
    }

    const targetList = roomByCategory.get(targetCategoryId) || [];
    const safeIndex = Math.max(0, Math.min(targetIndex, targetList.length));
    targetList.splice(safeIndex, 0, { ...movingRoom, category_id: targetCategoryId });
    roomByCategory.set(targetCategoryId, targetList);

    const targetCategory = nextCategories.find((cat) => cat.id === targetCategoryId);
    if (targetCategory && targetCategory.enforce_type_order === 1) {
      let seenVoice = false;
      let violatesDefaultOrder = false;
      for (const room of targetList) {
        if (room.type === "voice") seenVoice = true;
        if (room.type === "text" && seenVoice) {
          violatesDefaultOrder = true;
          break;
        }
      }
      if (violatesDefaultOrder) {
        targetCategory.enforce_type_order = 0;
      }
    }

    onUpdateLayout({
      categories: nextCategories.map((cat, index) => ({
        id: cat.id,
        position: index,
        enforceTypeOrder: cat.enforce_type_order === 1,
      })),
      rooms: nextCategories.flatMap((cat) =>
        (roomByCategory.get(cat.id) || []).map((room, index) => ({
          id: room.id,
          categoryId: cat.id,
          position: index,
        }))
      ),
    });
  }

  function updateCategoryOrderAfterMove(
    movingCategoryId: string,
    targetCategoryId?: string,
    insertAfter?: boolean
  ) {
    const nextCategories = orderedCategories.map((cat) => ({ ...cat }));
    const movingIndex = nextCategories.findIndex((cat) => cat.id === movingCategoryId);
    if (movingIndex === -1) return;

    const [movingCategory] = nextCategories.splice(movingIndex, 1);
    if (!movingCategory) return;

    if (!targetCategoryId) {
      nextCategories.push(movingCategory);
    } else {
      const targetIndex = nextCategories.findIndex((cat) => cat.id === targetCategoryId);
      if (targetIndex === -1) {
        nextCategories.push(movingCategory);
      } else {
        nextCategories.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, movingCategory);
      }
    }

    onUpdateLayout({
      categories: nextCategories.map((cat, index) => ({
        id: cat.id,
        position: index,
        enforceTypeOrder: cat.enforce_type_order === 1,
      })),
      rooms: nextCategories.flatMap((cat) =>
        sortRoomsForCategory(cat, getCategoryRooms(cat.id)).map((room, index) => ({
          id: room.id,
          categoryId: cat.id,
          position: index,
        }))
      ),
    });
  }

  function getDraggedRoomId(dataTransfer: DataTransfer) {
    const typed = dataTransfer.getData(ROOM_DRAG_MIME);
    if (typed) return typed;
    const plain = dataTransfer.getData("text/plain");
    if (plain.startsWith("room:")) return plain.slice(5);
    return null;
  }

  function getDraggedCategoryId(dataTransfer: DataTransfer) {
    const typed = dataTransfer.getData(CATEGORY_DRAG_MIME);
    if (typed) return typed;
    const plain = dataTransfer.getData("text/plain");
    if (plain.startsWith("category:")) return plain.slice(9);
    return null;
  }

  function getCurrentDraggedRoomId(dataTransfer?: DataTransfer | null) {
    if (dataTransfer) {
      const fromData = getDraggedRoomId(dataTransfer);
      if (fromData) return fromData;
    }
    return (
      draggedRoomIdRef.current ||
      draggedRoomCandidateIdRef.current ||
      draggedRoomId
    );
  }

  function getCurrentDraggedCategoryId(dataTransfer?: DataTransfer | null) {
    if (dataTransfer) {
      const fromData = getDraggedCategoryId(dataTransfer);
      if (fromData) return fromData;
    }
    return (
      draggedCategoryIdRef.current ||
      draggedCategoryCandidateIdRef.current ||
      draggedCategoryId
    );
  }

  function resetDragState() {
    draggedRoomIdRef.current = null;
    draggedCategoryIdRef.current = null;
    draggedRoomCandidateIdRef.current = null;
    draggedCategoryCandidateIdRef.current = null;
    setDraggedRoomId(null);
    setDraggedCategoryId(null);
    setDropIndicator(null);
  }

  // Fetch fresh media limits from server and position the popover
  const openSharePicker = useCallback(async () => {
    // Calculate fixed position from the anchor ref
    if (sharePickerRef.current) {
      const rect = sharePickerRef.current.getBoundingClientRect();
      setPickerPos({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
      });
    }

    // Fetch fresh limits from public server info
    try {
      const res = await fetch(`${getServerUrl()}/api/server/info`);
      if (res.ok) {
        const data = await res.json();
        if (data.mediaLimits) {
          setPickerLimits({
            maxScreenShareResolution: data.mediaLimits.maxScreenShareResolution,
            maxScreenShareFps: data.mediaLimits.maxScreenShareFps,
          });
        }
      }
    } catch {
      // Fall back to voice controls limits
    }

    setShowSharePicker(true);
  }, []);

  // Use freshly-fetched limits when available, otherwise fall back to token-time limits
  const activeLimits = pickerLimits || voiceControls?.mediaLimits;

  function getSafeCreateCategoryId(requested?: string) {
    const fallback = orderedCategories[0]?.id || "default";
    if (!requested) return fallback;
    return orderedCategories.some((category) => category.id === requested)
      ? requested
      : fallback;
  }

  function openCreateModal(options?: {
    entity?: "channel" | "category";
    type?: "text" | "voice";
    categoryId?: string;
  }) {
    setCreateEntity(options?.entity || "channel");
    setCreateType(options?.type || "text");
    setCreateCategoryId(getSafeCreateCategoryId(options?.categoryId));
    setContextMenu(null);
    setShowCreate(true);
  }

  function closeCreateModal() {
    setShowCreate(false);
    setNewRoomName("");
    setCreateEntity("channel");
    setCreateType("text");
    setCreateCategoryId(getSafeCreateCategoryId());
  }

  function openAddServerModal() {
    setContextMenu(null);
    setAddServerUrl("");
    setAddServerError("");
    setShowAddServer(true);
  }

  function closeAddServerModal() {
    setShowAddServer(false);
    setAddServerUrl("");
    setAddServerError("");
  }

  function submitAddServer() {
    const normalized = addServerUrl.trim().replace(/\/+$/, "");
    if (!normalized) {
      setAddServerError("Server address is required.");
      return;
    }
    onAddServer(normalized);
    closeAddServerModal();
  }

  function handleCreate() {
    const trimmed = newRoomName.trim();
    if (!trimmed) return;
    if (createEntity === "category") {
      if (!canManageChannels) return;
      onCreateCategory(trimmed);
      closeCreateModal();
      return;
    }
    onCreateRoom(trimmed, createType, createCategoryId);
    closeCreateModal();
  }

  function openRenameFromContextMenu() {
    if (
      !contextMenu ||
      !contextMenu.renameKind ||
      !contextMenu.renameId ||
      !contextMenu.renameName
    ) {
      return;
    }
    setRenameTarget({ kind: contextMenu.renameKind, id: contextMenu.renameId });
    setRenameValue(contextMenu.renameName);
    setShowRename(true);
    setContextMenu(null);
  }

  function openCreateFromContextMenu(type: "text" | "voice") {
    if (!contextMenu || !canCreateRooms) return;
    const categoryFromRoom =
      contextMenu.scope === "room"
        ? channelRooms.find((room) => room.id === contextMenu.renameId)?.category_id || "default"
        : undefined;
    const preferredCategory =
      contextMenu.categoryId || categoryFromRoom || orderedCategories[0]?.id || "default";
    openCreateModal({
      entity: "channel",
      type,
      categoryId: preferredCategory,
    });
  }

  function closeRenameModal() {
    setShowRename(false);
    setRenameValue("");
    setRenameTarget(null);
  }

  function submitRename() {
    const trimmed = renameValue.trim();
    if (!renameTarget || !trimmed) return;
    if (renameTarget.kind === "room") {
      onRenameRoom(renameTarget.id, trimmed);
    } else {
      onRenameCategory(renameTarget.id, trimmed);
    }
    closeRenameModal();
  }

  function openDeleteFromContextMenu() {
    if (
      !contextMenu ||
      !contextMenu.renameKind ||
      !contextMenu.renameId ||
      !contextMenu.renameName
    ) {
      return;
    }
    if (contextMenu.renameKind === "category" && contextMenu.renameId === "default") {
      setContextMenu(null);
      return;
    }
    setDeleteTarget({
      kind: contextMenu.renameKind,
      id: contextMenu.renameId,
      name: contextMenu.renameName,
    });
    setContextMenu(null);
  }

  function closeDeleteModal() {
    setDeleteTarget(null);
  }

  function submitDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "room") {
      onDeleteRoom(deleteTarget.id);
    } else {
      onDeleteCategory(deleteTarget.id);
    }
    closeDeleteModal();
  }

  function formatBadgeCount(count: number) {
    if (count > 99) return "99+";
    return String(count);
  }

  function renderRoomBadges(roomId: string) {
    const unread = unreadByRoom[roomId] ?? 0;
    const mentions = mentionByRoom[roomId] ?? 0;
    if (!unread && !mentions) return null;

    return (
      <span className="sidebar-channel-badges">
        {mentions > 0 && (
          <span className="sidebar-channel-badge mention">
            @{formatBadgeCount(mentions)}
          </span>
        )}
        {unread > 0 && (
          <span className="sidebar-channel-badge">
            {formatBadgeCount(unread)}
          </span>
        )}
      </span>
    );
  }

  function labelDevice(device: MediaDeviceInfo, index: number, prefix: string) {
    return device.label || `${prefix} ${index + 1}`;
  }

  function formatServerBadgeCount(count: number) {
    if (count > 99) return "99+";
    return String(count);
  }

  function getServerInitial(name: string, fallbackUrl: string) {
    const trimmedName = name.trim();
    if (trimmedName) return trimmedName.charAt(0).toUpperCase();
    try {
      const parsed = new URL(fallbackUrl);
      return parsed.hostname.charAt(0).toUpperCase();
    } catch {
      return "S";
    }
  }

  const syncActiveRoomPill = useCallback(() => {
    const listEl = roomsListRef.current;
    const currentActiveRoom = activeRoom;
    const activeRoomId = currentActiveRoom?.id;
    if (!listEl || !currentActiveRoom || !activeRoomId) {
      setActiveRoomPill((prev) =>
        prev.visible ? { ...prev, visible: false } : prev
      );
      return;
    }

    if (currentActiveRoom.type !== "dm") {
      const resolvedActiveRoom = channelRooms.find((room) => room.id === activeRoomId);
      const categoryId =
        resolvedActiveRoom?.category_id ||
        currentActiveRoom.category_id ||
        "default";
      if (collapsedCategories[categoryId] || expandingCategories[categoryId]) {
        setActiveRoomPill((prev) =>
          prev.visible ? { ...prev, visible: false } : prev
        );
        return;
      }
    }

    const roomEls = listEl.querySelectorAll<HTMLElement>("[data-room-id]");
    let targetEl: HTMLElement | null = null;
    for (const el of roomEls) {
      if (el.dataset.roomId === activeRoomId) {
        targetEl = el;
        break;
      }
    }

    if (!targetEl) {
      setActiveRoomPill((prev) =>
        prev.visible ? { ...prev, visible: false } : prev
      );
      return;
    }

    const renderedHeight = targetEl.getBoundingClientRect().height;
    if (renderedHeight < 8) {
      setActiveRoomPill((prev) =>
        prev.visible ? { ...prev, visible: false } : prev
      );
      return;
    }

    const nextTop = Math.round(targetEl.offsetTop - listEl.scrollTop);
    const nextHeight = Math.round(targetEl.offsetHeight);
    setActiveRoomPill((prev) => {
      if (
        prev.visible &&
        prev.top === nextTop &&
        prev.height === nextHeight
      ) {
        return prev;
      }
      return {
        top: nextTop,
        height: nextHeight,
        visible: true,
      };
    });
  }, [
    activeRoom,
    channelRooms,
    collapsedCategories,
    expandingCategories,
    draggedRoomId,
    draggedCategoryId,
  ]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(syncActiveRoomPill);
    return () => cancelAnimationFrame(frame);
  }, [
    syncActiveRoomPill,
    collapsedCategories,
    activeRoom?.id,
    rooms.length,
    dmRooms.length,
    draggedRoomId,
    categoryOrderKey,
    roomOrderKey,
    dmOrderKey,
  ]);

  useEffect(() => {
    const listEl = roomsListRef.current;
    if (!listEl) return;
    const onScroll = () => syncActiveRoomPill();
    const onResize = () => syncActiveRoomPill();
    listEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      listEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [syncActiveRoomPill]);

  return (
    <>
      <aside
        className="server-rail"
        aria-label="Servers"
        onContextMenu={(event) => {
          if (!(event.target instanceof HTMLElement)) return;
          if (event.target.closest(".server-rail-item")) return;
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            scope: "server-bar",
          });
        }}
      >
        {serverProfiles.map((server) => {
          const isActive = server.url === activeServerUrl;
          const unread = serverUnreadByUrl[server.url] ?? 0;
          return (
            <button
              key={server.url}
              type="button"
              className={`server-rail-item ${isActive ? "active" : ""}`}
              onClick={() => onSwitchServer(server.url)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  scope: "server",
                  serverUrl: server.url,
                });
              }}
              title={server.name || server.url}
              aria-label={server.name || server.url}
            >
              <span className="server-rail-item-label">
                {getServerInitial(server.name || "", server.url)}
              </span>
              {unread > 0 && (
                <span className="server-rail-badge">
                  {formatServerBadgeCount(unread)}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="server-rail-item server-rail-manage"
          onClick={openAddServerModal}
          title="Add server"
          aria-label="Add server"
        >
          +
        </button>
      </aside>

      <aside className="flex flex-col w-72 h-full sidebar-panel">
        {/* Server header */}
        <div className="sidebar-header">
          <div className="sidebar-header-row">
            <div className="sidebar-server-meta">
              <h1 className="sidebar-header-title heading-font">
                {serverName || "Server"}
              </h1>
              <div className="sidebar-header-subtitle">
                <span className={`sidebar-header-dot ${serverStatusClass}`} />
                <p className="sidebar-header-label">{serverStatusLabel}</p>
              </div>
            </div>
            {canCreateRooms && (
                <button
                  onClick={() =>
                    openCreateModal({
                      entity: "channel",
                      type: "text",
                      categoryId:
                        activeRoom?.type === "text" || activeRoom?.type === "voice"
                          ? activeRoom.category_id || "default"
                          : orderedCategories[0]?.id || "default",
                    })
                  }
                  className="sidebar-create-btn"
                  title="Create"
                >
                  +
                </button>
            )}
          </div>
        </div>

      {/* Create modal */}
      {showCreate && (
        <div
          className="create-modal-backdrop"
          onClick={closeCreateModal}
        >
          <div
            className="create-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="create-modal-title">Create</div>
            <p className="create-modal-subtitle">
              Create a channel or category.
            </p>
            <div className="create-toggle" role="group" aria-label="Create type">
              <button
                type="button"
              className={`create-toggle-option ${
                    createEntity === "channel" ? "active" : ""
                }`}
                onClick={() => setCreateEntity("channel")}
              >
                Channel
              </button>
              {canManageChannels && (
                <button
                  type="button"
                  className={`create-toggle-option ${
                    createEntity === "category" ? "active" : ""
                  }`}
                  onClick={() => setCreateEntity("category")}
                >
                  Category
                </button>
              )}
            </div>
            {createEntity === "channel" && (
              <div className="create-channel-options">
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
                <label className="create-modal-field-label" htmlFor="create-channel-category">
                  Category
                </label>
                <select
                  id="create-channel-category"
                  value={createCategoryId}
                  onChange={(event) => setCreateCategoryId(event.target.value)}
                  className="create-modal-select"
                >
                  {orderedCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <input
              type="text"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder={createEntity === "category" ? "category-name" : "channel-name"}
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
                {createEntity === "category" ? "Create category" : "Create channel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {contextMenu &&
        (contextMenu.scope === "server" ||
          contextMenu.scope === "server-bar" ||
          canCreateRooms ||
          canManageChannels) && (
        <div
          ref={contextMenuRef}
          className="sidebar-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {(contextMenu.scope === "sidebar" ||
            contextMenu.scope === "category" ||
            contextMenu.scope === "room") &&
            canCreateRooms && (
            <>
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={() => openCreateFromContextMenu("text")}
              >
                Create text channel
              </button>
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={() => openCreateFromContextMenu("voice")}
              >
                Create voice channel
              </button>
            </>
          )}
          {(contextMenu.scope === "sidebar" || contextMenu.scope === "category") &&
            canManageChannels &&
            (contextMenu.scope === "sidebar" || contextMenu.scope === "category") && (
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={() => openCreateModal({ entity: "category" })}
              >
                Create category
              </button>
            )}
          {(contextMenu.scope === "room" || contextMenu.scope === "category") &&
            canManageChannels &&
            (contextMenu.renameKind === "category" || contextMenu.renameKind === "room") && (
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={openRenameFromContextMenu}
              >
                {contextMenu.renameKind === "category"
                  ? "Rename category"
                  : "Rename channel"}
              </button>
            )}
          {(contextMenu.scope === "room" || contextMenu.scope === "category") &&
            canManageChannels &&
            (contextMenu.renameKind === "room" ||
              (contextMenu.renameKind === "category" &&
                contextMenu.renameId !== "default")) && (
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={openDeleteFromContextMenu}
              >
                {contextMenu.renameKind === "category"
                  ? "Delete category"
                  : "Delete channel"}
              </button>
            )}
          {(contextMenu.scope === "server" || contextMenu.scope === "server-bar") && (
            <button
              type="button"
              className="sidebar-context-menu-item"
              onClick={() => {
                openAddServerModal();
                setContextMenu(null);
              }}
            >
              Add server
            </button>
          )}
          {contextMenu.scope === "server" &&
            contextMenu.serverUrl &&
            serverHasTokenByUrl[contextMenu.serverUrl] && (
              <button
                type="button"
                className="sidebar-context-menu-item"
                onClick={() => {
                  onSignOutServer(contextMenu.serverUrl!);
                  setContextMenu(null);
                }}
              >
                Log out of server
              </button>
            )}
          {contextMenu.scope === "server" && contextMenu.serverUrl && (
            <button
              type="button"
              className="sidebar-context-menu-item"
              onClick={() => {
                onRemoveServer(contextMenu.serverUrl!);
                setContextMenu(null);
              }}
            >
              Remove server
            </button>
          )}
        </div>
      )}

      {showAddServer && (
        <div className="create-modal-backdrop" onClick={closeAddServerModal}>
          <div className="create-modal" onClick={(e) => e.stopPropagation()}>
            <div className="create-modal-title">Add Server</div>
            <p className="create-modal-subtitle">
              Enter a server address to connect.
            </p>
            <label className="create-modal-field-label" htmlFor="add-server-url">
              Server Address
            </label>
            <input
              id="add-server-url"
              type="text"
              value={addServerUrl}
              onChange={(event) => {
                setAddServerUrl(event.target.value);
                if (addServerError) setAddServerError("");
              }}
              placeholder="https://chat.example.com"
              className="w-full px-3 py-3 mb-2 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg outline-none focus:border-[var(--accent)]"
              autoFocus
            />
            {addServerError && (
              <p className="text-xs text-[var(--danger)] mb-3">{addServerError}</p>
            )}
            <div className="create-modal-actions">
              <button
                type="button"
                onClick={closeAddServerModal}
                className="profile-button secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAddServer}
                className="profile-button"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {showRename && renameTarget && (
        <div className="create-modal-backdrop" onClick={closeRenameModal}>
          <div className="create-modal" onClick={(e) => e.stopPropagation()}>
            <div className="create-modal-title">
              {renameTarget.kind === "category" ? "Rename Category" : "Rename Channel"}
            </div>
            <p className="create-modal-subtitle">
              Enter a new name.
            </p>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-3 py-3 mb-4 text-sm bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg outline-none focus:border-[var(--accent)]"
            />
            <div className="create-modal-actions">
              <button
                type="button"
                onClick={closeRenameModal}
                className="profile-button secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitRename}
                className="profile-button"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="create-modal-backdrop" onClick={closeDeleteModal}>
          <div className="create-modal" onClick={(e) => e.stopPropagation()}>
            <div className="create-modal-title">
              {deleteTarget.kind === "category" ? "Delete Category" : "Delete Channel"}
            </div>
            <p className="create-modal-subtitle">
              This will permanently delete <strong>{deleteTarget.name}</strong>.
            </p>
            <div className="create-modal-actions">
              <button
                type="button"
                onClick={closeDeleteModal}
                className="profile-button secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDelete}
                className="profile-button"
                style={{ background: "var(--danger)" }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Room lists */}
      <div
        className="sidebar-rooms"
        ref={roomsListRef}
        onContextMenu={(event) => {
          if (!canCreateRooms && !canManageChannels) return;
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            scope: "sidebar",
            categoryId: orderedCategories[0]?.id || "default",
          });
        }}
        onDragOver={(event) => {
          if (!canManageChannels || !canReorderLayout) return;
          const movingCategoryId = getCurrentDraggedCategoryId(event.dataTransfer);
          const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
          if (!movingCategoryId && !movingRoomId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!canManageChannels || !canReorderLayout) return;
          const movingCategoryId = getCurrentDraggedCategoryId(event.dataTransfer);
          const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
          if (!movingCategoryId && !movingRoomId) return;
          event.preventDefault();
          if (movingCategoryId) {
            updateCategoryOrderAfterMove(movingCategoryId);
          }
          resetDragState();
        }}
      >
        <motion.div
          className="sidebar-channel-active-pill"
          initial={false}
          animate={{
            y: activeRoomPill.top,
            height: activeRoomPill.height,
            opacity: activeRoomPill.visible ? 1 : 0,
          }}
          transition={{
            type: "spring",
            stiffness: 540,
            damping: 44,
            mass: 0.7,
          }}
        />
        {orderedCategories.map((category) => {
          const categoryRooms = sortRoomsForCategory(
            category,
            getCategoryRooms(category.id)
          );
          const isCollapsed = collapsedCategories[category.id] ?? false;
          const catDropClass =
            dropIndicator?.type === "category" && dropIndicator.id === category.id
              ? dropIndicator.position === "before" ? "category-drop-before" : "category-drop-after"
              : undefined;
          return (
            <div key={category.id} className={catDropClass}>
              <button
                className={`sidebar-section-title heading-font sidebar-section-toggle ${
                  draggedCategoryId === category.id ? "dragging" : ""
                }`}
                draggable={canManageChannels && canReorderLayout}
                onMouseDown={() => {
                  if (!canManageChannels || !canReorderLayout) return;
                  draggedRoomCandidateIdRef.current = null;
                  draggedCategoryCandidateIdRef.current = category.id;
                }}
                onDragStart={(event) => {
                  if (!canManageChannels || !canReorderLayout) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(CATEGORY_DRAG_MIME, category.id);
                  event.dataTransfer.setData("text/plain", `category:${category.id}`);
                  draggedRoomIdRef.current = null;
                  draggedRoomCandidateIdRef.current = null;
                  setDraggedRoomId(null);
                  draggedCategoryIdRef.current = category.id;
                  setDraggedCategoryId(category.id);
                }}
                onDragEnd={() => {
                  resetDragState();
                  lastCategoryDragAtRef.current = Date.now();
                }}
                onDragOver={(event) => {
                  if (!canManageChannels || !canReorderLayout) return;
                  const movingCategoryId = getCurrentDraggedCategoryId(event.dataTransfer);
                  const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                  if (!movingCategoryId && !movingRoomId) return;
                  if (movingCategoryId && movingCategoryId === category.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  if (movingCategoryId) {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const pos = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                    setDropIndicator({ type: "category", id: category.id, position: pos });
                  }
                }}
                onDrop={(event) => {
                  if (!canManageChannels || !canReorderLayout) return;
                  const movingCategoryId = getCurrentDraggedCategoryId(event.dataTransfer);
                  const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                  if (!movingCategoryId && !movingRoomId) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (movingCategoryId && movingCategoryId !== category.id) {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                    const insertAfter = event.clientY >= rect.top + rect.height / 2;
                    updateCategoryOrderAfterMove(movingCategoryId, category.id, insertAfter);
                    resetDragState();
                    return;
                  }
                  if (movingRoomId) {
                    updateLayoutAfterMove(movingRoomId, category.id, categoryRooms.length);
                    resetDragState();
                  }
                }}
                onContextMenu={(event) => {
                  if (!canCreateRooms && !canManageChannels) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    scope: "category",
                    categoryId: category.id,
                    renameKind: "category",
                    renameId: category.id,
                    renameName: category.name,
                  });
                }}
                onClick={() => {
                  if (canReorderLayout && Date.now() - lastCategoryDragAtRef.current < 180) return;
                  const activeCategoryId =
                    (activeRoom && activeRoom.type !== "dm"
                      ? channelRooms.find((room) => room.id === activeRoom.id)?.category_id
                      : null) ||
                    (activeRoom && activeRoom.type !== "dm" ? activeRoom.category_id : null) ||
                    "default";
                  const togglesSelectedRoomCategory =
                    activeRoom?.type !== "dm" && activeCategoryId === category.id;
                  if (togglesSelectedRoomCategory) {
                    setActiveRoomPill((prev) =>
                      prev.visible ? { ...prev, visible: false } : prev
                    );
                  }
                  if (isCollapsed && togglesSelectedRoomCategory) {
                    setExpandingCategories((prev) => ({ ...prev, [category.id]: true }));
                  } else {
                    setExpandingCategories((prev) => {
                      if (!prev[category.id]) return prev;
                      const next = { ...prev };
                      delete next[category.id];
                      return next;
                    });
                  }
                  setCollapsedCategories((prev) => ({
                    ...prev,
                    [category.id]: !isCollapsed,
                  }));
                }}
              >
                <span className="sidebar-section-toggle-label">
                  {category.name} - {categoryRooms.length}
                </span>
                <span className="sidebar-section-toggle-icon" aria-hidden="true">
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div
                    key={`cat-${category.id}`}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    onAnimationComplete={() => {
                      setExpandingCategories((prev) => {
                        if (!prev[category.id]) return prev;
                        const next = { ...prev };
                        delete next[category.id];
                        return next;
                      });
                      syncActiveRoomPill();
                    }}
                    style={{ overflow: "hidden" }}
                    onContextMenu={(event) => {
                      if (!canCreateRooms && !canManageChannels) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        scope: "category",
                        categoryId: category.id,
                      });
                    }}
                    onDragOver={(event) => {
                      if (!canManageChannels || !canReorderLayout) return;
                      const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                      if (!movingRoomId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = "move";
                      setDropIndicator({ type: "room-end", categoryId: category.id });
                    }}
                    onDrop={(event) => {
                      if (!canManageChannels || !canReorderLayout) return;
                      const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                      if (!movingRoomId) return;
                      event.preventDefault();
                      event.stopPropagation();
                      updateLayoutAfterMove(movingRoomId, category.id, categoryRooms.length);
                      resetDragState();
                    }}
                  >
                    {categoryRooms.map((room) => {
                      const isLastRoom = room.id === categoryRooms[categoryRooms.length - 1]?.id;
                      const roomDropClass =
                        dropIndicator?.type === "room" && dropIndicator.id === room.id
                          ? dropIndicator.position === "before" ? "room-drop-before" : "room-drop-after"
                          : dropIndicator?.type === "room-end" && dropIndicator.categoryId === category.id && isLastRoom
                            ? "room-drop-after"
                            : undefined;
                      return (
                      <motion.div
                        key={room.id}
                        className={roomDropClass}
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                        onDragOver={(event) => {
                          if (!canManageChannels || !canReorderLayout) return;
                          const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                          if (!movingRoomId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = "move";
                          if (movingRoomId !== room.id) {
                            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                            const pos = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                            setDropIndicator({ type: "room", id: room.id, position: pos, categoryId: category.id });
                          } else {
                            setDropIndicator(null);
                          }
                        }}
                        onDrop={(event) => {
                          if (!canManageChannels || !canReorderLayout) return;
                          const movingRoomId = getCurrentDraggedRoomId(event.dataTransfer);
                          if (!movingRoomId) return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (movingRoomId === room.id) { resetDragState(); return; }
                          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                          const insertAfter = event.clientY >= rect.top + rect.height / 2;
                          const baseIndex = categoryRooms.findIndex((r) => r.id === room.id);
                          updateLayoutAfterMove(movingRoomId, category.id, insertAfter ? baseIndex + 1 : baseIndex);
                          resetDragState();
                        }}
                      >
                        <button
                          draggable={canManageChannels && canReorderLayout}
                          onMouseDown={() => {
                            if (!canManageChannels || !canReorderLayout) return;
                            draggedCategoryCandidateIdRef.current = null;
                            draggedRoomCandidateIdRef.current = room.id;
                          }}
                          onDragStart={(event) => {
                            if (!canManageChannels || !canReorderLayout) return;
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData(ROOM_DRAG_MIME, room.id);
                            event.dataTransfer.setData("text/plain", `room:${room.id}`);
                            draggedCategoryIdRef.current = null;
                            draggedCategoryCandidateIdRef.current = null;
                            setDraggedCategoryId(null);
                            draggedRoomIdRef.current = room.id;
                            setDraggedRoomId(room.id);
                          }}
                          onDragEnd={() => {
                            resetDragState();
                          }}
                          onClick={() => onSelectRoom(room)}
                          onContextMenu={(event) => {
                            if (!canCreateRooms && !canManageChannels) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              scope: "room",
                              categoryId: room.category_id || "default",
                              renameKind: "room",
                              renameId: room.id,
                              renameName: room.name,
                            });
                          }}
                          className={`sidebar-channel ${
                            activeRoom?.id === room.id ? "active" : ""
                          } ${draggedRoomId === room.id ? "dragging" : ""}`}
                          title={room.name}
                          data-room-id={room.id}
                        >
                          <span className="sidebar-channel-main">
                            <span className="sidebar-channel-icon" aria-hidden="true">
                              {room.type === "voice" ? (
                                <Volume2 size={14} />
                              ) : (
                                <MessageSquare size={14} />
                              )}
                            </span>
                            <span className="sidebar-channel-main-text">
                              {room.name}
                            </span>
                            {room.type === "voice" && (
                              <span className="sidebar-voice-count">
                                {voiceParticipants[room.id]?.length ?? 0}
                              </span>
                            )}
                          </span>
                          {renderRoomBadges(room.id)}
                        </button>
                        {room.type === "voice" &&
                        (voiceParticipants[room.id]?.length ||
                          leavingParticipants[room.id]?.length) ? (
                          <div className="sidebar-voice-participants">
                            {voiceParticipants[room.id]?.map((participant) => (
                              <div
                                key={`${room.id}-${participant.id}`}
                                className={`sidebar-voice-participant ${
                                  participant.isSpeaking ? "speaking" : ""
                                }`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onVoiceParticipantContextMenu?.(participant.id, e.clientX, e.clientY);
                                }}
                              >
                                <span className="sidebar-voice-dot" />
                                <span className="sidebar-voice-name">
                                  {participant.name}
                                </span>
                                {participant.isSpeaking && (
                                  <Mic size={12} className="sidebar-voice-speaking-icon" />
                                )}
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
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {/* Direct Messages */}
        {dmRooms.length > 0 && (
          <>
            <div className="sidebar-section-title heading-font">Direct Messages</div>
            <AnimatePresence initial={false}>
              {dmRooms.map((dm) => {
                const isGroup = (dm.other_members?.length ?? 0) > 1;
                const displayName = isGroup
                  ? (dm.other_members ?? []).map((m) => m.username).join(", ")
                  : (dm.other_username || "Unknown User");
                const avatarUrl = isGroup ? null : dm.other_avatar_url;
                return (
                  <motion.div
                    key={dm.id}
                    layout
                    initial={{ opacity: 0, x: -20, height: 0 }}
                    animate={{ opacity: 1, x: 0, height: "auto" }}
                    exit={{ opacity: 0, x: -20, height: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className={`sidebar-channel sidebar-dm-row ${
                      activeRoom?.id === dm.id ? "active" : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    data-room-id={dm.id}
                    onClick={() => onSelectRoom(dm)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectRoom(dm);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setDmContextMenu({ x: event.clientX, y: event.clientY, room: dm });
                    }}
                    title={displayName}
                  >
                    <div className="sidebar-dm-open">
                      <span className="sidebar-channel-main">
                        <span className={`sidebar-dm-avatar ${isGroup ? "sidebar-dm-avatar-group" : ""}`}>
                          {isGroup ? (
                            <span className="sidebar-dm-group-icon">👥</span>
                          ) : avatarUrl ? (
                            <img src={avatarUrl} alt="" />
                          ) : (
                            displayName.charAt(0).toUpperCase()
                          )}
                        </span>
                        <span className="sidebar-channel-main-text">
                          {displayName}
                        </span>
                      </span>
                      {renderRoomBadges(dm.id)}
                    </div>
                    <button
                      type="button"
                      className="sidebar-dm-hide"
                      title={`Hide DM`}
                      aria-label={`Hide DM`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onHideDM(dm.id);
                      }}
                    >
                      <span aria-hidden="true">x</span>
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </>
        )}
      </div>

      {/* Voice controls (when connected) */}
      {voiceControls && (
        <div className="sidebar-voice-controls">
          <div className="sidebar-voice-controls-label">
            {voiceControls.isConnected ? "Voice Connected" : "Voice Connecting..."}
          </div>
          <div className="sidebar-voice-controls-buttons">
            <button
              onClick={voiceControls.toggleMute}
              disabled={!voiceControls.isConnected}
              className={`sidebar-vc-btn ${voiceControls.isMuted ? "active" : ""}`}
              title={voiceControls.isMuted ? "Unmute" : "Mute"}
            >
              {voiceControls.isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleDeafen}
              disabled={!voiceControls.isConnected}
              className={`sidebar-vc-btn ${voiceControls.isDeafened ? "active" : ""}`}
              title={voiceControls.isDeafened ? "Undeafen" : "Deafen"}
            >
              {voiceControls.isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleVideo}
              disabled={!voiceControls.isConnected}
              className={`sidebar-vc-btn ${voiceControls.isCameraOn ? "active" : ""}`}
              title={voiceControls.isCameraOn ? "Turn off camera" : "Turn on camera"}
            >
              {voiceControls.isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
            <button
              onClick={voiceControls.toggleNoiseSuppression}
              disabled={!voiceControls.isConnected}
              className={`sidebar-vc-btn ${voiceControls.isNoiseSuppressionEnabled ? "active" : ""}`}
              title={
                voiceControls.isNoiseSuppressionEnabled
                  ? "Disable noise suppression"
                  : "Enable noise suppression"
              }
            >
              <Wind size={18} />
            </button>
            <div className="share-picker-anchor" ref={sharePickerRef}>
              <button
                onClick={() => {
                  if (!voiceControls.isConnected) return;
                  if (voiceControls.isScreenSharing) {
                    voiceControls.stopScreenShare();
                  } else if (showSharePicker) {
                    setShowSharePicker(false);
                  } else {
                    openSharePicker();
                  }
                }}
                disabled={!voiceControls.isConnected}
                className={`sidebar-vc-btn ${voiceControls.isScreenSharing ? "active" : ""}`}
                title={voiceControls.isScreenSharing ? "Stop sharing" : "Share screen"}
              >
                <MonitorUp size={18} />
              </button>
              {showSharePicker && !voiceControls.isScreenSharing && (
                <div
                  className="share-picker-popover"
                  style={{ bottom: pickerPos.bottom, left: pickerPos.left }}
                >
                  <div className="share-picker-title">Screen Share Quality</div>
                  <label className="share-picker-label">Resolution</label>
                  <select
                    className="share-picker-select"
                    value={shareRes}
                    onChange={(e) => setShareRes(e.target.value)}
                  >
                    {getResolutionsUpTo(activeLimits?.maxScreenShareResolution || "1080p").map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label} ({r.width}x{r.height})
                      </option>
                    ))}
                  </select>
                  <label className="share-picker-label">Frame Rate</label>
                  <select
                    className="share-picker-select"
                    value={shareFps}
                    onChange={(e) => setShareFps(parseInt(e.target.value, 10))}
                  >
                    {getFpsUpTo(activeLimits?.maxScreenShareFps || 30).map((fps) => (
                      <option key={fps} value={fps}>
                        {fps} fps
                      </option>
                    ))}
                  </select>
                  <button
                    className="share-picker-start"
                    disabled={!voiceControls.isConnected}
                    onClick={() => {
                      setShowSharePicker(false);
                      voiceControls.startScreenShare(shareRes, shareFps);
                    }}
                  >
                    Start Sharing
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="sidebar-device-pickers">
            <select
              className="sidebar-device-select"
              title="Microphone"
              disabled={!voiceControls.isConnected}
              value={voiceControls.audioInputDeviceId}
              onChange={async (e) => {
                try {
                  await voiceControls.setAudioInputDevice(e.target.value);
                  setDevicePickerError(null);
                } catch (err) {
                  setDevicePickerError(
                    err instanceof Error
                      ? err.message
                      : "Unable to switch microphone device"
                  );
                }
              }}
            >
              <option value="">Mic: System default</option>
              {audioInputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {labelDevice(device, index, "Microphone")}
                </option>
              ))}
            </select>
            <select
              className="sidebar-device-select"
              title="Speakers"
              disabled={!voiceControls.isConnected}
              value={voiceControls.audioOutputDeviceId}
              onChange={async (e) => {
                try {
                  await voiceControls.setAudioOutputDevice(e.target.value);
                  setDevicePickerError(null);
                } catch (err) {
                  setDevicePickerError(
                    err instanceof Error
                      ? err.message
                      : "Unable to switch speaker device"
                  );
                }
              }}
            >
              <option value="">Output: System default</option>
              {audioOutputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {labelDevice(device, index, "Output")}
                </option>
              ))}
            </select>
          </div>
          {devicePickerError && (
            <div className="sidebar-device-error">{devicePickerError}</div>
          )}
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
          </div>
          <div
            className="sidebar-user-status-wrap"
            ref={statusMenuRef}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="sidebar-user-status sidebar-user-status-trigger"
              onClick={() => setShowStatusMenu((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={showStatusMenu}
              title={`Status: ${currentStatus.label}`}
            >
              <span
                className="sidebar-user-status-dot"
                style={{ background: currentStatus.color }}
              />
              <ChevronDown
                size={11}
                className={`sidebar-user-status-caret ${showStatusMenu ? "open" : ""}`}
              />
            </button>
            {showStatusMenu && (
              <div className="sidebar-status-menu" role="menu" aria-label="Change status">
                {statusOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={status === option.value}
                    className={`sidebar-status-menu-item ${
                      status === option.value ? "active" : ""
                    }`}
                    onClick={() => {
                      onChangeStatus(option.value);
                      setShowStatusMenu(false);
                    }}
                  >
                    <span
                      className="sidebar-user-status-dot"
                      style={{ background: option.color }}
                    />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {canManageRoles && (
            <button
              onClick={onOpenAccessManager}
              className="sidebar-signout"
              title="Manage roles and permissions"
              style={{ flex: 1 }}
            >
              Access
            </button>
          )}
          <button
            onClick={onSignOut}
            className="sidebar-signout"
            title="Sign out"
            style={{ flex: 1 }}
          >
            Sign out
          </button>
        </div>
      </div>
      </aside>

      {/* DM right-click context menu */}
      {dmContextMenu && (
        <div
          ref={dmContextMenuRef}
          className="sidebar-context-menu"
          style={{ top: dmContextMenu.y, left: dmContextMenu.x, position: "fixed", zIndex: 9999 }}
        >
          {onStartGroupDM && (
            <button
              type="button"
              className="sidebar-context-menu-item"
              onClick={() => { onStartGroupDM(dmContextMenu.room); setDmContextMenu(null); }}
            >
              Start Group DM
            </button>
          )}
          <button
            type="button"
            className="sidebar-context-menu-item"
            onClick={() => { onHideDM(dmContextMenu.room.id); setDmContextMenu(null); }}
          >
            Hide DM
          </button>
        </div>
      )}
    </>
  );
}
