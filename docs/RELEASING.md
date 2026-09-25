# 发布与更新

Windows x64 安装包发布到 https://github.com/Hessel2333/RallyCut/releases 。安装包采用当前用户安装，不修改应用 identifier，因此升级继续使用原有数据库、设置和缓存。

应用启动 15 秒后检查更新，此后每 4 小时检查一次。默认自动下载，可在“版本与更新”中关闭。安装始终由用户点击“安装并重新打开”，导入、预览、硬件检测、导出队列或未保存标记会阻止安装。Windows 安装器完成后重新打开应用；新版本首次启动显示内置更新说明，关闭后不再重复显示。手动下载安装新版本也会显示说明；首次安装不冒充升级。

## 发布新版本

1. 同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `src/release-notes.json` 的版本号，并填写中文更新说明。
2. 执行 `npm install --package-lock-only` 和 `cargo check --manifest-path src-tauri/Cargo.toml` 更新锁文件。
3. 执行 `node scripts/check-release.mjs`、`npm test`、`npm run build` 和 `cargo test --locked --manifest-path src-tauri/Cargo.toml`。
4. 提交并推送代码后创建对应 `vX.Y.Z` 标签，再推送标签。也可在 GitHub Actions 手动运行 Release Windows app。
5. 工作流先创建草稿，上传安装包、签名和 `latest.json` 后才公开发布；失败时草稿不会成为更新源。

仓库 Actions secret `TAURI_SIGNING_PRIVATE_KEY` 保存 Tauri 更新签名私钥，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可选。私钥必须在仓库外安全备份，不得提交，也不得在后续发布时重新生成。公钥已配置在 Tauri 配置中。

Tauri 更新签名用于验证下载包，不等于 Windows Authenticode 代码签名。未配置商业代码签名证书时，Windows 可能提示未知发布者。

## 本地打包

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\Users\你的用户名\.tauri\RallyCut.key'
npm run tauri build -- --bundles nsis -- --locked
```

产物位于 `src-tauri/target/release/bundle/nsis/`。FFmpeg 与 ffprobe 暂不内置，需要在设置中指定可执行文件或通过 PATH 提供。

自动更新通过 HTTPS 请求 GitHub Releases，网络不可用时保留当前版本并允许重试；关闭自动更新后只通过手动检查触发新的检查。正在进行的下载不会强行中断。更新说明按普通文本显示，不执行远程 HTML。
