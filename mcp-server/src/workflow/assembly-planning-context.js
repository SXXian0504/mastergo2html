import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function buildAssemblyPlanningContext(jobDir) {
  const normalizedDir = join(jobDir, '01-normalized')
  const layoutDir = join(jobDir, '02-layout')
  const plansDir = join(jobDir, '03-page-plans')

  return {
    pageLayout: readJson(join(layoutDir, 'page-layout.json'), '02-layout/page-layout.json'),
    pageLayoutDescription: readText(join(layoutDir, 'page-layout.md'), '02-layout/page-layout.md'),
    componentStructurePlan: readText(
      join(plansDir, 'component-structure.plan.md'),
      '03-page-plans/component-structure.plan.md',
    ),
    staticAssetsPlan: readText(
      join(plansDir, 'static-assets.plan.md'),
      '03-page-plans/static-assets.plan.md',
    ),
    interactionPlan: readText(
      join(plansDir, 'interaction.plan.md'),
      '03-page-plans/interaction.plan.md',
    ),
    assetIndex: readJson(join(normalizedDir, 'asset-index.json'), '01-normalized/asset-index.json'),
    designTokens: readJson(join(normalizedDir, 'design-tokens.json'), '01-normalized/design-tokens.json'),
  }
}

function readText(path, relativePath) {
  if (!existsSync(path)) {
    throw new Error(`阶段七缺少必要输入：${relativePath}`)
  }
  return readFileSync(path, 'utf8')
}

function readJson(path, relativePath) {
  const content = readText(path, relativePath)
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`阶段七输入不是有效 JSON：${relativePath}`)
  }
}
