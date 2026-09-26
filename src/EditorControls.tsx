import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Asset } from "./types";
export function outsideDialog(e: React.MouseEvent<HTMLDialogElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  return (
    e.target === e.currentTarget &&
    (e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom)
  );
}
export function NamePicker({
  label,
  value,
  tags,
  change,
}: {
  label: string;
  value: string;
  tags: string[];
  change: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <div
      className="name-picker"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          e.stopPropagation();
        }
      }}
    >
      <input
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
      <button
        className="name-dropdown"
        aria-label={label + "选择标签"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ⌄
      </button>
      {open && (
        <div className="name-options" role="group" aria-label="可选标签">
          {tags.length ? (
            tags.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  change(tag);
                  setOpen(false);
                }}
              >
                {tag}
              </button>
            ))
          ) : (
            <span>暂无标签，可在“管理标签”中添加</span>
          )}
        </div>
      )}
    </div>
  );
}
export function LocalDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => before?.focus();
  }, []);
  return (
    <dialog
      className="local-dialog"
      ref={ref}
      aria-label={title}
      onClick={(e) => {
        if (outsideDialog(e)) close();
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={close}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function SpeedMenu({
  value,
  change,
}: {
  value: number;
  change: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <div
      className="speed-menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        aria-label="播放速度"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {value}× ⌄
      </button>
      {open && (
        <div role="menu" aria-label="播放速度">
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
            <button
              key={n}
              role="menuitemradio"
              aria-checked={n === value}
              onClick={() => {
                change(n);
                setOpen(false);
              }}
            >
              {n === value ? "✓ " : ""}
              {n}×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function MediaInfo({
  asset,
  close,
}: {
  asset: Asset;
  close: () => void;
}) {
  const v = asset.metadata.streams.find((s) => s.codec_type === "video") ?? {};
  const a = asset.metadata.streams.find((s) => s.codec_type === "audio");
  const f = asset.metadata.format ?? {};
  const rate = (x: unknown) =>
    Number(x) > 0
      ? (Number(x) / 1000).toLocaleString("zh-CN", {
          maximumFractionDigits: 1,
        }) + " kbps"
      : "未提供";
  const pairs = [
    ["文件", asset.name],
    ["位置", asset.path],
    ["大小", (asset.size / 1024 / 1024).toFixed(1) + " MB"],
    ["时长", (asset.duration_us / 1e6).toFixed(3) + " 秒"],
    ["视频编码", v.codec_name ?? "未提供"],
    ["分辨率", v.width + " × " + v.height],
    ["平均帧率", v.avg_frame_rate ?? "未提供"],
    ["标称帧率", v.r_frame_rate ?? "未提供"],
    ["视频码率", rate(v.bit_rate)],
    ["总码率", rate(f.bit_rate)],
    ["像素格式", v.pix_fmt ?? "未提供"],
    [
      "色彩",
      [v.color_space, v.color_transfer, v.color_primaries]
        .filter(Boolean)
        .join(" / ") || "未提供",
    ],
    [
      "音频",
      a
        ? [
            a.codec_name,
            a.sample_rate + " Hz",
            a.channels + " 声道",
            rate(a.bit_rate),
          ].join(" · ")
        : "无音频",
    ],
  ];
  return (
    <LocalDialog title="原始素材信息" close={close}>
      <dl className="media-info">
        {pairs.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </LocalDialog>
  );
}
