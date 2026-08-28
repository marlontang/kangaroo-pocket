import { useRef, useState } from 'react'
import {
  FileInput,
  FileOutput,
  Image as ImageIcon,
  Menu as MenuIcon,
  MessageCircle,
  Plus,
  Search,
  Trash2,
  type LucideIcon
} from 'lucide-react'
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
  avatarSrc?: string
  icon?: LucideIcon
  iconTone?: 'neutral' | 'image' | 'trash'
  name: string
  preview: string
  time?: string
  unread?: number
  active: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function Row({
  avatarSrc,
  icon,
  iconTone,
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
      <Avatar name={name} imageSrc={avatarSrc} icon={icon} iconTone={iconTone} size={40} />
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
  const [dataMenu, setDataMenu] = useState<{ x: number; y: number } | null>(null)
  const [transferring, setTransferring] = useState<'import' | 'export' | null>(null)
  const dataButtonRef = useRef<HTMLButtonElement>(null)

  const select = (id: ConversationId): void => {
    onNavigate()
    void selectConversation(id)
  }

  const toggleDataMenu = (): void => {
    if (dataMenu) {
      setDataMenu(null)
      return
    }
    const rect = dataButtonRef.current?.getBoundingClientRect()
    if (rect) setDataMenu({ x: rect.left, y: rect.top })
  }

  const runTransfer = async (kind: 'import' | 'export'): Promise<void> => {
    setDataMenu(null)
    setTransferring(kind)
    try {
      const result =
        kind === 'import' ? await window.api.importData() : await window.api.exportData()
      if (result.canceled) return
      if (kind === 'import') {
        await selectConversation(activeId)
        showToast(
          `已导入 ${result.messages} 条消息、${result.categories} 个新分类、${result.images} 张图片`
        )
      } else {
        showToast(
          `已导出 ${result.messages} 条消息、${result.categories} 个分类、${result.images} 张图片`
        )
      }
    } catch (error) {
      showToast(`${kind === 'import' ? '导入' : '导出'}失败：${(error as Error).message}`)
    } finally {
      setTransferring(null)
    }
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
            emoji: '',
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
    <aside className="relative z-40 flex w-[324px] shrink-0">
      {/* QQ 式左侧功能栏：顶端仍保留 macOS 红绿灯的安全区域。 */}
      <nav className="flex w-16 shrink-0 flex-col border-r border-line bg-rail">
        <div className="drag h-11 shrink-0" />

        <div className="no-drag flex flex-col items-center gap-1.5 px-2 py-1">
          <button
            onClick={() => select('all')}
            title="消息"
            aria-label="消息"
            className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
              activeId !== 'unclassified' && activeId !== 'trash'
                ? 'bg-active text-fg'
                : 'text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            <MessageCircle size={22} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">消息</span>
          </button>

          <button
            onClick={onOpenSettings}
            title="小袋鼠"
            aria-label="小袋鼠"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <img
              src={KANGAROO_LOGO}
              alt=""
              className="monochrome-logo h-6 w-6 rounded-full object-cover"
            />
            <span className="sr-only">小袋鼠</span>
          </button>

        </div>

        <div className="no-drag mt-auto flex flex-col items-center gap-1.5 px-2 pb-2">
          <button
            onClick={() => select('trash')}
            title="垃圾箱"
            aria-label="垃圾箱"
            className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
              activeId === 'trash'
                ? 'bg-active text-fg'
                : 'text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            <Trash2 size={20} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">垃圾箱</span>
          </button>
          <button
            ref={dataButtonRef}
            onClick={toggleDataMenu}
            disabled={transferring !== null}
            title="数据菜单"
            aria-label="数据菜单"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <MenuIcon size={20} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">数据菜单</span>
          </button>
        </div>
      </nav>

      {/* 中栏只承载搜索和会话列表，与右侧聊天内容职责分离。 */}
      <div className="flex w-[260px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="drag h-11 shrink-0" />

        <div className="no-drag flex shrink-0 items-center gap-2 px-3 pb-2">
          <button
            onClick={onOpenSearch}
            title="搜索消息 (⌘F)"
            className="flex flex-1 items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-left text-[12px] text-muted transition-opacity hover:opacity-80"
          >
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            搜索
          </button>
          <button
            onClick={() => setDialog({ mode: 'create' })}
            title="新建分类"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-base text-muted transition-opacity hover:opacity-80"
          >
            <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">新建分类</span>
          </button>
        </div>

        <nav className="no-drag scroll-thin flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          <Row
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
              icon={c.isSystem ? ImageIcon : undefined}
              iconTone={c.isSystem ? 'image' : undefined}
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

          <Row
            name="未分类"
            preview={unclassifiedCount > 0 ? '待处理消息' : '暂无消息'}
            active={activeId === 'unclassified'}
            onClick={() => select('unclassified')}
          />
        </nav>
      </div>

      {dataMenu && (
        <FloatingMenu
          x={dataMenu.x}
          y={dataMenu.y}
          placement="above"
          onClose={() => setDataMenu(null)}
        >
          <button
            onClick={() => void runTransfer('import')}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-fg hover:bg-hover"
          >
            <FileInput size={16} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
            导入数据
          </button>
          <button
            onClick={() => void runTransfer('export')}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-fg hover:bg-hover"
          >
            <FileOutput size={16} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
            导出数据
          </button>
        </FloatingMenu>
      )}

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
