import { describe, it, expect } from "vitest";
import { adjacentFrame } from "./editorPreferences";
import type { Asset } from "./types";
const asset = (id: string, rate: string, duration_us = 10010000) =>
  ({
    id,
    duration_us,
    metadata: { streams: [{ codec_type: "video", avg_frame_rate: rate }] },
  }) as unknown as Asset;
describe("source frame stepping", () => {
  it("uses rational 60000/1001 without treating it as 60", () => {
    const a = [asset("a", "60000/1001")];
    expect(adjacentFrame(a, 0, 1)).toBe(16683);
    expect(adjacentFrame(a, 16683, 1)).toBe(33367);
    expect(adjacentFrame(a, 33367, -1)).toBe(16683);
  });
  it("handles exact boundary and different source rates", () => {
    const a = [asset("a", "60/1", 1000000), asset("b", "30/1", 1000000)];
    expect(adjacentFrame(a, 1000000, -1)).toBe(983333);
    expect(adjacentFrame(a, 1000000, 1)).toBe(1033333);
    expect(adjacentFrame(a, 0, -1)).toBe(0);
    expect(adjacentFrame(a, 2000000, 1)).toBe(2000000);
  });
  it("rejects missing frame rate", () =>
    expect(() => adjacentFrame([asset("a", "0/0")], 0, 1)).toThrow());
});
