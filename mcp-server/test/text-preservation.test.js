import assert from 'node:assert/strict'
import test from 'node:test'
import { preserveSourceText } from '../src/workflow/raw-layout-conversion.js'
import { compactNode } from '../src/workflow/page-planning-context.js'

test('source text preservation normalizes line endings without collapsing layout whitespace', () => {
  assert.equal(preserveSourceText('第一行\r\n第二行  保留空格\r第三行'), '第一行\n第二行  保留空格\n第三行')
})

test('planning context uses a compact text preview instead of duplicating full source text', () => {
  const text = `第一行\n${'很长的正文 '.repeat(80)}\n第三行`
  const node = compactNode({
    id: 'text-1',
    sourceNodeId: 'text-1',
    name: '正文',
    type: 'TEXT',
    role: 'text',
    text,
    style: { text: { fontSize: 16, lineHeight: 32 } },
  })

  assert.equal('characters' in node.text, false)
  assert.equal(node.text.characterCount, text.length)
  assert.equal(node.text.explicitLineCount, 3)
  assert.ok(node.text.preview.length <= 123)
})
