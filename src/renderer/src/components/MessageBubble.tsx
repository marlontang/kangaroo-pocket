import { useEffect, useState } from 'react'
import type { Message } from '@shared/types'
import { useStore } from '../store'
import { FloatingMenu } from './FloatingMenu'
import { Avatar } from './Avatar'

/**
 * 气泡右侧的头像。
 * 这个应用只有一个发送者，放固定头像没信息量 —— 显示消息归入的分类，
 * 时间线就能一眼扫出每条落到哪儿了。
 */
function MessageAvatar({ message }: { message: Message }) {
  const { categories } = useStore()
  const category = categories.find((c) => c.id === message.categoryId)

  if (category) return <Avatar name={category.name} emoji={category.emoji} size={36} />

  // 还没归类的用符号占位，不用文字头像 —— 文字头像意味着「属于某个分类」
  if (message.status === 'pending') {
    return (
      <span
        title="分类中"
        className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-raised text-base opacity-50"
      >
        ⏳
      </span>
    )
  }

  // 头像只表达状态，不承担操作 —— 重试走右键菜单的「重新分类」，
  // 同一个操作没必要有两个入口。失败原因放 title 里备查。
  return (
    <span
      title={`未分类${message.error ? ` · ${message.error}` : ''}（右键可重新分类）`}
      className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-raised text-base"
    >
      ❓
    </span>
  )
}

/** 全屏大图。Esc 或点击空白处关闭。 */
function ImagePreview({
  image,
  onClose
}: {
  image: NonNullable<Message['image']>
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="no-drag fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/85 p-10"
      onClick={onClose}
    >
      <img
        src={image.url}
        alt={image.name}
        className="max-h-[calc(100vh-9rem)] max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="mt-3 text-center text-xs text-white/70">
        {image.name} · {image.width}×{image.height} · {(image.bytes / 1024).toFixed(0)} KB
      </div>
      <button
        onClick={onClose}
        className="absolute right-6 top-6 rounded-lg bg-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/25"
      >
        关闭
      </button>
    </div>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const {
    categories,
    activeId,
    moveMessage,
    reclassify,
    deleteMessage,
    restoreMessage,
    purgeMessage,
    showToast
  } = useStore()
  const inTrash = activeId === 'trash'
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [preview, setPreview] = useState(false)

  const closeMenu = (): void => setMenu(null)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(message.content || message.image?.name || '')
    showToast('已复制')
    closeMenu()
  }

  // 不弹窗确认 —— 删除只是移入垃圾箱，toast 上还能直接撤销
  const remove = async (): Promise<void> => {
    closeMenu()
    await deleteMessage(message.id)
  }

  return (
    // 头像固定在右侧顶部；气泡靠 flex 收缩到内容宽度，最宽占满剩余空间。
    // 加了头像后右侧多出约 44px 的视觉重量，两侧边距相应收到 24px。
    <div className="flex items-start justify-end gap-2 px-6">
      <div className="flex min-w-0 max-w-full flex-col items-end">
        {/*
          中性灰气泡：饱和色块长时间盯着很刺眼，层次靠「比底色浅一档」来表达。
          换行用 overflow-wrap:anywhere 而不是 break-words —— 后者只在渲染时断行，
          不参与 min-content 宽度计算，遇到 ASCII 表格框线、长 URL 这类
          「整串没有断点」的内容时，flex 仍按不可断来算宽度，气泡会被撑爆。
        */}
        <div
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          className={
            message.image
              ? 'overflow-hidden rounded-lg bg-raised'
              : 'selectable whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-raised px-3.5 py-3 text-[14px] leading-relaxed text-raised-fg'
          }
        >
          {message.image ? (
            <>
              {/* 气泡里只放预览图，点击才看原图 —— 长图不该把整个时间线撑开 */}
              <button
                onClick={() => setPreview(true)}
                title={`${message.image.name} · ${message.image.width}×${message.image.height} · 点击查看大图`}
                className="group relative block w-full cursor-zoom-in"
              >
                <img
                  src={message.image.url}
                  alt={message.image.name}
                  loading="lazy"
                  className="block max-h-[220px] w-auto max-w-full object-contain"
                />
                <span className="pointer-events-none absolute inset-0 flex items-end justify-end p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                    点击看大图
                  </span>
                </span>
              </button>
              {message.content && (
                <div className="selectable whitespace-pre-wrap [overflow-wrap:anywhere] px-3.5 py-3 text-[14px] leading-relaxed text-raised-fg">
                  {message.content}
                </div>
              )}
            </>
          ) : (
            message.content
          )}
        </div>
      </div>

      <MessageAvatar message={message} />

      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <>
            <button
              className="w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
              onClick={() => void copy()}
            >
              复制
            </button>
            {!message.image && !inTrash && (
              <button
                className="w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
                onClick={() => {
                  void reclassify(message.id)
                  closeMenu()
                }}
              >
                重新分类
              </button>
            )}

            {categories.length > 0 && !inTrash && (
              <>
                <div className="mt-1 border-t border-line px-3 pb-1 pt-1.5 text-[11px] text-muted">
                  移动到
                </div>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    disabled={c.id === message.categoryId}
                    className="w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-hover disabled:opacity-40"
                    onClick={() => {
                      void moveMessage(message.id, c.id)
                      closeMenu()
                    }}
                  >
                    {c.emoji} {c.name}
                  </button>
                ))}
              </>
            )}

            <div className="mt-1 border-t border-line pt-1">
              {inTrash ? (
                <>
                  <button
                    className="w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
                    onClick={() => {
                      void restoreMessage(message.id)
                      closeMenu()
                    }}
                  >
                    还原
                  </button>
                  <button
                    className="w-full px-3 py-1.5 text-left text-[13px] text-danger hover:bg-hover"
                    onClick={() => {
                      void purgeMessage(message.id)
                      closeMenu()
                    }}
                  >
                    彻底删除
                  </button>
                </>
              ) : (
                <button
                  className="w-full px-3 py-1.5 text-left text-[13px] text-danger hover:bg-hover"
                  onClick={() => void remove()}
                >
                  删除
                </button>
              )}
            </div>
          </>
        </FloatingMenu>
      )}

      {preview && message.image && (
        <ImagePreview image={message.image} onClose={() => setPreview(false)} />
      )}
    </div>
  )
}
