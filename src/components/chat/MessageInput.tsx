import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { getServerUrl, getToken } from "../../lib/api";
import type { MessageAttachment } from "../../types";

interface MessageInputProps {
  onSend: (content: string, attachments?: MessageAttachment[]) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  onTypingChange?: (isTyping: boolean) => void;
}

export default function MessageInput({
  onSend,
  disabled = false,
  placeholder = "Type a message...",
  onTypingChange,
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function formatBytes(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function uploadFiles(files: File[]): Promise<MessageAttachment[]> {
    const token = getToken();
    if (!token) {
      throw new Error("Missing auth token");
    }

    const uploaded: MessageAttachment[] = [];
    for (const file of files) {
      const res = await fetch(`${getServerUrl()}/api/files/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-file-name": file.name,
        },
        body: await file.arrayBuffer(),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Upload failed for ${file.name}`);
      }

      uploaded.push({
        id: data.id,
        original_name: data.originalName ?? file.name,
        mime_type:
          data.mimeType ?? file.type ?? "application/octet-stream",
        size_bytes: Number(data.sizeBytes ?? file.size ?? 0),
        created_at: new Date().toISOString(),
        url: data.url,
      });
    }
    return uploaded;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || uploading) return;
    const trimmed = message.trim();
    if (!trimmed && selectedFiles.length === 0) return;

    setUploadError(null);

    try {
      setUploading(true);
      const attachments =
        selectedFiles.length > 0 ? await uploadFiles(selectedFiles) : [];
      await onSend(trimmed, attachments);
      setMessage("");
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      onTypingChange?.(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]/60 chat-input">
      {selectedFiles.length > 0 && (
        <div className="chat-attachments-staging">
          {selectedFiles.map((file) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}`} className="chat-attachment-chip">
              <span className="chat-attachment-chip-name" title={file.name}>
                {file.name}
              </span>
              <span className="chat-attachment-chip-size">{formatBytes(file.size)}</span>
              <button
                type="button"
                className="chat-attachment-chip-remove"
                onClick={() =>
                  setSelectedFiles((prev) =>
                    prev.filter(
                      (f) =>
                        !(
                          f.name === file.name &&
                          f.size === file.size &&
                          f.lastModified === file.lastModified
                        )
                    )
                  )
                }
                title="Remove attachment"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-3 px-10 py-4"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length === 0) return;
            setSelectedFiles((prev) => [...prev, ...files]);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          title="Attach files"
        >
          <Paperclip size={16} />
        </button>

        <input
          type="text"
          value={message}
          onChange={(e) => {
            const next = e.target.value;
            setMessage(next);
            onTypingChange?.(next.trim().length > 0);
          }}
          placeholder={placeholder}
          disabled={disabled || uploading}
          className="flex-1 px-4 py-3 bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border)] rounded-xl outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-muted)] disabled:opacity-50 chat-input-field"
        />
        <button
          type="submit"
          disabled={disabled || uploading || (!message.trim() && selectedFiles.length === 0)}
          className="px-5 py-3 bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors chat-send"
        >
          {uploading ? "Uploading..." : "Send"}
        </button>
      </form>

      {uploadError && (
        <div className="chat-upload-error">
          {uploadError}
        </div>
      )}
    </div>
  );
}
