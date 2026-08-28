import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/channels'
import type {
  Api,
  CategoryInput,
  SendOptions,
  ConversationId,
  ListMessagesOptions,
  Message,
  SettingsInput
} from '../shared/types'

/**
 * 渲染进程唯一的能力入口。只暴露下列白名单方法 —— 没有 fs、没有数据库、
 * 没有 API Key 明文，也不暴露任意 ipcRenderer.invoke。
 */
const api: Api = {
  ping: () => ipcRenderer.invoke(CH.ping),

  sendMessage: (content: string, opts?: SendOptions) =>
    ipcRenderer.invoke(CH.sendMessage, content, opts),
  listMessages: (opts: ListMessagesOptions) => ipcRenderer.invoke(CH.listMessages, opts),
  moveMessage: (id: number, categoryId: number) =>
    ipcRenderer.invoke(CH.moveMessage, id, categoryId),
  reclassify: (id: number) => ipcRenderer.invoke(CH.reclassify, id),
  deleteMessage: (id: number) => ipcRenderer.invoke(CH.deleteMessage, id),
  restoreMessage: (id: number) => ipcRenderer.invoke(CH.restoreMessage, id),
  purgeMessage: (id: number) => ipcRenderer.invoke(CH.purgeMessage, id),
  emptyTrash: () => ipcRenderer.invoke(CH.emptyTrash),
  countTrash: () => ipcRenderer.invoke(CH.countTrash),
  search: (keyword: string) => ipcRenderer.invoke(CH.search, keyword),

  listCategories: () => ipcRenderer.invoke(CH.listCategories),
  createCategory: (input: CategoryInput) => ipcRenderer.invoke(CH.createCategory, input),
  updateCategory: (id: number, input: Partial<CategoryInput>) =>
    ipcRenderer.invoke(CH.updateCategory, id, input),
  deleteCategory: (id: number) => ipcRenderer.invoke(CH.deleteCategory, id),
  markRead: (categoryId: ConversationId) => ipcRenderer.invoke(CH.markRead, categoryId),
  countUnclassified: () => ipcRenderer.invoke(CH.countUnclassified),

  discoverCategories: () => ipcRenderer.invoke(CH.discoverCategories),
  estimateReclassify: () => ipcRenderer.invoke(CH.estimateReclassify),
  reclassifyAll: () => ipcRenderer.invoke(CH.reclassifyAll),
  countPending: () => ipcRenderer.invoke(CH.countPending),

  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke(CH.saveSettings, input),
  testConnection: () => ipcRenderer.invoke(CH.testConnection),

  exportData: () => ipcRenderer.invoke(CH.exportData),
  importData: () => ipcRenderer.invoke(CH.importData),

  onMessageUpdated: (cb: (message: Message) => void) => {
    const listener = (_e: unknown, message: Message): void => cb(message)
    ipcRenderer.on(CH.messageUpdated, listener)
    return () => ipcRenderer.off(CH.messageUpdated, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
