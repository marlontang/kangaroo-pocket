import { app, nativeImage, protocol, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ImageInput, MessageImage } from '../shared/types'

/** 自定义协议：渲染进程只能通过它读到图片目录里的文件，碰不到磁盘其他地方 */
export const IMAGE_SCHEME = 'collect-img'

/** 按后缀判断是不是图片。SVG 可执行脚本，故意排除。 */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const MAX_BYTES = 20 * 1024 * 1024

export function isImageFile(name: string): boolean {
  return ALLOWED_EXT.has(extname(name).toLowerCase())
}

function imageDir(): string {
  const dir = join(app.getPath('userData'), 'images')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 只允许纯文件名，挡掉 ../ 之类的路径穿越 */
function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)
}

export function urlFor(fileName: string): string {
  return `${IMAGE_SCHEME}://local/${fileName}`
}

export function fileNameFromUrl(url: string): string | null {
  const m = url.match(new RegExp(`^${IMAGE_SCHEME}://local/(.+)$`))
  return m && isSafeName(m[1]) ? m[1] : null
}

/**
 * 保存图片到 userData/images 并返回可渲染的描述。
 * 除了看后缀，还会真正解码一次——文件名骗得了后缀，骗不过解码器。
 */
export function saveImage(input: ImageInput): MessageImage {
  if (!isImageFile(input.name)) {
    throw new Error(
      `不支持的文件类型：${extname(input.name) || '无后缀'}（仅支持 png / jpg / gif / webp / bmp）`
    )
  }
  const buf = Buffer.from(input.bytes)
  if (buf.byteLength === 0) throw new Error('图片内容为空')
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`图片过大（${(buf.byteLength / 1024 / 1024).toFixed(1)}MB），上限 20MB`)
  }

  const decoded = nativeImage.createFromBuffer(buf)
  if (decoded.isEmpty()) throw new Error('图片无法解码，可能已损坏或不是真正的图片')
  const { width, height } = decoded.getSize()

  const ext = extname(input.name).toLowerCase()
  const fileName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${ext}`
  writeFileSync(join(imageDir(), fileName), buf)

  return { url: urlFor(fileName), width, height, name: input.name, bytes: buf.byteLength }
}

/** 消息被删除时清掉磁盘上的图片，避免残留 */
export function deleteImage(url: string): void {
  const name = fileNameFromUrl(url)
  if (!name) return
  try {
    rmSync(join(imageDir(), name), { force: true })
  } catch {
    // 删不掉不影响主流程
  }
}

/** 读回原始字节（导出/另存为用） */
export function readImage(url: string): Buffer | null {
  const name = fileNameFromUrl(url)
  if (!name) return null
  const p = join(imageDir(), name)
  return existsSync(p) ? readFileSync(p) : null
}

/** 必须在 app ready 之前调用 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** 在 app ready 之后调用，把协议接到本地图片目录上 */
export function serveImages(): void {
  protocol.handle(IMAGE_SCHEME, (request) => {
    const name = fileNameFromUrl(request.url)
    if (!name) return new Response('bad request', { status: 400 })
    const filePath = join(imageDir(), name)
    if (!existsSync(filePath)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}
