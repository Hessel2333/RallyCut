import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type Candidate = {
  id: string;
  session_id?: string;
  path: string;
  name: string;
  time_us: number;
};
export function CoverImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setSrc("");
    setError("");
    void invoke<string>("cover_preview", { path })
      .then((value) => {
        if (alive) setSrc(value);
      })
      .catch((e) => {
        if (alive) {
          if (String(e).includes("not found")) setSrc(convertFileSrc(path));
          else setError(String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [path]);
  return error ? (
    <span className="muted">{error}</span>
  ) : src ? (
    <img
      src={src}
      alt={alt}
      onError={() => setError("图片无法显示，请重新选择封面")}
    />
  ) : (
    <span className="muted">正在加载封面…</span>
  );
}
export function CoverPicker({
  sessionIds,
  value,
  disabled,
  change,
}: {
  sessionIds: string[];
  value: string;
  disabled: boolean;
  change: (path: string) => void;
}) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{
    path: string;
    source: string;
    scope: string;
    sessionId: string;
  }>();
  const scope = JSON.stringify(sessionIds);
  const result =
    exported?.source === value && exported.scope === scope
      ? exported
      : undefined;
  useEffect(() => {
    let alive = true;
    setItems([]);
    setError("");
    void invoke<Candidate[]>("cover_candidates", {
      sessionIds: JSON.parse(scope),
    })
      .then((v) => {
        if (alive) {
          setItems(v ?? []);
          setError("");
        }
      })
      .catch(() => {
        if (alive) setError("封面备选暂时无法加载");
      });
    return () => {
      alive = false;
    };
  }, [scope]);
  return (
    <section className="cover-picker" aria-label="投稿封面">
      {value && (
        <div className="cover-selected">
          <CoverImage key={value} path={value} alt="投稿封面预览" />
        </div>
      )}
      <div className="cover-export-actions">
        <button
          type="button"
          disabled={disabled || exporting}
          onClick={async () => {
            setError("");
            try {
              const path = await invoke<string | null>("choose_path", {
                kind: "file",
              });
              if (path) {
                await invoke("cover_preview", { path });
                change(path);
              }
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          选择封面图片
        </button>
        <button
          type="button"
          disabled={!value || !sessionIds.length || exporting}
          onClick={async () => {
            setExporting(true);
            setError("");
            setExported(undefined);
            try {
              const sessionId =
                items.find((item) => item.path === value)?.session_id ||
                sessionIds[0];
              const path = await invoke<string>("export_cover", {
                path: value,
                sessionId,
              });
              setExported({ path, source: value, scope, sessionId });
            } catch (e) {
              setError(String(e));
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "正在导出封面…" : "导出封面到日期文件夹"}
        </button>
        {result && (
          <button
            type="button"
            onClick={() => {
              void invoke("open_session_output", {
                sessionId: result.sessionId,
              }).catch((e) => setError(String(e)));
            }}
          >
            打开日期文件夹
          </button>
        )}
      </div>
      {result && (
        <p className="muted" role="status">
          封面已导出：{result.path}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <h4>封面备选</h4>
      {!items.length ? (
        <p className="muted">在剪辑页停在喜欢的画面，点击“加入封面备选”。</p>
      ) : (
        <div className="cover-candidates">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={disabled || exporting}
              aria-label={`选择封面备选：${item.name}`}
              aria-pressed={value === item.path}
              onClick={() => change(item.path)}
            >
              <CoverImage path={item.path} alt={`${item.name} 封面备选`} />
              <span>
                {item.name} · {(item.time_us / 1e6).toFixed(1)} 秒
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
