import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function extractImmutableSourceTexts(normalized) {
  const texts = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.visible !== false && node.role === 'text' && typeof node.text === 'string' && node.text.trim()) {
      texts.push({
        sourceNodeId: node.sourceNodeId || node.id,
        ...(node.name === undefined ? {} : { name: node.name }),
        characters: node.text,
      })
    }
    for (const child of node.children || []) visit(child)
  }
  for (const node of normalized?.nodes || []) visit(node)
  return texts
}

export function buildImmutableTextContract(sourceTexts, path = '01-normalized/source-texts.json') {
  return {
    path,
    count: sourceTexts?.length || 0,
    sourceNodeIds: (sourceTexts || []).map((item) => item.sourceNodeId),
  }
}

export function readOrCreateImmutableSourceTexts(sourceTextsPath, normalizedPath) {
  if (existsSync(sourceTextsPath)) return JSON.parse(readFileSync(sourceTextsPath, 'utf8'))
  const sourceTexts = extractImmutableSourceTexts(JSON.parse(readFileSync(normalizedPath, 'utf8')))
  writeFileSync(sourceTextsPath, JSON.stringify(sourceTexts, null, 2), 'utf8')
  return sourceTexts
}

export function appendImmutableTextContractSection(markdown, contract) {
  const content = String(markdown || '').trimEnd()
  const section = [
    '# 不可变文本契约',
    '',
    '> 本章节由 workflow 程序化生成。完整原文不在计划中重复，避免增加后续输入 token；必须从下述唯一事实源按 sourceNodeId 读取 characters，禁止 AI 总结、改写、纠错、删减、扩写或调整字符顺序。',
    '',
    '```json',
    JSON.stringify(contract, null, 2),
    '```',
  ].join('\n')
  return `${content}\n\n${section}\n`
}
