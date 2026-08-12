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

function validateAgentQuality({ html, css, errors, warnings, agentQuality }) {
  if (!agentQuality) return
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
