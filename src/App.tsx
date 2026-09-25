import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  FolderOpen,
  Plus,
  Settings as SettingsIcon,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Scissors,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronUp,
  ChevronDown,
  X,
  Check,
  Film,
  Undo2,
  Redo2,
  Trash2,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import type {
  Snapshot,
  Session,
  Match,
  Preset,
  Settings,
  Tools,
  Asset,
  ExportPreferences,
} from "./types";
import {
  mapRange,
  locate,
  bounds,
  timecode,
  parseTime,
  totalUs,
  orderedMatches,
  appendSegment,
  splitSegment,
} from "./timeline";
import { jobMatchesCurrent, remaining } from "./jobs";
import { UpdateCenter } from "./UpdateCenter";

const defaultPreset: Preset = {
  codec: "hevc",
  width: 3840,
  height: 2160,
  bitrate_kbps: 20000,
  audio_kbps: 192,
  force_60: false,
  encoder: "auto",
  acknowledge_sdr: false,
};
const statusName: Record<string, string> = {
  waiting: "等待中",
  preparing: "检查源素材",
  exporting: "正在导出",
  validating: "验证输出",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const phaseName: Record<string, string> = {
  hashing: "检查源素材",
  probing: "读取视频信息",
  copying: "复制素材",
  verifying: "读回校验",
};
const dateNow = () => new Date().toLocaleDateString("sv-SE");
const quickTags = [
  "男单",
  "男双",
  "混双",
  "男双vs混双",
  "拉练",
  "女单",
  "女双",
];
function ClockInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(timecode(value));
  useEffect(() => setText(timecode(value)), [value]);
  return (
    <label className="clock-input">
      <span>{label}</span>
      <input
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            onChange(parseTime(text));
          } catch {
            setText(timecode(value));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
export default function App() {
  const [previews, setPreviews] = useState<
    { asset_id: string; path: string; kind: string }[]
  >([]);
  const [previewTask, setPreviewTask] = useState<{
    token: string;
    progress: number;
  } | null>(null);
  const [outputPreview, setOutputPreview] = useState<string[]>([]);
  const [data, setData] = useState<Snapshot>();
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem("rallycut-session") ?? "",
  );
  const [tools, setTools] = useState<Tools>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("已保存");
  const [modal, setModal] = useState<
    "import" | "settings" | "export" | "delete" | null
  >(null);
  const [left, setLeft] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const [queue, setQueue] = useState(false);
  const [allJobs, setAllJobs] = useState(false);
  const [draftTag, setDraftTag] = useState("男双");
  const [preferences, setPreferences] = useState<ExportPreferences>({
    current: defaultPreset,
    presets: [],
  });
  const [presetName, setPresetName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [markIn, setMarkIn] = useState(0);
  const [markOut, setMarkOut] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState(defaultPreset);
  const [hardware, setHardware] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importDir, setImportDir] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [copy, setCopy] = useState(false);
  const [importName, setImportName] = useState("羽毛球");
  const [importDate, setImportDate] = useState(dateNow());
  const [busy, setBusy] = useState(false);
  const [importProgress, setImportProgress] = useState<any>();
  const importToken = useRef("");
  const [config, setConfig] = useState<Settings>();
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef<{ local: number; play: boolean } | null>(null);
  const saveChain = useRef(Promise.resolve());
  const saveError = useRef("");
  const undo = useRef<Match[][]>([]);
  const redo = useRef<Match[][]>([]);
  const session = data?.sessions.find((s) => s.id === sessionId);
  const assets = (session?.asset_ids
    .map((id) => data?.assets.find((a) => a.id === id))
    .filter(Boolean) ?? []) as Asset[];
  const total = totalUs(assets);
  const current = assets[sourceIndex];
  const offset = assets
    .slice(0, sourceIndex)
    .reduce((n, a) => n + a.duration_us, 0);
  const refresh = async (full = true) => {
    const v = await invoke<Snapshot>("snapshot");
    setData((old) =>
      full || !old
        ? v
        : {
            ...old,
            jobs: v.jobs,
            assets: v.assets,
            paused: v.paused,
            match_numbers: v.match_numbers,
          },
    );
    if (full)
      setSessionId((id) =>
        v.sessions.some((s) => s.id === id) ? id : v.sessions[0]?.id || "",
      );
  };
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    void run(async () => {
      await refresh();
      setTools(await invoke<Tools>("tool_status"));
      setPreviews(await invoke("cached_previews"));
      const pref = await invoke<ExportPreferences>("export_preferences");
      setPreferences(pref);
      setPreset(pref.current);
      const activePreset = pref.presets.find(
        (p) => JSON.stringify(p.preset) === JSON.stringify(pref.current),
      );
      if (activePreset) {
        setPresetId(activePreset.id);
        setPresetName(activePreset.name);
      }
    });
    const timer = setInterval(
      () => void refresh(false).catch((e) => setError(String(e))),
      1000,
    );
    const unlisten = listen("import-progress", (e) =>
      setImportProgress(e.payload),
    );
    const off = listen<{ token: string; progress: number }>(
      "preview-progress",
      (e) =>
        setPreviewTask((t) => (t?.token === e.payload.token ? e.payload : t)),
    );
    return () => {
      clearInterval(timer);
      void unlisten.then((f) => f());
      void off.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (sessionId) localStorage.setItem("rallycut-session", sessionId);
    setPlayhead(0);
    setSourceIndex(0);
    const end = Math.max(
      0,
      ...(session?.matches ?? []).map((m) => bounds(assets, m.ranges).end),
    );
    setMarkIn(end);
    setMarkOut(end);
    setSelected([]);
    setPlaying(false);
    pending.current = { local: 0, play: false };
    undo.current = [];
    redo.current = [];
    video.current?.pause();
  }, [sessionId]);
  useEffect(() => {
    setSelected((ids) =>
      ids.filter((id) => session?.matches.some((m) => m.id === id)),
    );
  }, [session?.matches]);
  const saveSession = (next: Session, history = true) => {
    if (!session) return;
    if (history) {
      undo.current.push(structuredClone(session.matches));
      redo.current = [];
    }
    setData((d) =>
      d
        ? {
            ...d,
            sessions: d.sessions.map((s) => (s.id === next.id ? next : s)),
          }
        : d,
    );
    setSaved("保存中…");
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(() => invoke("save_session", { session: next }))
      .then(() => {
        setSaved("已保存");
        saveError.current = "";
      })
      .catch((e) => {
        setSaved("保存失败");
        saveError.current = String(e);
        setError(String(e));
      });
  };
  const saveMatches = (matches: Match[], history = true) =>
    session &&
    saveSession(
      { ...session, matches: orderedMatches(assets, matches) },
      history,
    );
  const seek = (us: number, auto = playing) => {
    if (!assets.length) return;
    const t = Math.max(0, Math.min(total, Math.round(us)));
    const loc = locate(assets, t);
    setPlayhead(t);
    if (loc.index === sourceIndex && video.current) {
      video.current.currentTime = loc.local / 1e6;
      if (auto) void video.current.play().catch((e) => setError(String(e)));
    } else {
      pending.current = { local: loc.local, play: auto };
      setSourceIndex(loc.index);
    }
  };
  const toggle = () => {
    const v = video.current;
    if (v) {
      if (v.paused)
        void v
          .play()
          .catch(() =>
            setError(
              "此素材无法在播放器中打开。可尝试其他 H.264 素材；请生成预览代理。",
            ),
          );
      else v.pause();
    }
  };
  const addMatch = (end = markOut) => {
    if (!session) return;
    try {
      const id = crypto.randomUUID();
      const next = appendSegment(
        assets,
        session.matches,
        markIn,
        end,
        draftTag.trim() || "未命名",
        id,
      );
      saveMatches(next.matches);
      setMarkIn(next.nextStart);
      setMarkOut(next.nextEnd);
      setSelected((s) => [...s, id]);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const cutHere = () => {
    if (!session) return;
    const id = crypto.randomUUID();
    const split = splitSegment(assets, session.matches, playhead, id);
    if (split) {
      saveMatches(split);
      setSelected((s) => [...s, id]);
      setError("");
    } else addMatch(playhead);
  };
  const history = (forward: boolean) => {
    if (!session) return;
    const from = forward ? redo.current : undo.current,
      to = forward ? undo.current : redo.current;
    const next = from.pop();
    if (next) {
      to.push(structuredClone(session.matches));
      saveMatches(next, false);
      const end = Math.max(0, ...next.map((m) => bounds(assets, m.ranges).end));
      setMarkIn(end);
      setMarkOut(end);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        modal ||
        document.querySelector("dialog[open]") ||
        target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        history(e.shiftKey);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key.toLowerCase() === "i") setMarkIn(playhead);
      else if (e.key.toLowerCase() === "o") setMarkOut(playhead);
      else if (e.key === "Enter") addMatch();
      else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        cutHere();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seek(
          playhead +
            (e.key === "ArrowLeft" ? -1 : 1) *
              (e.shiftKey ? 10000000 : 1000000),
        );
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const prepare = (kind: string) =>
    run(async () => {
      if (!current) return;
      const token = crypto.randomUUID();
      setPreviewTask({ token, progress: 0 });
      pending.current = {
        local: Math.max(0, playhead - offset),
        play: playing,
      };
      try {
        const p = await invoke<{
          asset_id: string;
          path: string;
          kind: string;
        }>("prepare_preview", { assetId: current.id, kind, token });
        setPreviews((old) => [
          ...old.filter((x) => x.asset_id !== p.asset_id || x.kind !== p.kind),
          p,
        ]);
      } finally {
        setPreviewTask(null);
      }
    });
  useEffect(() => {
    if (modal === "export" && session && selected.length)
      void saveChain.current
        .then(() =>
          invoke<string[]>("enqueue", {
            sessionId: session.id,
            matchIds: selected,
            preset,
            dryRun: true,
          }),
        )
        .then(setOutputPreview)
        .catch((e) => setError(String(e)));
    else setOutputPreview([]);
  }, [modal, selected, preset, session, data?.settings.output]);
  const persistPreferences = async (next = preferences) => {
    const value = { ...next, current: preset };
    await invoke("save_export_preferences", { value });
    setPreferences(value);
  };
  const choose = () =>
    invoke<string | null>("choose_path", { kind: "directory" });
  const scan = () =>
    run(async () => {
      const p = await choose();
      if (p) {
        setImportDir(p);
        setPaths(await invoke<string[]>("scan_directory", { path: p }));
      }
    });
  const doImport = () =>
    run(async () => {
      setBusy(true);
      importToken.current = crypto.randomUUID();
      try {
        const id = await invoke<string>("import_session", {
          paths,
          copy,
          name: importName,
          date: importDate,
          token: importToken.current,
        });
        await refresh();
        setSessionId(id);
        setModal(null);
        setPaths([]);
        setImportProgress(undefined);
      } finally {
        setBusy(false);
      }
    });
  const showSettings = () => {
    setConfig(data?.settings);
    setModal("settings");
  };
  const configure = (key: keyof Settings) =>
    run(async () => {
      const p = await invoke<string | null>("choose_path", {
        kind: key === "ffmpeg" || key === "ffprobe" ? "file" : "directory",
      });
      if (p) setConfig((c) => (c ? { ...c, [key]: p } : c));
    });
  const exportSelected = () =>
    run(async () => {
      if (!session) return;
      await saveChain.current;
      if (saveError.current) throw Error("比赛标记尚未保存，请先解决保存错误");
      await persistPreferences();
      await invoke("enqueue", {
        sessionId: session.id,
        matchIds: selected,
        preset,
      });
      await refresh(false);
      setQueue(true);
      setModal(null);
    });
  const updateBoundary = (m: Match, start: number, end: number) => {
    try {
      appendSegment(
        assets,
        session!.matches.filter((x) => x.id !== m.id),
        start,
        end,
        m.name,
        m.id,
      );
      const ranges = mapRange(assets, start, end);
      saveMatches(
        session!.matches.map((x) => (x.id === m.id ? { ...x, ranges } : x)),
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const activeJobs =
    data?.jobs.filter(
      (j) =>
        !["completed", "cancelled", "failed", "interrupted"].includes(j.status),
    ).length ?? 0;
  if (!isTauri())
    return (
      <div className="browser-notice">
        <Scissors size={40} />
        <h1>RallyCut</h1>
        <p>请从桌面应用打开，以访问本地素材。</p>
        <code>npm run tauri dev</code>
      </div>
    );
  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          <Scissors size={21} />
          <strong>RallyCut</strong>
          <span>本地剪辑</span>
        </div>
        <div className="header-center">
          {session?.name ?? "工作区"}
          {session && <small>{session.date}</small>}
        </div>
        <button onClick={() => setModal("export")} title="查看和保存导出设置">
          导出设置
        </button>
        <UpdateCenter
          blocked={
            busy || !!previewTask || detecting || activeJobs > 0 || !!modal
          }
          beforeInstall={async () => {
            await saveChain.current;
            if (saveError.current)
              throw new Error("比赛标记尚未保存，请先解决保存错误");
          }}
        />
        <button onClick={showSettings} title="设置">
          <SettingsIcon size={17} />
          <span>设置</span>
        </button>
        <button
          className="primary"
          disabled={!session?.matches.length}
          onClick={() => {
            setSelected((s) =>
              s.length ? s : session!.matches.map((m) => m.id),
            );
            setModal("export");
          }}
        >
          <Download size={16} />
          导出比赛
        </button>
      </header>
      {error && (
        <div role="alert" className="error">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="关闭错误">
            <X size={15} />
          </button>
        </div>
      )}
      <div className={`workspace ${left ? "" : "collapsed"}`}>
        {left && (
          <aside className="library">
            <div className="panel-heading">
              <strong>拍摄记录</strong>
              <button
                className="icon"
                title="收起拍摄记录"
                onClick={() => setLeft(false)}
              >
                <PanelLeftClose size={17} />
              </button>
            </div>
            <button
              className="import-button"
              onClick={() => setModal("import")}
            >
              <Plus size={16} />
              导入素材
            </button>
            <div className="session-list">
              {data?.sessions.map((s) => (
                <div
                  className={`session-row ${s.id === sessionId ? "active" : ""}`}
                  key={s.id}
                >
                  <button
                    className={`session ${s.id === sessionId ? "active" : ""}`}
                    onClick={() => setSessionId(s.id)}
                  >
                    <Film size={17} />
                    <div>
                      <strong>{s.name}</strong>
                      <small>
                        {s.date} · {s.asset_ids.length} 个文件
                      </small>
                    </div>
                  </button>
                  <button
                    className="icon delete-session"
                    aria-label={`删除拍摄记录：${s.name}（${s.date}）`}
                    title="删除拍摄记录"
                    onClick={() => {
                      setDeleteTarget(s);
                      setError("");
                      setModal("delete");
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="library-bottom">
              <span
                className={`dot ${tools?.ffmpeg.available && tools?.ffprobe.available ? "ok" : ""}`}
              />
              <button onClick={showSettings}>
                {tools?.ffmpeg.available && tools?.ffprobe.available
                  ? "视频工具已就绪"
                  : "配置视频工具"}
              </button>
              <small>素材始终保留在本机</small>
            </div>
          </aside>
        )}
        <main className="editor">
          <div className="editor-heading">
            {!left && (
              <button
                className="icon"
                title="展开拍摄记录"
                onClick={() => setLeft(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            <span>{session ? "素材预览" : "开始一次剪辑"}</span>
            <span className="muted">
              {current
                ? `${current.name} · ${sourceIndex + 1} / ${assets.length}`
                : ""}
            </span>
            {current && (
              <button
                className="preview-button"
                disabled={!!previewTask}
                onClick={() => prepare("proxy")}
              >
                生成代理
              </button>
            )}
            {current && (
              <button
                className="preview-button"
                disabled={!!previewTask}
                onClick={() => prepare("thumbnail")}
              >
                缩略图
              </button>
            )}
            {previewTask && (
              <button
                className="preview-button"
                onClick={() =>
                  run(() =>
                    invoke("queue_action", {
                      action: "cancel",
                      jobId: previewTask.token,
                    }),
                  )
                }
              >
                取消准备 {Math.round(previewTask.progress * 100)}%
              </button>
            )}
            <span className="save-status">
              <Check size={12} />
              {saved}
            </span>
          </div>
          <div className="viewer">
            {current ? (
              current.available ? (
                <video
                  ref={video}
                  src={convertFileSrc(
                    previews.find(
                      (p) => p.asset_id === current.id && p.kind === "proxy",
                    )?.path ?? current.path,
                  )}
                  onLoadedMetadata={() => {
                    if (pending.current && video.current) {
                      video.current.currentTime = pending.current.local / 1e6;
                      if (pending.current.play)
                        void video.current.play().catch(() => {});
                      pending.current = null;
                    }
                  }}
                  onTimeUpdate={() => {
                    if (video.current)
                      setPlayhead(
                        offset +
                          Math.min(
                            current.duration_us,
                            Math.round(video.current.currentTime * 1e6),
                          ),
                      );
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => {
                    if (sourceIndex < assets.length - 1) {
                      pending.current = { local: 0, play: true };
                      setSourceIndex((i) => i + 1);
                    } else setPlaying(false);
                  }}
                  onError={() =>
                    setError(
                      "当前素材无法播放或定位。请检查编码格式与文件可用性。",
                    )
                  }
                  onClick={toggle}
                />
              ) : (
                <div className="empty">
                  <AlertCircle size={36} />
                  <h2>素材离线</h2>
                  <p>{current.name}</p>
                  <button
                    onClick={() =>
                      run(async () => {
                        const path = await invoke<string | null>(
                          "choose_path",
                          { kind: "file" },
                        );
                        if (path) {
                          await invoke("relink_asset", {
                            assetId: current.id,
                            path,
                          });
                          await refresh(false);
                        }
                      })
                    }
                  >
                    重新定位素材
                  </button>
                </div>
              )
            ) : (
              <div className="empty">
                <div className="empty-icon">
                  <Film size={34} />
                </div>
                <h1>从一场拍摄开始</h1>
                <p>导入原片，标记每局的开始与结束。</p>
                <button className="primary" onClick={() => setModal("import")}>
                  <Plus size={17} />
                  导入素材
                </button>
                <small>复制到素材库，或直接引用硬盘中的视频</small>
              </div>
            )}
          </div>
          <div className="transport">
            <span className="time-readout">
              {timecode(playhead)}
              <span> / {timecode(total)}</span>
            </span>
            <div className="play-controls">
              <button
                title="后退 10 秒"
                disabled={!current}
                onClick={() => seek(playhead - 10000000)}
              >
                <SkipBack size={17} />
              </button>
              <button
                className="play"
                title="播放 / 暂停（Space）"
                disabled={!current}
                onClick={toggle}
              >
                {playing ? <Pause size={19} /> : <Play size={19} />}
              </button>
              <button
                title="前进 10 秒"
                disabled={!current}
                onClick={() => seek(playhead + 10000000)}
              >
                <SkipForward size={17} />
              </button>
            </div>
            <select
              aria-label="播放速度"
              defaultValue="1"
              onChange={(e) => {
                if (video.current) video.current.playbackRate = +e.target.value;
              }}
            >
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </div>
          <section className="timeline-panel">
            <div className="timeline-toolbar">
              <strong>统一时间线</strong>
              <span className="muted">
                {assets.length > 1 ? "文件交界不代表连续拍摄，请检查衔接" : ""}
              </span>
              <label>
                缩放{" "}
                <input
                  type="range"
                  aria-label="时间线缩放"
                  min="1"
                  max="8"
                  step="0.5"
                  value={zoom}
                  onChange={(e) => setZoom(+e.target.value)}
                />
              </label>
            </div>
            <div className="timeline-scroll">
              <div
                className="timeline"
                style={{ width: `${zoom * 100}%` }}
                onPointerDown={(e) => {
                  if (!total) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  seek(((e.clientX - rect.left) / rect.width) * total);
                }}
              >
                <div className="ruler">
                  {Array.from({ length: 9 }, (_, i) => (
                    <span key={i}>
                      {timecode(Math.floor((total * i) / 8)).slice(0, 8)}
                    </span>
                  ))}
                </div>
                <div className="source-track">
                  {assets.map((a, i) => (
                    <div
                      key={a.id}
                      style={{ width: `${(a.duration_us / total) * 100}%` }}
                      className={i === sourceIndex ? "current" : ""}
                    >
                      {previews.find(
                        (p) => p.asset_id === a.id && p.kind === "thumbnail",
                      ) ? (
                        <img
                          className="source-thumb"
                          src={convertFileSrc(
                            previews.find(
                              (p) =>
                                p.asset_id === a.id && p.kind === "thumbnail",
                            )!.path,
                          )}
                        />
                      ) : (
                        <Film size={13} />
                      )}
                      <span>{a.name}</span>
                    </div>
                  ))}
                </div>
                <div className="match-track">
                  {session?.matches.map((m, i) => {
                    const b = bounds(assets, m.ranges);
                    return (
                      <div
                        title={m.name}
                        key={m.id}
                        className="match-block"
                        style={{
                          left: `${(b.start / total) * 100}%`,
                          width: `${((b.end - b.start) / total) * 100}%`,
                        }}
                      >
                        <span>
                          {data?.match_numbers[m.id] ?? i + 1} {m.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {total > 0 && (
                  <>
                    <div
                      className="playhead"
                      style={{ left: `${(playhead / total) * 100}%` }}
                    />
                    <div
                      className="draft-range"
                      style={{
                        left: `${(markIn / total) * 100}%`,
                        width: `${(Math.max(0, markOut - markIn) / total) * 100}%`,
                      }}
                    />
                    <input
                      className="boundary start"
                      title="拖动开始边界"
                      aria-label="拖动开始边界"
                      type="range"
                      min="0"
                      max={total}
                      step="1000"
                      value={markIn}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setMarkIn(+e.target.value)}
                    />
                    <input
                      className="boundary end"
                      title="拖动结束边界"
                      aria-label="拖动结束边界"
                      type="range"
                      min="0"
                      max={total}
                      step="1000"
                      value={markOut}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => setMarkOut(+e.target.value)}
                    />
                  </>
                )}
              </div>
            </div>
            <div className="mark-toolbar">
              <button
                className="primary"
                disabled={!current}
                onClick={cutHere}
                title="在播放位置分段（S）"
              >
                在此分段 <kbd>S</kbd>
              </button>
              <button disabled={!current} onClick={() => setMarkIn(playhead)}>
                设为开始 <kbd>I</kbd>
              </button>
              <ClockInput
                label="开始时间"
                value={markIn}
                onChange={setMarkIn}
              />
              <button disabled={!current} onClick={() => setMarkOut(playhead)}>
                设为结束 <kbd>O</kbd>
              </button>
              <ClockInput
                label="结束时间"
                value={markOut}
                onChange={setMarkOut}
              />
              <button
                className="primary"
                disabled={!current || markOut <= markIn}
                onClick={() => addMatch()}
              >
                <Plus size={15} />
                添加一局
              </button>
            </div>
            <div className="tag-toolbar">
              <span>下一段标签</span>
              <input
                aria-label="下一段标签"
                value={draftTag}
                onChange={(e) => setDraftTag(e.target.value)}
              />
              {quickTags.map((tag) => (
                <button
                  key={tag}
                  className={draftTag === tag ? "active" : ""}
                  onClick={() => setDraftTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </section>
        </main>
        <aside className="matches">
          <div className="panel-heading">
            <strong>
              比赛 <span>{session?.matches.length ?? 0}</span>
            </strong>
            <div>
              <button
                className="icon"
                title="撤销（Ctrl+Z）"
                disabled={!undo.current.length}
                onClick={() => history(false)}
              >
                <Undo2 size={16} />
              </button>
              <button
                className="icon"
                title="重做（Ctrl+Shift+Z）"
                disabled={!redo.current.length}
                onClick={() => history(true)}
              >
                <Redo2 size={16} />
              </button>
            </div>
          </div>
          <div className="matches-list">
            {!session?.matches.length ? (
              <div className="matches-empty">
                <Scissors size={24} />
                <p>标记你想保留的每一局</p>
                <small>到每局结束处按 S 分段；局间休息可用 I 跳过。</small>
              </div>
            ) : (
              orderedMatches(assets, session.matches).map((m, i) => {
                const b = bounds(assets, m.ranges);
                const overlap = session.matches.some((other) => {
                  if (other.id === m.id) return false;
                  const x = bounds(assets, other.ranges);
                  return b.start < x.end && b.end > x.start;
                });
                return (
                  <article className="match-item" key={m.id}>
                    <div className="match-title">
                      <input
                        type="checkbox"
                        aria-label={`选择${m.name}`}
                        checked={selected.includes(m.id)}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.target.checked
                              ? [...s, m.id]
                              : s.filter((id) => id !== m.id),
                          )
                        }
                      />
                      <span className="ordinal">
                        {data?.match_numbers[m.id] ?? i + 1}
                      </span>
                      <input
                        aria-label={`比赛${i + 1}名称`}
                        value={m.name}
                        onChange={(e) =>
                          saveMatches(
                            session.matches.map((x) =>
                              x.id === m.id
                                ? { ...x, name: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      <button
                        className="icon"
                        title="删除比赛标记"
                        onClick={() =>
                          saveMatches(
                            session.matches.filter((x) => x.id !== m.id),
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="quick-tags">
                      {quickTags.map((tag) => (
                        <button
                          key={tag}
                          className={m.name === tag ? "active" : ""}
                          onClick={() =>
                            saveMatches(
                              session.matches.map((x) =>
                                x.id === m.id ? { ...x, name: tag } : x,
                              ),
                            )
                          }
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    <div className="match-times">
                      <ClockInput
                        label="起点"
                        value={b.start}
                        onChange={(v) => updateBoundary(m, v, b.end)}
                      />
                      <ClockInput
                        label="终点"
                        value={b.end}
                        onChange={(v) => updateBoundary(m, b.start, v)}
                      />
                    </div>
                    <div className="match-details">
                      <button onClick={() => seek(b.start, false)}>
                        跳转起点
                      </button>
                      <button onClick={() => seek(b.end, false)}>终点</button>
                      <span>
                        {timecode(b.end - b.start).slice(3, 8)}
                        {m.ranges.length > 1
                          ? ` · 跨 ${m.ranges.length} 个文件`
                          : ""}
                      </span>
                    </div>
                    <input
                      className="note"
                      placeholder="比分或备注"
                      aria-label="比分或备注"
                      value={m.note}
                      onChange={(e) =>
                        saveMatches(
                          session.matches.map((x) =>
                            x.id === m.id ? { ...x, note: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    {overlap && (
                      <small className="warning">与其他比赛区间重叠</small>
                    )}
                  </article>
                );
              })
            )}
          </div>
          <div className="matches-footer">
            <span>仅导出所选比赛</span>
            <button
              className="primary"
              disabled={!selected.length}
              onClick={() => setModal("export")}
            >
              <Download size={15} />
              导出 {selected.length || ""}
            </button>
          </div>
        </aside>
      </div>
      <footer className="statusbar">
        <button onClick={() => setQueue(!queue)}>
          {queue ? <ChevronDown size={16} /> : <ChevronUp size={16} />}任务队列{" "}
          {activeJobs > 0 && <span className="badge">{activeJobs}</span>}
        </button>
        <span>
          {current
            ? `${current.metadata.streams.find((s) => s.codec_type === "video")?.width} × ${current.metadata.streams.find((s) => s.codec_type === "video")?.height} · ${current.metadata.streams.find((s) => s.codec_type === "video")?.avg_frame_rate} fps`
            : "准备就绪"}
        </span>
        <button onClick={() => run(() => invoke("open_output"))}>
          <FolderOpen size={14} />
          输出目录
        </button>
      </footer>
      {queue && (
        <section className="queue">
          <div className="panel-heading">
            <strong>导出任务</strong>
            <select
              aria-label="任务范围"
              value={allJobs ? "all" : "session"}
              onChange={(e) => setAllJobs(e.target.value === "all")}
            >
              <option value="session">当前拍摄</option>
              <option value="all">全部任务</option>
            </select>
            <span className="muted">
              {data?.paused ? "已暂停启动后续任务" : "按顺序处理 · 每次一局"}
            </span>
            <button
              onClick={() =>
                run(async () => {
                  await invoke("queue_action", {
                    action: data?.paused ? "resume" : "pause",
                  });
                  await refresh(false);
                })
              }
            >
              {data?.paused ? "继续队列" : "暂停队列"}
            </button>
            <button
              className="icon"
              title="收起队列"
              onClick={() => setQueue(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="queue-list">
            {!data?.jobs.filter((j) => allJobs || j.session_id === sessionId)
              .length ? (
              <p className="muted">还没有导出任务。标记比赛后即可导出。</p>
            ) : (
              [...data.jobs]
                .filter((j) => allJobs || j.session_id === sessionId)
                .reverse()
                .map((j) => (
                  <div className="job" key={j.id}>
                    <div className="job-name">
                      <strong>{j.segment.name}</strong>
                      {allJobs && (
                        <small>
                          {data.sessions.find((s) => s.id === j.session_id)
                            ?.name ?? "历史拍摄"}
                        </small>
                      )}
                      <small>
                        {j.preset.codec === "hevc" ? "H.265" : "H.264"} ·{" "}
                        {j.preset.width} × {j.preset.height} ·{" "}
                        {j.preset.force_60 ? "60 fps" : "源帧率"} ·{" "}
                        {j.preset.bitrate_kbps} kbps
                      </small>
                      <small title={j.output}>{j.output}</small>
                      {j.error && <pre>{j.error}</pre>}
                      {j.validation && <small>{j.validation}</small>}
                      {!jobMatchesCurrent(
                        j,
                        data.sessions,
                        data.assets,
                        j.preset,
                      ) && (
                        <small className="warning">
                          比赛标记或素材已改变，已有导出保持不变
                        </small>
                      )}
                    </div>
                    <div className="job-progress">
                      <span>
                        {statusName[j.status]}{" "}
                        {j.status === "exporting"
                          ? `${Math.round(j.progress * 100)}%`
                          : ""}
                      </span>
                      {j.status === "exporting" && (
                        <progress max="1" value={j.progress} />
                      )}
                      <small>{j.speed}</small>
                      <small>{remaining(j)}</small>
                    </div>
                    {["failed", "cancelled", "interrupted"].includes(
                      j.status,
                    ) ? (
                      <button
                        onClick={() =>
                          run(() =>
                            invoke("queue_action", {
                              action: "retry",
                              jobId: j.id,
                            }),
                          )
                        }
                      >
                        重试
                      </button>
                    ) : (
                      j.status !== "completed" && (
                        <button
                          onClick={() =>
                            run(() =>
                              invoke("queue_action", {
                                action: "cancel",
                                jobId: j.id,
                              }),
                            )
                          }
                        >
                          取消
                        </button>
                      )
                    )}
                  </div>
                ))
            )}
          </div>
        </section>
      )}
      {modal && (
        <div className="modal-backdrop">
          <section
            className={`modal ${modal === "import" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-title">
              <h2>
                {modal === "import"
                  ? "导入一次拍摄"
                  : modal === "settings"
                    ? "设置"
                    : modal === "delete"
                      ? "删除拍摄记录"
                      : "导出设置"}
              </h2>
              <button
                className="icon"
                aria-label="关闭"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>
            {error && (
              <p className="modal-error" role="alert">
                {error}
              </p>
            )}
            {modal === "delete" && deleteTarget && (
              <>
                <p>删除“{deleteTarget.name}”？</p>
                <p className="muted">
                  {deleteTarget.date} · {deleteTarget.asset_ids.length} 个素材 ·{" "}
                  {deleteTarget.matches.length} 个比赛标记
                </p>
                <p>
                  此拍摄记录及比赛标记将被移除。原始素材、已导出视频和历史导出记录都会保留。
                </p>
                <p className="muted">
                  历史导出可在“全部任务”中查看。当天其余比赛的新导出编号会重新排列。
                </p>
                {data?.jobs.some(
                  (j) =>
                    j.session_id === deleteTarget.id &&
                    ![
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                    ].includes(j.status),
                ) && (
                  <p className="warning">
                    此拍摄还有未完成任务，请等待完成或取消任务后再删除。
                  </p>
                )}
                <div className="modal-actions">
                  <button disabled={busy} onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="danger"
                    disabled={
                      busy ||
                      data?.jobs.some(
                        (j) =>
                          j.session_id === deleteTarget.id &&
                          ![
                            "completed",
                            "failed",
                            "cancelled",
                            "interrupted",
                          ].includes(j.status),
                      )
                    }
                    onClick={() =>
                      run(async () => {
                        setBusy(true);
                        try {
                          await saveChain.current;
                          await invoke("delete_session", {
                            sessionId: deleteTarget.id,
                          });
                          await refresh();
                          setDeleteTarget(null);
                          setModal(null);
                        } finally {
                          setBusy(false);
                        }
                      })
                    }
                  >
                    {busy ? "正在删除…" : "删除记录与标记"}
                  </button>
                </div>
              </>
            )}
            {modal === "import" && (
              <>
                <div className="form-row">
                  <label>
                    拍摄名称
                    <input
                      value={importName}
                      onChange={(e) => setImportName(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    拍摄日期
                    <input
                      type="date"
                      value={importDate}
                      onChange={(e) => setImportDate(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                </div>
                <div className="path-row">
                  <span title={importDir}>
                    {importDir || "选择包含视频的目录"}
                  </span>
                  <button disabled={busy} onClick={scan}>
                    <FolderOpen size={16} />
                    选择目录
                  </button>
                </div>
                <div className="segmented">
                  <button
                    disabled={busy}
                    className={!copy ? "selected" : ""}
                    onClick={() => setCopy(false)}
                  >
                    就地引用
                  </button>
                  <button
                    disabled={busy}
                    className={copy ? "selected" : ""}
                    onClick={() => setCopy(true)}
                  >
                    复制到素材库
                  </button>
                </div>
                <p className="muted">
                  {copy
                    ? "复制后读回校验；原文件保持不变。"
                    : "直接使用当前位置的文件，请保留素材。"}{" "}
                  按文件名自然排序，请确认拍摄顺序。
                </p>
                <div className="scan-list">
                  {paths.map((p, i) => (
                    <div key={p}>
                      <span className="ordinal">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span title={p}>{p.split(/[\\/]/).at(-1)}</span>
                      <button
                        className="icon"
                        title="上移"
                        disabled={busy || i === 0}
                        onClick={() =>
                          setPaths((a) => {
                            const b = [...a];
                            [b[i - 1], b[i]] = [b[i], b[i - 1]];
                            return b;
                          })
                        }
                      >
                        <ChevronUp size={15} />
                      </button>
                      <button
                        className="icon"
                        title="下移"
                        disabled={busy || i === paths.length - 1}
                        onClick={() =>
                          setPaths((a) => {
                            const b = [...a];
                            [b[i], b[i + 1]] = [b[i + 1], b[i]];
                            return b;
                          })
                        }
                      >
                        <ChevronDown size={15} />
                      </button>
                      <button
                        className="icon"
                        title="不导入此文件"
                        disabled={busy}
                        onClick={() =>
                          setPaths((a) => a.filter((x) => x !== p))
                        }
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                {busy && (
                  <div className="import-progress">
                    <LoaderCircle size={16} className="spin" />
                    <span>
                      {phaseName[importProgress?.phase] ?? "准备导入"} ·{" "}
                      {importProgress?.index ?? 0}/{paths.length}
                    </span>
                    {importProgress?.phase !== "probing" &&
                      importProgress?.total > 0 && (
                        <progress
                          value={importProgress.bytes}
                          max={importProgress.total}
                        />
                      )}
                  </div>
                )}
                <div className="modal-actions">
                  <span className="muted">
                    {paths.length} 个视频 · 不推断拍摄连续性
                  </span>
                  {busy ? (
                    <button
                      onClick={() =>
                        run(() =>
                          invoke("queue_action", {
                            action: "cancel",
                            jobId: importToken.current,
                          }),
                        )
                      }
                    >
                      取消导入
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={!paths.length}
                      onClick={doImport}
                    >
                      建立拍摄记录
                    </button>
                  )}
                </div>
              </>
            )}
            {modal === "settings" && config && (
              <>
                <div className="settings-fields">
                  {(["ffmpeg", "ffprobe", "library"] as const).map((key) => (
                    <label key={key}>
                      {
                        {
                          ffmpeg: "FFmpeg 可执行文件",
                          ffprobe: "ffprobe 可执行文件",
                          library: "素材库",
                          output: "输出目录",
                        }[key]
                      }
                      <div className="path-row">
                        <span title={config[key]}>
                          {config[key] || "自动检测应用工具目录与 PATH"}
                        </span>
                        <button onClick={() => configure(key)}>选择</button>
                        {(key === "ffmpeg" || key === "ffprobe") &&
                          config[key] && (
                            <button
                              onClick={() =>
                                setConfig({ ...config, [key]: "" })
                              }
                            >
                              自动
                            </button>
                          )}
                      </div>
                      {(key === "ffmpeg" || key === "ffprobe") && (
                        <small
                          className={
                            tools?.[key].available ? "muted" : "warning"
                          }
                        >
                          {tools?.[key].version}
                        </small>
                      )}
                    </label>
                  ))}
                </div>
                <details>
                  <summary>数据位置与媒体信息</summary>
                  <p className="path-text">{data?.data_dir}</p>
                  {current && (
                    <pre>{JSON.stringify(current.metadata, null, 2)}</pre>
                  )}
                </details>
                <div className="hardware">
                  <button
                    disabled={detecting}
                    onClick={() =>
                      run(async () => {
                        setDetecting(true);
                        try {
                          setHardware(
                            await invoke<string[]>("detect_hardware"),
                          );
                        } finally {
                          setDetecting(false);
                        }
                      })
                    }
                  >
                    {detecting ? "正在实测编码器…" : "检测硬件编码"}
                  </button>
                  <span className="muted">
                    {hardware.length
                      ? hardware.join("、")
                      : "未检测或未发现可运行的硬件编码器；使用 CPU"}
                  </span>
                </div>
                <div className="modal-actions">
                  <span className="muted">不下载任何工具</span>
                  <button
                    className="primary"
                    onClick={() =>
                      run(async () => {
                        await invoke("save_settings", { value: config });
                        await refresh();
                        setTools(await invoke<Tools>("tool_status"));
                        setModal(null);
                      })
                    }
                  >
                    保存设置
                  </button>
                </div>
              </>
            )}
            {modal === "export" && (
              <>
                <p className="muted">
                  {selected.length} 局比赛 · 每局输出一个 MP4 文件
                </p>
                <div className="preset-row">
                  <label>
                    快捷预设
                    <select
                      aria-label="快捷预设"
                      value={presetId}
                      onChange={(e) => {
                        const p = preferences.presets.find(
                          (p) => p.id === e.target.value,
                        );
                        setPresetId(e.target.value);
                        if (p) {
                          setPreset(p.preset);
                          setPresetName(p.name);
                        }
                      }}
                    >
                      <option value="">自定义设置</option>
                      {preferences.presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    预设名称
                    <input
                      aria-label="预设名称"
                      placeholder="例如：B站 4K"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={!presetName.trim()}
                    onClick={() =>
                      run(async () => {
                        const id = crypto.randomUUID();
                        const next = {
                          ...preferences,
                          presets: [
                            ...preferences.presets,
                            {
                              id,
                              name: presetName.trim(),
                              preset: { ...preset },
                            },
                          ],
                        };
                        await persistPreferences(next);
                        setPresetId(id);
                      })
                    }
                  >
                    另存预设
                  </button>
                  <button
                    disabled={!presetId || !presetName.trim()}
                    onClick={() =>
                      run(async () => {
                        await persistPreferences({
                          ...preferences,
                          presets: preferences.presets.map((p) =>
                            p.id === presetId
                              ? {
                                  ...p,
                                  name: presetName.trim(),
                                  preset: { ...preset },
                                }
                              : p,
                          ),
                        });
                      })
                    }
                  >
                    更新预设
                  </button>
                </div>
                <div className="form-row">
                  <label>
                    分辨率
                    <select
                      value={`${preset.width}x${preset.height}`}
                      onChange={(e) => {
                        const [width, height] = e.target.value
                          .split("x")
                          .map(Number);
                        setPreset({ ...preset, width, height });
                      }}
                    >
                      <option value="3840x2160">3840 × 2160（4K）</option>
                      <option value="1920x1080">1920 × 1080</option>
                      <option value="1280x720">1280 × 720</option>
                    </select>
                  </label>
                  <label>
                    视频码率（kbps）
                    <input
                      type="number"
                      min="100"
                      max="100000"
                      value={preset.bitrate_kbps}
                      onChange={(e) =>
                        setPreset({ ...preset, bitrate_kbps: +e.target.value })
                      }
                    />
                  </label>
                </div>
                <details className="advanced-export">
                  <summary>自定义尺寸与音频</summary>
                  <div className="form-row">
                    <label>
                      自定义宽度
                      <input
                        aria-label="输出宽度"
                        type="number"
                        min="2"
                        max="7680"
                        step="2"
                        value={preset.width}
                        onChange={(e) =>
                          setPreset({ ...preset, width: +e.target.value })
                        }
                      />
                    </label>
                    <label>
                      自定义高度
                      <input
                        aria-label="输出高度"
                        type="number"
                        min="2"
                        max="4320"
                        step="2"
                        value={preset.height}
                        onChange={(e) =>
                          setPreset({ ...preset, height: +e.target.value })
                        }
                      />
                    </label>
                    <label>
                      音频码率（kbps）
                      <input
                        aria-label="音频码率"
                        type="number"
                        min="32"
                        max="512"
                        value={preset.audio_kbps}
                        onChange={(e) =>
                          setPreset({ ...preset, audio_kbps: +e.target.value })
                        }
                      />
                    </label>
                  </div>
                </details>
                <div className="form-row">
                  <label>
                    帧率
                    <select
                      value={String(preset.force_60)}
                      onChange={(e) =>
                        setPreset({
                          ...preset,
                          force_60: e.target.value === "true",
                        })
                      }
                    >
                      <option value="false">
                        跟随首个源素材（保留分数帧率）
                      </option>
                      <option value="true">强制 60 fps</option>
                    </select>
                  </label>
                  <label>
                    视频编码
                    <select
                      value={preset.codec}
                      onChange={(e) =>
                        setPreset({
                          ...preset,
                          codec: e.target.value as Preset["codec"],
                          encoder: "auto",
                        })
                      }
                    >
                      <option value="hevc">H.265 / HEVC（日常）</option>
                      <option value="h264">H.264 / AVC（兼容）</option>
                    </select>
                  </label>
                  <label>
                    编码器
                    <select
                      value={preset.encoder}
                      onChange={(e) =>
                        setPreset({ ...preset, encoder: e.target.value })
                      }
                    >
                      <option value="auto">自动（已实测硬件优先）</option>
                      <option
                        value={preset.codec === "hevc" ? "libx265" : "libx264"}
                      >
                        CPU · {preset.codec === "hevc" ? "H.265" : "H.264"}
                      </option>
                      {hardware
                        .filter((h) => h.startsWith(preset.codec + "_"))
                        .map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                    </select>
                  </label>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={preset.acknowledge_sdr}
                    onChange={(e) =>
                      setPreset({
                        ...preset,
                        acknowledge_sdr: e.target.checked,
                      })
                    }
                  />
                  我确认色彩信息缺失的素材为普通 SDR，非 HDR / D-Log
                </label>
                <p className="muted">
                  {preset.codec === "hevc" ? "H.265" : "H.264"} · AAC{" "}
                  {preset.audio_kbps} kbps · 保持比例并补边 ·
                  多音轨素材采用第一条音轨
                </p>
                <p className="muted">
                  输入帧率不同会统一为首个素材帧率。此预设不是 HandBrake
                  设置的完整复现。
                </p>
                <div className="export-preview">
                  <strong>输出目录</strong>
                  <p>{data?.settings.output}</p>
                  <button
                    onClick={() =>
                      run(async () => {
                        const path = await choose();
                        if (path && data) {
                          await invoke("save_settings", {
                            value: { ...data.settings, output: path },
                          });
                          await refresh();
                        }
                      })
                    }
                  >
                    更改输出目录
                  </button>
                  <p className="muted">
                    按日期建文件夹，按当天比赛时间编号：1-男单.mp4。缺少拍摄时间的记录按导入顺序排列，记录内按时间线排序。
                  </p>
                  {outputPreview.map((p) => (
                    <div key={p} title={p}>
                      {p.split(/[\\/]/).at(-1)}
                    </div>
                  ))}
                </div>
                <div className="modal-actions">
                  <span className="muted">只转码已标记区间</span>
                  <button
                    onClick={() =>
                      run(async () => {
                        await persistPreferences();
                        setModal(null);
                      })
                    }
                  >
                    保存导出设置
                  </button>
                  <button
                    className="primary"
                    disabled={!selected.length}
                    onClick={exportSelected}
                  >
                    <Download size={16} />
                    加入导出队列
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
