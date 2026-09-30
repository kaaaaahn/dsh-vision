# 维护者发布指南（内部文档，非用户文档）

> 本文档仅面向本仓库维护者，描述发布与市场收录的完整操作流程。

## 1. npm 发布（市场安装的前提）

市场安装从 npm 拉包（`package.registry` 固定为 `npm`），因此收录生效前必须先发布 npm：

```bash
cd <profile>/node_modules/@zenk/vision
npm adduser                      # 首次：登录 npm（交互式，浏览器验证）
npm publish --access public
```

### scope 说明

- 当前包名 `@zenk/vision` 要求拥有 `@zenk` scope（npm 组织，或用户名恰好为 zenk）
- 若 scope 不可用，二选一：
  1. 在 npm 创建 `zenk` 组织并转移归属
  2. 改名 `@<你的npm用户名>/vision`（改 `package.json` 的 `name`），并同步修改 `catalog/plugins.json` 中 `items[0].package.name` 与 `name`

## 2. 版本更新流程

```bash
# 1) 改版本号
npm version patch   # 或 minor / major（会同步 package.json 并打 git tag）

# 2) 同步目录源
#    编辑 catalog/plugins.json：
#    - latestVersion 与 updatedAt 更新为新版本
#    - generatedAt / revision 更新为当前时间

# 3) 提交并推送（GitHub Pages 自动重建目录源）
git add -A && git commit -m "release: vX.Y.Z" && git push origin main

# 4) 发布 npm
npm publish --access public

# 5) 验证目录源在线可用
curl -s https://kaaaaahn.github.io/dsh-vision/catalog/plugins.json | head
```

> 注意顺序：目录源先更新（Page 构建约 1 分钟），npm 后发布——两者都就绪后市场条目才可安装。

## 3. 模型图片能力：只查询，不改写（v0.4.0）

v0.4.0 起**不再改写任何配置**。能力判定走 harness 的正规入口：

```js
const sel = ctx.agentDefaultModel.currentSelection()          // { provider, model }
const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model)
info.inputModalities.includes('image')
```

查不到时按「不支持」处理（保守：桥接在任何情况下都安全，误判为支持才会让图片进纯文本通道）。不支持时只在 `vision_setup` 报告里**建议**用户切换模型，由用户在「设置 → 模型」自行操作。

> **为什么废弃了 v0.3.x 的 settings.yaml 写入**：`llm-deepseek.models` 是**整体替换**语义（`.default(DEFAULT_MODELS)` 只在字段缺失时生效），手写模型表会把官方默认目录里其他模型挤出去——被挤出的模型走 `modelInfoFor` 兜底分支按纯文本处理，**反而剥夺了官方默认就带的图片能力**（如 `deepseek-flash`）；同时把官方刻意定义为纯文本的 `deepseek-v4-flash` 标成支持 image，真发图可能被服务端拒绝。查证细节与实测矩阵见 [native-upload.md](native-upload.md)。

### Swift 分析工具预编译

`vision_analyze` 不再每次 `swift <script>` 现编译（需要写 Clang 模块缓存，缓存冷时可能被沙箱拒绝，报 `unable to open output file ... .pcm: Operation not permitted`）。改为 `swiftc -O` 一次，产物按「源文件大小+mtime」指纹缓存在 `$DSH_HOME/cache/zenk-vision/`，编译期用 `CLANG_MODULE_CACHE_PATH` / `SWIFT_MODULE_CACHE_PATH` 指向该可写目录，运行时只跑二进制（实测 0.96s → 0.30s）。

## 4. 本地开发

```bash
# 语法检查
node --check lib/index.js

# 脚本单测（不经 DSH）
swift lib/vision_analyze.swift /path/to/shot.png
swift lib/vision_analyze.swift /path/to/shot.png describe

# 组合验证（profile 已安装时）
node "<DSH>/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile <profile> --dump-config | grep zenk-vision
```

## 5. 依赖版本清单（维护时核对）

| 组件 | 版本要求 | 检查命令 |
| --- | --- | --- |
| macOS | 12+（Vision framework） | `sw_vers` |
| swift | 随 Xcode CLT 提供 | `swift --version` |
| ollama | 0.5+ | `ollama --version` |
| 视觉模型 | qwen3-vl:4b-instruct-q4_K_M | `ollama list` |

## 6. DSH 0.2 发布规范核对（清单）

发布前对照官方开发者文档核对（`docs/user/develop/`）：

- **包 manifest**：`dsh.bundle.patch` 指向 patch 文件；`main`/`exports` 指向入口；`files` 明确发布内容（本仓库：`lib/index.js`、`lib/vision_analyze.swift`、`cordis.patch.yml`）
- **patch 行**：`- insert: - id: <id>  name: <包名>`（按包名引用，Node 模块解析才能找到已安装代码）
- **服务依赖**：用到的服务写进 `export const inject`；`ctx.shell` 在 0.2 起**必须**声明，否则 `ctx.get('shell')` 返回 undefined
- **shell 调用**：`execute(spec)` → `await handle.result()`；结果字段 `exitCode`（null=信号）、`signal`、`timedOut`、`aborted`、`stdout.text`、`stderr.text`
- **工具定义**：`execute` 只返回规范值，渲染交给 `output.render`；显式对象声明 `additionalProperties`；按需声明 `timeoutMs`、`isConcurrencySafe`、`presentCall`
- **presentCall/presentResult**：必须是 args 的纯函数（回放期也会调用）
- **不要**依赖 `@deepseek-ai/dsh-tools` 的 `defineTool`，除非愿意把该包写进 peerDependencies（profile 与运行时都解析不到它）
- **desktop profile**：由 Electron 应用独占管理，验证插件用临时 profile
