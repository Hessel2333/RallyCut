import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import releaseNotes from "./release-notes.json";
import {
  AUTO_UPDATE,
  SEEN_VERSION,
  downloadPercent,
  shouldShowReleaseNotes,
} from "./updates";

type Phase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "latest"
  | "error";

export function UpdateCenter({
  blocked,
  beforeInstall,
}: {
  blocked: boolean;
  beforeInstall: () => Promise<void>;
}) {
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState(
    () => localStorage.getItem(AUTO_UPDATE) !== "false",
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [target, setTarget] = useState<{ version: string; notes: string }>();
  const update = useRef<Update | null>(null);
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  const download = useCallback(async (candidate: Update) => {
    setPhase("downloading");
    setProgress(null);
    let bytes = 0;
    let total: number | undefined;
    await candidate.download(
      (event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") bytes += event.data.chunkLength;
        setProgress(downloadPercent(bytes, total));
      },
      { timeout: 120000 },
    );
    setPhase("ready");
  }, []);

  const checkNow = useCallback(
    async (automatic = false) => {
      if (
        lock.current ||
        ["available", "ready", "installing"].includes(phaseRef.current)
      )
        return;
      lock.current = true;
      setMessage("");
      setPhase("checking");
      try {
        if (update.current) await update.current.close().catch(() => {});
        update.current = null;
        setTarget(undefined);
        const candidate = await check({ timeout: 20000 });
        update.current = candidate;
        if (!candidate) {
          setPhase("latest");
          return;
        }
        setTarget({
          version: candidate.version,
          notes: candidate.body || "此版本包含体验改进与问题修复。",
        });
        setPhase("available");
        if (automatic) await download(candidate);
      } catch {
        setPhase("error");
        setMessage("暂时无法获取更新，请检查网络后重试。");
      } finally {
        lock.current = false;
      }
    },
    [download],
  );

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (cancelled) return;
        setVersion(v);
        if (shouldShowReleaseNotes(localStorage.getItem(SEEN_VERSION), v))
          setShowNotes(true);
        else localStorage.setItem(SEEN_VERSION, v);
      })
      .catch(() => setMessage("无法读取当前版本，请重新打开应用。"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!auto) return;
    const startup = window.setTimeout(() => void checkNow(true), 15000);
    const repeat = window.setInterval(
      () => void checkNow(true),
      4 * 60 * 60 * 1000,
    );
    return () => {
      clearTimeout(startup);
      clearInterval(repeat);
    };
  }, [auto, checkNow]);

  useEffect(() => {
    if (open || showNotes) {
      previousFocus.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      previousFocus.current?.focus();
    }
  }, [open, showNotes]);

  const dismiss = () => {
    if (phase === "installing") return;
    if (showNotes) localStorage.setItem(SEEN_VERSION, version);
    setShowNotes(false);
    setOpen(false);
  };

  const install = async () => {
    if (blocked || lock.current || !update.current) return;
    lock.current = true;
    setPhase("installing");
    setMessage("");
    let guarded = false;
    try {
      await beforeInstall();
      await invoke("begin_app_update");
      guarded = true;
      await update.current.install();
      await relaunch();
    } catch (error) {
      setPhase(guarded ? "error" : "ready");
      setMessage(`未能安装更新：${String(error)}`);
      if (guarded) await invoke("end_app_update").catch(() => {});
    } finally {
      lock.current = false;
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)} title="版本与更新">
        {phase === "ready"
          ? "更新已就绪"
          : phase === "downloading"
            ? "正在下载更新"
            : "版本与更新"}
      </button>
      <dialog
        ref={dialog}
        className="update-dialog"
        aria-labelledby="update-title"
        onCancel={(event) => {
          event.preventDefault();
          dismiss();
        }}
      >
        <div className="modal-title">
          <h2 id="update-title">
            {showNotes ? `已更新至 ${version}` : "版本与更新"}
          </h2>
          <button
            aria-label="关闭更新窗口"
            disabled={phase === "installing"}
            onClick={dismiss}
          >
            ×
          </button>
        </div>
        {showNotes ? (
          <>
            <p>RallyCut 本次更新</p>
            <div className="release-notes">
              {releaseNotes.version === version
                ? releaseNotes.notes
                : "体验改进与问题修复。"}
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={dismiss}>
                开始使用
              </button>
            </div>
          </>
        ) : (
          <>
            <p>RallyCut {version}</p>
            <label className="update-toggle">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  localStorage.setItem(AUTO_UPDATE, String(e.target.checked));
                }}
              />
              自动检查并下载更新
            </label>
            <p className="muted">启动后及每 4 小时检查一次，安装前由你确认。</p>
            <p role="status" aria-live="polite">
              {
                {
                  idle: "",
                  checking: "正在检查更新…",
                  available: "发现新版本",
                  downloading: "正在下载更新…",
                  ready: "更新已下载，可以安装",
                  installing: "正在安装，即将重新打开应用…",
                  latest: "当前已是最新版本",
                  error: "检查或下载失败",
                }[phase]
              }
            </p>
            {phase === "downloading" && (
              <progress
                aria-label="更新下载进度"
                max={100}
                value={progress ?? undefined}
              />
            )}
            {target && (
              <>
                <h3>RallyCut {target.version}</h3>
                <div className="release-notes">{target.notes}</div>
              </>
            )}
            {message && (
              <p className="modal-error" role="alert">
                {message}
              </p>
            )}
            {blocked && phase === "ready" && (
              <p>请等待当前操作和导出队列完成，再安装更新。</p>
            )}
            <div className="modal-actions">
              {["idle", "latest", "error"].includes(phase) && (
                <button onClick={() => void checkNow()}>检查更新</button>
              )}
              {phase === "available" && (
                <button
                  className="primary"
                  onClick={async () => {
                    if (lock.current || !update.current) return;
                    lock.current = true;
                    try {
                      await download(update.current);
                    } catch {
                      setPhase("error");
                      setMessage("下载失败，请检查网络后重试。");
                    } finally {
                      lock.current = false;
                    }
                  }}
                >
                  下载更新
                </button>
              )}
              {phase === "ready" && (
                <button
                  className="primary"
                  disabled={blocked}
                  onClick={() => void install()}
                >
                  安装并重新打开
                </button>
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
