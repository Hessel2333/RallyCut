import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("rallycut-auto-update", "false");
    localStorage.removeItem("rallycut-seen-version");
    const w = window as any;
    w.isTauri = true;
    w.calls = [];
    const preset = {
      codec: "hevc",
      width: 3840,
      height: 2160,
      bitrate_kbps: 20000,
      audio_kbps: 192,
      force_60: false,
      encoder: "auto",
      acknowledge_sdr: false,
    };
    w.jobs = Array.from({ length: 30 }, (_, i) => ({
      id: `j${i}`,
      session_id: i === 29 ? "other" : "s",
      segment: { id: `m${i}`, name: `比赛${i}`, ranges: [], note: "" },
      assets: [],
      preset,
      output: `C:/视频/${i}.mp4`,
      status:
        i === 0
          ? "exporting"
          : i === 1
            ? "waiting"
            : i === 2
              ? "failed"
              : "completed",
      progress: 0.5,
      speed: "",
      error: "",
      validation: "",
    }));
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      convertFileSrc: (path: string) =>
        `http://127.0.0.1:1420/test-missing-video.mp4`,
      transformCallback: (f: any) => {
        w.callbacks ??= {};
        const id = Object.keys(w.callbacks).length + 1;
        w.callbacks[id] = f;
        return id;
      },
      unregisterCallback: () => {},
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        if (cmd === "set_theme_preference") {
          localStorage.setItem("test-theme", args.theme);
          return null;
        }
        if (cmd === "plugin:event|listen" && args.event === "media-dropped") {
          w.dropHandler = w.callbacks[args.handler];
          return 10;
        }
        if (cmd === "file_modified_ms")
          return new Date(2026, 8, 23, 12).getTime();
        if (cmd === "plugin:app|version") return "0.3.0";
        if (cmd === "save_session") {
          w.mediaSession = args.session;
          return null;
        }
        if (cmd === "snapshot")
          return {
            sessions: w.mediaSession
              ? [w.mediaSession]
              : [
                  {
                    id: "s",
                    name: "周三羽毛球",
                    date: "2026-09-23",
                    asset_ids: [],
                    matches: [],
                  },
                ],
            assets: w.mediaAssets ?? [],
            jobs: w.jobs,
            match_numbers: {},
            paused: false,
            data_dir: "",
            settings: {
              theme: localStorage.getItem("test-theme") || "dark",
              ffmpeg: "",
              ffprobe: "",
              library: "",
              output: "",
            },
          };
        if (cmd === "tool_status")
          return {
            ffmpeg: { available: false },
            ffprobe: { available: false },
          };
        if (cmd === "cached_previews") return [];
        if (cmd === "export_preferences")
          return { current: preset, presets: [] };
        if (cmd === "delete_export_jobs") {
          if (w.failDelete) throw new Error("删除失败，请重试");
          w.jobs = w.jobs.filter((j: any) => !args.jobIds.includes(j.id));
        }
        if (cmd === "queue_action" && args.action === "cancel")
          w.jobs = w.jobs.map((j: any) =>
            j.id === args.jobId ? { ...j, status: "cancelled" } : j,
          );
        return null;
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /任务队列/ }).click();
}

