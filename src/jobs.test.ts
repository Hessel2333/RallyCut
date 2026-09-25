import { it, expect } from "vitest";
import { jobMatchesCurrent, remaining } from "./jobs";
import type { Job, Session, Asset, Preset } from "./types";
it("invalidates edited marks, changed presets and missing sources without changing job snapshots", () => {
  const preset = { width: 3840, height: 2160 } as Preset;
  const ranges = [{ asset_id: "a", start_us: 0, end_us: 1000000 }];
  const job = {
    session_id: "s",
    segment: { id: "m", ranges },
    assets: [{ id: "a", sha256: "x" }],
    preset,
  } as Job;
  const sessions = [{ id: "s", matches: [{ id: "m", ranges }] }] as Session[];
  const assets = [{ id: "a", sha256: "x", available: true }] as Asset[];
  expect(jobMatchesCurrent(job, sessions, assets, preset)).toBe(true);
  expect(
    jobMatchesCurrent(job, sessions, assets, { ...preset, width: 1920 }),
  ).toBe(false);
  expect(jobMatchesCurrent(job, [], assets, preset)).toBe(false);
  expect(
    jobMatchesCurrent(job, sessions, [{ ...assets[0], sha256: "new" }], preset),
  ).toBe(false);
  expect(
    jobMatchesCurrent(
      job,
      [
        {
          ...sessions[0],
          matches: [
            {
              ...sessions[0].matches[0],
              ranges: [{ ...ranges[0], end_us: 500000 }],
            },
          ],
        },
      ],
      assets,
      preset,
    ),
  ).toBe(false);
  expect(job.segment.ranges[0].end_us).toBe(1000000);
});
it("estimates remaining time only from real speed", () => {
  const job = {
    status: "exporting",
    speed: "h264_nvenc · 2.0x",
    progress: 0.5,
    segment: { ranges: [{ start_us: 0, end_us: 120000000 }] },
  } as Job;
  expect(remaining(job)).toBe("预计剩余 1 分钟");
  expect(remaining({ ...job, speed: "N/A" })).toBe("");
});
