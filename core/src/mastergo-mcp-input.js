import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { McpStdioClient } from './mcp-stdio-client.js'

const DEFAULT_MCP_COMMAND = 'npx'
const DEFAULT_MCP_URL = 'http://localhost:50678'
const EMPTY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwQnGAAAAABJRU5ErkJggg=='
const EXPORT_SCALE = 2

export async function createInputFromMasterGoMcp(options = {}) {
  const outputDir = resolve(options.output || '.mastergo2html/mastergo-mcp/00-input')
  const client = createMasterGoMcpClient(options)

  try {
    await client.connect()
    const tools = await client.listTools()
    const codeTool = selectTool(tools, options.codeTool, [
      'get_selection_node',
      'get_current_selection',
      'get_selection',
      'getSelectedNode',
      'get_selection_code',
      'getSelectedCode',
      'get_selected_node_code',
      'selection_code',
    ])
    const imageTool = selectTool(tools, options.imageTool, [
      'get_selection_image',
      'getSelectedImage',
      'get_selected_node_image',
      'selection_image',
      'get_selection_preview',
    ])
    const originalImageTool = selectTool(tools, options.originalImageTool, [
      'get_image',
      'getImage',
      'get_image_by_ref',
      'getImageByHref',
      'export_image',
      'download_image',
      'get_static_asset',
    ])
    const nodeSliceTool = selectTool(tools, options.nodeSliceTool, [
      'export_node',
      'exportNode',
      'export_node_image',
      'get_node_image',
      'render_node',
      'export_selection_image',
    ])

    if (!codeTool) {
      throw new Error(`MasterGo MCP 未提供选中节点代码工具。可用工具：${tools.map((tool) => tool.name).join(', ') || 'none'}`)
    }

    const toolArgs = buildToolArguments(options)
    const codeResult = await client.callTool(codeTool.name, toolArgs)
    const imageResult = imageTool ? await client.callTool(imageTool.name, toolArgs).catch((error) => ({ error: error.message })) : null
    const input = buildMasterGoInput({
      codeResult,
      imageResult,
      codeToolName: codeTool.name,
      imageToolName: imageTool?.name || '',
      originalImageToolName: originalImageTool?.name || '',
      nodeSliceToolName: nodeSliceTool?.name || '',
      options,
    })
    await exportMcpAssets({
      client,
      input,
      root: input.files['raw.json'].selection[0],
      originalImageTool,
      nodeSliceTool,
      options,
    })

    writeInputDirectory(outputDir, input)
    return {
      ok: true,
      inputDir: outputDir,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description || '' })),
      usedTools: {
        code: codeTool.name,
        image: imageTool?.name || '',
        originalImage: originalImageTool?.name || '',
        nodeSlice: nodeSliceTool?.name || '',
      },
      source: input.source,
    }
  } finally {
    await client.close()
  }
}

export async function listMasterGoMcpTools(options = {}) {
  const client = createMasterGoMcpClient(options)
  try {
    await client.connect()
    return await client.listTools()
  } finally {
    await client.close()
  }
}

function createMasterGoMcpClient(options = {}) {
  return new McpStdioClient({
    command: options.command || DEFAULT_MCP_COMMAND,
    args: options.args || buildDefaultMcpArgs(options),
    cwd: options.cwd || process.cwd(),
    env: buildMcpEnv(options.env || {}),
  })
}

function buildDefaultMcpArgs(options = {}) {
  const url = options.url || process.env.MASTERGO_MCP_URL || DEFAULT_MCP_URL
  return ['-y', '@mastergo/vibe-mcp', `--url=${url}`]
}

function buildMcpEnv(env) {
  const accessKey = env.MASTERGO_MCP_ACCESS_KEY || process.env.MASTERGO_MCP_ACCESS_KEY || ''
  return {
    ...env,
    ...(accessKey ? {
      MASTERGO_MCP_ACCESS_KEY: accessKey,
      MASTERGO_ACCESS_KEY: env.MASTERGO_ACCESS_KEY || process.env.MASTERGO_ACCESS_KEY || accessKey,
    } : {}),
  }
}

function buildToolArguments(options) {
  const args = {}
  if (options.nodeId) args.nodeId = options.nodeId
  if (options.frameName) args.frameName = options.frameName
  if (options.pageName) args.pageName = options.pageName
  return args
}

