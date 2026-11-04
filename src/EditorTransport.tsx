import {
  ChevronLeft,
  ChevronRight,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  Play,
  Pause,
} from "lucide-react";
import { ClockInput, EditorIconButton } from "./EditorControls";

export function EditorTransport({
  mode,
  start,
  end,
  hasClip,
  completeClip,
  playing,
  step,
  disabled,
  markerDisabled,
  markStart,
  markEnd,
  changeStart,
  changeEnd,
  toggle,
  frame,
  jump,
  jumpSource,
}: {
  mode: "matches" | "short";
  start: number | null;
  end: number | null;
  hasClip: boolean;
  completeClip: boolean;
  playing: boolean;
  step: number;
  disabled: boolean;
  markerDisabled: boolean;
  markStart: () => void;
  markEnd: () => void;
  changeStart: (value: number) => void;
  changeEnd: (value: number) => void;
  toggle: () => void;
  frame: (direction: number) => void;
  jump: (direction: number) => void;
  jumpSource: (edge: "start" | "end") => void;
}) {
  const short = mode === "short";
  const startLabel = short ? "设为短片开头" : "设为开始";
  const endLabel = short
    ? completeClip
      ? "重设短片结尾"
      : "结束短片"
    : "设为结束";
  return (
    <div
      className="editor-transport"
      role="toolbar"
      aria-label="播放与起止点"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          (event.target as HTMLElement).closest("button")
        )
          event.stopPropagation();
      }}
    >
      <div className="editor-nav-group">
        <EditorIconButton
          label="跳到原片开头"
          disabled={disabled}
          onClick={() => jumpSource("start")}
        >
          <SkipBack size={16} />
        </EditorIconButton>
        <EditorIconButton
          label={`后退 ${step} 秒`}
          disabled={disabled}
          onClick={() => jump(-1)}
        >
          <Rewind size={16} />
        </EditorIconButton>
      </div>
      <div className="editor-marker start-marker">
        <ClockInput
          label={short ? "短片开始时间" : "开始时间"}
          value={start}
          onChange={changeStart}
          disabled={disabled}
        />
        <button
          className="marker-button"
          aria-label={startLabel}
          title={`${startLabel}（I）`}
          disabled={markerDisabled}
          onClick={markStart}
        >
          I
        </button>
      </div>
      <div className="editor-playback">
        <div className="editor-play-buttons">
          <button
            aria-label="上一帧（D）"
            title="上一帧（D）"
            disabled={disabled}
            onClick={() => frame(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="editor-play"
            aria-label="播放 / 暂停（Space）"
            title="播放 / 暂停（Space）"
            disabled={disabled}
            onClick={toggle}
          >
            {playing ? <Pause size={19} /> : <Play size={19} />}
          </button>
          <button
            aria-label="下一帧（F）"
            title="下一帧（F）"
            disabled={disabled}
            onClick={() => frame(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="editor-marker end-marker">
        <button
          className="marker-button"
          aria-label={endLabel}
          title={`${endLabel}（O）`}
          disabled={markerDisabled || (short && !hasClip)}
          onClick={markEnd}
        >
          O
        </button>
        <ClockInput
          label={short ? "短片结束时间" : "结束时间"}
          value={end}
          onChange={changeEnd}
          disabled={disabled || (short && !hasClip)}
        />
      </div>
      <div className="editor-nav-group">
        <EditorIconButton
          label={`前进 ${step} 秒`}
          disabled={disabled}
          onClick={() => jump(1)}
        >
          <FastForward size={16} />
        </EditorIconButton>
        <EditorIconButton
          label="跳到原片结尾"
          disabled={disabled}
          onClick={() => jumpSource("end")}
        >
          <SkipForward size={16} />
        </EditorIconButton>
      </div>
    </div>
  );
}
