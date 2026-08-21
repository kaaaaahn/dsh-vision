// @zenk/vision — DSH 本地视觉能力
// 1) vision_analyze 模型工具：macOS Vision OCR（文字+像素坐标）+ ollama qwen3-vl 语义描述
// 2) vision_setup 环境工具：检测 ollama/模型/内存/磁盘，按性能推荐模型，可一键安装
// 3) 上传图片桥接：agent/pre-step 把消息里的图片块转成带本地路径的文本说明，
//    让 text-only 模型通道（DeepSeek chat-completions）不会因图片块拒绝请求，
//    同时模型能在文本里看到图片路径并调用 vision_analyze 分析
// 4) read_image guard：该工具会产生模型通道不支持的图片内容，禁止调用
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promises as fsp } from 'node:fs'

export const name = 'zenk-vision'
export const inject = ['tools']

const scriptPath = fileURLToPath(new URL('./vision_analyze.swift', import.meta.url))
const attachmentRoot = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '/Users/USERNAME', '.dsh'), 'attachments', 'v1')

// DeepSeek 适配器文件位置（部署级 patch 目标；DSH 升级会覆盖，需要时可重打）
function deepseekAdapterFile() {
  const base = process.resourcesPath || (process.execPath && path.dirname(path.dirname(process.execPath)) + '/Resources') || ''
  return path.join(base, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js')
}

// 模型能力 patch：inputModalities 声明 image，上传预检才会放行图片
async function applyModelPatch() {
  try {
    const file = deepseekAdapterFile()
    const text = await fsp.readFile(file, 'utf8')
    if (text.includes('inputModalities: ["text", "image"]')) return { ok: true, already: true }
    if (!text.includes('inputModalities: ["text"]')) return { ok: false, error: '未找到 inputModalities 声明（DSH 版本结构可能已变化）' }
    const next = text.split('inputModalities: ["text"]').join('inputModalities: ["text", "image"]')
    await fsp.writeFile(file, next, 'utf8')
    return { ok: true, already: false }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
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
      const res = await shell.run(shell.resolve({ command, timeoutMs: 15000 }))
      const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text.trim() : ''
      return { exitCode: res.exitCode, out }
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

  // 模型能力 patch 状态（上传图片预检依赖它）
  const patchProbe = await run('grep -c \'inputModalities: \\["text", "image"\\]\' "' + deepseekAdapterFile().replace(/"/g, '\\"') + '" || echo 0')
  env.modelPatch = parseInt(patchProbe.out, 10) > 0
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
  lines.push('· 模型能力 patch: ' + (env.modelPatch ? '已生效' : '未生效（上传图片会被拒绝）'))
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
  if (!env.modelPatch) {
    lines.push('【待办】模型能力 patch 未生效：vision_setup(auto=true) 会自动补打（DSH 升级后需重打）')
  }
  if (env.modelReady && env.modelPatch) lines.push('【状态】环境就绪，可直接使用 vision_analyze。')
  lines.push('')
  lines.push('一键安装（检测→安装 ollama→启动→拉取推荐模型）: vision_setup(auto=true)')
  return lines.join('\n')
}

async function setupAll(ctx, env) {
  const shell = ctx.get('shell')
  const run = async (command, timeoutMs = 300000) => {
    try {
      const res = await shell.run(shell.resolve({ command, timeoutMs }))
      const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text.trim() : ''
      const err = res && res.stderr && typeof res.stderr.text === 'string' ? res.stderr.text.trim() : ''
      return { exitCode: res.exitCode, out, err }
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

  if (!env.modelPatch) {
    steps.push('补打模型能力 patch（inputModalities 声明 image）…')
    const p = await applyModelPatch()
    if (!p.ok) return { ok: false, steps, error: '模型能力 patch 失败: ' + p.error }
    steps.push('模型能力 patch 已' + (p.already ? '存在' : '生效') + '（重启 DSH 后完全生效）')
  }

  return { ok: true, steps, recommended: env.recommended }
}

function imageToText(block) {
  const att = block.attachment || {}
  const id = String(att.attachmentId || '')
  const m = /^sha256:([a-f0-9]{64})$/.exec(id)
  const file = m ? path.join(attachmentRoot, 'objects', m[1].slice(0, 2), m[1]) : null
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
  // ── 上传图片桥接：在消息进入会话历史之前（agent/pre-step）转换 ──
  // 决策消息在 append 进会话历史前被替换，历史始终是纯文本，text-only 适配器不会崩
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const transformed = decision.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg
      let changed = false
      const content = msg.content.map((block) => {
        if (!block || block.type !== 'image') return block
        changed = true
        return imageToText(block)
      })
      return changed ? Object.assign({}, msg, { content }) : msg
    })
    return Object.assign({}, decision, { messages: transformed })
  })

  // read_image 会产生 image block 进入会话历史，而 text-only 通道无法携带——
  // 禁止模型调用，统一走 vision_analyze
  ctx.effect(() => {
    const d = ctx.tools.guard((exec) => exec && exec.name === 'read_image' ? 'read_image 会产生模型通道不支持的图片内容；请改用 vision_analyze 工具分析图片' : undefined)
    return () => d()
  }, 'zenk-vision: read_image guard')

  // ── vision_setup 环境工具：检测 + 一键安装 ──
  ctx.effect(() => {
    const textOut = (schema) => ({ schema, render: (_a, v) => [{ type: 'text', text: v }] })
    const d = ctx.tools.register({
      name: 'vision_setup',
      description: '检测并配置本地视觉环境（ollama + 视觉模型）。无参数时输出检测报告（ollama 程序/服务、已拉取模型、内存、磁盘）并按机器性能推荐模型；auto=true 时自动完成：安装 ollama（需 brew）→ 启动服务 → 拉取推荐模型。首次使用前调用一次。',
      parameters: {
        type: 'object',
        properties: {
          auto: { type: 'boolean', description: '设为 true 时执行一键安装（检测→安装 ollama→启动→拉取推荐模型），耗时可长达数分钟' },
        },
        additionalProperties: false,
      },
      output: textOut({ type: 'string' }),
      execute: async (args, _exec) => {
        const env = await detectEnv(ctx)
        if (env.error) return 'error: ' + env.error
        if (args && args.auto) {
          const result = await setupAll(ctx, env)
          if (!result.ok) return '【一键安装未完成】\n' + result.steps.map((s) => '· ' + s).join('\n') + '\n失败: ' + result.error
          const fresh = await detectEnv(ctx)
          return '【一键安装完成】\n' + result.steps.map((s) => '· ' + s).join('\n') + '\n\n' + formatEnv(fresh)
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
      output: textOut({ type: 'string' }),
      execute: async (args, exec) => {
        const shell = ctx.get('shell')
        if (!shell) return 'error: shell 服务不可用'
        const file = args && args.file_path
        if (!file) return 'error: 缺少 file_path'
        const quoted = String(file).replace(/'/g, "'\\''")
        const mode = args && args.describe ? ' describe' : ''
        try {
          const res = await shell.run(shell.resolve({
            command: 'swift \'' + scriptPath + '\' \'' + quoted + '\'' + mode,
            timeoutMs: 180000,
          }))
          const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : ''
          const err = res && res.stderr && typeof res.stderr.text === 'string' ? res.stderr.text : ''
          if (res.exitCode !== 0) return 'error: ' + String(err || out || '视觉分析失败').slice(0, 2000)
          return out.slice(0, 12000)
        } catch (e) {
          return 'error: ' + String((e && e.message) || e)
        }
      },
    })
    return () => d()
  }, 'zenk-vision: tool')
}
