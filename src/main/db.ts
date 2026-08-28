import { DatabaseSync } from 'node:sqlite'
import type {
  Category,
  CategoryInput,
  CategoryWithMeta,
  ConversationId,
  ListMessagesOptions,
  Message,
  MessageImage,
  MessageStatus
} from '../shared/types'

/**
 * 「未分类」= 已经尝试过分类但失败/无匹配的消息。
 * 必须带上 status 判断：pending 消息的 category_id 也是 NULL，
 * 但它只是在排队等分类，不该出现在未分类会话里。
 */
/** 图片专用的内置分类名。目前只收图片，所以就叫「图片」而不是笼统的「文件」。 */
export const IMAGE_CATEGORY_NAME = '图片'

/** 早期版本用过的名字，升级时改名 */
const LEGACY_IMAGE_CATEGORY_NAME = '文件'

const UNCLASSIFIED_WHERE = "category_id IS NULL AND status = 'failed'"

/**
 * 未被删除。删除是软删除（进垃圾箱），除了垃圾箱视图本身，
 * 所有查询都必须带上这个条件。
 */
const ALIVE = 'deleted_at IS NULL'

/** reads 表用负数主键代表两个虚拟会话 */
const READ_KEY_ALL = -1
const READ_KEY_UNCLASSIFIED = -2
const READ_KEY_TRASH = -3

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  emoji       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT NOT NULL,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  classified_at INTEGER,
  error         TEXT,
  image_url     TEXT,
  image_w       INTEGER,
  image_h       INTEGER,
  image_name    TEXT,
  image_bytes   INTEGER,
  deleted_at    INTEGER   -- 非空表示在垃圾箱里
);
CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);

CREATE TABLE IF NOT EXISTS reads (
  category_id      INTEGER PRIMARY KEY,
  last_read_msg_id INTEGER NOT NULL DEFAULT 0
);
`

interface MessageRow {
  id: number
  content: string
  category_id: number | null
  status: string
  created_at: number
  classified_at: number | null
  error: string | null
  image_url: string | null
  image_w: number | null
  image_h: number | null
  image_name: string | null
  image_bytes: number | null
  deleted_at: number | null
}

interface CategoryRow {
  id: number
  name: string
  emoji: string
  description: string
  sort_order: number
  created_at: number
  is_system: number
}

function toMessage(r: MessageRow): Message {
  return {
    id: Number(r.id),
    content: r.content,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    status: r.status as MessageStatus,
    createdAt: Number(r.created_at),
    classifiedAt: r.classified_at === null ? null : Number(r.classified_at),
    error: r.error ?? null,
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
    image: r.image_url
      ? {
          url: r.image_url,
          width: Number(r.image_w ?? 0),
          height: Number(r.image_h ?? 0),
          name: r.image_name ?? '图片',
          bytes: Number(r.image_bytes ?? 0)
        }
      : null
  }
}

function toCategory(r: CategoryRow): Category {
  return {
    id: Number(r.id),
    name: r.name,
    emoji: r.emoji,
    description: r.description,
    sortOrder: Number(r.sort_order),
    createdAt: Number(r.created_at),
    isSystem: Number(r.is_system) === 1
  }
}

/** 转义 LIKE 的通配符，避免用户输入的 % _ 被当作模式 */
function escapeLike(kw: string): string {
  return kw.replace(/[\\%_]/g, (c) => '\\' + c)
}

function readKeyOf(id: ConversationId): number {
  if (id === 'all') return READ_KEY_ALL
  if (id === 'unclassified') return READ_KEY_UNCLASSIFIED
  if (id === 'trash') return READ_KEY_TRASH
  return id
}

/** 为已存在的旧库补齐新增字段。CREATE TABLE IF NOT EXISTS 不会改动已有表。 */
function migrate(db: DatabaseSync): void {
  const addMissing = (table: string, cols: Record<string, string>): void => {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
        (c) => c.name
      )
    )
    for (const [name, decl] of Object.entries(cols)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`)
    }
  }
  addMissing('messages', {
    error: 'TEXT',
    image_url: 'TEXT',
    image_w: 'INTEGER',
    image_h: 'INTEGER',
    image_name: 'TEXT',
    image_bytes: 'INTEGER',
    deleted_at: 'INTEGER'
  })
  addMissing('categories', { is_system: 'INTEGER NOT NULL DEFAULT 0' })

  // 早期版本把图片分类叫「文件」，改名。只动系统分类，
  // 免得误伤用户自己建的同名分类。
  const legacy = db
    .prepare('SELECT id FROM categories WHERE name = ? AND is_system = 1')
    .get(LEGACY_IMAGE_CATEGORY_NAME) as { id: number } | undefined
  if (legacy) {
    const taken = db
      .prepare('SELECT id FROM categories WHERE name = ?')
      .get(IMAGE_CATEGORY_NAME) as { id: number } | undefined
    if (!taken) {
      db.prepare('UPDATE categories SET name = ?, emoji = ?, description = ? WHERE id = ?').run(
        IMAGE_CATEGORY_NAME,
        '🖼️',
        '所有图片',
        legacy.id
      )
    }
  }
}

