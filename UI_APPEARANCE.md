# 主题与原生弹层外观（开发分支）

设置支持浅色、深色、跟随系统。旧用户的明确浅/深色偏好及默认浅色不变；历史 WarmTerra / claude / PPstyle 仍映射为浅色。只在用户明确选择后保存 system，系统切换不重写偏好，也不修改整理范围、决定或扫描结果。

共享 useThemeColor 订阅 React Native useColorScheme，system + dark 使用原深色语义色，其余使用原浅色；系统未报告外观时回退浅色。不另建第三套配色，不使用 Appearance.setColorScheme 改写系统外观。主题偏好沿用 settings AES-GCM 与设备密钥，备份格式及旧记录不变。

## Android 弹层边界

实际 API 37 模拟器复现：保持主题选择弹层打开，从系统浅色切换深色，弹层正文已变色，但状态栏仍为黑色图标；等待后仍然如此。关闭弹层后根页面状态栏正常，不把关闭动画当成同步成功。

安装的 RN 0.81.5 Modal 使用独立 Dialog，在显示时复制 Activity 的系统栏外观，现存 Dialog 不会随根 StatusBar 更新重新复制。小型本地 Expo 模块在 UI 线程仅更新本 Activity 内正在显示的 RN Modal 窗口系统栏，并递归包含嵌套 Dialog；不关弹层、不重挂子组件、不丢选择草稿、不修改系统主题。它使用项目已有 React Android 与 AndroidX API，不加权限、媒体访问、联网、数据存储或第三方运行引擎。

此适配依赖当前 RN 的内部 Modal 主机类（Kotlin 可访问，不是稳定跨版本 API），升级 RN 后需重新核对；旧构建缺模块时不会阻塞隐私恢复或整理，不能以旧构建证明弹层同步已经可用。根页面继续用 Expo StatusBar。黑色沉浸预览、全屏视频及其他弹层的整体视觉/无障碍交叉检查仍归 F，不以主题选择弹层的单项证据宣布全 App 验收通过。

## 验证范围

自动化验证手动主题不受系统影响、系统更新不重写偏好、未知系统外观、旧主题迁移、明确选择及真实 settings 加密重开。替身系统外观测试不证明 Android 的真实外观事件；原生构建/切换/重启/小屏证据以 ITERATION_CHECKPOINT.md 为准。真机与 iOS 仍延期；当前能力不是已发布 0.4.0 的声明。

依据（2026-10-04）：[React Native useColorScheme](https://reactnative.dev/docs/usecolorscheme)、[RN 0.81.5 Modal 源码](https://github.com/react/react-native/blob/v0.81.5/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/modal/ReactModalHostView.kt)。
