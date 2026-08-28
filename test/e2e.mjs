/**
 * 端到端冒烟测试：启动真实应用，通过 CDP 驱动界面，验证
 * 「发送 → AI 分类 → 落到对应分类会话」的完整链路，并截图。
 *
 * 用法：node test/e2e.mjs
 * 使用独立的 --user-data-dir，不污染日常使用的数据。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 9333
const userDataDir = mkdtempSync(join(tmpdir(), 'collect-e2e-'))
const shotDir = join(process.cwd(), 'screenshots')
mkdirSync(shotDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 启动应用 ──────────────────────────────────────────────
console.log(`启动应用（独立数据目录 ${userDataDir}）…`)
const app = spawn(
  'npx',
  ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
const appLog = []
app.stdout.on('data', (d) => appLog.push(d.toString()))
app.stderr.on('data', (d) => appLog.push(d.toString()))

// ── 连接 CDP ──────────────────────────────────────────────
async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error(`应用未在 20 秒内就绪。日志：\n${appLog.join('')}`)
}

const target = await findTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('CDP 连接失败'))
})

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 在渲染进程里求值，返回 JS 值 */
async function evaluate(expression) {
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

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(shotDir, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

/** 切回袋鼠会话 —— 只有这里有输入框（分类会话是只读过滤视图） */
async function gotoSecretary() {
  await evaluate(`
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('袋鼠'))
    if (btn) btn.click()
    return true
  `)
  await sleep(600)
}

/** 走真实 UI 发送一条消息：填输入框 + 点发送，验证 React 事件链路 */
async function sendViaUi(text) {
  await evaluate(`
    const ta = document.querySelector('textarea')
    if (!ta) throw new Error('当前会话没有输入框')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
    // 没有发送按钮，Enter 即发送
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  `)
  await sleep(400)
}

/** 轮询直到条件成立 */
async function waitFor(label, expression, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`return !!(${expression})`)) return true
    await sleep(300)
  }
  return false
}

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500) // 等 React 首屏渲染

  console.log('\n【1】应用启动与 IPC 桥接')
  check('preload 暴露了 window.api', await evaluate('return typeof window.api === "object"'))
  check('IPC 往返正常（ping）', (await evaluate('return await window.api.ping()')) === 'pong')
  check(
    '渲染进程无法直接访问 Node',
    await evaluate('return typeof require === "undefined" && typeof process === "undefined"')
  )
  // 用相对基线而非硬编码数量：内置分类（如「图片」）以后可能增减
  const seedCats = await evaluate('return (await window.api.listCategories()).map(c => c.name)')
  check('种子分类已创建', seedCats.includes('生活') && seedCats.includes('工作'), seedCats.join('、'))
  check('内置「图片」分类已创建', seedCats.includes('图片'))
  check(
    '界面渲染出袋鼠会话',
    await evaluate('return document.body.innerText.includes("袋鼠")')
  )
  await screenshot('01-启动')

  console.log('\n【2】创建业务分类')
  await evaluate(`
    await window.api.createCategory({ name: '项目A', emoji: '🚀', description: 'A 项目（电商App）的需求、进度、bug' })
    await window.api.createCategory({ name: '灵感', emoji: '💡', description: '突发的想法、读到的观点、书影音推荐' })
    return true
  `)
  check(
    '新建的两个分类都出现了',
    (await evaluate('return (await window.api.listCategories()).length')) === seedCats.length + 2
  )

  console.log('\n【3】发送消息 → AI 自动分类')
  const cases = [
    { text: '记得明天下班买牛奶和鸡蛋', expect: '生活' },
    { text: '周五下午3点部门季度复盘会，要准备PPT', expect: '工作' },
    { text: '电商App购物车在iOS 17上点结算会闪退，P0', expect: '项目A' },
    { text: '播客里听到一句：约束是创造力的前提', expect: '灵感' }
  ]

  for (const c of cases) await sendViaUi(c.text)

  check(
    '4 条消息立即出现在袋鼠时间线（不等 AI）',
    (await evaluate('return (await window.api.listMessages({categoryId:"all"})).length')) === 4
  )
  await screenshot('02-发送后分类中')

  const done = await waitFor(
    '分类完成',
    '(await window.api.listMessages({categoryId:"all"})).every(m => m.status !== "pending")',
    90000
  )
  check('全部消息完成分类', done)

  const results = await evaluate(`
    const cats = await window.api.listCategories()
    const msgs = await window.api.listMessages({categoryId:'all'})
    return msgs.map(m => ({
      content: m.content,
      status: m.status,
      error: m.error,
      category: cats.find(c => c.id === m.categoryId)?.name ?? null
    }))
  `)
  for (const c of cases) {
    const got = results.find((r) => r.content === c.text)
    check(`「${c.text.slice(0, 14)}…」→ ${c.expect}`, got?.category === c.expect, got?.category ?? got?.error ?? '未找到')
  }

  console.log('\n【4】分类会话是过滤视图，内容与原文一致')
  const lifeCheck = await evaluate(`
    const cats = await window.api.listCategories()
    const life = cats.find(c => c.name === '生活')
    const msgs = await window.api.listMessages({categoryId: life.id})
    return { count: msgs.length, first: msgs[0]?.content }
  `)
  check('「生活」会话只含 1 条', lifeCheck.count === 1, `实际 ${lifeCheck.count}`)
  check('内容与发送时一字不差', lifeCheck.first === '记得明天下班买牛奶和鸡蛋', lifeCheck.first)

  // 点击侧栏「项目A」，验证界面切换
  await evaluate(`
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('项目A'))
    btn.click()
    return true
  `)
  await sleep(800)
  check(
    '点击侧栏切换到「项目A」会话',
    await evaluate('return document.body.innerText.includes("购物车在iOS 17")')
  )
  await screenshot('03-项目A会话')

  console.log('\n【5】手动纠错')
  const moved = await evaluate(`
    const cats = await window.api.listCategories()
    const work = cats.find(c => c.name === '工作')
    const msgs = await window.api.listMessages({categoryId:'all'})
    const target = msgs.find(m => m.content.includes('购物车'))
    const r = await window.api.moveMessage(target.id, work.id)
    return { status: r.status, category: cats.find(c => c.id === r.categoryId)?.name }
  `)
  check('移动后状态为 manual', moved.status === 'manual', moved.status)
  check('移动到了「工作」', moved.category === '工作', moved.category)

  console.log('\n【6】搜索')
  const found = await evaluate(`
    const r = await window.api.search('牛奶')
    return { n: r.length, text: r[0]?.content }
  `)
  check('搜索命中历史消息', found.n === 1 && found.text.includes('牛奶'), `命中 ${found.n} 条`)
  const esc = await evaluate('return (await window.api.search("%")).length')
  check('LIKE 通配符被转义（搜 % 不匹配全部）', esc === 0, `命中 ${esc} 条`)

  console.log('\n【7】密钥不泄漏到渲染进程')
  const s = await evaluate('return await window.api.getSettings()')
  check('设置只返回掩码，无明文 Key', !!s.apiKeyMask && s.apiKeyMask.includes('****'), s.apiKeyMask)
  check(
    '返回对象不含任何明文 key 字段',
    !JSON.stringify(s).match(/sk-[a-zA-Z0-9]{20,}/),
    Object.keys(s).join(',')
  )

  console.log('\n【8】接口不可用时的容错（消息必须保住）')
  // 分类调用发生在主进程，渲染进程的网络模拟对它无效；
  // 指向一个必然连不上的地址来制造真实的接口故障。
  await evaluate(`
    await window.api.saveSettings({ baseUrl: 'http://127.0.0.1:9/v1' })
    return true
  `)
  await gotoSecretary()
  await sendViaUi('接口故障时发的：记得明天买酱油和醋')
  const savedImmediately = await evaluate(`
    const m = (await window.api.listMessages({categoryId:'all'})).find(m => m.content.includes('酱油'))
    return !!m
  `)
  check('接口不可用时消息仍立即保存', savedImmediately)

  const failed = await waitFor(
    '标记为未分类',
    `(await window.api.listMessages({categoryId:'all'})).find(m => m.content.includes('酱油'))?.status === 'failed'`,
    60000
  )
  check('重试耗尽后标记为「未分类」而非丢弃', failed)
  const failedMsg = await evaluate(`
    return (await window.api.listMessages({categoryId:'all'})).find(m => m.content.includes('酱油'))
  `)
  check('保留了失败原因', !!failedMsg.error, failedMsg.error)
  check('内容完好无损', failedMsg.content === '接口故障时发的：记得明天买酱油和醋')
  await screenshot('04-未分类与重试')

  console.log('\n【9】恢复配置后重试成功')
  await evaluate(`
    await window.api.saveSettings({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })
    const m = (await window.api.listMessages({categoryId:'all'})).find(m => m.content.includes('酱油'))
    await window.api.reclassify(m.id)
    return true
  `)
  const retried = await waitFor(
    '重试完成',
    `(await window.api.listMessages({categoryId:'all'})).find(m => m.content.includes('酱油'))?.status === 'classified'`,
    60000
  )
  check('重试后成功分类', retried)

  console.log('\n【10】删除分类：消息回落而非删除')
  const afterDelete = await evaluate(`
    const cats = await window.api.listCategories()
    const proj = cats.find(c => c.name === '项目A')
    await window.api.deleteCategory(proj.id)
    const msgs = await window.api.listMessages({categoryId:'all'})
    return { total: msgs.length, cats: (await window.api.listCategories()).length }
  `)
  check('分类被删除', afterDelete.cats === seedCats.length + 1, `剩余 ${afterDelete.cats}`)
  check('消息总数不变（未被连带删除）', afterDelete.total === 5, `实际 ${afterDelete.total}`)

  console.log('\n【11】数据持久化（重启应用）')
  const beforeRestart = await evaluate('return (await window.api.listMessages({categoryId:"all"})).length')
  ws.close()
  app.kill()
  await sleep(2000)

  const app2 = spawn(
    'npx',
    ['electron', '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { stdio: 'ignore' }
  )
  await sleep(1000)
  const target2 = await findTarget()
  const ws2 = new WebSocket(target2.webSocketDebuggerUrl)
  await new Promise((res) => (ws2.onopen = res))
  ws2.onmessage = ws.onmessage
  msgId = 0
  pending.clear()
  ws.send = ws2.send.bind(ws2)
  ws2.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await sleep(1500)

  const afterRestart = await evaluate('return (await window.api.listMessages({categoryId:"all"})).length')
  check('重启后消息完整保留', afterRestart === beforeRestart, `${afterRestart}/${beforeRestart}`)
  check(
    '重启后分类完整保留',
    (await evaluate('return (await window.api.listCategories()).length')) === seedCats.length + 1
  )
  const shot = await screenshot('05-重启后')
  console.log(`\n截图已保存到 ${shotDir}`)

  ws2.close()
  app2.kill()
} catch (e) {
  console.error('\n❌ 测试异常中断：', e.message)
  console.error(appLog.join('').slice(-2000))
  failures++
} finally {
  app.kill()
  await sleep(500)
}

console.log(failures === 0 ? '\n✅ 全部端到端检查通过' : `\n❌ ${failures} 项检查失败`)
process.exit(failures === 0 ? 0 : 1)
