import { useState } from 'react'
import type { CategoryWithMeta, ConversationId } from '@shared/types'
import { useStore } from '../store'
import { CategoryDialog } from './CategoryDialog'
import { FloatingMenu } from './FloatingMenu'
import { Avatar } from './Avatar'

const KANGAROO_LOGO = new URL('../../../../build/logo.png', import.meta.url).href

function timeLabel(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const yesterday = new Date(now.getTime() - 86400000)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

interface RowProps {
  emoji: string
  avatarSrc?: string
  name: string
  preview: string
  time?: string
  unread?: number
  active: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function Row({
  emoji,
  avatarSrc,
  name,
  preview,
  time,
  unread,
  active,
  onClick,
  onContextMenu
}: RowProps) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
        active ? 'bg-active' : 'hover:bg-hover'
      }`}
    >
      <Avatar name={name} emoji={emoji} imageSrc={avatarSrc} size={40} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{name}</span>
          <span className="shrink-0 text-[11px] text-muted">{time}</span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-[12px] text-muted">{preview}</span>
          {!!unread && (
            <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

export function Sidebar({
  onOpenSettings,
  onOpenSearch,
  onNavigate
}: {
  onOpenSettings: () => void
  onOpenSearch: () => void
  /** 切换会话时通知外层收起设置等浮层 */
  onNavigate: () => void
}) {
  const {
    categories,
    unclassifiedCount,
    trashCount,
    activeId,
    selectConversation,
    refreshCategories,
    showToast
  } = useStore()
  const [dialog, setDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; category: CategoryWithMeta } | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number; category: CategoryWithMeta } | null>(
    null
  )

  const select = (id: ConversationId): void => {
    onNavigate()
    void selectConversation(id)
  }

  /**
   * 删除分类不弹窗打断，改为可撤销的 toast。
   * 分类下的消息不会丢（回到「未分类」），撤销时把分类建回来并把消息挪回去。
   */
  const handleDelete = async (category: CategoryWithMeta): Promise<void> => {
    setMenu(null)
    const affected = await window.api.listMessages({ categoryId: category.id, limit: 200 })
    await window.api.deleteCategory(category.id)
    if (activeId === category.id) await selectConversation('all')
    await refreshCategories()

    showToast(`已删除分类「${category.name}」，${affected.length} 条消息回到「未分类」`, {
      label: '撤销',
      run: () => {
        void (async () => {
          const revived = await window.api.createCategory({
            name: category.name,
            emoji: category.emoji,
            description: category.description
          })
          for (const m of affected) await window.api.moveMessage(m.id, revived.id)
          await refreshCategories()
          showToast(`已恢复分类「${category.name}」`)
        })()
      }
    })
  }

  return (
    <aside className="relative z-40 flex w-[260px] shrink-0 flex-col border-r border-line bg-panel">
      {/* 顶部留给 macOS 红绿灯按钮 */}
      <div className="drag h-11 shrink-0" />

      <div className="no-drag flex shrink-0 items-center gap-2 px-3 pb-2">
        <button
          onClick={onOpenSearch}
          title="搜索消息 (⌘F)"
          className="flex flex-1 items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-left text-[12px] text-muted transition-opacity hover:opacity-80"
        >
          <span className="text-[11px]">🔍</span>
          搜索
        </button>
        <button
          onClick={() => setDialog({ mode: 'create' })}
          title="新建分类"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-base text-muted transition-opacity hover:opacity-80"
        >
          ＋
        </button>
      </div>

      <nav className="no-drag scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        <Row
          emoji=""
          avatarSrc={KANGAROO_LOGO}
          name="袋鼠"
          preview="全部消息 · 发送入口"
          active={activeId === 'all'}
          onClick={() => select('all')}
        />

        <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-muted">分类</div>

        {categories.map((c) => (
          <Row
            key={c.id}
            emoji={c.emoji}
            name={c.name}
            preview={c.lastMessage ?? '暂无消息'}
            time={timeLabel(c.lastMessageAt)}
            unread={c.unreadCount}
            active={activeId === c.id}
            onClick={() => select(c.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, category: c })
            }}
          />
        ))}

        {unclassifiedCount > 0 && (
          <Row
            emoji="❓"
            name="未分类"
            preview={`${unclassifiedCount} 条待处理`}
            active={activeId === 'unclassified'}
            onClick={() => select('unclassified')}
          />
        )}

        {trashCount > 0 && (
          <Row
            emoji="🗑️"
            name="垃圾箱"
            preview={`${trashCount} 项`}
            active={activeId === 'trash'}
            onClick={() => select('trash')}
          />
        )}

        <button
          onClick={() => setDialog({ mode: 'create' })}
          className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted transition-colors hover:bg-hover"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-lg">
            ＋
          </span>
          新建分类
        </button>
      </nav>

      <div className="no-drag shrink-0 border-t border-line p-2">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-muted transition-colors hover:bg-hover"
        >
          ⚙️ 设置
        </button>
      </div>

      {menu && (
        <FloatingMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <>
            <button
              className="w-full px-3 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
              onClick={() => {
                setDialog({ mode: 'edit', category: menu.category })
                setMenu(null)
              }}
            >
              编辑分类
            </button>
            <button
              className="w-full px-3 py-1.5 text-left text-[13px] text-danger hover:bg-hover"
              onClick={() => void handleDelete(menu.category)}
            >
              删除分类
            </button>
          </>
        </FloatingMenu>
      )}

      {dialog && (
        <CategoryDialog
          category={dialog.mode === 'edit' ? dialog.category : null}
          onClose={() => setDialog(null)}
        />
      )}
    </aside>
  )
}
