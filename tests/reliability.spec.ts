import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let media: Buffer;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "rallycut-player-"));
  const binary = process.env.RALLYCUT_FFMPEG_DIR;
  if (!binary)
    throw Error("Set RALLYCUT_FFMPEG_DIR to native FFmpeg (libx264 required)");
  const file = join(dir, "fixture.mp4");
  execFileSync(
    join(binary, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ],
  );
  media = readFileSync(file);
});
test.beforeEach(async ({ page }) => {
  await page.route("**/fixture*.mp4", (route) => {
    const range = route.request().headers()["range"];
    if (!range)
      return route.fulfill({
        body: media,
        contentType: "video/mp4",
        headers: { "Accept-Ranges": "bytes" },
      });
    const match = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(match[1]),
      end = match[2] ? Number(match[2]) : media.length - 1;
    return route.fulfill({
      status: 206,
      body: media.subarray(start, end + 1),
      contentType: "video/mp4",
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${media.length}`,
      },
    });
  });
  await page.addInitScript(() => {
    const w = window as any;
    localStorage.setItem("rallycut-auto-update", "false");
    localStorage.setItem("rallycut-seen-version", "0.4.0");
    localStorage.setItem("rallycut-session", "a");
    w.isTauri = true;
    w.callbacks = {};
    w.events = {};
    w.saves = [];
    w.sessions = ["a", "b"].map((id) => ({
      id,
      name: `拍摄${id}`,
      date: "2026-09-27",
      asset_ids: ["shared", "second"],
      matches: [
        {
          id: `m${id}`,
          name: "原名称",
          note: "",
          ranges: [{ asset_id: "shared", start_us: 0, end_us: 3000000 }],
        },
      ],
    }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) => "/" + path,
      transformCallback: (f: any) => {
        const id = Object.keys(w.callbacks).length + 1;
        w.callbacks[id] = f;
        return id;
      },
      unregisterCallback() {},
      invoke: async (cmd: string, args: any) => {
        if (cmd === "authorize_exit") {
          w.exitAuthorized = true;
          return null;
        }
        if (cmd === "plugin:event|listen") {
          w.events[args.event] = w.callbacks[args.handler];
          return 1;
        }
        if (cmd === "plugin:app|version") return "0.4.0";
        if (cmd === "snapshot")
          return {
            sessions: structuredClone(w.sessions),
            assets: ["shared", "second"].map((id, i) => ({
              id,
              name: `fixture${i || ""}.mp4`,
              path: `fixture${i || ""}.mp4`,
              original_path: `fixture${i || ""}.mp4`,
              available: true,
              duration_us: 6000000,
              size: 1000,
              sha256: "",
              verification: "",
              metadata: {
                streams: [
                  {
                    codec_type: "video",
                    width: 160,
                    height: 90,
                    avg_frame_rate: "30/1",
                  },
                ],
              },
            })),
            jobs: [],
            paused: false,
            match_numbers: {},
            data_dir: "",
            settings: {
              theme: "dark",
              output: "",
              library: "",
              ffmpeg: "",
              ffprobe: "",
            },
          };
        if (cmd === "tool_status")
          return { ffmpeg: { available: true }, ffprobe: { available: true } };
        if (cmd === "capture_cover_candidate") { w.capturedCover = args; return { id: "test-cover" }; }
        if (cmd === "cached_previews") return [];
        if (cmd === "prepare_preview")
          return new Promise((resolve) => {
            w.resolveProxy = () =>
              resolve({
                asset_id: args.assetId,
                path: "fixture-proxy.mp4",
                kind: "proxy",
              });
          });
        if (cmd === "export_preferences")
          return {
            current: {
              codec: "h264",
              width: 1920,
              height: 1080,
              bitrate_kbps: 10000,
              audio_kbps: 192,
              force_60: false,
              encoder: "auto",
              acknowledge_sdr: false,
            },
            presets: [],
          };
        if (cmd === "save_session") {
          await new Promise<void>((resolve, reject) =>
            w.saves.push({
              resolve: () => {
                w.sessions = w.sessions.map((s: any) =>
                  s.id === args.session.id ? args.session : s,
                );
                resolve();
              },
              reject,
            }),
          );
        }
        return null;
      },
    };
  });
  await page.goto("/");
});

test("close waits for final acknowledgement and a failed save can cancel exit", async ({
  page,
}) => {
  await page.locator(".match-item").getByText("备注与精确时间").click();
  const note = page.getByLabel("比分或备注");
  await note.fill("最终备注");
  await expect
    .poll(() => page.evaluate(() => (window as any).saves.length))
    .toBe(1);
  await page.evaluate(() =>
    (window as any).events["exit-requested"]({ payload: null }),
  );
  expect(
    await page.evaluate(() => (window as any).exitAuthorized),
  ).toBeUndefined();
  await page.evaluate(() =>
    (window as any).saves[0].reject(Error("injected failure")),
  );
  await expect(
    page.getByRole("dialog", { name: "标记尚未保存" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消退出" }).click();
  await expect(note).toHaveValue("最终备注");
  await page.evaluate(() =>
    (window as any).events["exit-requested"]({ payload: null }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).saves.length))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).exitAuthorized),
  ).toBeUndefined();
  await page.evaluate(() => (window as any).saves[1].resolve());
  await expect
    .poll(() => page.evaluate(() => (window as any).exitAuthorized))
    .toBe(true);
});

test("shared first asset resets on A B A with real decoded media", async ({
  page,
}) => {
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(3.8);
  await page.getByText("拍摄b", { exact: true }).click();
  await expect(page.getByText("正在定位…", { exact: true })).toHaveCount(0);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeLessThan(0.1);
  await page.getByText("拍摄a", { exact: true }).first().click();
  await page.getByText("拍摄b", { exact: true }).first().click();
  await page.getByText("拍摄a", { exact: true }).first().click();
  await expect(video).toBeVisible();
  await expect(page.getByText("正在定位…", { exact: true })).toHaveCount(0);
});

test("older save acknowledgement cannot mark later edits saved", async ({
  page,
}) => {
  await page.locator(".match-item").getByText("备注与精确时间").click();
  const end = page.locator(".match-item").getByLabel("终点", { exact: true });
  await end.fill("00:00:02.000");
  await end.press("Tab");
  await end.fill("00:00:01.000");
  await end.press("Tab");
  await expect
    .poll(() => page.evaluate(() => (window as any).saves.length))
    .toBe(1);
  await page.evaluate(() => (window as any).saves[0].resolve());
  await expect
    .poll(() => page.evaluate(() => (window as any).saves.length))
    .toBe(2);
  await expect(page.locator(".save-status")).toContainText("保存中");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(end).toHaveValue("00:00:01.000");
  await page.evaluate(() => (window as any).saves[1].resolve());
  await expect(page.locator(".save-status")).toContainText("已保存");
});

test("cross-file scrubbing and delayed proxy completion preserve the current asset", async ({
  page,
}) => {
  const video = page.locator("video");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "生成代理", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(video).toHaveAttribute("data-asset-id", "second");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(2, 1);
  await page.evaluate(() => (window as any).resolveProxy());
  await expect(video).toHaveAttribute("data-asset-id", "second");
  await expect(video).toHaveAttribute("data-path", "fixture1.mp4");
  await page.keyboard.press("ArrowLeft");
  await expect(video).toHaveAttribute("data-asset-id", "shared");
  await expect(video).toHaveAttribute("data-path", "fixture-proxy.mp4");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(4, 1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(video).toHaveAttribute("data-asset-id", "second");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(2, 1);
  await expect(video).toBeVisible();
  await page.getByRole("button", { name: "播放 / 暂停（Space）" }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(2.2);
  await page.getByRole("button", { name: "播放 / 暂停（Space）" }).click();
});

test("decode error becomes recoverable and retry loads actual video", async ({
  page,
}) => {
  let broken = true;
  await page.route("**/fixture1.mp4", (route) =>
    broken
      ? route.fulfill({ body: "broken", contentType: "video/mp4" })
      : route.fallback(),
  );
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "重试定位" })).toBeVisible();
  await expect(page.getByText("正在定位…", { exact: true })).toHaveCount(0);
  broken = false;
  await page.getByRole("button", { name: "重试定位" }).click();
  await expect(page.locator("video")).toBeVisible();
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeCloseTo(2, 1);
});


test("editor captures the paused media position as a cover candidate", async ({ page }) => {
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 2; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.getByRole("button", { name: "加入封面备选", exact: true }).click();
  await expect(page.getByText("已加入封面备选", { exact: true })).toBeVisible();
  const capture = await page.evaluate(() => (window as any).capturedCover);
  expect(capture.sessionId).toBe("a");
  expect(capture.assetId).toBe("shared");
  expect(capture.timeUs).toBe(2000000);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
