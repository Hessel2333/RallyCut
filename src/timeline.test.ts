import { describe, it, expect } from "vitest";
import {
  mapRange,
  locate,
  bounds,
  parseTime,
  timecode,
  appendSegment,
  splitSegment,
  orderedMatches,
} from "./timeline";
import type { Asset } from "./types";
const assets = [0, 1, 2].map(
  (i) =>
    ({
      id: String(i),
      duration_us: 15000000,
      metadata: { streams: [{ avg_frame_rate: i ? "60000/1001" : "60/1" }] },
    }) as unknown as Asset,
);
describe("integer half-open timeline", () => {
  it("continues from the previous end and rejects overlap", () => {
    const first = appendSegment(assets, [], 0, 12000000, "男单", "first");
    expect(first.nextStart).toBe(12000000);
    expect(first.nextEnd).toBe(first.nextStart);
    const second = appendSegment(
      assets,
      first.matches,
      first.nextStart,
      18000000,
      "男双",
      "second",
    );
    expect(second.matches[1].ranges).toHaveLength(2);
    expect(() =>
      appendSegment(assets, second.matches, 10000000, 19000000, "混双", "bad"),
    ).toThrow();
    const gap = appendSegment(
      assets,
      second.matches,
      20000000,
      22000000,
      "拉练",
      "gap",
    );
    expect(bounds(assets, gap.matches[2].ranges).start).toBe(20000000);
  });
  it("splits an existing cross-file match without overlap or loss", () => {
    const original = appendSegment(
      assets,
      [],
      12000000,
      18000000,
      "男双vs混双",
      "a",
    ).matches;
    const split = splitSegment(assets, original, 15000000, "b")!;
    expect(split.map((m) => bounds(assets, m.ranges))).toEqual([
      { start: 12000000, end: 15000000 },
      { start: 15000000, end: 18000000 },
    ]);
    expect(split.map((m) => m.name)).toEqual(["男双vs混双", "男双vs混双"]);
    expect(splitSegment(assets, split, 15000000, "c")).toBeNull();
    expect(
      orderedMatches(assets, [...split].reverse()).map((m) => m.id),
    ).toEqual(["a", "b"]);
    expect(original).toHaveLength(1);
  });
  it("single / two / three files", () => {
    expect(mapRange(assets, 0, 1)).toHaveLength(1);
    expect(mapRange(assets, 12000000, 18000000)).toEqual([
      { asset_id: "0", start_us: 12000000, end_us: 15000000 },
      { asset_id: "1", start_us: 0, end_us: 3000000 },
    ]);
    expect(mapRange(assets, 12000000, 33000000)).toHaveLength(3);
  });
  it("exact boundary", () => {
    expect(mapRange(assets, 15000000, 30000000)).toEqual([
      { asset_id: "1", start_us: 0, end_us: 15000000 },
    ]);
    expect(locate(assets, 15000000)).toEqual({ index: 1, local: 0 });
  });
  it("invalid range", () => {
    for (const [s, e] of [
      [-1, 1],
      [0, 0],
      [2, 1],
      [0, 46000000],
      [0, 0.5],
    ])
      expect(() => mapRange(assets, s, e)).toThrow();
  });
  it("does not round source rate or drift", () => {
    expect(assets[1].metadata.streams[0].avg_frame_rate).toBe("60000/1001");
    expect(parseTime("01:00:00.000001")).toBe(3600000001);
    expect(timecode(15015000)).toBe("00:00:15.015");
  });
  it("retains source identities", () => {
    const r = mapRange(assets, 12000000, 18000000);
    expect(bounds(assets, r)).toEqual({ start: 12000000, end: 18000000 });
    expect(r[0].asset_id).toBe("0");
  });
});
