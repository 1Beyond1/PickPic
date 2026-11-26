# Changelog

本文件记录 PickPic 的主要版本变更历史（从 `v0.1.1` 至 `v0.5.1`）。版本号遵循语义化版本约定（`MAJOR.MINOR.PATCH`）。

> 注：本项目的自动化测试与本地构建主要在 Android 模拟器环境下验证，Android 多厂商真机与 iOS 原生构建验收状态请以 [真机验证清单](docs/REAL_DEVICE_CHECKLIST.md) 为准。

---

## [v0.5.1] - 2026-11-26

### 修复（Fixed）
- **完全重复检测特殊路径编码（P1-1）**：在传入 `expo-file-system` `new File(uri)` 前通过纯函数 `normalizeCandidateFileUri` 规范编码 Android `file://` 路径段中的 `#`、`?`、`%`、`[`、`]`、空格及中文字符（保留已有合法 `%XX` 序列且不破坏 `content://` / `ph://` URI），并在存在字面 `%XX` 文件名时提供安全回退，避免含特殊字符的照片 SHA-256 静默漏检。
- **分页竞态与跨 Tab 加载锁（P1-2）**：在 `useMediaStore` 的 `loadOrderedAlbumAssets` 与 `loadAssetsForReview` 每次 `getAssetsAsync` 前后检查 `isCurrent()` 立即中断过期分页；将全局 `activeMediaLoads` 拆分为 `isLoadingPhotos` / `isLoadingVideos`（兼容保留汇总 `isLoading`），照片全库随机抽样不再锁死视频 Tab 加载或清空 `activeId`。
- **隐私门禁恢复死锁与错误区分（P1-3）**：在 `BackupError` 中拆分 `'permission'` 与 `'unavailable'`，选文件不可读不再误报“缺少相册权限”；在 `PrivacyRecoveryScreen` 导入恢复向导内新增按需授权按钮（调用 `MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])` 与系统设置跳转 `Linking.openSettings()`），彻底解除 Android 13+ 含视频记录备份在门禁下的授权死锁。
- **视频页前后台切换体验（P1-4）**：`VideosScreen` 在 `AppState -> active` 时改为后台静默复查视频权限，仅当 `granted` 或 `accessPrivileges` 相对上次确实变化时才重置并重载会话，点击分享或下拉通知栏返回不再卸载播放器或清零播放进度。
- **删除确认落盘与受保护状态提示（P2）**：`confirmPendingDeletion` 物理删除结算后执行 `await flushMediaProgress()` 确保加密记录及时落盘；当待删除项全部被保护相册拦截且无失败时返回专属 `'protected'` 状态，消除矛盾的“权限不足或不可用”提示。
- **备份恢复写入原子性（P2）**：`restoreEncryptedRecords` 改为先写入 SQLCipher v2 表再提交内存状态并等待 `flushMediaProgress()` 完成，持久化失败时自动回滚内存快照。
- **视频侧边栏按钮稳定 Key（P2）**：`VideoFeedItem` 操作栏按钮 `key` 由易变的文案标签改用稳定 `action.id`，避免切换静音时按钮重挂。

### 优化（Changed / Performance）
- **感知哈希抗抖动升级（P1-5）**：`ImageOpsJS.computeDHash64` 从单像素采样升级为 9×8 区域像素均值（box/area average）降采样（零额外原生调用），同步递增 `GLOBAL_ALGO_VERSION` 至 `5`，存量库在下次扫描时自动平滑增量重算。
- **无定位权限扫描去 O(N²) 与 EXIF 裁剪降级（P1-6）**：`AIScanner` 在单轮扫描内缓存并复用 `syncAssetsToDatabase` 枚举结果与单图 `assetInfo`，消除单张图连续 3 次 `getReadableAssetInfo` 及 Android 无 `ACCESS_MEDIA_LOCATION` 权限时对零时间戳截图反复全库翻页的 O(N²) 退化；`ImageOpsJS.centerCropSquare` 在 EXIF 旋转导致裁剪失败或元数据缺失尺寸时降级为直接等目标尺寸缩放 `resize: { width: target, height: target }`，避免 48–200MP 原图直传 TFLite/ML Kit。
- **原生模块正则复用（P2）**：`PickPicMediaIndexModule.kt` 将媒体 ID 校验正则提取为 `companion object` 常量 `MEDIA_ID_REGEX`。
- **文档与工程规范同步**：补齐根目录 `CHANGELOG.md`，同步 `AGENTS.md`（基线 `0.5.1`、14 个隐私补丁文件、5 项 CI 校验）与 `docs/*.md` 发布状态说明。

---

## [v0.5.0] - 2026-11-26

