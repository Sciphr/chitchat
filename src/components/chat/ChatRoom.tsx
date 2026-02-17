import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import EmojiPicker, { type EmojiClickData, Theme } from "emoji-picker-react";
import {
  ArrowDownCircle,
  AtSign,
  Bell,
  BellOff,
  CornerUpLeft,
  Download,
  ImageIcon,
  MessageSquare,
  Search,
  SmilePlus,
} from "lucide-react";
import type { Message, MessageAttachment, MessageReaction, Room } from "../../types";
import MessageInput from "./MessageInput";
import type { Socket } from "socket.io-client";
import { getServerUrl, getToken } from "../../lib/api";

interface ChatRoomProps {
  room: Room;
  socket: Socket;
  isConnected: boolean;
  currentUserId: string | null;
  currentUsername: string;
  currentAvatarUrl: string;
  isAdmin: boolean;
  canManageMessages: boolean;
  canPinMessages: boolean;
  canUseEmojis: boolean;
  unreadCount?: number;
  firstUnreadAt?: string;
  onMarkRead?: (roomId: string) => void;
  notificationMode: NotificationMode;
  onNotificationModeChange: (mode: NotificationMode) => void;
  mentionableUsernames: string[];
}

type NotificationMode = "all" | "mentions" | "mute";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveAttachmentUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${getServerUrl()}${url}`;
}

function isInternalAttachmentUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    return new URL(url).origin === new URL(getServerUrl()).origin;
  } catch {
    return false;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Download failed";
}

function getAttachmentMediaKind(attachment: MessageAttachment): "image" | "video" | "other" {
  if (attachment.mime_type.startsWith("image/")) return "image";
  if (attachment.mime_type.startsWith("video/")) return "video";
  const lowerName = attachment.original_name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lowerName)) return "image";
  if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(lowerName)) return "video";
  return "other";
}

async function fetchAttachmentBlob(url: string): Promise<Blob> {
  const token = getToken();
  const resolvedUrl = resolveAttachmentUrl(url);
  const headers: Record<string, string> = {};
  if (isInternalAttachmentUrl(url)) {
    if (!token) throw new Error("Missing auth token");
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(resolvedUrl, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch attachment");
  }
  return res.blob();
}

function getFirstYouTubeEmbedUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/gi);
  if (!match) return null;
  for (const raw of match) {
    try {
      const parsed = new URL(raw);
      if (parsed.hostname.includes("youtu.be")) {
        const id = parsed.pathname.replace("/", "").trim();
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
      if (parsed.hostname.includes("youtube.com")) {
        const id = parsed.searchParams.get("v");
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMessageWithMentions(content: string, currentUsername: string) {
  const mentionPattern = /(@[A-Za-z0-9_.-]+)/g;
  const ownMentionRegex = currentUsername
    ? new RegExp(`^@${escapeRegExp(currentUsername)}$`, "i")
    : null;
  return content.split(mentionPattern).map((part, index) => {
    if (!part.startsWith("@")) {
      return (
        <Fragment key={`text-${index}`}>
          {part}
        </Fragment>
      );
    }
    const isSelf = ownMentionRegex ? ownMentionRegex.test(part) : false;
    return (
      <span
        key={`mention-${index}`}
        className={`chat-inline-mention ${isSelf ? "self" : ""}`}
      >
        {part}
      </span>
    );
  });
}

function AttachmentCard({
  attachment,
  onOpenMedia,
}: {
  attachment: MessageAttachment;
  onOpenMedia: (media: { kind: "image" | "video"; src: string; name: string }) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const mediaKind = getAttachmentMediaKind(attachment);
  const isImage = mediaKind === "image";
  const isVideo = mediaKind === "video";

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    async function loadPreview() {
      if (!isImage && !isVideo) return;
      if (!isInternalAttachmentUrl(attachment.url)) {
        setPreviewUrl(resolveAttachmentUrl(attachment.url));
        return;
      }
      try {
        const blob = await fetchAttachmentBlob(attachment.url);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      } catch (err) {
        if (!active) return;
        setPreviewError(err instanceof Error ? err.message : "Preview unavailable");
      }
    }

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.url, isImage, isVideo]);

  async function handleDownload() {
    setDownloadError(null);
    setDownloadStatus("Preparing download...");
    try {
      const resolvedUrl = resolveAttachmentUrl(attachment.url);
      const isDesktop =
        typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

      if (!isInternalAttachmentUrl(attachment.url)) {
        if (isDesktop) {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(resolvedUrl);
        } else {
          window.open(resolvedUrl, "_blank", "noopener,noreferrer");
        }
        setDownloadStatus("Opened source file");
        window.setTimeout(() => setDownloadStatus(null), 1800);
        return;
      }

      const blob = await fetchAttachmentBlob(attachment.url);

      if (isDesktop) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const selectedPath = await save({
          title: "Save attachment",
          defaultPath: attachment.original_name,
        });
        if (!selectedPath) {
          setDownloadStatus("Download canceled");
          window.setTimeout(() => setDownloadStatus(null), 1200);
          return;
        }
        setDownloadStatus("Downloading...");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await writeFile(selectedPath, bytes);
      } else {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = attachment.original_name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }

      setDownloadStatus("Downloaded");
      window.setTimeout(() => setDownloadStatus(null), 1800);
    } catch (err) {
      const message = getErrorMessage(err);
      console.error("Attachment download failed:", message, err);
      setDownloadError(message);
      setDownloadStatus(null);
    }
  }

  return (
    <div className="chat-attachment-card">
      {isImage ? (
        previewUrl ? (
          <button
            className="chat-attachment-preview-btn"
            onClick={() =>
              onOpenMedia({
                kind: "image",
                src: previewUrl,
                name: attachment.original_name,
              })
            }
            title="Open image"
          >
            <img
              src={previewUrl}
              alt={attachment.original_name}
              className="chat-attachment-image"
            />
          </button>
        ) : (
          <div className="chat-attachment-placeholder">
            <ImageIcon size={14} />
            <span>{previewError ? "Preview unavailable" : "Loading image..."}</span>
          </div>
        )
      ) : isVideo ? (
        previewUrl ? (
          <button
            className="chat-attachment-preview-btn"
            onClick={() =>
              onOpenMedia({
                kind: "video",
                src: previewUrl,
                name: attachment.original_name,
              })
            }
            title="Open video"
          >
            <video
              src={previewUrl}
              className="chat-attachment-image"
              muted
              playsInline
            />
          </button>
        ) : (
          <div className="chat-attachment-placeholder">
            <MessageSquare size={14} />
            <span>{previewError ? "Preview unavailable" : "Loading video..."}</span>
          </div>
        )
      ) : (
        <div className="chat-attachment-placeholder">
          <MessageSquare size={14} />
          <span>File</span>
        </div>
      )}
      <div className="chat-attachment-meta">
        <div className="chat-attachment-name" title={attachment.original_name}>
          {attachment.original_name}
        </div>
        <div className="chat-attachment-size">{formatBytes(attachment.size_bytes)}</div>
      </div>
      <button className="chat-attachment-download" onClick={handleDownload}>
        <Download size={12} />
      </button>
      {downloadStatus && (
        <div className="chat-attachment-status">{downloadStatus}</div>
      )}
      {downloadError && (
        <div className="chat-attachment-error">
          {downloadError}
        </div>
      )}
    </div>
  );
}

export default function ChatRoom({
  room,
  socket,
  isConnected,
  currentUserId,
  currentUsername,
  currentAvatarUrl,
  isAdmin,
  canManageMessages,
  canPinMessages,
  canUseEmojis,
  unreadCount = 0,
  firstUnreadAt,
  onMarkRead,
  notificationMode,
  onNotificationModeChange,
  mentionableUsernames,
}: ChatRoomProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Message | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [mediaPreview, setMediaPreview] = useState<{
    kind: "image" | "video";
    src: string;
    name: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const unreadMarkerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const typingActiveRef = useRef(false);
  const typingStopTimerRef = useRef<number | null>(null);
  const notificationMenuRef = useRef<HTMLDivElement | null>(null);
  const searchPanelRef = useRef<HTMLDivElement | null>(null);
  const messageContextMenuRef = useRef<HTMLDivElement | null>(null);
  const messageItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [pinnedByMessageId, setPinnedByMessageId] = useState<Record<string, boolean>>({});
  const [messageContextMenu, setMessageContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
  } | null>(null);

  const firstUnreadIndex = useMemo(() => {
    if (!firstUnreadAt || unreadCount <= 0) return -1;
    const markerTime = new Date(firstUnreadAt).getTime();
    return messages.findIndex(
      (msg) => new Date(msg.created_at).getTime() >= markerTime,
    );
  }, [messages, firstUnreadAt, unreadCount]);
  const contextMenuMessage = useMemo(() => {
    if (!messageContextMenu) return null;
    return messages.find((msg) => msg.id === messageContextMenu.messageId) || null;
  }, [messageContextMenu, messages]);

  // Auto-scroll to bottom on new messages (only when already near bottom)
  useEffect(() => {
    if (shouldScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Join room and listen for messages
  useEffect(() => {
    if (!isConnected) return;

    socket.emit("room:join", room.id);

    function onMessage(message: Message) {
      shouldScrollRef.current = true;
      setMessages((prev) => {
        if (message.client_nonce) {
          const index = prev.findIndex(
            (msg) => msg.client_nonce === message.client_nonce,
          );
          if (index !== -1) {
            const next = [...prev];
            next[index] = { ...message, pending: false };
            return next;
          }
        }
        return [...prev, message];
      });
    }

    function onHistory({ messages: history, hasMore: more }: { messages: Message[]; hasMore: boolean }) {
      shouldScrollRef.current = true;
      setMessages(history);
      const nextPinned: Record<string, boolean> = {};
      for (const msg of history as Array<Message & { pinned?: unknown }>) {
        if ((msg as any).pinned) nextPinned[msg.id] = true;
      }
      setPinnedByMessageId(nextPinned);
      setHasMore(more);
    }

    function onDeleted({ messageId }: { messageId: string }) {
      setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    }

    function onReactionUpdate({
      messageId,
      reactions,
    }: {
      messageId: string;
      reactions: MessageReaction[];
    }) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                reactions: reactions || [],
              }
            : msg
        )
      );
    }

    function onPinnedUpdate({
      messageId,
      pinned,
    }: {
      messageId: string;
      pinned: boolean;
    }) {
      setPinnedByMessageId((prev) => ({ ...prev, [messageId]: Boolean(pinned) }));
    }

    function onSystemMessage({ content }: { content: string }) {
      shouldScrollRef.current = true;
      const systemMsg: Message = {
        id: `system-${Date.now()}`,
        room_id: room.id,
        user_id: "__system__",
        username: "System",
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, systemMsg]);
    }

    function onTypingStart({
      room_id,
      user_id,
      username,
    }: {
      room_id: string;
      user_id: string;
      username: string;
    }) {
      if (room_id !== room.id) return;
      if (user_id === currentUserId) return;
      setTypingUsers((prev) => ({ ...prev, [user_id]: username || "Someone" }));
    }

    function onTypingStop({
      room_id,
      user_id,
    }: {
      room_id: string;
      user_id: string;
    }) {
      if (room_id !== room.id) return;
      setTypingUsers((prev) => {
        if (!prev[user_id]) return prev;
        const next = { ...prev };
        delete next[user_id];
        return next;
      });
    }

    socket.on("message:new", onMessage);
    socket.on("message:history", onHistory);
    socket.on("message:deleted", onDeleted);
    socket.on("message:reaction:update", onReactionUpdate);
    socket.on("message:pinned:update", onPinnedUpdate);
    socket.on("message:system", onSystemMessage);
    socket.on("typing:start", onTypingStart);
    socket.on("typing:stop", onTypingStop);
    socket.emit(
      "message:pins:get",
      { roomId: room.id },
      (ack?: { ok: boolean; messageIds?: string[] }) => {
        if (!ack?.ok || !Array.isArray(ack.messageIds)) return;
        const next: Record<string, boolean> = {};
        for (const id of ack.messageIds) next[id] = true;
        setPinnedByMessageId(next);
      }
    );

    return () => {
      if (typingActiveRef.current) {
        socket.emit("typing:stop", { roomId: room.id });
      }
      if (typingStopTimerRef.current !== null) {
        window.clearTimeout(typingStopTimerRef.current);
        typingStopTimerRef.current = null;
      }
      typingActiveRef.current = false;
      setTypingUsers({});
      socket.emit("room:leave", room.id);
      socket.off("message:new", onMessage);
      socket.off("message:history", onHistory);
      socket.off("message:deleted", onDeleted);
      socket.off("message:reaction:update", onReactionUpdate);
      socket.off("message:pinned:update", onPinnedUpdate);
      socket.off("message:system", onSystemMessage);
      socket.off("typing:start", onTypingStart);
      socket.off("typing:stop", onTypingStop);
      setMessages([]);
      setPinnedByMessageId({});
      setHasMore(false);
    };
  }, [room.id, isConnected, socket, currentUserId]);

  function handleLoadMore() {
    if (loadingMore || !messages.length) return;
    const oldest = messages[0];
    setLoadingMore(true);
    shouldScrollRef.current = false;

    // Save scroll position so we can restore it after prepending
    const container = chatBodyRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    socket.emit(
      "message:loadMore",
      { roomId: room.id, before: oldest.created_at },
      (ack: { messages: Message[]; hasMore: boolean }) => {
        setMessages((prev) => [...ack.messages, ...prev]);
        setHasMore(ack.hasMore);
        setLoadingMore(false);

        // Restore scroll position after React renders the new messages
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop += newScrollHeight - prevScrollHeight;
          }
        });
      },
    );
  }

  function handleSend(
    content: string,
    attachments: MessageAttachment[] = [],
    retryMessageId?: string
  ) {
    if (!isConnected || !currentUserId) {
      setSendError("Not connected. Try again.");
      return;
    }

    setSendError(null);
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (retryMessageId) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === retryMessageId
            ? {
                ...msg,
                client_nonce: nonce,
                pending: true,
                failed: false,
                error: undefined,
                attachments,
              }
            : msg
        )
      );
    } else {
      const optimistic: Message = {
        id: `temp-${nonce}`,
        room_id: room.id,
        user_id: currentUserId,
        username: currentUsername,
        avatar_url: currentAvatarUrl || undefined,
        reply_to_message_id: replyTo?.id || null,
        reply_to_id: replyTo?.id || null,
        reply_to_username: replyTo?.username || null,
        reply_to_content: replyTo?.content || null,
        content,
        attachments,
        created_at: new Date().toISOString(),
        client_nonce: nonce,
        pending: true,
        failed: false,
      };
      setMessages((prev) => [...prev, optimistic]);
    }

    socket.emit(
      "message:send",
      {
        room_id: room.id,
        content,
        client_nonce: nonce,
        attachment_ids: attachments.map((attachment) => attachment.id),
        reply_to_message_id: replyTo?.id || null,
      },
      (ack?: { ok: boolean; error?: string; message?: Message }) => {
        if (!ack || !ack.ok || !ack.message) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.client_nonce === nonce
                ? {
                    ...msg,
                    pending: false,
                    failed: true,
                    error: ack?.error || "Message failed to send.",
                  }
                : msg
            )
          );
          setSendError(ack?.error || "Message failed to send.");
          return;
        }

        setMessages((prev) => {
          const confirmed: Message = { ...ack.message!, pending: false } as Message;
          const index = prev.findIndex(
            (msg) => msg.client_nonce === nonce,
          );
          if (index === -1) {
            return [...prev, confirmed];
          }
          const next = [...prev];
          next[index] = confirmed;
          return next;
        });
        setReplyTo(null);
      },
    );
  }

  function runSearch() {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    socket.emit(
      "message:search",
      { roomId: room.id, query, limit: 40 },
      (ack?: { ok: boolean; error?: string; messages?: Message[] }) => {
        setSearching(false);
        if (!ack?.ok) {
          setSendError(ack?.error || "Search failed.");
          return;
        }
        setSearchResults(ack.messages || []);
      }
    );
  }

  function jumpToMessage(messageId: string) {
    setSearchOpen(false);
    const target = messageItemRefs.current[messageId];
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleDelete(msg: Message) {
    const isOwnMessage = currentUserId && msg.user_id === currentUserId;

    // Admin deleting someone else's message — show confirmation
    if (!isOwnMessage && isAdmin) {
      setConfirmDelete(msg);
      return;
    }

    // Own message — delete immediately
    doDelete(msg.id);
  }

  function doDelete(messageId: string) {
    socket.emit(
      "message:delete",
      { messageId },
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          setSendError(ack.error || "Failed to delete message.");
        }
      },
    );
    setConfirmDelete(null);
  }

  function handleRetry(msg: Message) {
    if (!msg.content.trim() && (!msg.attachments || msg.attachments.length === 0)) return;
    handleSend(msg.content, msg.attachments || [], msg.id);
  }

  function isAtBottom(el: HTMLDivElement) {
    const threshold = 24;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function handleJumpToUnread() {
    if (firstUnreadIndex >= 0 && unreadMarkerRef.current) {
      unreadMarkerRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (chatBodyRef.current) {
      chatBodyRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
    onMarkRead?.(room.id);
  }

  function handleChatScroll() {
    if (!chatBodyRef.current) return;
    if (unreadCount > 0 && isAtBottom(chatBodyRef.current)) {
      onMarkRead?.(room.id);
    }
  }

  function handleTypingChange(isTyping: boolean) {
    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }

    if (isTyping) {
      if (!typingActiveRef.current) {
        typingActiveRef.current = true;
        socket.emit("typing:start", { roomId: room.id });
      }
      typingStopTimerRef.current = window.setTimeout(() => {
        if (typingActiveRef.current) {
          typingActiveRef.current = false;
          socket.emit("typing:stop", { roomId: room.id });
        }
      }, 2200);
      return;
    }

    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      socket.emit("typing:stop", { roomId: room.id });
    }
  }

  function hasCurrentUserReacted(reaction: MessageReaction) {
    if (!currentUserId) return false;
    return (reaction.user_ids || []).includes(currentUserId);
  }

  function setReaction(messageId: string, emoji: string, active: boolean) {
    socket.emit(
      "message:reaction:set",
      { messageId, emoji, active },
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          setSendError(ack.error || "Failed to update reaction.");
        }
      }
    );
  }

  function toggleReaction(messageId: string, reaction: MessageReaction) {
    const isActive = hasCurrentUserReacted(reaction);
    setReaction(messageId, reaction.emoji, !isActive);
  }

  function addReactionFromPicker(messageId: string, value: EmojiClickData) {
    if (!canUseEmojis) return;
    setReaction(messageId, value.emoji, true);
    setReactionPickerMessageId(null);
  }

  function canDeleteMessage(msg: Message) {
    const isOwnMessage = Boolean(currentUserId && msg.user_id === currentUserId);
    const pending = Boolean(msg.pending);
    const failed = Boolean(msg.failed);
    return (
      !pending &&
      !failed &&
      !msg.id.startsWith("temp-") &&
      (isOwnMessage || isAdmin || canManageMessages)
    );
  }

  function canPinMessage(msg: Message) {
    if (!msg || msg.id.startsWith("temp-")) return false;
    return isAdmin || canPinMessages;
  }

  const typingNames = Object.values(typingUsers);
  const typingLabel =
    typingNames.length === 0
      ? ""
      : typingNames.length === 1
        ? `${typingNames[0]} is typing...`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing...`
          : `${typingNames[0]} and ${typingNames.length - 1} others are typing...`;

  useEffect(() => {
    if (!notificationMenuOpen) return;
    function onDocumentClick(event: MouseEvent) {
      if (
        notificationMenuRef.current &&
        !notificationMenuRef.current.contains(event.target as Node)
      ) {
        setNotificationMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onDocumentClick);
    return () => window.removeEventListener("mousedown", onDocumentClick);
  }, [notificationMenuOpen]);

  useEffect(() => {
    if (!reactionPickerMessageId) return;
    function onDocumentClick(event: MouseEvent) {
      if (
        reactionPickerRef.current &&
        !reactionPickerRef.current.contains(event.target as Node)
      ) {
        setReactionPickerMessageId(null);
      }
    }
    window.addEventListener("mousedown", onDocumentClick);
    return () => window.removeEventListener("mousedown", onDocumentClick);
  }, [reactionPickerMessageId]);

  useLayoutEffect(() => {
    if (!messageContextMenu || !messageContextMenuRef.current) return;
    const rect = messageContextMenuRef.current.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - margin;
    const maxY = window.innerHeight - margin;
    let nextX = messageContextMenu.x;
    let nextY = messageContextMenu.y;
    if (rect.right > maxX) nextX -= rect.right - maxX;
    if (rect.bottom > maxY) nextY -= rect.bottom - maxY;
    if (rect.left < margin) nextX += margin - rect.left;
    if (rect.top < margin) nextY += margin - rect.top;
    if (nextX !== messageContextMenu.x || nextY !== messageContextMenu.y) {
      setMessageContextMenu((prev) =>
        prev ? { ...prev, x: nextX, y: nextY } : prev
      );
    }
  }, [messageContextMenu]);

  useEffect(() => {
    if (!messageContextMenu) return;
    function onDocumentClick(event: MouseEvent) {
      if (
        messageContextMenuRef.current &&
        !messageContextMenuRef.current.contains(event.target as Node)
      ) {
        setMessageContextMenu(null);
      }
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMessageContextMenu(null);
    }
    window.addEventListener("mousedown", onDocumentClick);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onDocumentClick);
      window.removeEventListener("keydown", onEscape);
    };
  }, [messageContextMenu]);

  useEffect(() => {
    setReplyTo(null);
    setSearchQuery("");
    setSearchResults([]);
    setSearchOpen(false);
    setMessageContextMenu(null);
  }, [room.id]);

  useEffect(() => {
    if (!searchOpen) return;
    function onDocumentClick(event: MouseEvent) {
      if (
        searchPanelRef.current &&
        !searchPanelRef.current.contains(event.target as Node)
      ) {
        setSearchOpen(false);
      }
    }
    window.addEventListener("mousedown", onDocumentClick);
    return () => window.removeEventListener("mousedown", onDocumentClick);
  }, [searchOpen]);

  const notificationLabel =
    notificationMode === "mute"
      ? "Muted"
      : notificationMode === "mentions"
      ? "Mentions"
      : "All";

  return (
    <div className="flex flex-col h-full chat-shell">
      {/* Room header */}
      <div className="room-header chat-header">
        {room.type === "dm" ? (
          <>
            <span className="room-header-icon" aria-hidden="true">
              <AtSign size={16} />
            </span>
            <h2 className="room-header-title heading-font">
              {room.other_username || "Direct Message"}
            </h2>
          </>
        ) : (
          <>
            <span className="room-header-icon" aria-hidden="true">
              <MessageSquare size={16} />
            </span>
            <h2 className="room-header-title heading-font">{room.name}</h2>
          </>
        )}
        <div className="room-header-actions">
          <div className="room-header-search" ref={searchPanelRef}>
            <button
              type="button"
              className={`room-header-notify ${searchOpen ? "active" : ""}`}
              onClick={() => setSearchOpen((prev) => !prev)}
              title="Search messages"
            >
              <Search size={14} />
              <span>Search</span>
            </button>
            {searchOpen && (
              <div className="room-header-search-panel">
                <div className="room-header-search-row">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runSearch();
                      }
                    }}
                    placeholder="Search this channel..."
                  />
                  <button type="button" onClick={runSearch} disabled={searching}>
                    {searching ? "..." : "Go"}
                  </button>
                </div>
                <div className="room-header-search-results">
                  {searchResults.length === 0 ? (
                    <div className="room-header-search-empty">
                      {searchQuery.trim().length < 2
                        ? "Type at least 2 characters"
                        : "No matches"}
                    </div>
                  ) : (
                    searchResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        className="room-header-search-result"
                        onClick={() => jumpToMessage(result.id)}
                      >
                        <strong>{result.username}</strong>
                        <span>
                          {result.content.length > 80
                            ? `${result.content.slice(0, 80)}...`
                            : result.content}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="room-header-notifications" ref={notificationMenuRef}>
            <button
              type="button"
              className={`room-header-notify ${notificationMode === "mute" ? "muted" : ""}`}
              onClick={() => setNotificationMenuOpen((prev) => !prev)}
              title={`Notifications: ${notificationLabel}`}
            >
              {notificationMode === "mute" ? <BellOff size={14} /> : <Bell size={14} />}
              <span>{notificationLabel}</span>
            </button>
            {notificationMenuOpen && (
              <div className="room-header-notify-menu">
                <button
                  type="button"
                  className={notificationMode === "all" ? "active" : ""}
                  onClick={() => {
                    onNotificationModeChange("all");
                    setNotificationMenuOpen(false);
                  }}
                >
                  All messages
                </button>
                <button
                  type="button"
                  className={notificationMode === "mentions" ? "active" : ""}
                  onClick={() => {
                    onNotificationModeChange("mentions");
                    setNotificationMenuOpen(false);
                  }}
                >
                  Mentions only
                </button>
                <button
                  type="button"
                  className={notificationMode === "mute" ? "active" : ""}
                  onClick={() => {
                    onNotificationModeChange("mute");
                    setNotificationMenuOpen(false);
                  }}
                >
                  Mute
                </button>
              </div>
            )}
          </div>
          {unreadCount > 0 && (
            <button className="room-header-jump" onClick={handleJumpToUnread}>
              <ArrowDownCircle size={14} />
              <span>Jump to first unread ({unreadCount})</span>
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={chatBodyRef}
        className="flex-1 overflow-y-auto px-10 py-6 space-y-5 bg-[var(--bg-primary)]/20 chat-body"
        onScroll={handleChatScroll}
      >
        {!isConnected && (
          <div className="text-center text-[var(--text-muted)] py-8">
            Connecting to server...
          </div>
        )}
        {isConnected && hasMore && (
          <div className="text-center py-2">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="chat-load-more"
            >
              {loadingMore ? "Loading..." : "Load older messages"}
            </button>
          </div>
        )}
        {isConnected && messages.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-12">
            No messages yet. Start the conversation!
          </div>
        )}
        <AnimatePresence initial={false}>
        {messages.map((msg, index) => {
          const isOwnMessage = Boolean(currentUserId && msg.user_id === currentUserId);
          const displayName = isOwnMessage ? currentUsername : msg.username;
          const displayAvatar = isOwnMessage ? currentAvatarUrl : msg.avatar_url;
          const pending = Boolean(msg.pending);
          const failed = Boolean(msg.failed);
          const canRetry = failed && isOwnMessage;
          const canDelete =
            !pending &&
            !failed &&
            !msg.id.startsWith("temp-") &&
            (isOwnMessage || isAdmin || canManageMessages);
          const isPinned = Boolean(pinnedByMessageId[msg.id]);
          const youtubeEmbedUrl = getFirstYouTubeEmbedUrl(msg.content);

          return (
            <Fragment key={msg.id}>
              {index === firstUnreadIndex && unreadCount > 0 && (
                <div className="chat-unread-divider" ref={unreadMarkerRef}>
                  <span>Unread messages</span>
                </div>
              )}
              <motion.div
                ref={(element) => {
                  messageItemRefs.current[msg.id] = element;
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMessageContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    messageId: msg.id,
                  });
                }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: pending ? 0.7 : 1, y: 0 }}
                exit={{ opacity: 0, x: -30, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className={`flex items-start gap-4 group bg-[var(--bg-secondary)]/80 border border-[var(--border)] rounded-2xl px-5 py-4 shadow-[0_12px_30px_-22px_rgba(0,0,0,0.7)] chat-message${isOwnMessage ? " own" : ""}`}
              >
                <div className="w-10 h-10 rounded-xl bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold shrink-0 mt-0.5">
                  {displayAvatar ? (
                    <img
                      src={displayAvatar}
                      alt={displayName}
                      className="w-full h-full object-cover rounded-xl"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        e.currentTarget.parentElement!.textContent = displayName.charAt(0).toUpperCase();
                      }}
                    />
                  ) : (
                    displayName.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1 chat-message-content">
                  {msg.reply_to_id && (
                    <div className="chat-reply-preview">
                      <strong>{msg.reply_to_username || "Unknown"}</strong>
                      <span>
                        {msg.reply_to_content
                          ? msg.reply_to_content.length > 90
                            ? `${msg.reply_to_content.slice(0, 90)}...`
                            : msg.reply_to_content
                          : "Original message unavailable"}
                      </span>
                    </div>
                  )}
                  <div className="flex items-baseline gap-2">
                    <span
                      className="font-semibold text-sm"
                      style={msg.role_color ? { color: msg.role_color } : undefined}
                    >
                      {displayName}
                    </span>
                    {isOwnMessage && (
                      <span className="chat-message-you-tag">You</span>
                    )}
                    {pending && (
                      <span className="text-[10px] text-[var(--text-muted)]">
                        Sending...
                      </span>
                    )}
                    {failed && (
                      <span className="chat-message-failed">
                        Failed
                      </span>
                    )}
                    <span className="text-xs text-[var(--text-muted)]">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                    {isPinned && (
                      <span className="text-xs text-[var(--text-muted)]">Pinned</span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--text-secondary)] break-words leading-relaxed">
                    {renderMessageWithMentions(msg.content, currentUsername)}
                  </p>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="chat-attachments-list">
                      {msg.attachments.map((attachment) => (
                        <AttachmentCard
                          key={attachment.id}
                          attachment={attachment}
                          onOpenMedia={setMediaPreview}
                        />
                      ))}
                    </div>
                  )}
                  {youtubeEmbedUrl && (
                    <div className="chat-embed">
                      <iframe
                        src={youtubeEmbedUrl}
                        title="Video preview"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                      />
                    </div>
                  )}
                  {(msg.reactions || []).length > 0 && (
                    <div className="chat-reactions-row">
                      {(msg.reactions || []).map((reaction) => (
                        <button
                          key={`${msg.id}-${reaction.emoji}`}
                          type="button"
                          className={`chat-reaction-chip ${
                            hasCurrentUserReacted(reaction) ? "active" : ""
                          }`}
                          disabled={!canUseEmojis}
                          onClick={() => {
                            if (!canUseEmojis) return;
                            toggleReaction(msg.id, reaction);
                          }}
                          title={reaction.user_ids?.length ? `${reaction.user_ids.length} reactions` : "React"}
                        >
                          <span>{reaction.emoji}</span>
                          <span>{reaction.count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div
                    className={`chat-reaction-add-wrap ${
                      reactionPickerMessageId === msg.id ? "open" : ""
                    }`}
                  >
                    {!msg.id.startsWith("temp-") && (
                      <button
                        type="button"
                        className="chat-reaction-add"
                        title="Reply"
                        onClick={() => setReplyTo(msg)}
                      >
                        <CornerUpLeft size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="chat-reaction-add"
                      title="Add reaction"
                      disabled={!canUseEmojis}
                      onClick={() =>
                        setReactionPickerMessageId((prev) =>
                          prev === msg.id ? null : msg.id
                        )
                      }
                    >
                      <SmilePlus size={13} />
                    </button>
                    {reactionPickerMessageId === msg.id && (
                      <div className="chat-reaction-picker" ref={reactionPickerRef}>
                        <EmojiPicker
                          onEmojiClick={(value: EmojiClickData) =>
                            addReactionFromPicker(msg.id, value)
                          }
                          theme={Theme.DARK}
                          skinTonesDisabled
                          lazyLoadEmojis
                        />
                      </div>
                    )}
                  </div>
                </div>
                {canDelete && (
                  <button
                    className="chat-delete-btn"
                    onClick={() => handleDelete(msg)}
                    title="Delete message"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                )}
                {canRetry && (
                  <button
                    className="chat-retry-btn"
                    onClick={() => handleRetry(msg)}
                    title={msg.error || "Retry"}
                  >
                    Retry
                  </button>
                )}
              </motion.div>
            </Fragment>
          );
        })}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      {typingLabel && (
        <div className="chat-typing-indicator">
          {typingLabel}
        </div>
      )}
      <MessageInput
        onSend={(content, attachments) => handleSend(content, attachments || [])}
        onTypingChange={handleTypingChange}
        mentionUsernames={mentionableUsernames}
        replyTo={
          replyTo
            ? {
                username: replyTo.username,
                content: replyTo.content,
              }
            : null
        }
        onCancelReply={() => setReplyTo(null)}
        disabled={!isConnected}
        placeholder={room.type === "dm" ? `Message @${room.other_username || "user"}` : `Message #${room.name}`}
      />
      {sendError && (
        <div className="px-10 pb-4 text-xs text-[var(--danger)]">
          {sendError}
        </div>
      )}
      {messageContextMenu && contextMenuMessage && (
        <div
          ref={messageContextMenuRef}
          className="chat-message-context-menu"
          style={{ top: messageContextMenu.y, left: messageContextMenu.x }}
        >
          <button
            type="button"
            className="chat-message-context-item"
            onClick={() => {
              setReplyTo(contextMenuMessage);
              setMessageContextMenu(null);
            }}
          >
            Reply
          </button>
          <button
            type="button"
            className="chat-message-context-item"
            disabled={!canUseEmojis}
            onClick={() => {
              setReactionPickerMessageId(contextMenuMessage.id);
              setMessageContextMenu(null);
            }}
          >
            React
          </button>
          {canPinMessage(contextMenuMessage) && (
            <button
              type="button"
              className="chat-message-context-item"
              onClick={() => {
                socket.emit(
                  "message:pin:set",
                  {
                    messageId: contextMenuMessage.id,
                    active: !pinnedByMessageId[contextMenuMessage.id],
                  },
                  () => undefined
                );
                setMessageContextMenu(null);
              }}
            >
              {pinnedByMessageId[contextMenuMessage.id] ? "Unpin" : "Pin"}
            </button>
          )}
          {canDeleteMessage(contextMenuMessage) && (
            <button
              type="button"
              className="chat-message-context-item danger"
              onClick={() => {
                handleDelete(contextMenuMessage);
                setMessageContextMenu(null);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {/* Admin delete confirmation modal */}
      {confirmDelete && (
        <div className="chat-confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="chat-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-confirm-title">Delete message?</h3>
            <p className="chat-confirm-text">
              This message was sent by <strong>{confirmDelete.username}</strong>. Are you sure you want to delete it?
            </p>
            <div className="chat-confirm-preview">
              {confirmDelete.content.length > 120
                ? confirmDelete.content.slice(0, 120) + "..."
                : confirmDelete.content}
            </div>
            <div className="chat-confirm-actions">
              <button
                className="chat-confirm-cancel"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="chat-confirm-delete"
                onClick={() => doDelete(confirmDelete.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {mediaPreview && (
        <div
          className="chat-media-overlay"
          onClick={() => setMediaPreview(null)}
        >
          <div
            className="chat-media-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-media-header">
              <span className="chat-media-title">{mediaPreview.name}</span>
              <button
                className="chat-media-close"
                onClick={() => setMediaPreview(null)}
              >
                Close
              </button>
            </div>
            <div className="chat-media-body">
              {mediaPreview.kind === "image" ? (
                <img
                  src={mediaPreview.src}
                  alt={mediaPreview.name}
                  className="chat-media-full"
                />
              ) : (
                <video
                  src={mediaPreview.src}
                  controls
                  autoPlay
                  className="chat-media-full"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
