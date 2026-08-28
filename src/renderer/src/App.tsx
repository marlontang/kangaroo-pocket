import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsDialog } from './components/SettingsDialog'
import { SearchPanel } from './components/SearchPanel'

export default function App() {
  const { init, applyUpdate, toast } = useStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    void init()
    // 主进程分类完成后推送结果
    return window.api.onMessageUpdated(applyUpdate)
  }, [init, applyUpdate])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full bg-app">
      {/* 侧栏始终在设置浮层之上、不被遮罩挡住 ——
          这样点分类能一步切过去，而不是「先关设置再点一次」 */}
      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={() => setSearchOpen(true)}
        onNavigate={() => setSettingsOpen(false)}
      />

      <ChatView />

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {searchOpen && (
        <SearchPanel
          onClose={() => setSearchOpen(false)}
          onNavigate={() => setSettingsOpen(false)}
        />
      )}

      {/* pointer-events-none 是必须的：提示条浮在输入框上方，
          没有它就会在 3 秒内吃掉输入框的点击，体感就是「点了没反应」 */}
      {toast && (
        <div className="pointer-events-none fixed bottom-28 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2 text-sm text-fg shadow-2xl">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              onClick={toast.action.run}
              className="pointer-events-auto rounded px-1.5 py-0.5 font-medium text-accent underline-offset-2 hover:underline"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
