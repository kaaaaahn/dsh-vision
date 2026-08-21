// @zenk/vision — DSH 本地视觉能力
// 1) vision_analyze 模型工具：macOS Vision OCR（文字+像素坐标）+ ollama qwen3-vl 语义描述
// 2) 上传图片桥接：agent/pre-step 把消息里的图片块转成带本地路径的文本说明，
//    让 text-only 模型通道（DeepSeek chat-completions）不会因图片块拒绝请求，
//    同时模型能在文本里看到图片路径并调用 vision_analyze 分析
// 3) read_image guard：该工具会产生模型通道不支持的图片内容，禁止调用
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'zenk-vision'
export const inject = ['tools']

const scriptPath = fileURLToPath(new URL('./vision_analyze.swift', import.meta.url))
const attachmentRoot = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '/Users/USERNAME', '.dsh'), 'attachments', 'v1')

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
