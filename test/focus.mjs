/**
 * 针对性检查：含长串不可断字符（ASCII 表格框线、长 URL 等）的消息
 * 必须被约束在气泡宽度内，不能溢出聊天区。
 * 用法：node test/focus.mjs
 */
import { launch, installHelpers, createChecker, sleep } from './cdp.mjs'

const check = createChecker()
let app

// 用户实际发的内容：box-drawing 字符之间没有任何断行机会
const TABLE = [
  '    │ 1                 │ + 请求行 POST https://... → 200 OK │',
  '    ├───────────────────┼────────────────────────────────────┤',
  '    │ 2                 │ + 完整 header                      │',
  '    ├───────────────────┼────────────────────────────────────┤',
  '    │ 3                 │ + 完整 body                        │',
  '    └───────────────────┴────────────────────────────────────┘'
].join('\n')

const LONG_URL =
  'https://example.com/very/long/path/that/never/breaks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1'

try {
  app = await launch({ port: 9377 })
  const { cdp } = app
  await installHelpers(cdp)
  const ev = (e) => cdp.evaluate(e)

  const sendAndMeasure = async (text, label, marker) => {
    const r = await ev(`
      const ta = document.querySelector('textarea')
      window.__t.setValue(ta, ${JSON.stringify(text)})
      await new Promise(r => setTimeout(r, 250))
      window.__t.enter(ta)
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 150))
        const rows = [...document.querySelectorAll('section div')]
          .filter(d => d.className.includes('justify-end') && d.className.includes('items-start'))
        const row = rows[rows.length - 1]
        if (!row || !row.textContent.includes(${JSON.stringify(marker)})) continue
        const bubble = row.querySelector('div.bg-raised')
        const section = document.querySelector('section')
        const b = bubble.getBoundingClientRect()
        const s = section.getBoundingClientRect()
        const avatar = row.lastElementChild.getBoundingClientRect()
        return {
          // 气泡右对齐，溢出方向是向左 —— 必须查左边缘，不是右边缘
          bubbleLeft: Math.round(b.left),
          bubbleWidth: Math.round(b.width),
          sectionLeft: Math.round(s.left),
          sectionWidth: Math.round(s.width),
          // 行内边距 24×2 + 头像 + 间距，剩下的才是气泡能用的宽度
          maxAllowed: Math.round(s.width - 48 - avatar.width - 8),
          contentOverflow: Math.round(bubble.scrollWidth - bubble.clientWidth),
          hScroll: Math.round(section.scrollWidth - section.clientWidth)
        }
      }
      return null
    `)
    if (!r) {
      check(`${label}：消息发出`, false, '没找到气泡')
      return
    }
    check(
      `${label}：气泡左边缘没有越过聊天区`,
      r.bubbleLeft >= r.sectionLeft,
      `气泡左边 ${r.bubbleLeft} / 聊天区左边 ${r.sectionLeft}`
    )
    check(
      `${label}：气泡宽度不超过可用宽度`,
      r.bubbleWidth <= r.maxAllowed + 1,
      `气泡宽 ${r.bubbleWidth} / 上限 ${r.maxAllowed}`
    )
    check(
      `${label}：内容没有撑破气泡`,
      r.contentOverflow <= 1,
      `溢出 ${r.contentOverflow}px`
    )
    check(`${label}：聊天区没有出现横向滚动`, r.hScroll <= 1, `横向可滚 ${r.hScroll}px`)
  }

  console.log('\n【普通长文本（有空格可断）】')
  await sendAndMeasure('这是一条正常的长消息 '.repeat(20), '普通长文本', '这是一条正常的长消息')

  console.log('\n【ASCII 表格框线 —— 用户报的 bug】')
  await sendAndMeasure(TABLE, '表格框线', '请求行 POST')

  console.log('\n【超长不可断 URL】')
  await sendAndMeasure(LONG_URL, '长 URL', 'very/long/path')

  await cdp.screenshot('20-长内容换行')
} catch (e) {
  console.error('\n❌ 异常：', e.message)
  check.state.failures++
} finally {
  const errs = app?.errors ?? []
  if (errs.length) {
    console.log(`\n渲染进程报错（${errs.length} 条）：`)
    for (const e of [...new Set(errs)].slice(0, 5))
      console.log('  ' + String(e).split('\n')[0].slice(0, 160))
    check.state.failures++
  }
  app?.cdp?.close()
  app?.kill()
  await sleep(300)
}

const { failures, total } = check.state
console.log(failures === 0 ? `\n✅ 全部通过（${total} 项）` : `\n❌ ${failures}/${total} 项失败`)
process.exit(failures === 0 ? 0 : 1)
