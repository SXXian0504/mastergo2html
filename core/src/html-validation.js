import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const REQUIRED_HTML_FILES = Object.freeze(['index.html', 'styles.css', 'script.js'])

export function readHtmlFiles(directory) {
  for (const file of REQUIRED_HTML_FILES) {
    const path = join(directory, file)
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Agent draft is missing a valid ${file}`)
    }
  }
  return {
    indexHtml: readFileSync(join(directory, 'index.html'), 'utf8'),
    stylesCss: readFileSync(join(directory, 'styles.css'), 'utf8'),
    scriptJs: readFileSync(join(directory, 'script.js'), 'utf8'),
  }
}

export function writeHtmlFiles(directory, files) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.html'), files.indexHtml, 'utf8')
  writeFileSync(join(directory, 'styles.css'), files.stylesCss, 'utf8')
  writeFileSync(join(directory, 'script.js'), files.scriptJs, 'utf8')
}

export function validateHtmlFirstPass(files, {
  sourceTexts = [],
  assetIndex = {},
  fontAssets = {},
  nodeStyleFacts = {},
  draftDir,
  agentQuality = null,
} = {}) {
  const errors = []
  const warnings = []
  const html = String(files?.indexHtml || '')
  const css = String(files?.stylesCss || '')
  const js = String(files?.scriptJs || '')
  if (!/<!doctype\s+html/i.test(html)) warnings.push('index.html does not declare an HTML doctype')
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) errors.push('index.html is missing html/body structure')
  if (!/<link\b[^>]*href=["'](?:\.\/)?styles\.css["']/i.test(html)) errors.push('index.html does not reference styles.css')
  if (!/<script\b[^>]*src=["'](?:\.\/)?script\.js["']/i.test(html)) errors.push('index.html does not reference script.js')
  if (!balanced(stripCssStrings(css), '{', '}')) errors.push('CSS braces are unbalanced')
  try { new Function(js) } catch (error) { errors.push(`JavaScript syntax error: ${error.message}`) }
  if (/<(?:img|script|link|source|video|audio)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html) || /(?:url\(|@import\s+)[^;\n]*https?:\/\//i.test(css)) {
    errors.push('Network resources are forbidden')
  }
  if (/(?:src|href)=["'](?:\.\.\/|\/)/i.test(html) || /url\(\s*["']?(?:\.\.\/|\/)/i.test(css)) {
    errors.push('References outside the output directory are forbidden')
  }

  const textEntries = Array.isArray(sourceTexts) ? sourceTexts : sourceTexts?.texts || sourceTexts?.items || []
  for (const text of textEntries) {
    const id = String(text?.sourceNodeId || text?.nodeId || '')
    const characters = String(text?.characters ?? text?.text ?? '')
    if (!characters) continue
    if (!html.includes(escapeHtml(characters)) && !html.includes(characters)) errors.push(`Source text is missing: ${id || characters.slice(0, 24)}`)
    if (id && !new RegExp(`data-text-source-node-id=["']${escapeRegExp(id)}["']`).test(html)) errors.push(`Text binding is missing: ${id}`)
  }
  for (const fact of nodeStyleFacts?.facts || []) {
    if (!fact?.bindingRequired && !fact?.textBindingRequired && !fact?.compactSurfaceRequired && !fact?.rasterEffect) continue
    const id = String(fact?.sourceNodeId || '')
    if (id && !new RegExp(`data-style-source-node-id=["']${escapeRegExp(id)}["']`).test(html)) errors.push(`Style binding is missing: ${id}`)
  }

  const allowedAssets = new Set()
  const forbiddenAssets = new Set()
  for (const asset of assetIndex?.assets || []) {
    const paths = [asset?.preferred?.copiedPath, asset?.copiedPath, ...(asset?.rendered || []).map((item) => item?.path)].filter(Boolean)
    for (const path of paths) {
      if (['review-only', 'forbidden-final'].includes(asset?.renderPolicy)) forbiddenAssets.add(path)
      else allowedAssets.add(path)
    }
  }
  for (const path of fontAssets?.files || []) allowedAssets.add(path)
  for (const value of referencedAssets(html, css)) {
    if (forbiddenAssets.has(value)) errors.push(`Forbidden asset is referenced: ${value}`)
    else if (!allowedAssets.has(value)) errors.push(`Asset is not present in asset-index: ${value}`)
    else if (draftDir && !existsSync(join(draftDir, value))) errors.push(`Referenced asset file is missing: ${value}`)
  }
  validateBoundVisualFacts({ html, css, nodeStyleFacts, errors })
  validateRequiredLogoAssets({ html, css, assetIndex, errors })
  validateNavigationCompositeExclusivity({ html, assetIndex, errors })
  validateResponsiveProcessIcons({ html, css, assetIndex, agentQuality, errors })
  validateAgentQuality({ html, css, errors, warnings, agentQuality })
  return {
    version: 'mastergo2html.first-pass-validation.v1',
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    checkedAt: new Date().toISOString(),
    transport: {
      mode: 'direct-files',
      jsonEnvelopeParsed: false,
      files: REQUIRED_HTML_FILES.map((file) => ({ file, sizeBytes: byteSize(files, file) })),
    },
  }
}

function validateResponsiveProcessIcons({ html, css, assetIndex, agentQuality, errors }) {
  if (!agentQuality?.responsiveRequired) return
  const iconFacts = collectHorizontalProcessIconFacts(html, assetIndex)
  if (iconFacts.size < 3) return
  const mobileCss = extractMaxWidthMediaCss(css, 0, 1280)

  for (const match of mobileCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim()
    const declarations = match[2]
    const affected = affectedProcessIcons(selector, html, iconFacts)
    if (affected.length === 0) continue

    const scaleMatch = declarations.match(/(?:^|;)\s*transform\s*:\s*[^;]*?scale\(\s*(\d*\.?\d+)/i)
    if (scaleMatch) {
      const scale = Number(scaleMatch[1])
      const undersized = affected.filter((fact) => fact.size * scale < 48)
      if (undersized.length > 0) {
        errors.push(`Responsive process collection scales meaningful icons below 48px: ${undersized.map((fact) => fact.sourceNodeId).join(', ')}`)
      }
    }

    for (const fact of affected) {
      if (!selector.includes(`data-source-node-id="${fact.sourceNodeId}"`) && !selector.includes(`data-source-node-id='${fact.sourceNodeId}'`)) continue
      const width = declarations.match(/(?:^|;)\s*width\s*:\s*(\d*\.?\d+)px/i)
      const height = declarations.match(/(?:^|;)\s*height\s*:\s*(\d*\.?\d+)px/i)
      if ((width && Number(width[1]) < 48) || (height && Number(height[1]) < 48)) {
        errors.push(`Responsive process icon is smaller than 48px: ${fact.sourceNodeId}`)
      }
    }
  }
}

function collectHorizontalProcessIconFacts(html, assetIndex) {
  const candidateFacts = new Map()
  for (const asset of assetIndex?.assets || []) {
    for (const source of asset?.sourceNodes || []) {
      const isIcon = source?.usageHint === 'icon'
        || (source?.semanticHints || []).some((hint) => hint?.usage === 'icon')
      const bounds = source?.bounds
      const size = Math.min(Number(bounds?.width), Number(bounds?.height))
      const id = String(source?.sourceNodeId || '')
      if (!isIcon || !id || !Number.isFinite(size) || size < 48) continue
      const current = candidateFacts.get(id)
      if (!current || size > current.size) candidateFacts.set(id, { sourceNodeId: id, size })
    }
  }

  const processFacts = new Map()
  for (const open of html.matchAll(/<([a-z][\w-]*)\b[^>]*data-layout-skeleton=["']repeated-list["'][^>]*data-layout-axis=["']horizontal["'][^>]*>/gi)) {
    const block = findElementBlock(html, open.index, open[1])
    const contained = [...candidateFacts.values()].filter((fact) => new RegExp(`data-source-node-id=["']${escapeRegExp(fact.sourceNodeId)}["']`).test(block))
    if (contained.length < 3) continue
    for (const fact of contained) processFacts.set(fact.sourceNodeId, fact)
  }
  return processFacts
}

function affectedProcessIcons(selector, html, iconFacts) {
  if (/(?:mg-flow-collection|data-layout-skeleton\s*=\s*["']repeated-list)/i.test(selector)) return [...iconFacts.values()]
  const affected = new Map()
  for (const idMatch of selector.matchAll(/data-source-node-id\s*=\s*["']([^"']+)["']/gi)) {
    const id = idMatch[1]
    if (iconFacts.has(id)) affected.set(id, iconFacts.get(id))
    const block = findSourceNodeBlock(html, id)
    for (const fact of iconFacts.values()) {
      if (new RegExp(`data-source-node-id=["']${escapeRegExp(fact.sourceNodeId)}["']`).test(block)) affected.set(fact.sourceNodeId, fact)
    }
  }
  return [...affected.values()]
}

function findSourceNodeBlock(html, sourceNodeId) {
  const open = new RegExp(`<([a-z][\\w-]*)\\b[^>]*data-source-node-id=["']${escapeRegExp(sourceNodeId)}["'][^>]*>`, 'i').exec(html)
  return open ? findElementBlock(html, open.index, open[1]) : ''
}

function findElementBlock(html, startIndex, tag) {
  const token = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi')
  token.lastIndex = startIndex
  let depth = 0
  let match
  while ((match = token.exec(html))) {
    if (match[0][1] === '/') depth -= 1
    else if (!/\/>$/.test(match[0])) depth += 1
    if (depth === 0) return html.slice(startIndex, token.lastIndex)
  }
  return ''
}

function validateBoundVisualFacts({ html, css, nodeStyleFacts, errors }) {
  const source = `${html}\n${css}`.replace(/\s+/g, '').toLowerCase()
  for (const fact of nodeStyleFacts?.facts || []) {
    const id = String(fact?.sourceNodeId || '')
    const assetMode = String(fact?.rasterEffect?.assetMode || '')
    if (assetMode.startsWith('required-final-') || fact?.coveredByRenderedSlice) continue
    const backgroundBlur = (fact?.rasterEffect?.effects || []).find((effect) => effect?.type === 'BACKGROUND_BLUR')
    const cssBoundVisual = fact?.bindingRequired || fact?.compactSurfaceRequired || (backgroundBlur && assetMode === 'css-fallback')
    const color = String(fact?.resolvedBackgroundColor || '')
    if (cssBoundVisual && id && /^rgba\([^)]*,\s*0?\.\d+\)$/i.test(color) && !source.includes(color.replace(/\s+/g, '').toLowerCase())) {
      errors.push(`Translucent background color is missing for source node: ${id} (${color})`)
    }
    const radius = Number(backgroundBlur?.radius)
    if (id && Number.isFinite(radius) && radius > 0) {
      const blurPattern = new RegExp(`(?:-webkit-)?backdrop-filter\\s*:\\s*blur\\(\\s*${escapeRegExp(trimNumber(radius))}px\\s*\\)`, 'i')
      if (!blurPattern.test(`${html}\n${css}`)) errors.push(`Background blur is missing for source node: ${id} (${trimNumber(radius)}px)`)
    }
  }
}

function validateRequiredLogoAssets({ html, css, assetIndex, errors }) {
  const referenced = new Set(referencedAssets(html, css))
  for (const asset of assetIndex?.assets || []) {
    if (asset?.renderPolicy !== 'required-final') continue
    const explicitlyLogo = asset?.usageHint === 'logo'
      || (asset?.sourceNodes || []).some((source) => source?.usageHint === 'logo')
    if (!explicitlyLogo) continue
    const paths = [asset?.preferred?.copiedPath, asset?.copiedPath, ...(asset?.rendered || []).map((item) => item?.path)].filter(Boolean)
    if (!paths.some((path) => referenced.has(path))) errors.push(`Required logo asset is missing: ${asset.assetId}`)
  }
}

function validateNavigationCompositeExclusivity({ html, assetIndex, errors }) {
  if (!/<nav\b/i.test(html)) return
  const sourceTextTags = new Map()
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*data-text-source-node-id=["']([^"']+)["'][^>]*)>/gi)) {
    const attrs = match[2]
    const id = match[3]
    const hidden = /(?:visually-hidden|mg-source-contract)/i.test(attrs)
      || /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(attrs)
    const list = sourceTextTags.get(id) || []
    list.push({ tag: match[1].toLowerCase(), hidden })
    sourceTextTags.set(id, list)
  }
  for (const [id, tags] of sourceTextTags) {
    if (tags.some((item) => ['a', 'button'].includes(item.tag)) && tags.filter((item) => !item.hidden).length > 1) {
      errors.push(`Navigation source text has multiple visible representations: ${id}`)
    }
  }
  for (const asset of assetIndex?.assets || []) {
    const navigationSource = (asset?.sourceNodes || []).some((source) =>
      /(?:导航|header|nav|navigation|menu|菜单|tab|tabs)/i.test(String(source?.sourceNodeName || '')),
    )
    if (!navigationSource || !['required-final', undefined].includes(asset?.renderPolicy)) continue
    const paths = [asset?.preferred?.copiedPath, asset?.copiedPath, ...(asset?.rendered || []).map((item) => item?.path)].filter(Boolean)
    if (paths.some((path) => html.includes(`src="${path}"`) || html.includes(`src='${path}'`))) {
      errors.push(`Navigation composite asset must not be visible with semantic nav: ${asset.assetId}`)
    }
  }
}

function validateAgentQuality({ html, css, errors, warnings, agentQuality }) {
  if (!agentQuality) return
  validateGlobalDecorationOwnership({ html, errors, agentQuality })
  if (agentQuality.semanticNavigationRequired) {
    if (!/<nav\b/i.test(html)) errors.push('Semantic navigation is required for a header with source navigation text')
    const interactiveBindings = [...html.matchAll(/<(?:a|button)\b[^>]*data-text-source-node-id=["']([^"']+)["'][^>]*>/gi)]
    if (interactiveBindings.length === 0) errors.push('Visible source-bound navigation links or buttons are required')
    if (interactiveBindings.some((match) => /(?:opacity\s*:\s*0(?:[;"']|$)|color\s*:\s*transparent|visibility\s*:\s*hidden)/i.test(match[0]))) {
      errors.push('Transparent navigation hotspots are forbidden')
    }
    if (!/:hover\b/.test(css)) errors.push('Visible controls require a hover state')
    if (!/:focus-visible\b/.test(css)) errors.push('Visible controls require a focus-visible state')
  }
  if (agentQuality.responsiveRequired && !/@media\b/i.test(css)) errors.push('Responsive CSS breakpoints are required')
  if (agentQuality.responsiveRequired && !/prefers-reduced-motion/.test(css)) warnings.push('Reduced-motion handling is recommended for Agent interactions')
  if (agentQuality.responsivePage) {
    const mobileMax = Number(agentQuality.responsivePage.mobileMax || 767)
    const mediaQueries = [...css.matchAll(/@media\s*([^\{]+)\{/gi)].map((match) => match[1])
    const coversMobile = mediaQueries.some((query) => {
      const max = query.match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/i)
      return max && Number(max[1]) >= mobileMax
    })
    if (!coversMobile) errors.push(`Responsive page requires a media query covering max-width ${mobileMax}px`)
    const desktopFixedMinimum = /\.mg-prototype-root\s*\{[^}]*min-width\s*:\s*(?:9\d{2}|[1-9]\d{3,})px/i.test(css)
    const mobileCss = extractMaxWidthMediaCss(css, mobileMax)
    const resetsDesktopWidth = /\.mg-prototype-root\s*\{[^}]*(?:min-width\s*:\s*(?:0|auto|unset)|max-width\s*:\s*100%|width\s*:\s*100%)/i.test(mobileCss)
    if (desktopFixedMinimum && !resetsDesktopWidth) {
      errors.push('Responsive page keeps the desktop fixed minimum width without a mobile override')
    }
    for (const sourceNodeId of agentQuality.responsivePage.mobileOnlyTextIds || []) {
      if (!new RegExp(`data-text-source-node-id=["']${escapeRegExp(sourceNodeId)}["']`).test(html)) {
        errors.push(`Mobile-only text binding is missing: ${sourceNodeId}`)
      }
    }
    const usedAssets = new Set(referencedAssets(html, css))
    for (const asset of agentQuality.responsivePage.requiredMobileAssets || []) {
      if (!(asset.paths || []).some((path) => usedAssets.has(path))) {
        errors.push(`Required mobile asset is missing: ${asset.assetId}`)
      }
    }
  }
  for (const promotion of agentQuality.heroForegroundPromotions || []) {
    const hero = findModuleBlock(html, promotion.heroModuleId, 'hero')
    if (!hero || !new RegExp(`data-source-node-id=["']${escapeRegExp(promotion.sourceNodeId)}["']`).test(hero)) {
      errors.push(`Hero foreground is outside its hero module: ${promotion.sourceNodeId}`)
    }
  }
}

function validateGlobalDecorationOwnership({ html, errors, agentQuality }) {
  const decorationIds = agentQuality.globalDecorationIds || []
  if (decorationIds.length === 0) return
  const moduleBlocks = (agentQuality.moduleIds || []).map((moduleId) => ({
    moduleId,
    html: findModuleBlock(html, moduleId, '__never__'),
  })).filter((item) => item.html)
  for (const id of decorationIds) {
    const binding = new RegExp(`data-source-node-id=["']${escapeRegExp(id)}["']`)
    if (!binding.test(html)) {
      errors.push(`Global decoration is missing: ${id}`)
      continue
    }
    const owner = moduleBlocks.find((item) => binding.test(item.html))
    if (owner) errors.push(`Global decoration entered module ${owner.moduleId}: ${id}`)
  }
}

function findModuleBlock(html, moduleId, moduleType) {
  const open = new RegExp(`<([a-z][\\w-]*)\\b[^>]*(?:data-module-id=["']${escapeRegExp(moduleId)}["']|data-module-type=["']${escapeRegExp(moduleType)}["'])[^>]*>`, 'i').exec(html)
  if (!open) return ''
  const tag = open[1]
  const token = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, 'gi')
  token.lastIndex = open.index
  let depth = 0
  let match
  while ((match = token.exec(html))) {
    if (match[0][1] === '/') depth -= 1
    else if (!/\/>$/.test(match[0])) depth += 1
    if (depth === 0) return html.slice(open.index, token.lastIndex)
  }
  return ''
}

function trimNumber(value) {
  return String(Math.round(Number(value) * 1000) / 1000)
}

function extractMaxWidthMediaCss(css, minimumMaxWidth, maximumMaxWidth = Number.POSITIVE_INFINITY) {
  const blocks = []
  const media = /@media\s*([^\{]+)\{/gi
  let match
  while ((match = media.exec(css))) {
    const max = match[1].match(/max-width\s*:\s*(\d+(?:\.\d+)?)px/i)
    if (!max || Number(max[1]) < minimumMaxWidth || Number(max[1]) > maximumMaxWidth) continue
    let depth = 1
    let index = media.lastIndex
    for (; index < css.length && depth > 0; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') depth -= 1
    }
    blocks.push(css.slice(media.lastIndex, Math.max(media.lastIndex, index - 1)))
  }
  return blocks.join('\n')
}

export function copyDirectory(sourceDir, targetDir) {
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
}

export function publishDirectory(sourceDir, outputDir) {
  const staging = `${outputDir}.staging`
  const backup = `${outputDir}.previous`
  rmSync(staging, { recursive: true, force: true })
  copyDirectory(sourceDir, staging)
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(outputDir)) renameSync(outputDir, backup)
  try {
    renameSync(staging, outputDir)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(backup) && !existsSync(outputDir)) renameSync(backup, outputDir)
    throw error
  }
}

export async function smokeTestDirectory(outputDir) {
  readHtmlFiles(outputDir)
  const html = readFileSync(join(outputDir, 'index.html'), 'utf8')
  if (html.includes('\\\\') || /(?:^|["'(])\/(?:Users|private|tmp)\//.test(html)) throw new Error('HTML contains a local absolute path')
  return { status: 'passed', ok: true, mode: 'filesystem' }
}

function referencedAssets(html, css) {
  const values = []
  for (const match of String(html).matchAll(/(?:src|href)=["']([^"']+)["']/gi)) if (match[1].startsWith('assets/')) values.push(match[1])
  for (const match of String(css).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) if (match[1].startsWith('assets/')) values.push(match[1])
  return [...new Set(values)]
}

function byteSize(files, name) {
  const key = name === 'index.html' ? 'indexHtml' : name === 'styles.css' ? 'stylesCss' : 'scriptJs'
  return Buffer.byteLength(String(files?.[key] || ''))
}

function balanced(value, open, close) {
  let depth = 0
  for (const char of value) {
    if (char === open) depth += 1
    if (char === close) depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}

function stripCssStrings(value) {
  return String(value).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
