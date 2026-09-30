# 图片上传：harness 原生通道 vs 本插件桥接

本文件记录 v0.4.0 的设计依据。结论来自对部署内 `@deepseek-ai/dsh-llm` 与
`@deepseek-ai/dsh-llm-deepseek` 源码的查证，不是推测。

## 一、harness 自己就能发图

`dsh-llm-deepseek` 的适配器原生构造图片 content part：

```js
// lib/index.js:62-72
{ type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${...}` } }
```

图片可以是 `data:` URL 内联，也可以通过 DeepSeek Files API 走 `file_id`。
另有一条完整链路：durable attachment → 归一化 → 尺寸/字节预算 → 超预算的
最老图片降级成文本（`offloadedImagePrefixCount`）。

## 二、门禁只有一个：`inputModalities`

```js
// dsh-llm-deepseek lib/index.js:1620
if (connection.models.find(e => e.id === options.model)?.inputModalities?.includes('image') !== true)
  throw new LlmError(`DeepSeek model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
```

模型目录来自 `Config.models`，默认值是内置的 `DEFAULT_MODELS`：

| 模型 id | 默认 `inputModalities` |
| --- | --- |
| `deepseek-flash`（DeepSeek-V41-Flash） | `["text", "image"]` |
| `deepseek-v4-flash` | 未声明 → `["text"]` |
| `deepseek-v4-pro` | 未声明 → `["text"]` |
| `deepseek-v4-flash-vision-exp` | `["text", "image"]` |

本机部署组合里 `llm-deepseek` 这一行**没有 config**，即 `models` 走内置默认。
所以 `deepseek-flash` 本来就支持图片，`llm-deepseek: {}` 这个空段不会削弱它。

## 三、坑：`models` 是整体替换，不是合并

```js
models: z.array(catalogModel).default(DEFAULT_MODELS)
```

`.default()` 只在字段缺失时生效。一旦 settings 里写了 `models:`，整张表被替换。

v0.3.x 曾把下面这张手写表写进 `settings.yaml`：

```yaml
llm-deepseek:
  models:
    - id: deepseek-v4-flash        # 官方定义为纯文本
    - id: deepseek-v4-pro
    - id: deepseek-v4-flash-vision-exp
```

两个问题：

1. **表里没有 `deepseek-flash`**。本机默认模型正是 `deepseek-flash`，被挤出目录后
   走 `modelInfoFor` 的兜底分支 `inputModalities: ["text"]`，**图片能力反而被剥夺**。
2. `deepseek-v4-flash` 被标成支持 image，而官方目录刻意把它定义为纯文本——真发图
   可能被服务端拒绝。

v0.4.0 因此**不再改写真配置**：能力判定改为向 harness 查询，不支持时只做建议。

## 四、能力判定的正规入口

```js
const sel = ctx.agentDefaultModel.currentSelection()      // { provider, model }
const info = await ctx.llm.resolveModelInfo(sel.provider, sel.model)
info.inputModalities.includes('image')
```

查不到时按「不支持」处理——桥接在任何情况下都安全，误判为支持才会出事。

## 五、纯文本通道下官方降级丢掉了什么

`dsh-llm` 对无 image 模态的路由会先把图片投影成文本：

```js
// dsh-llm lib/index.js:541
`[image omitted because this model accepts text only; attachment sha256:${id.slice(7,15)}]`
```

模型只拿到 8 位 sha256 前缀，**无法据此读回图片**。这正是桥接存在的唯一理由：
换成带**本地可读路径**的文本，模型可以立刻调用 `vision_analyze`。

反过来，模型支持 image 时，harness 除了发真图，还会附上可读路径：

```js
// dsh-llm lib/index.js:533-556
`Normalized copy (read-only; may be resized or re-encoded): "${access.readonlyPath}" (WxHpx, type)`
```

所以此时桥接不但多余，还会**抢在真图之前**把图换掉——纯降级。

## 六、v0.4.0 行为矩阵

| 当前模型 | 粘贴图片 | `read_image` | `vision_analyze` 的定位 |
| --- | --- | --- | --- |
| 声明 `image` | 原样进请求，模型直接看见 | 放行 | 像素级工具：需要 OCR 文本/坐标/区域框时用 |
| 纯文本 | 换成带本地路径的文本 | 封禁并给出替代提示 | 唯一的看图手段 |
| 能力查询失败 | 同「纯文本」（保守） | 封禁 | 同「纯文本」 |

## 七、Swift 工具改为预编译

旧实现每次调用都 `swift <script>` 现编译，需要写 Clang 模块缓存
（`/var/folders/.../C/clang/ModuleCache`）。缓存冷时该写入可能被沙箱拒绝，报：

```
error: unable to open output file '.../SwiftShims-....pcm': 'Operation not permitted'
```

整个工具随之失败，且每次 macOS / Command Line Tools 升级都会复发。

v0.4.0 改为 `swiftc -O` 一次，产物按「源文件大小+mtime」指纹缓存在
`$DSH_HOME/cache/zenk-vision/`，编译期把 `CLANG_MODULE_CACHE_PATH` /
`SWIFT_MODULE_CACHE_PATH` 显式指到 `$DSH_HOME` 下的可写目录。运行时只跑二进制，
不再依赖 clang。实测单次调用 0.96s → 0.30s（约 3.2×）。

## 八、DSH 0.2（正式版）兼容适配（v0.5.0）

DSH 0.2 起 shell 执行 seam 与工具规范都有变化。以下结论来自在 0.2.0-rc.2 上用探针插件实测，不是推测。

### 8.1 `shell.run()` 已从 seam 移除

旧调用（v0.4.0 及以前，在 0.2 上**完全失效**）：

```js
const res = await shell.run(shell.resolve({ command, timeoutMs }))
res.exitCode, res.stdout.text, res.stderr.text
```

新 seam（`@deepseek-ai/dsh-shell`）只有一个执行方法，且必须两步取结果：

```js
const execution = await ctx.shell.execute(ctx.shell.resolve({ command, timeoutMs }))
const result = await execution.result()
result.exitCode      // 数字；null = 被信号终止
result.signal        // 终止信号名
result.timedOut      // 超时是否为首个中断原因
result.aborted       // 调用方中止是否为首个原因
result.stdout.text   // 截断时是流的尾部；truncated / spillPath 另有指示
```

`result()` 不因非零退出、超时或中止而 reject——它们都是结果；只有基础设施故障（工作目录不可用、缺 shell、准备失败）才 reject `execute`。插件内的 `runShell()` 同时兼容两代 seam，并在旧版走 `run()` 分支。

### 8.2 `ctx.shell` 必须由 `inject` 声明

实测（inject 只写 `['tools']`）：

```text
shell=undefined | llm=OK | agentDefaultModel=OK | attachments=OK | tools=OK | jobs=OK
```

`shell` 是唯一**不 inject 就拿不到**的服务（新版按需提供，且 `ctx.shell` 属性访问只对已 inject 的服务可用）。因此 `inject` 必须写 `['tools', 'shell']`；llm / agentDefaultModel / attachments 仍可 `ctx.get()` 取用并保持可选。

### 8.3 `defineTool` 在本插件不可用

官方推荐用 `@deepseek-ai/dsh-tools` 的 `defineTool()`（自动参数校验 + 类型推导）。但该包**在 profile 与运行时的模块解析中都拿不到**：

```text
Cannot find package '@deepseek-ai/dsh-tools' imported from .../plugins/vision/index.js
```

要用它就得把 `@deepseek-ai/dsh-tools` 同时写进 `peerDependencies` 与 `devDependencies`，让 pnpm 在 profile 内装一份副本——代价是插件与宿主工具包版本强耦合，宿主升级即可能错配。官方规范明确「直接注册的原始 JSON Schema 工具自行负责输入校验，但仍需声明输出」，因此本插件保持**原始 JSON Schema 注册**，并把规范允许的元数据补齐（见 8.4）。

### 8.4 工具元数据（规范允许的字段实测均被接受）

| 字段 | 用途 | 本插件取值 |
| --- | --- | --- |
| `parameters.additionalProperties: false` | 显式对象节点必须声明 | 两个工具都已声明 |
| `timeoutMs` | 策略元数据（非模型可见 schema） | `vision_analyze` 200s；`vision_setup` 1800s |
| `isConcurrencySafe(args)` | 只有返回确切 `true` 才允许并发分发 | `vision_analyze` 为只读分析，参数合法即并发安全；`vision_setup` 可能安装软件，保持独占 |
| `presentCall(args)` | UI 卡片（纯函数，回放期也会调用） | `vision_analyze` 返回 `{ card: 'generic', kind: 'read', locations: [{ path }] }`，让有能力的编辑器跟随图片文件 |
| `output.schema` + `render` | `execute` 只返回规范值，渲染交给 `render` | 字符串根 + `[{ type: 'text', text }]` |

> `presentCall` / `presentResult` 必须是 `args`（加结果）的纯函数——不做 I/O、不读会话状态、不用时钟或随机数，因为 UI 在实时流式输出和日志回放时都会调用它们。

### 8.5 profile 归属

0.2 起 `--profile desktop` 由 Electron 应用独占管理，CLI 直接操作会报：

```text
error: profile "desktop" is managed exclusively by the Electron application
```

验证插件请另建临时 profile（`dsh plugin --profile <tmp> add <path>`），不要直接改 desktop profile 的配置。
