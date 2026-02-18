import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Room, ServerUser } from "../../types";

type Role = {
  id: string;
  name: string;
  color: string;
  position: number;
  can_manage_channels: number;
  can_manage_roles: number;
  can_manage_server: number;
  can_kick_members: number;
  can_ban_members: number;
  can_timeout_members: number;
  can_moderate_voice: number;
  can_pin_messages: number;
  can_manage_messages: number;
  can_upload_files: number;
  can_use_emojis: number;
  can_start_voice: number;
  is_system: number;
  created_at: string;
};

type PermissionKey =
  | "canManageChannels"
  | "canManageRoles"
  | "canManageServer"
  | "canKickMembers"
  | "canBanMembers"
  | "canTimeoutMembers"
  | "canModerateVoice"
  | "canPinMessages"
  | "canManageMessages"
  | "canUploadFiles"
  | "canUseEmojis"
  | "canStartVoice";

type RoomPermission = {
  roleId: string;
  allowView: boolean;
  allowSend: boolean;
  allowConnect: boolean;
};

type RoleStatePayload = {
  roles: Role[];
  userRoles: Record<string, string[]>;
  roomPermissions: Record<string, RoomPermission[]>;
  userPermissionOverrides?: Record<string, Partial<Record<PermissionKey, boolean>>>;
};

type AccessManagerModalProps = {
  socket: Socket;
  isConnected: boolean;
  users: ServerUser[];
  rooms: Room[];
  canManageRoles: boolean;
  onClose: () => void;
};

function sortRoles(roles: Role[]) {
  return [...roles].sort((a, b) => a.position - b.position);
}

const CAPABILITY_OPTIONS: Array<{
  key: PermissionKey;
  roleField: keyof Role;
  label: string;
}> = [
  { key: "canManageChannels", roleField: "can_manage_channels", label: "Manage channels" },
  { key: "canManageRoles", roleField: "can_manage_roles", label: "Manage roles" },
  { key: "canManageServer", roleField: "can_manage_server", label: "Manage server" },
  { key: "canKickMembers", roleField: "can_kick_members", label: "Kick members" },
  { key: "canBanMembers", roleField: "can_ban_members", label: "Ban members" },
  { key: "canTimeoutMembers", roleField: "can_timeout_members", label: "Timeout members" },
  { key: "canModerateVoice", roleField: "can_moderate_voice", label: "Moderate voice" },
  { key: "canPinMessages", roleField: "can_pin_messages", label: "Pin messages" },
  { key: "canManageMessages", roleField: "can_manage_messages", label: "Manage messages" },
  { key: "canUploadFiles", roleField: "can_upload_files", label: "Upload files" },
  { key: "canUseEmojis", roleField: "can_use_emojis", label: "Use emojis" },
  { key: "canStartVoice", roleField: "can_start_voice", label: "Start/join voice" },
];

const DEFAULT_ROLE_CAPABILITIES: Record<PermissionKey, boolean> = {
  canManageChannels: false,
  canManageRoles: false,
  canManageServer: false,
  canKickMembers: false,
  canBanMembers: false,
  canTimeoutMembers: false,
  canModerateVoice: false,
  canPinMessages: false,
  canManageMessages: false,
  canUploadFiles: true,
  canUseEmojis: true,
  canStartVoice: true,
};

