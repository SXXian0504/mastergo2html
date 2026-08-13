import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { prepareResponsivePage } from './responsive-page.js'
import { extractStoredZip } from './zip.js'

export const AGENT_PAGE_BUNDLE_V1 = 'mastergo2html.page-bundle.v1'
export const AGENT_PAGE_BUNDLE_V2 = 'mastergo2html.page-bundle.v2'

export function prepareAgentPageBundleInput(inputPath, workspaceDir) {
  const resolvedInput = resolve(inputPath)
  if (!existsSync(resolvedInput)) throw new Error(`页面包不存在：${resolvedInput}`)
  const workspace = resolve(workspaceDir)
  const sourceDir = join(workspace, 'source')
  rmSync(sourceDir, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })
  const stat = statSync(resolvedInput)
  let bundleRoot
  if (stat.isDirectory()) bundleRoot = findBundleRoot(resolvedInput)
  else if (extname(resolvedInput).toLowerCase() === '.zip') {
    extractStoredZip(resolvedInput, sourceDir)
    bundleRoot = findBundleRoot(sourceDir)
  } else throw new Error('页面包必须是 ZIP 文件或包含 mastergo-pages.json 的目录。')

  const manifestPath = join(bundleRoot, 'mastergo-pages.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateAgentPageBundleManifest(manifest)
  const pages = manifest.pages.map((page, index) => {
    const inputKind = manifest.version === AGENT_PAGE_BUNDLE_V1 ? 'single-page' : page.inputKind
    const inputPath = resolve(bundleRoot, safeRelativePath(page.inputDir))
    if (!isInside(bundleRoot, inputPath)) throw new Error(`页面 ${page.name} 的 inputDir 越出页面包：${page.inputDir}`)
    if (inputKind === 'responsive-page') prepareResponsivePage(inputPath, join(workspace, `validate-responsive-${index}`))
    else validateSingleInput(inputPath, page.name)
    return {
      ...page,
      index,
      inputKind,
      inputPath,
      sourceNodeIds: Array.isArray(page.sourceNodeIds) ? page.sourceNodeIds : [page.sourceNodeId].filter(Boolean),
      frameScreenshotPath: inputKind === 'responsive-page'
        ? join(inputPath, 'variants', 'desktop', '00-input', 'frame-screenshot.png')
        : join(inputPath, 'frame-screenshot.png'),
    }
  })
  return { inputPath: resolvedInput, workspace, bundleRoot, manifestPath, manifest, pages }
}

export function validateAgentPageBundleManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('mastergo-pages.json 必须是 JSON 对象。')
  if (![AGENT_PAGE_BUNDLE_V1, AGENT_PAGE_BUNDLE_V2].includes(manifest.version)) {
    throw new Error(`不支持的 Agent 页面包版本：${manifest.version || 'missing'}。`)
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) throw new Error('mastergo-pages.json 至少需要包含一个页面。')
  if (manifest.version === AGENT_PAGE_BUNDLE_V2 && (!Number.isInteger(manifest.frameCount) || manifest.frameCount < manifest.pages.length)) {
    throw new Error('page-bundle.v2 的 frameCount 必须是不小于逻辑页面数的整数。')
  }
  const ids = new Set()
  const routes = new Set()
  const sourceNodeIds = new Set()
  let countedFrames = 0
  for (const [index, page] of manifest.pages.entries()) {
    if (!page || typeof page !== 'object') throw new Error(`pages[${index}] 必须是对象。`)
    for (const key of ['id', 'name', 'route', 'inputDir']) {
      if (typeof page[key] !== 'string' || !page[key].trim()) throw new Error(`pages[${index}].${key} 不能为空。`)
    }
    safeRelativePath(page.inputDir)
    if (!page.route.startsWith('/')) throw new Error(`页面路由必须以 / 开头：${page.route}`)
    if (ids.has(page.id)) throw new Error(`页面 id 重复：${page.id}`)
    if (routes.has(page.route)) throw new Error(`页面 route 重复：${page.route}`)
    if (manifest.version === AGENT_PAGE_BUNDLE_V2) {
      if (!['single-page', 'responsive-page'].includes(page.inputKind)) throw new Error(`pages[${index}].inputKind 无效：${page.inputKind || 'missing'}`)
      const expectedSources = page.inputKind === 'responsive-page' ? 2 : 1
      if (!Array.isArray(page.sourceNodeIds) || page.sourceNodeIds.length !== expectedSources || page.sourceNodeIds.some((id) => typeof id !== 'string' || !id)) {
        throw new Error(`pages[${index}].sourceNodeIds 必须包含 ${expectedSources} 个节点。`)
      }
      if (page.sourceNodeId !== page.sourceNodeIds[0]) throw new Error(`pages[${index}].sourceNodeId 必须等于 sourceNodeIds[0]。`)
      countedFrames += page.sourceNodeIds.length
      for (const sourceNodeId of page.sourceNodeIds) {
        if (sourceNodeIds.has(sourceNodeId)) throw new Error(`Frame 被多个逻辑页面重复引用：${sourceNodeId}`)
        sourceNodeIds.add(sourceNodeId)
      }
    }
    ids.add(page.id)
    routes.add(page.route)
  }
  if (manifest.version === AGENT_PAGE_BUNDLE_V2 && manifest.frameCount !== countedFrames) {
    throw new Error(`page-bundle.v2 的 frameCount=${manifest.frameCount} 与 sourceNodeIds 总数 ${countedFrames} 不一致。`)
  }
  return { ok: true, version: manifest.version }
}

function validateSingleInput(inputDir, pageName) {
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) throw new Error(`页面 ${pageName} 的 00-input 目录不存在：${inputDir}`)
  for (const file of ['raw.json', 'asset-manifest.json', 'export-options.json', 'frame-screenshot.png']) {
    const path = join(inputDir, file)
    if (!existsSync(path)) throw new Error(`页面 ${pageName} 缺少 ${file}。`)
    if (file.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'))
  }
}

function findBundleRoot(root) {
  if (existsSync(join(root, 'mastergo-pages.json'))) return root
  const matches = []
  walk(root, 4, (path) => { if (basename(path) === 'mastergo-pages.json') matches.push(dirname(path)) })
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error('页面包中缺少 mastergo-pages.json。')
  throw new Error('页面包中存在多个 mastergo-pages.json，无法确定入口。')
}

function walk(root, depth, visit) {
  if (depth < 0 || !existsSync(root) || !statSync(root).isDirectory()) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile()) visit(path)
    else if (entry.isDirectory()) walk(path, depth - 1, visit)
  }
}

function safeRelativePath(path) {
  const safe = normalize(String(path || ''))
  if (!safe || isAbsolute(safe) || safe.startsWith('..')) throw new Error(`非法页面 inputDir：${path}`)
  return safe
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
