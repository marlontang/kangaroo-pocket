import { describe, expect, it } from 'vitest'
import { extractJsonObject } from '../src/main/json'

describe('extractJsonObject', () => {
  it('解析普通 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
  })

  it('解析嵌套结构 —— 这是不能复用旧正则的原因', () => {
    const raw = '{"categories":[{"name":"工作","description":"公司事务"}],"secretaryPrompt":"x"}'
    expect(extractJsonObject(raw)).toEqual({
      categories: [{ name: '工作', description: '公司事务' }],
      secretaryPrompt: 'x'
    })
  })

  it('剥掉 markdown 代码围栏', () => {
    expect(extractJsonObject('```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } })
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('忽略 JSON 前后的多余文字', () => {
    expect(extractJsonObject('好的，结果如下：\n{"a":[1,2]}\n以上。')).toEqual({ a: [1, 2] })
  })

  it('容忍尾部多余的花括号残片', () => {
    expect(extractJsonObject('{"a":1} 补充说明 }')).toEqual({ a: 1 })
  })

  it('字符串里含花括号也不破坏解析', () => {
    expect(extractJsonObject('{"tpl":"{\\"category\\":\\"x\\"}"}')).toEqual({
      tpl: '{"category":"x"}'
    })
  })

  it('无法解析时返回 null', () => {
    expect(extractJsonObject('完全不是 JSON')).toBeNull()
    expect(extractJsonObject('{坏的')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
  })
})
