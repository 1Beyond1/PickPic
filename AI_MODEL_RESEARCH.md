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

## 扩展候选：现成权重不等于现成手机产品

补充调查日期同上。以下没有下载权重、接入运行依赖或测量手机性能；它们是后续候选，不代表本轮授权替换。

| 方案 | 已核实的资源 | PickPic 的价值与限制 | 建议 |
| --- | --- | --- | --- |
| MobileNetV4 Conv Small（timm 发布者预训练权重） | 发布者模型卡标明 ImageNet-1k、3.8M 参数、Apache-2.0；单份 FP32 safetensors 约 15.2 MB。仓库约 30.5 MB 包含两种重复权重格式，不能当 APK 增量 | 可作为轻量物体分类比较项，但和当前模型一样受 ImageNet 类别限制，不天然具备聊天截图、票据等相册知识；PyTorch 权重需转换、验证预处理和量化。不是已验证的 Google 官方 Android 成品包 | 在性能瓶颈明确时比较，不能承诺更准或仅靠换架构解决相册分类 |
| Google SigLIP2 Base Patch16 224 | Google 官方模型卡 Apache-2.0，支持零样本分类与图文检索；完整 FP32 权重约 1.5 GB，含图像和文本部分 | 固定相册类别可以预计算文字向量，理论上裁掉手机端文字编码器；但图像塔转换、量化、部署体积、中文类别效果、手机内存与速度均未验证。完整 checkpoint 不是可用 APK 模型 | 许可较清楚的语义模型研究候选，目前不是轻量手机首选 |
| PaddleClas PULC 清晰度评估 | 官方提供现成清晰/模糊推理模型，文档大小约 7.0M；代码仓库 Apache-2.0，具体权重发布条件仍需随资源核对 | 更对应当前传统模糊检测的痛点。其训练主要合成运动/高斯模糊，并不证明能可靠区分人像虚化、夜景、低纹理照片；官方 2.13ms 是 Xeon CPU、10 线程、MKLDNN，不能推算手机速度。需 Paddle Lite 或转换后的原生适配 | 后续专项试验，不要求用户训练，也不与通用分类模型直接比 |
| Apple Vision 内置分类 | Apple 官方提供 ClassifyImageRequest / VNClassifyImageRequest、支持类别查询与示例；是系统框架而非可提取的开源权重 | iOS 后续可优先调查系统现成能力，避免自行训练；仍需 RN 原生桥和 iOS 验证。Android 不可用，两个平台分类结果未必一致 | iOS 路线独立候选，本轮延期，不宣传已支持 |
| MediaPipe Image Embedder 的 MobileNetV3 预训练资源 | 官方任务支持提取图片特征和余弦相似度，提供 small/large 候选 | 可用于相似图片评估；语义相似不是相同文件，也可能把不同照片视为相近。需要同一素材集测试，与现有相似算法比较 | 相似分组后续调查，不充当大类分类或完全重复证明 |

