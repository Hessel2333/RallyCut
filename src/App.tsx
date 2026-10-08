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
  Job,
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
  timelineGaps,
} from "./timeline";
import { jobMatchesCurrent, remaining } from "./jobs";
import {
  LocalDialog,
  MediaInfo,
  SpeedMenu,
  NamePicker,
  outsideDialog,
} from "./EditorControls";
import {
  adjacentFrame,
  defaultTags,
  readPreference,
} from "./editorPreferences";
import { useMediaSeek } from "./mediaSeek";
import { SessionSaves } from "./sessionSaves";
import { PublicationPanel } from "./PublicationPanel";
import { ChapterEditor } from "./ChapterEditor";
import { ContinuityPanel, useContinuity } from "./ContinuityPanel";
import { sharePreset, sourceBounds, focusWindow, resizedMatch, crossingPairs } from "./editing";
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
  flushing: "正在完成写入",
};
const dateNow = () => new Date().toLocaleDateString("sv-SE");
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
  const [quickTags, setQuickTags] = useState<string[]>(() =>
    readPreference("rallycut-tags", defaultTags),
  );
  const [tagEditor, setTagEditor] = useState(false);
  const [tagText, setTagText] = useState("");
  const [stepSeconds, setStepSeconds] = useState<number>(() =>
    readPreference("rallycut-step", 4),
  );
  const [speed, setSpeed] = useState(1);
  const [panelWidths, setPanelWidths] = useState<[number, number]>(() =>
    readPreference("rallycut-panels", [210, 290]),
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [infoAsset, setInfoAsset] = useState<Asset | null>(null);
  const [removal, setRemoval] = useState<{
    kind: "session" | "asset" | "import";
    id: string;
    name: string;
  } | null>(null);
  const [removeError, setRemoveError] = useState("");
  useEffect(() => setRemoveError(""), [removal]);
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: "session" | "asset" | "match";
    id: string;
  } | null>(null);
  useEffect(() => {
    localStorage.setItem("rallycut-tags", JSON.stringify(quickTags));
  }, [quickTags]);
  useEffect(() => {
    localStorage.setItem("rallycut-step", JSON.stringify(stepSeconds));
  }, [stepSeconds]);
  useEffect(() => {
    localStorage.setItem("rallycut-panels", JSON.stringify(panelWidths));
  }, [panelWidths]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const [previews, setPreviews] = useState<
    { asset_id: string; path: string; kind: string }[]
  >([]);
  const [previewTask, setPreviewTask] = useState<{
    token: string;
    progress: number;
  } | null>(null);
  const [outputPreview, setOutputPreview] = useState<string[]>([]);
  const [data, setData] = useState<Snapshot>();
  const queueSequence = useRef(0);
  const knownJobs = useRef(new Set<string>());
  const jobPatches = useRef(new Map<string, { sequence: number; job: Partial<Job> }>());
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem("rallycut-session") ?? "",
  );
  const [tools, setTools] = useState<Tools>();
  const [error, setError] = useState("");
  const [, redrawSave] = useState(0);
  const [saves] = useState(() => new SessionSaves(
    value => invoke("save_session", { session: value }),
    () => redrawSave(n => n + 1),
  ));
  const saved = saves.status(sessionId);
  const [closePrompt, setClosePrompt] = useState<
    "settings" | "export" | "tags" | null
  >(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [exitError, setExitError] = useState<string | null>(null);
  const exiting = useRef(false);
  const exitRef = useRef<() => void>(() => {});
  const deferredTransition = useRef<(() => void) | null>(null);
  const transitionRef = useRef<(action: () => void) => void>(() => {});
  const [modal, setModal] = useState<"import" | "settings" | "export" | null>(
    null,
  );
  const [left, setLeft] = useState(true);
  const [queue, setQueue] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverNotice, setCoverNotice] = useState("");
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [publicationActive, setPublicationActive] = useState(false);
  const publicationGuard = useRef<(action: () => void) => void>(action => action());
  const [allJobs, setAllJobs] = useState(false);
  const queueDialog = useRef<HTMLDialogElement>(null);
  const [queueError, setQueueError] = useState("");
  const [queueBusy, setQueueBusy] = useState(false);
  useEffect(() => {
    if (!queue) return;
    const previous = document.activeElement as HTMLElement | null;
    queueDialog.current?.showModal();
    return () => previous?.focus();
  }, [queue]);
  const closeQueue = () => {
    setQueue(false);
    setQueueError("");
  };
  const queueRun = async (operation: () => Promise<unknown>) => {
    if (queueBusy) return;
    setQueueBusy(true);
    setQueueError("");
    try {
      await operation();
      await refresh(false);
    } catch (e) {
      setQueueError(String(e));
    } finally {
      setQueueBusy(false);
    }
  };
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    id: string;
    start: number;
    end: number;
  } | null>(null);
  const [markIn, setMarkIn] = useState(0);
  const [markOut, setMarkOut] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [focusRange, setFocusRange] = useState<{ start: number; end: number } | null>(null);
  const [shareClip, setShareClip] = useState<{ start_us: number; end_us: number } | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [continuityOpen, setContinuityOpen] = useState(false);
  const [mergeAction, setMergeAction] = useState<{ pairs: string[]; action: () => void } | null>(null);
  const timelineScroll = useRef<HTMLDivElement>(null);
  useEffect(() => { setFocusRange(null); setZoom(1); setChapterId(null); setContinuityOpen(false); setMergeAction(null); }, [sessionId]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState(defaultPreset);
  const [hardware, setHardware] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importDir, setImportDir] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [copy, setCopy] = useState(false);
  const [verifyCopy, setVerifyCopy] = useState(false);
  const [importName, setImportName] = useState("羽毛球");
  const [busy, setBusy] = useState(false);
  const [importDate, setImportDate] = useState(dateNow());
  const [manualDate, setManualDate] = useState(false);
  const [folderRule, setFolderRule] = useState("{date}-日常羽毛球");
  useEffect(() => {
    setFolderRule(data?.settings.folder_template || "{date}-日常羽毛球");
  }, [data?.settings.folder_template]);
  useEffect(() => {
    if (!paths[0] || manualDate) return;
    let active = true;
    invoke<number>("file_modified_ms", { path: paths[0] })
      .then((ms) => {
        if (active && typeof ms === "number")
          setImportDate(new Date(ms).toLocaleDateString("sv-SE"));
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [paths[0], manualDate]);
  useEffect(() => {
    const off = listen<string[]>("media-dropped", (e) => {
      if (busy) {
        setError("请等待当前导入完成后再拖入视频");
        return;
      }
      if (!e.payload.length) {
        setError("请拖入视频文件");
        return;
      }
      transitionRef.current(() => {
        setQueue(false);
        setModal("import");
        setError("");
        setManualDate(false);
        setPaths(e.payload);
        setImportDir(`已拖入 ${e.payload.length} 个视频`);
      });
    });
    return () => {
      void off.then((f) => f());
    };
  }, [busy]);

  const [importProgress, setImportProgress] = useState<any>();
  const importToken = useRef("");
  const [config, setConfig] = useState<Settings>();
  const [appearance, setAppearance] = useState("dark");
  useEffect(() => {
    setAppearance(data?.settings.theme || "dark");
  }, [data?.settings.theme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        appearance === "system"
          ? media.matches
            ? "dark"
            : "light"
          : appearance;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  const video = useRef<HTMLVideoElement>(null);
  const undo = useRef<Match[][]>([]);
  const redo = useRef<Match[][]>([]);
  const session = data?.sessions.find((s) => s.id === sessionId);
  const assets = (session?.asset_ids
    .map((id) => data?.assets.find((a) => a.id === id))
    .filter(Boolean) ?? []) as Asset[];
  const total = totalUs(assets);
  const current = assets[sourceIndex];
  const { reviews, retry: retryContinuity } = useContinuity(sessionId, assets);
  const timelineStart = focusRange?.start ?? 0;
  const timelineEnd = focusRange?.end ?? total;
  const timelineDuration = Math.max(1, timelineEnd - timelineStart);
  const timelineLeft = (time: number) => `${((time - timelineStart) / timelineDuration) * 100}%`;
  const clipped = (start: number, end: number) => ({
    left: timelineLeft(Math.max(timelineStart, start)),
    width: `${((Math.min(end, timelineEnd) - Math.max(start, timelineStart)) / timelineDuration) * 100}%`,
  });
  const visibleRange = (start: number, end: number) => end > timelineStart && start < timelineEnd;
  const focusClip = (start: number, end: number) => {
    setFocusRange(focusWindow(total, start, end)); setZoom(1);
    if (timelineScroll.current) timelineScroll.current.scrollLeft = 0;
  };
  const confirmMerge = (action: () => void) => {
    let matches = (session?.matches ?? []).filter(m => selected.includes(m.id));
    if (shareClip && modal === "export") {
      try { matches = [{ id: "share", name: "精彩片段", note: "", ranges: mapRange(assets, shareClip.start_us, shareClip.end_us) }]; }
      catch (e) { setError(String(e)); return; }
    }
    const pairs = crossingPairs(matches);
    if (pairs.length) setMergeAction({ pairs, action }); else action();
  };
  const offset = assets
    .slice(0, sourceIndex)
    .reduce((n, a) => n + a.duration_us, 0);
  const mediaPath = (asset: Asset) => previews.find(p => p.asset_id === asset.id && p.kind === "proxy")?.path ?? asset.path;
  const { pending, switchingSource, seeking, showSeekStatus, seekError, beginSeek, validMedia, failSeek, finishSeek } = useMediaSeek(video, sessionId, current, mediaPath, setPlaying, setError);
  const refresh = async (full = true) => {
    const checkpoint = saves.checkpoint();
    const startedAt = queueSequence.current;
    const v = await invoke<Snapshot>("snapshot");
    v.sessions = saves.merge(v.sessions, checkpoint);
    v.jobs = v.jobs.map(j => {
      const patch = jobPatches.current.get(j.id);
      return patch && patch.sequence > (v.queue_sequence ?? startedAt) ? { ...j, ...patch.job } : j;
    });
    knownJobs.current = new Set(v.jobs.map(j => j.id));
    for (const [id, patch] of jobPatches.current) if (patch.sequence <= (v.queue_sequence ?? startedAt)) jobPatches.current.delete(id);
    queueSequence.current = Math.max(queueSequence.current, v.queue_sequence ?? 0);
    if (v.queue_error) setQueueError(v.queue_error);
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
  const flushAndExit = async (discard = false) => {
    if (exiting.current) return;
    exiting.current = true;
    try {
      if (!discard) await saves.flush(true);
      await invoke("authorize_exit");
    } catch (e) { setExitError(String(e)); }
    finally { exiting.current = false; }
  };
  exitRef.current = () => {
    if (busy) void flushAndExit();
    else transitionRef.current(() => void flushAndExit());
  };
  useEffect(() => {
    const off = listen("exit-requested", () => exitRef.current());
    return () => { void off.then(f => f()); };
  }, []);
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
    let active = true;
    const jobsOff = listen<{ sequence: number; job: Pick<Job, "id" | "status" | "progress" | "speed" | "error" | "validation" | "output"> }>("job-update", e => {
      if (!active || e.payload.sequence <= queueSequence.current) return;
      const gap = e.payload.sequence > queueSequence.current + 1;
      queueSequence.current = e.payload.sequence;
      const job = e.payload.job;
      jobPatches.current.set(job.id, e.payload);
      setData(d => d ? { ...d, jobs: d.jobs.map(j => j.id === job.id ? { ...j, ...job } : j) } : d);
      if (gap || !knownJobs.current.has(job.id)) void refresh(false).catch(e => setQueueError(String(e)));
    });
    const faultOff = listen<string>("queue-error", e => { if (active) { setQueueError(e.payload); setError(e.payload); setData(d => d ? { ...d, paused: true } : d); } });
    const reconnect = () => { if (document.visibilityState === "visible") void refresh().catch(e => setError(String(e))); };
    document.addEventListener("visibilitychange", reconnect);
    const unlisten = listen("import-progress", (e) =>
      setImportProgress(e.payload),
    );
    const off = listen<{ token: string; progress: number }>(
      "preview-progress",
      (e) =>
        setPreviewTask((t) => (t?.token === e.payload.token ? e.payload : t)),
    );
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", reconnect);
      void jobsOff.then(f => f());
      void faultOff.then(f => f());
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
    setEditingId(null);
    setSelected([]);
    setPlaying(false);
    beginSeek(0, false, assets[0]);
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
    saves.edit(next);
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
    const local = Math.min(loc.local, Math.max(0, assets[loc.index].duration_us - 1000));
    beginSeek(local, auto && t < total, assets[loc.index]);
    if (
      video.current && validMedia(video.current) &&
      video.current &&
      video.current.readyState >= 1
    ) {
      try {
        video.current.dataset.seekRequest = String(pending.current?.id);
        video.current.currentTime = local / 1e6;
        finishSeek(video.current);
      } catch { failSeek("无法定位，请检查素材或生成预览代理。"); }
    } else {
      video.current?.pause();
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
      setEditingId(null);
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
    } else {
      const gap = timelineGaps(assets, session.matches).find(
        (g) => g.start < playhead && playhead <= g.end,
      );
      if (gap) {
        const start =
          markIn >= gap.start && markIn < playhead ? markIn : gap.start;
        try {
          const next = appendSegment(
            assets,
            session.matches,
            start,
            playhead,
            draftTag.trim() || "未命名",
            id,
          );
          saveMatches(next.matches);
          setEditingId(null);
          setMarkIn(playhead);
          setMarkOut(playhead);
          setSelected((s) => [...s, id]);
          setError("");
        } catch (e) {
          setError(String(e));
        }
      } else setError("请将播放位置移到区间内部");
    }
  };
  const history = (forward: boolean) => {
    if (!session) return;
    const from = forward ? redo.current : undo.current,
      to = forward ? undo.current : redo.current;
    const next = from.pop();
    if (next) {
      setEditingId(null);
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
        modal || publicationOpen ||
        document.querySelector("dialog[open]") ||
        target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      if (e.key === "Escape") {
        setContextMenu(null);
        return;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        deleteFocused();
        return;
      }
      if (["d", "f"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        stepFrame(e.key.toLowerCase() === "d" ? -1 : 1);
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        history(e.shiftKey);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key.toLowerCase() === "i") changeStart(playhead);
      else if (e.key.toLowerCase() === "o") changeEnd(playhead);
      else if (e.key === "Enter" && !editingId) addMatch();
      else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        cutHere();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seek(
          playhead +
            (e.key === "ArrowLeft" ? -1 : 1) *
              (e.shiftKey ? stepSeconds * 5e6 : stepSeconds * 1e6),
        );
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const prepare = (kind: string) =>
    run(async () => {
      if (!current) return;
      const previewVideo = video.current;
      const token = crypto.randomUUID();
      setPreviewTask({ token, progress: 0 });

      try {
        const p = await invoke<{
          asset_id: string;
          path: string;
          kind: string;
        }>("prepare_preview", { assetId: current.id, kind, token });
        if (
          kind === "proxy" &&
          !previews.some(
            (x) =>
              x.asset_id === p.asset_id &&
              x.kind === "proxy" &&
              x.path === p.path,
          ) &&
          video.current &&
          video.current === previewVideo
        ) {
          beginSeek(Math.round(video.current.currentTime * 1e6), !video.current.paused, current, p.path);
            }
        setPreviews((old) => [
          ...old.filter((x) => x.asset_id !== p.asset_id || x.kind !== p.kind),
          p,
        ]);
      } finally {
        setPreviewTask(null);
      }
    });
  useEffect(() => {
    if (modal === "export" && session && (selected.length || shareClip))
      void saves.flush()
        .then(() =>
          invoke<string[]>("enqueue", {
            sessionId: session.id,
            matchIds: selected,
            preset,
            dryRun: true,
            clip: shareClip,
          }),
        )
        .then(setOutputPreview)
        .catch((e) => setError(String(e)));
    else setOutputPreview([]);
  }, [
    modal,
    selected,
    shareClip,
    preset,
    session,
    data?.settings.output,
    data?.settings.folder_template,
  ]);
  const persistPreferences = async (next = preferences) => {
    const value = { ...next, current: preset };
    await invoke("save_export_preferences", { value });
    setPreferences(value);
  };
  const normalizedTags = () =>
    [
      ...new Set(
        tagText
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].slice(0, 50);
  const saveTags = () => {
    localStorage.setItem("rallycut-tags", JSON.stringify(normalizedTags()));
    setQuickTags(normalizedTags());
    setTagEditor(false);
  };
  const exportDirty = () =>
    JSON.stringify(preset) !== JSON.stringify(preferences.current) ||
    folderRule !== (data?.settings.folder_template || "{date}-日常羽毛球") ||
    presetName !==
      (preferences.presets.find((p) => p.id === presetId)?.name ?? "");
  const isDirty = (kind: typeof modal | "tags") =>
    kind === "tags" ? JSON.stringify(normalizedTags()) !== JSON.stringify(quickTags)
      : kind === "settings" ? JSON.stringify(config) !== JSON.stringify(data?.settings)
      : kind === "export" ? exportDirty() : false;
  const transition = (action: () => void) => {
    if (busy || closing || closePrompt) return;
    if (publicationOpen) { publicationGuard.current(() => { setPublicationOpen(false); action(); }); return; }
    const kind = tagEditor ? "tags" : modal;
    if (isDirty(kind)) {
      deferredTransition.current = action;
      setCloseError("");
      setClosePrompt(kind as "settings" | "export" | "tags");
    } else { setTagEditor(false); setModal(null); action(); }
  };
  transitionRef.current = transition;
  const finishTransition = () => {
    const action = deferredTransition.current;
    deferredTransition.current = null;
    action?.();
  };
  const cancelTransition = () => { deferredTransition.current = null; setClosePrompt(null); };
  const openModal = (kind: "import" | "settings" | "export") => transition(() => {
    if (kind === "settings") setConfig(data?.settings);
    setShareClip(null);
    setModal(kind);
  });
  const requestClose = (
    kind: "settings" | "export" | "tags" | "import" | null = modal,
  ) => {
    if (busy || closing) return;
    const dirty = isDirty(kind);
    if (dirty) {
      setCloseError("");
      setClosePrompt(kind as "settings" | "export" | "tags");
    } else if (kind === "tags") setTagEditor(false);
    else setModal(null);
  };
  const saveExportSettings = async () => {
    if (
      data &&
      folderRule !== (data.settings.folder_template || "{date}-日常羽毛球")
    ) {
      await invoke("save_settings", {
        value: { ...data.settings, folder_template: folderRule },
      });
      await refresh();
    }
    let next = preferences;
    if (
      presetName.trim() &&
      presetName !==
        (preferences.presets.find((p) => p.id === presetId)?.name ?? "")
    ) {
      const id = presetId || crypto.randomUUID();
      const named = { id, name: presetName.trim(), preset: { ...preset } };
      next = {
        ...preferences,
        presets: presetId
          ? preferences.presets.map((p) => (p.id === id ? named : p))
          : [...preferences.presets, named],
      };
      setPresetId(id);
    }
    await persistPreferences(next);
  };
  const saveBeforeClose = async () => {
    if (closing) return;
    setClosing(true);
    setCloseError("");
    try {
      if (closePrompt === "tags") saveTags();
      else if (closePrompt === "settings") {
        await invoke("save_settings", { value: config });
        await refresh();
        setTools(await invoke<Tools>("tool_status"));
        setModal(null);
      } else {
        await saveExportSettings();
        setModal(null);
      }
      setClosePrompt(null);
      finishTransition();
    } catch (e) {
      setCloseError(String(e));
    } finally {
      setClosing(false);
    }
  };
  const discardAndClose = () => {
    if (closePrompt === "tags") setTagEditor(false);
    else {
      setPreset(preferences.current);
      setPresetId("");
      setPresetName("");
      setFolderRule(data?.settings.folder_template || "{date}-日常羽毛球");
      setModal(null);
    }
    setClosePrompt(null);
    finishTransition();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        modal &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const choose = () =>
    invoke<string | null>("choose_path", { kind: "directory" });
  const scan = () =>
    run(async () => {
      const p = await choose();
      if (p) {
        setImportDir(p);
        setManualDate(false);
        setPaths(await invoke<string[]>("scan_directory", { path: p }));
      }
    });
  const selectVideos = () =>
    run(async () => {
      const selectedPaths = await invoke<string[] | null>("choose_video_files");
      if (selectedPaths?.length) {
        setManualDate(false);
        setPaths(selectedPaths);
        setImportDir(`已选择 ${selectedPaths.length} 个视频`);
      }
    });
  const doImport = () =>
    run(async () => {
      setBusy(true);
      importToken.current = crypto.randomUUID();
      try {
        const captureDate = manualDate
          ? importDate
          : new Date(
              await invoke<number>("file_modified_ms", { path: paths[0] }),
            ).toLocaleDateString("sv-SE");
        const id = await invoke<string>("import_session", {
          paths,
          copy,
          verifyCopy,
          name: importName,
          date: captureDate,
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
    openModal("settings");
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
      await saves.flush();
      await saveExportSettings();
      await invoke("enqueue", {
        sessionId: session.id,
        matchIds: selected,
        preset,
        clip: shareClip,
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
        session!.matches.map((x) => (x.id === m.id ? resizedMatch(assets, x, ranges) : x)),
      );
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const editingMatch = session?.matches.find((m) => m.id === editingId);
  const editBounds = editingMatch ? bounds(assets, editingMatch.ranges) : null;
  const shownStart = editBounds?.start ?? markIn;
  const shownEnd = editBounds?.end ?? markOut;
  const changeStart = (value: number) =>
    editingMatch
      ? updateBoundary(editingMatch, value, shownEnd)
      : setMarkIn(value);
  const changeEnd = (value: number) =>
    editingMatch
      ? updateBoundary(editingMatch, shownStart, value)
      : setMarkOut(value);
  const chooseGap = (start: number, end: number) => {
    setEditingId(null);
    setMarkIn(start);
    setMarkOut(end);
    seek(start, false);
  };
  const dragBoundary = (
    e: React.PointerEvent<HTMLButtonElement>,
    m: Match,
    side: "start" | "end",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const handle = e.currentTarget;
    const rect = handle.closest(".timeline")!.getBoundingClientRect();
    const original = bounds(assets, m.ranges);
    const others = session!.matches
      .filter((x) => x.id !== m.id)
      .map((x) => bounds(assets, x.ranges));
    const min = Math.max(
      0,
      ...others.filter((x) => x.end <= original.start).map((x) => x.end),
    );
    const max = Math.min(
      total,
      ...others.filter((x) => x.start >= original.end).map((x) => x.start),
    );
    let next = { ...original };
    setEditingId(m.id);
    handle.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const t = Math.round(timelineStart + ((event.clientX - rect.left) / rect.width) * timelineDuration);
      next =
        side === "start"
          ? {
              start: Math.max(min, Math.min(original.end - 1000, t)),
              end: original.end,
            }
          : {
              start: original.start,
              end: Math.min(max, Math.max(original.start + 1000, t)),
            };
      setDragPreview({ id: m.id, ...next });
    };
    const finish = (event: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      setDragPreview(null);
      if (
        event.type === "pointerup" &&
        (next.start !== original.start || next.end !== original.end)
      )
        updateBoundary(m, next.start, next.end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };
  const removeMatch = (id: string) => {
    const m = session?.matches.find((x) => x.id === id);
    if (!m || !session) return;
    const b = bounds(assets, m.ranges);
    saveMatches(session.matches.filter((x) => x.id !== id));
    setSelected((ids) => ids.filter((x) => x !== id));
    setDeleteTarget(null);
    chooseGap(b.start, b.end);
  };
  const deleteFocused = () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === "match") removeMatch(deleteTarget.id);
    else if (deleteTarget.kind === "session") {
      const found = data?.sessions.find((x) => x.id === deleteTarget.id);
      if (found)
        setRemoval({ kind: "session", id: found.id, name: found.name });
    } else {
      const found = assets.find((x) => x.id === deleteTarget.id);
      if (found) setRemoval({ kind: "asset", id: found.id, name: found.name });
    }
  };
  const confirmRemoval = async () => {
    if (!removal || busy) return;
    setBusy(true);
    setRemoveError("");
    try {
      await saves.flush();
      if (removal.kind === "import") {
        setPaths((paths) => paths.filter((p) => p !== removal.id));
        setRemoval(null);
        return;
      }
      if (removal.kind === "session")
        await invoke("delete_session", { sessionId: removal.id });
      else
        await invoke("remove_session_asset", {
          sessionId,
          assetId: removal.id,
        });
      undo.current = [];
      redo.current = [];
      setEditingId(null);
      setDeleteTarget(null);
      setPlayhead(0);
      setSourceIndex(0);
      setMarkIn(0);
      setMarkOut(0);
      beginSeek(0, false, assets[0]);
      video.current?.pause();
      setPlaying(false);
      if (video.current && video.current.readyState >= 1) {
        video.current.currentTime = 0;
        finishSeek(video.current);
      }
      await refresh();
      setRemoval(null);
    } catch (e) {
      setRemoveError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const stepFrame = (direction: number) => {
    try {
      video.current?.pause();
      seek(adjacentFrame(assets, playhead, direction), false);
    } catch (e) {
      setError(String(e));
    }
  };
  const resizePanel = (e: React.PointerEvent<HTMLDivElement>, side: number) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const x = e.clientX;
    const width = panelWidths[side];
    const move = (ev: PointerEvent) =>
      setPanelWidths((old) => {
        const next: [number, number] = [...old];
        next[side] = Math.round(
          Math.max(
            side === 0 ? 170 : 220,
            Math.min(
              side === 0 ? 360 : 460,
              width + (ev.clientX - x) * (side === 0 ? 1 : -1),
            ),
          ),
        );
        return next;
      });
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const scrubTimeline = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!total || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    el.setPointerCapture(e.pointerId);
    const rect = el.closest(".timeline")!.getBoundingClientRect();
    const auto = playing;
    let frame = 0;
    let target = timelineStart + ((e.clientX - rect.left) / rect.width) * timelineDuration;
    const move = (ev: PointerEvent) => {
      target = timelineStart + ((ev.clientX - rect.left) / rect.width) * timelineDuration;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; seek(target, auto); });
    };
    seek(target, auto);
    const end = () => {
      if (frame) { cancelAnimationFrame(frame); seek(target, auto); }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };
  const activeJobs =
    data?.jobs.filter(
      (j) =>
        !["completed", "cancelled", "failed", "interrupted"].includes(j.status),
    ).length ?? 0;
  if (!isTauri())
    return (
      <div className="browser-notice">
        <img src="/app-icon.png" width={48} height={48} alt="" />
        <h1>RallyCut</h1>
        <p>请从桌面应用打开，以访问本地素材。</p>
        <code>npm run tauri dev</code>
      </div>
    );
  return (
    <div className="app">
      <header className="appbar">
        <div className="brand">
          <img src="/app-icon.png" width={28} height={28} alt="" />
          <strong>RallyCut</strong>
        </div>
        <div className="header-center">
          {session?.name ?? "工作区"}
          {session && <small>{session.date}</small>}
        </div>
        <button onClick={() => openModal("export")} title="查看和保存导出设置">
          导出设置
        </button>
        <button onClick={() => transition(() => { confirmMerge(() => { setQueue(false); setPublicationOpen(true); }); })}>B 站发布</button>
        <UpdateCenter
          blocked={
            busy || !!previewTask || detecting || activeJobs > 0 || !!modal || publicationActive || publicationOpen
          }
          beforeInstall={async () => {
            await saves.flush();
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
            openModal("export");
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
      <div
        className={`workspace ${left ? "" : "collapsed"}`}
        style={
          {
            "--left-width": `${panelWidths[0]}px`,
            "--right-width": `${panelWidths[1]}px`,
          } as React.CSSProperties
        }
      >
        {left && (
          <aside className="library">
            <div
              className="panel-resizer right"
              role="separator"
              aria-label="调整拍摄列表宽度"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(e) => resizePanel(e, 0)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  e.stopPropagation();
                  setPanelWidths(([l, r]) => [
                    Math.max(
                      170,
                      Math.min(360, l + (e.key === "ArrowLeft" ? -10 : 10)),
                    ),
                    r,
                  ]);
                }
              }}
            />
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
              onClick={() => openModal("import")}
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
                    onClick={() => {
                      setSessionId(s.id);
                      setDeleteTarget({ kind: "session", id: s.id });
                    }}
                    onFocus={() =>
                      setDeleteTarget({ kind: "session", id: s.id })
                    }
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
                    disabled={busy}
                    onClick={() => {
                      setRemoveError("");
                      setRemoval({ kind: "session", id: s.id, name: s.name });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="library-bottom">
              <div
                className="theme-switch"
                role="group"
                aria-label="外观主题"
                style={
                  {
                    "--theme-index": ["light", "dark", "system"].indexOf(
                      appearance,
                    ),
                  } as React.CSSProperties
                }
              >
                <span className="theme-thumb" aria-hidden="true" />
                {(
                  [
                    ["light", "浅色"],
                    ["dark", "深色"],
                    ["system", "系统"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={appearance === value}
                    onClick={() =>
                      void run(async () => {
                        await invoke("set_theme_preference", { theme: value });
                        setAppearance(value);
                        await refresh();
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
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
              {saved === "保存失败" && <button onClick={() => void run(() => saves.flush(true))}>重试保存</button>}
            </span>
          </div>
          <div
            className="viewer"
            onContextMenu={(e) => {
              e.preventDefault();
              if (current)
                setContextMenu({
                  x: Math.min(e.clientX, window.innerWidth - 245),
                  y: Math.min(e.clientY, window.innerHeight - 340),
                });
            }}
          >
            {seekError && <div className="seek-status" role="alert">{seekError}<button onClick={() => { seek(playhead, false); video.current?.load(); }}>重试定位</button></div>}
            {showSeekStatus && current?.available && (
              <span className="seek-status seeking" role="status">
                正在定位…
              </span>
            )}
            {current ? (
              current.available ? (
                <video
                  key={
                    sessionId + ":" + current.id +
                    (previews.find(
                      (p) => p.asset_id === current.id && p.kind === "proxy",
                    )?.path ?? current.path)
                  }
                  style={{ visibility: switchingSource || seekError ? "hidden" : "visible" }}
                  preload="auto"
                  playsInline
                  ref={video}
                  data-asset-id={current.id}
                  data-session-id={sessionId}
                  data-path={mediaPath(current)}
                  src={convertFileSrc(
                    previews.find(
                      (p) => p.asset_id === current.id && p.kind === "proxy",
                    )?.path ?? current.path,
                  )}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (!validMedia(v)) return;
                    v.playbackRate = speed;
                    if (pending.current) {
                      try {
                        v.dataset.seekRequest = String(pending.current.id);
                        v.currentTime = pending.current.local / 1e6;
                        finishSeek(v);
                      } catch { failSeek("无法定位，请重试或生成预览代理。"); }
                    }
                  }}
                  onLoadedData={(e) => finishSeek(e.currentTarget)}
                  onCanPlay={(e) => finishSeek(e.currentTarget)}
                  onSeeked={(e) => finishSeek(e.currentTarget)}
                  onTimeUpdate={() => {
                    if (video.current && !pending.current)
                      setPlayhead(
                        offset +
                          Math.min(
                            current.duration_us,
                            Math.round(video.current.currentTime * 1e6),
                          ),
                      );
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => {
                    if (!pending.current) setPlaying(false);
                  }}
                  onEnded={() => {
                    if (sourceIndex < assets.length - 1) {
                      seek(offset + current.duration_us, true);
                    } else setPlaying(false);
                  }}
                  onError={(e) => {
                    if (e.currentTarget !== video.current) return;
                    failSeek("当前素材无法播放或定位，请重试或生成预览代理。");
                  }}
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
                <button className="primary" onClick={() => openModal("import")}>
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
              <button title="上一帧（D）" disabled={!current} onClick={() => stepFrame(-1)}>‹ 帧</button>
              <button
                title={`后退 ${stepSeconds} 秒`}
                disabled={!current}
                onClick={() => seek(playhead - stepSeconds * 1e6)}
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
                title={`前进 ${stepSeconds} 秒`}
                disabled={!current}
                onClick={() => seek(playhead + stepSeconds * 1e6)}
              >
                <SkipForward size={17} />
              </button>
            </div>
            <button title="下一帧（F）" disabled={!current} onClick={() => stepFrame(1)}>帧 ›</button>
            <button disabled={!current?.available || seeking || !!seekError || coverBusy}
              onClick={() => {
                const media = video.current;
                if (!current || !media || media.readyState < 2) return;
                media.pause();
                const assetId = current.id;
                const timeUs = Math.round(media.currentTime * 1e6);
                setCoverBusy(true); setCoverNotice("");
                void invoke("capture_cover_candidate", { sessionId, assetId, timeUs })
                  .then(() => setCoverNotice("已加入封面备选"))
                  .catch(e => setError(String(e).includes("not found") ? "请在当前投稿处理完成后重新启动新版应用，再添加封面备选。" : String(e)))
                  .finally(() => setCoverBusy(false));
              }}>{coverBusy ? "正在保存封面…" : "加入封面备选"}</button>
            {coverNotice && <span className="muted" role="status">{coverNotice}</span>}
            <SpeedMenu
              value={speed}
              change={(n) => {
                setSpeed(n);
                if (video.current) video.current.playbackRate = n;
              }}
            />
          </div>
          <section className="timeline-panel">
            <div className="timeline-toolbar">
              <strong>{focusRange ? "片段精调" : "统一时间线"}</strong>
              {assets.length > 1 && <button onClick={() => setContinuityOpen(true)}>检查衔接 · {Object.keys(reviews).length}/{assets.length - 1}</button>}
              <button disabled={!total} onClick={() => focusClip(shownEnd > shownStart ? shownStart : playhead, shownEnd > shownStart ? shownEnd : playhead + 10e6)}>放大选区</button>
              <button disabled={!total} onClick={() => focusClip(playhead - 5e6, playhead + 5e6)}>精调 15 秒</button>
              {focusRange && <button onClick={() => { setFocusRange(null); setZoom(1); }}>查看全片</button>}
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
            <div className="timeline-scroll" ref={timelineScroll}>
              <div
                className="timeline"
                style={{ width: `${zoom * 100}%` }}
                tabIndex={0}
                onPointerDown={scrubTimeline}
              >
                <div className="ruler">
                  {Array.from({ length: 9 }, (_, i) => (
                    <span key={i}>
                      {timecode(Math.floor(timelineStart + (timelineDuration * i) / 8)).slice(0, focusRange ? 12 : 8)}
                    </span>
                  ))}
                </div>
                <div className="source-track">
                  {assets.map((a, i) => {
                    const start = totalUs(assets.slice(0, i)), end = start + a.duration_us;
                    if (!visibleRange(start, end)) return null;
                    return <div
                      key={a.id}
                      tabIndex={0}
                      onFocus={() =>
                        setDeleteTarget({ kind: "asset", id: a.id })
                      }
                      onPointerDown={() =>
                        setDeleteTarget({ kind: "asset", id: a.id })
                      }
                      style={{ ...clipped(start, end), position: "absolute", height: "100%" }}
                      onDoubleClick={(e) => { e.stopPropagation(); chooseGap(start, end); focusClip(start, end); }}
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
                    </div>;
                  })}
                </div>
                <div className="match-track">
                  {timelineGaps(assets, session?.matches ?? []).filter(g => visibleRange(g.start, g.end)).map((g) => (
                    <button
                      key={g.start}
                      className="gap-block"
                      title="选择空档，添加一局"
                      aria-label={`选择空档 ${timecode(g.start)}—${timecode(g.end)}`}
                      style={clipped(g.start, g.end)}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => chooseGap(g.start, g.end)}
                    >
                      +
                    </button>
                  ))}
                  {session?.matches.map((m, i) => {
                    const b =
                      dragPreview?.id === m.id
                        ? dragPreview
                        : bounds(assets, m.ranges);
                    if (!visibleRange(b.start, b.end)) return null;
                    return (
                      <div
                        title={`${m.name} · 双击放大选区`}
                        onDoubleClick={() => focusClip(b.start, b.end)}
                        key={m.id}
                        className={`match-block ${editingId === m.id ? "editing" : ""}`}
                        tabIndex={0}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          scrubTimeline(e);
                        }}
                        onClick={() => {
                          setEditingId(m.id);
                          setDeleteTarget({ kind: "match", id: m.id });
                        }}
                        style={clipped(b.start, b.end)}
                      >
                        <button
                          className="segment-handle start"
                          style={{ visibility: b.start < timelineStart ? "hidden" : "visible" }}
                          aria-label={`调整${m.name}开始`}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => dragBoundary(e, m, "start")}
                        />
                        <button
                          className="segment-handle end"
                          style={{ visibility: b.end > timelineEnd ? "hidden" : "visible" }}
                          aria-label={`调整${m.name}结束`}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => dragBoundary(e, m, "end")}
                        />
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
                      style={{ left: timelineLeft(playhead), display: playhead < timelineStart || playhead > timelineEnd ? "none" : undefined }}
                    />
                    <div
                      className="draft-range"
                      style={visibleRange(shownStart, shownEnd) ? clipped(shownStart, shownEnd) : { display: "none" }}
                    />
                    <input
                      className="boundary start"
                      style={{ visibility: shownStart < timelineStart || shownStart > timelineEnd ? "hidden" : "visible" }}
                      title="拖动开始边界"
                      aria-label="拖动开始边界"
                      type="range"
                      min={timelineStart}
                      max={timelineEnd}
                      step="1000"
                      value={shownStart}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => changeStart(+e.target.value)}
                    />
                    <input
                      className="boundary end"
                      style={{ visibility: shownEnd < timelineStart || shownEnd > timelineEnd ? "hidden" : "visible" }}
                      title="拖动结束边界"
                      aria-label="拖动结束边界"
                      type="range"
                      min={timelineStart}
                      max={timelineEnd}
                      step="1000"
                      value={shownEnd}
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => changeEnd(+e.target.value)}
                    />
                  </>
                )}
              </div>
            </div>
            <div className="mark-toolbar">
              {editingMatch && (
                <>
                  <span>编辑：{editingMatch.name}</span>
                  <button onClick={() => chooseGap(shownEnd, shownEnd)}>
                    完成编辑
                  </button>
                </>
              )}
              <button
                className="primary"
                disabled={!current}
                onClick={cutHere}
                title="在播放位置分段（S）"
              >
                在此分段 <kbd>S</kbd>
              </button>
              <button disabled={!current} onClick={() => changeStart(playhead)}>
                设为开始 <kbd>I</kbd>
              </button>
              <button disabled={!current} title="开始对齐所选区间首个原片的开头" onClick={() => changeStart(sourceBounds(assets, shownStart).start)}>原片开头</button>
              <ClockInput
                label="开始时间"
                value={shownStart}
                onChange={changeStart}
              />
              <button disabled={!current} onClick={() => changeEnd(playhead)}>
                设为结束 <kbd>O</kbd>
              </button>
              <button disabled={!current} title="结束对齐所选区间最后一个原片的结尾" onClick={() => changeEnd(sourceBounds(assets, shownEnd > shownStart ? shownEnd : playhead, shownEnd > shownStart).end)}>原片结尾</button>
              <ClockInput
                label="结束时间"
                value={shownEnd}
                onChange={changeEnd}
              />
              <button
                className="primary"
                disabled={!current || !!editingMatch || markOut <= markIn}
                onClick={() => addMatch()}
              >
                <Plus size={15} />
                添加一局
              </button>
            </div>
            <div className="editing-actions source-actions">
              <button disabled={!current} onClick={() => {
                if (editingMatch) updateBoundary(editingMatch, offset, offset + current.duration_us);
                else { setMarkIn(offset); setMarkOut(offset + current.duration_us); }
              }}>选取当前原片</button>
              <button disabled={!current} onClick={() => seek(offset, false)}>跳到原片开头</button>
              <button disabled={!current} onClick={() => seek(offset + current.duration_us - 1000, false)}>跳到原片结尾</button>
              <button disabled={!session || shownEnd <= shownStart} onClick={() => transition(() => {
                setPreset({ ...sharePreset }); setPresetId(""); setPresetName("");
                setShareClip({ start_us: shownStart, end_us: shownEnd }); setModal("export");
              })}>分享选区 · 1080p</button>
              <button disabled={!current || playhead >= total} onClick={() => transition(() => {
                setPreset({ ...sharePreset }); setPresetId(""); setPresetName("");
                setShareClip({ start_us: playhead, end_us: Math.min(total, playhead + 10e6) }); setModal("export");
              })}>从此处截取 10 秒</button>
              {shownEnd > shownStart && <small>选区 {((shownEnd - shownStart) / 1e6).toFixed(2)} 秒</small>}
            </div>
            <div className="tag-toolbar">
              <button
                onClick={() => {
                  setTagText(quickTags.join("\n"));
                  setTagEditor(true);
                }}
              >
                管理标签
              </button>
              <span>{editingMatch ? "片段标签" : "下一段标签"}</span>
              <input
                aria-label="下一段标签"
                value={editingMatch?.name ?? draftTag}
                onChange={(e) =>
                  editingMatch
                    ? saveMatches(
                        session!.matches.map((m) =>
                          m.id === editingId
                            ? { ...m, name: e.target.value }
                            : m,
                        ),
                      )
                    : setDraftTag(e.target.value)
                }
              />
              {quickTags.map((tag) => (
                <button
                  key={tag}
                  className={
                    (editingMatch?.name ?? draftTag) === tag ? "active" : ""
                  }
                  onClick={() =>
                    editingMatch
                      ? saveMatches(
                          session!.matches.map((m) =>
                            m.id === editingId ? { ...m, name: tag } : m,
                          ),
                        )
                      : setDraftTag(tag)
                  }
                >
                  {tag}
                </button>
              ))}
            </div>
          </section>
        </main>
        <aside className="matches">
          <div
            className="panel-resizer left"
            role="separator"
            aria-label="调整分段列表宽度"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={(e) => resizePanel(e, 1)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                e.stopPropagation();
                setPanelWidths(([l, r]) => [
                  l,
                  Math.max(
                    220,
                    Math.min(460, r + (e.key === "ArrowLeft" ? 10 : -10)),
                  ),
                ]);
              }
            }}
          />
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
                  <article
                    className={`match-item ${editingId === m.id ? "editing" : ""}`}
                    key={m.id}
                    tabIndex={0}
                    onFocus={() => setDeleteTarget({ kind: "match", id: m.id })}
                    onClick={(e) => {
                      if (
                        !(e.target as HTMLElement).closest(
                          "input,button,textarea,select,summary",
                        )
                      ) {
                        setEditingId(m.id);
                        setDeleteTarget({ kind: "match", id: m.id });
                      }
                    }}
                  >
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
                      <NamePicker
                        label={`比赛${i + 1}名称`}
                        value={m.name}
                        tags={quickTags}
                        change={(name) =>
                          saveMatches(
                            session.matches.map((x) =>
                              x.id === m.id ? { ...x, name } : x,
                            ),
                          )
                        }
                      />
                      <button
                        className="icon"
                        title="删除比赛标记"
                        onClick={() => removeMatch(m.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="segment-summary">
                      <span>
                        {timecode(b.start).slice(0, 8)} —{" "}
                        {timecode(b.end).slice(0, 8)}
                      </span>
                      <span>{timecode(b.end - b.start).slice(3, 8)}</span>
                    </div>
                    <div className="editing-actions">
                      <button onClick={() => { setEditingId(m.id); focusClip(b.start, b.end); }}>精调</button>
                      <button onClick={() => setChapterId(m.id)}>章节{m.chapters?.length ? ` · ${m.chapters.length}` : ""}</button>
                      {m.ranges.length > 1 && <button onClick={() => setContinuityOpen(true)}>跨 {m.ranges.length} 个原片</button>}
                    </div>
                    {!!m.chapters?.length && <div className="chapter-jumps" aria-label={`${m.name}章节跳转`}>
                      {m.chapters.map((c, index) => <button key={index} title={c.title} onClick={() => { setEditingId(m.id); seek(b.start + c.offset_us, false); }}>{timecode(c.offset_us).slice(3, 8)} {c.title}</button>)}
                    </div>}
                    <details className="segment-extra">
                      <summary>备注与精确时间</summary>
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
                      <input
                        className="note"
                        placeholder="比分或备注"
                        aria-label="比分或备注"
                        value={m.note}
                        onChange={(e) =>
                          saveMatches(
                            session.matches.map((x) =>
                              x.id === m.id
                                ? { ...x, note: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                    </details>
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
              onClick={() => openModal("export")}
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
        <dialog
          ref={queueDialog}
          onClick={(e) => {
            if (outsideDialog(e)) closeQueue();
          }}
          className="queue"
          aria-labelledby="queue-title"
          onCancel={(e) => {
            e.preventDefault();
            if (!queueBusy) closeQueue();
          }}
        >
          <div className="panel-heading">
            <strong id="queue-title">导出任务</strong>
            <select
              aria-label="任务范围"
              value={allJobs ? "all" : "session"}
              disabled={queueBusy}
              onChange={(e) => setAllJobs(e.target.value === "all")}
            >
              <option value="session">当前拍摄</option>
              <option value="all">全部任务</option>
            </select>
            <span className="muted">
              {data?.paused ? "已暂停启动后续任务" : "按顺序处理 · 每次一局"}
            </span>
            <button
              disabled={queueBusy}
              onClick={() =>
                queueRun(async () => {
                  await invoke("queue_action", {
                    action: data?.paused ? "resume" : "pause",
                  });
                })
              }
            >
              {data?.paused ? "继续队列" : "暂停队列"}
            </button>
            <button
              className="icon"
              title="关闭导出任务"
              aria-label="关闭导出任务"
              disabled={queueBusy}
              onClick={closeQueue}
            >
              <X size={18} />
            </button>
          </div>
          <div className="queue-toolbar">
            <span className="muted">
              {allJobs ? "全部拍摄" : (session?.name ?? "当前拍摄")} ·{" "}
              {data?.jobs.filter((j) => allJobs || j.session_id === sessionId)
                .length ?? 0}{" "}
              条任务
            </span>
            <button
              disabled={
                queueBusy ||
                !data?.jobs.some(
                  (j) =>
                    (allJobs || j.session_id === sessionId) &&
                    [
                      "completed",
                      "failed",
                      "cancelled",
                      "interrupted",
                    ].includes(j.status),
                )
              }
              onClick={() =>
                queueRun(() =>
                  invoke("delete_export_jobs", {
                    jobIds:
                      data?.jobs
                        .filter(
                          (j) =>
                            (allJobs || j.session_id === sessionId) &&
                            [
                              "completed",
                              "failed",
                              "cancelled",
                              "interrupted",
                            ].includes(j.status),
                        )
                        .map((j) => j.id) ?? [],
                  }),
                )
              }
            >
              清除已结束记录
            </button>
          </div>
          {queueError && (
            <p className="queue-message warning" role="alert">
              {queueError}
            </p>
          )}
          <div className="queue-list" aria-label="导出任务列表">
            {!data?.jobs.filter((j) => allJobs || j.session_id === sessionId)
              .length ? (
              <p className="muted">还没有导出任务。标记比赛后即可导出。</p>
            ) : (
              [...data.jobs]
                .filter((j) => allJobs || j.session_id === sessionId)
                .reverse()
                .map((j) => (
                  <div className="job" key={j.id} data-job-id={j.id}>
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
                      {!j.segment.id.startsWith("clip-") && !jobMatchesCurrent(
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
                    <fieldset className="job-actions" disabled={queueBusy}>
                      {["failed", "cancelled", "interrupted"].includes(
                        j.status,
                      ) ? (
                        <button
                          onClick={() =>
                            queueRun(() =>
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
                              queueRun(() =>
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
                      {[
                        "completed",
                        "failed",
                        "cancelled",
                        "interrupted",
                      ].includes(j.status) && (
                        <button
                          className="icon"
                          aria-label={`删除任务记录：${j.segment.name}`}
                          title="删除记录，保留视频"
                          onClick={() =>
                            queueRun(() =>
                              invoke("delete_export_jobs", { jobIds: [j.id] }),
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </fieldset>
                  </div>
                ))
            )}
          </div>
        </dialog>
      )}
      {contextMenu && (
        <div
          className="video-menu"
          role="menu"
          aria-label="视频菜单"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              toggle();
              setContextMenu(null);
            }}
          >
            {playing ? "暂停" : "播放"} <kbd>Space</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              stepFrame(-1);
              setContextMenu(null);
            }}
          >
            上一帧 <kbd>D</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              stepFrame(1);
              setContextMenu(null);
            }}
          >
            下一帧 <kbd>F</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              changeStart(playhead);
              setContextMenu(null);
            }}
          >
            设为开始 <kbd>I</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              changeEnd(playhead);
              setContextMenu(null);
            }}
          >
            设为结束 <kbd>O</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setInfoAsset(current);
              setContextMenu(null);
            }}
          >
            原始素材信息
          </button>
          <button
            role="menuitem"
            disabled={!!previewTask}
            onClick={() => {
              void prepare("proxy");
              setContextMenu(null);
            }}
          >
            生成预览代理
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setRemoval({ kind: "asset", id: current.id, name: current.name });
              setContextMenu(null);
            }}
          >
            从拍摄中移除此素材
          </button>
        </div>
      )}
      {infoAsset && (
        <MediaInfo asset={infoAsset} close={() => setInfoAsset(null)} />
      )}
      {tagEditor && (
        <LocalDialog title="管理快捷标签" close={() => requestClose("tags")}>
          <label className="tag-editor">
            每行一个标签
            <textarea
              aria-label="快捷标签列表"
              rows={8}
              value={tagText}
              onChange={(e) => setTagText(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setTagText(defaultTags.join("\n"))}>
              恢复默认
            </button>
            <button className="primary" onClick={() => void run(async () => saveTags())}>
              保存标签
            </button>
          </div>
        </LocalDialog>
      )}
      {removal && (
        <LocalDialog
          title={removal.kind === "session" ? "删除拍摄记录？" : "移除素材？"}
          close={() => {
            if (!busy) {
              setRemoval(null);
              setRemoveError("");
            }
          }}
        >
          <p>{removal.name}</p>
          <p>
            {removal.kind === "session"
              ? "此记录及其片段标记将被删除。"
              : removal.kind === "import"
                ? "此文件将从待导入列表移除。"
                : "此素材将从当前拍摄移除，引用它的 " +
                  (session?.matches.filter((m) =>
                    m.ranges.some((r) => r.asset_id === removal.id),
                  ).length ?? 0) +
                  " 个片段标记也将删除。其余素材和标记保留。"}
          </p>
          <p className="muted">磁盘上的原始视频和已导出视频均保留。</p>
          {removeError && <p role="alert">{removeError}</p>}
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setRemoval(null)}>
              取消
            </button>
            <button
              disabled={busy}
              className="primary"
              onClick={() => void confirmRemoval()}
            >
              {busy ? "处理中…" : "确认删除"}
            </button>
          </div>
        </LocalDialog>
      )}
      {(continuityOpen || mergeAction) && <ContinuityPanel assets={assets} reviews={reviews} retry={retryContinuity} seek={us => seek(us, false)} close={() => { setContinuityOpen(false); setMergeAction(null); }} pairs={mergeAction?.pairs} proceed={mergeAction ? () => { const action = mergeAction.action; setMergeAction(null); action(); } : undefined} />}
      {chapterId && session?.matches.some(m => m.id === chapterId) && (() => {
        const m = session.matches.find(m => m.id === chapterId)!;
        const b = bounds(assets, m.ranges);
        return <ChapterEditor match={m} duration={b.end - b.start} position={playhead - b.start} close={() => setChapterId(null)} seek={us => seek(b.start + us, false)} change={chapters => saveMatches(session.matches.map(x => x.id === m.id ? { ...x, chapters } : x))} />;
      })()}
      <PublicationPanel open={publicationOpen} close={() => setPublicationOpen(false)} sessionId={sessionId} selected={selected} preset={preset} beforeCreate={() => saves.flush()} guardRef={publicationGuard} activeChanged={setPublicationActive} />
      {exitError !== null && <LocalDialog title="标记尚未保存" close={() => setExitError(null)}>
        <p role="alert">{exitError}</p>
        <div className="modal-actions">
          <button onClick={() => setExitError(null)}>取消退出</button>
          <button onClick={() => void flushAndExit(true)}>放弃未保存标记并退出</button>
          <button onClick={() => void flushAndExit()}>重试保存并退出</button>
        </div>
      </LocalDialog>}
      {closePrompt && (
        <LocalDialog
          title="保存更改？"
          close={() => {
            if (!closing) cancelTransition();
          }}
        >
          <p>有尚未保存的更改，要保存后再关闭吗？</p>
          {closeError && <p role="alert">{closeError}</p>}
          <div className="modal-actions">
            <button disabled={closing} onClick={cancelTransition}>
              继续编辑
            </button>
            <button disabled={closing} onClick={discardAndClose}>
              不保存
            </button>
            <button
              disabled={closing}
              className="primary"
              onClick={() => void saveBeforeClose()}
            >
              {closing ? "保存中…" : "保存并关闭"}
            </button>
          </div>
        </LocalDialog>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) requestClose();
          }}
        >
          <section
            className={`modal ${modal === "import" ? "wide" : ""} ${modal === "export" ? "export-modal" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-title">
              <h2>
                {modal === "import"
                  ? "导入一次拍摄"
                  : modal === "settings"
                    ? "设置"
                    : "导出设置"}
              </h2>
              <button
                className="icon"
                aria-label="关闭"
                disabled={busy}
                onClick={() => requestClose()}
              >
                <X size={20} />
              </button>
            </div>
            {error && (
              <p className="modal-error" role="alert">
                {error}
              </p>
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
                      onClick={(e) => {
                        try {
                          e.currentTarget.showPicker();
                        } catch {
                          /* Keyboard entry remains available. */
                        }
                      }}
                      value={importDate}
                      onChange={(e) => {
                        setManualDate(true);
                        setImportDate(e.target.value);
                      }}
                      disabled={busy}
                    />
                  </label>
                </div>
                <div className="path-row">
                  <span title={importDir}>
                    {importDir || "选择视频或拖入窗口，可多选"}
                  </span>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={selectVideos}
                  >
                    <Film size={16} />
                    选择视频
                  </button>
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
                    ? "复制到素材库，原文件保持不变。"
                    : "直接使用当前位置的文件，请保留素材。"}{" "}
                  按文件名自然排序，请确认拍摄顺序。
                </p>
                {copy && (
                  <label className="update-toggle">
                    <input
                      type="checkbox"
                      checked={verifyCopy}
                      disabled={busy}
                      onChange={(e) => setVerifyCopy(e.target.checked)}
                    />
                    复制后完整校验（更耗时）
                  </label>
                )}
                <div className="scan-list">
                  {paths.map((p, i) => (
                    <div
                      key={p}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" && !busy) {
                          e.preventDefault();
                          e.stopPropagation();
                          setRemoval({
                            kind: "import",
                            id: p,
                            name: p.split(/[\\/]/).at(-1) ?? p,
                          });
                        }
                      }}
                    >
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
                          setRemoval({
                            kind: "import",
                            id: p,
                            name: p.split(/[\\/]/).at(-1) ?? p,
                          })
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
                  <label>
                    左右方向键步进（秒）
                    <input
                      aria-label="方向键步进秒数"
                      type="number"
                      min="0.1"
                      max="120"
                      step="0.1"
                      value={stepSeconds}
                      onChange={(e) => {
                        const n = +e.target.value;
                        if (n >= 0.1 && n <= 120) setStepSeconds(n);
                      }}
                    />
                  </label>
                  <small>
                    D / F 上一帧、下一帧 · Shift + 方向键按 5 倍时长跳转
                  </small>
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
                  {shareClip ? "导出独立分享片段，保留原有比赛标记。" : selected.length
                    ? `已选 ${selected.length} 个片段，每段保存为一个 MP4 文件`
                    : "设置常用的导出画质与保存位置"}
                </p>
                {shareClip && <div className="share-clip-range">
                  <ClockInput label="分享开始" value={shareClip.start_us} onChange={start_us => setShareClip({ ...shareClip, start_us })} />
                  <ClockInput label="分享结束" value={shareClip.end_us} onChange={end_us => setShareClip({ ...shareClip, end_us })} />
                  <span>预计约 {Math.max(0, (shareClip.end_us - shareClip.start_us) / 1e6 * (preset.bitrate_kbps + preset.audio_kbps) / 8000).toFixed(1)} MB</span>
                </div>}
                <h3 className="export-heading">导出预设</h3>
                <div className="editing-actions">
                  <button onClick={() => { setPreset({ ...sharePreset }); setPresetId(""); setPresetName(""); }}>微信分享 · 1080p / 60 fps / 6 Mbps</button>
                </div>
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
                  <details className="preset-save">
                    <summary>保存为快捷预设</summary>
                    <div className="preset-row">
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
                  </details>
                </div>
                <h3 className="export-heading">画质</h3>
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
                      <option value="false">与原片一致</option>
                      <option value="true">60 fps</option>
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
                      <option value="auto">自动 · 优先显卡</option>
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
                <details className="advanced-export">
                  <summary>色彩与音轨</summary>
                  <p className="muted">
                    普通视频保持原色彩；HDR 或 D-Log
                    暂不支持。无法识别色彩时，请确认来源后再勾选。
                  </p>
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
                    色彩信息缺失时，按普通 SDR 视频处理
                  </label>
                  <p className="muted">
                    {preset.codec === "hevc" ? "H.265" : "H.264"} · AAC{" "}
                    {preset.audio_kbps} kbps · 保持比例并补边 ·
                    多音轨素材采用第一条音轨
                  </p>
                  <p className="muted">多个原片帧率不同时，以首个原片为准。</p>
                </details>
                <h3 className="export-heading">保存位置</h3>
                <div className="export-preview">
                  <details className="folder-rule">
                    <summary>文件夹命名规则</summary>
                    <label>
                      文件夹名称
                      <input
                        value={folderRule}
                        onChange={(e) => setFolderRule(e.target.value)}
                      />
                    </label>
                    <p className="muted">
                      {"{date}"} 为拍摄日期，{"{name}"}{" "}
                      为拍摄名称。示例：2026.09.23-日常羽毛球
                    </p>
                    <button
                      onClick={() =>
                        run(async () => {
                          if (!data) return;
                          await invoke("save_settings", {
                            value: {
                              ...data.settings,
                              folder_template: folderRule,
                            },
                          });
                          await refresh();
                        })
                      }
                    >
                      保存命名规则
                    </button>
                  </details>
                  <strong>保存到</strong>
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
                    片段按时间顺序编号，例如：1-男单.mp4。
                  </p>
                  {outputPreview.map((p) => (
                    <div key={p} title={p}>
                      {p.split(/[\\/]/).at(-1)}
                    </div>
                  ))}
                </div>
                <div className="modal-actions">
                  <span className="muted">
                    {shareClip ? "1 个分享片段" : selected.length
                      ? `${selected.length} 个片段`
                      : "尚未选择片段"}
                  </span>
                  <button
                    onClick={() =>
                      run(async () => {
                        await saveExportSettings();
                        setModal(null);
                      })
                    }
                  >
                    保存导出设置
                  </button>
                  <button
                    className="primary"
                    disabled={!selected.length && !shareClip}
                    onClick={() => confirmMerge(exportSelected)}
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
