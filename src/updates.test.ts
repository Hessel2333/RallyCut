import { describe, expect, it } from "vitest";
import {
  downloadPercent,
  shouldShowReleaseNotes,
  updateErrorMessage,
} from "./updates";

describe("release notes", () => {
  it("does not call a first installation an upgrade", () =>
    expect(shouldShowReleaseNotes(null, "0.2.0")).toBe(false));
  it("shows notes once after an installed version changes", () => {
    expect(shouldShowReleaseNotes("0.1.0", "0.2.0")).toBe(true);
    expect(shouldShowReleaseNotes("0.2.0", "0.2.0")).toBe(false);
  });
});
describe("download progress", () => {
  it("handles missing content length and caps inaccurate lengths", () => {
    expect(downloadPercent(100)).toBeNull();
    expect(downloadPercent(100, 0)).toBeNull();
    expect(downloadPercent(25, 100)).toBe(25);
    expect(downloadPercent(200, 100)).toBe(100);
  });
});

describe("update error messages", () => {
  it.each([
    [
      "the platform `darwin-aarch64` was not found in the response `platforms` object",
      "尚未提供",
    ],
    [
      "None of the fallback platforms `[darwin-aarch64]` were found in the response `platforms` object",
      "尚未提供",
    ],
    ["signature verification failed", "校验失败"],
    ["operation timed out", "超时"],
    ["error sending request", "网络或代理"],
    ["invalid JSON", "服务暂时不可用"],
    ["unexpected failure", "未能完成更新"],
  ])(
    "classifies %s without treating every failure as a network error",
    (error, expected) => {
      expect(updateErrorMessage(new Error(error))).toContain(expected);
    },
  );
});
