import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings, SettingsInput } from '../shared/types'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_SECRETARY_PROMPT } from '../shared/defaults'

interface StoredSettings {
  baseUrl: string
  model: string
  secretaryPrompt: string
  /** safeStorage 加密后的 base64；明文永不落盘 */
  apiKeyEnc?: string
  /** 加密不可用时的降级存储（见 saveApiKey 注释） */
  apiKeyPlain?: string
}

function defaults(): StoredSettings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    secretaryPrompt: DEFAULT_SECRETARY_PROMPT
  }
}

/** 开发期从项目根目录 .env 读取，免去每次手填 Key。打包后不启用。 */
function devEnvDefaults(): Partial<StoredSettings> {
  if (app.isPackaged) return {}
  try {
    const envPath = join(app.getAppPath(), '.env')
    if (!existsSync(envPath)) return {}
    const env: Record<string, string> = {}
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    const out: Partial<StoredSettings> = {}
    if (env.QWEN_API_KEY) out.apiKeyPlain = env.QWEN_API_KEY
    if (env.QWEN_MODEL) out.model = env.QWEN_MODEL
    if (env.QWEN_API_URL) out.baseUrl = env.QWEN_API_URL
    return out
  } catch {
    return {}
  }
}

let cache: StoredSettings | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): StoredSettings {
  if (cache) return cache
  let stored: StoredSettings = defaults()
  try {
    if (existsSync(filePath())) {
      stored = { ...stored, ...JSON.parse(readFileSync(filePath(), 'utf-8')) }
    }
  } catch {
    // 配置损坏时回落到默认值，不阻塞启动
  }
  // 首次运行且用户尚未配置过 Key 时，才注入开发环境默认值
  if (!stored.apiKeyEnc && !stored.apiKeyPlain) {
    stored = { ...stored, ...devEnvDefaults() }
  }
  cache = stored
  return stored
}

function persist(s: StoredSettings): void {
  cache = s
  writeFileSync(filePath(), JSON.stringify(s, null, 2), 'utf-8')
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 11) return key.slice(0, 3) + '****'
  return `${key.slice(0, 7)}****${key.slice(-4)}`
}

// 解密要走 macOS 钥匙串，有几百毫秒级的开销；每条消息分类都读一次太浪费，
// 缓存起来，保存设置时失效即可。
let apiKeyCache: string | null = null

/** 明文 API Key —— 只允许在主进程内使用，绝不通过 IPC 返回渲染进程 */
export function getApiKey(): string {
  if (apiKeyCache !== null) return apiKeyCache
  const s = load()
  let key = ''
  if (s.apiKeyEnc) {
    try {
      key = safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'))
    } catch {
      key = ''
    }
  } else {
    key = s.apiKeyPlain ?? ''
  }
  apiKeyCache = key
  return key
}

export function getSettings(): Settings {
  const s = load()
  const key = getApiKey()
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    secretaryPrompt: s.secretaryPrompt,
    apiKeyMask: mask(key),
    hasApiKey: key.length > 0
  }
}

export function saveSettings(input: SettingsInput): Settings {
  const s = { ...load() }
  if (input.baseUrl !== undefined) s.baseUrl = input.baseUrl.trim()
  if (input.model !== undefined) s.model = input.model.trim()
  if (input.secretaryPrompt !== undefined) s.secretaryPrompt = input.secretaryPrompt

  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim()
    apiKeyCache = null // Key 变了，缓存作废
    delete s.apiKeyEnc
    delete s.apiKeyPlain
    if (key) {
      // safeStorage 在 macOS 上走钥匙串。个别环境（如未登录钥匙串）不可用，
      // 此时降级为明文存储 —— 宁可可用，也在 UI 上如实告知用户。
      if (safeStorage.isEncryptionAvailable()) {
        s.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
      } else {
        s.apiKeyPlain = key
      }
    }
  }
  persist(s)
  return getSettings()
}
