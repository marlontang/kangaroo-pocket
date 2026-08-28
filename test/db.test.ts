import { describe, expect, it, beforeEach } from 'vitest'
import { createDb, type Db } from '../src/main/db'

let db: Db

beforeEach(() => {
  db = createDb(':memory:')
})

describe('分类', () => {
  it('首次启动写入种子分类，重复调用不重复写入', () => {
    db.seedIfEmpty()
    // 「图片」是内置分类，排序固定在最后
    expect(db.listCategories().map((c) => c.name)).toEqual(['生活', '工作', '图片'])
    db.seedIfEmpty()
    expect(db.listCategories()).toHaveLength(3)
  })

  it('创建、更新分类', () => {
    const c = db.createCategory({ name: '项目A', emoji: '🚀', description: 'A 项目相关' })
    expect(c.name).toBe('项目A')
    const updated = db.updateCategory(c.id, { name: '项目Alpha' })
    expect(updated.name).toBe('项目Alpha')
    expect(updated.emoji).toBe('🚀') // 未传的字段保持不变
  })

  it('拒绝空分类名', () => {
    expect(() => db.createCategory({ name: '   ' })).toThrow()
  })
})

describe('消息', () => {
  it('插入的消息为 pending 且无分类', () => {
    const m = db.insertMessage('买牛奶')
    expect(m.status).toBe('pending')
    expect(m.categoryId).toBeNull()
    expect(m.content).toBe('买牛奶')
  })

  it('按分类查询只返回该分类的消息，且按时间升序', () => {
    const life = db.createCategory({ name: '生活' })
    const work = db.createCategory({ name: '工作' })
    const m1 = db.insertMessage('买牛奶')
    const m2 = db.insertMessage('写周报')
    const m3 = db.insertMessage('买鸡蛋')
    db.applyClassification(m1.id, life.id)
    db.applyClassification(m2.id, work.id)
    db.applyClassification(m3.id, life.id)

    expect(db.listMessages({ categoryId: life.id }).map((m) => m.content)).toEqual(['买牛奶', '买鸡蛋'])
    expect(db.listMessages({ categoryId: work.id }).map((m) => m.content)).toEqual(['写周报'])
    expect(db.listMessages({ categoryId: 'all' })).toHaveLength(3)
  })

  it('分页游标 beforeId 向上翻页', () => {
    for (let i = 1; i <= 5; i++) db.insertMessage(`msg${i}`)
    const page1 = db.listMessages({ categoryId: 'all', limit: 2 })
    expect(page1.map((m) => m.content)).toEqual(['msg4', 'msg5'])
    const page2 = db.listMessages({ categoryId: 'all', limit: 2, beforeId: page1[0].id })
    expect(page2.map((m) => m.content)).toEqual(['msg2', 'msg3'])
  })

  it('手动移动分类后状态为 manual', () => {
    const c = db.createCategory({ name: '生活' })
    const m = db.insertMessage('买牛奶')
    const moved = db.moveMessage(m.id, c.id)
    expect(moved.categoryId).toBe(c.id)
    expect(moved.status).toBe('manual')
  })

  it('分类结果为 null 时标记为 failed', () => {
    const m = db.insertMessage('嗯')
    const after = db.applyClassification(m.id, null)
    expect(after?.status).toBe('failed')
    expect(after?.categoryId).toBeNull()
  })

  it('内容永不被改写', () => {
    const c = db.createCategory({ name: '生活' })
    const raw = '  多行\n内容  带空格 %_ 😀 '
    const m = db.insertMessage(raw)
    db.applyClassification(m.id, c.id)
    expect(db.getMessage(m.id)?.content).toBe(raw)
  })

  it('listPendingMessages 只返回待分类的', () => {
    const c = db.createCategory({ name: '生活' })
    const m1 = db.insertMessage('a')
    db.insertMessage('b')
    db.applyClassification(m1.id, c.id)
    expect(db.listPendingMessages().map((m) => m.content)).toEqual(['b'])
  })
})

