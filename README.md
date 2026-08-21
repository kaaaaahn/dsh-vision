# @zenk/vision

DSH 本地视觉插件：对话框里直接粘贴截图，AI 就能看到并分析，图片不出本机。

## 做什么

DSH 默认的模型通道是纯文本的，`read_image` 用不了，粘贴图片会被拒。本插件在图片进入会话前把它转成本地路径文本，再叠加 macOS Vision OCR 与本地 qwen3-vl 语义理解，让 AI 具备看图能力——不换模型、不改通道、不花钱、离线可用。

## 特性

- **OCR 带像素坐标**：识别文字并给出位置，UI 定位可以直接按坐标说
- **语义理解**：qwen3-vl 看懂画面整体，识别布局、元素、异常区域
- **零配置**：装好即用——自动检测环境、按内存选模型（8G→2b / 16~32G→4b / 32G+→8b）、缺 ollama 自动安装
- **渐进可用**：首次下载模型（后台，1.8~5.7GB）期间 OCR 已可用，语义描述就绪后自动开启
- **全本地**：免费、离线、图片不出 Mac

## 安装

1. 插件市场添加来源：`https://kaaaaahn.github.io/dsh-vision/catalog/source.json`
2. 设置 → 插件市场 → 添加来源 → 粘贴 URL → 安装 `@zenk/vision`
3. 重启 DSH

手动安装：`pnpm add @zenk/vision`，并加入 profile 的 `dsh.profile.bundles`。

## 使用

- **直接粘贴图片**发送，AI 自动分析并回复
- 或让 AI 调用 `vision_analyze(file_path=..., describe=true)` 分析本地文件（describe 开启语义描述）

## 文档

- [环境准备与模型选型](docs/ollama-setup.md)（手动安装、磁盘/内存规划、调优）
- [常见问题](docs/troubleshooting.md)（22 条 FAQ）

## 仓库结构

```
├── lib/
│   ├── index.js              # 插件入口：vision_analyze + vision_setup + 图片桥接 + guard
│   └── vision_analyze.swift  # OCR + ollama 语义描述脚本（随包分发）
├── catalog/                  # DSH Community Market 目录源
├── docs/
│   ├── ollama-setup.md       # 环境准备参考
│   ├── troubleshooting.md    # 常见问题 FAQ
│   └── PUBLISHING.md         # 维护者内部文档（发布流程）
└── package.json
```

## License

MIT
