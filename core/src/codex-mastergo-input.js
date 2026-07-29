import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

const DEFAULT_DESIGN_ROOT = '.mastergo/design'
const EMPTY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwQnGAAAAABJRU5ErkJggg=='
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const SVG_EXTENSIONS = new Set(['.svg'])
const EXPORT_SCALE = 2

export function createInputFromCodexMasterGo(options = {}) {
  const snapshot = findSnapshot(options)
  const outputDir = resolve(options.output || '.mastergo2html/codex-mastergo/00-input')
  const createdAt = new Date().toISOString()
  const html = readFileSync(snapshot.htmlPath, 'utf8')
  const root = parseMasterGoHtmlSnapshot(html, snapshot)
  const assetFiles = collectSnapshotAssets(snapshot.snapshotDir)
  const assets = buildAssetManifestEntries(root, assetFiles)
  const source = {
    pageId: snapshot.documentId || 'codex-mastergo-page',
    pageName: options.pageName || snapshot.pageName || 'Codex MasterGo',
    selectionIds: [root.id],
    selectionCount: 1,
  }
  const files = {}

  for (const file of assetFiles) {
    files[file.inputPath] = {
      path: file.inputPath,
      mimeType: mimeTypeForPath(file.sourcePath),
      encoding: isUtf8Asset(file.sourcePath) ? 'utf8' : 'base64',
      content: isUtf8Asset(file.sourcePath)
        ? readFileSync(file.sourcePath, 'utf8')
        : readFileSync(file.sourcePath).toString('base64'),
    }
  }

  const input = {
    'raw.json': {
      version: 'mastergo2html.raw.v1',
      generatedAt: createdAt,
      sourceKind: 'codex-mastergo-hosted-mcp',
      page: {
        id: source.pageId,
        name: source.pageName,
      },
      selection: [root],
      assetManifestFile: 'asset-manifest.json',
      codexMasterGo: {
        snapshotHtml: snapshot.htmlPath,
        snapshotDir: snapshot.snapshotDir,
      },
    },
    'asset-manifest.json': {
      version: 'mastergo2html.asset-manifest.v1',
      generatedAt: createdAt,
      source,
      assets,
      files: assets.flatMap((asset) => {
        const original = asset.kind === 'image' ? {
          path: asset.suggestedFile,
          assetId: asset.assetId,
          kind: 'original-image',
          status: asset.status,
          sourceNodeIds: asset.sourceNodes.map((sourceNode) => sourceNode.nodeId),
        } : null
        const rendered = asset.renderedAssets.map((item) => ({
          path: item.suggestedFile,
          assetId: item.assetId,
          kind: asset.kind === 'node-slice' ? 'node-slice' : 'rendered-image',
          status: item.status,
          sourceNodeIds: [item.nodeId],
        }))
        return [original, ...rendered].filter(Boolean)
      }),
      codexMasterGo: {
        note: 'Input built from Codex App hosted MasterGo MCP snapshot files under .mastergo/design.',
        snapshotHtml: snapshot.htmlPath,
      },
    },
    'export-options.json': {
      exportOptions: {
        includeOriginalImages: false,
        includeRenderedSlices: true,
        rawProfile: 'html',
        sourceKind: 'codex-mastergo-hosted-mcp',
      },
      source,
      createdAt,
    },
    'frame-screenshot.png': readScreenshotBase64(options, snapshot),
    ...files,
  }

  writeInputDirectory(outputDir, input)
  return {
    ok: true,
    inputDir: outputDir,
    source,
    snapshot,
    assetCount: assets.length,
  }
}

function findSnapshot(options) {
  if (options.snapshotHtml) {
    const htmlPath = resolve(options.snapshotHtml)
    if (!existsSync(htmlPath)) throw new Error(`Codex MasterGo 快照 HTML 不存在：${htmlPath}`)
    return {
      htmlPath,
      snapshotDir: dirname(htmlPath),
      documentId: options.documentId || inferDocumentId(htmlPath),
      pageName: options.pageName || inferPageName(htmlPath),
    }
  }

  const designRoot = resolve(options.designRoot || DEFAULT_DESIGN_ROOT)
  if (!existsSync(designRoot)) throw new Error(`Codex MasterGo 快照目录不存在：${designRoot}`)
  const htmlFiles = findFiles(designRoot, (filePath) => extname(filePath).toLowerCase() === '.html')
    .filter((filePath) => !options.nodeId || filePath.includes(safeNodeIdForFile(options.nodeId)))
    .filter((filePath) => !options.frameName || basename(filePath).includes(options.frameName))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

  if (htmlFiles.length === 0) {
    throw new Error('没有找到 Codex MasterGo 快照 HTML。请先通过 Codex App 托管 MCP 调用 get_selection_node 落盘当前选区。')
  }

  const htmlPath = htmlFiles[0]
  return {
    htmlPath,
    snapshotDir: dirname(htmlPath),
    documentId: options.documentId || inferDocumentId(htmlPath),
    pageName: options.pageName || inferPageName(htmlPath),
  }
}

