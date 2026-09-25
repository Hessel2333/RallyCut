# macOS 兼容状态

已完成代码适配，尚未在 macOS 真机或 CI 上执行验收，没有生成 Mac 安装包。

- FFmpeg/ffprobe 使用无 `.exe` 的可执行文件名；支持手动路径、应用 tools 目录、环境变量、PATH，以及 `/opt/homebrew/bin`、`/usr/local/bin`。
- H.264 / H.265 分别短测 `h264_videotoolbox` / `hevc_videotoolbox`，禁止把 VideoToolbox 软件回退误报为硬件可用。失败时按同一编码格式回退 libx264 / libx265，FFmpeg 必须包含相应编码器。
- 输出目录通过 Finder 的 `open` 打开；H.265 MP4 写入 `hvc1` 标签。
- `tauri.macos.conf.json` 使用 app/dmg 和 icns。Mac updater 产物暂不开启，现有发布工作流仍只发布 Windows。CI 包含 macos-latest 编译/测试任务，运行结果以 GitHub Actions 为准。

## 在 Mac 上验证

安装 Xcode Command Line Tools、Rust stable、Node.js 22 和可信来源的原生 FFmpeg（例如自行安装 Homebrew 的 ffmpeg）。不运行自动下载脚本。

```sh
npm ci
npm run tauri dev
# 构建本机架构的 app/dmg，正式分发另需签名、公证
npm run tauri build
```

原来的 Windows 路径无法在 Mac 上直接使用。需要在 Mac 导入可访问的素材；暂未实现跨系统工程迁移。重点验收原片/代理播放、原生目录选择、跨文件导出、VideoToolbox 编码、取消任务、中文路径以及 app/dmg 启动。当前长片合成集成测试仍使用 Windows 字体，Mac 需调整测试字体后执行；普通 cargo test 不执行这些 ignored 用例。

参考：[Tauri prerequisites](https://tauri.app/start/prerequisites/)、[FFmpeg VideoToolbox implementation](https://ffmpeg.org/doxygen/7.0/videotoolboxenc_8c.html)。此次未增加新的第三方依赖；许可证沿用项目依赖说明。
