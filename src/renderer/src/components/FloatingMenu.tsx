import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 右键弹出菜单的共用外壳，负责三件容易做错的事：
 *
 * 1. **钳进视口** —— 直接拿鼠标坐标当左上角，在窗口右侧/底部右键时菜单会有一半在窗外，
 *    而 body 是 overflow:hidden，滚不过去，那些菜单项就永远点不到。
 * 2. **遮罩标 no-drag** —— 遮罩盖住了标题栏拖拽区，若不标 no-drag，
 *    在顶部 44px 内点击「关闭菜单」会被 macOS 的窗口拖拽吞掉，还会把窗口拖走。
 * 3. **Esc 关闭** —— 只靠点遮罩关闭，在上面两种情况下就没有退路了。
 */
export function FloatingMenu({
  x,
  y,
  onClose,
  children
}: {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 先渲染但不可见，量到真实尺寸后再定位，避免闪一下再跳位置
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: x,
    top: y,
    ready: false
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const MARGIN = 8
    const r = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + r.width > window.innerWidth - MARGIN) {
      left = Math.max(MARGIN, window.innerWidth - r.width - MARGIN)
    }
    if (top + r.height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - r.height - MARGIN)
    }
    setPos({ left, top, ready: true })
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div
        className="no-drag fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={ref}
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        className="no-drag scroll-thin fixed z-50 max-h-[70vh] min-w-[160px] overflow-y-auto rounded-lg border border-line bg-panel py-1 shadow-2xl"
      >
        {children}
      </div>
    </>
  )
}
