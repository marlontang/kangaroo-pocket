import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/**
 * 每条消息上方的时间。近的只显示时刻，远的补上日期 ——
 * 「今天 14:32」这种冗余信息没必要占位置。
 */
function timeLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const clock = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`

  if (d.toDateString() === now.toDateString()) return clock
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) {
    return `昨天 ${clock}`
  }
  // 一周内用星期几，更好认
  if (now.getTime() - d.getTime() < 7 * 86400000) return `${WEEKDAYS[d.getDay()]} ${clock}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`
}

/**
 * 居中的时间药丸。上下留白按参考 IM 的实测节奏：上 30px、药丸 20px、下 14px。
 * 注意别用 first: 变体 —— 每个药丸都是自己那层 wrapper 的第一个子元素，
 * 那样写会对所有药丸生效。
 */
function TimeDivider({ ts }: { ts: number }) {
  return (
    <div className="mb-3.5 mt-[30px] flex justify-center">
      <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] leading-4 text-muted">
        {timeLabel(ts)}
      </span>
    </div>
  )
}

/** 垃圾箱底部的操作条。清空不可逆，用行内二次确认，不打断为弹窗。 */
function TrashBar() {
  const { messages, emptyTrash } = useStore()
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-3">
      <span className="text-xs text-muted">
        {messages.length > 0 ? '右键任意消息可「还原」或「彻底删除」' : '垃圾箱是空的'}
      </span>
      {messages.length > 0 &&
        (confirming ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-muted">确定彻底删除全部？不可恢复</span>
            <button
              onClick={() => setConfirming(false)}
              className="rounded px-2 py-1 text-muted hover:bg-hover"
            >
              取消
            </button>
            <button
              onClick={() => {
                void emptyTrash()
                setConfirming(false)
              }}
              className="rounded bg-danger px-2.5 py-1 font-medium text-white hover:opacity-90"
            >
              清空
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="rounded-lg px-3 py-1 text-xs text-danger hover:bg-hover"
          >
            清空垃圾箱
          </button>
        ))}
    </div>
  )
}

function EmptyState({ isSecretary, isTrash }: { isSecretary: boolean; isTrash?: boolean }) {
  const { settings } = useStore()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-4xl">{isTrash ? '🗑️' : isSecretary ? '🗂️' : '📭'}</div>
      <p className="text-sm text-muted">
        {isTrash
          ? '垃圾箱是空的。删除的消息会先放到这里，随时可以还原。'
          : isSecretary
            ? '把任何想记的东西发给袋鼠，它会自动归类到对应的联系人。'
            : '这个分类还没有消息。到袋鼠那里发送，符合条件的会自动出现在这里。'}
      </p>
      {isSecretary && settings && !settings.hasApiKey && (
        <p className="mt-1 rounded-lg border border-line px-3 py-1.5 text-xs text-warn">
          还没配置 API Key，消息会被保存但不会自动分类 —— 请先到「设置」填写。
        </p>
      )}
    </div>
  )
}

export function ChatView() {
  const { messages, activeId, categories, loading, hasMore, loadMore } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(0)
  const prevCountRef = useRef(0)
  const prevActiveRef = useRef(activeId)

  const isSecretary = activeId === 'all'
  const isTrash = activeId === 'trash'
  // 真实分类也能直接发消息（虚拟会话「未分类」「垃圾箱」不行）
  const canCompose = isSecretary || typeof activeId === 'number'
  const active = categories.find((c) => c.id === activeId)
  const title = isSecretary
    ? '袋鼠'
    : isTrash
      ? '垃圾箱'
      : activeId === 'unclassified'
        ? '未分类'
        : (active?.name ?? '')
  const subtitle = isSecretary
    ? '全部消息 · 在这里发送'
    : isTrash
      ? '删除的消息暂存在这里，可以还原'
      : activeId === 'unclassified'
        ? '袋鼠没能归类的消息，右键可手动指定'
        : (active?.description ?? '')

  // 切会话或有新消息时贴底；向上翻页加载历史时保持视口位置不跳
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const switched = prevActiveRef.current !== activeId
    const grewAtTop = messages.length > prevCountRef.current && el.scrollTop < 80 && !switched

    if (switched || !grewAtTop) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    } else {
      el.scrollTop = el.scrollHeight - prevHeightRef.current
    }

    prevHeightRef.current = el.scrollHeight
    prevCountRef.current = messages.length
    prevActiveRef.current = activeId
  }, [messages, activeId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      if (el.scrollTop < 60 && hasMore && !loading) void loadMore()
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [hasMore, loading, loadMore])

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="drag flex h-11 shrink-0 items-center gap-2 border-b border-line px-5">
        <span className="shrink-0 text-[14px] font-medium text-fg">{title}</span>
        {subtitle && <span className="truncate text-[12px] text-muted">{subtitle}</span>}
      </header>

      <div ref={scrollRef} className="scroll-thin flex-1 overflow-y-auto py-3">
        {messages.length === 0 && !loading ? (
          <EmptyState isSecretary={isSecretary} isTrash={isTrash} />
        ) : (
          // 消息少于一屏时贴着底部排列，符合 IM 习惯
          <div className="flex min-h-full flex-col justify-end">
            {hasMore && (
              <div className="py-2 text-center text-[11px] text-muted">
                {loading ? '加载中…' : '向上滚动加载更多'}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id}>
                <TimeDivider ts={m.createdAt} />
                <MessageBubble message={m} />
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {canCompose ? (
        <Composer placeholder={isSecretary ? undefined : `发送到「${title}」…`} />
      ) : isTrash ? (
        <TrashBar />
      ) : (
        <div className="shrink-0 border-t border-line px-4 py-3 text-center text-xs text-muted">
          袋鼠没能归类的消息会出现在这里，右键可手动指定分类
        </div>
      )}
    </section>
  )
}
