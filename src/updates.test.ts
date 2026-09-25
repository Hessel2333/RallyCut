import { describe, expect, it } from "vitest";
import { downloadPercent, shouldShowReleaseNotes } from "./updates";

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
