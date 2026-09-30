// @zenk/vision — DSH 本地视觉能力
// 1) vision_analyze 模型工具：macOS Vision OCR（文字+像素坐标）+ ollama qwen3-vl 语义描述
// 2) vision_setup 环境工具：检测 ollama/模型/内存/磁盘，按性能推荐模型，可一键安装
// 3) 上传图片桥接：agent/pre-step 把消息里的图片块转成带本地路径的文本说明，
//    让 text-only 模型通道（DeepSeek chat-completions）不会因图片块拒绝请求，
//    同时模型能在文本里看到图片路径并调用 vision_analyze 分析
// 4) read_image guard：该工具会产生模型通道不支持的图片内容，禁止调用
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'

export const name = 'zenk-vision'
export const inject = ['tools', 'shell']

const scriptPath = fileURLToPath(new URL('./vision_analyze.swift', import.meta.url))
const attachmentRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'attachments', 'v1')

// ── 当前路由的图片能力：向 harness 查询，不猜配置 ──
// 判定依据是 harness 自己解析出来的模型能力（llm.resolveModelInfo），模型来自
// agentDefaultModel.currentSelection()。之所以不再自己改写 settings.yaml 的
// llm-deepseek.models：那是「整体替换」语义而非追加，手写一份模型表会把表里
// 没有的模型挤出目录，被挤出的模型按 inputModalities:["text"] 处理，反而丢掉
// 官方默认就带的图片能力。官方默认目录（dsh-llm-deepseek DEFAULT_MODELS）里
// deepseek-flash 与 deepseek-v4-flash-vision-exp 本就声明了 image。
const cacheRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'cache', 'zenk-vision')

/** POSIX 单引号转义，用于拼接 shell 命令。 */
function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * 统一的 shell 执行入口，兼容两代 shell seam：
 * - 新版（DSH 0.2+）：`shell.execute(spec)` 返回句柄，再 `await handle.result()`；
 *   `run()` 已从 seam 移除，且 `ctx.shell` 必须由 `inject` 声明才可见。
 * - 旧版：`shell.run(spec)` 直接 resolve 结果。
 * 统一返回 { exitCode, out, err, timedOut, signal }；exitCode 为 null 表示被信号终止。
 */
async function runShell(shell, { command, timeoutMs = 15000 }) {
  const spec = shell.resolve({ command, timeoutMs })
  if (typeof shell.execute === 'function') {
    const handle = await shell.execute(spec)
    const result = await handle.result()
    return {
      exitCode: result.exitCode,
      out: (result.stdout && result.stdout.text) || '',
      err: (result.stderr && result.stderr.text) || '',
      timedOut: !!result.timedOut,
      signal: result.signal || null,
    }
  }
  const res = await shell.run(spec)
  return {
    exitCode: res.exitCode,
    out: (res.stdout && res.stdout.text) || '',
    err: (res.stderr && res.stderr.text) || '',
    timedOut: false,
    signal: null,
  }
}

/**
 * 解析当前默认路由的图片能力。
 * 服务缺失或查询失败时返回 known:false —— 调用方必须按「不支持」处理，
 * 因为桥接在任何情况下都是安全的，而误判为支持会让图片进到纯文本通道。
 */
async function resolveRoute(ctx) {
  const adm = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  if (!adm || !llm) return { known: false, reason: 'llm/agentDefaultModel 服务不可用' }
  let sel
  try {
    sel = adm.currentSelection()
  } catch (e) {
    return { known: false, reason: String((e && e.message) || e) }
  }
  if (!sel || !sel.provider || !sel.model) return { known: false, reason: '未选择默认模型' }
  try {
    const info = await llm.resolveModelInfo(sel.provider, sel.model)
    const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : []
    return {
      known: true,
      provider: sel.provider,
      model: sel.model,
      name: (info && info.name) || sel.model,
      acceptsImages: modalities.includes('image'),
      modalities,
    }
  } catch (e) {
    return { known: false, provider: sel.provider, model: sel.model, reason: String((e && e.message) || e) }
  }
}

