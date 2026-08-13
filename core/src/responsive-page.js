import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { extractStoredZip } from './zip.js'

export const RESPONSIVE_PAGE_VERSION = 'mastergo2html.responsive-page.v1'
export const MOBILE_FRAME_SUFFIX = '-移动端'

export function isResponsivePageInput(inputPath) {
  const resolved = resolve(inputPath)
  if (!existsSync(resolved)) return false
  const stat = statSync(resolved)
  if (stat.isDirectory()) {
    try { findResponsiveRoot(resolved); return true } catch { return false }
  }
  if (extname(resolved).toLowerCase() !== '.zip') return false
  return readFileSync(resolved).includes(Buffer.from('mastergo-responsive-page.json'))
}

export function pairResponsiveFrames(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length !== 2) return null
  const mobileMax = Number(options.mobileMax ?? 767)
  const desktopMin = Number(options.desktopMin ?? 900)
  const candidates = frames.map((frame) => ({
    ...frame,
    name: String(frame?.name || '').trim(),
    width: Number(frame?.width ?? frame?.viewport?.width),
    height: Number(frame?.height ?? frame?.viewport?.height),
  }))
  if (candidates.some((frame) => frame.type && frame.type !== 'FRAME')) return null
  const mobile = candidates.find((frame) => frame.name.endsWith(MOBILE_FRAME_SUFFIX))
  if (!mobile) return null
  const desktop = candidates.find((frame) => frame !== mobile)
  const baseName = mobile.name.slice(0, -MOBILE_FRAME_SUFFIX.length).trim()
  if (!desktop || !baseName || desktop.name !== baseName) return null
  if (!Number.isFinite(desktop.width) || !Number.isFinite(mobile.width)) return null
  if (desktop.width < desktopMin || mobile.width > mobileMax || mobile.width >= desktop.width) return null
  return { baseName, desktop, mobile, mobileMax }
}

export function prepareResponsivePage(inputPath, workspaceDir) {
  const resolvedInput = resolve(inputPath)
  if (!existsSync(resolvedInput)) throw new Error(`响应式页面输入不存在：${resolvedInput}`)
  const workspace = resolve(workspaceDir)
  const sourceDir = join(workspace, 'responsive-source')
  rmSync(sourceDir, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })

  let bundleRoot
  const stat = statSync(resolvedInput)
  if (stat.isDirectory()) bundleRoot = findResponsiveRoot(resolvedInput)
  else if (extname(resolvedInput).toLowerCase() === '.zip') {
    extractStoredZip(resolvedInput, sourceDir)
    bundleRoot = findResponsiveRoot(sourceDir)
  } else throw new Error('响应式页面输入必须是 ZIP 或包含 mastergo-responsive-page.json 的目录。')

  const manifestPath = join(bundleRoot, 'mastergo-responsive-page.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateResponsivePageManifest(manifest)
  const variants = Object.fromEntries(['desktop', 'mobile'].map((kind) => {
    const variant = manifest.variants[kind]
    const inputDir = resolve(bundleRoot, assertSafeRelativePath(variant.inputDir))
    if (!isInside(bundleRoot, inputDir)) throw new Error(`${kind} inputDir 越出响应式页面包：${variant.inputDir}`)
    validateVariantInput(inputDir, kind)
    return [kind, { ...variant, kind, inputPath: inputDir }]
  }))
  return { inputPath: resolvedInput, workspace, bundleRoot, manifestPath, manifest, variants }
}

export function validateResponsivePageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('响应式页面 manifest 必须是对象。')
  if (manifest.version !== RESPONSIVE_PAGE_VERSION) throw new Error(`不支持的响应式页面版本：${manifest.version || 'missing'}。`)
  if (!manifest.page || typeof manifest.page.name !== 'string' || !manifest.page.name.trim()) throw new Error('响应式页面缺少 page.name。')
  const desktop = manifest.variants?.desktop
  const mobile = manifest.variants?.mobile
  for (const [kind, variant] of [['desktop', desktop], ['mobile', mobile]]) {
    if (!variant || typeof variant !== 'object') throw new Error(`响应式页面缺少 ${kind} variant。`)
    for (const key of ['name', 'sourceNodeId', 'inputDir']) {
      if (typeof variant[key] !== 'string' || !variant[key].trim()) throw new Error(`${kind}.${key} 不能为空。`)
    }
    if (!Number.isFinite(Number(variant.viewport?.width)) || !Number.isFinite(Number(variant.viewport?.height))) {
      throw new Error(`${kind}.viewport 必须包含有效宽高。`)
    }
  }
  const pair = pairResponsiveFrames([
    { ...desktop, type: 'FRAME', width: desktop.viewport.width, height: desktop.viewport.height },
    { ...mobile, type: 'FRAME', width: mobile.viewport.width, height: mobile.viewport.height },
  ], { mobileMax: manifest.breakpoints?.mobileMax })
  if (!pair) throw new Error('desktop/mobile 名称或尺寸不满足响应式配对规则。')
  if (manifest.page.baseName && manifest.page.baseName !== pair.baseName) throw new Error('page.baseName 与 Frame 配对结果不一致。')
  return { ok: true, pair }
}

function validateVariantInput(inputDir, kind) {
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) throw new Error(`${kind} 00-input 目录不存在。`)
  for (const file of ['raw.json', 'asset-manifest.json', 'export-options.json', 'frame-screenshot.png']) {
    if (!existsSync(join(inputDir, file))) throw new Error(`${kind} 00-input 缺少 ${file}。`)
  }
  for (const file of ['raw.json', 'asset-manifest.json', 'export-options.json']) JSON.parse(readFileSync(join(inputDir, file), 'utf8'))
}

function findResponsiveRoot(root) {
  if (existsSync(join(root, 'mastergo-responsive-page.json'))) return root
  const matches = []
  walk(root, 3, (path) => { if (basename(path) === 'mastergo-responsive-page.json') matches.push(dirname(path)) })
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error('输入中缺少 mastergo-responsive-page.json。')
  throw new Error('输入中存在多个 mastergo-responsive-page.json，无法确定入口。')
}

function walk(root, depth, visit) {
  if (depth < 0 || !existsSync(root) || !statSync(root).isDirectory()) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile()) visit(path)
    else if (entry.isDirectory()) walk(path, depth - 1, visit)
  }
}

function assertSafeRelativePath(path) {
  const safe = normalize(String(path || ''))
  if (!safe || isAbsolute(safe) || safe.startsWith('..')) throw new Error(`非法响应式页面相对路径：${path}`)
  return safe
}

function isInside(root, target) {
  const relative = target.slice(resolve(root).length)
  return relative === '' || relative.startsWith('/') || relative.startsWith('\\')
}

export function writeResponsiveManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
