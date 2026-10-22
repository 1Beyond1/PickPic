# 开发文档与目录维护

项目介绍、安装和开发入口见 [主 README](../README.md)。文档中的命令默认在项目根目录执行；历史记录里的结论应结合其日期阅读，不代表当前所有设备均已验证。

## 长期维护的说明

- [加密记录、密码备份与 SDK 隐私补丁](ENCRYPTED_BACKUP.md)
- [媒体大小与大文件优先](MEDIA_SIZE_INDEX.md)
- [截图、录屏相册来源](MEDIA_SOURCE_SCOPE.md)
- [主题与原生弹层](UI_APPEARANCE.md)
- [真机验证清单](REAL_DEVICE_CHECKLIST.md)
- [后续开发计划](NEXT_VERSION_PLAN.md)
- [现成模型调研](AI_MODEL_RESEARCH.md)

## 历史记录

- [整理体验与隐私改进验收](archive/ITERATION_CHECKPOINT.md)
- [历次质量审计](archive/QUALITY_AUDIT.md)

已结束阶段的记录进入 `docs/archive/`，保留修复依据，不继续往根目录堆放每日汇报。后续变更优先更新已有说明，不为每轮排查重复建立计划、总结和交接文件。

## 目录职责

```text
app/          路由与页面
components/   界面组件
hooks/        共享 React hooks
stores/       应用状态
services/     扫描、模型、备份与系统服务
database/     扫描数据库及仓库
modules/      自有原生模块
plugins/      Expo 配置插件
assets/       运行资源及 README 展示素材
tests/        自动化测试与必要测试夹具
scripts/      可重复使用的维护脚本
docs/         长期说明；archive/ 保存已结束阶段记录
```

本轮只整理文档和产物，不迁移业务源码目录，也不改变媒体整理、加密或删除语义。

## 本地产物的保留规则

- `build-artifacts/` 不提交 Git。截图、日志和临时探针只保留最近一次有用的证据，问题关闭后清理中间产物；不要在项目根目录生成统计报告。
- 保留当前测试 APK、已发布 APK、校验文件和必要构建脚本。核对相同哈希后，可移除重复的安装包副本。
- Gradle/CMake 的 `android/build`、`android/app/build`、`.cxx` 等编译输出可以重新生成；清理前确认没有构建进程，验证精确路径且不跟随目录链接。不得据目录名为 `build` 就删除依赖中的 JS 发布文件。
- 不直接删除整个 `node_modules/`、生成的 `android/` 或带 `node_modules` 链接的构建副本；源码补丁、原生配置、签名材料和编译缓存必须区分。缓存清理后，下次原生构建会重新编译并更慢。
- 签名密钥、口令保护文件、数据库、加密备份、模拟器用户数据和未确认用途的文件不自动清理。Git 忽略不等于可以删除；Git 不能恢复从未提交的文件。
- SDK、NDK、JDK 和全局依赖缓存不是本项目的一次性垃圾，不纳入仓库清理。旧 UI 样例与独立测试模拟器是否继续保留，由用户决定。

移除的 Expo `reset-project` 是脚手架清空脚本，不是应用数据重置功能；一次性翻译去重脚本和体积报告也不再作为长期源文件保留。已提交的旧版本仍可从 Git 历史找回。

2026-10-22 整理：文档集中归档；清理约 12.49 GiB 本地编译输出及 135.5 MiB 过期产物和重复包（按文件逻辑大小统计）。签名、备份、模拟器、UI 样例、依赖源码和运行模型保留。检查通过不等于重新做过真机或原生构建验收；本轮不重建刚清理的缓存。
