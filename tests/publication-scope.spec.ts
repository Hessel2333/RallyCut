import { test, expect } from "@playwright/test";

test("select a shooting record or day, protect draft edits and export covers without logging in", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    w.calls = [];
    w.callbacks = {};
    localStorage.setItem("rallycut-auto-update", "false");
    localStorage.setItem("rallycut-seen-version", "0.6.1");
    localStorage.setItem("rallycut-session", "morning");
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
    const sessions = [
      {
        id: "morning",
        name: "上午练习",
        date: "2026-09-26",
        asset_ids: [],
        matches: [
          {
            id: "m1",
            name: "男单",
            ranges: [{ asset_id: "video", start_us: 0, end_us: 1000000 }],
            note: "",
          },
        ],
      },
      {
        id: "evening",
        name: "晚间练习",
        date: "2026-09-26",
        asset_ids: [],
        matches: [
          {
            id: "m2",
            name: "男双",
            ranges: [{ asset_id: "video", start_us: 0, end_us: 1000000 }],
            note: "",
          },
        ],
      },
      {
        id: "next",
        name: "周日练习",
        date: "2026-09-27",
        asset_ids: [],
        matches: [
          {
            id: "m3",
            name: "混双",
            ranges: [{ asset_id: "video", start_us: 0, end_us: 1000000 }],
            note: "",
          },
        ],
      },
      {
        id: "empty",
        name: "封面备选",
        date: "2026-09-28",
        asset_ids: [],
        matches: [],
      },
    ];
    const draft = (id: string, session: string, title: string) => ({
      id,
      session_ids: [session],
      title,
      revision: 1,
      account_id: null,
      description: "",
      cover_path: `/${session}.jpg`,
      category: 0,
      tags: "羽毛球",
      visibility: "public",
      status: "draft",
      error: "",
      parts: [
        {
          id: `${id}-p1`,
          artifact_id: `${session}-video`,
          job_id: null,
          name: title,
        },
      ],
    });
    w.state = {
      drafts: [
        draft("d1", "morning", "九月二十六日的练习"),
        draft("d2", "next", "九月二十七日的练习"),
      ],
      artifacts: sessions.slice(0, 3).map((s) => ({
        id: `${s.id}-video`,
        session_id: s.id,
        segment: { name: s.name },
        codec: "hevc",
        duration_us: 5e6,
        availability: "available",
        path: `/${s.id}.mp4`,
      })),
      publications: [],
      uploads: [],
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
        if (cmd === "plugin:event|listen") return 1;
        if (cmd === "plugin:app|version") return "0.6.1";
        if (cmd === "snapshot")
          return {
            sessions,
            assets: [],
            jobs: [],
            match_numbers: {},
            settings: {
              theme: "dark",
              output: "D:/exports",
              ffmpeg: "",
              ffprobe: "",
              library: "",
            },
            paused: false,
          };
        if (cmd === "tool_status")
          return { ffmpeg: { available: true }, ffprobe: { available: true } };
        if (cmd === "export_preferences")
          return { current: preset, presets: [] };
        if (cmd === "cached_previews") return [];
        if (cmd === "publication_snapshot") return structuredClone(w.state);
        if (cmd === "publication_account") throw Error("未登录");
        if (cmd === "cover_candidates")
          return sessions
            .filter((s) => args.sessionIds.includes(s.id))
            .map((s) => ({
              id: s.id,
              path: `/${s.id}.jpg`,
              name: `${s.name}封面`,
              time_us: 1e6,
            }));
        if (cmd === "cover_preview")
          return (
            "data:image/svg+xml," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#445e75"/></svg>',
            )
          );
        if (cmd === "export_cover") {
          if (w.failExport) throw Error("请先在导出设置中选择输出目录");
          return `D:/exports/${sessions.find((s) => s.id === args.sessionId)!.date.replaceAll("-", ".")}-日常羽毛球/封面.jpg`;
        }
        if (cmd === "publication_save") {
          if (w.failSave) throw Error("草稿保存失败");
          const saved = { ...args.draft, revision: args.draft.revision + 1 };
          w.state.drafts = w.state.drafts.map((d: any) =>
            d.id === saved.id ? saved : d,
          );
          return saved;
        }
        if (cmd === "publication_from_sessions") {
          const result = {
            ...draft("day", args.sessionIds[0], "2026-09-26 日常羽毛球"),
            session_ids: args.sessionIds,
            parts: sessions
              .filter((s) => args.sessionIds.includes(s.id))
              .flatMap((s) =>
                s.matches.map((m) => ({
                  id: m.id,
                  artifact_id: `${s.id}-video`,
                  job_id: null,
                  name: m.name,
                })),
              ),
          };
          w.state.drafts.push(result);
          return result;
        }
        return null;
      },
    };
  });
  await page.goto("/");
  await expect(page).toHaveTitle("RallyCut");
  await page.getByRole("button", { name: "B 站发布", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "B 站发布", exact: true });
  const selector = panel.getByLabel("拍摄记录或日期");
  await expect(selector).toHaveValue("session:morning");
  await expect(panel.getByLabel("投稿标题")).toHaveValue("九月二十六日的练习");
  await expect(
    panel.getByRole("button", { name: /九月二十七日的练习/ }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "选择封面备选：周日练习封面" }),
  ).toHaveCount(0);

  await panel.getByRole("button", { name: "导出封面到日期文件夹" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "封面已导出" }),
  ).toContainText("2026.09.26-日常羽毛球/封面.jpg");
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.findLast((c: any) => c.cmd === "export_cover")
          .args,
    ),
  ).toEqual({ path: "/morning.jpg", sessionId: "morning" });
  await panel.getByRole("button", { name: "打开日期文件夹" }).click();

  await panel.getByLabel("投稿标题").fill("尚未保存的标题");
  await selector.selectOption("session:next");
  const guard = page.getByRole("dialog", {
    name: "保存投稿草稿？",
    exact: true,
  });
  await guard.getByRole("button", { name: "继续编辑" }).click();
  await expect(selector).toHaveValue("session:morning");
  await expect(panel.getByLabel("投稿标题")).toHaveValue("尚未保存的标题");
  await selector.selectOption("session:next");
  await page.evaluate(() => {
    (window as any).failSave = true;
  });
  await guard.getByRole("button", { name: "保存并继续" }).click();
  await expect(guard.getByRole("alert")).toContainText("草稿保存失败");
  await expect(selector).toHaveValue("session:morning");
  await page.evaluate(() => {
    (window as any).failSave = false;
  });
  await guard.getByRole("button", { name: "保存并继续" }).click();
  await expect(panel.getByLabel("投稿标题")).toHaveValue("九月二十七日的练习");
  await expect(
    panel.getByRole("button", { name: "打开日期文件夹" }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "选择封面备选：上午练习封面" }),
  ).toHaveCount(0);

  await selector.selectOption("date:2026-09-26");
  await panel
    .getByRole("button", { name: "新建草稿并准备成片", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "选择封面备选：晚间练习封面" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /2026-09-26 日常羽毛球/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("P1 名称", { exact: true })).toHaveValue(
    "男单",
  );
  await expect(panel.getByLabel("P2 名称", { exact: true })).toHaveValue(
    "男双",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.findLast(
          (c: any) => c.cmd === "publication_from_sessions",
        ).args.sessionIds,
    ),
  ).toEqual(["morning", "evening"]);
  await page.screenshot({
    path: `${process.env.TEMP}/rallycut-publishing-scope-desktop.png`,
  });

  await selector.selectOption("session:empty");
  await expect(panel.getByLabel("投稿标题")).toHaveCount(0);
  await panel
    .getByRole("button", { name: "选择封面备选：封面备选封面" })
    .click();
  await page.evaluate(() => {
    (window as any).failExport = true;
  });
  await panel.getByRole("button", { name: "导出封面到日期文件夹" }).click();
  await expect(panel.getByRole("alert")).toContainText(
    "请先在导出设置中选择输出目录",
  );
  await page.evaluate(() => {
    (window as any).failExport = false;
  });
  await panel.getByRole("button", { name: "导出封面到日期文件夹" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "封面已导出" }),
  ).toContainText("2026.09.28-日常羽毛球/封面.jpg");
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((c: any) =>
        [
          "publication_upload",
          "publication_submit",
          "publication_login",
        ].includes(c.cmd),
      ),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("button", { name: "导出封面到日期文件夹" }),
  ).toBeVisible();
  const dimensions = await panel.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(390);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  await page.screenshot({
    path: `${process.env.TEMP}/rallycut-publishing-scope-mobile.png`,
  });
});
