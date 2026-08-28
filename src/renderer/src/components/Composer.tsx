import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { useStore } from '../store'

/** 按后缀判断是不是图片 —— 和主进程 images.ts 的 ALLOWED_EXT 保持一致 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 输入区最少 4 行高，内容多了再往上长 */
const MIN_ROWS = 4
const MAX_HEIGHT = 260

export function isImageFile(file: File): boolean {
  return IMAGE_EXT.test(file.name) || file.type.startsWith('image/')
}

/** 待发送的图片：本地预览用 dataUrl，发送时用 bytes */
interface PendingImage {
  id: string
  name: string
  mime: string
  bytes: Uint8Array
  dataUrl: string
}

async function toPending(file: File): Promise<PendingImage> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读取图片失败'))
    fr.readAsDataURL(file)
  })
  // 剪贴板里的图片没有文件名，补一个带正确后缀的
  const name =
    file.name ||
    `粘贴的图片-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`
  return { id: `${Date.now()}-${Math.random()}`, name, mime: file.type, bytes: buf, dataUrl }
}

export function Composer({ placeholder }: { placeholder?: string }) {
  const { send, showToast } = useStore()
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const composingRef = useRef(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 内容超过 4 行才长高，且有上限 —— 否则输入区会把消息列表挤没 */
  const autoGrow = (el: HTMLTextAreaElement): void => {
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22
    const min = line * MIN_ROWS
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), MAX_HEIGHT)}px`
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const picked = files.filter(isImageFile)
    const rejected = files.length - picked.length
    if (rejected > 0) showToast(`已忽略 ${rejected} 个非图片文件`)
    if (picked.length === 0) return
    try {
      const pending = await Promise.all(picked.map(toPending))
      setImages((prev) => [...prev, ...pending])
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  const submit = async (): Promise<void> => {
    const content = text.trim()
    if ((!content && images.length === 0) || sending) return
    setSending(true)
    try {
      if (images.length > 0) {
        // 每张图各自成为一条消息；文字作为第一张图的说明一起发出
        for (let i = 0; i < images.length; i++) {
          const img = images[i]
          await send(i === 0 ? content : '', {
            bytes: img.bytes,
            name: img.name,
            mime: img.mime
          })
        }
      } else {
        await send(content)
      }
      setText('')
      setImages([])
      if (taRef.current) autoGrow(taRef.current)
    } catch (e) {
      showToast(`发送失败：${(e as Error).message}`)
    } finally {
      setSending(false)
      taRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 中文输入法用 Enter 选词时不能误发送
    if (e.key !== 'Enter' || e.shiftKey) return
    if (composingRef.current || e.nativeEvent.isComposing) return
    e.preventDefault()
    void submit()
  }

  return (
    <div
      className={`shrink-0 border-t px-3 pb-3 transition-colors ${
        dragOver ? 'border-accent bg-hover' : 'border-line bg-app'
      }`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      {/* 工具栏在输入区上方 —— 只放我们真有的功能 */}
      <div className="flex items-center gap-1 py-1.5">
        <button
          onClick={() => fileRef.current?.click()}
          title="发送图片"
          className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ImagePlus size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])])
            e.target.value = '' // 允许连续选同一张图
          }}
        />
      </div>

      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {images.map((img) => (
            <div key={img.id} className="group relative">
              <img
                src={img.dataUrl}
                alt={img.name}
                className="h-16 w-16 rounded-lg border border-line object-cover"
              />
              <button
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                title="移除"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-active text-xs text-fg shadow hover:opacity-80"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 无边框、无发送按钮：Enter 发送是 IM 的默认约定，不需要额外说明 */}
      <textarea
        ref={taRef}
        value={text}
        rows={MIN_ROWS}
        disabled={sending}
        onChange={(e) => {
          setText(e.target.value)
          autoGrow(e.target)
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length > 0) {
            e.preventDefault() // 别把文件名当文本粘进来
            void addFiles(files)
          }
        }}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => (composingRef.current = false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? '发送给袋鼠，它会自动帮你归类…'}
        className="selectable scroll-thin block w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-fg outline-none placeholder:text-muted disabled:opacity-60"
        style={{ maxHeight: MAX_HEIGHT }}
      />
    </div>
  )
}
