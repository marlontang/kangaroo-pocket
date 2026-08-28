import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createDb, type Db } from '../src/main/db'
import { buildUserPrompt, createClassifier, parseCategoryName } from '../src/main/classifier'
import { LlmError } from '../src/main/llm'
import type { Message } from '../src/shared/types'

describe('parseCategoryName', () => {
  const valid = ['生活', '工作', '项目A']

  it('解析标准 JSON', () => {
    expect(parseCategoryName('{"category":"生活"}', valid)).toBe('生活')
  })

  it('容忍 markdown 代码块与多余文字', () => {
    expect(parseCategoryName('```json\n{"category": "工作"}\n```', valid)).toBe('工作')
    expect(parseCategoryName('好的，结果是 {"category":"项目A"} 。', valid)).toBe('项目A')
  })

  it('unknown 归为无法分类', () => {
    expect(parseCategoryName('{"category":"unknown"}', valid)).toBeNull()
  })

  it('模型自创的分类名不被接受', () => {
    expect(parseCategoryName('{"category":"娱乐"}', valid)).toBeNull()
  })

  it('非 JSON 或格式异常返回 null', () => {
    expect(parseCategoryName('生活', valid)).toBeNull()
    expect(parseCategoryName('{"category": 123}', valid)).toBeNull()
    expect(parseCategoryName('{坏的json}', valid)).toBeNull()
    expect(parseCategoryName('', valid)).toBeNull()
  })
})

describe('buildUserPrompt', () => {
  it('列出分类名与说明，并原样嵌入消息内容', () => {
    const prompt = buildUserPrompt(
      [
        { id: 1, name: '生活', emoji: '🏠', description: '购物健康', sortOrder: 1, createdAt: 0, isSystem: false },
        { id: 2, name: '工作', emoji: '💼', description: '', sortOrder: 2, createdAt: 0, isSystem: false }
      ],
      '买牛奶'
    )
    expect(prompt).toContain('- 生活：购物健康')
    expect(prompt).toContain('- 工作')
    expect(prompt).toContain('买牛奶')
  })
})

