import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Asset } from "./types";
import { parseTime, timecode } from "./timeline";

export function EditorIconButton({
  label,
  shortcut,
  disabled,
  className = "",
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`editor-icon-button ${className}`}
      aria-label={label}
      title={shortcut ? `${label}（${shortcut}）` : label}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}

export function ClockInput({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: number | null;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const format = (value: number | null) =>
    value === null ? "" : timecode(value);
  const [text, setText] = useState(format(value));
  useEffect(() => setText(format(value)), [value]);
  return (
    <label className="clock-input">
      <span>{label}</span>
      <input
        aria-label={label}
        title={label}
        disabled={disabled}
        value={text}
        placeholder="未设定"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (!text && value === null) return;
          try {
            onChange(parseTime(text));
            setText(format(value));
          } catch {
            setText(format(value));
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}
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
  manage,
}: {
  label: string;
  value: string;
  tags: string[];
  change: (s: string) => void;
  manage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const focusOptions = useRef(false);
  const beginEditing = () => {
    cancelled.current = false;
    setText(value);
    setOpen(false);
    setEditing(true);
  };
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (open && focusOptions.current) {
      ref.current
        ?.querySelector<HTMLButtonElement>(".name-options button")
        ?.focus();
      focusOptions.current = false;
    }
  }, [open]);
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
          e.preventDefault();
          if (editing) {
            cancelled.current = true;
            setEditing(false);
          }
          setOpen(false);
          e.stopPropagation();
          requestAnimationFrame(() => trigger.current?.focus());
        } else if (
          open &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
        ) {
          e.preventDefault();
          e.stopPropagation();
          const options = [
            ...ref.current!.querySelectorAll<HTMLButtonElement>(
              ".name-options button",
            ),
          ];
          const index = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? options.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                  options.length;
          options[next]?.focus();
        } else if (open && e.key === "Tab") {
          trigger.current?.focus();
          setOpen(false);
        }
      }}
    >
      {editing ? (
        <input
          ref={input}
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (!cancelled.current && text !== value) change(text);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
              requestAnimationFrame(() => trigger.current?.focus());
            }
          }}
        />
      ) : (
        <button
          ref={trigger}
          type="button"
          className="name-trigger"
          aria-label={label + "选择标签"}
          title="单击选择标签，双击编辑名称"
          aria-expanded={open}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ")
              event.stopPropagation();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              if (open)
                ref.current
                  ?.querySelector<HTMLButtonElement>(".name-options button")
                  ?.focus();
              else {
                focusOptions.current = true;
                setOpen(true);
              }
            } else if (event.key === "F2") {
              event.preventDefault();
              event.stopPropagation();
              beginEditing();
            }
          }}
          onClick={() => setOpen((current) => !current)}
          onDoubleClick={beginEditing}
        >
          <span>{value || "选择标签"}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div className="name-options" role="group" aria-label="可选标签">
          {tags.length ? (
            tags.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  change(tag);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                {tag}
              </button>
            ))
          ) : (
            <span>暂无标签，可在“管理标签”中添加</span>
          )}
          {manage && (
            <button
              onClick={() => {
                setOpen(false);
                manage();
              }}
            >
              管理标签
            </button>
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
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
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
