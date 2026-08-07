import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  generateCodexTextStreamDetailed,
  resetCodexSdkStateForTests,
} from '../src/llm/codex-sdk.js'

test.afterEach(() => {
  resetCodexSdkStateForTests()
})

test('Codex SDK adapter streams text, usage, progress, and persists its thread id', async () => {
  const root = join('/tmp', `mastergo-codex-sdk-${Date.now()}-${Math.random()}`)
  const statePath = join(root, '.codex-sdk-threads.json')
  const progress = []
  let prompt = ''
  const factory = async () => ({
    startThread(options) {
      assert.equal(options.sandboxMode, 'read-only')
      assert.equal(options.networkAccessEnabled, false)
      assert.equal(options.webSearchMode, 'disabled')
      return {
        id: 'thread-1',
        async runStreamed(input) {
          prompt = input
          return { events: successfulEvents('thread-1', 'generated html') }
        },
      }
    },
    resumeThread() {
      throw new Error('unexpected resume')
    },
  })

  const result = await generateCodexTextStreamDetailed({
    config: codexConfig(root, statePath),
    system: 'system rule',
    prompt: 'user request',
    retries: 0,
    onProgress: (metrics) => progress.push(metrics),
    codexFactory: factory,
  })

  assert.equal(result.text, 'generated html')
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    cachedInputTokens: 3,
    reasoningOutputTokens: 2,
    estimated: false,
  })
  assert.match(prompt, /<SYSTEM_INSTRUCTIONS>\nsystem rule/)
  assert.match(prompt, /<USER_PROMPT>\nuser request/)
  assert.equal(progress.some((item) => item.state === 'streaming'), true)
  assert.equal(progress.at(-1).state, 'validating')
  assert.equal(existsSync(statePath), true)
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).threads.default, 'thread-1')
})

test('Codex SDK adapter resumes a persisted thread and serializes turns for one page', async () => {
  const root = join('/tmp', `mastergo-codex-sdk-reuse-${Date.now()}-${Math.random()}`)
  const statePath = join(root, '.codex-sdk-threads.json')
  let starts = 0
  let active = 0
  let maxActive = 0
  let call = 0
  const thread = {
    id: 'thread-reuse',
    async runStreamed() {
      active += 1
      maxActive = Math.max(maxActive, active)
      const current = ++call
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
      active -= 1
      return { events: successfulEvents('thread-reuse', `answer-${current}`) }
    },
  }
  const factory = async () => ({
    startThread() {
      starts += 1
      return thread
    },
    resumeThread() {
      throw new Error('unexpected resume')
    },
  })
  const options = {
    config: codexConfig(root, statePath),
    system: 'system',
    prompt: 'prompt',
    retries: 0,
    codexFactory: factory,
  }

  const results = await Promise.all([
    generateCodexTextStreamDetailed(options),
    generateCodexTextStreamDetailed(options),
  ])

  assert.equal(starts, 1)
  assert.equal(maxActive, 1)
  assert.deepEqual(results.map((result) => result.text), ['answer-1', 'answer-2'])
})

test('Codex SDK adapter does not retry authentication failures', async () => {
  const root = join('/tmp', `mastergo-codex-sdk-auth-${Date.now()}-${Math.random()}`)
  let calls = 0
  const factory = async () => ({
    startThread() {
      return {
        id: 'thread-auth',
        async runStreamed() {
          calls += 1
          throw new Error('not logged in: authentication required')
        },
      }
    },
  })

  await assert.rejects(generateCodexTextStreamDetailed({
    config: codexConfig(root, join(root, '.threads.json')),
    system: 'system',
    prompt: 'prompt',
    retries: 2,
    codexFactory: factory,
  }), /authentication required/)
  assert.equal(calls, 1)
})

function codexConfig(root, statePath) {
  return {
    provider: 'codex-sdk',
    model: '',
    codexWorkingDirectory: root,
    codexSandboxMode: 'read-only',
    reasoningEffort: 'high',
    codexReuseThread: true,
    codexThreadKey: root,
    codexThreadStatePath: statePath,
  }
}

async function* successfulEvents(threadId, text) {
  yield { type: 'thread.started', thread_id: threadId }
  yield { type: 'turn.started' }
  yield { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text } }
  yield {
    type: 'turn.completed',
    usage: {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    },
  }
}
