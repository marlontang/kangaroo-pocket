import { app, dialog } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BackupCategory,
  BackupFile,
  BackupImage,
  BackupMessage,
  DataTransferResult,
  MessageStatus
} from '../shared/types'
import type { Db, ImportedMessage } from './db'
import { deleteImage, readImage, saveImage } from './images'

const FORMAT = 'kangaroo-pocket-backup'
const VERSION = 1
const MAX_BACKUP_BYTES = 1024 ** 4
const STATUSES = new Set<MessageStatus>(['pending', 'classified', 'manual', 'failed'])

function backupFileName(): string {
  const date = new Date().toISOString().slice(0, 10)
  return `kangaroo-pocket-backup-${date}.json`
}

function emptyResult(canceled: boolean): DataTransferResult {
  return { canceled, categories: 0, messages: 0, images: 0 }
}

export async function exportData(db: Db): Promise<DataTransferResult> {
  const picked = await dialog.showSaveDialog({
    title: '导出 kangaroo-pocket 数据',
    defaultPath: join(app.getPath('documents'), backupFileName()),
    filters: [{ name: 'kangaroo-pocket JSON 备份', extensions: ['json'] }]
  })
  if (picked.canceled || !picked.filePath) return emptyResult(true)

  const snapshot = db.exportSnapshot()
  let imageCount = 0
  const messages: BackupMessage[] = snapshot.messages.map((message) => {
    let image: BackupImage | null = null
    if (message.image) {
      const bytes = readImage(message.image.url)
      if (!bytes) throw new Error(`图片文件缺失：${message.image.name}`)
      imageCount++
      image = {
        name: message.image.name,
        width: message.image.width,
        height: message.image.height,
        bytes: bytes.byteLength,
        dataBase64: bytes.toString('base64')
      }
    }
    return {
      sourceId: message.id,
      content: message.content,
      categorySourceId: message.categoryId,
      status: message.status,
      createdAt: message.createdAt,
      classifiedAt: message.classifiedAt,
      error: message.error,
      deletedAt: message.deletedAt,
      image
    }
  })

  const backup: BackupFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    categories: snapshot.categories.map((category) => ({
      sourceId: category.id,
      name: category.name,
      description: category.description,
      sortOrder: category.sortOrder,
      createdAt: category.createdAt,
      isSystem: category.isSystem
    })),
    messages
  }

  const serialized = JSON.stringify(backup, null, 2)
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BACKUP_BYTES) {
    throw new Error('备份文件超过 1 TB，无法导出')
  }
  writeFileSync(picked.filePath, serialized, 'utf-8')
  return {
    canceled: false,
    filePath: picked.filePath,
    categories: backup.categories.length,
    messages: backup.messages.length,
    images: imageCount
  }
}