describe('未分类会话', () => {
  it('正在排队分类的消息不算未分类', () => {
    db.insertMessage('刚发出，还在分类队列里') // status = pending，category_id 也是 null
    expect(db.countUnclassified()).toBe(0)
    expect(db.listMessages({ categoryId: 'unclassified' })).toHaveLength(0)
  })

  it('分类失败的消息才算未分类', () => {
    const m = db.insertMessage('分不出来的内容')
    db.applyClassification(m.id, null, '没有匹配的分类')
    expect(db.countUnclassified()).toBe(1)
    expect(db.listMessages({ categoryId: 'unclassified' }).map((x) => x.content)).toEqual([
      '分不出来的内容'
    ])
  })

  it('重试进行中的消息会退出未分类列表', () => {
    const m = db.insertMessage('先失败再重试')
    db.applyClassification(m.id, null, '网络错误')
    expect(db.countUnclassified()).toBe(1)

    db.markPending(m.id) // 用户点了「重试」
    expect(db.countUnclassified()).toBe(0)
  })

  it('未分类的未读数同样不含排队中的消息', () => {
    const failed = db.insertMessage('失败的')
    db.applyClassification(failed.id, null, '网络错误')
    db.insertMessage('排队中的')
    expect(db.unreadCount('unclassified')).toBe(1)
  })
})

describe('分类重名', () => {
  it('创建同名分类时给出可读错误', () => {
    db.createCategory({ name: '项目A' })
    expect(() => db.createCategory({ name: '项目A' })).toThrow('已存在同名分类')
    // 前后空格不应绕过判重
    expect(() => db.createCategory({ name: '  项目A  ' })).toThrow('已存在同名分类')
  })

  it('改名撞上其他分类时报错，改成自己原名则允许', () => {
    const a = db.createCategory({ name: '项目A' })
    db.createCategory({ name: '项目B' })
    expect(() => db.updateCategory(a.id, { name: '项目B' })).toThrow('已存在同名分类')
    expect(db.updateCategory(a.id, { name: '项目A', emoji: '🚀' }).emoji).toBe('🚀')
  })
})

describe('删除分类', () => {
  it('消息回落为未分类且不被删除', () => {
    const c = db.createCategory({ name: '项目A' })
    const m = db.insertMessage('A项目的bug')
    db.applyClassification(m.id, c.id)

    db.deleteCategory(c.id)

    expect(db.listCategories()).toHaveLength(0)
    const after = db.getMessage(m.id)
    expect(after).not.toBeNull()
    expect(after?.content).toBe('A项目的bug')
    expect(after?.categoryId).toBeNull()
    expect(after?.status).toBe('failed')
    expect(db.countUnclassified()).toBe(1)
  })
})

describe('搜索', () => {
  it('匹配任意分类下的历史消息', () => {
    const c = db.createCategory({ name: '生活' })
    const m = db.insertMessage('记得买牛奶和鸡蛋')
    db.applyClassification(m.id, c.id)
    db.insertMessage('写周报')
    expect(db.search('牛奶').map((m) => m.content)).toEqual(['记得买牛奶和鸡蛋'])
    expect(db.search('不存在的词')).toHaveLength(0)
    expect(db.search('  ')).toHaveLength(0)
  })

  it('LIKE 通配符被转义，不当作模式', () => {
    db.insertMessage('100%完成')
    db.insertMessage('无关内容')
    expect(db.search('%').map((m) => m.content)).toEqual(['100%完成'])
  })
})

describe('未读数', () => {
  it('新消息累加，标记已读后归零', () => {
    const c = db.createCategory({ name: '生活' })
    const m1 = db.insertMessage('a')
    const m2 = db.insertMessage('b')
    db.applyClassification(m1.id, c.id)
    db.applyClassification(m2.id, c.id)
    expect(db.unreadCount(c.id)).toBe(2)

    db.markRead(c.id)
    expect(db.unreadCount(c.id)).toBe(0)

    const m3 = db.insertMessage('c')
    db.applyClassification(m3.id, c.id)
    expect(db.unreadCount(c.id)).toBe(1)
  })

  it('侧栏元数据包含最后一条消息与未读数', () => {
    const c = db.createCategory({ name: '生活' })
    const m1 = db.insertMessage('第一条')
    const m2 = db.insertMessage('第二条')
    db.applyClassification(m1.id, c.id)
    db.applyClassification(m2.id, c.id)
    const meta = db.listCategoriesWithMeta()
    expect(meta[0].lastMessage).toBe('第二条')
    expect(meta[0].unreadCount).toBe(2)
  })
})

