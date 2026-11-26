# AGENTS.md — PickPic 工程协作规范

本文件为在本仓库工作的 AI Agent 与协作者提供精简、准确的工程上下文与不可违背的安全红线。

## 1. 项目定位与当前边界

- **定位**：离线优先的本地照片/视频滑动整理与设备端分析应用（React Native `0.81.5` + Expo SDK `54` + TypeScript `~5.9` + Expo Router + Zustand + Reanimated）。
- **版本约束**：当前公开发布基线为 `0.5.1`（`package.json` / `app.json`），未经明确授权不得修改版本号、发布标签或签名配置。
- **平台与验证边界**：开发与模拟器验证以 Android（ARM64 / x86_64）为主；**Android 多厂商真机与 iOS 原生构建/运行均尚未完成实机验收**，严禁将自动化测试或模拟器结果表述为真机或 iOS 已通过（详见 `docs/REAL_DEVICE_CHECKLIST.md`）。

## 2. 目录地图

```text
app/          Expo Router 页面与路由（照片/视频整理、扫描结果、设置、权限门禁、相似对比等）
components/   可复用 UI 组件（卡片、复核弹层、相册选择器、备份面板、MLBridge 等）
hooks/        共享 React hooks（扫描器订阅、主题、国际化、预览源等）
stores/       Zustand 状态与加密持久化（useMediaStore / useSettingsStore / useScannerStore / usePrivacyStore）
services/     扫描引擎（scanner/AIScanner）、ML 分类、图像运算、可读媒体查询、加密存储与口令备份
database/     SQLCipher 扫描库连接、迁移与仓库（Asset / DupGroup / SimilarReview / Face / Meta / AIAnalysis）
modules/      自有 Android Kotlin 原生 Expo 模块
plugins/      Expo Config Plugins（原生加密工具链对齐与系统备份排除规则）
assets/       运行资源（含随包 efficientnet-lite4.tflite）与 README 展示素材
scripts/      维护脚本（SDK 隐私日志补丁 scripts/apply-privacy-patches.js）
tests/        Jest 自动化测试与内存 SQLite 测试夹具（tests/helpers/testDatabase.ts）
docs/         长期架构/安全/验证说明；已结束阶段归档在 docs/archive/
```

## 3. 自有原生模块与配置插件

- `modules/pickpic-media-index`（`PickPicMediaIndexModule.kt`）：Android 专用只读模块，仅按请求的纯数字媒体 ID 批量查询 `MediaStore` 的 `_ID` 与 `SIZE`（单批上限 200 条），不读取路径、文件名、EXIF、原文件字节，不发起网络下载或写入；用于 Android「大文件优先」排序。
- `modules/pickpic-system-ui`（`PickPicSystemUIModule.kt`）：Android 专用模块，在主线程原地同步已打开 `ReactModalHostView` 弹窗的状态栏/导航栏明暗外观（`syncModalAppearance`），不重建弹窗子树、不访问媒体。
- `plugins/withNativeCryptoToolchain.js`：让 `react-native-nitro-modules` 与 `react-native-quick-crypto` 继承应用已选定的 AGP/Kotlin 版本，不硬编码工具链、不改写 `node_modules`。
- `plugins/withPrivateRecordsBackup.js`：让 `expo-sqlite`（SQLCipher）继承应用 NDK；在 Android 清单关闭 `allowBackup` 并排除全部私有域云备份/设备迁移；在 iOS `AppDelegate` 排除 Documents / Application Support 目录备份。

## 4. 隐私安全与 SQLCipher 红线

1. **离线边界与无外网**：严禁新增任何云端上传、遥测或额外外网请求；不申请位置权限（`app.json` 中保持 `isAccessMediaLocationEnabled: false`）。
2. **加密存储与失败关闭（Fail-Closed）**：
   - 整理记录、待删除/收藏队列、会话与设置采用本机 AES-256-GCM 持久化；扫描索引采用 SQLCipher（`database/encryptedDatabase.ts`）；各域独立设备密钥由 `expo-secure-store` 托管。
   - 密码导出备份使用原生 Quick Crypto 异步 scrypt（N=65536, r=8, p=2）+ AES-256-GCM，严禁降低参数或静默降级。
   - 密钥缺失、密文认证失败或存储读写失败必须触发 `usePrivacyStore` 门禁（`LocalPrivacyError`），严禁用默认空状态静默覆盖已有密文。
3. **事务与性能约束**：
   - `withEncryptedTransaction` 会打开独立加密钥 SQLCipher 连接执行 `BEGIN IMMEDIATE`；扫描同步与批量清理必须按页/按批在单事务内提交（如 `AssetRepository.syncLibraryMetadataBatch`、`removeAssetsAndDerivedData`），禁止在循环中逐张开事务或对大相册做无并发上限的全库回退查询。
4. **日志与临时缓存红线**：
   - 任何 `console.*` / 原生日志只允许输出通用阶段描述，严禁输出媒体 ID、URI、文件路径、EXIF、分类标签、数据库行内容或密钥。
   - 相册预览统一使用内存缓存策略；扫描裁剪/缩放临时文件须在 `finally` 中立即清理，清理失败须触发缓存隐私门禁并停止后续扫描。
5. **敏感资产保护**：严禁提交或删除 `build-artifacts/signing/`、签名密钥（`*.jks` / `*.keystore`）、`credentials.json`、`*.pickpic` 备份或真实用户媒体。

## 5. SDK 隐私日志补丁机制

- `npm ci` / `npm install` 会自动执行 `postinstall`：`node scripts/apply-privacy-patches.js`。
- 该脚本对 `@infinitered/react-native-mlkit-core` / `image-labeling` / `face-detection`（`5.0.0`，含 Android Kotlin、iOS Swift 与 JS/TS 文件）与 `expo-media-library`（`18.2.1`）共 **14 个**文件执行受版本与完整文件 SHA-256 指纹校验的日志脱敏替换。
- `package.json` 的 `expo.autolinking.android.buildFromSource` 固定包含 `expo-media-library` 与 `expo-image`，防止 Android 预编译产物绕过本地源码补丁或带入详细日志。
- **严禁手工修改 `node_modules` 或绕过指纹校验**；升级相关依赖前必须先审查上游源码差异、更新补丁与指纹并重跑隐私回归。

## 6. 验证命令与 `.tmp/` 约定

提交任何改动前，必须在仓库根目录实跑并全部通过以下五项检查（与 `.github/workflows/ci.yml` 一致）：

```bash
node scripts/apply-privacy-patches.js --check
node scripts/check-privacy-config.mjs
npm run typecheck
npm run lint
npm run test:ci
```

- **`.tmp/` 临时目录约定**：本地调试脚本、临时日志或一次性排查输出一律放入 `.tmp/`（已在 `.gitignore` 中忽略），不得污染仓库根目录，任务结束后及时清理；不要误删 `build-artifacts/signing/` 等未纳入 Git 但不可恢复的本机关键文件。
- **Git 提交规范**：遵循 Angular Commit 规范（如 `fix(scanner): ...`、`perf(scanner): ...`、`docs: ...`、`chore: ...`），描述使用简体中文。
