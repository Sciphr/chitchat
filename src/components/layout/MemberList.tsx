import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Mic, ChevronDown, ChevronRight, MessageCircle } from "lucide-react";
import type { Socket } from "socket.io-client";
import type { ServerUser } from "../../types";

interface MemberListProps {
  socket: Socket;
  isConnected: boolean;
  users: ServerUser[];
  voiceParticipants: Record<
    string,
    Array<{ id: string; name: string; isSpeaking: boolean }>
  >;
  currentUserId: string | null;
  onUserClick: (user: ServerUser) => void;
  onViewProfile: (user: ServerUser) => void;
  activeCall: {
    roomId: string;
    ownerUserId: string;
    participantIds: string[];
  } | null;
  onStartCall: (user: ServerUser) => void;
  onAddToCall: (user: ServerUser) => void;
  onRemoveFromCall: (user: ServerUser) => void;
  onEndCall: () => void;
  onLeaveCall: () => void;
  onToggle: () => void;
  canManageRoles: boolean;
  canKickMembers: boolean;
  canBanMembers: boolean;
  canTimeoutMembers: boolean;
  canModerateVoice: boolean;
}

const STATUS_ORDER = ["online", "away", "dnd", "offline"] as const;

const STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  away: "#f59e0b",
  dnd: "var(--danger)",
  offline: "var(--text-muted)",
};

const STATUS_LABELS: Record<string, string> = {
  online: "Online",
  away: "Away",
  dnd: "Do Not Disturb",
  offline: "Offline",
};

function MemberItem({
  user,
  isInVoice,
  isSelf,
  onClick,
  onContextMenu,
}: {
  user: ServerUser;
  isInVoice: boolean;
  isSelf: boolean;
  onClick: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className={`member-item ${isSelf ? "self" : ""}`}
      onClick={isSelf ? undefined : onClick}
      onContextMenu={onContextMenu}
      title={isSelf ? "You" : `Message ${user.username}`}
    >
      <div className="member-avatar">
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" />
        ) : (
          user.username.charAt(0).toUpperCase()
        )}
        <span
          className="member-status-dot"
          style={{ background: STATUS_COLORS[user.status] || STATUS_COLORS.offline }}
        />
      </div>
      <span className="member-meta">
        <span
          className="member-name"
          style={{ color: user.role_color || undefined }}
        >
          {user.username}
        </span>
        {user.activity_game && user.status !== "offline" && (
          <span className="member-activity">Playing {user.activity_game}</span>
        )}
      </span>
      {isInVoice && <Mic size={14} className="member-voice-icon" />}
      {!isSelf && (
        <span
          className="member-quick-dm"
          role="button"
          aria-label={`Message ${user.username}`}
          title={`Message ${user.username}`}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          <MessageCircle size={12} />
        </span>
      )}
    </button>
  );
}

