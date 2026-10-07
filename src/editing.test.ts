import { describe, expect, it } from "vitest";
import {
  chapterText,
  crossingPairs,
  focusWindow,
  resizedMatch,
  sharePreset,
  sourceBounds,
} from "./editing";
import { mapRange, splitSegment } from "./timeline";
import type { Asset, Match } from "./types";
const assets = [
  { id: "a", duration_us: 60e6 },
  { id: "b", duration_us: 60e6 },
] as Asset[];
const match: Match = {
  id: "m",
  name: "单打",
  note: "",
  ranges: mapRange(assets, 10e6, 90e6),
  chapters: [
    { title: "第一局", offset_us: 0 },
    { title: "第二局", offset_us: 30e6 },
    { title: "第三局", offset_us: 65e6 },
  ],
};
describe("editing boundaries and chapters", () => {
  it("an exact end boundary belongs to the preceding source, a start to the next", () => {
    expect(sourceBounds(assets, 60e6, true)).toEqual({ start: 0, end: 60e6 });
    expect(sourceBounds(assets, 60e6)).toEqual({ start: 60e6, end: 120e6 });
  });
  it("trimming preserves chapter source positions and drops chapters outside the cut", () => {
    const changed = resizedMatch(assets, match, mapRange(assets, 20e6, 70e6));
    expect(changed.chapters).toEqual([{ title: "第二局", offset_us: 20e6 }]);
    expect(chapterText(changed)).toBe("00:00:00 开始\n00:00:20 第二局");
  });
  it("splitting moves right-side chapters to the new clip origin exactly once", () => {
    const split = splitSegment(assets, [match], 40e6, "right")!;
    expect(split[0].chapters).toEqual([{ title: "第一局", offset_us: 0 }]);
    expect(split[1].chapters).toEqual([
      { title: "第二局", offset_us: 0 },
      { title: "第三局", offset_us: 35e6 },
    ]);
  });
  it("detects cross-file exports without flagging separate matches in adjacent files", () => {
    expect(crossingPairs([match])).toEqual(["a:b"]);
    expect(
      crossingPairs([
        { ...match, ranges: mapRange(assets, 0, 60e6) },
        { ...match, ranges: mapRange(assets, 60e6, 120e6) },
      ]),
    ).toEqual([]);
  });
  it("keeps a 10 second clip readable in a long capture and clamps at both ends", () => {
    expect(focusWindow(7200e6, 3600e6, 3610e6)).toEqual({
      start: 3597.5e6,
      end: 3612.5e6,
    });
    expect(focusWindow(60e6, -5e6, 5e6)).toEqual({ start: 0, end: 15e6 });
    expect(focusWindow(60e6, 58e6, 60e6)).toEqual({ start: 50e6, end: 60e6 });
    expect(sharePreset).toMatchObject({
      codec: "h264",
      width: 1920,
      height: 1080,
      force_60: true,
      bitrate_kbps: 6000,
    });
  });
});
