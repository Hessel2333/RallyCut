import { useState } from "react";
import type { Chapter, Match } from "./types";
import { chapterText } from "./editing";
import { parseTime, timecode } from "./timeline";
import { LocalDialog } from "./EditorControls";
export function ChapterEditor({
  match,
  duration,
  position,
  change,
  seek,
  close,
}: {
  match: Match;
  duration: number;
  position: number;
  change: (chapters: Chapter[]) => void;
  seek: (offset: number) => void;
  close: () => void;
}) {
  const [error, setError] = useState("");
  const chapters = match.chapters ?? [];
  const save = (next: Chapter[]) => {
    next = [...next].sort((a, b) => a.offset_us - b.offset_us);
    if (
      next.some(
        (c, i) =>
          !c.title.trim() ||
          c.offset_us < 0 ||
          c.offset_us >= duration ||
          (i > 0 && c.offset_us === next[i - 1].offset_us),
      )
    ) {
      setError("请使用不重复的片内时间，且位于这场比赛内。章节名称不能为空。");
      return;
    }
    change(next);
    setError("");
  };
  return (
    <LocalDialog title={`${match.name} · 章节`} close={close}>
      <p>章节只增加跳转点，整场仍导出为一个视频。时间从成片开头计算。</p>
      <div className="chapter-list">
        {chapters.map((chapter, i) => (
          <div className="chapter-row" key={`${i}:${chapter.offset_us}`}>
            <button
              aria-label={`跳到章节${i + 1}`}
              onClick={() => seek(chapter.offset_us)}
            >
              {i + 1}
            </button>
            <input
              aria-label={`章节${i + 1}时间`}
              defaultValue={timecode(chapter.offset_us)}
              onBlur={(e) => {
                try {
                  save(
                    chapters.map((c, j) =>
                      j === i
                        ? { ...c, offset_us: parseTime(e.target.value) }
                        : c,
                    ),
                  );
                } catch {
                  setError("请输入 时:分:秒.毫秒");
                }
                e.target.value = timecode(chapter.offset_us);
              }}
            />
            <input
              aria-label={`章节${i + 1}名称`}
              maxLength={80}
              value={chapter.title}
              onChange={(e) =>
                save(
                  chapters.map((c, j) =>
                    j === i ? { ...c, title: e.target.value } : c,
                  ),
                )
              }
            />
            <button
              aria-label={`删除章节${i + 1}`}
              onClick={() => save(chapters.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="editing-actions">
        <button
          disabled={position < 0 || position >= duration}
          onClick={() => {
            const next = [...chapters];
            if (!next.length && position > 0)
              next.push({ title: "第1小局", offset_us: 0 });
            save([
              ...next,
              {
                title: `第${next.length + 1}小局`,
                offset_us: Math.floor(position / 1e6) * 1e6,
              },
            ]);
          }}
        >
          在播放位置添加章节
        </button>
        <button
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([chapterText(match)], {
                type: "text/plain;charset=utf-8",
              }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = `${match.name.replace(/[\\/:*?"<>|]/g, "_")}-章节.txt`;
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          导出章节时间表
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <label className="chapter-copy">
        章节时间表
        <textarea
          aria-label="章节时间表"
          readOnly
          value={chapterText(match)}
          onFocus={(e) => e.target.select()}
        />
      </label>
      <small>
        可在 B
        站创作中心的稿件管理中配置分段章节，开放条件以当前账号为准。这里保存的章节不会自动提交到
        B 站。
      </small>
    </LocalDialog>
  );
}
