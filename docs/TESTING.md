# 验证记录

## 上传完成后投稿入口修复（2026-09-27）

只读确认用户两 P 均为 uploaded，草稿 category=0，未有 publication 提交意图。原界面只禁用按钮、不解释缺少分区；修改后显示明确前置条件，已上传时提示无需重传。编辑分区后点“确认投稿”先保存草稿，再打开最终公开投稿确认；保存失败保留编辑并拒绝打开确认。Playwright 先失败后通过，断言分区写入、保存失败保护和上传调用仍只有一次；前端构建通过。未替用户选择分区或提交真实稿件。

## 上传进度反馈修复（2026-09-27）

用户自行发起真实上传后报告“好像不能上传”。只读检查原生界面发现已确认字节数持续增长，并非没有传输；未代替用户点击上传、取消或投稿。本次补充每 P 的真实百分比、已上传/总容量、零字节准备提示和传完等待确认提示；发布面板打开时恢复本机已登录账号及分区，防止重载后错误提示未检查登录。未重启后端或中断这次上传。

发布 Playwright 回归先验证缺失进度文案和自动恢复账号均失败，再修复通过；覆盖 25%→50% 的真实事件字段更新。npm run build 通过。原生窗口已看到第一 P 从 270 MiB 增长到超过 1.5 GiB，且新进度文案已显示；这是上传进行中的验证，不等同于整文件上传成功或投稿成功。


## 扫码登录热修复（2026-09-27）

原生窗口复现“二维码来源无效”：真实扫码生成接口已经返回 `https://account.bilibili.com/h5/account-h5/auth/scan-web`，旧校验仅接受 passport 域名。先增加失败测试，再兼容当前及旧版精确端点；仍拒绝仿冒域名、HTTP、异常端口、用户信息和非预期路径。前端补充获取中提示及失败后重试，二维码请求上限为 15 秒。

验证：29 项 Rust 单元测试通过（原生凭据测试仍默认 ignored）；发布 Playwright 回归通过，覆盖获取中、失败重试、二维码显示和原有投稿确认；前端构建、原生构建及 cargo fmt 检查通过。已重启当前工作区应用，在 Windows 原生窗口点击扫码登录并确认真实二维码图像与提示出现。未扫码确认账号、上传文件或投稿。没有将真实二维码密钥写入测试夹具或日志。


## 2026-09-27 工作区增量（未发布）

基线为 `99fee92483cccd089638ba476c7abc7302bab90a`。先运行原有测试：17 Vitest、16 Playwright、21 Rust 单元测试通过，3 FFmpeg 测试默认忽略；再增加失败复现和修复。没有 reset、改动 design/、使用用户视频或生产数据库。

本次最终执行结果：

| 检查 | 结果 |
| --- | --- |
| `npm test` | 19/19 通过 |
| `npm run test:e2e` | 23/23 通过（Chromium，含有效合成视频） |
| `npm run build` | TypeScript 与 Vite 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 28 单元 + 1 路径恢复测试通过；4 FFmpeg、1 原生凭据测试按设计默认 ignored |
| 显式 `--test export_integration -- --ignored --nocapture` | 4/4 通过，使用本机原生 FFmpeg 7.0.1/ffprobe |
| 显式 `native_credential_store_roundtrip -- --ignored` | 1/1 通过，合成凭据 |
| 依赖检查 | npm 生产依赖 0；开发依赖 2 moderate，Rust OSV 警告见 [依赖记录](DEPENDENCIES.md) |

当前复现与覆盖：

- 共用首素材的会话切换、A→B→A、跨文件连续定位、代理晚完成、媒体失败重试：播放 FFmpeg 生成的小型有效 H.264 视频，浏览器原生媒体事件。WebView2 和任意 VFR 的逐帧精度不作保证。
- 保存串行合并、旧确认不覆盖新修订、刷新期间本地编辑、退出等待和失败取消：Vitest 延迟/失败写入及 Playwright IPC 控制；Rust 独立数据库覆盖重启持久化。
- 原片迁移后旧任务重试，原区间/预设不变；关键领取/最终写入故障注入；成片正式提交后 DB 未确认的收据恢复、任务清理保留历史。
- 发布 HTTP 契约测试使用本机可控 TCP 服务：实际上传适配器、部分 P 成功、429、认证过期、已接收投稿但响应丢失、重启恢复及拒绝重复提交。UI 的账号和投稿结果使用明确测试 mock，不能作为真实平台验收。
- 匿名检查实际 B 站扫码入口响应结构，未扫码登录；未读取浏览器 Cookie、上传文件或提交稿件。Windows 凭据管理器以独立测试服务名写入/读取/删除合成凭据，已通过。