/** 列出当前 provider 下官方已声明 image 的模型，供用户切换（不自动改配置）。 */
async function imageCapableModels(ctx) {
  const llm = ctx.get('llm')
  const adm = ctx.get('agentDefaultModel')
  if (!llm || !adm) return []
  try {
    const sel = adm.currentSelection()
    if (!sel || !sel.provider) return []
    const list = await llm.listModels(sel.provider)
    return (list || []).filter((m) => Array.isArray(m.inputModalities) && m.inputModalities.includes('image'))
  } catch (e) {
    return []
  }
}

// ── Swift 脚本预编译：swiftc -O 一次，之后直接跑二进制 ──
// 旧实现每次调用都 `swift <script>` 现编译，编译需要写 Clang 模块缓存
// （/var/folders/.../C/clang/ModuleCache）。缓存冷时那次写入可能被沙箱拒绝，
// 报 "unable to open output file ... .pcm: Operation not permitted"，整个工具就
// 直接失败。预编译后运行时不再需要 clang，也不会随 macOS/CLT 升级而复发；
// 编译期把模块缓存显式指到 $DSH_HOME 下可写的位置，同样不再依赖系统缓存目录。
async function ensureBinary(shell) {
  let stamp
  try {
    const st = await fsp.stat(scriptPath)
    stamp = String(st.size) + '-' + String(Math.floor(st.mtimeMs))
  } catch (e) {
    return { ok: false, error: '找不到 vision_analyze.swift: ' + String((e && e.message) || e) }
  }
  const bin = path.join(cacheRoot, 'vision_analyze-' + stamp)
  const modCache = path.join(cacheRoot, 'clang')
  const exists = async () => {
    try {
      const res = await runShell(shell, {
        command: 'test -x ' + shq(bin) + ' && echo __OK__ || echo __MISSING__',
        timeoutMs: 10000,
      })
      return String(res.out || '').includes('__OK__')
    } catch (e) {
      return false
    }
  }
  if (await exists()) return { ok: true, bin, cached: true }
  const command = 'mkdir -p ' + shq(cacheRoot) + ' ' + shq(modCache) +
    ' && CLANG_MODULE_CACHE_PATH=' + shq(modCache) +
    ' SWIFT_MODULE_CACHE_PATH=' + shq(modCache) +
    ' swiftc -O -o ' + shq(bin) + ' ' + shq(scriptPath)
  try {
    const res = await runShell(shell, { command, timeoutMs: 180000 })
    if (res.exitCode !== 0) {
      return { ok: false, error: 'swiftc 编译失败: ' + String(res.err || res.out || '').trim().slice(0, 800) }
    }
    if (!(await exists())) return { ok: false, error: 'swiftc 退出码为 0 但未产出可执行文件: ' + bin }
    return { ok: true, bin, cached: false }
  } catch (e) {
    return { ok: false, error: 'swiftc 调用失败: ' + String((e && e.message) || e) }
  }
}


const RECOMMENDED_MODEL = 'qwen3-vl:4b-instruct-q4_K_M'

// 按内存推荐模型：8G→2b、16~32G→4b、32G+→8b
function recommendModel(memoryGB) {
  if (!memoryGB || memoryGB < 12) return { model: 'qwen3-vl:2b', sizeGB: 1.8, note: '8GB 内存的老款 Mac：选最小模型，保证可用' }
  if (memoryGB < 32) return { model: RECOMMENDED_MODEL, sizeGB: 3.1, note: '16~24GB 内存主流配置：4b 性价比最佳' }
  return { model: 'qwen3-vl:8b', sizeGB: 5.7, note: '32GB+ 内存：可选 8b 获得更高理解力' }
}

