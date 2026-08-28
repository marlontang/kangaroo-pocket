/**
 * 从模型回复里抠出一个 JSON 对象。
 *
 * 不能复用 classifier 里那个 `/\{[^{}]*\}/` —— 它明确不匹配嵌套花括号，
 * 而识别分类/批量分类返回的都是嵌套结构。
 */
export function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null

  const candidates: string[] = []

  // 1) 优先取 ``` 代码围栏里的内容（模型很爱裹一层）
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1])

  // 2) 原文
  candidates.push(raw)

  for (const text of candidates) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) continue

    // 先试完整区间；失败再从 end 往回收缩，容忍尾部多余内容
    let slice = text.slice(start, end + 1)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return JSON.parse(slice)
      } catch {
        const prev = slice.lastIndexOf('}', slice.length - 2)
        if (prev <= 0) break
        slice = slice.slice(0, prev + 1)
      }
    }
  }
  return null
}