export default function MemberList({
  socket,
  isConnected,
  users,
  voiceParticipants,
  currentUserId,
  onUserClick,
  onViewProfile,
  activeCall,
  onStartCall,
  onAddToCall,
  onRemoveFromCall,
  onEndCall,
  onLeaveCall,
  onToggle,
  canManageRoles,
  canKickMembers,
  canBanMembers,
  canTimeoutMembers,
  canModerateVoice,
}: MemberListProps) {
  type RoleSummary = {
    id: string;
    name: string;
    color: string;
    position: number;
    is_system: number;
  };
  const [offlineCollapsed, setOfflineCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    user: ServerUser;
    isSelf: boolean;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const CONTEXT_MENU_MARGIN = 8;
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [userRoles, setUserRoles] = useState<Record<string, string[]>>({});
  const [roleBusy, setRoleBusy] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string>("");
  const [moderationBusy, setModerationBusy] = useState(false);
  const [moderationError, setModerationError] = useState("");

  useEffect(() => {
    if (!canManageRoles || !isConnected) return;

    function applyRoleState(payload: {
      roles?: RoleSummary[];
      userRoles?: Record<string, string[]>;
    }) {
      const nextRoles = [...(payload.roles || [])].sort(
        (a, b) => a.position - b.position
      );
      setRoles(nextRoles);
      setUserRoles(payload.userRoles || {});
    }

    socket.emit(
      "roles:get",
      (ack?: {
        ok: boolean;
        error?: string;
        roles?: RoleSummary[];
        userRoles?: Record<string, string[]>;
      }) => {
        if (!ack?.ok) {
          setRoleError(ack?.error || "Could not load role state.");
          return;
        }
        applyRoleState({ roles: ack.roles, userRoles: ack.userRoles });
      }
    );

    function onRoleState(payload: {
      roles: RoleSummary[];
      userRoles: Record<string, string[]>;
    }) {
      applyRoleState(payload);
    }
    socket.on("roles:state", onRoleState);

    return () => {
      socket.off("roles:state", onRoleState);
    };
  }, [canManageRoles, isConnected, socket]);

  function userHasRole(userId: string, roleId: string) {
    return (userRoles[userId] || []).includes(roleId);
  }

  function toggleRoleForUser(targetUserId: string, roleId: string, active: boolean) {
    setRoleBusy(`${targetUserId}:${roleId}`);
    setRoleError("");
    socket.emit(
      "user:role:set",
      { userId: targetUserId, roleId, active },
      (ack?: { ok: boolean; error?: string }) => {
        setRoleBusy(null);
        if (!ack?.ok) {
          setRoleError(ack?.error || "Failed to update role.");
        }
      }
    );
  }

  function runModerationAction(
    targetUserId: string,
    action:
      | "kick"
      | "ban"
      | "unban"
      | "timeout"
      | "clear-timeout"
      | "server-mute"
      | "server-unmute"
      | "server-deafen"
      | "server-undeafen",
    durationMinutes?: number
  ) {
    setModerationBusy(true);
    setModerationError("");
    socket.emit(
      "user:moderation:action",
      { userId: targetUserId, action, durationMinutes },
      (ack?: { ok: boolean; error?: string }) => {
        setModerationBusy(false);
        if (!ack?.ok) {
          setModerationError(ack?.error || "Moderation action failed.");
          return;
        }
        setContextMenu(null);
      }
    );
  }

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - CONTEXT_MENU_MARGIN;
    const maxY = window.innerHeight - CONTEXT_MENU_MARGIN;
    let nextX = contextMenu.x;
    let nextY = contextMenu.y;

    if (rect.right > maxX) {
      nextX -= rect.right - maxX;
    }
    if (rect.bottom > maxY) {
      nextY -= rect.bottom - maxY;
    }
    if (rect.left < CONTEXT_MENU_MARGIN) {
      nextX += CONTEXT_MENU_MARGIN - rect.left;
    }
    if (rect.top < CONTEXT_MENU_MARGIN) {
      nextY += CONTEXT_MENU_MARGIN - rect.top;
    }

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev));
    }
  }, [contextMenu]);

  useEffect(() => {
    function closeMenu(event: MouseEvent) {
      if (!menuRef.current) {
        setContextMenu(null);
        return;
      }
      if (!menuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContextMenu(null);
    }

    function clampOnResize() {
      if (!contextMenu) return;
      setContextMenu((prev) => (prev ? { ...prev } : prev));
    }

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", clampOnResize);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", clampOnResize);
    };
  }, [contextMenu]);

  // Build a set of user IDs currently in any voice channel
  const voiceUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const participants of Object.values(voiceParticipants)) {
      for (const p of participants) {
        ids.add(p.id);
      }
    }
    return ids;
  }, [voiceParticipants]);

  // Group users by status
  const grouped = useMemo(() => {
    const groups: Record<string, ServerUser[]> = {
      online: [],
      away: [],
      dnd: [],
      offline: [],
    };
    for (const user of users) {
      const key = groups[user.status] ? user.status : "offline";
      groups[key].push(user);
    }
    // Sort each group alphabetically
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) =>
        a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
      );
    }
    return groups;
  }, [users]);

  const onlineCount =
    grouped.online.length + grouped.away.length + grouped.dnd.length;
  const isCallOwner = Boolean(
    activeCall && currentUserId && activeCall.ownerUserId === currentUserId
  );
  const submenuOpensLeft = Boolean(
    contextMenu && contextMenu.x > window.innerWidth - 430
  );

  return (
    <aside className="member-list-panel">
      <div className="member-list-header">
        <button
          onClick={onToggle}
          className="member-list-toggle member-list-toggle--inside"
          title="Hide members"
          aria-label="Hide members"
        >
          <ChevronRight size={12} />
        </button>
        <div className="member-list-header-meta">
          <h2 className="heading-font">Members</h2>
          <span className="member-count">{onlineCount} online</span>
        </div>
      </div>

      <div className="member-list-scroll">
        {STATUS_ORDER.map((status) => {
          const group = grouped[status];
          if (group.length === 0) return null;

          const isOffline = status === "offline";

          // Offline section is collapsible
          if (isOffline) {
            return (
              <div key={status}>
                <button
                  className="member-section-title clickable"
                  onClick={() => setOfflineCollapsed((p) => !p)}
                >
                  <span>
                    {STATUS_LABELS[status]} - {group.length}
                  </span>
                  {offlineCollapsed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
                {!offlineCollapsed &&
                  group.map((user) => (
                    <MemberItem
                      key={user.id}
                      user={user}
                      isInVoice={voiceUserIds.has(user.id)}
                      isSelf={user.id === currentUserId}
                      onClick={() => onUserClick(user)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          user,
                          isSelf: user.id === currentUserId,
                        });
                      }}
                    />
                  ))}
              </div>
            );
          }

          return (
            <div key={status}>
              <div className="member-section-title">
                {STATUS_LABELS[status]} - {group.length}
              </div>
              {group.map((user) => (
                <MemberItem
                  key={user.id}
                  user={user}
                  isInVoice={voiceUserIds.has(user.id)}
                  isSelf={user.id === currentUserId}
                  onClick={() => onUserClick(user)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      user,
                      isSelf: user.id === currentUserId,
                    });
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="member-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {!contextMenu.isSelf && (
            <button
              type="button"
              className="member-context-menu-item"
              onClick={() => {
                onUserClick(contextMenu.user);
                setContextMenu(null);
              }}
            >
              Send Direct Message
            </button>
          )}
          {!contextMenu.isSelf && (
            !activeCall ? (
              <button
                type="button"
                className="member-context-menu-item"
                onClick={() => {
                  onStartCall(contextMenu.user);
                  setContextMenu(null);
                }}
              >
                Start Call
              </button>
            ) : activeCall.participantIds.includes(contextMenu.user.id) ? (
              isCallOwner ? (
                <button
                  type="button"
                  className="member-context-menu-item"
                  onClick={() => {
                    onRemoveFromCall(contextMenu.user);
                    setContextMenu(null);
                  }}
                >
                  Remove from Call
                </button>
              ) : null
            ) : isCallOwner ? (
              <button
                type="button"
                className="member-context-menu-item"
                onClick={() => {
                  onAddToCall(contextMenu.user);
                  setContextMenu(null);
                }}
              >
                Add to Call
              </button>
            ) : null
          )}
          {contextMenu.isSelf && activeCall && (
            <button
              type="button"
              className="member-context-menu-item"
              onClick={() => {
                if (isCallOwner) onEndCall();
                else onLeaveCall();
                setContextMenu(null);
              }}
            >
              {isCallOwner ? "End Call" : "Leave Call"}
            </button>
          )}
          <button
            type="button"
            className="member-context-menu-item"
            onClick={() => {
              onViewProfile(contextMenu.user);
              setContextMenu(null);
            }}
          >
            View Profile
          </button>
          {canManageRoles && (
            <div className="member-context-submenu-wrap">
              <button type="button" className="member-context-menu-item member-context-submenu-trigger">
                <span>Assign Roles</span>
                <ChevronRight size={12} />
              </button>
              <div
                className={`member-context-submenu ${
                  submenuOpensLeft ? "open-left" : ""
                }`}
              >
                {roles.length === 0 ? (
                  <div className="member-context-menu-note">Loading roles...</div>
                ) : (
                  roles.map((role) => {
                    const checked =
                      role.id === "everyone" ||
                      userHasRole(contextMenu.user.id, role.id);
                    const disabled = role.id === "everyone";
                    return (
                      <label key={role.id} className="member-context-role-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled || roleBusy === `${contextMenu.user.id}:${role.id}`}
                          onChange={(event) =>
                            toggleRoleForUser(
                              contextMenu.user.id,
                              role.id,
                              event.target.checked
                            )
                          }
                        />
                        <span style={{ color: role.color, fontWeight: 700 }}>{role.name}</span>
                      </label>
                    );
                  })
                )}
                {roleError && (
                  <div className="member-context-menu-note member-context-menu-note-error">
                    {roleError}
                  </div>
                )}
              </div>
            </div>
          )}
          {(canKickMembers || canBanMembers || canTimeoutMembers || canModerateVoice) && !contextMenu.isSelf && (
            <div className="member-context-submenu-wrap">
              <button type="button" className="member-context-menu-item member-context-submenu-trigger">
                <span>Moderation</span>
                <ChevronRight size={12} />
              </button>
              <div
                className={`member-context-submenu ${
                  submenuOpensLeft ? "open-left" : ""
                }`}
              >
                {canKickMembers && (
                  <button
                    type="button"
                    className="member-context-menu-item"
                    disabled={moderationBusy}
                    onClick={() => runModerationAction(contextMenu.user.id, "kick")}
                  >
                    Kick user
                  </button>
                )}
                {canBanMembers && (
                  <button
                    type="button"
                    className="member-context-menu-item"
                    disabled={moderationBusy}
                    onClick={() => runModerationAction(contextMenu.user.id, "ban")}
                  >
                    Ban user
                  </button>
                )}
                {canTimeoutMembers && (
                  <>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "timeout", 10)}
                    >
                      Timeout 10m
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "timeout", 60)}
                    >
                      Timeout 1h
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "timeout", 1440)}
                    >
                      Timeout 1d
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "clear-timeout")}
                    >
                      Clear timeout
                    </button>
                  </>
                )}
                {canModerateVoice && (
                  <>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "server-mute")}
                    >
                      Server mute
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "server-unmute")}
                    >
                      Server unmute
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "server-deafen")}
                    >
                      Server deafen
                    </button>
                    <button
                      type="button"
                      className="member-context-menu-item"
                      disabled={moderationBusy}
                      onClick={() => runModerationAction(contextMenu.user.id, "server-undeafen")}
                    >
                      Server undeafen
                    </button>
                  </>
                )}
                {moderationError && (
                  <div className="member-context-menu-note member-context-menu-note-error">
                    {moderationError}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
