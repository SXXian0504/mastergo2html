import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getGlobalModelConcurrencyMetrics,
  getGlobalModelConcurrencyState,
  MAX_GLOBAL_MODEL_CONCURRENCY,
  resetGlobalModelConcurrencyForTests,
  setGlobalModelConcurrency,
  withGlobalModelSlot,
} from '../src/llm/concurrency.js'

test.afterEach(() => {
  resetGlobalModelConcurrencyForTests()
})

test('global model limiter runs at most three operations and reports queued work', async () => {
  setGlobalModelConcurrency(3)
  let active = 0
  let maxActive = 0
  const queued = []
  const releases = []

  const tasks = Array.from({ length: 4 }, (_, index) => withGlobalModelSlot(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolvePromise) => releases.push(resolvePromise))
    active -= 1
    return index
  }, {
    onQueued: (state) => queued.push(state),
  }))

  await waitFor(() => releases.length === 3)
  assert.deepEqual(getGlobalModelConcurrencyState(), { activeCount: 3, queuedCount: 1, limit: 3 })
  assert.equal(queued.length, 1)
  assert.deepEqual(queued.map((state) => state.queuedCount), [1])

  releases.shift()()
  await waitFor(() => getGlobalModelConcurrencyState().queuedCount === 0 && releases.length === 3)
  assert.deepEqual(getGlobalModelConcurrencyState(), { activeCount: 3, queuedCount: 0, limit: 3 })

  while (releases.length > 0) releases.shift()()
  await waitFor(() => releases.length > 0 || getGlobalModelConcurrencyState().activeCount === 0)
  while (releases.length > 0) releases.shift()()

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3])
  assert.equal(maxActive, 3)
  assert.deepEqual(getGlobalModelConcurrencyState(), { activeCount: 0, queuedCount: 0, limit: 3 })
  assert.deepEqual(getGlobalModelConcurrencyMetrics(), {
    peakActiveCount: 3,
    totalAcquisitionCount: 4,
    queuedAcquisitionCount: 1,
  })
})

test('global model limiter rejects configured limits above the hard maximum', () => {
  assert.equal(MAX_GLOBAL_MODEL_CONCURRENCY, 3)
  assert.throws(() => setGlobalModelConcurrency(4), /1-3/)
})

test('global model limiter releases a slot when an operation fails', async () => {
  setGlobalModelConcurrency(1)
  await assert.rejects(withGlobalModelSlot(async () => {
    throw new Error('boom')
  }), /boom/)

  const value = await withGlobalModelSlot(async () => 'recovered')
  assert.equal(value, 'recovered')
  assert.deepEqual(getGlobalModelConcurrencyState(), { activeCount: 0, queuedCount: 0, limit: 1 })
})

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for test condition')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
}
