import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bug, Heart, Minus, RefreshCw, Square, X } from "lucide-react";

const TRAY_HINT_KEY = "chitchat-tray-hint-shown";

const appWindow = getCurrentWindow();

type UpdateProgress = {
  version: string;
  percent: number;
  phase: "downloading" | "installing" | "done";
};

export default function TitleBar() {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [showIssueConfirm, setShowIssueConfirm] = useState(false);
  const [showTrayHint, setShowTrayHint] = useState(false);
  const [updateStatusKind, setUpdateStatusKind] = useState<"info" | "success" | "error">("info");
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const upToDateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!isDesktop) return;
    import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setAppVersion).catch(() => {})
    );
    return () => {
      if (upToDateTimerRef.current) clearTimeout(upToDateTimerRef.current);
    };
  }, [isDesktop]);

  async function handleCheckForUpdates() {
    if (!isDesktop || checkingUpdate) return;
    setUpdateStatus("Checking for updates...");
    setUpdateStatusKind("info");
    setCheckingUpdate(true);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setUpdateStatus("You're up to date.");
        setUpdateStatusKind("success");
        upToDateTimerRef.current = setTimeout(() => setUpdateStatus(""), 4000);
        return;
      }

      const nextVersion = update.version;
      let totalBytes = 0;
      let downloadedBytes = 0;
      setUpdateStatus("");
      setUpdateProgress({ version: nextVersion, percent: 0, phase: "downloading" });
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          setUpdateProgress({ version: nextVersion, percent: 0, phase: "downloading" });
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const percent = totalBytes > 0
            ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
            : 0;
          setUpdateProgress({ version: nextVersion, percent, phase: "downloading" });
          return;
        }
        setUpdateProgress({ version: nextVersion, percent: 100, phase: "installing" });
      });
      await update.close();
      setUpdateProgress({ version: nextVersion, percent: 100, phase: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setUpdateStatus(`Update failed: ${message}`);
      setUpdateStatusKind("error");
      setUpdateProgress(null);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function openIssuePage() {
    const url = "https://github.com/Sciphr/chitchat/issues";
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setShowIssueConfirm(false);
    }
  }

  async function openSponsorPage() {
    const url = "https://github.com/sponsors/Sciphr";
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <>
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-left" data-tauri-drag-region>
          <span className="titlebar-title">ChitChat</span>
          {appVersion && (
            <span className="titlebar-version">v{appVersion}</span>
          )}
        </div>
        {updateStatus && (
          <div
            className={`titlebar-status ${updateStatusKind}`}
            data-tauri-drag-region
          >
            {updateStatus}
          </div>
        )}
        <div className="titlebar-controls">
          <button
            className="titlebar-btn titlebar-btn-issue"
            onClick={() => setShowIssueConfirm(true)}
            aria-label="Report an issue"
            title="Report an issue"
          >
            <Bug size={14} />
          </button>
          <button
            className="titlebar-btn titlebar-btn-sponsor"
            onClick={openSponsorPage}
            aria-label="Sponsor ChitChat"
            title="Sponsor ChitChat"
          >
            <Heart size={14} />
          </button>
          {isDesktop && (
            <button
              className="titlebar-btn"
              onClick={handleCheckForUpdates}
              disabled={checkingUpdate}
              aria-label="Check for updates"
              title={checkingUpdate ? "Checking for updates..." : "Check for updates"}
            >
              <RefreshCw
                size={14}
                className={checkingUpdate ? "titlebar-btn-spin" : undefined}
              />
            </button>
          )}
          <button
            className="titlebar-btn"
            onClick={() => appWindow.minimize()}
            aria-label="Minimize"
          >
            <Minus size={14} />
          </button>
          <button
            className="titlebar-btn"
            onClick={() => appWindow.toggleMaximize()}
            aria-label="Maximize"
          >
            <Square size={12} />
          </button>
          <button
            className="titlebar-btn titlebar-btn-close"
            onClick={() => {
              if (isDesktop) {
                if (!localStorage.getItem(TRAY_HINT_KEY)) {
                  localStorage.setItem(TRAY_HINT_KEY, "1");
                  setShowTrayHint(true);
                  setTimeout(() => {
                    setShowTrayHint(false);
                    void appWindow.hide();
                  }, 3000);
                } else {
                  void appWindow.hide();
                }
              } else {
                void appWindow.close();
              }
            }}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {showTrayHint && (
        <div className="tray-hint-banner">
          <span>ChitChat is running in the system tray. Right-click the tray icon to quit.</span>
        </div>
      )}

      {showIssueConfirm && (
        <div className="titlebar-modal-overlay" onClick={() => setShowIssueConfirm(false)}>
          <div className="titlebar-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Open GitHub Issues?</h3>
            <p>
              This will open your browser to the ChitChat issues page so you can report a bug.
            </p>
            <div className="titlebar-modal-actions">
              <button
                className="titlebar-modal-btn titlebar-modal-btn-cancel"
                onClick={() => setShowIssueConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="titlebar-modal-btn titlebar-modal-btn-primary"
                onClick={openIssuePage}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {updateProgress && (
        <div className="update-overlay">
          <div className="update-overlay-box">
            <div className="update-overlay-title">
              {updateProgress.phase === "done"
                ? `ChitChat ${updateProgress.version} installed`
                : `Updating to ChitChat ${updateProgress.version}`}
            </div>
            {updateProgress.phase !== "done" && (
              <>
                <div className="update-overlay-bar-track">
                  <div
                    className="update-overlay-bar-fill"
                    style={{ width: `${updateProgress.percent}%` }}
                  />
                </div>
                <div className="update-overlay-status">
                  {updateProgress.phase === "installing"
                    ? "Installing..."
                    : `Downloading... ${updateProgress.percent}%`}
                </div>
              </>
            )}
            {updateProgress.phase === "done" && (
              <div className="update-overlay-done">
                <p>Restart ChitChat to apply the update.</p>
                <button
                  className="titlebar-modal-btn titlebar-modal-btn-primary"
                  onClick={() => appWindow.close()}
                >
                  Restart now
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
