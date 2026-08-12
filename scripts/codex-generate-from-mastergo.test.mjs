import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_MASTERGO_ENV,
  buildCodexMasterGoEnv,
  buildGenerateFromMasterGoArgs,
} from './codex-generate-from-mastergo.mjs'

test('Codex MasterGo wrapper applies the required backend and timeout policy', () => {
  const env = buildCodexMasterGoEnv({ LLM_BACKEND: 'other', KEEP_ME: 'yes' })

  assert.equal(env.KEEP_ME, 'yes')
  for (const [name, value] of Object.entries(CODEX_MASTERGO_ENV)) {
    assert.equal(env[name], value)
  }
})

test('Codex MasterGo wrapper adds stable export and JSON defaults', () => {
  const args = buildGenerateFromMasterGoArgs(['--frame', 'Home'])

  assert.equal(args[1], 'generate-from-mastergo')
  assert.deepEqual(args.slice(2), [
    '--frame',
    'Home',
    '--export-timeout-ms',
    '600000',
    '--json',
  ])
})

test('Codex MasterGo wrapper preserves explicit export options', () => {
  const args = buildGenerateFromMasterGoArgs([
    '--export-timeout-ms',
    '120000',
    '--json',
  ])

  assert.deepEqual(args.slice(2), [
    '--export-timeout-ms',
    '120000',
    '--json',
  ])
})
