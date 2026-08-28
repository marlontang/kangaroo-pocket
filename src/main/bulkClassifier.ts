import type { Db } from './db'
import { chat, LlmError, type ChatMessage, type LlmConfig } from './llm'
import { extractJsonObject } from './json'
import type { Category, Message } from '../shared/types'

/**
 * 批量分类管线：全量重跑时用，一次调用处理一批，把 200 条的调用次数从 200 降到 20。
 *
 * 日常逐条发送仍走 classifier.ts 的单条管线 —— 那里延迟敏感，一次只有一条，
 * 攒批毫无意义。两条管线共用 db.applyClassification 写回。
 */

const BATCH_SIZE = 10
const MAX_CHARS_PER_MESSAGE = 500
const BATCH_TIMEOUT_MS = 120_000
const RETRY_DELAYS = [2_000, 8_000]

export interface BulkDeps {
  db: Db
  getConfig: () => LlmConfig & { secretaryPrompt: string }
  onUpdate: (message: Message) => void
  /** 批内失配的条目回退到单条管线重跑 */
  enqueueSingle: (messageId: number) => void
  chatFn?: typeof chat
  sleepFn?: (ms: number) => Promise<void>
}

export interface BulkProgress {
  total: number
  done: number
}

/** 组装一批的 user prompt —— 纯函数，便于测试 */
export function buildBatchPrompt(categories: Category[], messages: Message[]): string {
  const cats = categories
    .map((c) => `- ${c.name}${c.description ? `：${c.description}` : ''}`)
    .join('\n')
  const items = messages
    .map((m, i) => `${i + 1}. 「${m.content.slice(0, MAX_CHARS_PER_MESSAGE).replace(/\n/g, ' ')}」`)
    .join('\n')

  return `可选分类（名称：说明）：
${cats}

待分类的信息列表（共 ${messages.length} 条）：
${items}

只输出 JSON：{"results":[{"id":1,"category":"<分类名>"}]}
- id 对应上面的编号，每一条都必须给出结果
- category 必须与候选分类完全一致；没有匹配的用 "unknown"
- 不要输出解释，不要用 markdown 代码块`
}

/**
 * 解析一批的返回，得到「编号 → 分类名」。
 * 编号越界、分类名不合法、缺失的条目都不会出现在结果里，
 * 由调用方回退到单条管线，不会静默当成 unknown。
 */
export function parseBatchResults(
  raw: string,
  batchSize: number,
  validNames: string[]
): Map<number, string | null> {
  const out = new Map<number, string | null>()
  const parsed = extractJsonObject(raw) as { results?: unknown } | null
  if (!parsed || !Array.isArray(parsed.results)) return out

  for (const item of parsed.results) {
    const id = Number((item as { id?: unknown })?.id)
    const name = String((item as { category?: unknown })?.category ?? '').trim()
    if (!Number.isInteger(id) || id < 1 || id > batchSize) continue
    if (out.has(id)) continue // 重复编号以第一个为准
    if (!name || name === 'unknown') {
      out.set(id, null)
    } else if (validNames.includes(name)) {
      out.set(id, name)
    }
    // 分类名不合法 → 不写入，交给调用方回退单条重跑
  }
  return out
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createBulkClassifier(deps: BulkDeps) {
  const { db, getConfig, onUpdate, enqueueSingle } = deps
  const chatFn = deps.chatFn ?? chat
  const sleep = deps.sleepFn ?? defaultSleep

  let running = false

  function finish(id: number, categoryId: number | null, error?: string): void {
    // 批量执行期间用户可能手动指定了分类，别覆盖 —— 单条管线也有同样的检查
    const current = db.getMessage(id)
    if (!current || current.status !== 'pending') return
    const updated = db.applyClassification(id, categoryId, error)
    if (updated) onUpdate(updated)
  }

  async function runBatch(batch: Message[], categories: Category[]): Promise<void> {
    const config = getConfig()
    const messages: ChatMessage[] = [
      { role: 'system', content: config.secretaryPrompt },
      { role: 'user', content: buildBatchPrompt(categories, batch) }
    ]
    const validNames = categories.map((c) => c.name)

    let lastError = ''
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const reply = await chatFn(config, messages, { timeoutMs: BATCH_TIMEOUT_MS })
        const results = parseBatchResults(reply, batch.length, validNames)

        batch.forEach((m, i) => {
          const idx = i + 1
          if (!results.has(idx)) {
            // 这一条没拿到可用结果 —— 回退单条管线重跑，而不是直接判未分类
            enqueueSingle(m.id)
            return
          }
          const name = results.get(idx)!
          if (name === null) {
            finish(m.id, null, '没有匹配的分类')
          } else {
            finish(m.id, categories.find((c) => c.name === name)!.id)
          }
        })
        return
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        const retryable = e instanceof LlmError ? e.retryable : true
        if (!retryable || attempt === RETRY_DELAYS.length) break
        await sleep(RETRY_DELAYS[attempt])
      }
    }

    // 整批都没成功：逐条退回单条管线，让它们各自走重试与错误记录
    for (const m of batch) enqueueSingle(m.id)
    if (lastError) console.error('[bulk] 批次失败，已退回单条管线：', lastError)
  }

  /**
   * 按 id 快照批量分类。快照在调用前取好，
   * 期间用户新发的消息由单条管线处理，两边不会撞车。
   */
  async function run(ids: number[], onProgress?: (p: BulkProgress) => void): Promise<void> {
    if (running) throw new Error('已有一个批量分类在进行中')
    running = true
    try {
      const categories = db.listClassifiableCategories()
      if (categories.length === 0) {
        for (const id of ids) finish(id, null, '还没有创建任何分类')
        return
      }

      let done = 0
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids
          .slice(i, i + BATCH_SIZE)
          .map((id) => db.getMessage(id))
          .filter((m): m is Message => m !== null && m.status === 'pending')

        if (batch.length > 0) await runBatch(batch, categories)
        done += BATCH_SIZE
        onProgress?.({ total: ids.length, done: Math.min(done, ids.length) })
      }
    } finally {
      running = false
    }
  }

  return {
    run,
    get isRunning() {
      return running
    },
    BATCH_SIZE
  }
}

export type BulkClassifier = ReturnType<typeof createBulkClassifier>
export { BATCH_SIZE }
