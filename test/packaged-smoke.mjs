/**
 * 打包产物冒烟测试：直接运行 release 里的 .app，验证打包后（app.isPackaged=true，
 * 不读 .env、走 loadFile 加载页面）依然能正常启动和保存消息。
 *
 * 用法：node test/packaged-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'release/mac-arm64/kangaroo-pocket.app/Contents/MacOS/kangaroo-pocket'
const PORT = 9444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

if (!existsSync(APP)) {
  console.error(`找不到打包产物 ${APP}，请先运行 npm run dist`)
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'collect-pkg-'))
console.log(`启动打包后的应用（独立数据目录）…`)
const app = spawn(APP, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
  stdio: ['ignore', 'pipe', 'pipe']
})
const log = []
app.stdout.on('data', (d) => log.push(d.toString()))
app.stderr.on('data', (d) => log.push(d.toString()))

let ws
try {
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/json`)
      target = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error(`应用未就绪。日志：\n${log.join('')}`)

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })

  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(2000)

  console.log('\n打包产物检查')
  check('页面从本地文件加载成功', await evaluate('return document.readyState === "complete"'))
  check('界面渲染正常', await evaluate('return document.body.innerText.includes("小秘书")'))
  check('IPC 桥接可用', (await evaluate('return await window.api.ping()')) === 'pong')
  const cats = await evaluate('return (await window.api.listCategories()).map(c => c.name)')
  check('种子分类已写入', cats.includes('生活') && cats.includes('工作'), cats.join('、'))
  check('内置「图片」分类已写入', cats.includes('图片'))
  check(
    '渲染进程无 Node 权限',
    await evaluate('return typeof require === "undefined" && typeof process === "undefined"')
  )

  const s = await evaluate('return await window.api.getSettings()')
  check('打包后不读取项目 .env（未预置 Key）', s.hasApiKey === false, `hasApiKey=${s.hasApiKey}`)
  check('默认模型正确', s.model === 'qwen3.6-flash', s.model)

  // 没配 Key 时消息仍必须保住
  await evaluate(`
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '未配置Key时也不能丢消息')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  `)
  await sleep(1500)
  const msgs = await evaluate('return await window.api.listMessages({categoryId:"all"})')
  check('未配置 Key 时消息仍被保存', msgs.length === 1, `${msgs.length} 条`)
  check('内容完好', msgs[0]?.content === '未配置Key时也不能丢消息')
  check(
    '给出可读的失败原因',
    (msgs[0]?.error ?? '').includes('API Key'),
    msgs[0]?.error ?? `status=${msgs[0]?.status}`
  )

  mkdirSync('screenshots', { recursive: true })
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('screenshots/06-打包产物.png', Buffer.from(data, 'base64'))
} catch (e) {
  console.error('\n❌ 异常：', e.message)
  console.error(log.join('').slice(-1500))
  failures++
} finally {
  ws?.close()
  app.kill()
  await sleep(500)
}

console.log(failures === 0 ? '\n✅ 打包产物检查通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
