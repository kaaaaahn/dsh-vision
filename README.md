# @zenk/vision — DSH 本地视觉能力

为 DeepSeek Harness 提供读图能力：模型可以把本地图片（截图、附件）变成可分析的内容。

## 能力

1. **`vision_analyze` 模型工具**
   - macOS Vision OCR：识别图片中所有文字（中/英）+ 像素坐标 + 置信度
   - `describe: true` 时调用本地 ollama 视觉模型输出语义描述（布局、元素、异常区域）
2. **上传图片桥接**（`agent/pre-step`）
   - 消息中的图片块在进入会话历史前被转换为带本地路径的文本说明
   - text-only 模型通道（DeepSeek chat-completions）不会因图片块拒绝整轮请求
   - 模型在文本中看到图片路径 → 自动调用 `vision_analyze` 分析
3. **`read_image` guard**
   - 禁止 `read_image` 工具（它会产生通道不支持的图片内容），统一走 `vision_analyze`

## 依赖

- macOS（Vision framework + `swift` CLI）
- [ollama](https://ollama.com) 运行中，且已拉取视觉模型：
  ```bash
  ollama pull qwen3-vl:4b-instruct-q4_K_M   # ~3.3GB，性能/体积最佳
  # 更小：qwen3-vl:2b-instruct-q4_K_M（~1.6GB）
  ```

## 部署

1. 将包放入 profile 的 `node_modules/@zenk/vision/`，并在 profile `package.json` 的 `dsh.profile.bundles` 加入 `"@zenk/vision"`
2. **模型能力声明 patch**（让上传预检放行图片；DSH 升级后需重新应用）：
   ```bash
   # 修改 <DSH>/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
   # 两处 inputModalities: ["text"] → ["text", "image"]
   ```
3. 重启 DSH

## 发布与市场收录

仓库：https://github.com/kaaaaahn/dsh-vision

### 目录源（DSH Community Market）

本仓库的 `catalog/` 目录已发布标准目录源（[manifest](catalog/source.json) + [provider page](catalog/plugins.json)），托管于 GitHub Pages：

- **Manifest URL**：`https://kaaaaahn.github.io/dsh-vision/catalog/source.json`

DSH 用户添加来源步骤（设置 → 插件市场 → 添加来源 → 粘贴 Manifest URL），即可浏览并安装本插件。

### npm 发布（安装前提）

市场安装从 npm 拉包（`package.registry` 固定为 `npm`），因此收录生效前需发布 npm：

```bash
cd node_modules/@zenk/vision
npm adduser                      # 首次：登录 npm（交互式）
npm publish --access public      # 需要 @zenk scope 归属（npm 组织或改名）
```

若 `@zenk` scope 不可用，可把 `package.json` 的 `name` 改为 `@<你的npm用户名>/vision`，并同步更新 `catalog/plugins.json` 的 `package.name`。

### 手动安装

```bash
pnpm add @zenk/vision   # 在 profile 目录，然后手动加入 dsh.profile.bundles
```

## License

MIT
