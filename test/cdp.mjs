/**
 * 共享的 CDP 测试骨架：启动 Electron 应用并通过 Chrome DevTools Protocol 驱动界面。
 * 供 e2e.mjs（数据链路）与 ui.mjs（界面交互）复用。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 创建一个统计通过/失败的检查器 */
export function createChecker() {
  const state = { failures: 0, total: 0 }
  const check = (name, ok, detail = '') => {
    state.total++
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) state.failures++
  }
  check.state = state
  return check
}

/**
 * 启动应用并连上 CDP。
 * @param {{ appPath?: string, port?: number, reuseUserData?: string }} opts
 *   appPath 省略时用 `npx electron .` 跑构建产物；传入则直接运行打包后的可执行文件。
 */
export async function launch(opts = {}) {
  const port = opts.port ?? 9333
  const userDataDir = opts.reuseUserData ?? mkdtempSync(join(tmpdir(), 'collect-test-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    // 测试窗口通常不在前台，Chromium 会把隐藏页面的 setTimeout 节流到每秒一次，
    // 导致轮询式断言出现「恰好 1000ms」的假失败。测试环境下关掉这些节流。
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'
  ]

  const proc = opts.appPath
    ? spawn(opts.appPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npx', ['electron', '.', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

  const log = []
  proc.stdout?.on('data', (d) => log.push(d.toString()))
  proc.stderr?.on('data', (d) => log.push(d.toString()))

  // 等应用起来并暴露出可调试的页面
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/json`)
      target = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) {
    proc.kill()
    throw new Error(`应用未在 20 秒内就绪。日志：\n${log.join('')}`)
  }

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1500) // 等 React 首屏渲染

  return { proc, cdp, userDataDir, port, log, errors: cdp.errors, kill: () => proc.kill() }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })

  let id = 0
  const pending = new Map()
  // 收集渲染进程的报错 —— 界面「没反应」十有八九是这里悄悄抛了异常
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails
      errors.push(d?.exception?.description ?? d?.text ?? '未知异常')
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, (m) =>
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      )
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  /** 在渲染进程里求值。传入的代码用 return 返回结果，支持 await。 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
    }
    return r.result.value
  }

  const screenshot = async (name) => {
    mkdirSync('screenshots', { recursive: true })
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    const path = join('screenshots', `${name}.png`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  /** 轮询直到表达式为真 */
  const waitFor = async (expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await evaluate(`return !!(${expression})`)) return true
      await sleep(200)
    }
    return false
  }

  return { ws, send, evaluate, screenshot, waitFor, errors, close: () => ws.close() }
}

// ── 界面操作helper —— 都走真实 DOM 事件，不直接调 window.api ──────────

/** 注入一批工具函数到页面，后续操作复用 */
export async function installHelpers(cdp) {
  await cdp.evaluate(`
    window.__t = {
      // 按可见文字精确匹配一个按钮
      btn(text) {
        return [...document.querySelectorAll('button')]
          .find(b => b.textContent.trim() === text) || null
      },
      // 按可见文字模糊匹配一个按钮
      btnLike(text) {
        return [...document.querySelectorAll('button')]
          .find(b => b.textContent.includes(text)) || null
      },
      // React 受控组件必须走原生 setter 才能触发 onChange
      setValue(el, value) {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      rightClick(el) {
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.top + r.height / 2)
        }))
      },
      // React 的 onBlur 监听的是冒泡的 focusout，不是 blur。
      // 直接派发 focusout 比 focus()+blur() 稳 —— 后者依赖窗口的系统焦点，
      // CDP 驱动时窗口未必在前台，会时灵时不灵。
      blur(el) {
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      },
      // 没有发送按钮了，Enter 就是发送 —— 统一走这个入口
      enter(el) {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true
        }))
      },
      key(el, key, opts = {}) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
      },
      text() { return document.body.innerText },
      // 判断某个元素中心点是否真的能被点到（没有被其他元素遮挡）
      topmostAt(el) {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2)
        )
        if (hit === el || el.contains(hit)) return null
        if (!hit) return '视口外或不可命中'
        // 遮挡物常常是无文字的透明遮罩，光取 textContent 会得到空串（而空串不是 nullish，
        // ?? 兜底不生效），所以带上标签名和类名才认得出是谁
        const label = (hit.textContent || '').trim().slice(0, 16)
        return hit.tagName.toLowerCase() +
          (label ? '「' + label + '」' : '') +
          ' .' + String(hit.className || '(无类名)').split(' ').slice(0, 4).join('.')
      },
      // 取元素的实际背景色，返回 {r,g,b} 与饱和度（0~1）
      bgOf(el) {
        // 注意这段代码在模板字符串里，正则的反斜杠必须写成 \\d ——
        // 否则 \d 会被模板字符串当转义序列吃掉，正则变成 /d+/g 永远匹配不到
        const m = getComputedStyle(el).backgroundColor.match(/\\d+/g)
        if (!m) return null
        const [r, g, b] = m.map(Number)
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
        return { r, g, b, sat: mx === 0 ? 0 : (mx - mn) / mx }
      },
      // 找出所有「落在标题栏拖拽区里、却没标 no-drag」的交互元素。
      // 这类元素在 macOS 上鼠标点不动 —— 事件被窗口拖拽逻辑吞掉；
      // 而 element.click() 会绕过命中测试，所以普通点击断言测不出来。
      dragTrapped() {
        // 不能用 offsetParent 判断可见性：position:fixed 元素的 offsetParent 恒为 null，
        // 而这类元素恰恰最容易压在拖拽区上。
        const visible = (el) => {
          const s = getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const inNoDrag = (el) => {
          for (let n = el; n; n = n.parentElement) {
            const region = getComputedStyle(n).webkitAppRegion
            if (region === 'no-drag') return true
            if (region === 'drag') return false
          }
          return false
        }
        // 用矩形相交而非中心点：fixed 元素在 DOM 上不是 drag 区的后代，
        // 但只要几何上压上去就会被吞，哪怕只压到一角。
        const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
        const dragRects = [...document.querySelectorAll('*')]
          .filter(n => getComputedStyle(n).webkitAppRegion === 'drag')
          .map(n => n.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0)

        return [...document.querySelectorAll('button, input, textarea, select, a[href], [role="button"]')]
          .filter(el => visible(el) && !el.disabled)
          .filter(el => getComputedStyle(el).pointerEvents !== 'none')
          .filter(el => dragRects.some(d => hit(el.getBoundingClientRect(), d)) && !inNoDrag(el))
          .map(el => (el.textContent || el.placeholder || el.tagName).trim().slice(0, 24))
      },
      // 覆盖整个视口的遮罩层：要么标 no-drag（否则顶部 44px 点不到、还会拖走窗口），
      // 要么整层不吃事件。
      overlaysTrapped() {
        const inNoDrag = (el) => {
          for (let n = el; n; n = n.parentElement) {
            const r = getComputedStyle(n).webkitAppRegion
            if (r === 'no-drag') return true
            if (r === 'drag') return false
          }
          return false
        }
        return [...document.querySelectorAll('div')]
          .filter(el => {
            const s = getComputedStyle(el)
            if (s.position !== 'fixed' || s.pointerEvents === 'none') return false
            const r = el.getBoundingClientRect()
            return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && r.top < 5
          })
          .filter(el => !inNoDrag(el))
          .map(el => el.className.slice(0, 50) || 'div')
      },
      // 浮层（右键菜单、弹窗）必须完整落在视口内，否则里面的项点不到 ——
      // body 是 overflow:hidden，滚不过去。
      offscreenFloaters() {
        return [...document.querySelectorAll('div')]
          .filter(el => {
            const s = getComputedStyle(el)
            if (s.position !== 'fixed') return false
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return false
            // 只看菜单/卡片这类小浮层，跳过全屏遮罩
            if (r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9) return false
            return el.querySelector('button') !== null
          })
          .filter(el => {
            const r = el.getBoundingClientRect()
            return r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight
          })
          .map(el => {
            const r = el.getBoundingClientRect()
            // 注意：这段代码会被塞进外层模板字符串里 eval，不能用反引号/取值插值
            return (el.textContent || '').trim().slice(0, 14) +
              ' [' + Math.round(r.left) + ',' + Math.round(r.top) +
              ' → ' + Math.round(r.right) + ',' + Math.round(r.bottom) +
              ' 视口 ' + innerWidth + 'x' + innerHeight + ']'
          })
      }
    }
    // 弹窗确认自动通过，避免测试卡住
    window.confirm = () => true
    return true
  `)
}

/** 点击文字完全匹配的按钮，返回是否找到 */
export const clickBtn = (cdp, text) =>
  cdp.evaluate(`
    const b = window.__t.btn(${JSON.stringify(text)})
    if (!b) return false
    b.click()
    return true
  `)

/** 点击文字包含指定内容的按钮 */
export const clickBtnLike = (cdp, text) =>
  cdp.evaluate(`
    const b = window.__t.btnLike(${JSON.stringify(text)})
    if (!b) return false
    b.click()
    return true
  `)

/** 页面可见文字里是否包含某段内容 */
export const seesText = (cdp, text) =>
  cdp.evaluate(`return window.__t.text().includes(${JSON.stringify(text)})`)

/** 往选择器命中的第一个输入框填值 */
export const fill = (cdp, selector, value) =>
  cdp.evaluate(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    window.__t.setValue(el, ${JSON.stringify(value)})
    return true
  `)
