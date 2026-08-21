# @zenk/vision — DSH 本地视觉能力

> 为 DeepSeek Harness 提供**完全本地**的读图能力：模型可以把截图、上传的图片变成可分析的内容——**所有图片数据不出本机**。

## 能力

| 能力 | 说明 |
| --- | --- |
| **`vision_analyze` 模型工具** | 分析任意本地图片：① macOS Vision OCR 识别全部文字（中/英）+ **像素坐标** + 置信度；② 可选 `describe: true` 调用本地 ollama 视觉模型输出**语义描述**（布局、元素、异常区域） |
| **上传图片桥接** | 对话框直接粘贴/上传图片 → `agent/pre-step` 阶段把图片块转换为带**本地文件路径**的文本说明 → text-only 模型通道（DeepSeek chat-completions）不会拒绝整轮请求，模型在文本中看到路径后自动调用 `vision_analyze` 分析 |
| **`read_image` guard** | 拦截内置 `read_image` 工具（其产生的图片内容块在当前模型通道无法携带），统一引导到 `vision_analyze` |

### 工作原理

```
你在对话框粘贴图片
  → 图片保存到 ~/.dsh/attachments/v1/objects/<sha256前2位>/<sha256>（内容寻址）
  → agent/pre-step 桥接：图片块 → 文本说明（含本地路径）
  → 会话历史始终是纯文本，模型请求不会因图片块失败
  → 模型看到路径 → 调用 vision_analyze 分析（OCR 坐标 + qwen3-vl 语义）
  → 回复你图片内容
```

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | macOS（需 Vision framework 与 `swift` CLI，macOS 12+ 内置） |
| DSH | Desktop 2.0+（profile 插件机制） |
| [ollama](https://ollama.com) | 0.5+，运行中（`http://127.0.0.1:11434`） |
| 视觉模型 | `qwen3-vl:4b-instruct-q4_K_M`（推荐）或 2b/8b，见[模型选型](docs/ollama-setup.md#模型选型指南) |
| 磁盘 | 模型权重：2b≈1.8GB / 4b≈3.1GB / 8b≈5.7GB（`~/.ollama` 目录） |
| 内存 | 建议 16GB+（8GB 仅适合 2b 模型），见[内存规划](docs/ollama-setup.md#内存与磁盘规划) |

## 快速开始

```bash
# 1. 安装并启动 ollama（已装的跳过）
brew install ollama            # 或官网下载 dmg
ollama serve &                 # 首次需启动服务（brew 安装后一般已自动运行）

# 2. 拉取视觉模型（约 3.1GB，视网速 3~20 分钟）
ollama pull qwen3-vl:4b-instruct-q4_K_M

# 3. 验证
ollama list                     # 应看到 qwen3-vl:4b-instruct-q4_K_M
```

然后按[部署](#部署)接入 DSH。

> 完整安装细节（macOS 各安装方式、启动排查、模型选型表、性能调优）见 **[docs/ollama-setup.md](docs/ollama-setup.md)**。
> 遇到问题先查 **[docs/troubleshooting.md](docs/troubleshooting.md)**（20+ 常见问题）。

## 部署

1. 将包放入 profile 的 `node_modules/@zenk/vision/`，并在 profile `package.json` 的 `dsh.profile.bundles` 加入 `"@zenk/vision"`
2. **模型能力声明 patch**（让上传预检放行图片；⚠️ DSH 升级后需重新应用）：
   ```bash
   # 修改 <DSH>/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
   # 两处 inputModalities: ["text"] → ["text", "image"]
   ```
3. 完全退出并重启 DSH

验证：粘贴一张截图到对话框 → 发送 → 应看到消息被转换为含本地路径的文本说明，并收到图片内容分析。

## 市场收录

本插件已发布标准目录源（[manifest](catalog/source.json) + [provider page](catalog/plugins.json)），托管于 GitHub Pages：

- **Manifest URL**：`https://kaaaaahn.github.io/dsh-vision/catalog/source.json`

添加来源步骤：**设置 → 插件市场 → 添加来源 → 粘贴 Manifest URL**，即可浏览并安装本插件。

### 手动安装

```bash
pnpm add @zenk/vision   # 在 profile 目录，然后手动加入 dsh.profile.bundles
```

## 仓库结构

```
├── lib/
│   ├── index.js              # 插件入口：vision_analyze 工具 + 图片桥接 + read_image guard
│   └── vision_analyze.swift  # OCR + ollama 语义描述脚本（随包分发）
├── catalog/                  # DSH Community Market 目录源
│   ├── source.json           # 来源 manifest（com.zenk.dsh-vision）
│   └── plugins.json          # 标准 provider page（@zenk/vision）
├── docs/
│   ├── ollama-setup.md       # Ollama 部署详解：安装/模型选型/内存磁盘规划/性能调优
│   ├── troubleshooting.md    # 常见问题 FAQ
│   └── PUBLISHING.md         # 维护者内部文档（发布流程，非用户文档）
├── package.json
└── README.md
```

## License

MIT
