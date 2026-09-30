# @zenk/vision

DSH 本地视觉插件：对话框里直接粘贴截图，AI 就能看到并分析，图片不出本机。

## 特性

- **OCR 带像素坐标**（macOS Vision）：识别文字并给出位置，UI 定位直接按坐标说
- **语义理解**（ollama + qwen3-vl）：看懂画面布局、元素与异常区域
- **两阶段读图**：先定位标注区域（文本/框线），再裁剪放大细看，标注内容读得准
- **自适应上传**：按当前模型的图片能力自动切换——支持 image 直接看见图，纯文本通道走本地视觉（不改写你的任何配置）
- **零配置**：自动检测环境、按内存选模型（8G→2b / 16~32G→4b / 32G+→8b）、缺 ollama 自动安装、Swift 工具自动预编译
- **渐进可用**：模型后台下载（1.8~5.7GB）期间 OCR 已可用
- **全本地**：免费、离线、图片不出 Mac

## 安装

```sh
dsh plugin --profile web add "github:kaaaaahn/dsh-vision#v0.4.0"
```

重启 DSH 生效。桌面端把 `--profile web` 换成 `--profile desktop`。

> 插件市场条目（添加来源 `https://kaaaaahn.github.io/dsh-vision/catalog/source.json`）依赖 npm 发布，目前暂未上线，请使用上方 GitHub 命令安装。

首次使用会自动下载模型并预编译 Swift 工具（均后台进行），期间 OCR 已可用；环境细节见 [docs/ollama-setup.md](docs/ollama-setup.md)。

## 使用

- **直接粘贴图片**发送，AI 自动分析并回复
- 或让 AI 调用 `vision_analyze(file_path=..., describe=true)` 分析本地文件（describe 开启语义描述与区域放大）

## 文档

- [环境准备与模型选型](docs/ollama-setup.md)
- [常见问题](docs/troubleshooting.md)（22 条 FAQ）
- [图片上传设计依据](docs/native-upload.md)（原生通道 vs 桥接、能力判定、预编译）

## 仓库结构

```
├── lib/
│   ├── index.js              # 插件入口：vision_analyze + vision_setup + 能力自适应桥接 + guard
│   └── vision_analyze.swift  # OCR + 区域定位 + ollama 语义描述（swiftc 预编译）
├── catalog/                  # DSH Community Market 目录源
├── docs/
│   ├── ollama-setup.md       # 环境准备参考
│   ├── troubleshooting.md    # 常见问题 FAQ
│   ├── native-upload.md      # 图片上传设计依据（能力判定/桥接/预编译）
│   └── PUBLISHING.md         # 维护者内部文档（发布流程）
└── package.json
```

## License

MIT
