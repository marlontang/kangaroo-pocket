/**
 * 生成 macOS 应用图标。用 Electron 自己渲染一张 1024×1024 的 PNG，
 * 再交给系统的 iconutil 打包成 .icns —— 不引入任何图形依赖。
 *
 * 用法：node build/make-icon.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = dirname(fileURLToPath(import.meta.url))
const iconset = join(buildDir, 'icon.iconset')

const HTML = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px;overflow:hidden}
  .bg{width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(145deg,#4f8ef7 0%,#2563eb 55%,#1d4ed8 100%)}
  .glyph{font-size:560px;line-height:1;filter:drop-shadow(0 24px 48px rgba(0,0,0,.28))}
</style><div class="bg"><div class="glyph">🗂️</div></div>`

const RENDER = `
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
app.disableHardwareAcceleration()
app.on('ready', async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false,
    webPreferences: { offscreen: true } })
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(HTML)}))
  await new Promise(r => setTimeout(r, 1200))
  const img = await w.webContents.capturePage()
  writeFileSync(process.argv[2], img.toPNG())
  app.quit()
})
`

const scriptPath = join(buildDir, '.render-icon.cjs')
const basePng = join(buildDir, 'icon.png')

mkdirSync(buildDir, { recursive: true })
writeFileSync(scriptPath, RENDER)

console.log('渲染图标…')
const r = spawnSync('npx', ['electron', scriptPath, basePng], { stdio: 'inherit' })
rmSync(scriptPath, { force: true })
if (r.status !== 0) {
  console.error('渲染失败')
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
console.log('已生成 build/icon.icns')
