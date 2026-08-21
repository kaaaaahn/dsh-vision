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

## 3. 模型能力声明 patch（随 DSH 升级需重做）

上传图片链路依赖部署级 patch，DSH 升级会覆盖：

```bash
# 文件：<DSH>/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
# 修改：两处 inputModalities: ["text"] → ["text", "image"]
sed -i.bak 's/inputModalities: \["text"\]/inputModalities: ["text", "image"]/g' \
  "/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"
```

备份在 `.bak` 后缀文件；回滚用备份覆盖即可。

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
