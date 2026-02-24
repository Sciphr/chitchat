import { useEffect, useRef } from "react";

export interface Toast {
  id: string;
  roomId?: string;
  title?: string;
  body?: string;
  avatarUrl?: string;
  isDm?: boolean;
  /** Simple alert message (used instead of title/body for non-notification toasts) */
  message?: string;
  type?: "error" | "info" | "success";
}

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  onRoomClick: (roomId: string) => void;
}

const TOAST_DURATION_MS = 5000;

function ToastItem({
  toast,
  onDismiss,
  onRoomClick,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
  onRoomClick: (roomId: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(toast.id), TOAST_DURATION_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, onDismiss]);

  const isAlert = !toast.roomId && toast.message !== undefined;

  return (
    <div
      className={`toast${toast.type ? ` toast-${toast.type}` : ""}`}
      onClick={() => {
        if (toast.roomId) onRoomClick(toast.roomId);
        onDismiss(toast.id);
      }}
    >
      {!isAlert && (
        <div className="toast-avatar">
          {toast.avatarUrl ? (
            <img src={toast.avatarUrl} alt="" className="toast-avatar-img" />
          ) : (
            <span className="toast-avatar-placeholder">
              {toast.isDm ? (toast.title ?? "").charAt(0).toUpperCase() : "#"}
            </span>
          )}
        </div>
      )}
      <div className="toast-content">
        {isAlert ? (
          <div className="toast-body">{toast.message}</div>
        ) : (
          <>
            <div className="toast-title">{toast.title}</div>
            <div className="toast-body">{toast.body}</div>
          </>
        )}
      </div>
      <button
        type="button"
        className="toast-close"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.id);
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export default function ToastNotifications({ toasts, onDismiss, onRoomClick }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={onDismiss}
          onRoomClick={onRoomClick}
        />
      ))}
    </div>
  );
}
