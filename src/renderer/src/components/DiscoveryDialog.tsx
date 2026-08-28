import { useEffect, useState } from 'react'
import type { DiscoveredCategory, DiscoveryResult } from '@shared/types'
import { useStore } from '../store'
import { Avatar } from './Avatar'

/**
 * 把规则和候选列表拼成分类器真正会发出去的样子。
 * 候选列表是运行时从分类表动态生成的，不存进 prompt —— 预览里要让用户看到全貌，
 * 但保存的只有规则部分。
 */
function previewFullPrompt(rules: string, categories: DiscoveredCategory[]): string {
  const list = categories
    .map((c) => `- ${c.name}${c.description ? `：${c.description}` : ''}`)
    .join('\n')
  return `${rules}

────── 以下由程序自动附加 ──────
可选分类（名称：说明）：
${list}

待分类的信息：
"""
<消息原文>
"""`
}

export function DiscoveryDialog({
  result,
  onClose
}: {
  result: DiscoveryResult
  onClose: () => void
}) {
  const { categories: existing, refreshCategories, refreshSettings, showToast } = useStore()
  const [step, setStep] = useState<1 | 2>(1)
  const [rows, setRows] = useState<DiscoveredCategory[]>(result.categories)
  const [rules] = useState(result.secretaryPrompt)
  const [confirming, setConfirming] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, applying])

  const valid = rows.filter((r) => r.name.trim())
  // 「图片」是系统分类，永远不参与替换
  const replaceable = existing.filter((c) => !c.isSystem)

  const apply = async (): Promise<void> => {
    setApplying(true)
    setError('')
    try {
      const keep = new Set(valid.map((r) => r.name.trim()))

      // 替换式：方案里没有的旧分类直接删掉（用户确认过旧归属不需要保留）
      for (const old of replaceable) {
        if (!keep.has(old.name)) await window.api.deleteCategory(old.id)
      }
      for (const row of valid) {
        const name = row.name.trim()
        const hit = replaceable.find((c) => c.name === name)
        if (hit) {
          await window.api.updateCategory(hit.id, { description: row.description.trim() })
        } else {
          await window.api.createCategory({ name, description: row.description.trim() })
        }
      }
      await window.api.saveSettings({ secretaryPrompt: rules })

      await refreshCategories()
      await refreshSettings()
      showToast(`分类方案已应用（${valid.length} 个分类），请点击开始分类`)
      onClose()
    } catch (e) {
      setError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
      )
      setApplying(false)
      setConfirming(false)
    }
  }

  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={() => !applying && onClose()}
    >
      <div
        className="scroll-thin flex max-h-[calc(100vh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-medium text-fg">
            {step === 1 ? 'AI 识别出的分类方案' : '确认 System Prompt'}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {step === 1
              ? `基于最近 ${result.sampledCount} 条消息归纳。应用后将替换现有分类（「图片」除外）`
              : '这是分类器实际会用到的完整提示词'}
          </p>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
          {step === 1 ? (
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="pt-1.5">
                    <Avatar name={row.name.trim() || '新'} size={32} />
                  </div>
                  <div className="flex-1 space-y-1">
                    <input
                      value={row.name}
                      onChange={(e) =>
                        setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                      }
                      placeholder="分类名"
                      className="selectable w-full rounded-lg border border-line bg-raised px-2.5 py-1.5 text-[13px] font-medium text-fg outline-none focus:border-accent"
                    />
                    <textarea
                      value={row.description}
                      rows={2}
                      onChange={(e) =>
                        setRows(
                          rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r))
                        )
                      }
                      placeholder="分类说明 —— 告诉分类器什么消息该归这里"
                      className="selectable w-full resize-none rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent"
                    />
                  </div>
                  <button
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    title="删除这个分类"
                    className="mt-1.5 rounded px-2 py-1 text-xs text-muted hover:bg-hover hover:text-danger"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setRows([...rows, { name: '', description: '' }])}
                className="w-full rounded-lg border border-dashed border-line py-2 text-xs text-muted hover:bg-hover"
              >
                ＋ 添加分类
              </button>
            </div>
          ) : (
            <>
              <pre className="selectable scroll-thin max-h-[46vh] overflow-auto whitespace-pre-wrap rounded-lg bg-raised p-3 font-mono text-[11px] leading-relaxed text-fg">
                {previewFullPrompt(rules, valid)}
              </pre>
              <p className="mt-2 text-[11px] text-muted">
                候选分类列表由分类表自动生成，保存进设置的只有上方分隔线以上的规则部分。
              </p>
            </>
          )}

          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-xs text-muted">{step === 1 ? `${valid.length} 个分类` : ''}</span>

          {step === 1 ? (
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="rounded-lg px-4 py-1.5 text-sm text-muted hover:bg-hover"
              >
                取消
              </button>
              <button
                onClick={() => setStep(2)}
                disabled={valid.length === 0}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                下一步
              </button>
            </div>
          ) : confirming ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">
                将用 {valid.length} 个新分类替换现有 {replaceable.length} 个，并覆盖 System Prompt
              </span>
              <button
                onClick={() => setConfirming(false)}
                className="rounded px-2 py-1 text-muted hover:bg-hover"
              >
                取消
              </button>
              <button
                onClick={() => void apply()}
                disabled={applying}
                className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {applying ? '应用中…' : '确认应用'}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(previewFullPrompt(rules, valid))
                  showToast('已复制完整提示词')
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover"
              >
                复制
              </button>
              <button
                onClick={() => setStep(1)}
                className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover"
              >
                返回
              </button>
              <button
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                确认应用
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
