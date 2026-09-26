import type { Asset } from "./types";
import { locate, totalUs } from "./timeline";
export const defaultTags = [
  "男单",
  "男双",
  "混双",
  "男双vs混双",
  "拉练",
  "女单",
  "女双",
];
export function readPreference<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function adjacentFrame(
  assets: Asset[],
  time: number,
  direction: number,
) {
  const loc = locate(assets, time);
  let i = loc.index;
  let local = loc.local;
  if (direction < 0 && local === 0 && i > 0) {
    i--;
    local = assets[i].duration_us;
  }
  const v = assets[i]?.metadata.streams.find((s) => s.codec_type === "video");
  const [n, d] = String(v?.avg_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  if (!n || !d || n / d <= 0) throw Error("无法读取素材帧率，暂不能逐帧定位");
  const frame = (local * n) / (1e6 * d);
  const index =
    direction > 0
      ? Math.floor(frame + 0.0001) + 1
      : Math.ceil(frame - 0.0001) - 1;
  const offset = assets.slice(0, i).reduce((sum, a) => sum + a.duration_us, 0);
  return Math.max(
    0,
    Math.min(
      totalUs(assets),
      offset +
        Math.min(assets[i].duration_us, Math.round((index * 1e6 * d) / n)),
    ),
  );
}
