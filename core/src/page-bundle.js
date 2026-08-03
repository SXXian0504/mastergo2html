import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { runGenerateFromInput } from './runner.js'
import { extractStoredZip } from './zip.js'

const PAGE_BUNDLE_VERSION = 'mastergo2html.page-bundle.v1'

export function preparePageBundle(inputPath, workspaceDir) {
  const resolvedInput = resolve(inputPath)
  if (!existsSync(resolvedInput)) throw new Error(`页面包不存在：${resolvedInput}`)

  const workspace = resolve(workspaceDir)
  const sourceDir = join(workspace, 'source')
  rmSync(sourceDir, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })

  const stat = statSync(resolvedInput)
  let bundleRoot
  if (stat.isDirectory()) {
    bundleRoot = findBundleRoot(resolvedInput)
  } else if (extname(resolvedInput).toLowerCase() === '.zip') {
    extractStoredZip(resolvedInput, sourceDir)
    bundleRoot = findBundleRoot(sourceDir)
  } else {
    throw new Error('页面包必须是 ZIP 文件或包含 mastergo-pages.json 的目录。')
  }

  const manifestPath = join(bundleRoot, 'mastergo-pages.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validatePageBundleManifest(manifest)

  const pages = manifest.pages.map((page, index) => {
    const safeInputDir = assertSafeBundlePath(page.inputDir)
    const pageInputPath = resolve(bundleRoot, safeInputDir)
    if (!isInside(bundleRoot, pageInputPath)) throw new Error(`页面 ${page.name} 的 inputDir 越出页面包：${page.inputDir}`)
    validatePageInput(pageInputPath, page.name)
    return {
      ...page,
      index,
      inputPath: pageInputPath,
    }
  })

  return {
    inputPath: resolvedInput,
    workspace,
    bundleRoot,
    manifestPath,
    manifest,
    pages,
  }
}

export async function runGeneratePageBundle(inputPath, options = {}) {
  const batchId = options.batchId || randomUUID()
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/page-batches')
  const batchDir = join(batchRoot, batchId)
  const jobsRoot = join(batchDir, 'jobs')
  mkdirSync(jobsRoot, { recursive: true })

  const prepared = preparePageBundle(inputPath, batchDir)
  const startedAt = new Date().toISOString()
  const results = []
  const continueOnError = options.continueOnError !== false
  const emit = () => writeBatchRecord(batchDir, {
    version: 'mastergo2html.page-batch-result.v1',
    batchId,
    status: results.length === prepared.pages.length
      ? (results.some((page) => page.status === 'error') ? 'partial' : 'done')
      : 'running',
    inputPath: prepared.inputPath,
    manifestPath: prepared.manifestPath,
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    source: prepared.manifest.source,
    pages: results,
  })

  emit()
  for (const page of prepared.pages) {
    const pageBase = {
      id: page.id,
      name: page.name,
      route: page.route,
      sourceNodeId: page.sourceNodeId,
      inputPath: page.inputPath,
    }
    options.onPageStart?.({ ...pageBase, index: page.index, total: prepared.pages.length })
    try {
      const job = await runGenerateFromInput(page.inputPath, {
        jobRoot: jobsRoot,
        onJobStart: (jobInfo) => options.onJobStart?.({ page: pageBase, ...jobInfo }),
        onProgress: (progress) => options.onProgress?.({ page: pageBase, progress }),
      })
      const result = {
        ...pageBase,
        status: 'done',
        jobId: job.jobId,
        outputDir: job.outputDir,
        htmlPath: job.resultSummary?.htmlPath,
        zipPath: job.resultSummary?.zipPath,
      }
      results.push(result)
      options.onPageComplete?.(result)
      emit()
    } catch (error) {
      const failed = {
        ...pageBase,
        status: 'error',
        jobId: error?.job?.jobId,
        error: error instanceof Error ? error.message : String(error),
      }
      results.push(failed)
      options.onPageError?.(failed)
      emit()
      if (!continueOnError) throw Object.assign(new Error(failed.error), { batchId, page: failed })
    }
  }

  const result = {
    version: 'mastergo2html.page-batch-result.v1',
    batchId,
    status: results.some((page) => page.status === 'error') ? 'partial' : 'done',
    inputPath: prepared.inputPath,
    manifestPath: prepared.manifestPath,
    batchDir,
    jobsRoot,
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    source: prepared.manifest.source,
    pages: results,
  }
  writeBatchRecord(batchDir, result)
  return result
}

export function buildMergePrepareCommand(result, options = {}) {
  const script = options.script || 'skills/merge-html-to-next-app/scripts/prepare_inputs.py'
  const workspace = options.workspace || join(result.batchDir, 'react-merge')
  const pageArgs = result.pages
    .filter((page) => page.status === 'done' && page.outputDir && page.inputPath)
    .flatMap((page) => [
      `--page ${shellQuote(`${page.route}=${page.outputDir}`)}`,
      `--frame-screenshot ${shellQuote(`${page.route}=${join(page.inputPath, 'frame-screenshot.png')}`)}`,
    ])
  if (pageArgs.length === 0) return null
  return `python3 ${shellQuote(script)} --workspace ${shellQuote(workspace)} --require-frame-screenshot ${pageArgs.join(' ')}`
}

function validatePageBundleManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('mastergo-pages.json 必须是 JSON 对象。')
  if (manifest.version !== PAGE_BUNDLE_VERSION) {
    throw new Error(`不支持的页面包版本：${manifest.version || 'missing'}。`)
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('mastergo-pages.json 至少需要包含一个页面。')
  }

  const ids = new Set()
  const routes = new Set()
  for (const [index, page] of manifest.pages.entries()) {
    if (!page || typeof page !== 'object') throw new Error(`pages[${index}] 必须是对象。`)
    for (const key of ['id', 'name', 'route', 'inputDir']) {
      if (typeof page[key] !== 'string' || !page[key].trim()) throw new Error(`pages[${index}].${key} 不能为空。`)
    }
    if (!page.route.startsWith('/')) throw new Error(`页面路由必须以 / 开头：${page.route}`)
    if (ids.has(page.id)) throw new Error(`页面 id 重复：${page.id}`)
    if (routes.has(page.route)) throw new Error(`页面 route 重复：${page.route}`)
    ids.add(page.id)
    routes.add(page.route)
  }
}

function validatePageInput(inputDir, pageName) {
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`页面 ${pageName} 的 00-input 目录不存在：${inputDir}`)
  }
  for (const file of ['raw.json', 'asset-manifest.json', 'frame-screenshot.png']) {
    if (!existsSync(join(inputDir, file))) throw new Error(`页面 ${pageName} 缺少 ${file}。`)
  }
}

function findBundleRoot(root) {
  if (existsSync(join(root, 'mastergo-pages.json'))) return root
  const matches = []
  walk(root, 3, (path) => {
    if (basename(path) === 'mastergo-pages.json') matches.push(dirname(path))
  })
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

function assertSafeBundlePath(path) {
  const safe = normalize(path)
  if (isAbsolute(safe) || safe.startsWith('..')) throw new Error(`非法页面 inputDir：${path}`)
  return safe
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function writeBatchRecord(batchDir, payload) {
  mkdirSync(batchDir, { recursive: true })
  writeFileSync(join(batchDir, 'batch.json'), JSON.stringify(payload, null, 2))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
