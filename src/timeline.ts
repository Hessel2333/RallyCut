import type { Asset, Range, Match } from "./types";
export function orderedMatches(assets: Asset[], matches: Match[]) {
  return [...matches].sort(
    (a, b) => bounds(assets, a.ranges).start - bounds(assets, b.ranges).start,
  );
}
export function appendSegment(
  assets: Asset[],
  matches: Match[],
  start: number,
  end: number,
  name: string,
  id: string,
) {
  const ranges = mapRange(assets, start, end);
  if (
    matches.some((m) => {
      const b = bounds(assets, m.ranges);
      return start < b.end && end > b.start;
    })
  )
    throw Error("这段时间已包含比赛，请调整起止位置，或在已有比赛内添加分割点");
  return {
    matches: orderedMatches(assets, [
      ...matches,
      { id, name, ranges, note: "" },
    ]),
    nextStart: end,
    nextEnd: end,
  };
}
export function splitSegment(
  assets: Asset[],
  matches: Match[],
  time: number,
  id: string,
) {
  const found = matches.find((m) => {
    const b = bounds(assets, m.ranges);
    return b.start < time && time < b.end;
  });
  if (!found) return null;
  const b = bounds(assets, found.ranges);
  return orderedMatches(
    assets,
    matches.flatMap((m) =>
      m.id === found.id
        ? [
            { ...m, ranges: mapRange(assets, b.start, time) },
            { ...m, id, ranges: mapRange(assets, time, b.end) },
          ]
        : [m],
    ),
  );
}
export const totalUs = (assets: Asset[]) =>
  assets.reduce((n, a) => n + a.duration_us, 0);
export function mapRange(assets: Asset[], start: number, end: number): Range[] {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > totalUs(assets)
  )
    throw Error("结束时间必须晚于开始时间，且位于拍摄范围内");
  let offset = 0;
  return assets.flatMap((a) => {
    const s = Math.max(start, offset) - offset,
      e = Math.min(end, offset + a.duration_us) - offset;
    offset += a.duration_us;
    return e > s ? [{ asset_id: a.id, start_us: s, end_us: e }] : [];
  });
}
export function locate(assets: Asset[], time: number) {
  let offset = 0;
  for (let i = 0; i < assets.length; i++) {
    if (time < offset + assets[i].duration_us || i === assets.length - 1)
      return {
        index: i,
        local: Math.max(0, Math.min(assets[i].duration_us, time - offset)),
      };
    offset += assets[i].duration_us;
  }
  return { index: 0, local: 0 };
}
export function bounds(assets: Asset[], ranges: Range[]) {
  let offset = 0;
  const starts = new Map<string, number>();
  assets.forEach((a) => {
    starts.set(a.id, offset);
    offset += a.duration_us;
  });
  return {
    start: (starts.get(ranges[0].asset_id) ?? 0) + ranges[0].start_us,
    end: (starts.get(ranges.at(-1)!.asset_id) ?? 0) + ranges.at(-1)!.end_us,
  };
}
export function timecode(us: number) {
  const ms = Math.floor(us / 1000);
  return (
    `${Math.floor(ms / 3600000)
      .toString()
      .padStart(2, "0")}:${Math.floor(ms / 60000) % 60}`.replace(
      /:(\d)$/,
      ":0$1",
    ) +
    `:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")}.${(ms % 1000).toString().padStart(3, "0")}`
  );
}
export function parseTime(s: string) {
  if (!/^\d{1,3}:\d{2}:\d{2}(\.\d{1,6})?$/.test(s))
    throw Error("请输入 时:分:秒.毫秒");
  const [h, m, t] = s.split(":");
  const [sec, frac = ""] = t.split(".");
  if (+m >= 60 || +sec >= 60) throw Error("分和秒必须小于 60");
  return (+h * 3600 + +m * 60 + +sec) * 1000000 + +frac.padEnd(6, "0");
}
