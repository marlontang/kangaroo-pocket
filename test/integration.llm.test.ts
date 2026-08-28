/**
 * 真实调用千问接口的集成测试 —— 验证 PRD 第 7 节的分类准确率验收标准。
 * 默认跳过（会产生真实费用与网络请求），用 RUN_LLM_TESTS=1 npx vitest run 显式执行。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDb, type Db } from '../src/main/db'
import { createClassifier } from '../src/main/classifier'
import { testConnection, type LlmConfig } from '../src/main/llm'
import { DEFAULT_SECRETARY_PROMPT } from '../src/shared/defaults'

const ENABLED = process.env.RUN_LLM_TESTS === '1'

function loadEnv(): Record<string, string> {
  const p = join(process.cwd(), '.env')
  if (!existsSync(p)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const CATEGORIES = [
  { name: '生活', emoji: '🏠', description: '日常生活、购物、健康、家庭、饮食、出行' },
  { name: '工作', emoji: '💼', description: '公司事务、同事沟通、会议、汇报、绩效、招聘' },
  { name: '项目A', emoji: '🚀', description: 'A 项目（电商 App）的需求、进度、bug、客户沟通' },
  { name: '项目B', emoji: '📊', description: 'B 项目（数据看板）的技术方案、接口、上线计划' },
  { name: '灵感', emoji: '💡', description: '突发的想法、读到的观点、想写的内容、书影音推荐' }
]

/** 20 条混杂消息，模拟真实使用场景 */
const CASES: { content: string; expect: string }[] = [
  { content: '记得明天下班买牛奶和鸡蛋', expect: '生活' },
  { content: '周五下午3点部门季度复盘会，要准备PPT', expect: '工作' },
  { content: '电商App的购物车在iOS 17上点结算会闪退，优先级P0', expect: '项目A' },
  { content: '数据看板的指标接口改成分页返回，一次别拉全量', expect: '项目B' },
  { content: '想写一篇关于「工具如何塑造思维」的文章', expect: '灵感' },
  { content: '牙医预约改到下周二上午十点了', expect: '生活' },
  { content: '给小王的转正评估要在本周内提交给HR', expect: '工作' },
  { content: '客户反馈A项目的优惠券叠加逻辑和需求文档不一致', expect: '项目A' },
  { content: '看板项目下周三灰度上线，先放10%流量', expect: '项目B' },
  { content: '《置身事内》这本书讲地方财政讲得很透，推荐', expect: '灵感' },
  { content: '家里的滤芯该换了，型号是RO-400G', expect: '生活' },
  { content: '明天10点和候选人的技术面，记得提前看简历', expect: '工作' },
  { content: 'A项目商品详情页首屏加载要压到1.5秒以内', expect: '项目A' },
  { content: 'B项目的图表组件换成ECharts，Recharts性能扛不住十万点', expect: '项目B' },
  { content: '一个想法：把日常记账做成对话式的会不会更容易坚持', expect: '灵感' },
  { content: '周末带娃去自然博物馆，要提前三天预约门票', expect: '生活' },
  { content: '把这个季度的OKR进度同步到部门周报里', expect: '工作' },
  { content: 'A项目支付回调偶发超时，怀疑是第三方网关限流', expect: '项目A' },
  { content: 'B项目要接SSO单点登录，对接文档找运维要', expect: '项目B' },
  { content: '播客里听到一句：约束是创造力的前提', expect: '灵感' }
]

describe.skipIf(!ENABLED)('千问真实接口集成测试', () => {
  let config: LlmConfig
  let db: Db

  beforeAll(() => {
    const env = loadEnv()
    config = {
      baseUrl: env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: env.QWEN_API_KEY ?? '',
      model: env.QWEN_MODEL || 'qwen3.6-flash'
    }
    expect(config.apiKey, '.env 中缺少 QWEN_API_KEY').not.toBe('')
  })

  it('测试连接可用', { timeout: 60_000 }, async () => {
    const r = await testConnection(config)
    expect(r.error ?? '').toBe('')
    expect(r.ok).toBe(true)
  })

  it(
    '20 条混杂消息的分类准确率 ≥ 80%',
    { timeout: 300_000 },
    async () => {
      db = createDb(':memory:')
      for (const c of CATEGORIES) db.createCategory(c)

      const classifier = createClassifier({
        db,
        getConfig: () => ({ ...config, secretaryPrompt: DEFAULT_SECRETARY_PROMPT }),
        onUpdate: () => {}
      })

      const ids = CASES.map((c) => db.insertMessage(c.content).id)
      ids.forEach((id) => classifier.enqueue(id))

      // 串行队列，等它排空
      const deadline = Date.now() + 280_000
      while (db.listPendingMessages().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300))
      }

      const wrong: string[] = []
      ids.forEach((id, i) => {
        const m = db.getMessage(id)!
        const actual = m.categoryId ? db.getCategory(m.categoryId)!.name : `未分类(${m.error})`
        if (actual !== CASES[i].expect) {
          wrong.push(`  「${CASES[i].content}」\n    期望 ${CASES[i].expect} → 实际 ${actual}`)
        }
      })

      const accuracy = (CASES.length - wrong.length) / CASES.length
      console.log(
        `\n分类准确率：${(accuracy * 100).toFixed(0)}% (${CASES.length - wrong.length}/${CASES.length})` +
          (wrong.length ? `\n分错的：\n${wrong.join('\n')}` : '')
      )
      expect(accuracy).toBeGreaterThanOrEqual(0.8)
    }
  )

  it('内容在分类全过程中一字未改', { timeout: 120_000 }, async () => {
    const fresh = createDb(':memory:')
    for (const c of CATEGORIES) fresh.createCategory(c)
    const classifier = createClassifier({
      db: fresh,
      getConfig: () => ({ ...config, secretaryPrompt: DEFAULT_SECRETARY_PROMPT }),
      onUpdate: () => {}
    })
    const raw = '  多行\n带空格和符号 100% <b>不转义</b> 😀  '
    const id = fresh.insertMessage(raw).id
    classifier.enqueue(id)

    const deadline = Date.now() + 100_000
    while (fresh.getMessage(id)!.status === 'pending' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(fresh.getMessage(id)!.content).toBe(raw)
  })
})