function parseMasterGoHtmlSnapshot(html, snapshot) {
  const tokens = [...html.matchAll(/<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*)>/g)]
  const stack = []
  let root = null

  for (let index = 0; index < tokens.length; index += 1) {
    const match = tokens[index]
    const full = match[0]
    if (full.startsWith('<!--')) continue
    const isClosing = full.startsWith('</')
    if (isClosing) {
      stack.pop()
      continue
    }

    const tag = match[1].toLowerCase()
    const attrs = parseAttributes(match[2] || '')
    const node = createNodeFromElement(tag, attrs, snapshot)
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else root = node

    const text = readTextUntilNextTag(html, match.index + full.length)
    if (text && tag !== 'img') {
      const normalizedText = normalizeText(text)
      if (normalizedText) node.characters = normalizedText
    }

    if (!full.endsWith('/>') && tag !== 'img' && tag !== 'br' && tag !== 'input') stack.push(node)
  }

  if (!root) throw new Error(`无法解析 Codex MasterGo 快照 HTML：${snapshot.htmlPath}`)
  if (!root.id) root.id = 'codex-mastergo-selection'
  if (!root.name) root.name = inferPageName(snapshot.htmlPath)
  if (!root.type) root.type = 'FRAME'
  return root
}

function createNodeFromElement(tag, attrs, snapshot) {
  const style = parseStyle(attrs.style || '')
  const bounds = boundsFromStyle(style)
  const src = attrs.src ? normalizeAssetPath(attrs.src) : ''
  const node = {
    id: attrs['data-node-id'] || '',
    name: attrs['data-name'] || attrs.title || tag,
    type: inferNodeType(tag, attrs, style),
    isVisible: true,
    ...bounds,
  }

  if (bounds.absoluteBoundingBox) {
    node.absoluteRenderBounds = { ...bounds.absoluteBoundingBox }
  }
  if (style.opacity !== undefined) node.opacity = toNumber(style.opacity, undefined)
  if (style.background) node.fills = paintsFromBackground(style.background)
  if (style.color && node.type === 'TEXT') {
    node.fills = [{ type: 'SOLID', color: style.color, isVisible: true }]
  }
  if (style['border-radius']) node.cornerRadius = firstNumber(style['border-radius'])
  if (style['font-size']) node.fontSize = firstNumber(style['font-size'])
  if (style['font-family']) node.fontName = { family: stripQuotes(style['font-family'].split(',')[0]), style: 'Regular' }
  if (style['font-weight']) node.fontWeight = style['font-weight']
  if (style['line-height']) node.lineHeight = firstNumber(style['line-height'])
  if (style['text-align']) node.textAlignHorizontal = String(style['text-align']).toUpperCase()
  if (src) {
    node.fills = [{
      type: 'IMAGE',
      imageRef: src,
      assetPath: inputAssetPathForSnapshotAsset(src, snapshot.snapshotDir),
      scaleMode: style['object-fit'] === 'cover' ? 'FILL' : 'FIT',
      isVisible: true,
    }]
  }
  node.children = []
  return node
}

function collectSnapshotAssets(snapshotDir) {
  const assetRoot = join(snapshotDir, 'asset')
  if (!existsSync(assetRoot)) return []
  return findFiles(assetRoot, (filePath) => {
    const extension = extname(filePath).toLowerCase()
    return IMAGE_EXTENSIONS.has(extension) || SVG_EXTENSIONS.has(extension)
  }).map((sourcePath) => ({
    sourcePath,
    inputPath: inputAssetPathForSnapshotAsset(relative(snapshotDir, sourcePath), snapshotDir),
  }))
}

