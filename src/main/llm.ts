import type { TestConnectionResult } from '../shared/types'

const DEFAULT_TIMEOUT_MS = 30_000

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 用户可能填 `.../v1`，也可能直接粘贴 `.../v1/chat/completions`。
 * 两种都接受，统一归一到完整的 chat/completions 地址。
 */
export function resolveChatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 Base URL')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

export class LlmError extends Error {
  /** true 表示网络/限流/服务端错误，值得重试；false 表示配置或请求本身有问题 */
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'LlmError'
    this.retryable = retryable
  }
}

export interface ChatOptions {
  /** 归纳/批量这类长任务需要更久，默认 30 秒 */
  timeoutMs?: number
  /** 分类要确定性所以默认 0；归纳类任务可以给一点发散 */
  temperature?: number
}

/** 调用 OpenAI 兼容的 chat/completions，返回助手回复文本 */
export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  if (!config.apiKey) throw new LlmError('未配置 API Key，请到「小袋鼠」中填写', false)

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(resolveChatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: opts.temperature ?? 0,
        // qwen3 系列默认开启思考模式，会返回 reasoning_content 并显著增加延迟。
        // 分类是确定性的短任务，关掉思考更快更省。非 qwen3 模型会忽略该字段。
        enable_thinking: false
      }),
      signal: controller.signal
    })
  } catch (e) {
    const msg =
      (e as Error).name === 'AbortError'
        ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `网络错误：${(e as Error).message}`
    throw new LlmError(msg, true)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const detail = extractErrorMessage(body) || body.slice(0, 200)
    // 4xx 多为 Key / 模型名 / 参数问题，重试无意义；429 和 5xx 值得重试
    const retryable = res.status === 429 || res.status >= 500
    throw new LlmError(`接口返回 ${res.status}：${detail || '无详情'}`, retryable)
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
  } | null
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new LlmError('接口返回格式异常，未取到回复内容', true)
  return content
}

function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body)
    return j?.error?.message ?? j?.message ?? ''
  } catch {
    return ''
  }
}

export async function testConnection(config: LlmConfig): Promise<TestConnectionResult> {
  try {
    const reply = await chat(config, [{ role: 'user', content: '只回复两个字：可用' }])
    return { ok: true, reply: reply.trim().slice(0, 50) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
