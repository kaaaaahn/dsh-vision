# Ollama 部署详解（macOS）

本插件依赖 ollama 提供本地视觉模型推理。本文覆盖：安装、启动排查、模型拉取、模型选型、内存/磁盘规划、性能调优。

## 1. 安装 ollama

三种方式任选：

### 方式 A：Homebrew（推荐）

```bash
brew install ollama
```

安装后 brew 会自动注册服务：

```bash
brew services start ollama    # 开机自启（推荐）
# 或前台运行：ollama serve
```

### 方式 B：官方安装包

从 <https://ollama.com/download/mac> 下载 `Ollama-darwin.zip`，解压后把 `Ollama.app` 拖入「应用程序」。首次启动 App 即开始服务。

### 方式 C：命令行脚本（仅 macOS arm64）

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### 验证安装

```bash
ollama --version          # 应输出版本号（如 0.5.x / 0.6.x）
ollama list               # 列出已拉取模型（初始为空）
curl -s http://127.0.0.1:11434/api/version   # 服务健康检查，应返回 {"version":"..."}
```

> 第三条命令报 `connection refused` 说明服务未启动：`ollama serve`（前台）或 `brew services start ollama`（后台）。

## 2. 拉取视觉模型

```bash
ollama pull qwen3-vl:4b-instruct-q4_K_M
```

- 权重约 **3.1GB**，按网速不同耗时 3~20 分钟；显示进度条，`success` 结尾即完成
- 拉取中断可重跑同一条命令（断点续传）
- 国内网络慢时可配置镜像：`OLLAMA_HOST` 或使用代理后再拉取

### 可选模型规格

| 标签 | 权重大小 | 下载后占用 | 推荐内存 | 适用场景 |
| --- | --- | --- | --- | --- |
| `qwen3-vl:2b` | 1.76 GB | ~2 GB | 8 GB 起 | 内存紧张的老款 Mac、纯 OCR 辅助 |
| `qwen3-vl:4b-instruct-q4_K_M`（推荐） | 3.07 GB | ~3.5 GB | 16 GB 起 | 中文 UI 截图理解/OCR 的性价比之选 |
| `qwen3-vl:8b` | 5.72 GB | ~6.5 GB | 24 GB 起 | 复杂画面、文档版面、更高精度 |

> 数据来源：Ollama Registry 官方 manifest（2026-08 实测）。所有尺寸均为 Q4 量化后权重。
>
> 4b 是**体量小但综合性能最高**的选择：Qwen3-VL 系列的中文与 UI/截图理解能力在开源小模型中领先（[评测对比](https://codersera.com/blog/qwen3-vl-4b-vs-qwen3-vl-8b-benchmarks-vram-guide/)），4B 版在 Apple Silicon 上速度与质量平衡最好；2b 更小但理解力明显下降，8b 更强但内存与速度成本高。

### 切换模型

插件默认使用 `qwen3-vl:4b-instruct-q4_K_M`。自定义模型名（须已 `ollama pull`）：

```bash
# 工具参数 describe 之外，脚本也支持: swift vision_analyze.swift <图> describe:<模型名>
swift lib/vision_analyze.swift /tmp/shot.png describe:qwen3-vl:8b
```

## 3. 模型选型指南

### 3.1 内存规划

Apple Silicon 使用**统一内存**，模型加载占用 ≈ 权重 × 1.3 + KV cache + 系统开销：

| 你的 Mac 内存 | 可流畅运行 | 勉强可用 | 不建议 |
| --- | --- | --- | --- |
| 8 GB | 2b | 4b（会较慢/卡顿） | 8b |
| 16 GB | 4b ✅ | 8b | 32b |
| 24 GB | 4b / 8b ✅ | 32b | — |
| 36 GB+ | 8b / 32b | — | — |

> 运行期间 ollama 常驻内存：2b≈2.5GB、4b≈4.5GB、8b≈8GB。请给 DSH（Electron，常驻 1~2GB）和系统留足余量。

### 3.2 速度预期（Apple Silicon，视觉推理）

| 芯片 | 4b 描述单图 | 备注 |
| --- | --- | --- |
| M1 / M2（基础款） | 15~40 秒 | 可用但偏慢，建议 2b |
| M1 Pro / M2 Pro | 8~20 秒 | 日常可用 |
| M3 / M4 | 5~12 秒 | 流畅 |
| M4 Pro / Max | 3~8 秒 | 流畅 |

首次调用（冷启动）额外多 3~10 秒（加载模型进内存）；之后保持常驻。

### 3.3 磁盘规划

模型存放在 `~/.ollama/models/`（macOS 默认）。**三档模型同时拉取约占用 11GB**，只留推荐档约 3.5GB：

```bash
# 查看占用
du -sh ~/.ollama/models

# 删除不用的模型释放空间
ollama rm qwen3-vl:2b

# 模型目录迁移到大磁盘（可选）
# 1) 设置环境变量：export OLLAMA_MODELS=/Volumes/Data/ollama-models
#    （brew 服务：在 /Library/LaunchDaemons 或 ~/Library/LaunchAgents 的
#     com.ollama.plist 中加 EnvironmentVariables）
# 2) 或软链：mv ~/.ollama/models /Volumes/Data/ollama-models && ln -s /Volumes/Data/ollama-models ~/.ollama/models
```

## 4. 性能与调优

### 4.1 上下文窗口（num_ctx）

本插件调用 ollama 时已设置 `num_ctx: 16384`（脚本内硬编码），足以容纳大图的视觉 token（Qwen3-VL 按图缩放后约 1~4k token）。仍报 `exceeds the available context size` 时：

```bash
# 查看模型默认上下文
ollama show qwen3-vl:4b-instruct-q4_K_M
# 在 ~/.ollama 无全局配置时，可创建 Modelfile 覆盖
# FROM qwen3-vl:4b-instruct-q4_K_M
# PARAMETER num_ctx 32768
# ollama create qwen3-vl-4b-32k -f Modelfile
```

### 4.2 图片预处理

脚本在传给视觉模型前会把图片**最长边缩放到 1280px**：

- 目的：控制视觉 token 数量（4k 上下文内）、显著提速
- 影响：语义描述不受影响；OCR 坐标始终基于**原始分辨率**（OCR 用原图，不缩放）

### 4.3 温度与输出

- 脚本默认 `temperature: 0.2`（描述更稳定）、`num_predict: 400`（描述上限）
- 描述 prompt 限定 150 字以内，控制 token

### 4.4 常驻与释放

```bash
ollama ps                # 查看当前加载的模型与内存
ollama stop qwen3-vl:4b-instruct-q4_K_M   # 手动卸载释放内存
```

ollama 空闲 5 分钟自动卸载模型。需要时可用 `OLLAMA_KEEP_ALIVE` 调整（如 `OLLAMA_KEEP_ALIVE=30m ollama serve`）。

## 5. 常见安装命令速查

```bash
ollama list                  # 已拉取模型
ollama pull <model>          # 拉取
ollama rm <model>            # 删除
ollama run <model>           # 交互测试（可带图片路径做冒烟测试）
ollama ps                    # 运行中模型
ollama serve                 # 前台启动服务
brew services start ollama   # 后台常驻
curl http://127.0.0.1:11434/api/version   # 健康检查
```

---

下一步：遇到问题查 [troubleshooting.md](troubleshooting.md)。