function buildAssetManifestEntries(root, assetFiles) {
  const byInputPath = new Map(assetFiles.map((file) => [file.inputPath, file]))
  const refs = []
  walkNode(root, (node) => {
    if (!Array.isArray(node.fills)) return
    node.fills.forEach((paint, index) => {
      if (paint?.type !== 'IMAGE' || !paint.assetPath) return
      refs.push({
        imageRef: paint.imageRef || paint.assetPath,
        assetPath: paint.assetPath,
        source: {
          nodeId: node.id,
          nodeName: node.name,
          paintPath: `fills[${index}]`,
          usageHint: inferUsageHint(node, paint.assetPath),
          scaleMode: paint.scaleMode,
        },
      })
    })
  })

  const grouped = new Map()
  for (const ref of refs) {
    const values = grouped.get(ref.assetPath) || []
    values.push(ref)
    grouped.set(ref.assetPath, values)
  }

  let imageIndex = 1
  let sliceIndex = 1
  const assets = []
  for (const [assetPath, values] of grouped) {
    const file = byInputPath.get(assetPath)
    const format = normalizeFormat(extname(assetPath))
    const isSvg = format === 'svg'
    const assetId = isSvg ? `node_${String(sliceIndex).padStart(4, '0')}` : `img_${String(imageIndex).padStart(4, '0')}`
    if (isSvg) sliceIndex += 1
    else imageIndex += 1
    const first = values[0]
    const renderedAsset = {
      assetId: `slice_${String(assets.length + 1).padStart(4, '0')}`,
      kind: 'rendered-image',
      format: isSvg ? 'svg' : 'png',
      nodeId: first.source.nodeId,
      status: file ? 'present' : 'reference-only',
      suggestedFile: assetPath,
      copiedPath: file ? assetPath : undefined,
      exportScale: EXPORT_SCALE,
    }
    assets.push({
      assetId,
      kind: isSvg ? 'node-slice' : 'image',
      usageHint: first.source.usageHint,
      renderPolicy: isSvg ? 'required-final' : 'fallback-only',
      format,
      targetDir: format === 'svg' ? 'assets/icon' : 'assets/img',
      imageRef: first.imageRef,
      status: file ? 'present' : 'reference-only',
      sourceNodes: mergeSourceNodes(values.map((value) => value.source)),
      suggestedFile: assetPath,
      copiedPath: file ? assetPath : undefined,
      originalFileName: basename(assetPath),
      renderedAssets: [renderedAsset],
      error: file ? undefined : 'Codex MasterGo 快照中未找到对应资源文件。',
    })
  }
  return assets
}

function readScreenshotBase64(options, snapshot) {
  const screenshotPath = options.screenshot ? resolve(options.screenshot) : findLatestScreenshot(snapshot)
  if (screenshotPath && existsSync(screenshotPath)) return readFileSync(screenshotPath).toString('base64')
  return EMPTY_PNG_BASE64
}

