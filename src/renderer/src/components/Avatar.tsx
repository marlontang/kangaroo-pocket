/**
 * 分类头像。
 *
 * 没设 emoji 时用「文字头像」：取名字的一两个字，配一个由名字决定的渐变底色
 * （钉钉那种风格）。颜色是确定性的 —— 同一个分类名永远同一个颜色，
 * 不会每次渲染都在变。
 */

/** 中等饱和度的渐变色板，取自参考截图的色系 */
const GRADIENTS: [string, string][] = [
  ['#3b9ad9', '#4361d8'], // 蓝
  ['#c07ac2', '#a8459f'], // 紫
  ['#2bb3a3', '#188f86'], // 青
  ['#e8a33d', '#d97432'], // 橙
  ['#5fb85f', '#3d9140'], // 绿
  ['#e07a6e', '#c9483f'], // 红
  ['#7b7fe0', '#5a52c4'], // 靛
  ['#d97aa8', '#c04d84'] // 粉
]

function gradientFor(name: string): [string, string] {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return GRADIENTS[h % GRADIENTS.length]
}

/**
 * 取用于显示的前两个字符。
 * 前缀相同的分类（如「项目A」「项目B」）文字会一样，靠底色区分 ——
 * 底色由完整名字决定，所以两者颜色不同。
 */
export function initialsOf(name: string): string {
  const s = name.trim()
  if (!s) return '?'
  const two = [...s].slice(0, 2).join('')
  return /^[\x20-\x7E]+$/.test(two) ? two.toUpperCase() : two
}

export function Avatar({
  name,
  emoji,
  size = 40
}: {
  name: string
  emoji?: string | null
  size?: number
}) {
  // 全应用统一圆形
  const base = { width: size, height: size, borderRadius: '9999px' } as const

  if (emoji) {
    return (
      <span
        title={name}
        style={{ ...base, fontSize: Math.round(size * 0.45) }}
        className="flex shrink-0 select-none items-center justify-center bg-raised leading-none"
      >
        {emoji}
      </span>
    )
  }

  const [from, to] = gradientFor(name)
  return (
    <span
      title={name}
      style={{
        ...base,
        background: `linear-gradient(135deg, ${from}, ${to})`,
        fontSize: Math.round(size * 0.32)
      }}
      className="flex shrink-0 select-none items-center justify-center font-medium leading-none text-white"
    >
      {initialsOf(name)}
    </span>
  )
}
