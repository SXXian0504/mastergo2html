import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendImmutableTextContractSection,
  buildImmutableTextContract,
  extractImmutableSourceTexts,
  readOrCreateImmutableSourceTexts,
} from '../src/workflow/immutable-source-texts.js'

test('immutable text contract keeps full copy out of analysis plans', () => {
  const sourceTexts = extractImmutableSourceTexts({
    nodes: [{ id: 'text-1', role: 'text', name: '正文', text: '这是一段不可修改且不应重复消耗计划 token 的长文本。' }],
  })
  const contract = buildImmutableTextContract(sourceTexts)
  const plan = appendImmutableTextContractSection('# 页面 DOM 结构\n内容', contract)

  assert.deepEqual(contract, {
    path: '01-normalized/source-texts.json',
    count: 1,
    sourceNodeIds: ['text-1'],
  })
  assert.match(plan, /# 不可变文本契约/)
  assert.doesNotMatch(plan, /这是一段不可修改/)
  assert.doesNotMatch(plan, /"characters"/)
})

test('old jobs materialize the canonical source text artifact on first read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'immutable-source-texts-'))
  const normalizedPath = join(dir, 'raw.normalized.json')
  const sourceTextsPath = join(dir, 'source-texts.json')
  writeFileSync(normalizedPath, JSON.stringify({
    nodes: [{ id: 'text-1', role: 'text', text: '原始文本' }],
  }))

  const sourceTexts = readOrCreateImmutableSourceTexts(sourceTextsPath, normalizedPath)

  assert.equal(existsSync(sourceTextsPath), true)
  assert.deepEqual(sourceTexts, [{ sourceNodeId: 'text-1', characters: '原始文本' }])
  assert.deepEqual(JSON.parse(readFileSync(sourceTextsPath, 'utf8')), sourceTexts)
})
