# 依赖、官方资料与许可

2026-09-27 增量：Rust 新增固定版本 reqwest 0.13.5（MIT OR Apache-2.0）、keyring 3.6.3（MIT OR Apache-2.0）、qrcode 0.14.1（MIT OR Apache-2.0）、base64 0.22（MIT OR Apache-2.0）。全部解析版本见 Cargo.lock。B 站协议参考固定 upstream 提交，授权与完整通知见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)，未引入直播服务或外部上传 CLI。

安全检查：npm 生产依赖 audit 为 0；包含开发依赖时现有 Vitest/@vitest/mocker 报 2 项 moderate（[GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)）。当前未启用其浏览器 mock 插件，未自动执行跨主版本修复。对 Cargo.lock 中 520 个 crates.io 包以公开名称/版本执行 OSV batch：glib 0.18.5 有 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)（Tauri 的 Linux GTK 传递依赖）；proc-macro-error 及 unic 系列另有停止维护提示。未通过替换底层 Tauri/GTK 的方式强行消除，仍需后续依赖升级评估。本检查不等同于完整安全审计。

2026-09-24 实际安装版本以 `package-lock.json` 与 `src-tauri/Cargo.lock` 为准。已核对安装包的 package/Cargo manifests 与官方文档，未复制参考项目实现、未把其他桌面应用当作后台。

| 直接依赖 | 本次版本 | 许可 |
| --- | --- | --- |
| Tauri Rust / API / CLI | 2.11.6 / 2.11.1 / 2.11.5 | MIT OR Apache-2.0 |
| tauri-build / tauri-plugin-dialog | 2.6.3 / 2.7.3 | MIT OR Apache-2.0 |
| React / React DOM | 19.3.0 | MIT |
| Vite / React Vite plugin | 6.4.3 / 4.7.0 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| Vitest / Prettier | 3.2.7 / 3.9.9 | MIT |
| Lucide React | 0.468.0 | ISC |
| rusqlite | 0.40.2 | MIT |
| serde / serde_json / uuid / sha2 | 锁文件版本 | MIT OR Apache-2.0 |
| tempfile（测试） | 3.27.0 | MIT OR Apache-2.0 |
| SQLite（rusqlite bundled） | 由 libsqlite3-sys 锁定 | Public domain |

API 依据：

- [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/)、[配置/CSP/asset protocol](https://v2.tauri.app/reference/config/)、[Dialog Rust API](https://v2.tauri.app/plugin/dialog/)
- [React 当前文档](https://react.dev/versions)、[Vite 文档](https://vite.dev/guide/features)
- [rusqlite 0.40.2](https://docs.rs/rusqlite/0.40.2/rusqlite/)
- [FFmpeg trim/atrim/concat/aresample 等滤镜](https://ffmpeg.org/ffmpeg-filters.html)
- [Windows MoveFileExW 不覆盖提交](https://learn.microsoft.com/zh-cn/windows/win32/api/winbase/nf-winbase-movefileexw)

FFmpeg **没有打包进应用**。本次调用本机既有的 `ffmpeg 7.0.1-full_build-www.gyan.dev`，构建参数包含 `--enable-gpl --enable-version3` 和 libx264。因此不能把此具体二进制笼统称为 LGPL；分发前须按其 GPL 组件和构建参数履行许可、对应源代码和通知义务。一般规则见 [FFmpeg 官方许可说明](https://ffmpeg.org/legal.html)。用户自选的其他 FFmpeg 构建可能有不同许可组合。

未引入 LosslessCut、ffui、ffmpeg-sidecar、HandBrakeCLI 或 rclone，也未复用其代码。未来如引入，需重新核对当时版本、API 与许可证。本文件记录直接依赖，尚未生成安装包所需的完整传递依赖版权清单。