重跑命令：

```powershell
npm test
npm run test:e2e
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
$env:RALLYCUT_FFMPEG_DIR = "C:/Program Files/ffmpeg-7.0.1-full_build/bin"
cargo test --locked --manifest-path src-tauri/Cargo.toml --test export_integration -- --ignored --nocapture
```

运行浏览器媒体测试前也需要上述 FFmpeg 环境变量；找不到真实 ffmpeg/ffprobe 会失败，不静默跳过。CI 新增独立 FFmpeg 作业，但本次未推送或运行远端 CI。Windows 原生 Rust/FFmpeg 已测试；本次未重新验收 Tauri 原生窗口全部交互、macOS 真机、真实 Pocket 3 长视频或真实账号投稿。以下旧日期记录保留为历史，不表示本次已重复验收。


2026-09-25 分段与导出设置更新：9 项前端测试、16 项 Rust 单元测试、2 项 FFmpeg 集成测试通过。新增连续边界接续、跨文件拆分、重叠拒绝、时间顺序、跨拍摄按日编号与预设持久化测试。等待用户两局任务均 completed 后才修改。Windows 原生窗口实测 S 分段后两端接续到 20 秒，输出预览为日期子目录下 `1-男双.mp4`；测试标记已撤销，用户比赛未改动。

2026-09-25 本地引用导入优化：前端构建、7 项 Vitest、14 项 Rust 单元测试及 2 项真实 FFmpeg 集成测试通过。集成素材改用有限抽样引用，覆盖跨文件导出及代理缓存。新增测试明确验证抽样不能检测采样窗口外的修改，不把它当成完整性校验。复制仍执行完整哈希和读回比较。应用由 Tauri dev 重新编译运行。

日期：2026-09-24。Windows 原生 MSVC 开发环境，Node 22.16.0、Rust/Cargo 1.97.1、FFmpeg/ffprobe 7.0.1。

所有视频验证都使用 FFmpeg 生成的合成素材，**没有通过真实 DJI Pocket 3 原片验收**。没有修改系统设置，没有自动下载 FFmpeg，没有删除用户素材。

## 可重复执行

```powershell
npm ci
npm run build
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

$env:RALLYCUT_FFMPEG_DIR='C:/Program Files/ffmpeg-7.0.1-full_build/bin'
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored --nocapture
```

上述为历史命令。当前集成素材已移除 Windows 字体依赖，使用系统独立临时目录和独立 SQLite；不会使用生产库。当前命令见本文件顶部。

## 自动检查结果

- TypeScript 检查与 Vite 生产构建：通过。
- Vitest：7/7 通过。单源、两源、三源、精确边界、非法/空/小数微秒区间、时间码精度、任务标记/预设/内容失效、基于实际速度的 ETA。
- Rust fmt/check：通过。
- Rust 单元测试：13/13 通过。时间线、稳定引用、重排拒绝、自然排序、特殊字符路径、复制读回校验、取消后重试、重复内容筛选、同名不同内容、重新定位哈希校验、数据库重启恢复、未完成队列中断恢复、无覆盖原子提交和不可用可执行文件。
- FFmpeg 集成测试：2/2 通过（普通 `cargo test` 会标为 ignored，最后一条命令已实际执行）。

集成测试覆盖：

1. 生成一个 30 秒连续测试源，带画面时间码和可识别的测试音频，从它拆出 A/B 各 15 秒。
2. 标记全局 12—18 秒，断言映射为 A 12—15 + B 0—3。输出视频与音频约 6 秒。
3. 与原连续源 12.5、14.8、15.2、17.5 秒画面对照；缩小至灰度 160×90 后 MAE 为约 0.31、0.21、0.19、0.18（0—255 量级）。已直接查看边界前后 PNG，时间码按 14.900 → 15.100 前进。
4. 解码真实输出音频为 48kHz PCM，与原连续源对照。普通窗口相关性 >0.999，跨 AAC 分文件边界窗口约 0.936；最佳对齐位移最多约 9.2ms，后半段约 2.7ms。这不是对所有长视频音画同步的保证，亦非人耳听审。
5. 整个合成输出完整解码；测试另外保存 `audio-check.wav` 供听审。应用正式任务仅执行基本+抽样验证，文案与集成测试完整解码区分。
6. 无音频输入补静音、真实取消后无正式输出、不可用编码器、已有输出不覆盖、HDR 拒绝、预设/标记更改后内容指纹变化。
7. 60000/1001 与 60/1 输入，不同分辨率输入；默认保留分数帧率与强制 60fps 分别验证；代理时长/零偏移、代理缓存复用、缩略图生成。

