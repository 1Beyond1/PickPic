# 手机本地相册分类模型调查

调查日期：2026-10-03。本轮只调查，当前权重与运行依赖保持原状。结论针对 PickPic 的相册大类需求，不以模型体积或其他手机跑分承诺准确率。

## 当前实际实现

`MLBridge.tsx` 加载 `assets/ml/efficientnet-lite4.tflite`，通过已安装 ML Kit 自定义标签原生桥执行。文件为 TFLite FlatBuffer（TFL3），实测 15,022,904 字节（约 14.33 MiB），输入 UINT8，尺寸 1×300×300×3；随包标签表 1,001 行，含 background。SHA-256 为 `63ddbdd6c80a19b24e8301526197f21f119c24225964fc7175807002b0625506`。文件名与桥配置标识为 EfficientNet-Lite4，未把独立架构鉴定当成已完成。

桥最多返回 5 个候选，最低模型分数 0.1；展示层使用固定大类与原有 0.4 接受门槛、0.08 竞争差距，取消弱候选分数相加。原始标签仍在数据库中，不被展示归类覆盖。人物还使用独立 ML Kit 人脸检测。当前多标签来自人脸与对象的独立证据；ImageNet 的竞争类别不能当成多个对象检测结果。

ImageNet 更擅长具体物体及品种，缺少手机截图、证件、聊天记录等完整相册类别。标签数量不代表覆盖日常图库。模型未输出某个类别时，展示映射无法补出能力。当前版本的真实峰值内存、ARM64 单张耗时、长时间耗电尚未测量。