test("large queue scrolls within dialog and clears only visible ended jobs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "导出任务" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".job")).toHaveCount(29);
  const rect = await dialog.boundingBox();
  expect(rect!.height).toBeGreaterThan(600);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(768);
  expect(
    await dialog
      .locator(".queue-list")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(true);
  await expect(
    dialog.locator('[data-job-id="j0"]').getByRole("button", { name: /删除/ }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "清除已结束记录" }).click();
  await expect(dialog.locator(".job")).toHaveCount(2);
  await dialog.getByLabel("任务范围").selectOption("all");
  await expect(dialog.locator(".job")).toHaveCount(3);
  await expect(dialog.locator('[data-job-id="j29"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /任务队列/ })).toBeFocused();
});

test("single deletion is immediate, reports failure and supports retry; waiting job must be cancelled first", async ({
  page,
}) => {
  await setup(page);
  const dialog = page.getByRole("dialog", { name: "导出任务" });
  await page.evaluate(() => {
    (window as any).failDelete = true;
  });
  await dialog
    .getByRole("button", { name: "删除任务记录：比赛28", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("删除失败");
  await page.evaluate(() => {
    (window as any).failDelete = false;
  });
  await dialog
    .getByRole("button", { name: "删除任务记录：比赛28", exact: true })
    .click();
  await expect(dialog.locator('[data-job-id="j28"]')).toHaveCount(0);
  const waiting = dialog.locator('[data-job-id="j1"]');
  await expect(waiting.getByRole("button", { name: /删除/ })).toHaveCount(0);
  await waiting.getByRole("button", { name: "取消", exact: true }).click();
  await expect(waiting.getByRole("button", { name: /删除/ })).toBeVisible();
  await expect(dialog.locator('[data-job-id="j0"]')).toContainText("正在导出");
});

test("import selects video files directly and cancellation preserves selection", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const w = window as any;
    const base = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "file_modified_ms")
        return new Date(2026, 8, 23, 12).getTime();
      if (cmd === "choose_video_files") {
        w.picks = (w.picks ?? 0) + 1;
        return w.picks === 1
          ? ["C:/素材/视频 ' 1.mp4", "C:/素材/视频 2.mp4"]
          : null;
      }
      return base(cmd, args);
    };
  });
  await page
    .getByRole("button", { name: "导入素材", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "选择视频", exact: true }).click();
  await expect(page.locator(".scan-list > div")).toHaveCount(2);
  await expect(page.locator(".scan-list")).toContainText("视频 ' 1.mp4");
  await expect(page.locator("input[type=date]")).toHaveValue("2026-09-23");
  await page.locator("input[type=date]").fill("2026-09-20");
  await page.getByRole("button", { name: "选择视频", exact: true }).click();
  await expect(page.locator(".scan-list > div")).toHaveCount(2);
});
test("session deletion requires confirmation and preserves files", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "删除拍摄记录：周三羽毛球（2026-09-23）" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "删除拍摄记录？" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((c: any) => c.cmd === "delete_session"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).calls.some(
          (c: any) => c.cmd === "delete_session" && c.args.sessionId === "s",
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("drag event opens import and folder naming persists through settings", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (window as any).dropHandler({
      event: "media-dropped",
      payload: ["C:/素材/A.mp4", "C:/素材/B.mp4"],
    }),
  );
  await expect(page.locator(".scan-list > div")).toHaveCount(2);
  await expect(page.locator("input[type=date]")).toHaveValue("2026-09-23");
  await expect(page.getByRole("button", { name: "选择拍摄日期" })).toHaveCount(
    0,
  );
  await expect(page.locator("input[type=date]")).toHaveCSS(
    "color-scheme",
    "dark",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导出设置", exact: true }).click();
  await page.getByText("文件夹命名规则", { exact: true }).click();
  await page.getByLabel("文件夹名称").fill("{date}-{name}");
  await page.getByRole("button", { name: "保存命名规则" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).calls.some(
          (c: any) =>
            c.cmd === "save_settings" &&
            c.args.value.folder_template === "{date}-{name}",
        ),
      ),
    )
    .toBe(true);
});

