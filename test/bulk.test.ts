import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createDb, type Db } from '../src/main/db'
import { buildBatchPrompt, createBulkClassifier, parseBatchResults } from '../src/main/bulkClassifier'
import { LlmError } from '../src/main/llm'
import type { Category, Message } from '../src/shared/types'

const cat = (id: number, name: string, description = ''): Category => ({
  id,
  name,
  emoji: '',
  description,
  sortOrder: id,
  createdAt: 0,
  isSystem: false
})

describe('buildBatchPrompt', () => {
  it('列出候选分类与编号消息，并要求批量 JSON 输出', () => {
    const p = buildBatchPrompt(
      [cat(1, '生活', '购物健康'), cat(2, '工作')],
      [{ content: '买牛奶' }, { content: '写周报' }] as Message[]
    )
    expect(p).toContain('- 生活：购物健康')
    expect(p).toContain('1. 「买牛奶」')
    expect(p).toContain('2. 「写周报」')
    expect(p).toContain('"results"')
    expect(p).toContain('共 2 条')
  })

  it('超长消息被截断，换行被压平', () => {
    const p = buildBatchPrompt([cat(1, 'x')], [{ content: 'a'.repeat(900) + '\nB' }] as Message[])
    expect(p).not.toContain('\nB')
    expect(p).toContain('a'.repeat(500))
    expect(p).not.toContain('a'.repeat(501))
  })
})

describe('parseBatchResults', () => {
  const valid = ['生活', '工作']

  it('解析正常返回', () => {
    const r = parseBatchResults('{"results":[{"id":1,"category":"生活"},{"id":2,"category":"工作"}]}', 2, valid)
    expect(r.get(1)).toBe('生活')
    expect(r.get(2)).toBe('工作')
  })

  it('unknown 记为 null（明确的「无匹配」）', () => {
    const r = parseBatchResults('{"results":[{"id":1,"category":"unknown"}]}', 1, valid)
    expect(r.has(1)).toBe(true)
    expect(r.get(1)).toBeNull()
  })

  it('缺条目时不臆造 —— 让调用方回退单条重跑', () => {
    const r = parseBatchResults('{"results":[{"id":1,"category":"生活"}]}', 3, valid)
    expect(r.size).toBe(1)
    expect(r.has(2)).toBe(false)
  })

  it('模型自创的分类名不被接受，同样交给回退', () => {
    const r = parseBatchResults('{"results":[{"id":1,"category":"娱乐"}]}', 1, valid)
    expect(r.has(1)).toBe(false)
  })

  it('编号越界被忽略', () => {
    const r = parseBatchResults('{"results":[{"id":9,"category":"生活"}]}', 2, valid)
    expect(r.size).toBe(0)
  })

  it('容忍 markdown 围栏与嵌套结构', () => {
    const r = parseBatchResults('```json\n{"results":[{"id":1,"category":"生活"}]}\n```', 1, valid)
    expect(r.get(1)).toBe('生活')
  })

  it('非法输入返回空表', () => {
    expect(parseBatchResults('不是 JSON', 2, valid).size).toBe(0)
    expect(parseBatchResults('{"results":"x"}', 2, valid).size).toBe(0)
  })
})

