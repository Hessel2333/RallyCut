import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type Candidate = { id: string; path: string; name: string; time_us: number };
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
  sessionId,
  value,
  disabled,
  change,
}: {
  sessionId: string;
  value: string;
  disabled: boolean;
  change: (path: string) => void;
}) {
  const [items, setItems] = useState<Candidate[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void invoke<Candidate[]>("cover_candidates", { sessionId })
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
  }, [sessionId]);
  return (
    <section className="cover-picker" aria-label="投稿封面">
      {value && (
        <div className="cover-selected">
          <CoverImage key={value} path={value} alt="投稿封面预览" />
        </div>
      )}
      <h4>封面备选</h4>
      {error ? (
        <p className="muted">{error}</p>
      ) : !items.length ? (
        <p className="muted">在剪辑页停在喜欢的画面，点击“加入封面备选”。</p>
      ) : (
        <div className="cover-candidates">
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={disabled}
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
