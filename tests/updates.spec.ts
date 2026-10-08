import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const releaseNotes = JSON.parse(readFileSync(new URL("../src/release-notes.json", import.meta.url), "utf8")) as { version: string; notes: string };

async function setup(page: Page, options: { previous?: string; auto?: boolean; result?: string; blocked?: boolean; supported?: boolean } = {}) {
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
        if (cmd === "supports_app_update") return options.supported ?? true;
        if (cmd === "plugin:app|version") return options.currentVersion;
        if (cmd === "publication_snapshot") return { drafts: [], artifacts: [], uploads: [], publications: [], active: false };
        if (cmd === "snapshot") return { sessions: [], assets: [], jobs: options.blocked ? [{ id: "active", status: "exporting" }] : [], match_numbers: {}, paused: false, data_dir: "", settings: { ffmpeg: "", ffprobe: "", library: "", output: "" } };
        if (cmd === "tool_status") return { ffmpeg: { available: false }, ffprobe: { available: false } };
        if (cmd === "cached_previews") return [];
        if (cmd === "export_preferences") return { current: { width: 3840, height: 2160, bitrate_kbps: 20000, audio_kbps: 192, force_60: false, encoder: "auto", acknowledge_sdr: false }, presets: [] };
        if (cmd === "plugin:updater|check") {
          if (w.updateResult === "missing-mac") throw new Error("the platform `darwin-aarch64` was not found in the response `platforms` object");
          if (w.updateResult === "error") throw new Error("offline");
          if (w.updateResult === "latest") return null;
          return { rid: 2, currentVersion: options.currentVersion, version: "99.0.0", body: "改进导出速度\n修复播放问题", rawJson: {} };
        }
        if (cmd === "plugin:updater|download") {
          args.onEvent.onmessage({ event: "Started", data: { contentLength: 100 } });
          args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 100 } });
          return 3;
        }
        return 1;
      },
    };
  }, { ...options, currentVersion: releaseNotes.version });
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
  await expect(page.getByRole("heading", { name: `已更新至 ${releaseNotes.version}` })).toBeVisible();
  await expect(page.locator(".release-notes")).toHaveText(releaseNotes.notes);
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


test("failed installation releases the queue guard and permits a fresh download", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "plugin:updater|install") throw new Error("installer unavailable");
      if (cmd === "plugin:resources|close") throw new Error("resource already consumed");
      return invoke(cmd, args);
    };
  });
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.getByRole("button", { name: "安装并重新打开" }).click();
  await expect(page.getByRole("alert")).toContainText("未能安装更新");
  expect(await page.evaluate(() => (window as any).calls.includes("end_app_update"))).toBe(true);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载更新", exact: true })).toBeVisible();
});

test("failed download never reaches installation", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "plugin:updater|download") throw new Error("signature verification failed");
      return invoke(cmd, args);
    };
  });
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("更新包校验失败");
  expect(await page.evaluate(() => (window as any).calls.includes("plugin:updater|install"))).toBe(false);
});

test("manual-update platforms never request automatic updates and open the release page", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page, { supported: false, auto: true });
  await page.clock.fastForward(16000);
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await expect(
    page.getByText("当前平台暂不支持自动更新", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "检查更新", exact: true }),
  ).toHaveCount(0);
  if (process.env.RALLYCUT_QA_SCREENSHOT) await page.screenshot({ path: process.env.RALLYCUT_QA_SCREENSHOT });
  await page.getByRole("button", { name: "前往官方下载页" }).click();
  expect(
    await page.evaluate(() =>
      (window as any).calls.includes("open_app_releases"),
    ),
  ).toBe(true);
  await page.clock.fastForward(4 * 60 * 60 * 1000);
  expect(
    await page.evaluate(() =>
      (window as any).calls.includes("plugin:updater|check"),
    ),
  ).toBe(false);
});


test("Mac missing artifact retains automatic updates and can retry when available", async ({ page }) => {
  await setup(page, { supported: true, auto: true, result: "missing-mac" });
  await page.getByRole("button", { name: "版本与更新", exact: true }).click();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("尚未提供");
  await expect(page.getByRole("alert")).not.toContainText("网络");
  await expect(page.getByRole("button", { name: "前往官方下载页" })).toBeVisible();
  await page.evaluate(() => { (window as any).updateResult = "available"; });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "安装并重新打开" })).toBeEnabled();
});


test("library import defaults to normal copy and offers optional readback", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "导入素材", exact: true }).first().click();
  await page.getByRole("button", { name: "复制到素材库", exact: true }).click();
  const verify = page.getByRole("checkbox", { name: "复制后完整校验（更耗时）" });
  await expect(verify).not.toBeChecked();
  await verify.check();
  await expect(verify).toBeChecked();
  await page.getByRole("button", { name: "就地引用", exact: true }).click();
  await expect(verify).toHaveCount(0);
});
