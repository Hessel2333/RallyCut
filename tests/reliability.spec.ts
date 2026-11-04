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
  await page.getByRole("button", { name: "素材操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "生成代理", exact: true }).click();
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

async function immediateSaves(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as any, previous = w.__TAURI_INTERNALS__.invoke;
    w.enqueued = [];
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'save_session') {
        w.sessions = w.sessions.map((s: any) => s.id === args.session.id ? structuredClone(args.session) : s);
        return null;
      }
      if (cmd === 'enqueue') { w.enqueued.push(args); return ['/tmp/精彩片段.mp4']; }
      return previous(cmd, args);
    };
  });
}

test('same-file seek never hides the video and source-end commands preserve exact selection bounds', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await video.evaluate(v => {
    (window as any).hiddenDuringSeek = false;
    new MutationObserver(() => {
      if ((v as HTMLElement).style.visibility === 'hidden') (window as any).hiddenDuringSeek = true;
    }).observe(v, { attributes: true, attributeFilter: ['style'] });
  });
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(4, 1);
  expect(await page.evaluate(() => (window as any).hiddenDuringSeek)).toBe(false);
  await page.getByRole('button', { name: '选取当前原片', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:00.000');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue('00:00:06.000');
  await page.getByRole('button', { name: '跳到原片结尾', exact: true }).click();
  await expect(video).toHaveAttribute('data-asset-id', 'shared');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(5.9);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('chapter edit persists relative times, jumps and exports a single video chapter table', async ({ page }) => {
  await immediateSaves(page);
  await page.locator('.match-item').getByRole('button', { name: '章节', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原名称 · 章节' });
  await dialog.getByRole('button', { name: '在播放位置添加章节' }).click();
  await expect(dialog.getByLabel('章节1名称')).toHaveValue('第1小局');
  await dialog.getByLabel('章节1名称').fill('第一小局');
  await expect.poll(() => page.evaluate(() => (window as any).sessions[0].matches[0].chapters?.[0]?.title)).toBe('第一小局');
  await dialog.getByRole('button', { name: '跳到章节1' }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0, 1);
  await expect(dialog.getByLabel('章节时间表')).toHaveValue('00:00:00 第一小局');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出章节时间表' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('原名称-章节.txt');
  expect(readFileSync((await download.path())!, 'utf8')).toBe('00:00:00 第一小局');
  await page.screenshot({ path: '/tmp/rallycut-chapters.png' });
});

test('short clip start and end preserve match chapters and require explicit cross-file confirmation', async ({ page }) => {
  await immediateSaves(page);
  await page.evaluate(() => {
    const w = window as any;
    w.sessions[0].matches[0].chapters = [{ title: '第一小局', offset_us: 0 }, { title: '第二小局', offset_us: 1500000 }];
    w.originalSessions = structuredClone(w.sessions);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.match-item').getByRole('button', { name: /第二小局/ })).toBeVisible();
  await page.locator('.match-item').getByRole('button', { name: '精调', exact: true }).click();
  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const controls = page.getByRole('region', { name: '短片选取', exact: true });
  await page.getByRole('button', { name: '设为短片开头', exact: true }).click();
  await expect(controls).toContainText('待选择结尾');
  await expect(page.getByLabel('分享开始', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(4, 1);
  await page.keyboard.press('ArrowRight');
  await expect(video).toHaveAttribute('data-asset-id', 'second');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2, 1);
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 5; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.getByRole('button', { name: '结束短片', exact: true }).click();
  await expect(controls).toContainText('已选 · 11.00 秒');
  await expect(page.getByLabel('短片开始时间', { exact: true })).toHaveValue('00:00:00.000');
  await expect(page.getByLabel('短片结束时间', { exact: true })).toHaveValue('00:00:11.000');
  await expect(controls.getByRole('button', { name: '导出短片', exact: true })).toBeEnabled();
  await controls.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.TEMP}/rallycut-short-clip-desktop.png` });
  await controls.getByRole('button', { name: '导出短片', exact: true }).click();
  await expect(page.getByLabel('分享开始', { exact: true })).toHaveValue('00:00:00.000');
  await expect(page.getByLabel('分享结束', { exact: true })).toHaveValue('00:00:11.000');
  await page.getByRole('button', { name: '加入导出队列', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认跨文件合并' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).enqueued.filter((v: any) => !v.dryRun).length)).toBe(0);
  await dialog.getByRole('button', { name: '仍然合并并继续', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).enqueued.filter((v: any) => !v.dryRun).length)).toBe(1);
  const sent = await page.evaluate(() => (window as any).enqueued.find((v: any) => !v.dryRun));
  expect(sent.clip).toEqual({ start_us: 0, end_us: 11e6 });
  expect(sent.preset).toMatchObject({ codec: 'h264', width: 1920, height: 1080, force_60: true, bitrate_kbps: 6000 });
  expect(await page.evaluate(() => (window as any).sessions)).toEqual(await page.evaluate(() => (window as any).originalSessions));
});

test('short clips reject reversed endpoints, can be cancelled and reset when switching records', async ({ page }) => {
  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const controls = page.getByRole('region', { name: '短片选取', exact: true });
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 2; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.getByRole('button', { name: '设为短片开头', exact: true }).click();
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 1; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.getByRole('button', { name: '结束短片', exact: true }).click();
  await expect(controls.getByRole('alert')).toContainText('开头之后');
  await expect(controls.getByRole('button', { name: '导出短片', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '设为短片开头', exact: true }).click();
  await expect(controls.getByRole('alert')).toHaveCount(0);
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 3.5; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.getByRole('button', { name: '结束短片', exact: true }).click();
  await expect(controls).toContainText('已选 · 2.50 秒');
  await controls.getByRole('button', { name: '取消短片', exact: true }).click();
  await expect(controls).toContainText('设定开头');
  await expect(controls.getByRole('button', { name: '导出短片', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '设为短片开头', exact: true }).click();
  await page.getByText('拍摄b', { exact: true }).first().click();
  await expect(controls).toContainText('设定开头');
  await expect(page.getByRole('button', { name: '结束短片', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);
});

test('short clip markers work during playback and finishing pauses at the selected frame', async ({ page }) => {
  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const before = await page.evaluate(() => structuredClone((window as any).sessions));
  const controls = page.getByRole('region', { name: '短片选取', exact: true });
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '设为短片开头', exact: true }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.2);
  await page.getByRole('button', { name: '结束短片', exact: true }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(controls.getByRole('button', { name: '导出短片', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).sessions)).toEqual(before);
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);
});

test('short-clip focus keeps controls visible at laptop and tablet widths', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '精调 15 秒', exact: true }).click();
  await page.screenshot({ path: '/tmp/rallycut-editor.png' });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  await expect(page.getByRole('button', { name: '设为短片开头', exact: true })).toBeVisible();
  await page.getByRole('region', { name: '短片选取', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '设为短片开头', exact: true })).toBeInViewport();
  await page.screenshot({ path: '/tmp/rallycut-tablet.png' });
  await expect(page.getByRole('button', { name: '查看全片', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '查看全片', exact: true }).click();
  expect(errors).toEqual([]);
});

test('unified editor keeps video large, supports keyboard menus and isolates short-mode shortcuts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page).toHaveTitle('RallyCut');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const before = await page.evaluate(() => structuredClone((window as any).sessions));
  const viewer = page.locator('.viewer');
  await page.getByLabel('开始时间', { exact: true }).fill('00:00:04.000');
  await page.getByLabel('开始时间', { exact: true }).press('Tab');
  await page.getByLabel('结束时间', { exact: true }).fill('00:00:05.000');
  await page.getByLabel('结束时间', { exact: true }).press('Tab');
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:04.000');
  const beforeStart = await page.getByLabel('开始时间', { exact: true }).inputValue();
  expect((await viewer.boundingBox())!.height).toBeGreaterThan(300);
  const dock = page.locator('.editor-dock');
  expect((await dock.boundingBox())!.height).toBeLessThanOrEqual(48);
  const play = (await page.getByRole('button', { name: '播放 / 暂停（Space）' }).boundingBox())!;
  expect(Math.abs(play.x + play.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(1);
  const markIn = (await page.getByRole('button', { name: '设为开始', exact: true }).boundingBox())!;
  const markOut = (await page.getByRole('button', { name: '设为结束', exact: true }).boundingBox())!;
  expect(play.x - (markIn.x + markIn.width)).toBeLessThanOrEqual(36);
  expect(markOut.x - (play.x + play.width)).toBeLessThanOrEqual(36);
  await expect(page.locator('.mark-toolbar, .tag-toolbar, .source-actions')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: '播放与起止点' })).toHaveCount(1);
  const menu = page.getByRole('button', { name: '素材操作', exact: true });
  await menu.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '生成代理', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(page.getByRole('menu', { name: '素材操作', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '生成代理', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);
  await page.screenshot({ path: `${process.env.TEMP}/rallycut-editor-unified-desktop.png` });

  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 1; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.keyboard.press('i');
  await expect(page.getByLabel('短片开始时间', { exact: true })).toHaveValue('00:00:01.000');
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 3; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await page.keyboard.press('o');
  await expect(page.getByLabel('短片结束时间', { exact: true })).toHaveValue('00:00:03.000');
  await page.keyboard.press('s');
  await expect(page.locator('.match-item')).toHaveCount(1);
  await page.getByLabel('短片结束时间', { exact: true }).fill('00:00:00.000');
  await page.getByLabel('短片结束时间', { exact: true }).press('Tab');
  await expect(page.getByRole('region', { name: '短片选取', exact: true }).getByRole('alert')).toContainText('开头之后');
  await expect(page.getByLabel('短片结束时间', { exact: true })).toHaveValue('00:00:03.000');
  await page.keyboard.press('Delete');
  await expect(page.getByLabel('短片开始时间', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).sessions)).toEqual(before);
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);
  await page.getByRole('button', { name: '比赛模式', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue(beforeStart);

  await page.setViewportSize({ width: 1024, height: 768 });
  expect((await viewer.boundingBox())!.height).toBeGreaterThan(270);
  await expect(page.getByRole('button', { name: '播放 / 暂停（Space）' })).toBeInViewport();
  await expect(page.getByRole('button', { name: '设为结束', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '素材操作', exact: true }).click();
  const popup = await page.getByRole('menu', { name: '素材操作', exact: true }).boundingBox();
  expect(popup!.y).toBeGreaterThanOrEqual(0);
  expect(popup!.y + popup!.height).toBeLessThanOrEqual(768);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${process.env.TEMP}/rallycut-editor-unified-tablet.png` });
  await page.locator('.library-bottom').getByRole('button', { name: '浅色', exact: true }).click();
  await page.screenshot({ path: `${process.env.TEMP}/rallycut-editor-unified-light.png` });
  expect(errors).toEqual([]);
});

test('frequent icon actions align source bounds, navigate without changing selection and keep short clips isolated', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const before = await page.evaluate(() => structuredClone((window as any).sessions));
  const visibleActions = ['起点对齐原片开头', '终点对齐原片结尾', '选取当前原片', '在此分段', '分享选区 · 1080p', '放大选区', '精调 15 秒', '查看全片', '放大时间线', '缩小时间线', '检查衔接', '跳到原片开头', '跳到原片结尾', '加入封面备选', '导出封面'];
  for (const name of visibleActions) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '起点对齐原片开头', exact: true })).toHaveAttribute('title', '起点对齐原片开头');
  await expect(page.getByRole('button', { name: '在此分段', exact: true })).toHaveAttribute('title', '在此分段（S）');

  await page.getByLabel('开始时间', { exact: true }).fill('00:00:07.000');
  await page.getByLabel('开始时间', { exact: true }).press('Tab');
  await page.getByLabel('结束时间', { exact: true }).fill('00:00:10.000');
  await page.getByLabel('结束时间', { exact: true }).press('Tab');
  await page.getByRole('button', { name: '起点对齐原片开头', exact: true }).click();
  await page.getByRole('button', { name: '终点对齐原片结尾', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:06.000');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue('00:00:12.000');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0, 1);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(video).toHaveAttribute('data-asset-id', 'second');
  await page.getByRole('button', { name: '跳到原片开头', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0, 1);
  await expect(video).toHaveAttribute('data-asset-id', 'second');
  await page.getByRole('button', { name: '跳到原片结尾', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(5.9);
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:06.000');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue('00:00:12.000');
  await page.getByRole('button', { name: '选取当前原片', exact: true }).click();
  await expect(page.getByLabel('开始时间', { exact: true })).toHaveValue('00:00:06.000');

  await page.getByRole('button', { name: '放大时间线', exact: true }).click();
  await expect(page.getByLabel('时间线缩放', { exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: '缩小时间线', exact: true }).click();
  await expect(page.getByLabel('时间线缩放', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: '放大选区', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看全片', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '查看全片', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看全片', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: '短片模式', exact: true }).click();
  await expect(page.getByRole('button', { name: '在此分段', exact: true })).toHaveCount(0);
  await page.getByLabel('短片开始时间', { exact: true }).fill('00:00:08.000');
  await page.getByLabel('短片开始时间', { exact: true }).press('Tab');
  await page.getByLabel('短片结束时间', { exact: true }).fill('00:00:10.000');
  await page.getByLabel('短片结束时间', { exact: true }).press('Tab');
  await page.getByRole('button', { name: '起点对齐原片开头', exact: true }).click();
  await page.getByRole('button', { name: '终点对齐原片结尾', exact: true }).click();
  await expect(page.getByLabel('短片开始时间', { exact: true })).toHaveValue('00:00:06.000');
  await expect(page.getByLabel('短片结束时间', { exact: true })).toHaveValue('00:00:12.000');
  expect(await page.evaluate(() => (window as any).sessions)).toEqual(before);
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);

  for (const size of [{ width: 1024, height: 768 }, { width: 1000, height: 680 }]) {
    await page.setViewportSize(size);
    const editor = (await page.locator('.workspace').boundingBox())!;
    const dock = page.locator('.editor-dock');
    expect((await dock.boundingBox())!.height).toBeLessThanOrEqual(48);
    expect(await dock.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const centers = await dock.locator('button').evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect(); return box.y + box.height / 2;
    }));
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    for (const name of visibleActions.filter(name => !['在此分段', '分享选区 · 1080p'].includes(name))) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(editor.x);
      expect(box.x + box.width).toBeLessThanOrEqual(editor.x + editor.width + 1);
    }
  }
  expect(errors).toEqual([]);
});

test('whole label opens choices and double-click or F2 edits without adding a match', async ({ page }) => {
  const label = page.getByRole('button', { name: '下一段标签选择标签', exact: true });
  await label.click({ position: { x: 12, y: 12 } });
  await expect(page.locator('.editor-context .name-options')).toBeVisible();
  await expect(page.getByLabel('下一段标签', { exact: true })).toHaveCount(0);
  await page.locator('.editor-context .name-options').getByRole('button', { name: '男单', exact: true }).click();
  await expect(label).toContainText('男单');
  await label.dblclick({ position: { x: 12, y: 12 } });
  const input = page.getByLabel('下一段标签', { exact: true });
  await expect(input).toBeFocused();
  await expect(page.locator('.editor-context .name-options')).toHaveCount(0);
  await input.fill('临时名称');
  await input.press('Escape');
  await expect(label).toContainText('男单');
  await expect(input).toHaveCount(0);
  await label.press('F2');
  await input.fill('周三训练');
  await input.press('Enter');
  await expect(label).toContainText('周三训练');
  await expect(page.locator('.match-item')).toHaveCount(1);
  await label.press('Enter');
  await expect(page.locator('.editor-context .name-options')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.editor-context .name-options button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(label).toBeFocused();
  expect(await page.evaluate(() => (window as any).saves)).toHaveLength(0);
});
