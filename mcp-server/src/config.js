import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = join(ROOT, '.env')

loadDotEnv()

function sanitizeModelName(model) {
  return (model || '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()
}

export function resolveEffectiveConfig(config) {
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
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_MODEL) {
    return {
      provider: 'openai-compatible',
      apiKey: process.env.OPENAI_API_KEY || '',
      authTokenType: 'bearer',
      baseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      wireApi: process.env.OPENAI_WIRE_API || 'chat-completions',
    }
  }

  const anthropicToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || ''
  if (anthropicToken || process.env.ANTHROPIC_BASE_URL) {
    return {
      provider: 'anthropic',
      apiKey: anthropicToken,
      authTokenType: process.env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key',
      baseUrl: trimTrailingSlash(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      wireApi: 'messages',
    }
  }

  return {
    provider: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY || '',
    authTokenType: 'bearer',
    baseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    wireApi: process.env.OPENAI_WIRE_API || 'chat-completions',
  }
}

export function assertLlmConfig(config = getLlmConfig()) {
  if (!config.apiKey) {
    throw new Error('缺少模型 API Key。请在 mcp-server/.env 中配置 OPENAI_API_KEY。')
  }
  if (!config.baseUrl) {
    throw new Error('缺少模型 BASE_URL。')
  }
  if (!config.model) {
    throw new Error('缺少模型名称。')
  }
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