## Windows 桌面验收

使用 computer-use 原生 Windows 工具操作实际 `rallycut.exe`，不是浏览器中的模拟 IPC。

- 系统目录选择器选中 `.test-data/native-input`；目录含中文、空格、单引号的 A/B 视频，按真实 ffprobe 结果展示 320×180、60/1。
- 引用导入两个文件成功；真实播放器播放，自动从 A 切换 B，全局时间继续前进。
- 输入 12 与 18 秒，添加一局，右侧显示“跨 2 个文件”，自动保存成功。
- 通过设置实测本机 NVENC、QSV 均可运行（不是仅检查编码器列表）。默认 4K 任务实际使用 NVENC。
- 实际正式输出经 ffprobe 复核：H.264 3840×2160、60/1、6.000000 秒；AAC 48kHz stereo、6.000000 秒。队列显示完成及“基本验证 + 首尾及拼接边界抽样解码（非完整解码）”。
- 当前素材的预览代理与缩略图已通过界面生成；重启后缓存可加载。
- 多次原生重启后，两个素材的顺序、比赛标记和已完成任务仍保留。再次导出预览自动追加 `_1`，已有正式文件保留。
- 已检查 1440×900、1280×720 逻辑工作区，以及约 1920×1080 的宽屏原生窗口（实际截图 1921×1079）；较小窗口整体约 1283×751，适合 1366×768 工作区域。检测到本机 AppliedDPI=144（150%），未修改系统缩放。尚未对所有多显示器 DPI 切换组合进行测试。

## 尚未验证

真实 Pocket 3 的 2K/2.7K 60/59.94fps 长视频、真实 HDR/D-Log、旋转/VFR/异常起始时间的大规模回归、小时级声画漂移、4GB 以上复制/空间不足/拔卡/权限故障实机注入、AMF 实际导出、真实 GPU 驱动故障回退、操作系统强杀瞬间的子进程行为、网络盘与其他文件系统、所有原生快捷键及取消交互组合、安装包。

未生成 MSI/NSIS 安装包。不要把小型合成素材通过解读为对全部相机原片、任意驱动与存储条件的生产保证。



## 2026-09-27 封面备选增量验证

- 先新增投稿页选择备选测试，旧界面因找不到“选择封面备选”按钮失败；修改后通过。
- Playwright 使用真实合成视频解码，断言点击“加入封面备选”提交当前 session/asset 与暂停的 2 秒位置；IPC 为 mock，不是原生 Tauri 端到端验收。
- 投稿页验证缩略图选择、图片 naturalWidth、选中状态、草稿保存引用；桌面与 390×844 截图。Browser plugin not available，使用现有 Playwright。
- 原生 FFmpeg 新测试验证真实 MP4 取 JPEG、ffprobe 尺寸、源文件不变、已有图片不覆盖、独立数据库重开恢复。首次测试暴露 image2 对单图片的 -n 不可靠，改为临时图片完成后使用不覆盖的硬链接提交；5 个 FFmpeg 集成测试显式执行全部通过。
- 前端单元测试 19 通过，发布/播放器 Playwright 7 通过，Rust lib 30 通过、1 个凭据测试按原有条件 ignored；build 与 fmt check 通过。
- 当前用户应用仍有 awaiting_confirmation 草稿，因此未重启或替换运行进程。cargo 集成测试命令在复制主 exe 时被 Windows 文件占用阻止；集成测试二进制已成功编译，直接执行最新 export_integration 测试程序 --ignored，5/5 通过。未将此报告为 cargo test 全套通过。
- 本增量未完成 Windows 原生新封面按钮端到端、真实 Pocket 3 帧对照或真实封面投稿验收；没有上传或提交用户文件。


## v0.5.0 发布前复核

2026-09-27 应用关闭后重新运行发布门禁：npm test 19/19；npm run test:e2e 24/24；更新清单脚本测试 2/2；npm run build、版本一致性与 cargo fmt --check 通过。npm 官方 registry 的生产依赖审计为 0 项漏洞（本机默认镜像不支持审计，已改用官方审计端点）。保留原有 design/ 未提交内容，未纳入发行。

应用关闭后的 cargo test --locked 全套通过：30 个库测试与 1 个可靠性集成测试通过，1 个原生凭据测试保持条件忽略；随后显式运行 5 个 FFmpeg 集成测试，全部通过。

首次云端检查发现 macOS 播放控制遮挡与新版 FFmpeg 合成帧色彩元数据覆盖输出参数的问题。取消未公开的 v0.5.0 发布，v0.5.1 改用正常流布局，并在合成源帧上显式 setparams；新增源帧 BT.709 断言，未放宽生产色彩校验。