describe('内置「图片」分类', () => {
  const IMG = { url: 'collect-img://local/abc.png', width: 64, height: 48, name: 'a.png', bytes: 1234 }

  beforeEach(() => db.seedIfEmpty())

  it('种子阶段自动创建，且标记为系统分类', () => {
    const file = db.listCategories().find((c) => c.name === '图片')!
    expect(file).toBeDefined()
    expect(file.isSystem).toBe(true)
    // 改用文字头像后不再预设 emoji
    expect(file.emoji).toBe('')
  })

  it('老库升级时也会补上（seedIfEmpty 不会因为已有分类而跳过）', () => {
    const fresh = createDb(':memory:')
    fresh.createCategory({ name: '已有分类' }) // 模拟老库：有分类但没有「图片」
    expect(fresh.listCategories().find((c) => c.name === '图片')).toBeUndefined()
    fresh.seedIfEmpty()
    expect(fresh.listCategories().find((c) => c.name === '图片')?.isSystem).toBe(true)
  })

  it('不可删除、不可修改', () => {
    const file = db.imageCategory()
    expect(() => db.deleteCategory(file.id)).toThrow('不能删除')
    expect(() => db.updateCategory(file.id, { name: '别的名字' })).toThrow('不能修改')
  })

  it('不参与 AI 分类候选 —— 文字消息不该被归到「图片」', () => {
    const names = db.listClassifiableCategories().map((c) => c.name)
    expect(names).toContain('生活')
    expect(names).not.toContain('图片')
  })

  it('重复调用 ensureSystemCategories 不会产生重复分类', () => {
    db.ensureSystemCategories()
    db.ensureSystemCategories()
    expect(db.listCategories().filter((c) => c.name === '图片')).toHaveLength(1)
  })
})

describe('图片消息', () => {
  const IMG = { url: 'collect-img://local/abc.png', width: 64, height: 48, name: 'a.png', bytes: 1234 }

  beforeEach(() => db.seedIfEmpty())

  it('带图片的消息直接落入「图片」，不进分类队列', () => {
    const file = db.imageCategory()
    const m = db.insertMessage('', { image: IMG, categoryId: file.id, status: 'classified' })
    expect(m.image).toEqual(IMG)
    expect(m.categoryId).toBe(file.id)
    expect(m.status).toBe('classified')
    expect(db.listPendingMessages()).toHaveLength(0) // 不需要模型介入
  })

  it('图片可以带文字说明', () => {
    const m = db.insertMessage('这是购物小票', {
      image: IMG,
      categoryId: db.imageCategory().id,
      status: 'classified'
    })
    expect(m.content).toBe('这是购物小票')
    expect(m.image?.name).toBe('a.png')
  })

  it('纯文字消息的 image 为 null', () => {
    expect(db.insertMessage('只有文字').image).toBeNull()
  })

  it('图片消息出现在「图片」会话里', () => {
    const file = db.imageCategory()
    db.insertMessage('', { image: IMG, categoryId: file.id, status: 'classified' })
    const list = db.listMessages({ categoryId: file.id })
    expect(list).toHaveLength(1)
    expect(list[0].image?.url).toBe(IMG.url)
  })

  it('侧栏预览对纯图片消息显示占位符', () => {
    const file = db.imageCategory()
    db.insertMessage('', { image: IMG, categoryId: file.id, status: 'classified' })
    const meta = db.listCategoriesWithMeta().find((c) => c.name === '图片')!
    expect(meta.lastMessage).toBe('[图片]')
  })

  it('可以手动把图片移到别的分类', () => {
    const file = db.imageCategory()
    const life = db.listCategories().find((c) => c.name === '生活')!
    const m = db.insertMessage('', { image: IMG, categoryId: file.id, status: 'classified' })
    const moved = db.moveMessage(m.id, life.id)
    expect(moved.categoryId).toBe(life.id)
    expect(moved.image?.url).toBe(IMG.url) // 图片信息不丢
  })
})

