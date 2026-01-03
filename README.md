# PickPic 📸

> 基于液态玻璃美学的沉浸式相册整理工具，让清理内存变得解压。

![Version](https://img.shields.io/badge/version-0.1.1-blue)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-green)
![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-orange)

---

## ✨ 功能亮点

### 📷 卡片式照片整理
像刷探探一样整理相册！
- ⬆️ **上滑删除** - 不想要的照片一划即走
- ⬇️ **下滑保留** - 珍贵回忆安全跳过
- 批量确认，避免误删

### 🎬 抖音风格视频浏览
全屏沉浸式刷自己的视频库
- 一键删除 / 收藏 / 分享
- 废纸篓二次确认机制
- 长按进入全屏模式

### ⚙️ 个性化设置
- **每组数量**：10 / 20 / 30 张可调
- **随机模式**：打乱顺序，重温旧时光
- **主题切换**：浅色 / 深色 / 跟随系统
- **双语支持**：中文 / English
- **进度追踪**：断点续整，随时继续

---

## 🚀 快速开始

### 环境要求
- Node.js 18+
- Expo CLI

### 安装运行
```bash
# 克隆项目
git clone https://github.com/1Beyond1/PickPic.git
cd PickPic

# 安装依赖
npm install

# 启动开发服务器
npx expo start
```

### 构建 APK
```bash
# 云端构建（推荐）
npx eas build -p android --profile preview

# 本地构建（需配置 Android SDK）
eas build --platform android --profile preview --local
```

---

## ⚠️ 使用须知

1. **永久删除风险**：部分机型（如小米）删除的文件会被直接清除，无法恢复！
2. **云同步限制**：如开启小米云/iCloud，本应用只能删除本机文件，云端会自动恢复。
3. **测试版本**：目前为 v0.1.1，如遇 Bug 欢迎反馈！

---

## 🛠️ 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | React Native + Expo SDK 54 |
| 导航 | Expo Router |
| 状态管理 | Zustand |
| 动画 | React Native Reanimated |
| 手势 | React Native Gesture Handler |
| 媒体 | expo-media-library, expo-av |

---

## 👤 作者

**1Beyond1**

[![GitHub](https://img.shields.io/badge/GitHub-1Beyond1-black?logo=github)](https://github.com/1Beyond1)

---

## 📝 许可协议

本项目基于 [CC BY-NC 4.0](LICENSE) 许可，仅限非商业用途。

---

**⭐ 如果觉得有用，欢迎 Star 支持！**