export default function AccessManagerModal({
  socket,
  isConnected,
  users,
  rooms,
  canManageRoles,
  onClose,
}: AccessManagerModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [roles, setRoles] = useState<Role[]>([]);
  const [userRoles, setUserRoles] = useState<Record<string, string[]>>({});
  const [roomPermissions, setRoomPermissions] = useState<
    Record<string, RoomPermission[]>
  >({});
  const [userPermissionOverrides, setUserPermissionOverrides] = useState<
    Record<string, Partial<Record<PermissionKey, boolean>>>
  >({});

  const [activeTab, setActiveTab] = useState<"roles" | "members" | "rooms">(
    "roles"
  );
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleColor, setNewRoleColor] = useState("#94a3b8");
  const [newRoleCapabilities, setNewRoleCapabilities] = useState<
    Record<PermissionKey, boolean>
  >(DEFAULT_ROLE_CAPABILITIES);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [draftRoomPermissions, setDraftRoomPermissions] = useState<
    Record<string, RoomPermission>
  >({});
  const membersListRef = useRef<HTMLDivElement | null>(null);

  const sortedRoles = useMemo(() => sortRoles(roles), [roles]);
  const assignableRoles = useMemo(
    () => sortedRoles.filter((role) => role.id !== "everyone"),
    [sortedRoles]
  );
  const manageableRooms = useMemo(
    () => rooms.filter((room) => room.type === "text" || room.type === "voice"),
    [rooms]
  );

  const selectedUser =
    users.find((entry) => entry.id === selectedUserId) || users[0] || null;
  const selectedRoom =
    manageableRooms.find((entry) => entry.id === selectedRoomId) ||
    manageableRooms[0] ||
    null;
  const selectedRole =
    sortedRoles.find((role) => role.id === selectedRoleId) || sortedRoles[0] || null;

  const applyRoleState = useCallback((payload: RoleStatePayload) => {
    setRoles(sortRoles(payload.roles || []));
    setUserRoles(payload.userRoles || {});
    setRoomPermissions(payload.roomPermissions || {});
    setUserPermissionOverrides(payload.userPermissionOverrides || {});
  }, []);

  const loadRoleState = useCallback(() => {
    if (!isConnected) {
      setError("Not connected to server.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    socket.emit(
      "roles:get",
      (ack?: {
        ok: boolean;
        error?: string;
        roles?: Role[];
        userRoles?: Record<string, string[]>;
        roomPermissions?: Record<string, RoomPermission[]>;
        userPermissionOverrides?: Record<string, Partial<Record<PermissionKey, boolean>>>;
      }) => {
        setLoading(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to load role state.");
          return;
        }
        applyRoleState({
          roles: ack.roles || [],
          userRoles: ack.userRoles || {},
          roomPermissions: ack.roomPermissions || {},
          userPermissionOverrides: ack.userPermissionOverrides || {},
        });
      }
    );
  }, [applyRoleState, isConnected, socket]);

  useEffect(() => {
    if (!canManageRoles) {
      setLoading(false);
      setError("You do not have permission to manage roles.");
      return;
    }
    loadRoleState();
  }, [canManageRoles, loadRoleState]);

  useEffect(() => {
    function onRoleState(payload: RoleStatePayload) {
      applyRoleState(payload);
    }
    socket.on("roles:state", onRoleState);
    return () => {
      socket.off("roles:state", onRoleState);
    };
  }, [applyRoleState, socket]);

  useEffect(() => {
    if (!selectedUserId && users.length > 0) {
      setSelectedUserId(users[0].id);
    }
  }, [users, selectedUserId]);

  useEffect(() => {
    if (!selectedRoomId && manageableRooms.length > 0) {
      setSelectedRoomId(manageableRooms[0].id);
    }
  }, [manageableRooms, selectedRoomId]);

  useEffect(() => {
    if (activeTab !== "members") return;
    if (!membersListRef.current) return;
    membersListRef.current.scrollTop = 0;
  }, [activeTab]);

  useEffect(() => {
    if (selectedRoleId && sortedRoles.some((role) => role.id === selectedRoleId)) {
      return;
    }
    setSelectedRoleId(sortedRoles[0]?.id || "");
  }, [sortedRoles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRoom) return;
    const current = roomPermissions[selectedRoom.id] || [];
    const next: Record<string, RoomPermission> = {};
    for (const row of current) {
      next[row.roleId] = { ...row };
    }
    setDraftRoomPermissions(next);
  }, [roomPermissions, selectedRoom]);

  function hasRole(userId: string, roleId: string) {
    return (userRoles[userId] || []).includes(roleId);
  }

  function toggleUserRole(userId: string, roleId: string, active: boolean) {
    setSaving(true);
    setError("");
    socket.emit(
      "user:role:set",
      { userId, roleId, active },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to update user role.");
        }
      }
    );
  }

  function createRole() {
    const name = newRoleName.trim();
    if (!name) {
      setError("Role name is required.");
      return;
    }
    setSaving(true);
    setError("");
    socket.emit(
      "role:create",
      {
        name,
        color: newRoleColor,
        ...newRoleCapabilities,
      },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to create role.");
          return;
        }
        setNewRoleName("");
        setNewRoleColor("#94a3b8");
        setNewRoleCapabilities(DEFAULT_ROLE_CAPABILITIES);
        setShowCreateRoleModal(false);
      }
    );
  }

  function openCreateRoleModal() {
    setNewRoleName("");
    setNewRoleColor("#94a3b8");
    setNewRoleCapabilities(DEFAULT_ROLE_CAPABILITIES);
    setShowCreateRoleModal(true);
  }

  function updateRole(
    roleId: string,
    patch: {
      color?: string;
      canManageChannels?: boolean;
      canManageRoles?: boolean;
      canManageServer?: boolean;
      canKickMembers?: boolean;
      canBanMembers?: boolean;
      canTimeoutMembers?: boolean;
      canModerateVoice?: boolean;
      canPinMessages?: boolean;
      canManageMessages?: boolean;
      canUploadFiles?: boolean;
      canUseEmojis?: boolean;
      canStartVoice?: boolean;
    }
  ) {
    setSaving(true);
    setError("");
    socket.emit(
      "role:update",
      { roleId, ...patch },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to update role.");
        }
      }
    );
  }

  function updateUserOverride(
    userId: string,
    key: PermissionKey,
    value: boolean | null
  ) {
    const existing = userPermissionOverrides[userId] || {};
    const next = { ...existing };
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    setSaving(true);
    setError("");
    socket.emit(
      "user:permissions:set",
      { userId, overrides: { [key]: value } },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to update user override.");
          return;
        }
        setUserPermissionOverrides((prev) => ({ ...prev, [userId]: next }));
      }
    );
  }

  function deleteRole(roleId: string) {
    setSaving(true);
    setError("");
    socket.emit(
      "role:delete",
      { roleId },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to delete role.");
          return;
        }
        if (selectedRoleId === roleId) {
          setSelectedRoleId("");
        }
      }
    );
  }

  function setDraftPermission(roleId: string, patch: Partial<RoomPermission>) {
    setDraftRoomPermissions((prev) => ({
      ...prev,
      [roleId]: {
        roleId,
        allowView: prev[roleId]?.allowView ?? false,
        allowSend: prev[roleId]?.allowSend ?? false,
        allowConnect: prev[roleId]?.allowConnect ?? false,
        ...patch,
      },
    }));
  }

  function saveRoomPermissions() {
    if (!selectedRoom) return;
    setSaving(true);
    setError("");
    const payload = Object.values(draftRoomPermissions).filter(
      (row) => row.allowView || row.allowSend || row.allowConnect
    );
    socket.emit(
      "room:permissions:set",
      { roomId: selectedRoom.id, permissions: payload },
      (ack?: { ok: boolean; error?: string }) => {
        setSaving(false);
        if (!ack?.ok) {
          setError(ack?.error || "Failed to save room permissions.");
        }
      }
    );
  }

  return (
    <div className="public-profile-backdrop" onClick={onClose}>
      <div
        className="public-profile-modal access-manager-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="public-profile-header access-manager-header">
          <h2 className="heading-font">Server Access Manager</h2>
          <button
            type="button"
            className="public-profile-close"
            onClick={onClose}
            aria-label="Close access manager"
          >
            Close
          </button>
        </div>

        <div className="access-manager-tabs">
          <div className="settings-tabs">
            <button
              type="button"
              className={`settings-tab ${activeTab === "roles" ? "active" : ""}`}
              onClick={() => setActiveTab("roles")}
            >
              Roles
            </button>
            <button
              type="button"
              className={`settings-tab ${activeTab === "members" ? "active" : ""}`}
              onClick={() => setActiveTab("members")}
            >
              Member Roles
            </button>
            <button
              type="button"
              className={`settings-tab ${activeTab === "rooms" ? "active" : ""}`}
              onClick={() => setActiveTab("rooms")}
            >
              Room Access
            </button>
          </div>
        </div>

        <div className="access-manager-body">
          {loading && (
            <div className="text-sm text-[var(--text-muted)]">
              Loading access state...
            </div>
          )}

          {!loading && activeTab === "roles" && (
            <div className="access-two-pane access-roles-pane">
              <div className="profile-section access-pane-list">
                <div className="access-role-list-header">
                  <div className="profile-section-title">Roles</div>
                  <button
                    type="button"
                    className="profile-button"
                    onClick={openCreateRoleModal}
                    disabled={saving}
                  >
                    New role
                  </button>
                </div>
                <div className="access-role-list">
                  {sortedRoles.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      className={`access-list-item access-role-list-item ${
                        selectedRole?.id === role.id ? "active" : ""
                      }`}
                      onClick={() => setSelectedRoleId(role.id)}
                    >
                      <span className="access-role-list-main">
                        <span
                          className="access-role-color-dot"
                          style={{ background: role.color }}
                        />
                        <span>{role.name}</span>
                      </span>
                      <span className="text-xs text-[var(--text-muted)]">
                        #{role.position}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="profile-section">
                <div className="profile-section-title">
                  {selectedRole ? `Edit role: ${selectedRole.name}` : "Select a role"}
                </div>
                {selectedRole ? (
                  <div className="access-role-editor">
                    <div className="access-role-color-row">
                      <label className="profile-label" htmlFor="access-role-color">
                        Color
                      </label>
                      <div className="access-role-color-input">
                        <input
                          id="access-role-color"
                          type="color"
                          value={selectedRole.color}
                          onChange={(e) =>
                            updateRole(selectedRole.id, { color: e.target.value })
                          }
                          disabled={saving}
                        />
                        <span className="access-role-color-preview">
                          <span
                            className="access-role-color-dot"
                            style={{ background: selectedRole.color }}
                          />
                          <span style={{ color: selectedRole.color, fontWeight: 700 }}>
                            {selectedRole.name}
                          </span>
                        </span>
                      </div>
                    </div>
                    <div className="access-role-checks">
                      {CAPABILITY_OPTIONS.map((capability) => (
                        <label
                          key={`${selectedRole.id}-${capability.key}`}
                          className="text-sm access-check-row access-capability-row"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(selectedRole[capability.roleField] === 1)}
                            onChange={(e) => {
                              const nextPatch = {
                                [capability.key]: e.target.checked,
                              } as any;
                              updateRole(selectedRole.id, nextPatch);
                            }}
                            disabled={saving}
                          />
                          <span>{capability.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="access-role-editor-footer">
                      <span className="text-xs text-[var(--text-muted)]">
                        Position {selectedRole.position}
                        {selectedRole.is_system === 1 ? " - system role" : ""}
                      </span>
                      {selectedRole.id !== "everyone" && selectedRole.is_system !== 1 && (
                        <button
                          type="button"
                          className="profile-button secondary"
                          onClick={() => deleteRole(selectedRole.id)}
                          disabled={saving}
                        >
                          Delete role
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--text-muted)]">
                    No role selected.
                  </div>
                )}
              </div>
            </div>
          )}

          {!loading && activeTab === "members" && (
            <div className="access-two-pane">
              <div className="profile-section access-pane-list" ref={membersListRef}>
                <div className="profile-section-title">Members</div>
                <div className="access-role-list">
                  {users.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`access-list-item access-role-list-item access-member-list-item ${
                        selectedUser?.id === entry.id ? "active" : ""
                      }`}
                      onClick={() => setSelectedUserId(entry.id)}
                    >
                      <span>{entry.username}</span>
                      <span className="text-xs text-[var(--text-muted)]">
                        {(userRoles[entry.id] || []).length} role(s)
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="profile-section">
                <div className="profile-section-title">
                  {selectedUser
                    ? `Roles for ${selectedUser.username}`
                    : "Select a member"}
                </div>
                <div className="access-role-checks">
                  {assignableRoles.map((role) => (
                    <label key={role.id} className="text-sm access-check-row">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedUser && hasRole(selectedUser.id, role.id))}
                        onChange={(e) =>
                          selectedUser &&
                          toggleUserRole(selectedUser.id, role.id, e.target.checked)
                        }
                        disabled={!selectedUser || saving}
                      />
                      <span style={{ color: role.color, fontWeight: 700 }}>
                        {role.name}
                      </span>
                    </label>
                  ))}
                </div>
                {selectedUser && (
                  <div className="access-role-checks" style={{ marginTop: 16 }}>
                    <div className="profile-section-title">Direct Permission Overrides</div>
                    {CAPABILITY_OPTIONS.map((capability) => {
                      const override = userPermissionOverrides[selectedUser.id]?.[capability.key];
                      return (
                        <div key={`${selectedUser.id}-${capability.key}`} className="access-check-row">
                          <span className="text-sm" style={{ minWidth: 200 }}>
                            {capability.label}
                          </span>
                          <button
                            type="button"
                            className={`profile-button secondary ${override === true ? "active" : ""}`}
                            onClick={() => updateUserOverride(selectedUser.id, capability.key, true)}
                            disabled={saving}
                          >
                            Allow
                          </button>
                          <button
                            type="button"
                            className={`profile-button secondary ${override === false ? "active" : ""}`}
                            onClick={() => updateUserOverride(selectedUser.id, capability.key, false)}
                            disabled={saving}
                          >
                            Deny
                          </button>
                          <button
                            type="button"
                            className="profile-button secondary"
                            onClick={() => updateUserOverride(selectedUser.id, capability.key, null)}
                            disabled={saving || override === undefined}
                          >
                            Clear
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {!loading && activeTab === "rooms" && (
            <div className="access-two-pane">
              <div className="profile-section access-pane-list">
                <div className="profile-section-title">Rooms</div>
                {manageableRooms.map((room) => (
                  <button
                    key={room.id}
                    type="button"
                    className={`access-list-item ${
                      selectedRoom?.id === room.id ? "active" : ""
                    }`}
                    onClick={() => setSelectedRoomId(room.id)}
                  >
                    <span>
                      {room.type === "text" ? "#" : "voice"} {room.name}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {(roomPermissions[room.id] || []).length} override(s)
                    </span>
                  </button>
                ))}
              </div>

              <div className="profile-section">
                <div className="profile-section-title">
                  {selectedRoom
                    ? `Role access for ${selectedRoom.name}`
                    : "Select a room"}
                </div>
                <div className="access-room-checks">
                  {sortedRoles.map((role) => {
                    const draft = draftRoomPermissions[role.id] || {
                      roleId: role.id,
                      allowView: false,
                      allowSend: false,
                      allowConnect: false,
                    };
                    return (
                      <div key={role.id} className="access-check-row access-room-row">
                        <div className="access-room-role" style={{ color: role.color }}>
                          {role.name}
                        </div>
                        <label className="text-sm access-room-toggle">
                          <input
                            type="checkbox"
                            checked={draft.allowView}
                            onChange={(e) =>
                              setDraftPermission(role.id, {
                                allowView: e.target.checked,
                              })
                            }
                          />{" "}
                          View
                        </label>
                        <label className="text-sm access-room-toggle">
                          <input
                            type="checkbox"
                            checked={draft.allowSend}
                            onChange={(e) =>
                              setDraftPermission(role.id, {
                                allowSend: e.target.checked,
                              })
                            }
                          />{" "}
                          Send
                        </label>
                        <label className="text-sm access-room-toggle">
                          <input
                            type="checkbox"
                            checked={draft.allowConnect}
                            onChange={(e) =>
                              setDraftPermission(role.id, {
                                allowConnect: e.target.checked,
                              })
                            }
                          />{" "}
                          Connect
                        </label>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="profile-button"
                  onClick={saveRoomPermissions}
                  disabled={!selectedRoom || saving}
                >
                  Save room permissions
                </button>
              </div>
            </div>
          )}
        </div>

        {showCreateRoleModal && (
          <div
            className="access-create-role-backdrop"
            onClick={() => setShowCreateRoleModal(false)}
          >
            <div
              className="access-create-role-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="profile-section-title">Create Role</div>
              <div className="profile-grid">
                <div>
                  <label className="profile-label">Name</label>
                  <input
                    className="profile-input"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="Moderator"
                  />
                </div>
                <div>
                  <label className="profile-label">Color</label>
                  <div className="access-role-color-input">
                    <input
                      type="color"
                      value={newRoleColor}
                      onChange={(e) => setNewRoleColor(e.target.value)}
                    />
                    <span className="access-role-color-preview">
                      <span
                        className="access-role-color-dot"
                        style={{ background: newRoleColor }}
                      />
                      <span style={{ color: newRoleColor, fontWeight: 700 }}>
                        Preview role
                      </span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="access-role-checks">
                {CAPABILITY_OPTIONS.map((capability) => (
                  <label
                    key={capability.key}
                    className="text-sm access-check-row access-capability-row"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(newRoleCapabilities[capability.key])}
                      onChange={(e) =>
                        setNewRoleCapabilities((prev) => ({
                          ...prev,
                          [capability.key]: e.target.checked,
                        }))
                      }
                    />
                    <span>{capability.label}</span>
                  </label>
                ))}
              </div>
              <div className="access-create-role-actions">
                <button
                  type="button"
                  className="profile-button secondary"
                  onClick={() => setShowCreateRoleModal(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="profile-button"
                  onClick={createRole}
                  disabled={saving}
                >
                  {saving ? "Creating..." : "Create role"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="access-manager-footer">
          {error ? (
            <span className="text-sm text-[var(--danger)]">{error}</span>
          ) : (
            <span className="text-sm text-[var(--text-muted)]">
              {saving
                ? "Saving changes..."
                : activeTab === "rooms"
                  ? "Room access changes are staged until you click Save room permissions."
                  : "Changes apply immediately."}
            </span>
          )}
          <button
            type="button"
            className="profile-button secondary"
            onClick={loadRoleState}
            disabled={saving}
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
