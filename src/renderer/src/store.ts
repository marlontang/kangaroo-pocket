import { create } from 'zustand'
import type { CategoryWithMeta, ConversationId, ImageInput, Message, Settings } from '@shared/types'

const PAGE_SIZE = 50

interface State {
  categories: CategoryWithMeta[]
  unclassifiedCount: number
  activeId: ConversationId
  messages: Message[]
  hasMore: boolean
  loading: boolean
  settings: Settings | null
  trashCount: number
  toast: { text: string; action?: { label: string; run: () => void } } | null

  init: () => Promise<void>
  refreshCategories: () => Promise<void>
  selectConversation: (id: ConversationId) => Promise<void>
  loadMore: () => Promise<void>
  send: (content: string, image?: ImageInput) => Promise<void>
  applyUpdate: (message: Message) => void
  moveMessage: (id: number, categoryId: number) => Promise<void>
  reclassify: (id: number) => Promise<void>
  deleteMessage: (id: number) => Promise<void>
  restoreMessage: (id: number) => Promise<void>
  purgeMessage: (id: number) => Promise<void>
  emptyTrash: () => Promise<void>
  refreshSettings: () => Promise<void>
  showToast: (text: string, action?: { label: string; run: () => void }) => void
}

/** 消息是否属于当前会话视图。判定口径要和主进程 db.ts 的 UNCLASSIFIED_WHERE 保持一致。 */
function belongsTo(message: Message, conversationId: ConversationId): boolean {
  // 垃圾箱是独立视图；已删除的消息不出现在任何其他会话里
  if (conversationId === 'trash') return message.deletedAt !== null
  if (message.deletedAt !== null) return false
  if (conversationId === 'all') return true
  // 正在排队分类的消息 categoryId 也是 null，但它不算「未分类」
  if (conversationId === 'unclassified')
    return message.categoryId === null && message.status === 'failed'
  return message.categoryId === conversationId
}

/** 按 id 升序插入，保持时间线有序 */
function insertSorted(list: Message[], message: Message): Message[] {
  const next = [...list, message]
  next.sort((a, b) => a.id - b.id)
  return next
}

export const useStore = create<State>((set, get) => ({
  categories: [],
  unclassifiedCount: 0,
  activeId: 'all',
  messages: [],
  hasMore: false,
  loading: false,
  settings: null,
  trashCount: 0,
  toast: null,

  async init() {
    await Promise.all([get().refreshCategories(), get().refreshSettings()])
    await get().selectConversation('all')
  },

  async refreshCategories() {
    // 「未分类」和「垃圾箱」只在非空时才出现在侧栏
    const [categories, unclassifiedCount, trashCount] = await Promise.all([
      window.api.listCategories(),
      window.api.countUnclassified(),
      window.api.countTrash()
    ])
    set({ categories, unclassifiedCount, trashCount })
  },

  async selectConversation(id) {
    set({ activeId: id, loading: true, messages: [], hasMore: false })
    const messages = await window.api.listMessages({ categoryId: id, limit: PAGE_SIZE })
    set({ messages, hasMore: messages.length === PAGE_SIZE, loading: false })
    await window.api.markRead(id)
    await get().refreshCategories()
  },

  async loadMore() {
    const { messages, activeId, hasMore, loading } = get()
    if (!hasMore || loading || messages.length === 0) return
    set({ loading: true })
    const older = await window.api.listMessages({
      categoryId: activeId,
      beforeId: messages[0].id,
      limit: PAGE_SIZE
    })
    set({
      messages: [...older, ...get().messages],
      hasMore: older.length === PAGE_SIZE,
      loading: false
    })
  },

  async send(content, image) {
    const { activeId } = get()
    // 在分类会话里发的消息直接归入该分类 —— 选了会话就等于指定了归属，
    // 不必再让 AI 猜。小秘书是「全部消息」视图，照样能看到。
    const message = await window.api.sendMessage(content, {
      image,
      ...(typeof activeId === 'number' ? { categoryId: activeId } : {})
    })
    // 小秘书是总时间线，消息立刻出现；分类会话要等分类结果才显示
    if (belongsTo(message, get().activeId)) {
      set({ messages: insertSorted(get().messages, message) })
    }
    await get().refreshCategories()
  },

  applyUpdate(message) {
    const { activeId, messages } = get()
    const index = messages.findIndex((m) => m.id === message.id)
    const shouldShow = belongsTo(message, activeId)

    if (index >= 0 && !shouldShow) {
      // 分类结果把它移出了当前视图
      set({ messages: messages.filter((m) => m.id !== message.id) })
    } else if (index >= 0) {
      const next = [...messages]
      next[index] = message
      set({ messages: next })
    } else if (shouldShow) {
      set({ messages: insertSorted(messages, message) })
    }

    if (shouldShow) void window.api.markRead(activeId)
    void get().refreshCategories()
  },

  async moveMessage(id, categoryId) {
    const updated = await window.api.moveMessage(id, categoryId)
    get().applyUpdate(updated)
  },

  async reclassify(id) {
    const target = get().messages.find((m) => m.id === id)
    await window.api.reclassify(id)
    // 图片是按规则归类的，不会进分类队列，主进程会直接推回结果，
    // 这里不能乐观地标成「分类中」，否则会一直停在那个状态
    if (target?.image) return
    const { activeId, messages } = get()
    // 立即反映「分类中」状态；分类完成后主进程会推送最终结果
    if (activeId === 'all') {
      set({
        messages: messages.map((m) =>
          m.id === id ? { ...m, status: 'pending', categoryId: null, error: null } : m
        )
      })
    } else {
      set({ messages: messages.filter((m) => m.id !== id) })
    }
    await get().refreshCategories()
  },

  /** 移入垃圾箱。不弹窗确认 —— 误删可以从 toast 直接撤销，或去垃圾箱还原。 */
  async deleteMessage(id) {
    await window.api.deleteMessage(id)
    set({ messages: get().messages.filter((m) => m.id !== id) })
    await get().refreshCategories()
    get().showToast('已移到垃圾箱', {
      label: '撤销',
      run: () => void get().restoreMessage(id)
    })
  },

  async restoreMessage(id) {
    const restored = await window.api.restoreMessage(id)
    const { activeId } = get()
    if (activeId === 'trash') {
      set({ messages: get().messages.filter((m) => m.id !== id) })
    } else if (belongsTo(restored, activeId)) {
      set({ messages: insertSorted(get().messages, restored) })
    }
    await get().refreshCategories()
    set({ toast: null })
  },

  async purgeMessage(id) {
    await window.api.purgeMessage(id)
    set({ messages: get().messages.filter((m) => m.id !== id) })
    await get().refreshCategories()
    get().showToast('已彻底删除')
  },

  async emptyTrash() {
    const n = await window.api.emptyTrash()
    if (get().activeId === 'trash') set({ messages: [] })
    await get().refreshCategories()
    get().showToast(`已清空垃圾箱（${n} 项）`)
  },

  async refreshSettings() {
    set({ settings: await window.api.getSettings() })
  },

  showToast(text, action) {
    const toast = { text, action }
    set({ toast })
    // 带撤销按钮的多留一会儿，给用户反应时间
    setTimeout(
      () => {
        if (get().toast === toast) set({ toast: null })
      },
      action ? 6000 : 3000
    )
  }
}))
