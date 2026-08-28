/** 主进程与渲染进程共享的类型契约。改动这里要同步 docs/TECH_DESIGN.md 第 5 节。 */

/** 消息分类状态 */
export type MessageStatus =
  | 'pending' // 待分类（已落库，排队中）
  | 'classified' // AI 已分类
  | 'manual' // 用户手动指定
  | 'failed' // 分类失败或无匹配 —— UI 显示为「未分类」

/** 消息附带的图片（MVP 一条消息最多一张） */
export interface MessageImage {
  /** collect-img:// 开头的可渲染地址 */
  url: string
  width: number
  height: number
  /** 原始文件名，用于「另存为」和展示 */
  name: string
  bytes: number
}

export interface Message {
  id: number
  /** 用户输入原文，永不被改写。带图片时可为空（纯图片消息） */
  content: string
  categoryId: number | null
  status: MessageStatus
  createdAt: number
  classifiedAt: number | null
  /** status 为 failed 时的原因，用于 UI 提示与排查 */
  error: string | null
  /** 非空表示在垃圾箱里 */
  deletedAt: number | null
  image: MessageImage | null
}

export interface Category {
  id: number
  name: string
  emoji: string
  /** 给 LLM 的分类说明 */
  description: string
  sortOrder: number
  createdAt: number
  /**
   * 系统内置分类（目前只有「文件」）。特点：
   * - 不可删除
   * - 不参与 AI 分类的候选（文字消息永远不会被归到这里）
   * - 图片按规则直接落入，不调用模型
   */
  isSystem: boolean
}

/** 侧栏用：分类 + 最后一条消息摘要 + 未读数 */
export interface CategoryWithMeta extends Category {
  lastMessage: string | null
  lastMessageAt: number | null
  unreadCount: number
}

/** 特殊会话 id：小秘书（全部消息）与未分类 */
export type ConversationId = number | 'all' | 'unclassified' | 'trash'

export interface ListMessagesOptions {
  categoryId: ConversationId
  /** 分页游标：只取 id 小于该值的消息（向上翻页） */
  beforeId?: number
  limit?: number
}

export interface Settings {
  baseUrl: string
  model: string
  secretaryPrompt: string
  /** 只读掩码，如 sk-3fa2****cdef；保存时传明文 apiKey 字段 */
  apiKeyMask: string
  hasApiKey: boolean
}

export interface SettingsInput {
  baseUrl?: string
  model?: string
  secretaryPrompt?: string
  /** 明文；不传表示不修改 */
  apiKey?: string
}

/** AI 归纳出的一个分类 */
export interface DiscoveredCategory {
  name: string
  description: string
}

export interface DiscoveryResult {
  categories: DiscoveredCategory[]
  /** 只含判断规则，不含候选列表 —— 列表由 classifier 每次动态拼接 */
  secretaryPrompt: string
  /** 实际参与归纳的消息条数，给界面显示 */
  sampledCount: number
}

/** 全量重跑的成本预估，用于二次确认弹窗 */
export interface ReclassifyEstimate {
  count: number
  /** 其中手动指定过分类的条数 —— 这些也会被覆盖，必须如实告知 */
  manualCount: number
  batches: number
  estTokens: number
  estSeconds: number
}

export interface TestConnectionResult {
  ok: boolean
  error?: string
  /** 成功时模型返回的内容，便于确认链路通畅 */
  reply?: string
}

export interface CategoryInput {
  name: string
  emoji?: string
  description?: string
}

export interface SendOptions {
  image?: ImageInput
  /**
   * 直接指定分类：在某个分类会话里发送时用。
   * 选了会话就等于指定了归属，不需要再让 AI 猜。
   */
  categoryId?: number
}

/** 渲染进程发送图片时的载荷 */
export interface ImageInput {
  /** 原始字节 */
  bytes: Uint8Array
  /** 原始文件名，用来取后缀判断是不是图片 */
  name: string
  mime: string
}

/** 主进程推送给渲染进程的事件 */
export interface MessageUpdatedEvent {
  message: Message
}

export interface Api {
  ping(): Promise<string>

  sendMessage(content: string, opts?: SendOptions): Promise<Message>
  listMessages(opts: ListMessagesOptions): Promise<Message[]>
  moveMessage(id: number, categoryId: number): Promise<Message>
  reclassify(id: number): Promise<void>
  /** 移入垃圾箱（软删除），可还原 */
  deleteMessage(id: number): Promise<Message>
  /** 从垃圾箱还原 */
  restoreMessage(id: number): Promise<Message>
  /** 彻底删除单条，不可恢复 */
  purgeMessage(id: number): Promise<void>
  /** 清空垃圾箱，返回清掉的条数 */
  emptyTrash(): Promise<number>
  countTrash(): Promise<number>
  search(keyword: string): Promise<Message[]>

  listCategories(): Promise<CategoryWithMeta[]>
  createCategory(input: CategoryInput): Promise<Category>
  updateCategory(id: number, input: Partial<CategoryInput>): Promise<Category>
  deleteCategory(id: number): Promise<void>
  markRead(categoryId: ConversationId): Promise<void>
  /** 未分类消息数（不含正在排队分类的） */
  countUnclassified(): Promise<number>

  /** 让 AI 通读消息后归纳一套分类方案 */
  discoverCategories(): Promise<DiscoveryResult>
  /** 全量重跑前的条数与成本预估 */
  estimateReclassify(): Promise<ReclassifyEstimate>
  /** 全量重新分类，返回参与重跑的条数 */
  reclassifyAll(): Promise<{ count: number }>
  /** 还在排队分类的条数，用于进度显示 */
  countPending(): Promise<number>

  getSettings(): Promise<Settings>
  saveSettings(input: SettingsInput): Promise<Settings>
  testConnection(): Promise<TestConnectionResult>

  /** 返回取消订阅函数 */
  onMessageUpdated(cb: (message: Message) => void): () => void
}
