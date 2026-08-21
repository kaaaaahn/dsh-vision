# 常见问题（Troubleshooting）

按现象分类，从高频到低频。定位问题先看顺序：**ollama 服务 → 模型 → 图片路径 → DSH 集成**。

## 〇、vision_setup 相关

### Q0. vision_setup 是什么？为什么需要它？

`vision_setup` 是本插件自带的**环境工具**：一条命令检测你的机器（ollama 程序/服务、已拉取模型、内存、磁盘、模型能力 patch 状态），按内存推荐合适的视觉模型；`auto=true` 时自动完成安装 ollama（brew）、启动服务、拉取推荐模型、补打模型 patch——开箱即用，不需要手动装任何东西。

```text
用法：vision_setup            # 检测并输出报告
      vision_setup(auto=true) # 一键安装（耗时可长达数分钟）
```

### Q0.1 一键安装失败怎么办？

按报错分段排查（安装顺序：ollama → 服务 → 模型 → patch）：
- **「未检测到 brew」**：机器没有 Homebrew。先装 brew（`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`）或从官网下载 ollama dmg，再重跑
- **「brew 安装 ollama 失败」**：网络问题，重试；或官网下载 dmg
- **「ollama 服务启动失败」**：手动 `ollama serve` 看输出
- **「模型拉取失败」**：网络慢/中断，重跑 `ollama pull` 续传；必要时挂代理
- **「模型能力 patch 失败」**：DSH 版本结构变化（见 Q12 的检查命令）；不影响 OCR-only 使用，仅上传图片会被预检拒绝

### Q0.2 为什么检测报告说「模型能力 patch 未生效」？

上传图片预检依赖部署级 patch（`dsh-llm-deepseek` 声明 image 输入能力）。DSH **升级会覆盖**此文件，升级后运行 `vision_setup(auto=true)` 会自动补打；也可手动检查（见 Q12）。

## 一、ollama 相关

### Q1. vision_analyze 返回「ollama 不可达: Could not connect...」

**原因**：ollama 服务未运行。

**解决**：
```bash
brew services start ollama    # 后台常驻
# 或前台：ollama serve
curl -s http://127.0.0.1:11434/api/version   # 验证，应返回版本 JSON
```
若 curl 通了再试分析。注意：脚本固定访问 `127.0.0.1:11434`，如果改了 `OLLAMA_HOST` 端口，脚本需要同步修改（`vision_analyze.swift` 中 `URL(string: "http://127.0.0.1:11434/api/generate")`）。

### Q2. 返回「ollama 调用失败: model \"qwen3-vl:4b-instruct-q4_K_M\" not found」

**原因**：模型未拉取或名称不一致。

**解决**：
```bash
ollama list                   # 确认模型存在
ollama pull qwen3-vl:4b-instruct-q4_K_M   # 不存在则拉取
```
标签必须完全一致（含 `-instruct-q4_K_M` 后缀）。若用了其他模型名，用 `describe:<模型名>` 模式（见 ollama-setup.md §2）。

### Q3. 拉取模型很慢 / 卡在 downloading

- 断点续传：重跑 `ollama pull` 同一命令即可
- 网络慢时挂代理后重试
- 也可用国内镜像源（社区镜像，自行甄别）或先在有条件的地方拉好再拷贝 `~/.ollama/models` 目录（跨机需版本兼容）

### Q4. 「exceeds the available context size (4096 tokens)」

**原因**：ollama 默认上下文 4096，大图视觉 token 放不下（旧版脚本未设置 num_ctx 时出现；当前版本已内置 `num_ctx: 16384` + 图片缩放，通常不会再触发）。

**解决**：仍触发时（超大长图、自定义模型）：
1. 确认用的是本仓库最新脚本（含 `"num_ctx": 16384`）
2. 自定义更大上下文的模型：见 ollama-setup.md §4.1（Modelfile `PARAMETER num_ctx 32768`）

### Q5. 分析很慢 / 首次调用等很久

- 首次调用包含**冷启动**（模型加载进内存 3~10 秒），正常
- 之后保持常驻则快；长时间未用被卸载会再次冷启动
- 图太大：脚本已自动缩放到 1280px；仍慢可考虑换 2b 模型
- 内存不足导致 swap：见 Q7

### Q6. 分析时电脑卡顿 / 风扇狂转

- 内存吃紧触发 swap：关闭其他大内存应用，或换更小的模型（2b）
- 可用 `ollama ps` 观察占用，`ollama stop <模型>` 手动释放
- 8GB 内存 Mac 强烈建议 2b 模型

### Q7. 内存不足 / 模型加载被系统杀掉

- 查看 `ollama ps` 与「活动监视器」内存压力
- 换小模型（2b：运行占用约 2.5GB）
- 磁盘空间不足也会导致模型加载失败（GGUF 需 mmap）：先清理磁盘（见 Q8）

### Q8. 磁盘空间不足（模型约 3.1GB+，三档全拉约 11GB）

```bash
du -sh ~/.ollama/models        # 看占用
ollama rm qwen3-vl:2b          # 删除不用的
```
大模型目录迁移方法见 ollama-setup.md §3.3（`OLLAMA_MODELS` 或软链）。

## 二、图片与 OCR 相关

### Q9. OCR 识别文字有错字 / 缺字

