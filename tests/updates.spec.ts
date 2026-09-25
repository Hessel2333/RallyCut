import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, options: { previous?: string; auto?: boolean; result?: string; blocked?: boolean } = {}) {
  await page.addInitScript((options) => {
    if (!sessionStorage.getItem("test-initialized")) {
      localStorage.clear();
      if (options.previous) localStorage.setItem("rallycut-seen-version", options.previous);
      localStorage.setItem("rallycut-auto-update", String(options.auto ?? false));
      sessionStorage.setItem("test-initialized", "true");
    }
    const w = window as any;
    w.isTauri = true;
    w.calls = [];
    w.updateResult = options.result ?? "available";
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (cmd: string, args: any) => {
        w.calls.push(cmd);
        if (cmd === "plugin:app|version") return "0.2.0";
        if (cmd === "snapshot") return { sessions: [], assets: [], jobs: options.blocked ? [{ id: "active", status: "exporting" }] : [], match_numbers: {}, paused: false, data_dir: "", settings: { ffmpeg: "", ffprobe: "", library: "", output: "" } };
        if (cmd === "tool_status") return { ffmpeg: { available: false }, ffprobe: { available: false } };
        if (cmd === "cached_previews") return [];
        if (cmd === "export_preferences") return { current: { width: 3840, height: 2160, bitrate_kbps: 20000, audio_kbps: 192, force_60: false, encoder: "auto", acknowledge_sdr: false }, presets: [] };
        if (cmd === "plugin:updater|check") {
          if (w.updateResult === "error") throw new Error("offline");
          if (w.updateResult === "latest") return null;
          return { rid: 2, currentVersion: "0.2.0", version: "0.3.0", body: "改进导出速度\n修复播放问题", rawJson: {} };
        }
        if (cmd === "plugin:updater|download") {
          args.onEvent.onmessage({ event: "Started", data: { contentLength: 100 } });
          args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 100 } });
          return 3;
        }
        return 1;
      },
    };
  }, options);
  await page.goto("/");
}

test("manual check, download and install", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await setup(page);
  await expect(page).toHaveTitle("RallyCut");
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("改进导出速度", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByRole("button", { name: "安装并重新打开" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.includes("plugin:updater|install"))).toBe(true);
  expect(await page.evaluate(() => (window as any).calls.indexOf("begin_app_update") < (window as any).calls.indexOf("plugin:updater|install"))).toBe(true);
  expect(errors).toEqual([]);
});

test("automatic download waits for confirmation and respects active work", async ({ page }) => {
  await page.clock.install();
  await setup(page, { auto: true, blocked: true });
  await page.clock.fastForward(16000);
  await page.getByRole("button", { name: "更新已就绪" }).click();
  await expect(page.getByRole("button", { name: "安装并重新打开" })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).calls.includes("plugin:updater|install"))).toBe(false);
});

test("notes appear once after upgrade and support narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 750 });
  await setup(page, { previous: "0.1.0" });
  await expect(page.getByRole("heading", { name: "已更新至 0.2.0" })).toBeVisible();
  await expect(page.locator(".release-notes")).toContainText("新增 Windows 安装包");
  if (process.env.RALLYCUT_QA_SCREENSHOT) await page.screenshot({ path: process.env.RALLYCUT_QA_SCREENSHOT });
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(600);
  await page.getByRole("button", { name: "开始使用" }).click();
  await page.reload();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("network failure can retry and auto-update preference persists", async ({ page }) => {
  await page.clock.install();
  await setup(page, { result: "error" });
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => (window as any).calls.includes("plugin:updater|check"))).toBe(false);
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("检查网络");
  await page.evaluate(() => { (window as any).updateResult = "latest"; });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("当前已是最新版本");
});
