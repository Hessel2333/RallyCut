# 发布与更新

Windows x64 安装包与 macOS Apple 芯片安装包发布到 https://github.com/Hessel2333/RallyCut/releases 。安装包采用当前用户安装，不修改应用 identifier，因此升级继续使用原有数据库、设置和缓存。

应用启动 15 秒后检查更新，此后每 4 小时检查一次。默认自动下载，可在“版本与更新”中关闭。安装始终由用户点击“安装并重新打开”，导入、预览、硬件检测、导出队列或未保存标记会阻止安装。Windows 安装器完成后重新打开应用；新版本首次启动显示内置更新说明，关闭后不再重复显示。手动下载安装新版本也会显示说明；首次安装不冒充升级。

## 发布新版本

1. 同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `src/release-notes.json` 的版本号，并填写中文更新说明。
2. 执行 `npm install --package-lock-only` 和 `cargo check --manifest-path src-tauri/Cargo.toml` 更新锁文件。
3. 执行 `node scripts/check-release.mjs`、`npm test`、`npm run build` 和 `cargo test --locked --manifest-path src-tauri/Cargo.toml`。
4. 提交并推送代码后创建对应 `vX.Y.Z` 标签，再推送标签。也可在 GitHub Actions 手动运行 Release desktop app。
5. 工作流先创建草稿；Windows 上传安装包、更新签名和 `latest.json`，macOS 构建并验证 Apple 芯片 app/dmg。两端成功后，统一上传 Mac 包及校验和，再公开发布；失败时草稿不会成为更新源。

仓库 Actions secret `TAURI_SIGNING_PRIVATE_KEY` 保存 Tauri 更新签名私钥，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 可选。私钥必须在仓库外安全备份，不得提交，也不得在后续发布时重新生成。公钥已配置在 Tauri 配置中。

Tauri 更新签名用于验证下载包，不等于 Windows Authenticode 代码签名。未配置商业代码签名证书时，Windows 可能提示未知发布者。

## 本地打包

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\Users\你的用户名\.tauri\RallyCut.key'
npx tauri build --bundles nsis -- --locked
```

产物位于 `src-tauri/target/release/bundle/nsis/`。FFmpeg 与 ffprobe 暂不内置，需要在设置中指定可执行文件或通过 PATH 提供。

自动更新通过 HTTPS 请求 GitHub Releases，网络不可用时保留当前版本并允许重试；关闭自动更新后只通过手动检查触发新的检查。正在进行的下载不会强行中断。更新说明按普通文本显示，不执行远程 HTML。


发布后需匿名读取 `releases/latest/download/latest.json`，确认版本、稳定 tag 下载地址及签名。GitHub 草稿的 `browser_download_url` 可能临时指向 `untagged-*`；finalize-update 会按版本和已知 Release 资产生成稳定地址，不能直接沿用临时地址。替换清单后应复查默认更新入口，避免将 CDN 的旧缓存视为最新文件。

## macOS 下载包（v0.6.0 起）

提供 Apple 芯片（aarch64）DMG、`.app.tar.gz` 和 `SHA256SUMS-macos.txt`。Mac 包使用本地临时签名（ad-hoc），未使用 Developer ID 分发签名，也未公证；系统可能阻止首次打开。v0.6.0 的已发布清单尚无 Mac 自动更新包。后续发布流程会使用现有 Tauri 密钥签名 Mac 更新归档，并在公开版本前合并 `darwin-aarch64` 更新信息；应用保留自动检查、下载及确认安装流程。Intel Mac 暂不提供安装包。

macOS 构建从同一发布标签生成；版本、包签名完整性检查通过后才上传。必须直接复制 Tauri 生成的 `.app.tar.gz` 与 `.sig`，不能重新压缩已签名归档。最终发布步骤保留 Windows 条目并加入 Mac 条目，缺少 Mac 归档或签名会阻止公开发布。Tauri 更新签名独立于 Developer ID 和公证，不代表已通过 Apple 分发认证。
