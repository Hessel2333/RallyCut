import type { Asset, Match, Preset } from "./types";
import { bounds, locate, timecode, totalUs, trimChapters } from "./timeline";

export const sharePreset: Preset = {
  codec: "h264",
  width: 1920,
  height: 1080,
  bitrate_kbps: 6000,
  audio_kbps: 128,
  force_60: true,
  encoder: "auto",
  acknowledge_sdr: false,
};
export function sourceBounds(assets: Asset[], time: number, end = false) {
  const { index } = locate(assets, Math.max(0, time - (end ? 1 : 0)));
  const start = totalUs(assets.slice(0, index));
  return { start, end: start + (assets[index]?.duration_us ?? 0) };
}
export function chapterText(match: Match) {
  const chapters = [...(match.chapters ?? [])].sort(
    (a, b) => a.offset_us - b.offset_us,
  );
  if (!chapters.length || chapters[0].offset_us !== 0)
    chapters.unshift({ title: "开始", offset_us: 0 });
  return chapters
    .map(
      (c) =>
        `${c.offset_us % 1e6 === 0 ? timecode(c.offset_us).slice(0, 8) : timecode(c.offset_us)} ${c.title}`,
    )
    .join("\n");
}
export function crossingPairs(matches: Match[]) {
  return [
    ...new Set(
      matches.flatMap((m) =>
        m.ranges
          .slice(1)
          .map((r, i) => `${m.ranges[i].asset_id}:${r.asset_id}`),
      ),
    ),
  ];
}
export function focusWindow(total: number, start: number, end: number) {
  const span = Math.min(total, Math.max(10e6, (end - start) * 1.5));
  const from = Math.max(0, Math.min(total - span, (start + end - span) / 2));
  return { start: from, end: from + span };
}
export function resizedMatch(
  assets: Asset[],
  match: Match,
  ranges: Match["ranges"],
) {
  const old = bounds(assets, match.ranges),
    next = bounds(assets, ranges);
  return {
    ...match,
    ranges,
    chapters: trimChapters(
      match.chapters,
      next.start - old.start,
      next.end - next.start,
    ),
  };
}