- Vision OCR 是尽力识别，极小的字号（<10px）、艺术字、深色低对比场景会出错
- 语义理解请用 `describe: true`（qwen3-vl 直接看原图，通常更准确）
- 截图建议保持原始分辨率导出（脚本 OCR 用原图）

### Q10. describe 模式返回的语义描述不准

- 4b 是 44 亿参数小模型，复杂推理有限；需要更强换 8b
- 描述 prompt 限 150 字，长画面信息会被压缩
- 温度 0.2 已尽量稳定；个别画面确实难以判断时模型会说明「无法确定」

### Q11. 上传图片后消息变成一段「[用户上传了图片；本地文件 ...]」文本？

**这是设计行为，不是 bug**：桥接把图片块转换为含本地路径的文本，DeepSeek 通道才能继续。模型会基于该路径自动调用 vision_analyze。若模型没有自动分析，直接对它说「分析这张图」即可。

### Q12. 上传图片仍提示「当前模型不支持图片识别」

**原因**：模型能力声明 patch 未生效（最常见）或被 DSH 升级覆盖。

**检查**：
```bash
grep -n "inputModalities" "/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"
# 期望输出：["text", "image"]（两处）
```
若仍是 `["text"]`：按 README「部署」第 2 步重新 patch，然后**完全退出并重启 DSH**（Cmd+Q）。当前进程不会热加载此改动。

### Q13. 粘贴图片后完全没反应 / 消息发不出去

- 先确认 Q12 的 patch 已生效（上传预检放行是第一步）
- 再看消息是否转换成功（Q11）
- 若本轮报错（如工具 schema 问题），查看会话错误信息后重启 DSH

## 三、DSH 集成相关

### Q14. vision_analyze 工具不存在 / 模型工具列表里没有

- 确认 `@zenk/vision` 已加入 profile `package.json` 的 `dsh.profile.bundles`
- 确认已重启 DSH（bundle 启动时加载）
- 插件被禁用：设置 → 插件，检查状态；或直接看
  `~/Library/Application Support/DSH Desktop/plugin-management/state.json` 的 `disabledBundles`（不应包含 `@zenk/vision`）
- 组合验证：`node <DSH>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile <profile> --dump-config` 中应有 `id: zenk-vision`

### Q15. 插件与 @zenk/gamedev 冲突吗？

不冲突。视觉能力已从 gamedev 拆分为独立插件；两者职责分离（视觉 vs 游戏设计库）。同时安装时工具名不重叠（gamedev 不含 vision_analyze）。

### Q16. 报错「read_image 会产生模型通道不支持的图片内容...」

这是 guard 的**预期提示**：模型尝试调用内置 `read_image` 被拦截。当前 DeepSeek 通道无法携带图片内容块，应使用 `vision_analyze` 替代。若模型反复调用 read_image，在对话中明确指示使用 vision_analyze。

### Q17. 升级 DSH 后功能失效

DSH 升级会覆盖两处：
1. `dsh-llm-deepseek` 的 inputModalities（见 Q12）→ 重新 patch
2. `node_modules/@zenk/vision/`（如果装在 app 目录下）→ 重新安装到 profile 目录

profile 目录（`~/.dsh/profiles/<name>/node_modules`）不受升级影响。

### Q18. 如何卸载

```bash
# 1) 从 profile package.json 的 dsh.profile.bundles 移除 "@zenk/vision"
# 2) 删除目录
rm -rf ~/.dsh/profiles/<name>/node_modules/@zenk/vision
# 3) 可选：恢复模型能力 patch（["text","image"] → ["text"]）并删除模型
ollama rm qwen3-vl:4b-instruct-q4_K_M
```

### Q19. 多 profile / 多用户场景

- 插件按 profile 安装；每个 profile 的 `dsh.profile.bundles` 独立
- ollama 与模型是全机共享（`~/.ollama`），多 profile 共用同一模型，内存只加载一份

### Q20. 自定义 ollama 模型名后工具不生效

`vision_analyze` 工具本身不暴露模型名参数（默认 4b）。自定义模型请：
1. 直接改 `lib/vision_analyze.swift` 中 `var modelName = "qwen3-vl:4b-instruct-q4_K_M"` 的默认值
2. 或命令行模式 `swift vision_analyze.swift <图> describe:<模型名>`（开发调试用）

## 四、开发与调试

### Q21. 单独测试脚本（不经过 DSH）

```bash
swift lib/vision_analyze.swift /path/to/shot.png              # 仅 OCR
swift lib/vision_analyze.swift /path/to/shot.png describe      # OCR + 语义
```
返回 JSON：`width/height`、`texts[]`（text/x/y/w/h/conf，左上原点像素坐标）、`vision`（语义描述）。

### Q22. 图片路径含中文/空格

脚本通过 shell 调用并做了单引号转义，正常支持中文路径与空格。极特殊字符（换行等）理论上会失败，规避即可。

---

仍无法解决？带上以下信息开 issue（[github.com/kaaaaahn/dsh-vision/issues](https://github.com/kaaaaahn/dsh-vision/issues)）：
1. 复现步骤与现象（截图）
2. `ollama --version` 与 `ollama list` 输出
3. `curl http://127.0.0.1:11434/api/version` 结果
4. `vision_analyze` 的完整报错文本
