import { useEffect, useState } from 'react'
import type { Category } from '@shared/types'
import { useStore } from '../store'

export function CategoryDialog({
  category,
  onClose
}: {
  category: Category | null
  onClose: () => void
}) {
  const { refreshCategories, showToast } = useStore()
  const [name, setName] = useState(category?.name ?? '')
  const [description, setDescription] = useState(category?.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('请填写分类名')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (category) {
        await window.api.updateCategory(category.id, { name, emoji: '', description })
      } else {
        await window.api.createCategory({ name, emoji: '', description })
      }
      await refreshCategories()
      showToast(category ? '分类已更新' : `已创建分类「${name.trim()}」`)
      onClose()
    } catch (e) {
      // 主进程已经把「重名」「空名」翻译成可读文案，这里直接展示
      setError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
      )
      setSaving(false)
    }
  }

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      {/* 限高 + 滚动：矮窗口（最小 560px 高）下不限高会把底部按钮推出视口，
          而 body 是 overflow:hidden，滚不到，按钮就点不着了 */}
      <div
        className="scroll-thin max-h-[calc(100vh-3rem)] w-full max-w-md overflow-y-auto rounded-xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-[15px] font-medium text-fg">
          {category ? '编辑分类' : '新建分类'}
        </h2>

        <label className="mb-1 block text-xs text-muted">分类名</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：项目A"
          className="selectable mb-4 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />

        <label className="mb-1 block text-xs text-muted">
          分类说明 —— 告诉袋鼠什么样的消息该归到这里
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="例如：A 项目的需求、进度、bug、和客户的沟通记录"
          className="selectable mb-2 w-full resize-none rounded-lg border border-line bg-raised px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        />
        <p className="mb-4 text-[11px] text-muted">说明写得越具体，分类越准。</p>

        {error && <p className="mb-3 text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-hover"
          >
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