// ── 环境检测 ──
async function detectEnv(ctx) {
  const shell = ctx.get('shell')
  if (!shell) return { error: 'shell 服务不可用' }
  const run = async (command) => {
    try {
      const res = await runShell(shell, { command, timeoutMs: 15000 })
      return { exitCode: res.exitCode, out: String(res.out || '').trim() }
    } catch (e) {
      return { exitCode: -1, out: '' }
    }
  }
  const env = {}

  const which = await run('command -v ollama || echo __MISSING__')
  env.ollamaBinary = which.out && !which.out.includes('__MISSING__') ? which.out : null

  const svc = await run('curl -s --max-time 3 http://127.0.0.1:11434/api/version || echo __UNREACHABLE__')
  env.ollamaService = svc.out && !svc.out.includes('__UNREACHABLE__') && !svc.out.includes('curl:') ? svc.out : null

  const list = await run('ollama list 2>/dev/null | tail -n +2 | awk \'{print $1}\'')
  env.models = env.ollamaBinary ? list.out.split('\n').map((s) => s.trim()).filter(Boolean) : []

  const mem = await run('sysctl -n hw.memsize 2>/dev/null || echo 0')
  env.memoryGB = Math.round((parseInt(mem.out, 10) || 0) / 1073741824)

  const disk = await run('df -k ~ 2>/dev/null | tail -1 | awk \'{print $4}\'')
  env.diskFreeGB = Math.round((parseInt(disk.out, 10) || 0) / 1048576)

  const rec = recommendModel(env.memoryGB)
  env.recommended = rec.model
  env.recommendedNote = rec.note
  env.recommendedSizeGB = rec.sizeGB
  env.modelReady = env.models.includes(rec.model)
  env.anyVisionModel = env.models.some((m) => m.includes('qwen3-vl') || m.includes('vl') || m.includes('llava'))
  env.brew = (await run('command -v brew || echo __MISSING__')).out.includes('__MISSING__') ? null : 'brew'

  // 当前路由的图片能力：向 harness 查（不再读 settings.yaml 猜）
  env.route = await resolveRoute(ctx)
  env.imageReady = env.route.known && env.route.acceptsImages
  if (!env.imageReady) env.imageModels = await imageCapableModels(ctx)

  // Swift 工具链：预编译产物是否就绪（首次调用会编译，之后命中缓存）
  const bin = await ensureBinary(shell)
  env.swiftBin = bin.ok ? bin : null
  env.swiftError = bin.ok ? null : bin.error
  return env
}