### 新增（Added）
- **字节级完全重复照片检测**：扫描结果页新增独立「完全重复」标签（与 dHash 视觉相似严格区分），按精确 `fileSize` 分桶后仅对多文件同大小桶计算 SHA-256，受单文件 32 MiB 上限、16 MiB 全局在途字节预算与大文件（≥ 8 MiB）串行降级保护，遵守保护相册规则并显式报告跳过统计。
- **保护相册三层防误删机制**：SQLCipher 升级至 Schema V8，提供未筛选整理默认跳过、全队列入口拦截与物理删除前实时复核（失败关闭 Fail-Closed），以及失效/改名保护相册提醒。
- **v2 跨设备加密备份与未备份提醒**：支持导出/恢复整理决定、收藏、待删除队列、保护相册与复核忽略清单（含模糊忽略及设备无关「此组不相似」稳定键，兼容 v1），支持 32 MiB 负载上限、原生异步 `scrypt`（`N=65536, r=8, p=2`）+ AES-256-GCM 及 1 对 1 唯一内容指纹跨设备重绑定。
- **分域失密自救向导**：`PrivacyRecoveryScreen` 区分 Keystore、SQLCipher 与 Schema 故障域，支持先验密再恢复 `.pickpic` 备份以及排空持久化队列后二次确认重置本地隐私索引（绝不触碰原照片/视频）。
- **快捷筛选预设与精审效率闭环**：新增「陈旧截图（30/90 天前）」与 Android「大体积视频」快捷预设、原生 `PickPicMediaIndex` 大文件优先排序、`ZoomablePhotoModal` 双指缩放预览、模糊多选/忽略与相似对比「此组不相似」持久化。
- **可恢复整理会话与近期决定撤销**：照片/视频整理支持中断续接、暂时跳过、最多 100 条加密近期决定撤销、统一待删除复核界面及跟随系统主题与 Android 原生弹层外观同步（`PickPicSystemUI`）。

### 安全与性能（Security & Performance）
- **本机加密与 SQLCipher 按行存储**：整理记录与待删队列迁入 SQLCipher 按行存储（Schema V7/V8）并实现写合并与增量行写；配置与快照采用本机 AES-256-GCM 加密。
- **SDK 隐私日志脱敏补丁与静态门禁**：`scripts/apply-privacy-patches.js` 覆盖 ML Kit 与 `expo-media-library` 共 14 个文件（SHA-256 指纹校验），接入 `scripts/check-privacy-config.mjs` 静态隐私门禁，强制 Android `expo-media-library` 与 `expo-image` 从源码构建。
- **扫描与视频解码性能治理**：扫描同步重构为分页批处理（100 张/页）+ 受控并发（16）+ 单事务提交；视频 Feed 延迟挂载 `ActiveVideoPlayer` 并约束解码器窗口；扫描结果页重构为批量 SQL Keyset 分页与网格虚拟化。

---

## [v0.4.0] - 2026-10-02

### 新增与变更（Added & Changed）
- **双主题与信息架构重整**：引入浅色/深色中性主题、新版照片首页与卡片整理界面，统一导航、复核与设置交互。
- **Android 11+ 大批量删除分批兼容**：超过系统单次请求上限的待删除项自动分批确认，单批成功即移出队列，取消或失败项安全保留以便重试。
- **视频整理与权限边界加固**：仅打开或离开视频页不再误记为已整理，支持回看与最后一条提示；完善受限照片/视频权限刷新、外部删除检测与安全重试。
- **开源许可与发布签名**：项目许可证更新为 Apache-2.0，启用正式发布签名并提供 ARM64 Android APK 下载与校验；接入 GitHub Actions CI 自动化验证。

---

## [v0.3.1] - 2026-01-16

### 新增与优化（Added & Changed）
- **设备端 AI 扫描引擎**：落地基于 `EfficientNet-Lite4`（TFLite）与 ML Kit 人脸检测的可选本地图片分类、模糊检测与相似照片分组扫描。
- **扫描管理与结果展示 UI 优化**：新增扫描进度控制、批量扫描与分类/模糊/相似结果浏览体验优化。

---

## [v0.2.2] / [v0.3.0] - 2026-01-11

### 修复与变更（Fixed & Changed）
- 修复视频废纸篓滚动布局问题并同步版本号至 `v0.2.2`（同提交同时标记 `v0.3.0` 里程碑）。

---

## [v0.2.1] - 2026-01-08

### 优化与修复（Changed & Fixed）
- 统一应用主题配色，更新应用名称与自适应图标/启动屏配置。
- 优化 ARM64 APK 产物体积并修复 Android 构建配置。

---

## [v0.1.1] - 2026-01-03

### 首个稳定版本（Initial Release）
- 推出 PickPic 首个离线本地照片/视频滑动整理版本，支持照片批次整理、待删除与收藏队列及基础设置。