function selectTool(tools, explicitName, candidates) {
  if (explicitName) {
    const tool = tools.find((item) => item.name === explicitName)
    if (!tool) throw new Error(`MasterGo MCP 工具不存在：${explicitName}`)
    return tool
  }
  const lowerCandidates = candidates.map((name) => name.toLowerCase())
  return tools.find((tool) => lowerCandidates.includes(String(tool.name).toLowerCase()))
    || tools.find((tool) => matchesCandidates(tool, candidates))
}

function matchesCandidates(tool, candidates) {
  const haystack = `${tool.name || ''} ${tool.description || ''}`.toLowerCase()
  return candidates.some((candidate) => {
    const normalized = candidate.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`).replace(/[_-]+/g, ' ').toLowerCase()
    return normalized.split(/\s+/).filter(Boolean).every((part) => haystack.includes(part))
  })
}

function buildMasterGoInput({ codeResult, imageResult, codeToolName, imageToolName, originalImageToolName, nodeSliceToolName, options }) {
  const createdAt = new Date().toISOString()
  const extracted = extractStructuredPayload(codeResult)
  const root = normalizeRootNode(extracted, options)
  const page = {
    id: stringValue(extracted?.pageId || extracted?.page?.id, 'mastergo-mcp-page'),
    name: stringValue(options.pageName || extracted?.pageName || extracted?.page?.name, 'MasterGo MCP'),
  }
  const source = {
    pageId: page.id,
    pageName: page.name,
    selectionIds: [root.id],
    selectionCount: 1,
  }

  return {
    source,
    files: {
      'raw.json': {
        version: 'mastergo2html.raw.v1',
        generatedAt: createdAt,
        sourceKind: 'mastergo-mcp',
        page,
        selection: [root],
        assetManifestFile: 'asset-manifest.json',
        mcp: {
          codeToolName,
          imageToolName,
          codeResult,
        },
      },
      'asset-manifest.json': {
        version: 'mastergo2html.asset-manifest.v1',
        generatedAt: createdAt,
        source,
        assets: createAssetManifestEntries(root),
        files: [],
        mcp: {
          note: 'MasterGo MCP selection import. Static assets are exported through dynamically selected MCP tools when available.',
          originalImageToolName,
          nodeSliceToolName,
        },
      },
      'export-options.json': {
        exportOptions: {
          includeOriginalImages: options.includeOriginalImages !== false,
          includeRenderedSlices: options.includeRenderedSlices !== false,
          rawProfile: 'html',
          sourceKind: 'mastergo-mcp',
        },
        source,
        createdAt,
      },
      'frame-screenshot.png': extractImageBase64(imageResult) || EMPTY_PNG_BASE64,
    },
  }
}

function normalizeRootNode(payload, options) {
  const node = payload?.node
    || payload?.selection?.[0]
    || payload?.currentSelection?.[0]
    || payload?.selectedNodes?.[0]
    || payload?.data?.node
    || payload?.data?.selection?.[0]
    || payload?.data?.currentSelection?.[0]
    || payload?.data?.selectedNodes?.[0]
    || payload
  const bounds = node?.absoluteBoundingBox || node?.bounds || node?.frame || {}
  return {
    id: stringValue(options.nodeId || node?.id || payload?.nodeId, 'mastergo-mcp-selection'),
    name: stringValue(options.frameName || node?.name || payload?.name, 'MasterGo MCP Selection'),
    type: stringValue(node?.type || payload?.type, 'FRAME'),
    visible: node?.visible !== false,
    absoluteBoundingBox: {
      x: numberValue(bounds.x, 0),
      y: numberValue(bounds.y, 0),
      width: numberValue(bounds.width, 1440),
      height: numberValue(bounds.height, 900),
    },
    children: Array.isArray(node?.children) ? node.children.map(normalizeNodeTree) : [],
    mcpCode: extractText(payload),
    mcpPayload: payload,
  }
}

function normalizeNodeTree(node) {
  if (!node || typeof node !== 'object') return node
  const bounds = node.absoluteBoundingBox || node.bounds || node.frame || {}
  const normalized = {
    ...node,
    id: stringValue(node.id, ''),
    name: stringValue(node.name, ''),
    type: stringValue(node.type, 'UNKNOWN'),
    visible: node.visible !== false && node.isVisible !== false,
    isVisible: node.visible !== false && node.isVisible !== false,
  }
  if (!normalized.absoluteBoundingBox && bounds && typeof bounds === 'object') {
    normalized.absoluteBoundingBox = {
      x: numberValue(bounds.x, 0),
      y: numberValue(bounds.y, 0),
      width: numberValue(bounds.width, numberValue(node.width, 0)),
      height: numberValue(bounds.height, numberValue(node.height, 0)),
    }
  }
  if (Array.isArray(node.children)) normalized.children = node.children.map(normalizeNodeTree)
  return normalized
}

function extractStructuredPayload(result) {
  const text = extractText(result)
  if (!text) return result
  try {
    return JSON.parse(text)
  } catch {
    return {
      id: 'mastergo-mcp-selection',
      name: 'MasterGo MCP Selection',
      type: 'FRAME',
      code: text,
    }
  }
}

function extractText(result) {
  if (typeof result === 'string') return result
  if (typeof result?.content === 'string') return result.content
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
  }
  return ''
}

function extractImageBase64(result) {
  if (!result || result.error) return ''
  if (typeof result?.base64 === 'string') return stripDataUrl(result.base64)
  if (typeof result?.data === 'string') return stripDataUrl(result.data)
  if (Array.isArray(result?.content)) {
    const image = result.content.find((item) => item?.type === 'image' && typeof item.data === 'string')
    if (image) return stripDataUrl(image.data)
  }
  return ''
}

function stripDataUrl(value) {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
}

async function exportMcpAssets({ client, input, root, originalImageTool, nodeSliceTool, options }) {
  const manifest = input.files['asset-manifest.json']
  const attachments = []

  if (options.includeOriginalImages !== false && originalImageTool) {
    for (const asset of manifest.assets.filter((item) => item.kind === 'image')) {
      const exported = await exportOriginalImageAsset(client, originalImageTool, asset)
      if (exported) {
        asset.status = 'present'
        asset.copiedPath = asset.suggestedFile
        attachments.push(exported)
      } else {
        asset.status = 'reference-only'
        asset.error = 'MasterGo MCP 未返回可识别的原图内容，保留 imageRef 供后续降级或补导。'
      }
    }
  }

  if (options.includeRenderedSlices !== false && nodeSliceTool) {
    let sliceIndex = 1
    for (const asset of manifest.assets) {
      const nodeIds = unique(asset.sourceNodes.map((source) => source.nodeId).filter(Boolean))
      for (const nodeId of nodeIds) {
        const sliceId = `slice_${String(sliceIndex).padStart(4, '0')}`
        sliceIndex += 1
        const exported = await exportNodeSliceAsset(client, nodeSliceTool, asset, nodeId, sliceId)
        asset.renderedAssets.push(exported.record)
        if (exported.file) attachments.push(exported.file)
      }
    }
  }

  manifest.files = manifest.assets.flatMap((asset) => {
    const original = asset.kind === 'image' ? {
      path: asset.suggestedFile,
      assetId: asset.assetId,
      kind: 'original-image',
      status: asset.status,
      sourceNodeIds: asset.sourceNodes.map((source) => source.nodeId),
    } : null
    const rendered = asset.renderedAssets.map((item) => ({
      path: item.suggestedFile,
      assetId: item.assetId,
      kind: asset.kind === 'node-slice' ? 'node-slice' : 'rendered-image',
      status: item.status,
      sourceNodeIds: [item.nodeId],
    }))
    return [original, ...rendered].filter(Boolean)
  })

  for (const file of attachments) {
    input.files[file.path] = file
  }

  if (!extractImageBase64(input.files['frame-screenshot.png'])) {
    const screenshot = nodeSliceTool ? await callMcpForImage(client, nodeSliceTool, [
      { nodeId: root.id, id: root.id, format: 'png', scale: EXPORT_SCALE, type: 'PNG' },
      { nodeId: root.id, format: 'PNG', constraint: { type: 'SCALE', value: EXPORT_SCALE } },
      { id: root.id, exportFormat: 'PNG' },
    ]) : ''
    if (screenshot) {
      input.files['frame-screenshot.png'] = {
        path: 'frame-screenshot.png',
        mimeType: screenshot.mimeType || 'image/png',
        encoding: screenshot.encoding || 'base64',
        content: screenshot.content,
      }
    }
  }
}

async function exportOriginalImageAsset(client, tool, asset) {
  const image = await callMcpForImage(client, tool, [
    { imageRef: asset.imageRef, href: asset.imageRef, assetId: asset.assetId },
    { ref: asset.imageRef },
    { url: asset.imageRef },
    { id: asset.assetId },
  ])
  if (!image) return null
  return {
    path: asset.suggestedFile,
    mimeType: image.mimeType || imageMimeType(asset.format),
    encoding: image.encoding || 'base64',
    content: image.content,
  }
}

async function exportNodeSliceAsset(client, tool, asset, nodeId, sliceId) {
  const format = asset.format === 'svg' ? 'svg' : 'png'
  const suggestedFile = `${assetTargetDir(format)}/${sliceId}.${format}`
  const image = await callMcpForImage(client, tool, [
    { nodeId, id: nodeId, format, scale: EXPORT_SCALE, type: format.toUpperCase() },
    { nodeId, format: format.toUpperCase(), constraint: { type: 'SCALE', value: EXPORT_SCALE } },
    { id: nodeId, exportFormat: format.toUpperCase() },
  ])
  const base = {
    assetId: sliceId,
    kind: 'rendered-image',
    format,
    nodeId,
    suggestedFile,
    exportScale: EXPORT_SCALE,
  }
  if (!image) {
    return {
      record: {
        ...base,
        status: 'export-error',
        error: 'MasterGo MCP 未返回可识别的节点切片内容。',
      },
      file: null,
    }
  }
  return {
    record: {
      ...base,
      status: 'present',
      copiedPath: suggestedFile,
    },
    file: {
      path: suggestedFile,
      mimeType: image.mimeType || imageMimeType(format),
      encoding: image.encoding || 'base64',
      content: image.content,
    },
  }
}

async function callMcpForImage(client, tool, argumentCandidates) {
  for (const args of argumentCandidates) {
    try {
      const result = await client.callTool(tool.name, args)
      const file = extractImageFile(result)
      if (file) return file
    } catch {
      // Try the next argument shape; official MCP tools differ by version.
    }
  }
  return null
}

function extractImageFile(result) {
  if (!result) return null
  if (typeof result === 'string') return imageFileFromString(result)
  if (typeof result.base64 === 'string') return imageFileFromString(result.base64, result.mimeType)
  if (typeof result.data === 'string') return imageFileFromString(result.data, result.mimeType)
  if (typeof result.image === 'string') return imageFileFromString(result.image, result.mimeType)
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === 'image' && typeof item.data === 'string') return imageFileFromString(item.data, item.mimeType)
      if (item?.type === 'text' && typeof item.text === 'string') {
        const parsed = parseMaybeJson(item.text)
        const file = parsed ? extractImageFile(parsed) : imageFileFromString(item.text)
        if (file) return file
      }
    }
  }
  if (Array.isArray(result.resources)) {
    const resource = result.resources.find((item) => typeof item?.data === 'string' || typeof item?.base64 === 'string')
    if (resource) return imageFileFromString(resource.data || resource.base64, resource.mimeType)
  }
  return null
}

function imageFileFromString(value, mimeType = '') {
  const text = String(value || '').trim()
  if (!text) return null
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(text)
  if (match) return { mimeType: match[1], encoding: 'base64', content: match[2] }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length > 32) {
    return { mimeType: mimeType || 'image/png', encoding: 'base64', content: text }
  }
  if (/^\s*<svg[\s>]/i.test(text)) return { mimeType: 'image/svg+xml', encoding: 'utf8', content: text }
  return null
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function createAssetManifestEntries(root) {
  const refs = []
  walkNode(root, (node) => {
    collectImageRefsFromPaints(node?.fills, node, 'fills', refs)
    collectImageRefsFromPaints(node?.strokes, node, 'strokes', refs)
    collectImageRefsFromPaints(node?.backgrounds, node, 'backgrounds', refs)
  })

  const assets = []
  const byRef = new Map()
  for (const ref of refs) {
    const values = byRef.get(ref.imageRef) || []
    values.push(ref)
    byRef.set(ref.imageRef, values)
  }

  let index = 1
  for (const [imageRef, values] of byRef) {
    const assetId = `img_${String(index).padStart(4, '0')}`
    index += 1
    const extension = guessImageExtension(imageRef)
    const format = normalizeAssetFormat(extension)
    const targetDir = assetTargetDir(format)
    applyAssetIdToPaints(root, imageRef, assetId)
    assets.push({
      assetId,
      kind: 'image',
      imageRef,
      status: 'reference-only',
      sourceNodes: mergeSourceNodes(values.map((value) => value.source)),
      suggestedFile: `${targetDir}/${assetId}.${extension}`,
      originalFileName: getOriginalFileName(imageRef, extension),
      format,
      targetDir,
      renderedAssets: [],
    })
  }
  return assets
}

function collectImageRefsFromPaints(paints, node, paintPath, refs) {
  if (!Array.isArray(paints)) return
  paints.forEach((paint, index) => {
    const imageRef = paint?.imageRef || paint?.href || paint?.ref || paint?.url
    if (!imageRef || paint?.isVisible === false || paint?.visible === false) return
    refs.push({
      imageRef: String(imageRef),
      source: {
        nodeId: String(node.id || ''),
        nodeName: String(node.name || ''),
        paintPath: `${paintPath}[${index}]`,
        usageHint: inferUsageHint(node),
        scaleMode: paint.scaleMode,
        ratio: paint.ratio,
        alpha: paint.alpha,
      },
    })
  })
}

function applyAssetIdToPaints(root, imageRef, assetId) {
  walkNode(root, (node) => {
    for (const key of ['fills', 'strokes', 'backgrounds']) {
      if (!Array.isArray(node?.[key])) continue
      for (const paint of node[key]) {
        const ref = paint?.imageRef || paint?.href || paint?.ref || paint?.url
        if (ref === imageRef) paint.assetId = assetId
      }
    }
  })
}

function walkNode(root, visitor) {
  if (!root || typeof root !== 'object') return
  visitor(root)
  if (Array.isArray(root.children)) {
    for (const child of root.children) walkNode(child, visitor)
  }
}

function mergeSourceNodes(sources) {
  const byKey = new Map()
  for (const source of sources) {
    const key = `${source.nodeId}:${source.paintPath}`
    if (!byKey.has(key)) byKey.set(key, source)
  }
  return [...byKey.values()]
}

function unique(values) {
  return [...new Set(values)]
}

function inferUsageHint(node) {
  const name = String(node?.name || '')
  if (/logo|品牌|标志/i.test(name)) return 'logo'
  if (/icon|图标/i.test(name)) return 'icon'
  if (/bg|background|背景/i.test(name)) return 'background'
  if (/decor|decoration|装饰/i.test(name)) return 'decorative'
  return 'content-image'
}

function guessImageExtension(imageRef) {
  const fileName = String(imageRef || '').split('?')[0].split('/').pop() || ''
  const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : ''
  return ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? (extension === 'jpeg' ? 'jpg' : extension) : 'png'
}

function normalizeAssetFormat(extension) {
  if (extension === 'svg') return 'svg'
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'webp') return 'webp'
  if (extension === 'gif') return 'gif'
  if (extension === 'png') return 'png'
  return 'unknown'
}

function assetTargetDir(format) {
  return format === 'svg' ? 'assets/icon' : 'assets/img'
}

function getOriginalFileName(imageRef, extension) {
  const fileName = String(imageRef || '').split('?')[0].split('/').pop()
  return fileName && fileName.includes('.') ? fileName : `${hashString(String(imageRef || 'image'))}.${extension}`
}

function hashString(value) {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) + value.charCodeAt(index)
  return `img_${Math.abs(hash >>> 0).toString(16)}`
}

function imageMimeType(format) {
  if (format === 'svg') return 'image/svg+xml'
  if (format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  if (format === 'gif') return 'image/gif'
  return 'image/png'
}

function writeInputDirectory(outputDir, input) {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'raw.json'), JSON.stringify(input.files['raw.json'], null, 2))
  writeFileSync(join(outputDir, 'asset-manifest.json'), JSON.stringify(input.files['asset-manifest.json'], null, 2))
  writeFileSync(join(outputDir, 'export-options.json'), JSON.stringify(input.files['export-options.json'], null, 2))
  const screenshot = input.files['frame-screenshot.png']
  if (typeof screenshot === 'string') writeFileSync(join(outputDir, 'frame-screenshot.png'), Buffer.from(screenshot, 'base64'))
  else writeFile(outputDir, screenshot)
  for (const [path, file] of Object.entries(input.files)) {
    if (['raw.json', 'asset-manifest.json', 'export-options.json', 'frame-screenshot.png'].includes(path)) continue
    writeFile(outputDir, file)
  }
}

function writeFile(outputDir, file) {
  if (!file || typeof file.path !== 'string') return
  const target = join(outputDir, file.path)
  mkdirSync(dirname(target), { recursive: true })
  if (file.encoding === 'utf8') writeFileSync(target, String(file.content || ''), 'utf8')
  else writeFileSync(target, Buffer.from(String(file.content || ''), 'base64'))
}

function stringValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function numberValue(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