function findLatestScreenshot(snapshot) {
  const designRoot = findDesignRoot(snapshot.htmlPath)
  if (!designRoot) return ''
  const nodeSafeId = safeNodeIdForFile(readRootIdFromHtml(snapshot.htmlPath))
  return findFiles(designRoot, (filePath) => {
    const lower = filePath.toLowerCase()
    return lower.endsWith('.png') && lower.includes('/screenshot/') && (!nodeSafeId || filePath.includes(nodeSafeId))
  }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || ''
}

function writeInputDirectory(outputDir, files) {
  mkdirSync(outputDir, { recursive: true })
  for (const [path, file] of Object.entries(files)) {
    const target = join(outputDir, path)
    mkdirSync(dirname(target), { recursive: true })
    if (typeof file === 'string') writeFileSync(target, Buffer.from(file, 'base64'))
    else if (file.encoding === 'utf8') writeFileSync(target, String(file.content || ''), 'utf8')
    else if (file.encoding === 'base64') writeFileSync(target, Buffer.from(String(file.content || ''), 'base64'))
    else writeFileSync(target, JSON.stringify(file, null, 2))
  }
}

function parseAttributes(input) {
  const attrs = {}
  for (const match of input.matchAll(/([:\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g)) {
    attrs[match[1]] = decodeHtml(match[3] ?? match[4] ?? match[5] ?? '')
  }
  return attrs
}

function parseStyle(styleText) {
  const style = {}
  for (const part of String(styleText || '').split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    style[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim()
  }
  return style
}

function boundsFromStyle(style) {
  const width = firstNumber(style.width)
  const height = firstNumber(style.height)
  const x = firstNumber(style.left) ?? 0
  const y = firstNumber(style.top) ?? 0
  const result = {}
  if (width !== undefined) result.width = width
  if (height !== undefined) result.height = height
  result.x = x
  result.y = y
  if (width !== undefined && height !== undefined) result.absoluteBoundingBox = { x, y, width, height }
  return result
}

function inferNodeType(tag, attrs, style) {
  if (tag === 'span' || style['font-size'] || attrs['data-name'] && !style.width && !style.height) return 'TEXT'
  if (tag === 'img') return extname(String(attrs.src || '')).toLowerCase() === '.svg' ? 'VECTOR' : 'RECTANGLE'
  return 'FRAME'
}

function paintsFromBackground(background) {
  const value = String(background || '').trim()
  if (!value || value === 'transparent') return []
  if (value.startsWith('linear-gradient')) return [{ type: 'GRADIENT_LINEAR', css: value, isVisible: true }]
  return [{ type: 'SOLID', color: value, isVisible: true }]
}

function inputAssetPathForSnapshotAsset(path) {
  const clean = normalizeAssetPath(path)
  const parts = clean.split('/')
  const assetIndex = parts.indexOf('asset')
  const relativeAssetPath = assetIndex >= 0 ? parts.slice(assetIndex + 1).join('/') : clean
  if (relativeAssetPath.startsWith('icons/')) return `assets/icon/${basename(relativeAssetPath)}`
  if (relativeAssetPath.startsWith('images/')) return `assets/img/${basename(relativeAssetPath)}`
  return `assets/img/${basename(relativeAssetPath)}`
}

function normalizeAssetPath(src) {
  return String(src || '').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

function findFiles(root, predicate, results = []) {
  if (!existsSync(root)) return results
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const filePath = join(root, entry.name)
    if (entry.isDirectory()) findFiles(filePath, predicate, results)
    else if (entry.isFile() && predicate(filePath)) results.push(filePath)
  }
  return results
}

function walkNode(root, visitor) {
  visitor(root)
  for (const child of root.children || []) walkNode(child, visitor)
}

function mergeSourceNodes(sources) {
  const byKey = new Map()
  for (const source of sources) {
    const key = `${source.nodeId}:${source.paintPath}`
    if (!byKey.has(key)) byKey.set(key, source)
  }
  return [...byKey.values()]
}

function readTextUntilNextTag(html, start) {
  const next = html.indexOf('<', start)
  return html.slice(start, next < 0 ? undefined : next)
}

function normalizeText(text) {
  return decodeHtml(String(text || '').replace(/\s+/g, ' ').trim())
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function firstNumber(value) {
  const match = /-?\d+(?:\.\d+)?/.exec(String(value || ''))
  return match ? Number(match[0]) : undefined
}

function toNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '')
}

function inferUsageHint(node, path) {
  const text = `${node.name || ''} ${path || ''}`
  if (/logo|品牌|标志/i.test(text)) return 'logo'
  if (/icon|icons|图标|svg_/i.test(text)) return 'icon'
  if (/bg|background|背景|banner/i.test(text)) return 'background'
  if (/decor|decoration|装饰|波点|圆形/i.test(text)) return 'decorative'
  return 'content-image'
}

function normalizeFormat(path) {
  const extension = extname(String(path || '')).toLowerCase().replace('.', '')
  if (extension === 'jpeg') return 'jpg'
  if (['svg', 'png', 'jpg', 'webp', 'gif'].includes(extension)) return extension
  return 'unknown'
}

function mimeTypeForPath(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

function isUtf8Asset(path) {
  return SVG_EXTENSIONS.has(extname(path).toLowerCase())
}

function inferDocumentId(path) {
  const parts = resolve(path).split('/')
  const index = parts.lastIndexOf('design')
  return index >= 0 ? parts[index + 1] || '' : ''
}

function inferPageName(path) {
  return basename(path).replace(/\.html$/i, '').replace(/-\d+-\d+$/, '').replace(/^-/, '') || 'Codex MasterGo'
}

function findDesignRoot(path) {
  const parts = resolve(path).split('/')
  const index = parts.lastIndexOf('design')
  return index >= 0 ? parts.slice(0, index + 1).join('/') : ''
}

function readRootIdFromHtml(path) {
  const html = readFileSync(path, 'utf8')
  const match = /data-node-id="([^"]+)"/.exec(html)
  return match?.[1] || ''
}

function safeNodeIdForFile(nodeId) {
  return String(nodeId || '').replace(/:/g, '-')
}