describe('批量分类管线', () => {
  let db: Db
  let updates: Message[]
  let requeued: number[]

  const make = (chatFn: (...a: never[]) => Promise<string>) =>
    createBulkClassifier({
      db,
      getConfig: () => ({ baseUrl: 'u', apiKey: 'k', model: 'm', secretaryPrompt: 'p' }),
      onUpdate: (m) => updates.push(m),
      enqueueSingle: (id) => requeued.push(id),
      chatFn: chatFn as never,
      sleepFn: () => Promise.resolve()
    })

  beforeEach(() => {
    db = createDb(':memory:')
    db.seedIfEmpty()
    updates = []
    requeued = []
  })

  it('一次调用处理整批', async () => {
    const chatFn = vi.fn(async () =>
      '{"results":[{"id":1,"category":"生活"},{"id":2,"category":"工作"}]}'
    )
    const a = db.insertMessage('买牛奶')
    const b = db.insertMessage('写周报')
    await make(chatFn).run([a.id, b.id])

    expect(chatFn).toHaveBeenCalledTimes(1) // 两条只花一次调用
    expect(db.getCategory(db.getMessage(a.id)!.categoryId!)!.name).toBe('生活')
    expect(db.getCategory(db.getMessage(b.id)!.categoryId!)!.name).toBe('工作')
  })

  it('超过一批时分多次调用', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => db.insertMessage(`第${i}条`).id)
    const chatFn = vi.fn(async () => '{"results":[]}')
    await make(chatFn).run(ids)
    expect(chatFn).toHaveBeenCalledTimes(3) // 10 + 10 + 3
  })

  it('批内缺失的条目回退单条管线，不直接判未分类', async () => {
    const a = db.insertMessage('买牛奶')
    const b = db.insertMessage('写周报')
    await make(async () => '{"results":[{"id":1,"category":"生活"}]}').run([a.id, b.id])

    expect(db.getMessage(a.id)!.status).toBe('classified')
    expect(requeued).toEqual([b.id]) // 第二条退回重跑
    expect(db.getMessage(b.id)!.status).toBe('pending') // 没被草率标失败
  })

  it('明确的 unknown 直接记未分类，不浪费一次单条重跑', async () => {
    const a = db.insertMessage('嗯')
    await make(async () => '{"results":[{"id":1,"category":"unknown"}]}').run([a.id])
    expect(db.getMessage(a.id)!.status).toBe('failed')
    expect(db.getMessage(a.id)!.error).toBe('没有匹配的分类')
    expect(requeued).toEqual([])
  })

  it('整批失败时全部退回单条管线', async () => {
    const a = db.insertMessage('a')
    const b = db.insertMessage('b')
    const chatFn = vi.fn(async () => {
      throw new LlmError('网络错误', true)
    })
    await make(chatFn).run([a.id, b.id])

    expect(chatFn).toHaveBeenCalledTimes(3) // 首次 + 2 次重试
    expect(requeued.sort()).toEqual([a.id, b.id].sort())
  })

  it('不可重试的错误不浪费重试次数', async () => {
    const a = db.insertMessage('a')
    const chatFn = vi.fn(async () => {
      throw new LlmError('接口返回 401', false)
    })
    await make(chatFn).run([a.id])
    expect(chatFn).toHaveBeenCalledTimes(1)
  })

  it('批量执行期间被手动指定的消息不会被覆盖', async () => {
    const work = db.listCategories().find((c) => c.name === '工作')!
    const a = db.insertMessage('买牛奶')
    db.moveMessage(a.id, work.id) // 用户抢先手动指定

    await make(async () => '{"results":[{"id":1,"category":"生活"}]}').run([a.id])

    const after = db.getMessage(a.id)!
    expect(after.status).toBe('manual')
    expect(after.categoryId).toBe(work.id)
  })

  it('没有可用分类时不调用模型', async () => {
    const fresh = createDb(':memory:')
    const chatFn = vi.fn(async () => '{"results":[]}')
    const bulk = createBulkClassifier({
      db: fresh,
      getConfig: () => ({ baseUrl: 'u', apiKey: 'k', model: 'm', secretaryPrompt: 'p' }),
      onUpdate: () => {},
      enqueueSingle: () => {},
      chatFn: chatFn as never,
      sleepFn: () => Promise.resolve()
    })
    const m = fresh.insertMessage('a')
    await bulk.run([m.id])

    expect(chatFn).not.toHaveBeenCalled()
    expect(fresh.getMessage(m.id)!.error).toBe('还没有创建任何分类')
  })

  it('汇报进度', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => db.insertMessage(`m${i}`).id)
    const seen: number[] = []
    await make(async () => '{"results":[]}').run(ids, (p) => seen.push(p.done))
    expect(seen).toEqual([10, 15])
  })
})