export type Db = ReturnType<typeof createDb>

/**
 * 创建数据库访问层。传 ':memory:' 用于测试。
 * 所有函数都是同步的（node:sqlite 只提供同步 API），由 IPC 层包成 Promise。
 */
export function createDb(filename: string) {
  const db = new DatabaseSync(filename)
  db.exec(SCHEMA)
  migrate(db)

  // ── 分类 ──────────────────────────────────────────────
  function listCategories(): Category[] {
    const rows = db
      .prepare('SELECT * FROM categories ORDER BY sort_order, id')
      .all() as unknown as CategoryRow[]
    return rows.map(toCategory)
  }

  /**
   * 参与 AI 分类的候选分类。排除系统分类 ——「文件」只接收图片，
   * 文字消息不该被归到那里。
   */
  function listClassifiableCategories(): Category[] {
    return listCategories().filter((c) => !c.isSystem)
  }

  function getCategory(id: number): Category | null {
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as unknown | undefined
    return row ? toCategory(row as CategoryRow) : null
  }

  function findCategoryByName(name: string): Category | null {
    const row = db.prepare('SELECT * FROM categories WHERE name = ?').get(name) as
      unknown | undefined
    return row ? toCategory(row as CategoryRow) : null
  }

  function createCategory(input: CategoryInput & { isSystem?: boolean }): Category {
    const name = input.name.trim()
    if (!name) throw new Error('分类名不能为空')
    // 显式判重，避免把 SQLite 的 UNIQUE 约束错误抛给界面层去猜
    if (findCategoryByName(name)) throw new Error('已存在同名分类')
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories')
      .get() as { m: number } | undefined
    const info = db
      .prepare(
        'INSERT INTO categories (name, emoji, description, sort_order, created_at, is_system) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        name,
        input.emoji ?? '',
        input.description || '',
        // 系统分类固定排在最后
        input.isSystem ? 9999 : Number(maxOrder?.m ?? 0) + 1,
        Date.now(),
        input.isSystem ? 1 : 0
      )
    return getCategory(Number(info.lastInsertRowid))!
  }

  function updateCategory(id: number, input: Partial<CategoryInput>): Category {
    const current = getCategory(id)
    if (!current) throw new Error('分类不存在')
    if (current.isSystem) throw new Error(`「${current.name}」是内置分类，不能修改`)
    const name = input.name === undefined ? current.name : input.name.trim()
    if (!name) throw new Error('分类名不能为空')
    const clash = findCategoryByName(name)
    if (clash && clash.id !== id) throw new Error('已存在同名分类')
    db.prepare('UPDATE categories SET name = ?, emoji = ?, description = ? WHERE id = ?').run(
      name,
      input.emoji === undefined ? current.emoji : input.emoji,
      input.description === undefined ? current.description : input.description,
      id
    )
    return getCategory(id)!
  }

  /** 删除分类：其消息回落为未分类（category_id → NULL），消息本身保留 */
  function deleteCategory(id: number): void {
    const target = getCategory(id)
    if (!target) throw new Error('分类不存在')
    if (target.isSystem) throw new Error(`「${target.name}」是内置分类，不能删除`)
    db.prepare(
      `UPDATE messages SET status = 'failed', error = '原分类已删除' WHERE ${ALIVE} AND category_id = ?`
    ).run(id)
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
    db.prepare('DELETE FROM reads WHERE category_id = ?').run(id)
  }

  // ── 消息 ──────────────────────────────────────────────
  function getMessage(id: number): Message | null {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown | undefined
    return row ? toMessage(row as MessageRow) : null
  }

  function insertMessage(
    content: string,
    opts: { image?: MessageImage; categoryId?: number; status?: MessageStatus } = {}
  ): Message {
    const img = opts.image
    const info = db
      .prepare(
        'INSERT INTO messages (content, status, created_at, category_id, classified_at,' +
          ' image_url, image_w, image_h, image_name, image_bytes)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        content,
        opts.status ?? 'pending',
        Date.now(),
        opts.categoryId ?? null,
        opts.categoryId === undefined ? null : Date.now(),
        img?.url ?? null,
        img?.width ?? null,
        img?.height ?? null,
        img?.name ?? null,
        img?.bytes ?? null
      )
    return getMessage(Number(info.lastInsertRowid))!
  }

  function listMessages(opts: ListMessagesOptions): Message[] {
    const limit = Math.min(opts.limit ?? 50, 200)
    const where: string[] = []
    const params: (number | string)[] = []

    if (opts.categoryId === 'trash') {
      where.push('deleted_at IS NOT NULL')
    } else if (opts.categoryId === 'unclassified') {
      where.push(ALIVE, UNCLASSIFIED_WHERE)
    } else if (opts.categoryId === 'all') {
      where.push(ALIVE)
    } else {
      where.push(ALIVE, 'category_id = ?')
      params.push(opts.categoryId)
    }
    if (opts.beforeId !== undefined) {
      where.push('id < ?')
      params.push(opts.beforeId)
    }

    const sql =
      'SELECT * FROM messages' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params) as unknown as MessageRow[]
    // 查询按 id 倒序取最近 N 条，返回时翻正成时间升序供 UI 直接渲染
    return rows.map(toMessage).reverse()
  }

  /** 手动指定分类 —— 标记为 manual，后续自动分类不会覆盖 */
  function moveMessage(id: number, categoryId: number): Message {
    if (!getCategory(categoryId)) throw new Error('分类不存在')
    db.prepare(
      "UPDATE messages SET category_id = ?, status = 'manual', classified_at = ?, error = NULL WHERE id = ?"
    ).run(categoryId, Date.now(), id)
    const m = getMessage(id)
    if (!m) throw new Error('消息不存在')
    return m
  }

  /** AI 分类结果写回。categoryId 为 null 表示失败，error 记录原因。 */
  function applyClassification(
    id: number,
    categoryId: number | null,
    error?: string
  ): Message | null {
    db.prepare(
      'UPDATE messages SET category_id = ?, status = ?, classified_at = ?, error = ? WHERE id = ?'
    ).run(
      categoryId,
      categoryId === null ? 'failed' : 'classified',
      Date.now(),
      categoryId === null ? (error ?? null) : null,
      id
    )
    return getMessage(id)
  }

  /** 重置为待分类，交给分类队列重跑 */
  function markPending(id: number): Message | null {
    db.prepare(
      "UPDATE messages SET status = 'pending', category_id = NULL, classified_at = NULL, error = NULL WHERE id = ?"
    ).run(id)
    return getMessage(id)
  }

  /** 待分类条数。进度轮询用，别拉全表。 */
  function countPendingMessages(): number {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE status = 'pending' AND ${ALIVE}`)
      .get() as { c: number }
    return Number(r.c)
  }

  /**
   * 全量重跑的范围统计。图片按规则归类不走模型，垃圾箱不参与。
   * manualCount 用于二次确认时如实告知「这些手动指定的也会被覆盖」。
   */
  function reclassifyScope(): { count: number; manualCount: number; chars: number } {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS c,
                SUM(CASE WHEN status = 'manual' THEN 1 ELSE 0 END) AS m,
                COALESCE(SUM(LENGTH(content)), 0) AS ch
         FROM messages WHERE ${ALIVE} AND image_url IS NULL`
      )
      .get() as { c: number; m: number | null; ch: number }
    return { count: Number(r.c), manualCount: Number(r.m ?? 0), chars: Number(r.ch) }
  }

  /**
   * 把待重跑的消息统一置回 pending，返回受影响条数。
   * 排除垃圾箱与图片消息；manual 也会被重置 —— 这是用户显式发起的批量覆盖。
   */
  function resetForReclassify(): number {
    const info = db
      .prepare(
        `UPDATE messages
         SET status = 'pending', category_id = NULL, classified_at = NULL, error = NULL
         WHERE ${ALIVE} AND image_url IS NULL`
      )
      .run()
    return Number(info.changes)
  }

  function listPendingMessages(): Message[] {
    const rows = db
      .prepare(`SELECT * FROM messages WHERE status = 'pending' AND ${ALIVE} ORDER BY id`)
      .all() as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /** 软删除：移入垃圾箱，随时可还原 */
  function trashMessage(id: number): Message | null {
    db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
    return getMessage(id)
  }

  /** 从垃圾箱还原 */
  function restoreMessage(id: number): Message | null {
    db.prepare('UPDATE messages SET deleted_at = NULL WHERE id = ?').run(id)
    return getMessage(id)
  }

  /**
   * 彻底删除。返回被删消息带的图片地址，交给调用方清理磁盘文件 ——
   * db 层不碰文件系统，保持可单测。
   */
  function purgeMessage(id: number): string[] {
    const m = getMessage(id)
    db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    return m?.image ? [m.image.url] : []
  }

  /**
   * 清空垃圾箱。
   * count 是清掉的消息条数，imageUrls 是需要调用方清理的磁盘文件 ——
   * 两者不相等（纯文字消息没有图片），不能拿后者的长度当条数用。
   */
  function emptyTrash(): { count: number; imageUrls: string[] } {
    const count = countTrash()
    const rows = db
      .prepare(
        'SELECT image_url FROM messages WHERE deleted_at IS NOT NULL AND image_url IS NOT NULL'
      )
      .all() as unknown as { image_url: string }[]
    db.prepare('DELETE FROM messages WHERE deleted_at IS NOT NULL').run()
    return { count, imageUrls: rows.map((r) => r.image_url) }
  }

  function countTrash(): number {
    const r = db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE deleted_at IS NOT NULL')
      .get() as {
      c: number
    }
    return Number(r.c)
  }

  /** 识别分类用的样本：未删除、有文字内容的消息，最近优先 */
  function sampleForDiscovery(limit = 300, maxChars = 200): string[] {
    const rows = db
      .prepare(
        `SELECT content FROM messages
         WHERE ${ALIVE} AND TRIM(content) <> ''
         ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as unknown as { content: string }[]
    return rows.map((r) => r.content.trim().slice(0, maxChars))
  }

  function search(keyword: string): Message[] {
    const kw = keyword.trim()
    if (!kw) return []
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE ${ALIVE} AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100`
      )
      .all(`%${escapeLike(kw)}%`) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  // ── 已读 / 未读 ────────────────────────────────────────
  function markRead(conversationId: ConversationId): void {
    // 垃圾箱不需要未读概念
    if (conversationId === 'trash') return
    const key = readKeyOf(conversationId)
    let maxId: number
    if (conversationId === 'all') {
      const r = db
        .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE ${ALIVE}`)
        .get() as { m: number }
      maxId = Number(r.m)
    } else if (conversationId === 'unclassified') {
      const r = db
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE ${ALIVE} AND ${UNCLASSIFIED_WHERE}`
        )
        .get() as { m: number }
      maxId = Number(r.m)
    } else {
      const r = db
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE ${ALIVE} AND category_id = ?`
        )
        .get(conversationId) as { m: number }
      maxId = Number(r.m)
    }
    db.prepare(
      'INSERT INTO reads (category_id, last_read_msg_id) VALUES (?, ?) ' +
        'ON CONFLICT(category_id) DO UPDATE SET last_read_msg_id = excluded.last_read_msg_id'
    ).run(key, maxId)
  }

  function unreadCount(conversationId: ConversationId): number {
    if (conversationId === 'trash') return 0
    const key = readKeyOf(conversationId)
    const read = db
      .prepare('SELECT last_read_msg_id AS v FROM reads WHERE category_id = ?')
      .get(key) as { v: number } | undefined
    const lastRead = Number(read?.v ?? 0)
    if (conversationId === 'all') {
      const r = db
        .prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${ALIVE} AND id > ?`)
        .get(lastRead) as {
        c: number
      }
      return Number(r.c)
    }
    if (conversationId === 'unclassified') {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS c FROM messages WHERE ${ALIVE} AND ${UNCLASSIFIED_WHERE} AND id > ?`
        )
        .get(lastRead) as { c: number }
      return Number(r.c)
    }
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${ALIVE} AND category_id = ? AND id > ?`)
      .get(conversationId, lastRead) as { c: number }
    return Number(r.c)
  }

  /** 侧栏数据：分类 + 最后一条消息 + 未读数 */
  function listCategoriesWithMeta(): CategoryWithMeta[] {
    return listCategories().map((c) => {
      const last = db
        .prepare(
          `SELECT content, created_at, image_url FROM messages WHERE ${ALIVE} AND category_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(c.id) as { content: string; created_at: number; image_url: string | null } | undefined
      // 纯图片消息没有文字，侧栏用占位符代替空白
      const preview = last ? last.content || (last.image_url ? '[图片]' : '') : null
      return {
        ...c,
        lastMessage: preview,
        lastMessageAt: last ? Number(last.created_at) : null,
        unreadCount: unreadCount(c.id)
      }
    })
  }

  function countUnclassified(): number {
    const r = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${ALIVE} AND ${UNCLASSIFIED_WHERE}`)
      .get() as {
      c: number
    }
    return Number(r.c)
  }

  /** 首次启动写入种子分类 */
  function seedIfEmpty(): void {
    const r = db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }
    if (Number(r.c) === 0) {
      // 不预设 emoji：默认走文字头像，用户想换再自己挑
      createCategory({ name: '生活', description: '日常生活、购物、健康、家庭、饮食、出行' })
      createCategory({ name: '工作', description: '公司事务、同事沟通、会议、汇报、绩效' })
    }
    ensureSystemCategories()
  }

  /** 内置分类必须存在。老库升级上来时也要补上，所以和 seedIfEmpty 分开。 */
  function ensureSystemCategories(): void {
    if (!findCategoryByName(IMAGE_CATEGORY_NAME)) {
      createCategory({ name: IMAGE_CATEGORY_NAME, description: '所有图片', isSystem: true })
    }
  }

  /** 图片统一归入的分类 */
  function imageCategory(): Category {
    ensureSystemCategories()
    return findCategoryByName(IMAGE_CATEGORY_NAME)!
  }

  function close(): void {
    db.close()
  }

  return {
    listCategories,
    listCategoriesWithMeta,
    getCategory,
    createCategory,
    updateCategory,
    deleteCategory,
    getMessage,
    insertMessage,
    listMessages,
    moveMessage,
    applyClassification,
    markPending,
    listPendingMessages,
    countPendingMessages,
    reclassifyScope,
    resetForReclassify,
    trashMessage,
    restoreMessage,
    purgeMessage,
    emptyTrash,
    countTrash,
    sampleForDiscovery,
    search,
    markRead,
    unreadCount,
    countUnclassified,
    seedIfEmpty,
    ensureSystemCategories,
    imageCategory,
    listClassifiableCategories,
    close
  }
}
