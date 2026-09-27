import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LocalDialog } from "./EditorControls";
import {
  publicationStatus as status,
  type PublicationDraft,
  type PublicationSnapshot,
  type UploadPart,
} from "./publicationTypes";
import { CoverPicker } from "./CoverPicker";
import type { Preset } from "./types";

function uploadSize(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Math.max(0, bytes),
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function PublicationPanel({
  open,
  close,
  sessionId,
  selected,
  preset,
  beforeCreate,
  guardRef,
  activeChanged,
}: {
  open: boolean;
  close: () => void;
  sessionId: string;
  selected: string[];
  preset: Preset;
  beforeCreate: () => Promise<void>;
  guardRef: MutableRefObject<(action: () => void) => void>;
  activeChanged: (active: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<PublicationSnapshot>({
    drafts: [],
    artifacts: [],
    uploads: [],
    publications: [],
    active: false,
  });
  const [draft, setDraft] = useState<PublicationDraft>();
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const accountRequest = useRef(0);
  const [account, setAccount] = useState<{ id: string; name: string }>();
  const [categories, setCategories] = useState<{ id: number; name: string }[]>(
    [],
  );
  const [qr, setQr] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [loginState, setLoginState] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [transition, setTransition] = useState<(() => void) | null>(null);
  const [coverTime, setCoverTime] = useState(0);
  const [manualAid, setManualAid] = useState("");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const active = working || snapshot.active;
  const publication = snapshot.publications.find(
    (p) => p.draft_id === draft?.id,
  );
  const locked = active || !!publication;
  const partsUploaded =
    !!draft?.parts.length &&
    draft.parts.every((p) =>
      snapshot.uploads.some(
        (u) =>
          u.draft_id === draft.id &&
          u.part_id === p.id &&
          u.artifact_id === p.artifact_id &&
          u.status === "uploaded",
      ),
    );
  const submitBlock =
    !draft || publication
      ? ""
      : active
        ? "请等待当前操作完成。"
        : !account
          ? "请先登录 B 站。"
          : !draft.title.trim()
            ? "请填写投稿标题。"
            : !draft.category
              ? partsUploaded
                ? "请选择投稿分区，无需重新上传文件。"
                : "请选择投稿分区。"
              : !draft.parts.length
                ? "请先添加分 P。"
                : !partsUploaded
                  ? "请先完成所有分 P 的上传。"
                  : "";

  const load = async () => {
    const value = await invoke<PublicationSnapshot>("publication_snapshot");
    if (!value) return;
    if (
      !Array.isArray(value.drafts) ||
      !Array.isArray(value.artifacts) ||
      !Array.isArray(value.uploads) ||
      !Array.isArray(value.publications)
    )
      throw Error("发布记录读取失败，请重试");
    setSnapshot(value);
    activeChanged(value.active);
    if (!dirtyRef.current && draftRef.current) {
      const latest = value.drafts.find((d) => d.id === draftRef.current!.id);
      if (latest) {
        setDraft(latest);
        setSaved(JSON.stringify(latest));
      }
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void loadRef.current().catch((e) => {
      if (alive) setError(String(e));
    });
    const off = listen("publication-update", () => {
      if (alive) void loadRef.current().catch((e) => setError(String(e)));
    });
    const progress = listen<UploadPart>("upload-progress", (e) => {
      if (alive)
        setSnapshot((s) => ({
          ...s,
          uploads: s.uploads.some((p) => p.id === e.payload.id)
            ? s.uploads.map((p) => (p.id === e.payload.id ? e.payload : p))
            : [...s.uploads, e.payload],
        }));
    });
    return () => {
      alive = false;
      void off.then((f) => f());
      void progress.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (!open || !isTauri()) return;
    void loadRef.current().catch((e) => setError(String(e)));
    const request = ++accountRequest.current;
    void invoke<{ id: string; name: string }>("publication_account")
      .then(async (value) => {
        if (request !== accountRequest.current) return;
        setAccount(value);
        try {
          const items = await invoke<{ id: number; name: string }[]>(
            "publication_categories",
          );
          if (request === accountRequest.current) setCategories(items);
        } catch (e) {
          if (request === accountRequest.current) setError(String(e));
        }
      })
      .catch(() => {
        if (request === accountRequest.current) {
          setAccount(undefined);
          setCategories([]);
        }
      });
    return () => {
      accountRequest.current++;
    };
  }, [open]);
  const run = async (action: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
      await load().catch((e) => setError(String(e)));
    }
  };
  const selectDraft = (next: PublicationDraft) => {
    setDraft(next);
    setSaved(JSON.stringify(next));
    setConfirm(false);
    setError("");
  };
  const protect = (action: () => void) => {
    if (confirm || transition) return;
    if (dirty) setTransition(() => action);
    else action();
  };
  guardRef.current = protect;
  const save = async () => {
    if (!draft) return;
    const value = await invoke<PublicationDraft>("publication_save", { draft });
    selectDraft(value);
    return value;
  };
  const createFromArtifacts = () => {
    const artifacts = picked
      .map((id) => snapshot.artifacts.find((a) => a.id === id)!)
      .filter(Boolean);
    selectDraft({
      id: crypto.randomUUID(),
      revision: 0,
      account_id: null,
      title: artifacts[0]?.segment?.name || "羽毛球比赛",
      description: "",
      cover_path: "",
      category: 0,
      tags: "羽毛球",
      visibility: "public",
      status: "draft",
      error: "",
      parts: artifacts.map((a, i) => ({
        id: crypto.randomUUID(),
        artifact_id: a.id,
        job_id: null,
        name: a.segment?.name || `第 ${i + 1} 局`,
      })),
    });
    setSaved("");
  };
  const edit = (change: Partial<PublicationDraft>) =>
    setDraft((d) => (d ? { ...d, ...change } : d));
  const checkAccount = async () => {
    const request = ++accountRequest.current;
    const value = await invoke<{ id: string; name: string }>(
      "publication_account",
    );
    if (request !== accountRequest.current) return;
    setAccount(value);
    const items = await invoke<{ id: number; name: string }[]>(
      "publication_categories",
    );
    if (request === accountRequest.current) setCategories(items);
  };
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) protect(close);
      }}
    >
      <section
        className="modal publication-panel"
        role="dialog"
        aria-label="B 站发布"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            protect(close);
          }
        }}
      >
        <div className="modal-title">
          <h2>B 站发布</h2>
          <button aria-label="关闭发布面板" onClick={() => protect(close)}>
            ×
          </button>
        </div>
        <div className="publication-account">
          <span>
            {account ? `${account.name}（${account.id}）` : "尚未检查登录状态"}
          </span>
          <button disabled={active} onClick={() => void run(checkAccount)}>
            检查登录
          </button>
          <button
            disabled={active}
            onClick={() =>
              void run(async () => {
                setQrLoading(true);
                setQr("");
                setLoginState("正在获取二维码…");
                try {
                  setQr(await invoke("publication_login"));
                  setLoginState("请用哔哩哔哩 App 扫码");
                } catch (e) {
                  setLoginState("");
                  throw e;
                } finally {
                  setQrLoading(false);
                }
              })
            }
          >
            {qrLoading ? "正在获取二维码…" : "扫码登录"}
          </button>
          {account && (
            <button
              disabled={active}
              onClick={() =>
                void run(async () => {
                  accountRequest.current++;
                  await invoke("publication_logout");
                  setAccount(undefined);
                  setCategories([]);
                  setLoginState("已清除本机凭据；平台侧登录状态请在 B 站管理");
                })
              }
            >
              退出登录
            </button>
          )}
        </div>
        {qr && (
          <div className="publication-qr">
            <img src={qr} width="180" height="180" alt="B 站登录二维码" />
            <button
              disabled={active}
              onClick={() =>
                void run(async () => {
                  const value = await invoke<{
                    id: string;
                    name: string;
                  } | null>("publication_poll_login");
                  if (value) {
                    accountRequest.current++;
                    setAccount(value);
                    setQr("");
                    setLoginState("登录成功");
                    setCategories(await invoke("publication_categories"));
                  } else setLoginState("等待扫码与确认");
                })
              }
            >
              我已扫码，检查登录
            </button>
            <button onClick={() => setQr("")}>收起二维码</button>
          </div>
        )}
        {loginState && <p role="status">{loginState}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="publication-layout">
          <aside className="publication-library">
            <button
              disabled={active || !selected.length}
              onClick={() =>
                protect(
                  () =>
                    void run(async () => {
                      await beforeCreate();
                      const value = await invoke<PublicationDraft>(
                        "publication_from_matches",
                        { sessionId, matchIds: selected, preset },
                      );
                      selectDraft(value);
                    }),
                )
              }
            >
              用所选比赛创建草稿（{selected.length}）
            </button>
            <p className="muted">
              缺少的成片按当前 {preset.codec === "hevc" ? "H.265" : "H.264"}{" "}
              预设导出
            </p>
            <h3>投稿草稿</h3>
            {snapshot.drafts.map((d) => (
              <button
                key={d.id}
                className={draft?.id === d.id ? "active" : ""}
                onClick={() => protect(() => selectDraft(d))}
              >
                {d.title || "未命名投稿"}
                <small>
                  {
                    status[
                      snapshot.publications.find((p) => p.draft_id === d.id)
                        ?.status || d.status
                    ]
                  }
                </small>
              </button>
            ))}
            <h3>已有成片</h3>
            <button
              disabled={active}
              onClick={() =>
                void run(async () => {
                  const path = await invoke<string | null>("choose_path", {
                    kind: "file",
                  });
                  if (path)
                    await invoke("publication_import_artifact", {
                      path,
                      artifactId: null,
                    });
                })
              }
            >
              导入既有成片
            </button>
            {snapshot.artifacts.map((a) => (
              <div className="artifact-row" key={a.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(a.id)}
                    onChange={(e) =>
                      setPicked((ids) =>
                        e.target.checked
                          ? [...ids, a.id]
                          : ids.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.segment?.name || a.path.split(/[\\/]/).pop()}
                  <small>
                    {a.codec.toUpperCase()} · {(a.duration_us / 1e6).toFixed(1)}{" "}
                    秒{a.availability !== "available" ? " · 不可用" : ""}
                  </small>
                </label>
                <button
                  title="重新定位成片"
                  disabled={active}
                  onClick={() =>
                    void run(async () => {
                      const path = await invoke<string | null>("choose_path", {
                        kind: "file",
                      });
                      if (path)
                        await invoke("publication_import_artifact", {
                          path,
                          artifactId: a.id,
                        });
                    })
                  }
                >
                  定位
                </button>
              </div>
            ))}
            <button
              disabled={!picked.length || active}
              onClick={() => protect(createFromArtifacts)}
            >
              用勾选成片新建草稿
            </button>
          </aside>
          <div className="publication-editor">
            {!draft ? (
              <p>选择比赛或已有成片，创建投稿草稿。</p>
            ) : (
              <>
                <div className="publication-state">
                  {status[publication?.status || draft.status]}
                  {dirty ? " · 有未保存修改" : ""}
                </div>
                {(draft.error || publication?.error) && (
                  <p role="alert">{publication?.error || draft.error}</p>
                )}
                <fieldset disabled={locked}>
                  <label>
                    标题
                    <input
                      aria-label="投稿标题"
                      value={draft.title}
                      onChange={(e) => edit({ title: e.target.value })}
                    />
                  </label>
                  <label>
                    简介
                    <textarea
                      aria-label="投稿简介"
                      value={draft.description}
                      onChange={(e) => edit({ description: e.target.value })}
                    />
                  </label>
                  <label>
                    标签
                    <input
                      aria-label="投稿标签"
                      value={draft.tags}
                      onChange={(e) => edit({ tags: e.target.value })}
                    />
                  </label>
                  <label>
                    分区
                    <select
                      aria-label="投稿分区"
                      value={draft.category}
                      onChange={(e) =>
                        edit({ category: Number(e.target.value) })
                      }
                    >
                      <option value={0}>
                        {!account
                          ? "检查登录后选择分区"
                          : categories.length
                            ? "请选择投稿分区"
                            : "分区未加载，请检查登录重试"}
                      </option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>可见性：公开（确认提交后由平台审核）</p>
                  <div className="publication-cover">
                    <button
                      onClick={() =>
                        void run(async () => {
                          const path = await invoke<string | null>(
                            "choose_path",
                            { kind: "file" },
                          );
                          if (path) { await invoke("cover_preview", { path }).catch(e => { if (!String(e).includes("not found")) throw e; }); edit({ cover_path: path }); }
                        })
                      }
                    >
                      选择封面
                    </button>
                    <label>
                      首 P 封面时间（秒）
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={coverTime}
                        onChange={(e) => setCoverTime(Number(e.target.value))}
                      />
                    </label>
                    <button
                      disabled={!draft.parts[0]?.artifact_id}
                      onClick={() =>
                        void run(async () => {
                          const path = await invoke<string>(
                            "publication_capture_cover",
                            {
                              artifactId: draft.parts[0].artifact_id,
                              timeUs: Math.round(coverTime * 1e6),
                            },
                          );
                          edit({ cover_path: path });
                        })
                      }
                    >
                      取此帧作封面
                    </button>
                    {draft.cover_path && (
                      <>
                        <span>{draft.cover_path.split(/[\\/]/).pop()}</span>
                        <button onClick={() => edit({ cover_path: "" })}>
                          移除封面
                        </button>
                      </>
                    )}
                  </div>
                  <CoverPicker sessionId={sessionId} value={draft.cover_path} disabled={locked} change={(path) => edit({ cover_path: path })} />
                  <h3>分 P 顺序</h3>
                  {draft.parts.map((part, i) => {
                    const upload = snapshot.uploads.find(
                      (u) => u.draft_id === draft.id && u.part_id === part.id,
                    );
                    const artifact = snapshot.artifacts.find(
                      (a) => a.id === part.artifact_id,
                    );
                    return (
                      <div key={part.id} className="publication-part">
                        <span>P{i + 1}</span>
                        <label>
                          <input
                            aria-label={`P${i + 1} 名称`}
                            value={part.name}
                            onChange={(e) =>
                              edit({
                                parts: draft.parts.map((p) =>
                                  p.id === part.id
                                    ? { ...p, name: e.target.value }
                                    : p,
                                ),
                              })
                            }
                          />
                          <small>
                            {upload
                              ? status[upload.status]
                              : artifact
                                ? `${artifact.codec.toUpperCase()} · 可上传`
                                : "等待成片"}
                          </small>
                          {upload?.error && (
                            <small role="alert">{upload.error}</small>
                          )}
                          {upload?.status === "uploading" && (
                            <div
                              className="publication-upload-progress"
                              aria-label={`P${i + 1} 上传进度`}
                            >
                              <span>
                                {upload.total > 0
                                  ? Math.min(
                                      100,
                                      (upload.bytes / upload.total) * 100,
                                    ).toFixed(1)
                                  : "0.0"}
                                % · {uploadSize(upload.bytes)} /{" "}
                                {uploadSize(upload.total)}
                              </span>
                              <progress
                                aria-label={`P${i + 1} 已上传字节`}
                                max={Math.max(1, upload.total)}
                                value={upload.bytes}
                              />
                              {upload.bytes === 0 && (
                                <small>正在准备文件并连接上传服务器…</small>
                              )}
                              {upload.bytes >= upload.total &&
                                upload.total > 0 && (
                                  <small>正在等待平台确认文件…</small>
                                )}
                            </div>
                          )}
                        </label>
                        <button
                          aria-label={`上移 P${i + 1}`}
                          disabled={i === 0}
                          onClick={() => {
                            const parts = [...draft.parts];
                            [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]];
                            edit({ parts });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`下移 P${i + 1}`}
                          disabled={i === draft.parts.length - 1}
                          onClick={() => {
                            const parts = [...draft.parts];
                            [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]];
                            edit({ parts });
                          }}
                        >
                          ↓
                        </button>
                      </div>
                    );
                  })}
                </fieldset>
                {submitBlock && (
                  <p id="publication-submit-help" role="status">
                    {submitBlock}
                  </p>
                )}
                <div className="modal-actions">
                  {!publication && (
                    <>
                      <button
                        disabled={locked || !dirty}
                        onClick={() => void run(save)}
                      >
                        保存草稿
                      </button>
                      <button
                        disabled={locked || !account}
                        onClick={() =>
                          void run(async () => {
                            const value = dirty ? await save() : draft;
                            if (value)
                              await invoke("publication_upload", {
                                draftId: value.id,
                                reuploadUnverified: false,
                              });
                          })
                        }
                      >
                        上传 / 重试失败分 P
                      </button>
                      {snapshot.uploads.some(
                        (u) =>
                          u.draft_id === draft.id &&
                          u.status === "uploaded_unverified",
                      ) && (
                        <button
                          disabled={locked}
                          onClick={() =>
                            void run(async () => {
                              if (dirty) await save();
                              await invoke("publication_upload", {
                                draftId: draft.id,
                                reuploadUnverified: true,
                              });
                            })
                          }
                        >
                          重新上传待核对分 P
                        </button>
                      )}
                      <button
                        disabled={locked || !!submitBlock}
                        aria-describedby={
                          submitBlock ? "publication-submit-help" : undefined
                        }
                        onClick={() =>
                          void run(async () => {
                            if (dirty) await save();
                            setConfirm(true);
                          })
                        }
                      >
                        确认投稿…
                      </button>
                    </>
                  )}
                  {active && !publication && (
                    <button
                      onClick={() =>
                        void invoke("publication_cancel", {
                          draftId: draft.id,
                        }).catch((e) => setError(String(e)))
                      }
                    >
                      取消上传
                    </button>
                  )}
                  {publication && (
                    <>
                      <button
                        disabled={active}
                        onClick={() =>
                          void run(() =>
                            invoke("publication_check", {
                              publicationId: publication.id,
                            }),
                          )
                        }
                      >
                        查询平台状态
                      </button>
                      <button
                        onClick={() =>
                          void run(() =>
                            invoke("publication_open", {
                              publicationId: publication.id,
                            }),
                          )
                        }
                      >
                        {publication.aid ? "打开稿件" : "打开创作中心核对"}
                      </button>
                    </>
                  )}
                </div>
                {publication?.status === "unknown" && (
                  <div className="publication-resolution">
                    <label>
                      已核对稿件的 AV 号
                      <input
                        aria-label="关联稿件 AV 号"
                        inputMode="numeric"
                        value={manualAid}
                        onChange={(e) => setManualAid(e.target.value)}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={manualConfirmed}
                        onChange={(e) => setManualConfirmed(e.target.checked)}
                      />
                      我已在创作中心确认这是本次投稿
                    </label>
                    <button
                      disabled={
                        active || !manualConfirmed || !/^\d+$/.test(manualAid)
                      }
                      onClick={() =>
                        void run(() =>
                          invoke("publication_resolve", {
                            publicationId: publication.id,
                            aid: Number(manualAid),
                            userConfirmed: manualConfirmed,
                          }),
                        )
                      }
                    >
                      关联已核对稿件
                    </button>
                  </div>
                )}
                {publication?.platform_status && (
                  <p>
                    {publication.platform_status}
                    {publication.checked_ms
                      ? ` · ${new Date(publication.checked_ms).toLocaleString()}`
                      : ""}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </section>
      {confirm && draft && account && (
        <LocalDialog title="确认公开投稿" close={() => setConfirm(false)}>
          <p>
            使用 {account.name}（{account.id}）提交「{draft.title}」，共{" "}
            {draft.parts.length} P。
          </p>
          <p>可见性：公开。平台审核通过后可公开观看。</p>
          <div className="modal-actions">
            <button onClick={() => setConfirm(false)}>返回修改</button>
            <button
              disabled={active}
              className="primary"
              onClick={() => {
                setConfirm(false);
                void run(() =>
                  invoke("publication_submit", {
                    draftId: draft.id,
                    expectedRevision: draft.revision,
                    confirmedAccount: account.id,
                  }),
                );
              }}
            >
              确认提交稿件
            </button>
          </div>
        </LocalDialog>
      )}
      {transition && (
        <LocalDialog title="保存投稿草稿？" close={() => setTransition(null)}>
          {error && <p role="alert">{error}</p>}
          <p>草稿有尚未保存的修改。</p>
          <div className="modal-actions">
            <button onClick={() => setTransition(null)}>继续编辑</button>
            <button
              onClick={() => {
                setDraft(saved ? JSON.parse(saved) : undefined);
                const action = transition;
                setTransition(null);
                action();
              }}
            >
              不保存
            </button>
            <button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await save();
                  const action = transition;
                  setTransition(null);
                  action();
                })
              }
            >
              保存并继续
            </button>
          </div>
        </LocalDialog>
      )}
    </div>
  );
}
