import assert from 'node:assert/strict'
import test from 'node:test'
import { getLlmConfig, validateLlmConfig, withLlmJobContext } from '../src/config.js'

const ENV_KEYS = [
  'LLM_BACKEND',
  'LLM_PROVIDER',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'CODEX_MODEL',
  'CODEX_PATH',
  'CODEX_WORKING_DIRECTORY',
  'CODEX_SANDBOX_MODE',
  'CODEX_REASONING_EFFORT',
  'CODEX_REUSE_THREAD',
]

test('openai-compatible backend validates API key configuration', () => withCleanEnv(() => {
  process.env.LLM_BACKEND = 'openai-compatible'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = 'https://example.test/v1/'
  process.env.OPENAI_MODEL = 'test-model'
  process.env.OPENAI_WIRE_API = 'responses'

  const config = getLlmConfig()
  assert.equal(config.provider, 'openai-compatible')
  assert.equal(config.baseUrl, 'https://example.test/v1')
  assert.equal(config.model, 'test-model')
  assert.equal(config.wireApi, 'responses')
  assert.deepEqual(validateLlmConfig(config), [])
}))

test('codex-sdk backend does not require an application API key', () => withCleanEnv(() => {
  process.env.LLM_BACKEND = 'codex-sdk'
  process.env.CODEX_SANDBOX_MODE = 'read-only'
  process.env.CODEX_REASONING_EFFORT = 'high'
  process.env.CODEX_REUSE_THREAD = 'true'

  const config = getLlmConfig()
  assert.equal(config.provider, 'codex-sdk')
  assert.equal(config.apiKey, '')
  assert.equal(config.codexReuseThread, true)
  assert.deepEqual(validateLlmConfig(config), [])

  const contextual = withLlmJobContext(config, { jobId: 'job-1', jobDir: '/tmp/job-1' })
  assert.equal(contextual.codexThreadKey, 'job-1')
  assert.equal(contextual.codexWorkingDirectory, '/tmp/job-1')
  assert.equal(contextual.codexThreadStatePath, '/tmp/job-1/.codex-sdk-threads.json')
}))

test('codex-sdk backend rejects unsupported sandbox and reasoning values', () => withCleanEnv(() => {
  process.env.LLM_BACKEND = 'codex-sdk'
  process.env.CODEX_SANDBOX_MODE = 'invalid'
  process.env.CODEX_REASONING_EFFORT = 'extreme'

  const errors = validateLlmConfig(getLlmConfig())
  assert.equal(errors.some((message) => message.includes('CODEX_SANDBOX_MODE')), true)
  assert.equal(errors.some((message) => message.includes('CODEX_REASONING_EFFORT')), true)
}))

function withCleanEnv(operation) {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  try {
    return operation()
  } finally {
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key]
      else process.env[key] = snapshot[key]
    }
  }
}
