import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  documents: '',
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.documents },
  dialog: {
    showSaveDialog: mocks.showSaveDialog,
    showOpenDialog: mocks.showOpenDialog
  },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) })
  },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  net: { fetch: vi.fn() }
}))

import { exportData, importData } from '../src/main/backup'
import { createDb } from '../src/main/db'
import { readImage, saveImage } from '../src/main/images'

beforeEach(() => {
  mocks.documents = mkdtempSync(join(tmpdir(), 'kangaroo-backup-test-'))
  mocks.showSaveDialog.mockReset()
  mocks.showOpenDialog.mockReset()
})

describe('JSON 数据备份', () => {
  it('导出版本化格式且不包含设置或 API Key', async () => {
    const db = createDb(':memory:')
    db.seedIfEmpty()
    db.insertMessage('需要备份的内容')
    const filePath = join(mocks.documents, 'backup.json')
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath })

    const result = await exportData(db)
    const raw = readFileSync(filePath, 'utf-8')
    const backup = JSON.parse(raw)

    expect(result).toMatchObject({ canceled: false, messages: 1, images: 0 })
    expect(backup).toMatchObject({ format: 'kangaroo-pocket-backup', version: 1 })
    expect(backup.messages[0].content).toBe('需要备份的内容')
    expect(raw).not.toContain('apiKey')
    expect(raw).not.toContain('secretaryPrompt')
  })

  it('取消文件对话框时不读写数据', async () => {
    const db = createDb(':memory:')
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    await expect(exportData(db)).resolves.toEqual({
      canceled: true,
      categories: 0,
      messages: 0,
      images: 0
    })
  })

  it('从合法备份合并导入分类与消息', async () => {
    const filePath = join(mocks.documents, 'backup.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        format: 'kangaroo-pocket-backup',
        version: 1,
        exportedAt: '2026-08-28T00:00:00.000Z',
        categories: [
          {
            sourceId: 7,
            name: '项目A',
            description: 'A 项目',
            sortOrder: 1,
            createdAt: 100,
            isSystem: false
          }
        ],
        messages: [
          {
            sourceId: 9,
            content: '导入内容',
            categorySourceId: 7,
            status: 'classified',
            createdAt: 200,
            classifiedAt: 201,
            error: null,
            deletedAt: null,
            image: null
          }
        ]
      }),
      'utf-8'
    )
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    const db = createDb(':memory:')
    db.seedIfEmpty()

    const result = await importData(db)

    expect(result).toMatchObject({ canceled: false, categories: 1, messages: 1, images: 0 })
    const category = db.listCategories().find((item) => item.name === '项目A')!
    expect(db.listMessages({ categoryId: category.id }).map((item) => item.content)).toEqual([
      '导入内容'
    ])
  })

  it('拒绝未知格式，不修改数据库', async () => {
    const filePath = join(mocks.documents, 'bad.json')
    writeFileSync(filePath, JSON.stringify({ format: 'other', version: 1 }), 'utf-8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    const db = createDb(':memory:')

    await expect(importData(db)).rejects.toThrow('不是受支持的')
    expect(db.exportSnapshot().messages).toHaveLength(0)
  })

  it('图片经过 Base64 备份后可以重新落盘', async () => {
    const filePath = join(mocks.documents, 'images.json')
    const source = createDb(':memory:')
    source.seedIfEmpty()
    const image = saveImage({
      bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
      name: 'note.png',
      mime: 'image/png'
    })
    source.insertMessage('', {
      image,
      categoryId: source.imageCategory().id,
      status: 'classified'
    })
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    await exportData(source)

    const target = createDb(':memory:')
    target.seedIfEmpty()
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
    const result = await importData(target)
    const imported = target.listMessages({ categoryId: target.imageCategory().id })[0]

    expect(result.images).toBe(1)
    expect(imported.image?.name).toBe('note.png')
    expect(readImage(imported.image!.url)).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]))
  })
})
