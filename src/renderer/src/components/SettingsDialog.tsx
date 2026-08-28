import { useEffect, useRef, useState } from 'react'
import type { DiscoveryResult, ReclassifyEstimate, TestConnectionResult } from '@shared/types'
import { DEFAULT_SECRETARY_PROMPT } from '@shared/defaults'
import { useStore } from '../store'
import { DiscoveryDialog } from './DiscoveryDialog'

const inputClass =
  'selectable w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-fg outline-none focus:border-accent'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, refreshSettings, refreshCategories, showToast } = useStore()
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestConnectionResult | null>(null)

  const [discovering, setDiscovering] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)

  const [estimate, setEstimate] = useState<ReclassifyEstimate | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)

  // 镜像当前值供「动作前先保存」使用。
  // 注意它是在渲染期间赋值的，blur 时可能还没跟上这次输入 ——
  // 所以 onBlur 一律把 e.target.value 显式传进 save()，不依赖这个镜像。
  const latest = useRef({ baseUrl, model, apiKey, prompt })
  latest.current = { baseUrl, model, apiKey, prompt }

  type Draft = {
    baseUrl: string
    model: string
    apiKey: string
    prompt: string
  }

  // 上次从主进程读到的值。只有它真的变了才回填输入框 ——
  // 否则每次 refreshSettings 都会把用户正在编辑的内容冲掉
  const synced = useRef({ baseUrl: '', model: '', prompt: '' })

  useEffect(() => {
    if (!settings) return
    if (settings.baseUrl !== synced.current.baseUrl) {
      synced.current.baseUrl = settings.baseUrl
      setBaseUrl(settings.baseUrl)
    }
    if (settings.model !== synced.current.model) {
      synced.current.model = settings.model
      setModel(settings.model)
    }
    // 识别分类应用新方案后，这里要能同步过来
    if (settings.secretaryPrompt !== synced.current.prompt) {
      synced.current.prompt = settings.secretaryPrompt
      setPrompt(settings.secretaryPrompt)
    }
  }, [settings])

  /**
   * 静默保存。没有保存按钮了，改为失焦即存 ——
   * 但绝不能在键入时存：API Key 打一半就落盘会存进残缺的 Key。
   */
  const save = async (override: Partial<Draft> = {}): Promise<boolean> => {
    const v = { ...latest.current, ...override }
    try {
      await window.api.saveSettings({
        baseUrl: v.baseUrl,
        model: v.model,
        secretaryPrompt: v.prompt,
        // 留空表示不修改已保存的 Key
        ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {})
      })
      if (v.apiKey.trim()) setApiKey('')
      await refreshSettings()
      return true
    } catch (e) {
      showToast(`保存失败：${(e as Error).message}`)
      return false
    }
  }

  const busy = testing || discovering || progress !== null

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      if (!(await save())) {
        setResult({ ok: false, error: '设置保存失败，无法测试' })
        return
      }
      setResult(await window.api.testConnection())
    } catch (e) {
      setResult({ ok: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    try {
      await save()
      setDiscovery(await window.api.discoverCategories())
    } catch (e) {
      showToast(
        (e as Error).message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
      )
    } finally {
      setDiscovering(false)
    }
  }

  const askReclassify = async (): Promise<void> => {
    await save()
    try {
      const est = await window.api.estimateReclassify()
      if (est.count === 0) {
        showToast('没有需要重新分类的消息')
        return
      }
      setEstimate(est)
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  const startReclassify = async (): Promise<void> => {
    const total = estimate?.count ?? 0
    setEstimate(null)
    setProgress({ done: 0, total })
    try {
      await window.api.reclassifyAll()
    } catch (e) {
      showToast(`重新分类失败：${(e as Error).message}`)
      setProgress(null)
    }
  }

  // 分类进行中：轮询剩余条数换算进度
  useEffect(() => {
    if (!progress) return
    const timer = setInterval(async () => {
      const pending = await window.api.countPending()
      if (pending === 0) {
        clearInterval(timer)
        setProgress(null)
        await refreshCategories()
        const unclassified = await window.api.countUnclassified()
        showToast(
          unclassified > 0
            ? `已重新分类 ${progress.total} 条，其中 ${unclassified} 条未能归类`
            : `已重新分类 ${progress.total} 条`
        )
        return
      }
      setProgress((p) => (p ? { ...p, done: Math.max(0, p.total - pending) } : p))
      await refreshCategories()
    }, 1000)
    return () => clearInterval(timer)
    // progress.total 固定，只需在进入/退出进行态时重建定时器
  }, [progress !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  // 忙的时候别让误触关掉，正在跑的动作会失去进度反馈
  const requestClose = (): void => {
    if (!busy) onClose()
  }

  return (
    // 遮罩从侧栏右侧开始 —— 侧栏要保持可点，这样点分类能一步切过去
    <div
      className="no-drag fixed inset-y-0 left-[260px] right-0 z-30 flex items-center justify-center bg-black/45 p-6"
      onClick={requestClose}
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-medium text-fg">设置</h2>
          <button
            onClick={requestClose}
            disabled={busy}
            title={busy ? '有任务进行中' : '关闭'}
            className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-hover disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-6">
            <section>
              <h3 className="mb-3 text-[13px] font-medium text-fg">模型服务</h3>

              <label className="mb-1 block text-xs text-muted">Base URL</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                onBlur={(e) => void save({ baseUrl: e.target.value })}
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                className={`${inputClass} mb-3`}
              />

              <label className="mb-1 block text-xs text-muted">
                API Key
                {settings?.hasApiKey && (
                  <span className="ml-2 text-muted">当前：{settings.apiKeyMask}</span>
                )}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={(e) => void save({ apiKey: e.target.value })}
                placeholder={settings?.hasApiKey ? '留空则不修改' : 'sk-...'}
                className={`${inputClass} mb-1`}
              />
              <p className="mb-3 text-[11px] text-muted">
                Key 使用系统钥匙串加密存储，不会明文落盘。
              </p>

              <label className="mb-1 block text-xs text-muted">模型</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={(e) => void save({ model: e.target.value })}
                placeholder="qwen3.6-flash"
                className={`${inputClass} mb-3`}
              />

              <div className="flex items-center gap-3">
                <button
                  onClick={() => void test()}
                  disabled={busy}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-fg hover:bg-hover disabled:opacity-50"
                >
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {result && (
                  <span className={`text-xs ${result.ok ? 'text-accent' : 'text-danger'}`}>
                    {result.ok ? `连接正常，模型回复：${result.reply}` : result.error}
                  </span>
                )}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[13px] font-medium text-fg">小秘书 System Prompt</h3>
                <button
                  onClick={() => {
                    setPrompt(DEFAULT_SECRETARY_PROMPT)
                    void save({ prompt: DEFAULT_SECRETARY_PROMPT })
                  }}
                  className="text-xs text-accent hover:underline"
                >
                  恢复默认
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onBlur={(e) => void save({ prompt: e.target.value })}
                rows={10}
                className={`${inputClass} resize-none font-mono text-xs leading-relaxed`}
              />
              <p className="mt-1 text-[11px] text-muted">
                修改自动保存。分类候选列表和消息原文会自动附在这段提示词之后，无需手写。
              </p>
            </section>
          </div>
        </div>

        {/* 动作固定在底栏，不跟着内容滚 —— 否则会被弹窗底边裁掉 */}
        <div className="shrink-0 border-t border-line px-5 py-3">
          {estimate ? (
            // 不可逆操作，用行内二次确认而不是模态弹窗打断
            <div className="rounded-lg border border-line bg-raised p-3">
              <p className="text-[13px] text-fg">
                将对 {estimate.count} 条消息重新分类（不含垃圾箱与图片消息）
                {estimate.manualCount > 0 && (
                  <span className="text-warn">
                    ，其中含你手动指定过的 {estimate.manualCount} 条，原有归属会被覆盖
                  </span>
                )}
              </p>
              <p className="mt-1 text-[11px] text-muted">
                约 {estimate.batches} 次模型调用 · 预计输入约{' '}
                {(estimate.estTokens / 10000).toFixed(1)} 万 token · 预计耗时约{' '}
                {estimate.estSeconds} 秒。此操作不可撤销。
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => setEstimate(null)}
                  className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover"
                >
                  取消
                </button>
                <button
                  onClick={() => void startReclassify()}
                  className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
                >
                  确认开始
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-muted">
                识别分类：让 AI 通读你的消息，重新归纳一套分类方案
              </span>
              <button
                onClick={() => void discover()}
                disabled={busy}
                className="rounded-lg border border-line px-4 py-2 text-sm text-fg hover:bg-hover disabled:opacity-50"
              >
                {discovering ? '识别中…' : '识别分类'}
              </button>
              <button
                onClick={() => void askReclassify()}
                disabled={busy}
                className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {progress ? `分类中 ${progress.done}/${progress.total}` : '开始分类'}
              </button>
            </div>
          )}
        </div>
      </div>

      {discovery && <DiscoveryDialog result={discovery} onClose={() => setDiscovery(null)} />}
    </div>
  )
}
