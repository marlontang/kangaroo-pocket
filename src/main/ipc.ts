import { ipcMain } from 'electron'
import { CH } from '../shared/channels'
import type { Db } from './db'
import type { Classifier } from './classifier'
import type { BulkClassifier } from './bulkClassifier'
import { BATCH_SIZE } from './bulkClassifier'
import { getApiKey, getSettings, saveSettings } from './settings'
import { testConnection } from './llm'
import { deleteImage, saveImage } from './images'
import { discoverCategories } from './discovery'
import { exportData, importData } from './backup'
import type {
  CategoryInput,
  ConversationId,
  ListMessagesOptions,
  Message,
  SendOptions,
  SettingsInput
} from '../shared/types'

export interface IpcDeps {
  db: Db
  classifier: Classifier
  bulk: BulkClassifier
  /** 主进程 → 渲染进程推送消息更新 */
  broadcast: (message: Message) => void
}

/** 中文按 1.6 token/字符粗估；批次固定开销含候选列表与指令 */
const TOKENS_PER_CHAR = 1.6
const TOKENS_PER_BATCH_OVERHEAD = 400
const SECONDS_PER_BATCH = 2

export function registerIpc({ db, classifier, bulk, broadcast }: IpcDeps): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])))
  }

  handle(CH.ping, () => 'pong')

  // ── 消息 ──────────────────────────────────────────────
  handle(CH.sendMessage, (content: string, opts: SendOptions = {}) => {
    const text = String(content ?? '')
    const { image, categoryId } = opts
    if (!text.trim() && !image) throw new Error('消息内容不能为空')

    // 在某个分类会话里发的：归属已由用户指定，不走模型。
    // 图片同理 —— 显式选择优先于「图片统一进图片分类」这条默认规则。
    if (categoryId !== undefined) {
      if (!db.getCategory(categoryId)) throw new Error('分类不存在')
      return db.insertMessage(text, {
        image: image ? saveImage(image) : undefined,
        categoryId,
        status: 'manual'
      })
    }

    if (image) {
      // 没指定分类时，图片按规则归入「图片」分类，不调用模型 ——
      // 后缀就足以判断这是不是图片，没必要为此花一次推理。
      return db.insertMessage(text, {
        image: saveImage(image),
        categoryId: db.imageCategory().id,
        status: 'classified'
      })
    }

    // 先落库并立即返回，分类在后台异步进行 —— 网络故障绝不影响消息保存
    const message = db.insertMessage(text)
    classifier.enqueue(message.id)
    return message
  })

  handle(CH.listMessages, (opts: ListMessagesOptions) => db.listMessages(opts))
  handle(CH.moveMessage, (id: number, categoryId: number) => db.moveMessage(id, categoryId))
  // 删除是软删除：移入垃圾箱，图片文件先留着，等彻底删除时再清理
  handle(CH.deleteMessage, (id: number) => db.trashMessage(id))
  handle(CH.restoreMessage, (id: number) => db.restoreMessage(id))

  handle(CH.purgeMessage, (id: number) => {
    // 彻底删除才动磁盘，避免删了消息还留一堆孤儿图片
    for (const url of db.purgeMessage(id)) deleteImage(url)
  })

  handle(CH.emptyTrash, () => {
    const { count, imageUrls } = db.emptyTrash()
    for (const url of imageUrls) deleteImage(url)
    return count
  })

  handle(CH.countTrash, () => db.countTrash())
  handle(CH.search, (keyword: string) => db.search(keyword))

  handle(CH.reclassify, (id: number) => {
    const m = db.getMessage(id)
    // 图片的归属是规则决定的，重跑模型没有意义，直接放回「文件」。
    // 必须推送更新，否则界面会一直停在「分类中」。
    if (m?.image) {
      broadcast(db.moveMessage(id, db.imageCategory().id))
      return
    }
    db.markPending(id)
    classifier.enqueue(id)
  })

  // ── 分类 ──────────────────────────────────────────────
  handle(CH.listCategories, () => db.listCategoriesWithMeta())
  handle(CH.createCategory, (input: CategoryInput) => db.createCategory(input))
  handle(CH.updateCategory, (id: number, input: Partial<CategoryInput>) =>
    db.updateCategory(id, input)
  )
  handle(CH.deleteCategory, (id: number) => db.deleteCategory(id))
  handle(CH.markRead, (categoryId: ConversationId) => db.markRead(categoryId))
  handle(CH.countUnclassified, () => db.countUnclassified())

  // ── AI 归纳与全量重跑 ──────────────────────────────────
  handle(CH.discoverCategories, () => {
    const s = getSettings()
    return discoverCategories(db, { baseUrl: s.baseUrl, model: s.model, apiKey: getApiKey() })
  })

  handle(CH.estimateReclassify, () => {
    const { count, manualCount, chars } = db.reclassifyScope()
    const batches = Math.ceil(count / BATCH_SIZE)
    return {
      count,
      manualCount,
      batches,
      estTokens: Math.round(chars * TOKENS_PER_CHAR + batches * TOKENS_PER_BATCH_OVERHEAD),
      estSeconds: batches * SECONDS_PER_BATCH
    }
  })

  handle(CH.reclassifyAll, () => {
    const count = db.resetForReclassify()
    // 先取快照再跑：期间用户新发的消息由单条管线处理，不会被卷进这一轮
    const ids = db.listPendingMessages().map((m) => m.id)
    void bulk.run(ids)
    return { count }
  })

  handle(CH.countPending, () => db.countPendingMessages())

  // ── 设置 ──────────────────────────────────────────────
  handle(CH.getSettings, () => getSettings())
  handle(CH.saveSettings, (input: SettingsInput) => saveSettings(input))
  handle(CH.testConnection, () => {
    const s = getSettings()
    return testConnection({ baseUrl: s.baseUrl, model: s.model, apiKey: getApiKey() })
  })

  // ── 数据备份 ──────────────────────────────────────────
  handle(CH.exportData, () => exportData(db))
  handle(CH.importData, () => importData(db))
}