describe('分类队列', () => {
  let db: Db
  let updates: Message[]

  const makeClassifier = (chatFn: (...args: never[]) => Promise<string>) =>
    createClassifier({
      db,
      getConfig: () => ({
        baseUrl: 'http://x/v1',
        apiKey: 'k',
        model: 'm',
        secretaryPrompt: 'p'
      }),
      onUpdate: (m) => updates.push(m),
      chatFn: chatFn as never,
      sleepFn: () => Promise.resolve() // 测试中不真的等待重试间隔
    })

  /** 队列是异步的，让出事件循环直到它排空 */
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
  }

  beforeEach(() => {
    db = createDb(':memory:')
    db.seedIfEmpty()
    updates = []
  })

  it('分类成功后消息落到对应分类', async () => {
    const c = makeClassifier(async () => '{"category":"生活"}')
    const m = db.insertMessage('买牛奶')
    c.enqueue(m.id)
    await flush()

    const after = db.getMessage(m.id)!
    expect(after.status).toBe('classified')
    expect(db.getCategory(after.categoryId!)?.name).toBe('生活')
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe(m.id)
  })

  it('无匹配分类时标记 failed 并记录原因，内容不丢', async () => {
    const c = makeClassifier(async () => '{"category":"unknown"}')
    const m = db.insertMessage('嗯')
    c.enqueue(m.id)
    await flush()

    const after = db.getMessage(m.id)!
    expect(after.status).toBe('failed')
    expect(after.content).toBe('嗯')
    expect(after.error).toBe('没有匹配的分类')
  })

  it('网络错误重试 2 次后放弃，消息保留为未分类', async () => {
    const chatFn = vi.fn(async () => {
      throw new LlmError('网络错误：fetch failed', true)
    })
    const c = makeClassifier(chatFn)
    const m = db.insertMessage('断网时发的消息')
    c.enqueue(m.id)
    await flush()

    expect(chatFn).toHaveBeenCalledTimes(3) // 首次 + 2 次重试
    const after = db.getMessage(m.id)!
    expect(after.status).toBe('failed')
    expect(after.content).toBe('断网时发的消息')
    expect(after.error).toContain('网络错误')
  })

  it('不可重试的错误（如 Key 无效）立即失败，不浪费重试', async () => {
    const chatFn = vi.fn(async () => {
      throw new LlmError('接口返回 401：invalid api key', false)
    })
    const c = makeClassifier(chatFn)
    const m = db.insertMessage('a')
    c.enqueue(m.id)
    await flush()

    expect(chatFn).toHaveBeenCalledTimes(1)
    expect(db.getMessage(m.id)!.error).toContain('401')
  })

  it('重试后成功', async () => {
    let n = 0
    const c = makeClassifier(async () => {
      if (++n === 1) throw new LlmError('网络错误', true)
      return '{"category":"工作"}'
    })
    const m = db.insertMessage('写周报')
    c.enqueue(m.id)
    await flush()

    expect(db.getMessage(m.id)!.status).toBe('classified')
  })

  it('没有任何分类时直接失败，不调用模型', async () => {
    const fresh = createDb(':memory:') // 不 seed
    const chatFn = vi.fn(async () => '{"category":"x"}')
    const c = createClassifier({
      db: fresh,
      getConfig: () => ({ baseUrl: 'u', apiKey: 'k', model: 'm', secretaryPrompt: 'p' }),
      onUpdate: (m) => updates.push(m),
      chatFn: chatFn as never,
      sleepFn: () => Promise.resolve()
    })
    const m = fresh.insertMessage('a')
    c.enqueue(m.id)
    await flush()

    expect(chatFn).not.toHaveBeenCalled()
    expect(fresh.getMessage(m.id)!.error).toBe('还没有创建任何分类')
  })

  it('排队期间被手动分类的消息不会被 AI 覆盖', async () => {
    const work = db.listCategories().find((c) => c.name === '工作')!
    const c = makeClassifier(async () => '{"category":"生活"}')
    const m = db.insertMessage('买牛奶')
    db.moveMessage(m.id, work.id) // 用户抢先手动指定
    c.enqueue(m.id)
    await flush()

    const after = db.getMessage(m.id)!
    expect(after.status).toBe('manual')
    expect(after.categoryId).toBe(work.id)
  })

  it('单条消息失败不会中断队列后续消息', async () => {
    let n = 0
    const c = makeClassifier(async () => {
      if (++n === 1) throw new LlmError('接口返回 400：bad request', false)
      return '{"category":"生活"}'
    })
    const m1 = db.insertMessage('第一条')
    const m2 = db.insertMessage('第二条')
    c.enqueue(m1.id)
    c.enqueue(m2.id)
    await flush()

    expect(db.getMessage(m1.id)!.status).toBe('failed')
    expect(db.getMessage(m2.id)!.status).toBe('classified')
  })

  it('未知异常按可重试处理（保守策略，避免因偶发错误丢分类）', async () => {
    let n = 0
    const c = makeClassifier(async () => {
      if (++n === 1) throw new Error('意料之外的崩溃')
      return '{"category":"生活"}'
    })
    const m = db.insertMessage('第一条')
    c.enqueue(m.id)
    await flush()

    expect(n).toBe(2)
    expect(db.getMessage(m.id)!.status).toBe('classified')
  })

  it('启动时回捞遗留的 pending 消息', async () => {
    const m1 = db.insertMessage('上次没处理完的')
    const m2 = db.insertMessage('另一条')
    db.applyClassification(m2.id, db.listCategories()[0].id) // 已处理过的不应重跑

    const chatFn = vi.fn(async () => '{"category":"生活"}')
    const c = makeClassifier(chatFn)
    c.resumePending()
    await flush()

    expect(chatFn).toHaveBeenCalledTimes(1)
    expect(db.getMessage(m1.id)!.status).toBe('classified')
  })
})
