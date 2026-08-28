import { useEffect, useState } from 'react'
import type { Message } from '@shared/types'
import { useStore } from '../store'

function highlight(text: string, keyword: string): React.ReactNode {
  const i = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (i < 0) return text.slice(0, 120)
  // 命中位置居中截取，让关键词始终可见
  const start = Math.max(0, i - 30)
  const snippet = text.slice(start, start + 120)
  const at = snippet.toLowerCase().indexOf(keyword.toLowerCase())
  return (
    <>
      {start > 0 && '…'}
      {snippet.slice(0, at)}
      <mark className="rounded bg-accent/30 px-0.5 text-fg">
        {snippet.slice(at, at + keyword.length)}
      </mark>
      {snippet.slice(at + keyword.length)}
      {text.length > start + 120 && '…'}
    </>
  )
}

export function SearchPanel({
  onClose,
  onNavigate
}: {
  onClose: () => void
  onNavigate: () => void
}) {
  const { categories, selectConversation } = useStore()
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const kw = keyword.trim()
    if (!kw) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(async () => {
      setResults(await window.api.search(kw))
      setSearching(false)
    }, 200)
    return () => clearTimeout(timer)
  }, [keyword])

  const jump = async (m: Message): Promise<void> => {
    await selectConversation(m.categoryId ?? 'all')
    // 在设置页也能用 ⌘F，跳转时必须切回聊天页，否则关掉面板还停在设置页，
    // 用户完全看不到跳转发生
    onNavigate()
    onClose()
  }

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex h-fit max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="搜索所有消息…"
          className="selectable shrink-0 border-b border-line bg-transparent px-4 py-3.5 text-[15px] text-fg outline-none placeholder:text-muted"
        />

        <div className="scroll-thin overflow-y-auto">
          {keyword.trim() && !searching && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted">没有找到包含该关键词的消息</p>
          )}
          {results.map((m) => {
            const c = categories.find((x) => x.id === m.categoryId)
            return (
              <button
                key={m.id}
                onClick={() => void jump(m)}
                className="block w-full border-b border-line px-4 py-3 text-left last:border-0 hover:bg-hover"
              >
                <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                  <span>{c ? `${c.emoji} ${c.name}` : '❓ 未分类'}</span>
                  <span>{new Date(m.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="text-sm leading-relaxed text-fg">
                  {highlight(m.content, keyword.trim())}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