现有本地 mobilenet 备份模型未由桥加载。不能用它们的总大小冒充当前模型运行开销；最终 APK 是否携带多余素材需检查构建包。TensorFlow 官方 EfficientNet-Lite 代码仓库为 Apache-2.0；当前二进制的来源与适用权重许可应随发布材料追溯核对，仓库许可不自动证明任意同名文件的来源。[官方实现与参数表](https://github.com/tensorflow/tpu/tree/master/models/official/efficientnet/lite)、[代码许可证](https://github.com/tensorflow/tpu/blob/master/LICENSE)。

## 候选比较

| 候选 | 大类适用性 | Android 离线与接入 | 成本与主要边界 |
| --- | --- | --- | --- |
| ML Kit 官方通用标签（bundled） | 官方有人物、猫狗、食物、汽车、风景等常见标签；截图/文档的可靠区分仍待实测 | 原生捆绑版本无需首次模型下载；应采用 bundled 而非 Play 服务下载路径。现有 RN 包只使用 CustomImageLabelerOptions，不能仅更换配置就获得官方基础模型，需要增加原生基础标签适配 | 官方称捆绑增量约 5.7 MB；这是参考集成大小，移除旧权重后的 PickPic 净 APK 变化未知。峰值内存、手机耗时、耗电未知 |
| MobileCLIP-S0 | 预训练图文模型，可用固定文字提示形成相册大类；效果与英文描述有关，中文泛化未验证 | 官方 PyTorch 与 iOS 示例可用；本次未确认官方可直接用于现有 Android 桥的 TFLite 包。需重参数化、转换与平台适配，量化后需验证 | 官方完整 checkpoint 216 MB，包含图像/文本部分，不是 APK 增量。部署时预计算固定类别文字向量、只带图像部分理论可减少体积；实际导出尺寸与内存未知 |
| MobileCLIP2-S0 | 比 V1 有官方通用零样本评测改善；不等于 PickPic 私人图库分类已经更好 | 同样需要转换和平台运行适配，不依赖 Google 在线推理；尚未证明 Android 部署稳定性 | 完整 checkpoint 300 MB，仍不是 APK 大小。官方图像/文字参数 11.4M/63.4M；实际工作内存与耗电未知 |
| EfficientNet-Lite0 / Lite2 预训练量化模型 | 和现有 ImageNet 系统同类，适合基础物体，不补齐截图/文档能力 | 官方提供 TFLite 与 INT8 资源，较适合复用当前自定义标签桥；具体元数据、标签索引与预处理仍需验证 | 官方 Pixel 4、batch=1、4 CPU 线程表中 INT8 Lite0/Lite2/Lite4 分别 6.5/12/30 ms。不同模型也有精度取舍，不能用这些数字推算应用端耗时或推荐替换 |

ML Kit 的 400 多个标签及捆绑/下载差异来自[通用标签说明](https://developers.google.com/ml-kit/vision/image-labeling)与[Android 集成说明](https://developers.google.com/ml-kit/vision/image-labeling/android)。国内没有 Google Play 服务的设备应验证 bundled 路径完整离线启动；它不使用 Play 服务模型下载机制，但尚未实机证明所有国内厂商兼容。Native Maven 构建下载依赖与安装后运行离线是两件事。

MobileCLIP 的 checkpoint 大小来自 Apple 官方型号文件目录：[S0](https://huggingface.co/apple/MobileCLIP-S0/tree/main)、[V2 S0](https://huggingface.co/apple/MobileCLIP2-S0/tree/main)。[官方代码与示例](https://github.com/apple-aiml-research/ml-mobileclip)包含零样本评测、预处理与重参数化要求。其移动延迟和 ImageNet 零样本数据不与当前监督式分类分数直接可比；本次没有进行 Android 同设备测量。

## 许可与隐私决定推荐顺序

ML Kit SDK/模型受 Google APIs 与 ML Kit 服务条款约束，不是看到文档样例 Apache-2.0 就能将模型当作 Apache 权重重新打包。媒体与识别结果在本机处理；官方也说明 SDK 可能发送性能/使用度量与查询更新，因此不能宣传为绝无联网或遥测。现有 ML Kit 集成也需要检查相同边界。[官方条款与隐私](https://developers.google.com/ml-kit/terms)。

MobileCLIP **代码 MIT 与权重许可不同**。当前官方 S0 与 V2 S0 权重均使用 Apple Machine Learning Research Model License，仅限科研，并明确排除产品开发；转换或量化不消除限制。仅凭 PickPic 免费或开源不能认定可直接集成发布。分发科研衍生物也要求提供协议、署名及变更说明。此前将其作为优先产品接入候选的建议证据不足，本报告纠正为：技术调研保留，当前不推荐用于 PickPic 发布。[代码许可](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE)、[V1 权重许可](https://huggingface.co/apple/MobileCLIP-S0/blob/main/LICENSE)、[V2 权重许可](https://huggingface.co/apple/MobileCLIP2-S0/blob/main/LICENSE)。

其他合理方案：MediaPipe 官方 Image Embedder 有 MobileNetV3 small/large 模型，可以辅助特征相似，但它不是相册分类器，语义近似也不能证明文件重复。此类方案作为后续相似检索调查，不作为本轮分类替换。框架代码 Apache-2.0，具体模型仍应核对各自来源许可。[官方能力与模型](https://developers.google.com/edge/mediapipe/solutions/vision/image_embedder)、[框架许可](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE)。

## 建议与后续验证

1. 首先保留当前权重并验收大类展示，解决细分类目录和分数叠加问题。
2. 若用户决定试新模型，第一候选为 ML Kit bundled 通用标签；先测常见相册类别与无 Play 服务环境，再决定迁移，不保证识别提升。
3. 轻量 EfficientNet 可在明确速度瓶颈时比较，目标是耗时/内存取舍，而非凭空增加相册知识。当前文件与候选权重来源、许可、索引必须先核对。
4. MobileCLIP 的许可问题未解决前，不进入公开产品实现；社区转换包不能替代原始许可与正确性验证。

后续评测由开发者完成，使用有许可的照片，固定类别、素材来源、切分和版本，同时记录未分类、错误分类、多标签以及截图/翻拍混淆；不要求用户训练或标注大图库。性能在同一 ARM64 手机测冷启动、图片读取预处理、推理、写库、峰值内存与连续扫描耗电，分别报告。开发者先做兼容与准确性对比，用户只需体验候选结果；本轮遵照指令不下载或接入新模型。

截图/录屏优先按系统类型或相册来源判断；OCR、文字/自然语言搜索、完全相同文件识别、压缩和编辑仅列为后续独立方案。普通通用分类模型不能替代这些功能的专项实现。
