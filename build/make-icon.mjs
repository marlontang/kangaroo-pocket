/** 从设计源图生成 Windows PNG 与 macOS ICNS 应用图标。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = dirname(fileURLToPath(import.meta.url))
const iconset = join(buildDir, 'icon.iconset')
const sourcePng = join(buildDir, 'logo.png')
const basePng = join(buildDir, 'icon.png')

mkdirSync(buildDir, { recursive: true })
console.log('生成 1024×1024 PNG…')
const r = spawnSync('sips', ['-z', '1024', '1024', sourcePng, '--out', basePng], {
  stdio: 'inherit'
})
if (r.status !== 0) {
  console.error('PNG 生成失败')
  process.exit(1)
}

// macOS 要求 iconset 包含这一组尺寸
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    spawnSync('sips', ['-z', String(px), String(px), basePng, '--out', join(iconset, name)], {
      stdio: 'ignore'
    })
  }
}

spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')], {
  stdio: 'inherit'
})
rmSync(iconset, { recursive: true, force: true })
console.log('已生成 build/icon.png 和 build/icon.icns')