export async function importData(db: Db): Promise<DataTransferResult> {
  const picked = await dialog.showOpenDialog({
    title: '导入 kangaroo-pocket 数据',
    properties: ['openFile'],
    filters: [{ name: 'kangaroo-pocket JSON 备份', extensions: ['json'] }]
  })
  const filePath = picked.filePaths[0]
  if (picked.canceled || !filePath) return emptyResult(true)
  if (statSync(filePath).size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 1 TB，无法导入')

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  const backup = validateBackup(raw)

  const savedUrls: string[] = []
  try {
    const messages: ImportedMessage[] = backup.messages.map((message) => {
      let image = null
      if (message.image) {
        const bytes = decodeImage(message.image)
        image = saveImage({ bytes, name: message.image.name, mime: '' }, MAX_BACKUP_BYTES)
        savedUrls.push(image.url)
      }
      return { ...message, image }
    })
    const summary = db.importBackup(backup.categories, messages)
    return { canceled: false, filePath, ...summary }
  } catch (error) {
    for (const url of savedUrls) deleteImage(url)
    throw error
  }
}

function validateBackup(value: unknown): BackupFile {
  if (!isRecord(value) || value.format !== FORMAT || value.version !== VERSION) {
    throw new Error('不是受支持的 kangaroo-pocket 备份文件')
  }
  if (!Array.isArray(value.categories) || !Array.isArray(value.messages)) {
    throw new Error('备份缺少分类或消息数据')
  }
  const categoryIds = new Set<number>()
  const categories = value.categories.map((item, index) => {
    if (!isRecord(item)) throw new Error(`第 ${index + 1} 个分类格式错误`)
    const sourceId = positiveInteger(item.sourceId, '分类 ID')
    if (categoryIds.has(sourceId)) throw new Error(`分类 ID 重复：${sourceId}`)
    categoryIds.add(sourceId)
    const name = requiredString(item.name, '分类名', 100).trim()
    if (!name) throw new Error('分类名不能为空')
    return {
      sourceId,
      name,
      description: optionalString(item.description, '分类说明', 10_000),
      sortOrder: finiteNumber(item.sortOrder, '分类顺序'),
      createdAt: timestamp(item.createdAt, '分类创建时间'),
      isSystem: item.isSystem === true
    } satisfies BackupCategory
  })

  const messageIds = new Set<number>()
  const messages = value.messages.map((item, index) => {
    if (!isRecord(item)) throw new Error(`第 ${index + 1} 条消息格式错误`)
    const sourceId = positiveInteger(item.sourceId, '消息 ID')
    if (messageIds.has(sourceId)) throw new Error(`消息 ID 重复：${sourceId}`)
    messageIds.add(sourceId)
    const categorySourceId =
      item.categorySourceId === null
        ? null
        : positiveInteger(item.categorySourceId, '消息分类 ID')
    if (categorySourceId !== null && !categoryIds.has(categorySourceId)) {
      throw new Error(`消息 ${sourceId} 引用了不存在的分类`)
    }
    if (typeof item.status !== 'string' || !STATUSES.has(item.status as MessageStatus)) {
      throw new Error(`消息 ${sourceId} 的状态无效`)
    }
    return {
      sourceId,
      content: requiredString(item.content, '消息内容', 10_000_000),
      categorySourceId,
      status: item.status as MessageStatus,
      createdAt: timestamp(item.createdAt, '消息创建时间'),
      classifiedAt: nullableTimestamp(item.classifiedAt, '消息分类时间'),
      error: nullableString(item.error, '消息错误信息', 10_000),
      deletedAt: nullableTimestamp(item.deletedAt, '消息删除时间'),
      image: item.image === null ? null : validateImage(item.image, sourceId)
    } satisfies BackupMessage
  })

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: requiredString(value.exportedAt, '导出时间', 100),
    categories,
    messages
  }
}

function validateImage(value: unknown, messageId: number): BackupImage {
  if (!isRecord(value)) throw new Error(`消息 ${messageId} 的图片格式错误`)
  const dataBase64 = requiredString(value.dataBase64, '图片数据', Number.MAX_SAFE_INTEGER)
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new Error(`消息 ${messageId} 的图片数据损坏`)
  }
  const bytes = positiveInteger(value.bytes, '图片大小')
  return {
    name: requiredString(value.name, '图片名称', 500),
    width: positiveInteger(value.width, '图片宽度'),
    height: positiveInteger(value.height, '图片高度'),
    bytes,
    dataBase64
  }
}

function decodeImage(image: BackupImage): Uint8Array {
  const bytes = Buffer.from(image.dataBase64, 'base64')
  if (bytes.byteLength !== image.bytes) {
    throw new Error(`图片数据大小不匹配：${image.name}`)
  }
  return new Uint8Array(bytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式错误`)
  return value
}

function optionalString(value: unknown, label: string, max: number): string {
  if (value === undefined) return ''
  return requiredString(value, label, max)
}

function nullableString(value: unknown, label: string, max: number): string | null {
  if (value === null) return null
  return requiredString(value, label, max)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}格式错误`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const n = finiteNumber(value, label)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}格式错误`)
  return n
}

function timestamp(value: unknown, label: string): number {
  const n = finiteNumber(value, label)
  if (n < 0) throw new Error(`${label}格式错误`)
  return n
}

function nullableTimestamp(value: unknown, label: string): number | null {
  if (value === null) return null
  return timestamp(value, label)
}
