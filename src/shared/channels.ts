/** IPC 频道名常量 —— 主进程与 preload 共用，避免字符串写错 */
export const CH = {
  ping: 'app:ping',

  sendMessage: 'msg:send',
  listMessages: 'msg:list',
  moveMessage: 'msg:move',
  reclassify: 'msg:reclassify',
  deleteMessage: 'msg:delete',
  restoreMessage: 'msg:restore',
  purgeMessage: 'msg:purge',
  emptyTrash: 'msg:emptyTrash',
  countTrash: 'msg:countTrash',
  search: 'msg:search',

  listCategories: 'cat:list',
  createCategory: 'cat:create',
  updateCategory: 'cat:update',
  deleteCategory: 'cat:delete',
  markRead: 'cat:markRead',
  countUnclassified: 'cat:countUnclassified',

  discoverCategories: 'ai:discover',
  estimateReclassify: 'ai:estimate',
  reclassifyAll: 'ai:reclassifyAll',
  countPending: 'ai:countPending',

  getSettings: 'settings:get',
  saveSettings: 'settings:save',
  testConnection: 'settings:test',

  exportData: 'data:export',
  importData: 'data:import',

  /** 主进程 → 渲染进程推送 */
  messageUpdated: 'push:messageUpdated'
} as const