describe('垃圾箱', () => {
  const IMG = { url: 'collect-img://local/x.png', width: 10, height: 10, name: 'x.png', bytes: 9 }

  beforeEach(() => db.seedIfEmpty())

  it('删除是软删除：消息进垃圾箱，不从库里消失', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const m = db.insertMessage('买牛奶')
    db.applyClassification(m.id, life.id)

    db.trashMessage(m.id)

    expect(db.getMessage(m.id)?.content).toBe('买牛奶') // 还在
    expect(db.getMessage(m.id)?.deletedAt).not.toBeNull()
    expect(db.countTrash()).toBe(1)
  })

  it('已删除的消息不出现在任何普通会话里', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const m = db.insertMessage('买牛奶')
    db.applyClassification(m.id, life.id)
    db.trashMessage(m.id)

    expect(db.listMessages({ categoryId: 'all' })).toHaveLength(0)
    expect(db.listMessages({ categoryId: life.id })).toHaveLength(0)
    expect(db.search('牛奶')).toHaveLength(0)
    expect(db.listMessages({ categoryId: 'trash' }).map((x) => x.content)).toEqual(['买牛奶'])
  })

  it('删除后不再计入未读数和侧栏预览', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const m1 = db.insertMessage('第一条')
    const m2 = db.insertMessage('第二条')
    db.applyClassification(m1.id, life.id)
    db.applyClassification(m2.id, life.id)
    expect(db.unreadCount(life.id)).toBe(2)

    db.trashMessage(m2.id)
    expect(db.unreadCount(life.id)).toBe(1)
    expect(db.listCategoriesWithMeta().find((c) => c.id === life.id)?.lastMessage).toBe('第一条')
  })

  it('未分类计数排除已删除的', () => {
    const m = db.insertMessage('分不出来')
    db.applyClassification(m.id, null, '没有匹配的分类')
    expect(db.countUnclassified()).toBe(1)
    db.trashMessage(m.id)
    expect(db.countUnclassified()).toBe(0)
  })

  it('待分类队列不会捞起已删除的消息', () => {
    const m = db.insertMessage('还没分类就被删了')
    expect(db.listPendingMessages()).toHaveLength(1)
    db.trashMessage(m.id)
    expect(db.listPendingMessages()).toHaveLength(0)
  })

  it('还原后回到原分类', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const m = db.insertMessage('买牛奶')
    db.applyClassification(m.id, life.id)
    db.trashMessage(m.id)

    const restored = db.restoreMessage(m.id)!
    expect(restored.deletedAt).toBeNull()
    expect(restored.categoryId).toBe(life.id) // 分类归属没丢
    expect(db.listMessages({ categoryId: life.id })).toHaveLength(1)
    expect(db.countTrash()).toBe(0)
  })

  it('彻底删除后不可恢复，并返回要清理的图片', () => {
    const m = db.insertMessage('带图的', {
      image: IMG,
      categoryId: db.imageCategory().id,
      status: 'classified'
    })
    db.trashMessage(m.id)

    expect(db.purgeMessage(m.id)).toEqual([IMG.url])
    expect(db.getMessage(m.id)).toBeNull()
    expect(db.countTrash()).toBe(0)
  })

  it('纯文字消息彻底删除时不返回图片地址', () => {
    const m = db.insertMessage('纯文字')
    db.trashMessage(m.id)
    expect(db.purgeMessage(m.id)).toEqual([])
  })

  it('清空垃圾箱只清垃圾箱里的，不动其他消息', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const keep = db.insertMessage('保留的')
    db.applyClassification(keep.id, life.id)

    const a = db.insertMessage('删掉的1')
    const b = db.insertMessage('删掉的2', {
      image: IMG,
      categoryId: db.imageCategory().id,
      status: 'classified'
    })
    db.trashMessage(a.id)
    db.trashMessage(b.id)

    const { count, imageUrls } = db.emptyTrash()
    // 条数和待清理图片数是两回事：清掉 2 条，其中只有 1 条带图
    expect(count).toBe(2)
    expect(imageUrls).toEqual([IMG.url])
    expect(db.countTrash()).toBe(0)
    expect(db.getMessage(a.id)).toBeNull()
    expect(db.getMessage(keep.id)?.content).toBe('保留的')
  })

  it('垃圾箱按删除时间倒序（最近删的在最后一屏）', () => {
    const m1 = db.insertMessage('先删的')
    const m2 = db.insertMessage('后删的')
    db.trashMessage(m1.id)
    db.trashMessage(m2.id)
    expect(db.listMessages({ categoryId: 'trash' }).map((m) => m.content)).toEqual([
      '先删的',
      '后删的'
    ])
  })

  it('垃圾箱没有未读概念', () => {
    const m = db.insertMessage('a')
    db.trashMessage(m.id)
    expect(db.unreadCount('trash')).toBe(0)
    db.markRead('trash') // 不应抛错
  })
})

