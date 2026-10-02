# PickPic

PickPic 是一款本地照片与视频整理工具。逐张浏览，决定保留或删除，在清理相册的同时记录整理进度。支持浅色与深色界面，以及设备端照片分析。

当前源码版本 **0.4.0**，处于测试阶段。主要在 Android 上开发和验证；iOS 尚未完成原生验证。源码版本不等同于已发布安装包的版本。

## 下载

Android 安装包与更新说明见 [GitHub Releases](https://github.com/1Beyond1/PickPic/releases)。请以具体 Release 的版本、支持架构和签名说明为准，不要将开发客户端当作独立安装包。

## 0.4.0 更新

- 统一浅色、深色界面，调整设置分组、整理操作与底部弹层。
- 照片复核时逐张改为保留，保持已整理；全部保留后仍可继续下一组。
- 视频仅在明确整理操作后记录进度，支持回看已整理内容及末条提示。
- 照片、视频与相似组读取失败可恢复，照片大图与复核预览支持重试。
- Android 16 及以上的大量待删除内容按系统上限分批确认；成功批次及时记账，后续取消或失败时保留未完成项。
- 完善删除风险与云同步边界说明，项目原创代码许可证改为 Apache-2.0。

待删除列表与删除前复核继续保留。接口兼容性修复不代表所有品牌、型号和系统版本均已实机验证。

## 界面预览

<p align="center">
  <a href="assets/screenshots/photo-home.jpg"><img src="assets/screenshots/photo-home.jpg" alt="照片首页与批次预览" width="42%" /></a>
  &nbsp;&nbsp;
  <a href="assets/screenshots/photo-organizer.jpg"><img src="assets/screenshots/photo-organizer.jpg" alt="卡片式照片整理" width="42%" /></a>
</p>

<p align="center">
  <a href="assets/screenshots/photo-review.jpg"><img src="assets/screenshots/photo-review.jpg" alt="删除前复核" width="42%" /></a>
  &nbsp;&nbsp;
  <a href="assets/screenshots/settings-dark.jpg"><img src="assets/screenshots/settings-dark.jpg" alt="深色设置界面" width="42%" /></a>
</p>

Android 模拟器实际运行截图。照片为 AI 生成的展示素材，不包含用户真实图库，界面未经拼接。

## 整理方式

### 照片

按批次逐张整理，也可以只查看指定相册。

- 上滑加入待删除列表，下滑保留；上滑本身不会删除原照片。
- 每批结束后进入删除前复核，确认后才请求系统删除。
- 复核时点击缩略图，将这一张改为保留，保持已整理，页面不会跳回整理页；长按可查看完整照片。
- 全部改为保留后，点击继续进入下一批，无需重新整理这些照片。

### 视频

上下滑动浏览，侧边提供静音、收藏、分享和待删除操作。

- 仅打开或离开视频页不会记为已整理；完成向下一条的切换，或明确加入待删除列表后才记录。
- 可以滑回查看已整理的视频，回看不撤销整理记录；末条视频有到达提示。
- 加入废纸篓后仍可撤回，最终删除需在废纸篓中确认。
- 长按可进入视频全屏模式。

### 设备端分析

查找疑似模糊照片、相似照片组，并提供可选的图片分类。分析在设备上进行，不向云端 AI 服务上传媒体，结果不会触发自动删除。

图片分类默认关闭，可在「设置 → 智能分析」中开启。当前分类使用 EfficientNet-Lite4，人物检测使用 ML Kit。分类仍为 Beta，开启后会增加扫描耗时；已有扫描结果不会自动补充分类，如需重新分析，可重置扫描记录后重新扫描。

模糊、相似和分类结果都是整理参考，而非删除建议。虚化照片可能被判为模糊，相似照片也可能各有保留价值；准确率和扫描速度会受照片内容、图库规模及设备影响。

### 偏好与记录

支持每组 10 / 20 / 30 张、最新 / 最早 / 随机顺序、相册范围选择、浅色 / 深色主题及中文 / English。整理记录保存在本机；照片整理、视频整理和扫描记录可分别重置，重置不会删除原媒体。

## 删除与云同步

**请先备份重要照片和视频。** PickPic 的待删除列表和视频废纸篓只是确认前的队列，不是用于恢复已删除文件的系统回收站。

当前删除接口不保证媒体进入系统回收站。Android 11 及以上的相关删除流程使用 `MediaStore.createDeleteRequest`，请求的是直接永久删除，而不是先移入回收站；这不是只影响某个手机品牌的问题。参见 [Android 官方说明](https://developer.android.com/training/data-storage/shared/media#manage-groups-media-files)。

Android 16 及以上的大量删除请求会拆为每批最多 2,000 项，可能需要多次系统确认。取消或失败不会自动重试后续批次，未完成项保留在应用的待删除列表中。

AI 结果页有独立的删除入口，不经过照片整理的组末复核。请在结果页检查照片后再操作；应用会在这些入口提示删除风险，但不能保证删除后可恢复。

PickPic 不管理云端备份，也不能保证「只删除本地，云端一定保留」。不同相册服务可能重新下载媒体，也可能同步删除决定。例如，启用 iCloud 照片时，删除会影响同一账号的其他设备，见 [Apple 官方说明](https://support.apple.com/en-nz/104967)。

## 从源码运行

项目基于 React Native 0.81、Expo SDK 54 和 TypeScript，使用 Expo Router、Zustand、Reanimated、Gesture Handler、expo-media-library 与 expo-video。

### 环境

- Node.js 20.19.4 或更新版本、npm；完整自动化测试推荐 Node.js 24.11.1，与当前 CI 一致。
- Android 本地开发：JDK 17、Android SDK，以及手机或模拟器。
- iOS 本地开发：macOS 与 Xcode。

```bash
git clone https://github.com/1Beyond1/PickPic.git
cd PickPic
npm ci

# 首次构建并安装 Android 开发客户端
npm run android

# 后续启动开发服务器，连接已安装的开发客户端
npx expo start --dev-client
```

项目包含 ML Kit 原生模块，不能仅用 Expo Go 运行完整应用。新增或修改原生依赖后需要重新构建开发客户端；普通 JS / TS 改动可通过 Metro 更新。参见 [Expo 开发构建说明](https://docs.expo.dev/workflow/customizing/)。

### 检查与构建

```bash
npm run typecheck
npm run lint
npm run test:ci

# EAS 云端预览 APK：需要 Expo 账号和对应项目权限
npx eas-cli build -p android --profile preview

# macOS / Linux 本地 EAS 预览 APK：另需本机构建工具和 EAS 登录
npx eas-cli build -p android --profile preview --local
```

`npm run android` 生成用于开发的客户端，需要 Metro，不等同于独立发布 APK。EAS 的 `preview` 配置输出 APK，`production` 配置输出 AAB。

Windows 可进行本地 Android 开发构建，但 EAS `--local` 不支持原生 Windows，WSL 也不是官方支持的构建环境。参见 [EAS 本地构建说明](https://docs.expo.dev/build-reference/local-builds/)。

## 反馈与贡献

通过 [Issues](https://github.com/1Beyond1/PickPic/issues) 反馈问题时，请提供应用版本、手机型号、系统版本和复现步骤。截图与日志请去除个人照片、账号和路径等信息。

提交代码前请运行上述检查，不提交访问令牌、API 密钥、签名密钥、本机配置、真实图库或应用数据库。忽略规则不能保护已经提交的秘密，泄露的凭据应立即撤销或轮换。

## 许可证

项目原创代码采用 [Apache License 2.0](LICENSE)，署名信息见 [NOTICE](NOTICE)。第三方依赖与模型保留各自的许可证。
