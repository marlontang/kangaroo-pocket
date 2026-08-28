/**
 * 界面交互测试：把每一个可点击元素都真的点一遍，验证它做了该做的事。
 *
 * 与 e2e.mjs 的区别：e2e 验证的是数据链路（发送 → 分类 → 落库 → 持久化），
 * 大量直接调 window.api；本文件**只走真实 DOM 事件**，专门覆盖那些
 * 「逻辑没问题但界面点不动」的问题，例如元素被遮挡、状态没刷新、弹窗关不掉。
 *
 * 用法：node test/ui.mjs
 */
import { launch, installHelpers, createChecker, clickBtn, clickBtnLike, seesText, fill, sleep } from './cdp.mjs'

const check = createChecker()
let app

/** 每个分组前打印标题 */
const group = (title) => console.log(`\n【${title}】`)

try {
  console.log('启动应用（独立数据目录）…')
  app = await launch({ port: 9355 })
  const { cdp } = app
  await installHelpers(cdp)

  const evaluate = (e) => cdp.evaluate(e)

  // ══════════════════════════════════════════════════════
  // 这一组用几何关系而非点击来断言 —— element.click() 会绕过命中测试，
  // 抓不到「被遮挡」和「被拖拽区吞掉」这两类真实鼠标才会遇到的问题。
  group('可点击性（真实鼠标能不能点到）')

  const trappedChat = await evaluate(`return window.__t.dragTrapped()`)
  check('聊天页没有被标题栏拖拽区吞掉的按钮', trappedChat.length === 0, trappedChat.join('、'))

  const searchBlocker = await evaluate(`
    const b = window.__t.btnLike('搜索')
    return b ? window.__t.topmostAt(b) : '按钮不存在'
  `)
  check('侧栏搜索入口没有被遮挡', searchBlocker === null, searchBlocker ?? '')

  check('侧栏左上角没有元素压住 macOS 红绿灯按钮', await evaluate(`
    // trafficLightPosition 设的是 x:16 y:18，按钮直径约 12px，整片区域约 80×36
    const hits = [...document.querySelectorAll('button, input, textarea, a[href]')]
      .filter(el => el.offsetParent !== null)
      .filter(el => {
        const r = el.getBoundingClientRect()
        return r.left < 88 && r.top < 40 && r.width > 0 && r.height > 0
      })
    return hits.length === 0
  `))

  // ══════════════════════════════════════════════════════
  group('侧栏导航')

  check('初始停在「袋鼠」会话', await seesText(cdp, '全部消息 · 在这里发送'))

  check('点击「生活」切换会话', (await clickBtnLike(cdp, '生活')) && (await sleep(600), await seesText(cdp, '日常生活、购物')))
  check('分类会话没有输入框（只读过滤视图）', !(await evaluate('return !!document.querySelector("textarea")')))
  check('点击「袋鼠」切回总时间线', (await clickBtnLike(cdp, '袋鼠')) && (await sleep(600), await evaluate('return !!document.querySelector("textarea")')))

  // ══════════════════════════════════════════════════════
  group('新建分类弹窗')

  check('点击「新建分类」打开弹窗', (await clickBtnLike(cdp, '新建分类')) && (await sleep(400), await seesText(cdp, '分类说明')))

  check('空名保存时给出提示', await evaluate(`
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 300))
    return window.__t.text().includes('请填写分类名')
  `))

  check('分类弹窗不再显示 emoji 头像选择器', await evaluate(`
    return !window.__t.text().includes('头像') &&
      ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '🚀')
  `))



  check('点击「取消」关闭弹窗且不创建', await evaluate(`
    const input = document.querySelector('input')
    window.__t.setValue(input, '临时分类')
    await new Promise(r => setTimeout(r, 100))
    window.__t.btn('取消').click()
    await new Promise(r => setTimeout(r, 400))
    const closed = !window.__t.text().includes('分类说明')
    const notCreated = !window.__t.btnLike('临时分类')
    return closed && notCreated
  `))

  check('填写后「保存」成功创建分类', await evaluate(`
    window.__t.btnLike('新建分类').click()
    await new Promise(r => setTimeout(r, 400))
    const [nameInput] = document.querySelectorAll('input')
    window.__t.setValue(nameInput, '项目A')
    window.__t.setValue(document.querySelector('textarea'), 'A 项目（电商App）的需求、进度、bug')
    await new Promise(r => setTimeout(r, 150))
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 800))
    return !!window.__t.btnLike('项目A')
  `))

  check('创建成功后弹出 toast', await seesText(cdp, '已创建分类'))

  check('重名时提示「已存在同名分类」', await evaluate(`
    window.__t.btnLike('新建分类').click()
    await new Promise(r => setTimeout(r, 400))
    window.__t.setValue(document.querySelectorAll('input')[0], '项目A')
    await new Promise(r => setTimeout(r, 150))
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 800))
    const shown = window.__t.text().includes('已存在同名分类')
    window.__t.btn('取消').click()
    await new Promise(r => setTimeout(r, 300))
    return shown
  `))

  // ══════════════════════════════════════════════════════
  group('分类右键菜单')

  check('右键分类弹出菜单', await evaluate(`
    window.__t.rightClick(window.__t.btnLike('项目A'))
    await new Promise(r => setTimeout(r, 300))
    return window.__t.text().includes('编辑分类') && window.__t.text().includes('删除分类')
  `))

  check('「编辑分类」可改名并保存', await evaluate(`
    window.__t.btn('编辑分类').click()
    await new Promise(r => setTimeout(r, 400))
    window.__t.setValue(document.querySelectorAll('input')[0], '项目Alpha')
    await new Promise(r => setTimeout(r, 150))
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 800))
    return !!window.__t.btnLike('项目Alpha') && !window.__t.btnLike('项目A（')
  `))

  check('「删除分类」确认后移除', await evaluate(`
    window.__t.rightClick(window.__t.btnLike('项目Alpha'))
    await new Promise(r => setTimeout(r, 300))
    window.__t.btn('删除分类').click()
    await new Promise(r => setTimeout(r, 900))
    return !window.__t.btnLike('项目Alpha')
  `))

  // 后面的消息测试需要一个分类，补回来。
  // 必须等弹窗真正关闭再往下走 —— 弹窗的 fixed inset-0 遮罩会盖住整个界面，
  // 而 element.click() 绕过命中测试照样能「点」到被遮住的按钮，
  // 于是后续的遮挡类断言会莫名其妙地失败。
  await evaluate(`
    window.__t.btnLike('新建分类').click()
    await new Promise(r => setTimeout(r, 400))
    window.__t.setValue(document.querySelectorAll('input')[0], '项目A')
    window.__t.setValue(document.querySelector('textarea'), 'A 项目（电商App）的需求、进度、bug')
    await new Promise(r => setTimeout(r, 150))
    window.__t.btn('保存').click()
    return true
  `)
  check('新建分类弹窗保存后自动关闭', await cdp.waitFor(`!window.__t.text().includes('分类说明')`, 15000))

  // ══════════════════════════════════════════════════════
  group('设置页')

  check('点击「设置」进入设置页', (await clickBtnLike(cdp, '设置')) && (await sleep(500), await seesText(cdp, '模型服务')))

  // ← 用户报告的 bug：返回按钮被 fixed 定位的搜索按钮盖住
  const blocker = await evaluate(`
    const back = window.__t.btn('返回')
    if (!back) return '按钮不存在'
    return window.__t.topmostAt(back)
  `)
  check('「返回」按钮没有被其他元素遮挡', blocker === null, blocker ? `被「${blocker}」挡住` : '')

  const trappedSettings = await evaluate(`return window.__t.dragTrapped()`)
  check('设置页没有被拖拽区吞掉的控件', trappedSettings.length === 0, trappedSettings.join('、'))

  check('点击「返回」回到聊天页（而非打开搜索）', await evaluate(`
    window.__t.btn('返回').click()
    await new Promise(r => setTimeout(r, 600))
    const backToChat = window.__t.text().includes('全部消息 · 在这里发送')
    const searchNotOpened = !document.querySelector('input[placeholder="搜索所有消息…"]')
    return backToChat && searchNotOpened
  `))

  check('设置页里侧栏搜索依然可用（不被设置页遮挡）', await evaluate(`
    window.__t.btnLike('设置').click()
    await new Promise(r => setTimeout(r, 500))
    const b = window.__t.btnLike('搜索')
    return !!b && window.__t.topmostAt(b) === null
  `))

  check('「恢复默认」重置 System Prompt', await evaluate(`
    const ta = [...document.querySelectorAll('textarea')].pop()
    window.__t.setValue(ta, '被改坏的提示词')
    await new Promise(r => setTimeout(r, 200))
    window.__t.btn('恢复默认').click()
    await new Promise(r => setTimeout(r, 300))
    return ta.value.includes('袋鼠信息分拣助手')
  `))

  check('修改模型名并「保存」后持久化', await evaluate(`
    const inputs = [...document.querySelectorAll('input')]
    const modelInput = inputs.find(i => i.placeholder === 'qwen3.6-flash')
    window.__t.setValue(modelInput, 'qwen-test-model')
    await new Promise(r => setTimeout(r, 200))
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 800))
    const saved = (await window.api.getSettings()).model === 'qwen-test-model'
    // 改回来，免得影响后面的分类测试
    window.__t.setValue(modelInput, 'qwen3.6-flash')
    await new Promise(r => setTimeout(r, 200))
    window.__t.btn('保存').click()
    await new Promise(r => setTimeout(r, 600))
    return saved
  `))

  check('保存后弹出 toast', await seesText(cdp, '设置已保存'))

  check('API Key 以掩码显示，不回显明文', await evaluate(`
    const t = window.__t.text()
    return t.includes('当前：') && !/sk-[a-zA-Z0-9]{20,}/.test(t)
  `))

  check('「测试连接」返回结果', await evaluate(`
    window.__t.btn('测试连接').click()
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500))
      const t = window.__t.text()
      if (t.includes('连接正常') || t.includes('接口返回') || t.includes('网络错误')) return true
    }
    return false
  `))
  check('测试连接结果为成功', await seesText(cdp, '连接正常'))

  await clickBtn(cdp, '返回')
  await sleep(600)

  // ══════════════════════════════════════════════════════
  group('输入框')

  check('输入区默认 4 行高', await evaluate(`
    const ta = document.querySelector('textarea')
    const line = parseFloat(getComputedStyle(ta).lineHeight)
    const rows = Math.round(ta.clientHeight / line)
    return rows === 4 ? true : ('实际 ' + rows + ' 行')
  `) === true)

  check('输入区右侧没有发送按钮', await evaluate(`
    return !window.__t.btn('发送')
  `))

  check('不显示「Enter 发送」这类提示文字', await evaluate(`
    return !window.__t.text().includes('Shift + Enter')
  `))

  check('空内容按 Enter 不发送', await evaluate(`
    const before = (await window.api.listMessages({ categoryId: 'all' })).length
    const ta = document.querySelector('textarea')
    window.__t.setValue(ta, '   ')
    await new Promise(r => setTimeout(r, 200))
    window.__t.enter(ta)
    await new Promise(r => setTimeout(r, 600))
    window.__t.setValue(ta, '测试内容')
    await new Promise(r => setTimeout(r, 200))
    return (await window.api.listMessages({ categoryId: 'all' })).length === before
  `))

  check('Shift+Enter 不发送（用于换行）', await evaluate(`
    const ta = document.querySelector('textarea')
    window.__t.key(ta, 'Enter', { shiftKey: true })
    await new Promise(r => setTimeout(r, 500))
    return ta.value === '测试内容'
  `))

  check('输入法组合态下 Enter 不发送', await evaluate(`
    const ta = document.querySelector('textarea')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    window.__t.key(ta, 'Enter')
    await new Promise(r => setTimeout(r, 500))
    const notSent = ta.value === '测试内容'
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    return notSent
  `))

  check('Enter 发送并清空输入框', await evaluate(`
    const ta = document.querySelector('textarea')
    window.__t.key(ta, 'Enter')
    await new Promise(r => setTimeout(r, 900))
    return ta.value === '' && window.__t.text().includes('测试内容')
  `))

  check('内容超过 4 行时输入区变高，且有上限', await evaluate(`
    const ta = document.querySelector('textarea')
    const base = ta.clientHeight
    window.__t.setValue(ta, Array(30).fill('很长的一行内容').join('\\n'))
    await new Promise(r => setTimeout(r, 300))
    const grown = ta.clientHeight
    window.__t.setValue(ta, '')
    await new Promise(r => setTimeout(r, 300))
    const back = ta.clientHeight
    return grown > base && grown <= 260 && back === base
      ? true : ('base=' + base + ' grown=' + grown + ' back=' + back)
  `) === true)

  check('发送后消息出现', await evaluate(`
    const ta = document.querySelector('textarea')
    window.__t.setValue(ta, '电商App购物车在iOS 17上点结算会闪退')
    await new Promise(r => setTimeout(r, 200))
    window.__t.enter(ta)
    await new Promise(r => setTimeout(r, 900))
    return window.__t.text().includes('购物车在iOS 17')
  `))

  // 核心承诺：消息落库与显示不依赖 AI。用「出现耗时」来测，
  // 而不是抽查「分类中」—— 模型有时快到 200ms 内就分类完了，那样抽查会误报。
  const appearMs = await evaluate(`
    window.__t.setValue(document.querySelector('textarea'), '记得明天下班买牛奶和鸡蛋')
    await new Promise(r => setTimeout(r, 200))
    const t0 = performance.now()
    window.__t.enter(document.querySelector('textarea'))
    for (let i = 0; i < 200; i++) {
      if (window.__t.text().includes('买牛奶和鸡蛋')) return Math.round(performance.now() - t0)
      await new Promise(r => setTimeout(r, 20))
    }
    return -1
  `)
  check('消息立即出现，不等 AI 分类', appearMs >= 0 && appearMs < 400, `耗时 ${appearMs}ms`)

  check('分类完成后显示分类标签', await cdp.waitFor(`!window.__t.text().includes('分类中')`, 60000))

  // ══════════════════════════════════════════════════════
  group('配色')

  const palette = await evaluate(`
    const bubble = [...document.querySelectorAll('div')]
      .find(d => d.className.includes('bg-raised') && d.className.includes('rounded-lg'))
    const row = [...document.querySelectorAll('button')].find(b => b.className.includes('bg-active'))
    return {
      body: window.__t.bgOf(document.body),
      bubble: bubble ? window.__t.bgOf(bubble) : null,
      activeRow: row ? window.__t.bgOf(row) : null
    }
  `)
  const rgb = (c) => (c ? `rgb(${c.r},${c.g},${c.b})` : '无')
  const sum = (c) => (c ? c.r + c.g + c.b : -1)

  // 用户明确反馈高饱和蓝色气泡「非常刺眼」，这里把它固化成约束
  check(
    '消息气泡是中性灰，不是高饱和色',
    palette.bubble !== null && palette.bubble.sat < 0.15,
    palette.bubble ? `饱和度 ${palette.bubble.sat.toFixed(2)}` : '未找到气泡'
  )
  check(
    '侧栏选中行也是中性色',
    palette.activeRow !== null && palette.activeRow.sat < 0.15,
    palette.activeRow ? `饱和度 ${palette.activeRow.sat.toFixed(2)}` : '未找到选中行'
  )
  check(
    '气泡靠明度和底色分层，不靠色相',
    sum(palette.bubble) > 0 && sum(palette.bubble) !== sum(palette.body),
    `底 ${rgb(palette.body)} 气泡 ${rgb(palette.bubble)}`
  )

  // ══════════════════════════════════════════════════════
  group('图片')

  // 在页面里真造一张 PNG，走真实的 paste 事件，而不是直接调 window.api
  const makePng = `
    const c = document.createElement('canvas')
    c.width = 64; c.height = 48
    const g = c.getContext('2d')
    g.fillStyle = '#4f8ef7'; g.fillRect(0, 0, 64, 48)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
  `

  check('侧栏有内置的「图片」分类', await seesText(cdp, '图片'))

  check('粘贴图片后输入框出现缩略图', await evaluate(`
    ${makePng}
    const file = new File([blob], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const ta = document.querySelector('textarea')
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('img[alt="pasted.png"]')) return true
    }
    return false
  `))

  check('有图片时即使没有文字也能发送', await evaluate(`
    const before = (await window.api.listMessages({ categoryId: 'all' })).length
    window.__t.enter(document.querySelector('textarea'))
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      if ((await window.api.listMessages({ categoryId: 'all' })).length > before) return true
    }
    return false
  `))

  check('缩略图可以单独移除', await evaluate(`
    const before = document.querySelectorAll('img[alt="pasted.png"]').length
    ${makePng}
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'second.png', { type: 'image/png' }))
    document.querySelector('textarea').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('img[alt="second.png"]')) break
    }
    // 移除刚加的第二张
    const wrap = document.querySelector('img[alt="second.png"]').parentElement
    wrap.querySelector('button').click()
    await new Promise(r => setTimeout(r, 300))
    return !document.querySelector('img[alt="second.png"]') &&
           document.querySelectorAll('img[alt="pasted.png"]').length === before
  `))

  check('发送后图片落入「图片」分类', await evaluate(`
    window.__t.enter(document.querySelector('textarea'))
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 200))
      const cats = await window.api.listCategories()
      const file = cats.find(c => c.name === '图片')
      const msgs = await window.api.listMessages({ categoryId: file.id })
      if (msgs.length === 1 && msgs[0].image) {
        return msgs[0].image.width === 64 && msgs[0].image.height === 48 ? true : 'wrong-size'
      }
    }
    return 'not-filed'
  `) === true)

  check('图片不经过 AI 分类（状态直接是 classified）', await evaluate(`
    const msgs = await window.api.listMessages({ categoryId: 'all' })
    const img = msgs.find(m => m.image)
    return img.status === 'classified' && img.error === null
  `))

  check('图片在气泡里能正常渲染（自定义协议可读）', await evaluate(`
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      const el = [...document.querySelectorAll('img')].find(i => i.src.startsWith('collect-img://'))
      if (el && el.complete && el.naturalWidth === 64) return true
    }
    return false
  `))

  // 用 src 协议区分：输入框缩略图是 data: URL，已发送的气泡是 collect-img://
  // （两者 alt 都是文件名，光按 alt 查会把已发送的那张也算进来）
  check('发送后输入框的缩略图被清空', await evaluate(`
    const previews = [...document.querySelectorAll('img[alt="pasted.png"]')]
      .filter(i => i.src.startsWith('data:'))
    return previews.length === 0
  `))

  check('点击图片打开大图预览，可关闭', await evaluate(`
    const el = [...document.querySelectorAll('img')].find(i => i.src.startsWith('collect-img://'))
    el.click()
    await new Promise(r => setTimeout(r, 400))
    const opened = !!window.__t.btn('关闭')
    if (opened) window.__t.btn('关闭').click()
    await new Promise(r => setTimeout(r, 400))
    return opened && !window.__t.btn('关闭')
  `))

  check('非图片文件被拒绝', await evaluate(`
    const dt = new DataTransfer()
    dt.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }))
    document.querySelector('textarea').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (window.__t.text().includes('已忽略')) return true
    }
    return false
  `))

  check('「图片」分类不可删除', await evaluate(`
    const cats = await window.api.listCategories()
    const file = cats.find(c => c.name === '图片')
    if (!file.isSystem) return 'not-system'
    try {
      await window.api.deleteCategory(file.id)
      return 'should-have-thrown'
    } catch (e) {
      return String(e.message).includes('不能删除')
    }
  `) === true)

  check('文字消息不会被归到「图片」', await evaluate(`
    // 「图片」不在 AI 候选里，所以任何文字都不该落进去
    const cats = await window.api.listCategories()
    const file = cats.find(c => c.name === '图片')
    const msgs = await window.api.listMessages({ categoryId: file.id })
    return msgs.every(m => m.image !== null)
  `))

  await cdp.screenshot('08-图片消息')

  // ══════════════════════════════════════════════════════
  group('消息右键菜单')

  const openMenu = `
    const bubble = [...document.querySelectorAll('div')]
      .find(d => d.className.includes('bg-raised') && d.textContent.includes('购物车在iOS 17'))
    window.__t.rightClick(bubble)
    await new Promise(r => setTimeout(r, 350))
  `

  check('右键消息弹出菜单', await evaluate(`
    ${openMenu}
    const t = window.__t.text()
    return t.includes('复制') && t.includes('重新分类') && t.includes('移动到') && t.includes('删除')
  `))

  check('点击别处关闭菜单', await evaluate(`
    document.querySelector('.fixed.inset-0')?.click()
    await new Promise(r => setTimeout(r, 300))
    return !window.__t.text().includes('重新分类')
  `))

  // 窗口未聚焦时 clipboard.readText 会被浏览器拒绝（测试环境限制，非应用问题），
  // 改为拦截 writeText 校验传入的内容
  check('「复制」把原文写入剪贴板', await evaluate(`
    const real = navigator.clipboard.writeText.bind(navigator.clipboard)
    let captured = null
    navigator.clipboard.writeText = async (t) => { captured = t; return real(t).catch(() => {}) }
    ${openMenu}
    window.__t.btn('复制').click()
    await new Promise(r => setTimeout(r, 500))
    navigator.clipboard.writeText = real
    return captured === '电商App购物车在iOS 17上点结算会闪退'
  `))
  check('复制后弹出 toast', await seesText(cdp, '已复制'))

  check('「移动到」把消息改到指定分类', await evaluate(`
    ${openMenu}
    const target = [...document.querySelectorAll('button')]
      .find(b => b.textContent.includes('工作') && b.offsetParent !== null && b.className.includes('py-1.5'))
    if (!target) return false
    target.click()
    await new Promise(r => setTimeout(r, 900))
    return window.__t.text().includes('工作 · 手动')
  `))

  // 同样密集轮询：模型可能几百毫秒就分类完，固定延时抽查会误报
  check('「重新分类」重新走一遍分类流程', await evaluate(`
    ${openMenu}
    window.__t.btn('重新分类').click()
    let sawPending = false
    for (let i = 0; i < 100; i++) {
      const m = (await window.api.listMessages({ categoryId: 'all' }))
        .find(m => m.content.includes('购物车在iOS 17'))
      if (m?.status === 'pending') sawPending = true
      if (sawPending && m?.status !== 'pending') return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  `))

  check('「删除」不弹确认窗，直接移入垃圾箱', await evaluate(`
    const before = (await window.api.listMessages({ categoryId: 'all' })).length
    const trashBefore = await window.api.countTrash()
    ${openMenu}
    window.__t.btn('删除').click()
    await new Promise(r => setTimeout(r, 900))
    const after = (await window.api.listMessages({ categoryId: 'all' })).length
    const trashAfter = await window.api.countTrash()
    return after === before - 1 && trashAfter === trashBefore + 1 &&
           !window.__t.text().includes('购物车在iOS 17')
  `))
  check('提示「已移到垃圾箱」并带撤销按钮', await evaluate(`
    return window.__t.text().includes('已移到垃圾箱') && !!window.__t.btn('撤销')
  `))

  check('点「撤销」把消息放回原处', await evaluate(`
    window.__t.btn('撤销').click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      if (window.__t.text().includes('购物车在iOS 17') && (await window.api.countTrash()) === 0) return true
    }
    return false
  `))

  // ══════════════════════════════════════════════════════
  group('垃圾箱')

  check('删除后侧栏出现「垃圾箱」入口', await evaluate(`
    ${openMenu}
    window.__t.btn('删除').click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      if (window.__t.btnLike('垃圾箱')) return true
    }
    return false
  `))

  check('进入垃圾箱能看到已删除的消息', await evaluate(`
    window.__t.btnLike('垃圾箱').click()
    await new Promise(r => setTimeout(r, 700))
    return window.__t.text().includes('购物车在iOS 17') && window.__t.text().includes('已删除')
  `))

  check('垃圾箱没有输入框（只读）', await evaluate(`
    return !document.querySelector('textarea')
  `))

  const trashMenu = `
    const trashBubble = [...document.querySelectorAll('div')]
      .find(d => d.className.includes('bg-raised') && d.textContent.includes('购物车在iOS 17'))
    if (!trashBubble) return 'bubble-not-found'
    window.__t.rightClick(trashBubble)
    await new Promise(r => setTimeout(r, 350))
  `

  check('垃圾箱里的右键菜单是「还原/彻底删除」', await evaluate(`
    ${trashMenu}
    const t = window.__t.text()
    return t.includes('还原') && t.includes('彻底删除') && !t.includes('移动到')
  `))

  check('「还原」把消息放回原分类', await evaluate(`
    const beforeCat = (await window.api.listMessages({ categoryId: 'trash' }))
      .find(m => m.content.includes('购物车在iOS 17'))?.categoryId
    window.__t.btn('还原').click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      if ((await window.api.countTrash()) === 0) break
    }
    const back = (await window.api.listMessages({ categoryId: 'all' }))
      .find(m => m.content.includes('购物车在iOS 17'))
    if (!back) return 'not-restored'
    // 分类归属必须原样保留（具体是哪个分类由前面的用例决定，这里不写死）
    return back.deletedAt === null && back.categoryId === beforeCat
  `) === true)

  check('垃圾箱清空后侧栏入口消失', await cdp.waitFor(`!window.__t.btnLike('垃圾箱')`, 15000))

  await evaluate(`
    window.__t.btnLike('袋鼠').click()
    await new Promise(r => setTimeout(r, 600))
    ${openMenu}
    window.__t.btn('删除').click()
    await new Promise(r => setTimeout(r, 800))
    window.__t.btnLike('垃圾箱').click()
    await new Promise(r => setTimeout(r, 700))
    return true
  `)

  check('「彻底删除」不可恢复', await evaluate(`
    ${trashMenu}
    window.__t.btn('彻底删除').click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      const all = await window.api.listMessages({ categoryId: 'all' })
      const trash = await window.api.listMessages({ categoryId: 'trash' })
      const gone = ![...all, ...trash].some(m => m.content.includes('购物车在iOS 17'))
      if (gone) return true
    }
    return false
  `))

  check('「清空垃圾箱」需要行内二次确认，可取消', await evaluate(`
    // 先制造两条垃圾
    window.__t.btnLike('袋鼠').click()
    await new Promise(r => setTimeout(r, 600))
    for (const txt of ['垃圾测试一', '垃圾测试二']) {
      window.__t.setValue(document.querySelector('textarea'), txt)
      await new Promise(r => setTimeout(r, 150))
      window.__t.enter(document.querySelector('textarea'))
      await new Promise(r => setTimeout(r, 700))
    }
    for (const txt of ['垃圾测试一', '垃圾测试二']) {
      const b = [...document.querySelectorAll('div')]
        .find(d => d.className.includes('bg-raised') && d.textContent.includes(txt))
      window.__t.rightClick(b)
      await new Promise(r => setTimeout(r, 300))
      window.__t.btn('删除').click()
      await new Promise(r => setTimeout(r, 600))
    }
    window.__t.btnLike('垃圾箱').click()
    await new Promise(r => setTimeout(r, 700))

    window.__t.btn('清空垃圾箱').click()
    await new Promise(r => setTimeout(r, 300))
    if (!window.__t.text().includes('不可恢复')) return 'no-confirm-shown'
    window.__t.btn('取消').click()
    await new Promise(r => setTimeout(r, 300))
    return (await window.api.countTrash()) === 2 ? true : 'cancel-did-not-work'
  `) === true)

  check('确认后清空垃圾箱', await evaluate(`
    window.__t.btn('清空垃圾箱').click()
    await new Promise(r => setTimeout(r, 300))
    window.__t.btn('清空').click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 150))
      if ((await window.api.countTrash()) === 0) return true
    }
    return false
  `))

  // 曾经这里显示「0 项」——因为把「待清理图片数」当成了「消息条数」
  check('清空后提示的条数正确', await seesText(cdp, '已清空垃圾箱（2 项）'))

  await cdp.screenshot('09-垃圾箱')

  // 回到袋鼠，后续用例需要输入框
  await evaluate(`
    window.__t.btnLike('袋鼠').click()
    await new Promise(r => setTimeout(r, 600))
    return true
  `)

  // ══════════════════════════════════════════════════════
  group('搜索')

  check('点击侧栏搜索打开搜索面板', await evaluate(`
    window.__t.btnLike('搜索').click()
    await new Promise(r => setTimeout(r, 400))
    return !!document.querySelector('input[placeholder="搜索所有消息…"]')
  `))

  // 搜索有 200ms 防抖 + IPC 往返，固定 sleep 不可靠，一律轮询等条件成立
  check('输入关键词显示结果并高亮', await evaluate(`
    window.__t.setValue(document.querySelector('input[placeholder="搜索所有消息…"]'), '牛奶')
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('mark')) return true
    }
    return false
  `))

  check('无结果时给出提示', await evaluate(`
    window.__t.setValue(document.querySelector('input[placeholder="搜索所有消息…"]'), '不存在的关键词xyz')
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (window.__t.text().includes('没有找到')) return true
    }
    return false
  `))

  check('Esc 关闭搜索面板', await evaluate(`
    window.__t.key(document.body, 'Escape')
    await new Promise(r => setTimeout(r, 400))
    return !document.querySelector('input[placeholder="搜索所有消息…"]')
  `))

  check('⌘F 打开搜索面板', await evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    return !!document.querySelector('input[placeholder="搜索所有消息…"]')
  `))

  check('点击搜索结果跳转到对应会话', await evaluate(`
    const input = document.querySelector('input[placeholder="搜索所有消息…"]')
    window.__t.setValue(input, '牛奶')
    // 必须限定在搜索面板内找结果行 —— 侧栏的会话行也含「牛奶」（最后一条消息摘要）
    let row = null
    for (let i = 0; i < 50 && !row; i++) {
      await new Promise(r => setTimeout(r, 100))
      row = input.nextElementSibling?.querySelector('button')
    }
    if (!row) return 'no-result-row'
    row.click()
    // jump() 里要走 selectConversation（多次 IPC）再关面板，轮询等它落定
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100))
      const closed = !document.querySelector('input[placeholder="搜索所有消息…"]')
      if (closed && window.__t.text().includes('买牛奶和鸡蛋')) return true
    }
    return 'not-navigated'
  `) === true)

  // ══════════════════════════════════════════════════════
  group('未分类会话与重试')

  // 发送一条注定分类失败的消息（指向一个连不上的地址）
  const pendingNotCounted = await evaluate(`
    await window.api.saveSettings({ baseUrl: 'http://127.0.0.1:9/v1' })
    // 确保没有遮罩残留，并回到有输入框的袋鼠会话
    window.__t.key(document.body, 'Escape')
    await new Promise(r => setTimeout(r, 300))
    window.__t.btnLike('袋鼠').click()
    await new Promise(r => setTimeout(r, 600))
    if (!document.querySelector('textarea')) return 'no-textarea'
    // 用基线对比而不是绝对值：前面的用例可能已经留下未分类消息
    const before = await window.api.countUnclassified()
    window.__t.setValue(document.querySelector('textarea'), '接口挂掉时发的：记得明天买酱油和醋')
    await new Promise(r => setTimeout(r, 200))
    window.__t.enter(document.querySelector('textarea'))
    // 消息刚进队列时 categoryId 也是 null，但它只是在排队，不该被算作未分类
    await new Promise(r => setTimeout(r, 600))
    const during = await window.api.countUnclassified()
    window.__baseUnclassified = before
    return during === before ? 'ok' : ('从 ' + before + ' 变成了 ' + during)
  `)
  check('排队分类中的消息不被算作「未分类」', pendingNotCounted === 'ok', pendingNotCounted)

  check('重试耗尽后侧栏出现「未分类」入口', await cdp.waitFor(
    `(await window.api.countUnclassified()) > (window.__baseUnclassified ?? 0)`, 60000
  ))

  check('未分类消息显示失败原因与「重试」按钮', await evaluate(`
    return window.__t.text().includes('网络错误') && !!window.__t.btn('重试')
  `))

  check('点击「重试」重新分类成功', await evaluate(`
    await window.api.saveSettings({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })
    // 必须点目标消息自己的「重试」——界面上可能同时有多条未分类消息，
    // 按文字取第一个按钮很可能点到别人身上
    const bubble = [...document.querySelectorAll('div')]
      .find(d => d.className.includes('bg-raised') && d.textContent.includes('酱油'))
    if (!bubble) return 'bubble-not-found'
    const retry = [...(bubble.parentElement?.querySelectorAll('button') ?? [])]
      .find(b => b.textContent.trim() === '重试')
    if (!retry) return 'retry-button-not-found'
    retry.click()
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 500))
      const m = (await window.api.listMessages({ categoryId: 'all' }))
        .find(m => m.content.includes('酱油'))
      if (m && m.status === 'classified') return true
      if (m && m.status === 'failed' && i > 20) return '重试后仍失败：' + m.error
    }
    return 'timeout'
  `) === true)

  await cdp.screenshot('07-界面交互测试')
} catch (e) {
  console.error('\n❌ 测试异常中断：', e.message)
  console.error((app?.log ?? []).join('').slice(-1500))
  check.state.failures++
} finally {
  app?.cdp?.close()
  app?.kill()
  await sleep(500)
}

// 渲染进程里静默抛出的异常往往就是「按钮点了没反应」的根因，必须暴露出来
const rendererErrors = app?.errors ?? []
if (rendererErrors.length) {
  console.log(`\n渲染进程报错（${rendererErrors.length} 条）：`)
  for (const e of [...new Set(rendererErrors)].slice(0, 10)) {
    console.log(`  ${String(e).split('\n')[0].slice(0, 160)}`)
  }
  check.state.failures++
  check.state.total++
}

const { failures, total } = check.state
console.log(
  failures === 0
    ? `\n✅ 界面交互检查全部通过（${total} 项）`
    : `\n❌ ${failures}/${total} 项检查失败`
)
process.exit(failures === 0 ? 0 : 1)
