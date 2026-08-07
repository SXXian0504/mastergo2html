const waiters = []
let activeCount = 0
let overrideLimit = null
let peakActiveCount = 0
let totalAcquisitionCount = 0
let queuedAcquisitionCount = 0

export async function withGlobalModelSlot(operation, { onQueued } = {}) {
  const limit = getGlobalModelConcurrency()
  totalAcquisitionCount += 1
  if (activeCount >= limit) {
    queuedAcquisitionCount += 1
    onQueued?.({ activeCount, limit, queuedCount: waiters.length + 1 })
  }
  await acquire(limit)
  try {
    return await operation()
  } finally {
    release()
  }
}

export function getGlobalModelConcurrency() {
  const configured = overrideLimit ?? Number(process.env.GLOBAL_MODEL_CONCURRENCY || 2)
  return Number.isInteger(configured) && configured > 0 ? configured : 2
}

export function setGlobalModelConcurrency(limit) {
  const parsed = Number(limit)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`全局模型并发必须是正整数：${limit}`)
  overrideLimit = parsed
  drain()
}

export function getGlobalModelConcurrencyState() {
  return { activeCount, queuedCount: waiters.length, limit: getGlobalModelConcurrency() }
}

export function getGlobalModelConcurrencyMetrics() {
  return {
    peakActiveCount,
    totalAcquisitionCount,
    queuedAcquisitionCount,
  }
}

export function resetGlobalModelConcurrencyMetrics() {
  peakActiveCount = activeCount
  totalAcquisitionCount = 0
  queuedAcquisitionCount = 0
}

function acquire(limit) {
  if (activeCount < limit) {
    activeCount += 1
    peakActiveCount = Math.max(peakActiveCount, activeCount)
    return Promise.resolve()
  }
  return new Promise((resolvePromise) => waiters.push(resolvePromise))
}

function release() {
  activeCount = Math.max(0, activeCount - 1)
  drain()
}

function drain() {
  const limit = getGlobalModelConcurrency()
  while (waiters.length > 0 && activeCount < limit) {
    activeCount += 1
    peakActiveCount = Math.max(peakActiveCount, activeCount)
    waiters.shift()()
  }
}

export function resetGlobalModelConcurrencyForTests() {
  if (activeCount !== 0 || waiters.length !== 0) throw new Error('仍有模型任务运行，无法重置并发器。')
  overrideLimit = null
  resetGlobalModelConcurrencyMetrics()
}
