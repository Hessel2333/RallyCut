import { test, expect } from "@playwright/test";

test("publication draft order, upload separation, confirmation and dirty close", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    w.calls = [];
    w.callbacks = {};
    localStorage.setItem("rallycut-auto-update", "false");
    localStorage.setItem("rallycut-seen-version", "0.4.0");
    w.state = {
      drafts: [],
      artifacts: ["first", "second"].map((id, i) => ({
        id,
        segment: { name: `第${i + 1}局` },
        path: `/${id}.mp4`,
        codec: "hevc",
        duration_us: 5000000,
        availability: "available",
      })),
      uploads: [],
      publications: [],
      active: false,
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.__TAURI_INTERNALS__ = {
      transformCallback(f: any) {
        const id = Object.keys(w.callbacks).length + 1;
        w.callbacks[id] = f;
        return id;
      },
      unregisterCallback() {},
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        if (cmd === "plugin:event|listen") {
          w.listeners ??= {};
          w.listeners[args.event] = args.handler;
          return 1;
        }
        if (cmd === "plugin:app|version") return "0.4.0";
        if (cmd === "snapshot")
          return {
            sessions: [],
            assets: [],
            jobs: [],
            match_numbers: {},
            paused: false,
            settings: {
              theme: "dark",
              ffmpeg: "",
              ffprobe: "",
              library: "",
              output: "",
            },
          };
        if (cmd === "tool_status")
          return { ffmpeg: { available: true }, ffprobe: { available: true } };
        if (cmd === "cached_previews") return [];
        if (cmd === "export_preferences")
          return {
            current: {
              codec: "hevc",
              width: 3840,
              height: 2160,
              bitrate_kbps: 20000,
              audio_kbps: 192,
              force_60: false,
              encoder: "auto",
              acknowledge_sdr: false,
            },
            presets: [],
          };
        if (cmd === "cover_candidates") return [{ id: "cover1", path: "/cover.jpg", name: "精彩回合", time_us: 1200000 }];
        if (cmd === "cover_preview") return "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="green"/></svg>');
        if (cmd === "publication_snapshot") return structuredClone(w.state);
        if (cmd === "publication_login")
          return new Promise((resolve, reject) => {
            w.resolveQr = resolve;
            w.rejectQr = reject;
          });
        if (cmd === "publication_account")
          return { id: "42", name: "测试账号" };
        if (cmd === "publication_categories")
          return [{ id: 9, name: "测试分区" }];
        if (cmd === "publication_save") {
          if (w.failSave) throw Error("测试保存失败");
          const d = { ...args.draft, revision: args.draft.revision + 1 };
          w.state.drafts = [d];
          return d;
        }
        if (cmd === "publication_upload") {
          const d = w.state.drafts[0];
          d.account_id = "42";
          d.status = "uploading";
          d.revision++;
          w.state.active = true;
          w.state.uploads = d.parts.map((p: any) => ({
            id: p.id,
            draft_id: d.id,
            part_id: p.id,
            artifact_id: p.artifact_id,
            status: "uploading",
            bytes: 1024 ** 3,
            total: 4 * 1024 ** 3,
            remote: { filename: p.id },
          }));
          w.callbacks[w.listeners["publication-update"]]({ payload: null });
          return new Promise((resolve) => {
            w.finishUpload = () => {
              d.status = "awaiting_confirmation";
              w.state.active = false;
              w.state.uploads.forEach((u: any) => {
                u.status = "uploaded";
                u.bytes = u.total;
              });
              resolve(null);
            };
          });
        }
        if (cmd === "publication_submit") {
          w.state.publications = [
            {
              id: "local-intent-test",
              draft_id: args.draftId,
              status: "unknown",
              aid: null,
              bvid: null,
              error: "测试：服务端接受后响应丢失",
            },
          ];
          return null;
        }
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page).toHaveTitle("RallyCut");
  await page.getByRole("button", { name: "B 站发布", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "B 站发布", exact: true });
  await expect(panel).toContainText("测试账号（42）");
  await panel.getByRole("button", { name: "扫码登录", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "正在获取二维码…" }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).rejectQr("测试：网络请求失败"));
  await expect(panel.getByRole("alert").first()).toContainText(
    "测试：网络请求失败",
  );
  await expect(
    panel.getByRole("button", { name: "扫码登录", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "扫码登录", exact: true }).click();
  await page.evaluate(() =>
    (window as any).resolveQr(
      "data:image/svg+xml;base64," +
        btoa(
          '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/></svg>',
        ),
    ),
  );
  await expect(
    panel.getByRole("img", { name: "B 站登录二维码" }),
  ).toBeVisible();
  await expect(panel.getByRole("status")).toContainText(
    "请用哔哩哔哩 App 扫码",
  );
  await panel.getByRole("button", { name: "检查登录", exact: true }).click();
  await panel.getByLabel("第1局").check();
  await panel.getByLabel("第2局").check();
  await panel.getByRole("button", { name: "用勾选成片新建草稿" }).click();
  await panel.getByRole("button", { name: "选择封面备选：精彩回合" }).click();
  await expect(panel.getByRole("img", { name: "投稿封面预览", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "选择封面备选：精彩回合" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("img", { name: "投稿封面预览", exact: true })).toHaveJSProperty("naturalWidth", 320);
  await panel.getByRole("img", { name: "投稿封面预览", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.TEMP || "/tmp"}/rallycut-cover-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("img", { name: "投稿封面预览", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${process.env.TEMP || "/tmp"}/rallycut-cover-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await panel.getByLabel("上移 P2").click();
  await expect(panel.getByLabel("P1 名称", { exact: true })).toHaveValue(
    "第2局",
  );
  await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
  expect(await page.evaluate(() => (window as any).state.drafts[0].cover_path)).toBe("/cover.jpg");
  await panel.getByRole("button", { name: "上传 / 重试失败分 P" }).click();
  await expect(panel.getByLabel("P1 上传进度")).toContainText(
    "25.0% · 1.00 GiB / 4.00 GiB",
  );
  await page.evaluate(() => {
    const w = window as any;
    const u = w.state.uploads[0];
    u.bytes = 2 * 1024 ** 3;
    w.callbacks[w.listeners["upload-progress"]]({ payload: { ...u } });
  });
  await expect(panel.getByLabel("P1 上传进度")).toContainText(
    "50.0% · 2.00 GiB / 4.00 GiB",
  );
  await page.evaluate(() => (window as any).finishUpload());
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.filter((c: any) => c.cmd === "publication_submit")
          .length,
    ),
  ).toBe(0);
  await expect(
    panel.getByText("请选择投稿分区，无需重新上传文件。", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认投稿…" })).toBeDisabled();
  await panel.getByLabel("投稿分区").selectOption("9");
  await page.evaluate(() => {
    (window as any).failSave = true;
  });
  await panel.getByRole("button", { name: "确认投稿…" }).click();
  await expect(panel.getByRole("alert").first()).toContainText("测试保存失败");
  await expect(
    page.getByRole("dialog", { name: "确认公开投稿", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).failSave = false;
  });
  await panel.getByRole("button", { name: "确认投稿…" }).click();
  expect(
    await page.evaluate(() => (window as any).state.drafts[0].category),
  ).toBe(9);
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.filter((c: any) => c.cmd === "publication_upload")
          .length,
    ),
  ).toBe(1);

  const confirmation = page.getByRole("dialog", {
    name: "确认公开投稿",
    exact: true,
  });
  await expect(confirmation).toContainText("测试账号");
  await confirmation.getByRole("button", { name: "返回修改" }).click();
  await panel.getByLabel("投稿标题").fill("修改后标题");
  await panel.getByRole("button", { name: "关闭发布面板" }).click();
  const prompt = page.getByRole("dialog", { name: "保存投稿草稿？" });
  await prompt.getByRole("button", { name: "继续编辑" }).click();
  await expect(panel.getByLabel("投稿标题")).toHaveValue("修改后标题");
  await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
  await panel.getByRole("button", { name: "确认投稿…" }).click();
  await confirmation
    .getByRole("button", { name: "确认提交稿件", exact: true })
    .click();
  await expect(panel.locator(".publication-state")).toHaveText("结果待核实");
  await expect(panel.getByRole("button", { name: "确认投稿…" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.filter((c: any) => c.cmd === "publication_submit")
          .length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as any).state.drafts[0].parts.map((p: any) => p.artifact_id),
    ),
  ).toEqual(["second", "first"]);
  await expect(
    panel.getByRole("button", { name: "打开创作中心核对" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `${process.env.TEMP || "/tmp"}/rallycut-publication-desktop.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${process.env.TEMP || "/tmp"}/rallycut-publication-mobile.png`,
  });
});
