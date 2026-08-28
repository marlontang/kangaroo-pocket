import type { Db } from './db'
import { chat, type LlmConfig } from './llm'
import { extractJsonObject } from './json'
import { IMAGE_CATEGORY_NAME } from './db'
import type { DiscoveredCategory, DiscoveryResult } from '../shared/types'

/** 归纳是长任务，30 秒不够 */
const DISCOVERY_TIMEOUT_MS = 90_000
const MIN_SAMPLES = 5
const MAX_SAMPLES = 300

const SYSTEM_PROMPT = `你是信息整理专家。根据用户的备忘消息归纳一套分类方案。`

export function buildDiscoveryPrompt(samples: string[]): string {
  const list = samples.map((s, i) => `${i + 1}. ${s.replace(/\n/g, ' ')}`).join('\n')
  return `以下是用户的 ${samples.length} 条备忘消息（每行一条，超长已截断）：
${list}

要求，只输出一个 JSON 对象：
{"categories":[{"name":"…","description":"…"}], "secretaryPrompt":"…"}

- categories：3~8 个；name 2~6 个字；description 是一句话判断标准（给分类器用）
- 分类要贴合上面消息的真实主题分布，不要套用通用模板
- 不要创建名为「${IMAGE_CATEGORY_NAME}」的分类（系统内置）
- secretaryPrompt：为这套分类定制的分拣员系统提示词。必须保留两条硬约定：
  只输出 {"category":"<分类名>"} 格式的 JSON；无匹配时输出 {"category":"unknown"}。
  必须包含这套分类之间的区分规则（例如哪类内容容易混淆、以什么为准）。
  不要在其中罗列候选分类列表（列表由程序自动附加）。`
}

/** 校验并规整模型返回。不合格就抛出可读错误交给界面显示。 */
export function parseDiscovery(raw: string): Omit<DiscoveryResult, 'sampledCount'> {
  const parsed = extractJsonObject(raw) as {
    categories?: unknown
    secretaryPrompt?: unknown
  } | null
  if (!parsed) throw new Error('模型返回的不是有效 JSON，请重试')

  const rawList = Array.isArray(parsed.categories) ? parsed.categories : []
  const seen = new Set<string>()
  const categories: DiscoveredCategory[] = []
  for (const item of rawList) {
    const name = String((item as DiscoveredCategory)?.name ?? '').trim()
    const description = String((item as DiscoveredCategory)?.description ?? '').trim()
    // 「图片」是系统内置的，模型不该也不能占用这个名字
    if (!name || name === IMAGE_CATEGORY_NAME || seen.has(name)) continue
    seen.add(name)
    categories.push({ name, description })
  }
  if (categories.length === 0) throw new Error('模型没有给出可用的分类，请重试')

  const secretaryPrompt = String(parsed.secretaryPrompt ?? '').trim()
  if (!secretaryPrompt.includes('category')) {
    throw new Error('模型给出的提示词缺少输出格式约定，请重试')
  }
  return { categories, secretaryPrompt }
}

export async function discoverCategories(
  db: Db,
  config: LlmConfig,
  chatFn = chat
): Promise<DiscoveryResult> {
  const samples = db.sampleForDiscovery(MAX_SAMPLES)
  if (samples.length < MIN_SAMPLES) {
    throw new Error(`消息太少（${samples.length} 条），先发够 ${MIN_SAMPLES} 条再来识别`)
  }

  const reply = await chatFn(
    config,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildDiscoveryPrompt(samples) }
    ],
    // 归纳类任务给一点发散；超时放宽
    { timeoutMs: DISCOVERY_TIMEOUT_MS, temperature: 0.3 }
  )

  return { ...parseDiscovery(reply), sampledCount: samples.length }
}