function formatEnv(env) {
  const lines = ['【环境检测】']
  lines.push('· macOS 内存: ' + (env.memoryGB ? env.memoryGB + ' GB' : '未知'))
  lines.push('· 磁盘可用: ' + (env.diskFreeGB ? env.diskFreeGB + ' GB' : '未知'))
  lines.push('· ollama 程序: ' + (env.ollamaBinary || '未安装'))
  lines.push('· ollama 服务: ' + (env.ollamaService ? '运行中 (' + env.ollamaService + ')' : '未运行/不可达'))
  lines.push('· 已拉取模型: ' + (env.models.length ? env.models.join(', ') : '无'))
  lines.push('· 推荐模型: ' + env.recommended + '（' + env.recommendedNote + '，约 ' + env.recommendedSizeGB + ' GB）')
  const route = env.route || { known: false }
  lines.push('· 当前模型: ' + (route.known
    ? route.provider + '/' + route.model + '（' + route.name + '）'
    : '未知（' + (route.reason || '查询失败') + '）'))
  lines.push('· 模型图片能力: ' + (env.imageReady
    ? '支持 image —— 粘图走原生通道，模型直接看见'
    : '不支持 image —— 粘图转成带本地路径的文本，模型用 vision_analyze 查看'))
  lines.push('· Swift 分析工具: ' + (env.swiftBin
    ? (env.swiftBin.cached ? '已编译（命中缓存）' : '已编译（本次新建）') + ' → ' + env.swiftBin.bin
    : '未就绪 —— ' + (env.swiftError || '未知错误')))
  lines.push('')
  if (!env.ollamaBinary) {
    lines.push('【待办】ollama 未安装：')
    if (env.brew) lines.push('  可自动安装（brew install ollama），或官网下载: https://ollama.com/download/mac')
    else lines.push('  未检测到 brew。可官网下载: https://ollama.com/download/mac；或用 vision_setup(auto=true) 尝试自动安装')
  } else if (!env.ollamaService) {
    lines.push('【待办】ollama 未运行：运行 `brew services start ollama` 或 `ollama serve`')
  }
  if (env.ollamaService && !env.modelReady) {
    lines.push('【待办】缺少推荐模型 ' + env.recommended + '：运行 `ollama pull ' + env.recommended + '`（约 ' + env.recommendedSizeGB + ' GB）')
  }
  if (!env.imageReady) {
    const names = (env.imageModels || []).map((m) => m.id + '（' + m.name + '）')
    if (names.length) {
      lines.push('【建议】想让模型直接「看见」图，把默认模型切到官方已声明 image 的其中一个：')
      for (const n of names) lines.push('  · ' + n)
      lines.push('  切换位置：设置 → 模型。本插件不会改写你的模型配置。')
    } else {
      lines.push('【提示】当前 provider 没有声明 image 的模型；粘图走文本桥接 + vision_analyze。')
    }
  }
  if (!env.swiftBin) lines.push('【待办】Swift 分析工具未就绪：' + (env.swiftError || '未知错误'))
  if (env.modelReady && env.swiftBin) lines.push('【状态】本地 OCR / 语义环境就绪，可直接使用 vision_analyze。')
  lines.push('')
  lines.push('一键安装（检测→安装 ollama→启动→拉取推荐模型）: vision_setup(auto=true)')
  return lines.join('\n')
}

