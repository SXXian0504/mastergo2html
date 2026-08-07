import { constants, existsSync, readFileSync, accessSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = join(ROOT, '.env')
loadDotEnv()

function sanitizeModelName(model) {
  return (model || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
}

export function resolveEffectiveConfig(config) {
  if (config.provider === 'codex-sdk') return config

  const suffix = sanitizeModelName(config.model)
  if (!suffix) return config

  const apiKey = process.env[`OPENAI_API_KEY_${suffix}`] || config.apiKey
  const baseUrl = process.env[`OPENAI_BASE_URL_${suffix}`]
    ? trimTrailingSlash(process.env[`OPENAI_BASE_URL_${suffix}`])
    : config.baseUrl
  const wireApi = process.env[`OPENAI_WIRE_API_${suffix}`] || config.wireApi

  if (apiKey === config.apiKey && baseUrl === config.baseUrl && wireApi === config.wireApi) {
    return config
  }

  return { ...config, apiKey, baseUrl, wireApi }
}

export function getLlmConfig() {
  const requestedBackend = normalizeBackend(process.env.LLM_BACKEND || process.env.LLM_PROVIDER)
  if (requestedBackend === 'codex-sdk') return getCodexSdkConfig()
  if (requestedBackend === 'anthropic') return getAnthropicConfig()
  if (requestedBackend === 'openai-compatible') return getOpenAiCompatibleConfig()

  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_MODEL) {
    return getOpenAiCompatibleConfig()
  }

  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (anthropicToken || process.env.ANTHROPIC_BASE_URL) return getAnthropicConfig()

  return getOpenAiCompatibleConfig()
}

export function withLlmJobContext(config, { jobId, jobDir } = {}) {
  if (config.provider !== 'codex-sdk') return config
  const resolvedJobDir = jobDir ? resolve(jobDir) : config.codexWorkingDirectory
  return {
    ...config,
    codexThreadKey: jobId || config.codexThreadKey,
    codexWorkingDirectory: resolvedJobDir || config.codexWorkingDirectory,
    codexThreadStatePath: resolvedJobDir
      ? join(resolvedJobDir, '.codex-sdk-threads.json')
      : config.codexThreadStatePath,
  }
}

export function validateLlmConfig(config = getLlmConfig()) {
  const errors = []
  if (config.provider === 'codex-sdk') {
    if (Number(process.versions.node.split('.')[0]) < 18) {
      errors.push('Codex SDK 需要 Node.js 18 或以上版本。')
    }
    if (!isCodexSdkInstalled()) {
      errors.push('缺少 @openai/codex-sdk。请执行 npm install --prefix mcp-server。')
    }
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(config.codexSandboxMode)) {
      errors.push(`无效的 CODEX_SANDBOX_MODE：${config.codexSandboxMode}`)
    }
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.reasoningEffort)) {
      errors.push(`无效的 CODEX_REASONING_EFFORT：${config.reasoningEffort}`)
    }
    return errors
  }

  if (!config.apiKey) {
    errors.push(config.provider === 'anthropic'
      ? '缺少 Anthropic API Key。请配置 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY。'
      : '缺少模型 API Key。请在 mcp-server/.env 中配置 OPENAI_API_KEY。')
  }
  if (!config.baseUrl) errors.push('缺少模型 BASE_URL。')
  if (!config.model) errors.push('缺少模型名称。')
  return errors
}

export function assertLlmConfig(config = getLlmConfig()) {
  const errors = validateLlmConfig(config)
  if (errors.length > 0) throw new Error(errors.join(' '))
}

function isCodexSdkInstalled() {
  return [
    join(ROOT, 'node_modules', '@openai', 'codex-sdk', 'package.json'),
    join(dirname(ROOT), 'node_modules', '@openai', 'codex-sdk', 'package.json'),
  ].some((path) => existsSync(path))
}

function getOpenAiCompatibleConfig() {
  return {
    provider: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY || '',
    authTokenType: 'bearer',
    baseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    wireApi: process.env.OPENAI_WIRE_API || 'chat-completions',
  }
}

function getAnthropicConfig() {
  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  return {
    provider: 'anthropic',
    apiKey: anthropicToken,
    authTokenType: process.env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key',
    baseUrl: trimTrailingSlash(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
    wireApi: 'messages',
  }
}

function getCodexSdkConfig() {
  return {
    provider: 'codex-sdk',
    apiKey: '',
    baseUrl: '',
    model: process.env.CODEX_MODEL || '',
    wireApi: 'codex-sdk',
    codexPath: process.env.CODEX_PATH || findExecutableOnPath('codex'),
    codexWorkingDirectory: process.env.CODEX_WORKING_DIRECTORY
      ? resolve(process.env.CODEX_WORKING_DIRECTORY)
      : '',
    codexSandboxMode: process.env.CODEX_SANDBOX_MODE || 'read-only',
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || 'high',
    codexReuseThread: process.env.CODEX_REUSE_THREAD !== 'false',
  }
}

function findExecutableOnPath(command) {
  const pathEntries = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return ''
}

function normalizeBackend(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['codex', 'codex-sdk'].includes(normalized)) return 'codex-sdk'
  if (['openai', 'openai-compatible', 'api', 'api-key'].includes(normalized)) return 'openai-compatible'
  if (normalized === 'anthropic') return 'anthropic'
  return ''
}

function loadDotEnv() {
  if (!existsSync(ENV_FILE)) return
  const content = readFileSync(ENV_FILE, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex <= 0) continue
    const key = trimmed.slice(0, equalsIndex).trim()
    const value = unquoteEnvValue(trimmed.slice(equalsIndex + 1).trim())
    if (!(key in process.env)) process.env[key] = value
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}