来源：[MobileNetV4 模型卡](https://huggingface.co/timm/mobilenetv4_conv_small.e2400_r224_in1k)、[具体权重文件](https://huggingface.co/timm/mobilenetv4_conv_small.e2400_r224_in1k/tree/main)、[SigLIP2 模型卡](https://huggingface.co/google/siglip2-base-patch16-224)、[完整文件列表](https://huggingface.co/google/siglip2-base-patch16-224/tree/main)、[PULC 清晰度模型与测试条件](https://github.com/PaddlePaddle/PaddleClas/blob/release/2.6/docs/zh_CN/models/PULC/PULC_clarity_assessment.md)、[PaddleClas 代码许可](https://github.com/PaddlePaddle/PaddleClas/blob/release/2.6/LICENSE)、[Apple 官方分类示例](https://developer.apple.com/documentation/vision/classifying-images-for-categorization-and-search)、[MediaPipe 官方特征任务](https://developers.google.com/edge/mediapipe/solutions/vision/image_embedder)。

现成方案仍由开发者做兼容、固定评测集和默认策略验证，不把标注大量照片、阈值滑块或提示词调试转嫁给用户。若需要绝不联网/遥测，应把 bundled ML Kit 与独立运行时的隐私边界一起比较；bundled 只说明模型可随包使用，不代表 SDK 没有度量通信。LiteRT/ONNX Runtime/Paddle Lite 是运行引擎，不是自动更准确的分类模型。截图/录屏优先依据可靠媒体类型和相册来源，没有充分证据时保持来源提示而不冒充内容识别。

## 建议与后续验证

### 追加：无需用户训练的其他现成路线

- **Paddle 多标签分类**：官方提供 PP-LCNet_x1_0_ML（29.4 MB）和 PP-HGNetV2-B0_ML（39.6 MB）推理资源，COCO2017 mAP 分别为 77.96、80.98。任务本身比 ImageNet 单一竞争类别更适合同时出现猫、狗、食物等对象；不是私人相册准确率，也不能证明截图、文档、风景覆盖。官方耗时来自 Xeon / Tesla T4，不用于估算手机。需要确认 Android 转换/运行兼容、量化损失、APK 增量、内存及耗电，均未实测；PaddleX 代码 Apache-2.0，具体下载权重的许可链仍需核对。作为 ML Kit 后的专项候选，不要求用户训练。[官方模型及测试条件](https://paddlepaddle.github.io/PaddleX/latest/module_usage/tutorials/cv_modules/image_multilabel_classification.html)、[代码许可](https://github.com/PaddlePaddle/PaddleX/blob/develop/LICENSE)。
- **Places365**：现成场景分类，可研究室内、街道、海边等场景，而非替代猫狗或文档模型。官方预训练模型为 CC BY，代码 MIT，分发需要适当署名；仓库未在该许可说明中指定 CC BY 版本，正式使用需确认对应文件条款。官方架构和部署格式不等于可直接接入手机，实际转换体积、速度、内存未知。本轮只作场景专项备选。[官方资源与许可说明](https://github.com/CSAILVision/places365)。
- **华为 ML Kit**：官方列有图像分类与场景检测，可作为国内设备路线调查。这里未核实具体功能的本地/云端组合、首次下载、HMS 服务依赖、分发条款、体积与 RN 兼容，不能据产品页宣传全离线或通用机型可用；这些未决点使其暂不进入优先实施。[官方能力目录](https://developer.huawei.com/consumer/en/hms/huawei-mlkit/)。

建议顺序仍为：bundled ML Kit 先做兼容性对比，Paddle 多标签做第二候选；模糊判断单独比较现成 PULC，不为了一个专项把整个相册分类换成大模型。场景专项和厂商 SDK 保留调查，不叠加多个引擎增加本轮包体与维护风险。所有评测与默认策略由开发者负责。

1. 首先保留当前权重并验收大类展示，解决细分类目录和分数叠加问题。
2. 若用户决定试新模型，第一候选为 ML Kit bundled 通用标签；先测常见相册类别与无 Play 服务环境，再决定迁移，不保证识别提升。
3. 轻量 EfficientNet 可在明确速度瓶颈时比较，目标是耗时/内存取舍，而非凭空增加相册知识。当前文件与候选权重来源、许可、索引必须先核对。
4. MobileCLIP 的许可问题未解决前，不进入公开产品实现；社区转换包不能替代原始许可与正确性验证。

后续评测由开发者完成，使用有许可的照片，固定类别、素材来源、切分和版本，同时记录未分类、错误分类、多标签以及截图/翻拍混淆；不要求用户训练或标注大图库。性能在同一 ARM64 手机测冷启动、图片读取预处理、推理、写库、峰值内存与连续扫描耗电，分别报告。开发者先做兼容与准确性对比，用户只需体验候选结果；本轮遵照指令不下载或接入新模型。

截图/录屏优先按系统类型或相册来源判断；OCR、文字/自然语言搜索、完全相同文件识别、压缩和编辑仅列为后续独立方案。普通通用分类模型不能替代这些功能的专项实现。

### 后续 OCR 资源补充（2026-10-05，仅调研）

ML Kit Text Recognition v2 提供中文 bundled 模型，模型可随应用构建，不使用首次 Play 服务模型下载路径；这仍不代表 SDK 无度量通信。PaddleOCR 当前官方 Android 示例提供 SDK / Demo 分离与 AAR 集成方式，列有 PP-OCRv6 tiny / small 及 PP-OCRv5 mobile，采用 ONNX Runtime，并涉及 OpenCV 等部署依赖。它们可以作为后续“截图文字本机搜索”的现成候选，而非当前分类模型的替代；需另验权重条款、RN 桥接、实际中文识别、完整 APK 增量、内存与索引隐私，不能将模型参数或 SDK 示例直接当作 PickPic 性能证据。识别文本不写日志、不自动上传，持久索引应纳入独立加密与清除设计；本轮没有下载、接入或创建 OCR 索引。[ML Kit 官方 Android 文档](https://developers.google.com/ml-kit/vision/text-recognition/v2/android)、[PaddleOCR 官方 Android 示例](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/android_deployment.en.md)。
