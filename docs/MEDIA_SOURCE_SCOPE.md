# 截图与录屏相册快捷入口（开发分支）

本轮不新增识别模型。照片/视频的“整理范围”推荐名字匹配的截图/录屏相册，选择只改草稿相册范围，保留月份和顺序；确认后才开始新一轮，取消不改旧会话与决定。

## 证据级别

- 当前实现是**相册快捷选择，不是来源识别**。Android 的 BUCKET_DISPLAY_NAME 提供所在相册名称，名字不能证明每张图或每段视频的捕获方式，用户也可能自己创建同名相册。
- 只匹配少量明确的完整相册标题，不按媒体文件名、分辨率、比例、模型标签或标题子串猜测。通用 Recordings 可能是录音，不当成录屏相册。
- 名称匹配不到不代表没有截图/录屏，仍可手动选择相册。不同语言、厂商命名、媒体移出原相册等情况可能没有推荐。
- 已检查安装的 Expo SDK 54：截图 mediaSubtypes 是 iOS 专有，不能用于 Android；其公开类型也没有提供通用录屏子类型。本轮没有写入猜测的截图/录屏分类或数据库字段。

iOS PhotoKit 提供 photoScreenshot；后续若引入系统子类型筛选，应保存并恢复独立的筛选语义，不能混用 Android 相册标题当作同级证据。本轮 iOS 仍延期原生验证，受限照片权限不调用 iOS 相册 API，只保留可访问媒体的普通范围操作。

## 隐私与失败边界

推荐只读取已有权限下的相册列表与权限状态，不枚举原文件，不分析照片内容，不读取 EXIF，不联网、不落盘缓存。界面的相册 ID/标题临时存在内存；确认的 ID 范围沿用 records AES-GCM，会话不新增明文存储。

权限失效、查询失败、不可用与“没有可推荐的标题”分开。月统计及开始查询仍重新验证相册与媒体可见性，推荐不是可以永久复用的授权凭据；受限权限再次读取，事件代次变化丢弃旧推荐。识别不可靠时不自动扩大范围，不自动保留或删除。

官方接口依据（核对日期 2026-10-04）：[Expo MediaLibrary SDK 54](https://docs.expo.dev/versions/v54.0.0/sdk/media-library/)、[MediaStore BUCKET_DISPLAY_NAME](https://developer.android.com/reference/android/provider/MediaStore.MediaColumns#BUCKET_DISPLAY_NAME)、[PhotoKit screenshot subtype](https://developer.apple.com/documentation/photos/phassetmediasubtype/photoscreenshot)。验收与尚未验证边界持续记录在 ITERATION_CHECKPOINT.md，不将本功能宣传为已发布 0.4.0 的能力。