describe('全量重新分类的范围', () => {
  const IMG = { url: 'collect-img://local/z.png', width: 8, height: 8, name: 'z.png', bytes: 5 }

  beforeEach(() => db.seedIfEmpty())

  it('只重置未删除的文字消息，垃圾箱与图片不动', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    const normal = db.insertMessage('买牛奶')
    db.applyClassification(normal.id, life.id)

    const manual = db.insertMessage('手动指定过的')
    db.moveMessage(manual.id, life.id)

    const trashed = db.insertMessage('已删除的')
    db.applyClassification(trashed.id, life.id)
    db.trashMessage(trashed.id)

    const img = db.insertMessage('', {
      image: IMG,
      categoryId: db.imageCategory().id,
      status: 'classified'
    })

    expect(db.resetForReclassify()).toBe(2) // 只有 normal + manual

    expect(db.getMessage(normal.id)!.status).toBe('pending')
    expect(db.getMessage(normal.id)!.categoryId).toBeNull()
    // 用户显式发起的批量覆盖，manual 也一并重置
    expect(db.getMessage(manual.id)!.status).toBe('pending')
    // 垃圾箱里的保持原样
    expect(db.getMessage(trashed.id)!.status).toBe('classified')
    expect(db.getMessage(trashed.id)!.deletedAt).not.toBeNull()
    // 图片仍归「图片」分类
    expect(db.getMessage(img.id)!.categoryId).toBe(db.imageCategory().id)
  })

  it('范围统计给出条数、手动条数与字符总量', () => {
    const life = db.listCategories().find((c) => c.name === '生活')!
    db.insertMessage('12345')
    const m = db.insertMessage('67890')
    db.moveMessage(m.id, life.id)
    const t = db.insertMessage('不算我')
    db.trashMessage(t.id)

    const scope = db.reclassifyScope()
    expect(scope.count).toBe(2)
    expect(scope.manualCount).toBe(1)
    expect(scope.chars).toBe(10)
  })

  it('countPendingMessages 排除垃圾箱', () => {
    db.insertMessage('排队中')
    const t = db.insertMessage('删掉的')
    db.trashMessage(t.id)
    expect(db.countPendingMessages()).toBe(1)
  })

  it('识别样本按最近优先，超长截断，空内容不取', () => {
    db.insertMessage('第一条')
    db.insertMessage('x'.repeat(500))
    db.insertMessage('   ')
    const s = db.sampleForDiscovery(10, 50)
    expect(s[0]).toHaveLength(50)
    expect(s).toContain('第一条')
    expect(s.some((x) => x === '')).toBe(false)
  })
})