async function setupAll(ctx, env) {
  const shell = ctx.get('shell')
  const run = async (command, timeoutMs = 300000) => {
    try {
      const res = await runShell(shell, { command, timeoutMs })
      return { exitCode: res.exitCode, out: String(res.out || '').trim(), err: String(res.err || '').trim() }
    } catch (e) {
      return { exitCode: -1, out: '', err: String((e && e.message) || e) }
    }
  }
  const steps = []

  if (!env.ollamaBinary) {
    steps.push('安装 ollama…')
    if (env.brew) {
      const r = await run('brew install ollama 2>&1 | tail -3', 600000)
      if (r.exitCode !== 0) return { ok: false, steps, error: 'brew 安装 ollama 失败: ' + (r.err || r.out) }
    } else {
      return { ok: false, steps, error: '未检测到 brew，请手动从 https://ollama.com/download/mac 安装 ollama' }
    }
    env.ollamaBinary = 'ollama'
  }

  if (!env.ollamaService) {
    steps.push('启动 ollama 服务…')
    let started = false
    if (env.brew) {
      const r = await run('brew services start ollama 2>&1 | tail -2', 60000)
      started = r.exitCode === 0
    }
    if (!started) await run('(nohup ollama serve > /tmp/ollama-serve.log 2>&1 &)', 10000)
    // 等待服务就绪（最多 15 秒）
    for (let i = 0; i < 15; i++) {
      const probe = await run('curl -s --max-time 2 http://127.0.0.1:11434/api/version || echo __UNREACHABLE__', 8000)
      if (probe.out && !probe.out.includes('__UNREACHABLE__') && !probe.out.includes('curl:')) {
        env.ollamaService = probe.out
        started = true
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!started) return { ok: false, steps, error: 'ollama 服务启动失败，请手动运行 ollama serve 查看日志' }
    steps.push('ollama 服务就绪')
  }

  if (!env.modelReady) {
    steps.push('拉取推荐模型 ' + env.recommended + '（约 ' + env.recommendedSizeGB + ' GB，耗时取决于网速）…')
    const r = await run('ollama pull ' + env.recommended, 1800000)
    if (r.exitCode !== 0) return { ok: false, steps, error: '模型拉取失败: ' + (r.err || r.out) }
    steps.push('模型拉取完成: ' + env.recommended)
  }

  // 预编译 Swift 分析工具（不阻塞：编译失败时调用会重试并回报具体错误）
  if (!env.swiftBin) {
    steps.push('预编译 Swift 分析工具…')
    const bin = await ensureBinary(shell)
    if (bin.ok) {
      env.swiftBin = bin
      steps.push('Swift 分析工具已就绪: ' + bin.bin)
    } else {
      steps.push('Swift 工具预编译未完成（调用 vision_analyze 时会重试）: ' + bin.error)
    }
  }

  return { ok: true, steps, recommended: env.recommended }
}

// ── 自动环境准备（安装即开箱即用：apply 时后台自动检测并补齐，用户零操作） ──
// state: idle | running | done | failed；Swift 工具编译失败单独记录，不阻塞整体就绪
const provision = { state: 'idle', steps: [], error: null, toolError: null, startedAt: null, finishedAt: null }

async function autoProvision(ctx) {
  if (provision.state === 'running' || provision.state === 'done') return provision
  provision.state = 'running'
  provision.startedAt = Date.now()
  provision.steps = []
  provision.error = null
  provision.toolError = null
  try {
    const env = await detectEnv(ctx)
    if (env.error) throw new Error(env.error)
    console.log('[zenk-vision] autoProvision: ollama=' + (env.ollamaBinary || '无') + ' svc=' + (env.ollamaService ? 'ok' : 'down') + ' model=' + (env.modelReady ? 'ok' : 'missing:' + env.recommended) + ' swift=' + (env.swiftBin ? 'ok' : 'missing') + ' upload=' + (env.imageReady ? 'native-image' : 'text-bridge'))
    const toolNote = env.swiftBin ? null : (env.swiftError || 'Swift 工具未就绪')
    // 快速路径：ollama + 模型 + Swift 工具都就绪
    if (env.ollamaBinary && env.ollamaService && env.modelReady && env.swiftBin) {
      provision.state = 'done'
      provision.toolError = toolNote
      provision.finishedAt = Date.now()
      return provision
    }
    // 慢路径：自动补齐（装 ollama → 起服务 → 拉模型 → 预编译 Swift 工具）
    const result = await setupAll(ctx, env)
    provision.steps = result.steps || []
    if (result.ok) {
      provision.state = 'done'
      provision.toolError = toolNote
    } else {
      provision.state = 'failed'
      provision.error = result.error || '未知错误'
      console.error('[zenk-vision] autoProvision failed: ' + provision.error)
    }
  } catch (e) {
    provision.state = 'failed'
    provision.error = String((e && e.message) || e)
    console.error('[zenk-vision] autoProvision error: ' + provision.error)
  }
  provision.finishedAt = Date.now()
  return provision
}

function provisionHint() {
  switch (provision.state) {
    case 'running': return '视觉环境自动准备中（' + (provision.steps.length ? provision.steps[provision.steps.length - 1] : '检测中…') + '）'
    case 'failed': return '视觉环境自动准备未完成：' + (provision.error || '未知错误') + '。可调用 vision_setup 查看详情'
    case 'done': return '视觉环境已就绪' + (provision.toolError ? '（' + provision.toolError + '）' : '')
    default: return '视觉环境准备中…'
  }
}

/**
 * 把 image block 换成「带本地路径的文本」，供纯文本通道使用。
 * 路径优先走官方 attachments.imageHostPath()，拿不到再退回按 sha256 拼路径。
 * @param block - 待替换的 image block。
 * @param attachments - 可选 attachments 服务。
 */
function imageToText(block, attachments) {
  const att = block.attachment || {}
  const id = String(att.attachmentId || '')
  let file = null
  if (attachments && typeof attachments.imageHostPath === 'function') {
    try {
      file = attachments.imageHostPath(att) || null
    } catch (e) {
      file = null
    }
  }
  if (!file) {
    const m = /^sha256:([a-f0-9]{64})$/.exec(id)
    if (m) file = path.join(attachmentRoot, 'objects', m[1].slice(0, 2), m[1])
  }
  const parts = ['用户上传了图片']
  if (att.name) parts.push('文件名 ' + att.name)
  if (att.width && att.height) parts.push(att.width + 'x' + att.height + 'px')
  if (att.mediaType) parts.push(att.mediaType)
  if (file) parts.push('本地文件 ' + file)
  if (!file) parts.push('attachmentId ' + id)
  parts.push('可用 vision_analyze 工具(file_path=本地文件路径, describe=true)查看图片内容')
  return { type: 'text', text: '[' + parts.join('；') + ']' }
}

export function apply(ctx) {
  // ── 安装即开箱即用：后台自动检测并补齐视觉环境（ollama/模型/patch），用户零操作 ──
  ctx.effect(() => {
    autoProvision(ctx)
    return () => {}
  }, 'zenk-vision: auto provision')

  // ── 上传图片桥接：按当前路由的真实图片能力决定是否接管 ──
  // 模型自己支持 image → 原样放行。harness 会把真图作为 image_url 发出，并附带
  //   归一化只读路径（dsh-llm 的 requestImageHandleText），模型直接看得见图；
  //   vision_analyze 退居「像素级工具」：需要 OCR 文本、像素坐标、区域框时才用。
  // 模型是纯文本通道 → 官方降级占位是
  //   "[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]"，
  //   模型拿不回图；这里换成带本地路径的文本，模型据此调用 vision_analyze。
  // routeCache 缓存能力结论，供下面的 read_image guard 同步读取。
  let routeCache = { known: false, acceptsImages: false }
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const route = await resolveRoute(ctx)
    routeCache = route
    if (route.known && route.acceptsImages) return decision
    const attachments = ctx.get('attachments')
    const transformed = decision.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg
      let changed = false
      const content = msg.content.map((block) => {
        if (!block || block.type !== 'image') return block
        changed = true
        return imageToText(block, attachments)
      })
      return changed ? Object.assign({}, msg, { content }) : msg
    })
    return Object.assign({}, decision, { messages: transformed })
  })

  // read_image 会产出 image block：纯文本通道携带不了才禁止；支持 image 时放开
  ctx.effect(() => {
    const d = ctx.tools.guard((exec) => {
      if (!exec || exec.name !== 'read_image') return undefined
      if (routeCache.known && routeCache.acceptsImages) return undefined
      return 'read_image 会产生模型通道不支持的图片内容；请改用 vision_analyze 工具分析图片'
    })
    return () => d()
  }, 'zenk-vision: read_image guard')

  // ── vision_setup 诊断工具（自动安装失败时的排查入口；正常情况下无需调用） ──
  ctx.effect(() => {
    const textOut = (schema) => ({ schema, render: (_a, v) => [{ type: 'text', text: v }] })
    const d = ctx.tools.register({
      name: 'vision_setup',
      description: '查看本地视觉环境状态（安装插件后环境会在后台自动准备，通常无需调用本工具）。输出检测报告（当前模型的图片能力、ollama 程序/服务、已拉取模型、内存、磁盘、Swift 工具状态）与推荐模型；auto=true 时重新执行自动安装（安装 ollama→启动服务→拉取推荐模型→预编译 Swift 工具）。',
      parameters: {
        type: 'object',
        properties: {
          auto: { type: 'boolean', description: '设为 true 时重新执行自动安装（自动安装失败或需手动触发时使用），耗时可长达数分钟' },
        },
        additionalProperties: false,
      },
      // 策略元数据：auto=true 含 brew 安装与模型拉取，预算放宽
      timeoutMs: 1800000,
      // auto=true 会写 cache 目录并可能安装软件，不声明并发安全（保持独占）
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.auto ? 'vision_setup（一键安装）' : 'vision_setup（环境检测）',
        kind: 'search',
      }),
      output: textOut({ type: 'string' }),
      execute: async (args, _exec) => {
        const env = await detectEnv(ctx)
        if (env.error) return 'error: ' + env.error
        if (args && args.auto) {
          const result = await setupAll(ctx, env)
          if (!result.ok) return '【自动安装未完成】\n' + result.steps.map((s) => '· ' + s).join('\n') + '\n失败: ' + result.error
          const fresh = await detectEnv(ctx)
          return '【自动安装完成】\n' + result.steps.map((s) => '· ' + s).join('\n') + '\n\n' + formatEnv(fresh)
        }
        return formatEnv(env)
      },
    })
    return () => d()
  }, 'zenk-vision: setup tool')

  // ── vision_analyze 工具 ──
  ctx.effect(() => {
    const textOut = (schema) => ({ schema, render: (_a, v) => [{ type: 'text', text: v }] })
    const d = ctx.tools.register({
      name: 'vision_analyze',
      description: '用 macOS Vision 分析本地图片：返回图片尺寸、全部 OCR 文本（含像素坐标）。可选 describe 调用 ollama 本地视觉模型（qwen3-vl）做语义描述，用于定位 UI 截图中的问题区域。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '图片绝对路径（PNG/JPG 等）' },
          describe: { type: 'boolean', description: '设为 true 时额外调用 ollama 视觉模型输出语义描述（较慢）' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      // 策略元数据：swift 分析含冷启动与 ollama 推理，给足预算（与 shell deadline 一致）
      timeoutMs: 200000,
      // 只读分析，无共享状态：允许与其它并发安全工具并行分发
      isConcurrencySafe: (args) => typeof (args && args.file_path) === 'string',
      // UI 卡片：标注图片文件位置，让有能力的编辑器可跟随/跳转；纯函数，不做 I/O
      presentCall: (args) => ({
        card: 'generic',
        title: 'vision_analyze ' + String((args && args.file_path) || ''),
        kind: 'read',
        locations: args && args.file_path ? [{ path: String(args.file_path) }] : undefined,
      }),
      output: textOut({ type: 'string' }),
      execute: async (args, exec) => {
        const shell = ctx.get('shell')
        if (!shell) return 'error: shell 服务不可用'
        const file = args && args.file_path
        if (!file) return 'error: 缺少 file_path'
        const quoted = String(file).replace(/'/g, "'\\''")
        // 环境未就绪时自动降级：describe 依赖 ollama 视觉模型，OCR 不依赖——先给 OCR，环境好了自动全功能
        // 注意：patch 状态只影响"上传图片预检"，与本地文件分析无关，不参与降级判断
        let wantDescribe = args && args.describe
        let degradeNote = ''
        if (wantDescribe) {
          const env = await detectEnv(ctx)
          if (env.error) degradeNote = '；语义描述暂不可用（' + env.error + '）'
          else if (!env.ollamaService) degradeNote = '；语义描述暂不可用（ollama 服务未就绪——' + provisionHint() + '）'
          else if (!env.anyVisionModel) degradeNote = '；语义描述暂不可用（视觉模型未就绪——' + provisionHint() + '）'
          if (degradeNote) wantDescribe = false
        }
        const mode = wantDescribe ? ' describe' : ''
        try {
          const bin = await ensureBinary(shell)
          if (!bin.ok) return 'error: ' + bin.error
          const res = await runShell(shell, {
            command: shq(bin.bin) + ' ' + shq(quoted) + mode,
            timeoutMs: 180000,
          })
          if (res.exitCode !== 0) {
            return 'error: ' + String(res.err || res.out || '视觉分析失败').slice(0, 2000)
          }
          return (String(res.out || '').slice(0, 12000)) + (degradeNote ? '\n\n【提示】' + degradeNote : '')
        } catch (e) {
          return 'error: ' + String((e && e.message) || e)
        }
      },
    })
    return () => d()
  }, 'zenk-vision: tool')
}
