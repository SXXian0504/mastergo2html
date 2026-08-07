import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONNECT_TIMEOUT_MS } from '../src/timeouts.js'

test('model gateway connection waits up to 120 seconds by default', () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 120000)
})