test("appearance switches, follows system changes and survives reload", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("Escape");

  const selector = page.getByLabel("外观主题");
  await selector.getByRole("button", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await selector.getByRole("button", { name: "系统" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await selector.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("deleted middle match can be restored and split match boundaries edited", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.mediaAssets = [
      {
        id: "a",
        name: "test.mp4",
        path: "test.mp4",
        original_path: "test.mp4",
        size: 1,
        sha256: "",
        verification: "",
        available: true,
        duration_us: 30000000,
        metadata: {
          streams: [
            {
              codec_type: "video",
              width: 1280,
              height: 720,
              avg_frame_rate: "60/1",
            },
          ],
          format: {},
        },
      },
    ];
    w.mediaSession = {
      id: "s",
      name: "周三羽毛球",
      date: "2026-09-23",
      asset_ids: ["a"],
      matches: [0, 1, 2].map((i) => ({
        id: "m" + i,
        name: "局" + (i + 1),
        note: "",
        ranges: [
          { asset_id: "a", start_us: i * 10000000, end_us: (i + 1) * 10000000 },
        ],
      })),
    };
  });
  await setup(page);
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".library-bottom").getByLabel("外观主题"),
  ).toBeVisible();
  await page.locator(".match-item").nth(1).getByTitle("删除比赛标记").click();
  await expect(page.getByLabel("开始时间", { exact: true })).toHaveValue(
    "00:00:10.000",
  );
  await expect(page.getByLabel("结束时间", { exact: true })).toHaveValue(
    "00:00:20.000",
  );
  await page.getByRole("button", { name: "添加一局", exact: true }).click();
  await expect(page.locator(".match-block")).toHaveCount(3);
  await page.locator(".match-block").nth(1).click();
  const start = page.getByLabel("开始时间", { exact: true });
  await start.fill("00:00:12.000");
  await start.press("Tab");
  await page.locator(".match-item").nth(1).getByText("备注与精确时间").click();
  await expect(
    page.locator(".match-item").nth(1).getByLabel("起点", { exact: true }),
  ).toHaveValue("00:00:12.000");
  const handle = page
    .locator(".match-block")
    .nth(1)
    .locator(".segment-handle.start");
  const box = (await handle.boundingBox())!;
  const track = (await page.locator(".timeline").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.45, box.y + box.height / 2);
  await page.mouse.up();
  await expect(start).not.toHaveValue("00:00:12.000");
  await page.getByTitle("撤销（Ctrl+Z）").click();
  await expect(
    page.locator(".match-item").nth(1).getByLabel("起点", { exact: true }),
  ).toHaveValue("00:00:12.000");
  await page
    .getByRole("button", {
      name: "选择空档 00:00:10.000—00:00:12.000",
      exact: true,
    })
    .click();
  await expect(start).toHaveValue("00:00:10.000");
  await expect(page.getByLabel("结束时间", { exact: true })).toHaveValue(
    "00:00:12.000",
  );
});

test("editor shortcuts, menus, tags and panel resizing", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.mediaAssets = [
      {
        id: "a",
        name: "test.mp4",
        path: "test.mp4",
        original_path: "test.mp4",
        size: 1024,
        available: true,
        duration_us: 30000000,
        metadata: {
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              avg_frame_rate: "60/1",
              width: 1280,
              height: 720,
              bit_rate: "20000000",
            },
          ],
          format: { bit_rate: "20192000" },
        },
      },
    ];
    w.mediaSession = {
      id: "s",
      name: "周三羽毛球",
      date: "2026-09-23",
      asset_ids: ["a"],
      matches: [
        {
          id: "m",
          name: "测试片段",
          note: "",
          ranges: [{ asset_id: "a", start_us: 0, end_us: 30000000 }],
        },
      ],
    };
  });
  await setup(page);
  await page.keyboard.press("Escape");
  await expect(page.getByText("视频工具已就绪", { exact: true })).toHaveCount(
    0,
  );
  await page.locator(".timeline").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".transport")).toContainText("00:00:04.000");
  await page.keyboard.press("f");
  await expect(page.locator(".transport")).toContainText("00:00:04.016");
  await page.keyboard.press("d");
  await expect(page.locator(".transport")).toContainText("00:00:04.000");
  const timeline = (await page.locator(".timeline").boundingBox())!;
  await page.mouse.move(timeline.x + timeline.width * 0.1, timeline.y + 8);
  await page.mouse.down();
  await page.mouse.move(timeline.x + timeline.width * 0.6, timeline.y + 8);
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect(page.locator(".transport")).toContainText("00:00:18.");
  await page.getByRole("button", { name: "播放速度", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "播放速度", exact: true }),
  ).toContainText("1.5×");
  await page.locator(".viewer").click({ button: "right" });
  await page.getByRole("menuitem", { name: "原始素材信息" }).click();
  await expect(
    page.getByRole("dialog", { name: "原始素材信息" }),
  ).toContainText("20,000 kbps");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "管理标签" }).click();
  await page.getByLabel("快捷标签列表").fill("访谈\n旅行\n访谈");
  await page.getByRole("button", { name: "保存标签" }).click();
  await expect(
    page
      .locator(".tag-toolbar")
      .getByRole("button", { name: "旅行", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("rallycut-tags")!),
    ),
  ).toEqual(["访谈", "旅行"]);
  const width = await page
    .locator(".library")
    .evaluate((e) => e.getBoundingClientRect().width);
  const bar = (await page
    .getByRole("separator", { name: "调整拍摄列表宽度" })
    .boundingBox())!;
  await page.mouse.move(bar.x + 3, bar.y + 40);
  await page.mouse.down();
  await page.mouse.move(bar.x + 43, bar.y + 40);
  await page.mouse.up();
  expect(
    await page
      .locator(".library")
      .evaluate((e) => e.getBoundingClientRect().width),
  ).toBeGreaterThan(width + 30);
  await page
    .getByRole("button", { name: "比赛1名称选择标签", exact: true })
    .click();
  await page
    .locator(".name-options")
    .getByRole("button", { name: "旅行", exact: true })
    .click();
  await expect(page.getByLabel("比赛1名称", { exact: true })).toHaveValue(
    "旅行",
  );
  await page.getByLabel("比赛1名称", { exact: true }).fill("自由名称");
  await page.getByLabel("比赛1名称", { exact: true }).press("Tab");
  await expect(page.getByLabel("比赛1名称", { exact: true })).toHaveValue(
    "自由名称",
  );
  await page.locator(".match-item").click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".match-item")).toHaveCount(0);
  await page.locator(".source-track > div").focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "移除素材？" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((c: any) => c.cmd === "remove_session_asset"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "移除素材？" })).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("方向键步进秒数").fill("2");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".timeline").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".transport")).toContainText("00:00:02.000");
});

