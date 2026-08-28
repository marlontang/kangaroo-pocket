import { app, BrowserWindow, shell } from 'electron'
import { cpSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createDb } from './db'
import { createClassifier } from './classifier'
import { createBulkClassifier } from './bulkClassifier'
import { registerIpc } from './ipc'
import { getApiKey, getSettings } from './settings'
import { registerImageScheme, serveImages } from './images'
import { CH } from '../shared/channels'
import type { Message } from '../shared/types'

// 必须在 app ready 之前注册协议
registerImageScheme()

let mainWindow: BrowserWindow | null = null

function migrateLegacyUserData(): void {
  // Tests and temporary launches provide an isolated directory intentionally.
  if (app.commandLine.hasSwitch('user-data-dir')) return

  const userData = app.getPath('userData')
  const database = join(userData, 'kangaroo-pocket.db')
  if (existsSync(database)) return

  // v0.1 used the old package name as its userData directory. Preserve messages,
  // settings, and images when upgrading to the new application name.
  const legacyDir = join(app.getPath('appData'), 'collect-history')
  if (existsSync(legacyDir) && legacyDir !== userData) {
    for (const name of readdirSync(legacyDir)) {
      const destination = join(userData, name)
      if (!existsSync(destination)) {
        cpSync(join(legacyDir, name), destination, { recursive: true, preserveTimestamps: true })
      }
    }
  }

  const legacyDatabase = join(userData, 'collect_history.db')
  if (existsSync(legacyDatabase) && !existsSync(database)) {
    renameSync(legacyDatabase, database)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'kangaroo-pocket',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 消息里的链接用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const broadcast = (message: Message): void => {
  mainWindow?.webContents.send(CH.messageUpdated, message)
}

app.whenReady().then(() => {
  migrateLegacyUserData()

  // Direct Electron launches otherwise keep Electron's default Dock icon.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = join(app.getAppPath(), 'build', 'logo.png')
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath)
  }

  serveImages()

  const db = createDb(join(app.getPath('userData'), 'kangaroo-pocket.db'))
  db.seedIfEmpty()

  const classifier = createClassifier({
    db,
    getConfig: () => {
      const s = getSettings()
      return {
        baseUrl: s.baseUrl,
        model: s.model,
        apiKey: getApiKey(),
        secretaryPrompt: s.secretaryPrompt
      }
    },
    onUpdate: broadcast
  })

  const bulk = createBulkClassifier({
    db,
    getConfig: () => {
      const s = getSettings()
      return {
        baseUrl: s.baseUrl,
        model: s.model,
        apiKey: getApiKey(),
        secretaryPrompt: s.secretaryPrompt
      }
    },
    onUpdate: broadcast,
    // 批内失配的条目退回单条管线重跑
    enqueueSingle: (id) => classifier.enqueue(id)
  })

  registerIpc({ db, classifier, bulk, broadcast })
  createWindow()
  // 回捞上次退出时未完成分类的消息
  classifier.resumePending()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => db.close())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
