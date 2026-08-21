# @zenk/vision

DSH 本地视觉插件：对话框里直接粘贴截图，AI 就能看到并分析，图片不出本机。

## 特性

- **OCR 带像素坐标**（macOS Vision）：识别文字并给出位置，UI 定位直接按坐标说
- **语义理解**（ollama + qwen3-vl）：看懂画面布局、元素与异常区域
- **零配置**：自动检测环境、按内存选模型（8G→2b / 16~32G→4b / 32G+→8b）、缺 ollama 自动安装
- **渐进可用**：模型后台下载（1.8~5.7GB）期间 OCR 已可用
- **全本地**：免费、离线、图片不出 Mac

## 安装

```sh
dsh plugin --profile web add "github:kaaaaahn/dsh-vision"
```

重启 DSH 生效。桌面端把 `--profile web` 换成 `--profile desktop`。

也可以从插件市场安装：设置 → 插件市场 → 添加来源 → 粘贴 `https://kaaaaahn.github.io/dsh-vision/catalog/source.json` → 安装 `@zenk/vision`。

首次使用会自动下载模型（后台进行），期间 OCR 已可用；环境细节见 [docs/ollama-setup.md](docs/ollama-setup.md)。

## 使用

- **直接粘贴图片**发送，AI 自动分析并回复
- 或让 AI 调用 `vision_analyze(file_path=..., describe=true)` 分析本地文件（describe 开启语义描述）

## 文档

- [环境准备与模型选型](docs/ollama-setup.md)
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