test("outside close prompts to save export settings; failed save keeps draft", async ({
  page,
}) => {
  await setup(page);
  await page.mouse.click(2, 2);
  await expect(page.getByRole("dialog", { name: "导出任务" })).toHaveCount(0);
  await page.getByRole("button", { name: "导出设置", exact: true }).click();
  await page.mouse.click(2, 2);
  await expect(page.locator(".export-modal")).toHaveCount(0);
  await page.getByRole("button", { name: "导出设置", exact: true }).click();
  await page.getByText("文件夹命名规则", { exact: true }).click();
  await page.getByLabel("文件夹名称").fill("{date}-旅行");
  await page.mouse.click(2, 2);
  const prompt = page.getByRole("dialog", { name: "保存更改？" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByLabel("文件夹名称")).toHaveValue("{date}-旅行");
  await page.evaluate(() => {
    const w = window as any;
    const base = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === "save_settings" && !w.allowSave) throw Error("保存失败");
      return base(cmd, args);
    };
  });
  await page.mouse.click(2, 2);
  await prompt.getByRole("button", { name: "保存并关闭" }).click();
  await expect(prompt.getByRole("alert")).toContainText("保存失败");
  await expect(page.getByLabel("文件夹名称")).toHaveValue("{date}-旅行");
  await page.evaluate(() => {
    (window as any).allowSave = true;
  });
  await prompt.getByRole("button", { name: "保存并关闭" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.locator(".export-modal")).toHaveCount(0);
  await page.getByRole("button", { name: "管理标签" }).click();
  await page.getByLabel("快捷标签列表").fill("采访");
  await page.mouse.click(2, 2);
  await prompt.getByRole("button", { name: "不保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("date click opens picker while manual entry remains available", async ({
  page,
}) => {
  await setup(page);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "导入素材", exact: true })
    .first()
    .click();
  await page.evaluate(() => {
    HTMLInputElement.prototype.showPicker = function () {
      (window as any).pickerCalls = ((window as any).pickerCalls ?? 0) + 1;
    };
  });
  const date = page.locator("input[type=date]");
  await date.click({ position: { x: 18, y: 10 } });
  expect(await page.evaluate(() => (window as any).pickerCalls)).toBe(1);
  await date.fill("2026-08-20");
  await expect(date).toHaveValue("2026-08-20");
  await page.mouse.click(2, 2);
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
});
