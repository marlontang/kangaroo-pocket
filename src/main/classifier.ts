import type { Db } from './db'
import { chat, LlmError, type ChatMessage, type LlmConfig } from './llm'
import type { Category, Message } from '../shared/types'

/** 失败重试间隔（毫秒）；数组长度即重试次数 */
const RETRY_DELAYS = [2_000, 8_000]

const UNKNOWN = 'unknown'

export interface ClassifierDeps {
  db: Db
  /** 每次分类时实时读取，保证用户改完设置立刻生效 */
  getConfig: () => LlmConfig & { secretaryPrompt: string }
  onUpdate: (message: Message) => void
  /** 可注入，便于测试 */
  chatFn?: typeof chat
  sleepFn?: (ms: number) => Promise<void>
}

/** 组装发给模型的用户消息 —— 纯函数，便于测试 */
export function buildUserPrompt(categories: Category[], content: string): string {
  const list = categories
    .map((c) => `- ${c.name}${c.description ? `：${c.description}` : ''}`)
    .join('\n')
  return `可选分类（名称：说明）：
${list}

待分类的信息：
"""
${content}
"""`
}

/**
 * 从模型回复中提取分类名。
 * 容错：模型可能包裹 markdown 代码块或附带多余文字，取第一个 JSON 对象。
 * 返回 null 表示无法归类（含显式 unknown 与不合法分类名）。
 */
export function parseCategoryName(raw: string, validNames: string[]): string | null {
  const match = raw.match(/\{[^{}]*\}/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  const name = (parsed as { category?: unknown })?.category
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed === UNKNOWN) return null
  // 必须精确命中现有分类，避免模型自创分类名
  return validNames.includes(trimmed) ? trimmed : null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 串行分类队列。
 *
 * 核心保证：消息落库与分类完全解耦 —— 队列出任何问题都不影响消息已被保存。
 * 失败的消息标记为 failed 并记录原因，用户可随时手动重试或直接指定分类。
 */
export function createClassifier(deps: ClassifierDeps) {
  const { db, getConfig, onUpdate } = deps
  const chatFn = deps.chatFn ?? chat
  const sleep = deps.sleepFn ?? defaultSleep

  const queue: number[] = []
  let running = false

  function enqueue(messageId: number): void {
    if (!queue.includes(messageId)) queue.push(messageId)
    // 推迟到下一轮事件循环再启动队列。drain() 在首个 await 之前有同步代码
    // （读配置会解密钥匙串里的 API Key，偶尔要几百毫秒），直接调用会拖慢
    // sendMessage 的 IPC 响应，让「消息立即出现」这个承诺打折扣。
    setImmediate(() => void drain())
  }

  /** 启动时回捞上次退出遗留的 pending 消息 */
  function resumePending(): void {
    for (const m of db.listPendingMessages()) enqueue(m.id)
  }

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const id = queue.shift()!
        try {
          await classifyOne(id)
        } catch (e) {
          // classifyOne 内部已处理所有可预期错误；这里兜底，防止一条消息拖垮整个队列
          finish(id, null, `分类异常：${(e as Error).message}`)
        }
      }
    } finally {
      running = false
    }
  }

  function finish(id: number, categoryId: number | null, error?: string): void {
    const updated = db.applyClassification(id, categoryId, error)
    if (updated) onUpdate(updated)
  }

  async function classifyOne(id: number): Promise<void> {
    const message = db.getMessage(id)
    // 消息可能已被删除，或用户在排队期间手动指定了分类 —— 都不应再覆盖
    if (!message || message.status !== 'pending') return

    // 只用非系统分类做候选：「文件」只接收图片，不该收文字
    const categories = db.listClassifiableCategories()
    if (categories.length === 0) {
      finish(id, null, '还没有创建任何分类')
      return
    }

    const config = getConfig()
    const messages: ChatMessage[] = [
      { role: 'system', content: config.secretaryPrompt },
      { role: 'user', content: buildUserPrompt(categories, message.content) }
    ]

    let lastError = ''
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const reply = await chatFn(config, messages)
        const name = parseCategoryName(
          reply,
          categories.map((c) => c.name)
        )
        if (name === null) {
          finish(id, null, '没有匹配的分类')
          return
        }
        finish(id, categories.find((c) => c.name === name)!.id)
        return
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        const retryable = e instanceof LlmError ? e.retryable : true
        if (!retryable || attempt === RETRY_DELAYS.length) break
        await sleep(RETRY_DELAYS[attempt])
        // 重试期间消息可能已被删除或手动分类
        const still = db.getMessage(id)
        if (!still || still.status !== 'pending') return
      }
    }
    finish(id, null, lastError)
  }

  return {
    enqueue,
    resumePending,
    get pendingCount() {
      return queue.length
    }
  }
}

export type Classifier = ReturnType<typeof createClassifier>
