import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export const FONT_ASSETS_VERSION = 'mastergo2html.font-assets.v1'

const DEFAULT_GOOGLE_FONT_FAMILIES = new Set([
  'inter',
  'noto sans',
  'noto sans sc',
  'noto serif sc',
  'roboto',
  'source sans 3',
])

const FONT_FORMAT_BY_EXT = {
  '.otf': 'opentype',
  '.ttf': 'truetype',
  '.woff': 'woff',
  '.woff2': 'woff2',
}

export async function resolveFontAssets({
  fontAvailability,
  flatNodes = [],
  inputDir,
  env = process.env,
  fetchFn = globalThis.fetch,
  warnings = [],
  allowDownloads = true,
} = {}) {
  const missingFonts = Array.isArray(fontAvailability?.missingFonts) ? fontAvailability.missingFonts : []
  const assetsDir = join(inputDir, 'assets', 'fonts')
  const familyText = collectTextByFontFamily(flatNodes)
  const registry = loadFontPackageRegistry(env)
  const fonts = []
  const files = []

  if (missingFonts.length > 0) mkdirSync(assetsDir, { recursive: true })

  for (const font of missingFonts) {
    const family = String(font.family || '').trim()
    if (!family) continue
    const weights = font.weights?.length > 0 ? font.weights : ['400']
    const text = familyText.get(normalizeFontFamily(family)) || ''
    const familyAssets = []
    const customSources = registry[normalizeFontFamily(family)] || registry[family]

    if (!allowDownloads) {
      warnings.push(createFontWarning(family, 'Agent v2 deterministic preparation disables network font downloads.'))
    } else if (Array.isArray(customSources) && customSources.length > 0) {
      for (const source of customSources) {
        const result = await downloadDirectFontSource({ source, family, assetsDir, fetchFn, env })
        if (result.ok) {
          familyAssets.push(result.asset)
          files.push(result.asset.path)
        } else {
          warnings.push(createFontWarning(family, result.reason))
        }
      }
    } else if (shouldTryGoogleFont(family, env)) {
      const result = await downloadGoogleFontFamily({ family, weights, text, assetsDir, fetchFn, env })
      if (result.assets.length > 0) {
        for (const asset of result.assets) {
          familyAssets.push(asset)
          files.push(asset.path)
        }
      } else {
        warnings.push(createFontWarning(family, result.reason || 'Google Fonts 未返回可下载字体文件。'))
      }
    }

    fonts.push({
      family,
      status: familyAssets.length > 0 ? 'downloaded' : 'fallback-required',
      usageCount: font.usageCount,
      styles: font.styles,
      weights,
      sourceNodes: font.sourceNodes,
      assets: familyAssets,
      fallbackStack: buildFallbackStack(family),
      css: familyAssets.length > 0 ? buildFontFaceCss(familyAssets) : '',
      note: familyAssets.length > 0
        ? '字体文件已复制到 assets/fonts，HTML 生成阶段必须通过 @font-face 引入。'
        : '未能下载授权字体文件，HTML 生成阶段应使用 fallbackStack 降级。',
    })
  }

  return {
    version: FONT_ASSETS_VERSION,
    generatedAt: new Date().toISOString(),
    strategy: allowDownloads ? 'download-known-fonts-then-fallback' : 'existing-assets-then-fallback',
    assetsDir: 'assets/fonts',
    fonts,
    files: [...new Set(files)].sort(),
  }
}

function loadFontPackageRegistry(env) {
  if (!env.FONT_PACKAGE_REGISTRY_JSON) return {}
  try {
    return JSON.parse(env.FONT_PACKAGE_REGISTRY_JSON)
  } catch {
    return {}
  }
}

function shouldTryGoogleFont(family, env) {
  if (env.FONT_DOWNLOAD_ENABLED === 'false') return false
  if (env.FONT_DOWNLOAD_GOOGLE_ENABLED === 'false') return false
  if (env.FONT_DOWNLOAD_GOOGLE_ALLOW_ANY === 'true') return true
  return DEFAULT_GOOGLE_FONT_FAMILIES.has(normalizeFontFamily(family))
}

async function downloadDirectFontSource({ source, family, assetsDir, fetchFn, env }) {
  const url = typeof source === 'string' ? source : source?.url
  if (!isAllowedFontUrl(url, env)) return { ok: false, reason: `字体下载地址不在允许域名内：${url || 'unknown'}` }
  try {
    const response = await fetchWithTimeout(fetchFn, url, env)
    if (!response.ok) return { ok: false, reason: `字体下载失败：${response.status} ${response.statusText}` }
    const bytes = Buffer.from(await response.arrayBuffer())
    const extension = fontExtensionFromUrl(url) || '.woff2'
    const weight = String(source?.weight || '400')
    const style = String(source?.style || 'normal')
    const fileName = `${slugify(family)}-${style}-${weight}${extension}`
    const asset = writeFontFile({ assetsDir, fileName, bytes, family, weight, style, sourceUrl: url })
    return { ok: true, asset }
  } catch (error) {
    return { ok: false, reason: `字体下载异常：${error.message}` }
  }
}

async function downloadGoogleFontFamily({ family, weights, text, assetsDir, fetchFn, env }) {
  if (!fetchFn) return { assets: [], reason: '当前 Node 环境没有 fetch，无法联网下载字体。' }
  const cssUrl = buildGoogleCssUrl(family, weights, text)
  try {
    const response = await fetchWithTimeout(fetchFn, cssUrl, env)
    if (!response.ok) return { assets: [], reason: `Google Fonts CSS 请求失败：${response.status} ${response.statusText}` }
    const css = await response.text()
    const fontFaces = parseFontFaceBlocks(css)
    const assets = []
    let index = 1
    for (const face of fontFaces) {
      if (!face.url) continue
      const fontResponse = await fetchWithTimeout(fetchFn, face.url, env)
      if (!fontResponse.ok) continue
      const bytes = Buffer.from(await fontResponse.arrayBuffer())
      const extension = fontExtensionFromUrl(face.url) || '.woff2'
      const suffix = fontFaces.length > 1 ? `-${String(index).padStart(2, '0')}` : ''
      index += 1
      const fileName = `${slugify(family)}-${face.style || 'normal'}-${face.weight || '400'}${suffix}${extension}`
      assets.push(writeFontFile({
        assetsDir,
        fileName,
        bytes,
        family,
        weight: face.weight || '400',
        style: face.style || 'normal',
        sourceUrl: face.url,
        unicodeRange: face.unicodeRange,
      }))
    }
    return { assets, reason: assets.length > 0 ? '' : 'Google Fonts CSS 中没有成功下载的字体 URL。' }
  } catch (error) {
    return { assets: [], reason: `Google Fonts 下载异常：${error.message}` }
  }
}

function buildGoogleCssUrl(family, weights, text) {
  const cleanWeights = [...new Set(weights.map((weight) => Number(weight)).filter(Number.isFinite))]
    .sort((a, b) => a - b)
  const params = new URLSearchParams()
  params.set('family', `${family.trim().replace(/\s+/g, ' ')}:wght@${cleanWeights.length > 0 ? cleanWeights.join(';') : '400'}`)
  params.set('display', 'swap')
  if (text) params.set('text', [...new Set(text)].join('').slice(0, 2000))
  return `https://fonts.googleapis.com/css2?${params.toString()}`
}

function parseFontFaceBlocks(css) {
  return [...String(css || '').matchAll(/@font-face\s*{([^}]+)}/gi)].map((match) => {
    const body = match[1]
    return {
      style: readCssProperty(body, 'font-style') || 'normal',
      weight: readCssProperty(body, 'font-weight') || '400',
      unicodeRange: readCssProperty(body, 'unicode-range'),
      url: body.match(/url\(([^)]+)\)/i)?.[1]?.replace(/^["']|["']$/g, ''),
    }
  })
}

function readCssProperty(body, property) {
  return String(body || '').match(new RegExp(`${property}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim()
}

async function fetchWithTimeout(fetchFn, url, env) {
  const timeoutMs = Number(env.FONT_DOWNLOAD_TIMEOUT_MS || 15000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 mastergo2html-font-assets' },
    })
  } finally {
    clearTimeout(timeout)
  }
}

function writeFontFile({ assetsDir, fileName, bytes, family, weight, style, sourceUrl, unicodeRange }) {
  const path = `assets/fonts/${fileName}`
  const diskPath = join(assetsDir, fileName)
  if (!existsSync(diskPath)) writeFileSync(diskPath, bytes)
  return {
    family,
    path,
    fileName,
    format: FONT_FORMAT_BY_EXT[extname(fileName).toLowerCase()] || 'woff2',
    fontWeight: String(weight),
    fontStyle: String(style),
    sourceUrl,
    unicodeRange,
  }
}

function buildFontFaceCss(assets) {
  return assets.map((asset) => [
    '@font-face {',
    `  font-family: "${asset.family}";`,
    `  src: url("${asset.path}") format("${asset.format}");`,
    `  font-weight: ${asset.fontWeight};`,
    `  font-style: ${asset.fontStyle};`,
    '  font-display: swap;',
    asset.unicodeRange ? `  unicode-range: ${asset.unicodeRange};` : '',
    '}',
  ].filter(Boolean).join('\n')).join('\n')
}

function collectTextByFontFamily(flatNodes) {
  const result = new Map()
  for (const node of flatNodes || []) {
    const family = node?.style?.text?.fontFamily
    if (!family || typeof node?.text !== 'string') continue
    const key = normalizeFontFamily(family)
    result.set(key, `${result.get(key) || ''}${node.text}`)
  }
  return result
}

function buildFallbackStack(family) {
  const normalized = normalizeFontFamily(family)
  if (/\bsc\b|hei|song|fang|yahei|pingfang|hans|chinese|cn|黑|宋|圆/i.test(normalized)) {
    return [`"${family}"`, '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'Arial', 'sans-serif']
  }
  return [`"${family}"`, 'Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Arial', 'sans-serif']
}

function isAllowedFontUrl(url, env) {
  if (!/^https:\/\//i.test(String(url || ''))) return false
  if (!env.FONT_DOWNLOAD_ALLOWED_HOSTS) return true
  const allowed = env.FONT_DOWNLOAD_ALLOWED_HOSTS.split(',').map((item) => item.trim()).filter(Boolean)
  if (allowed.length === 0) return true
  try {
    const host = new URL(url).hostname
    return allowed.some((item) => host === item || host.endsWith(`.${item}`))
  } catch {
    return false
  }
}

function fontExtensionFromUrl(url) {
  const cleanPath = String(url || '').split('?')[0]
  const extension = extname(cleanPath).toLowerCase()
  return FONT_FORMAT_BY_EXT[extension] ? extension : ''
}

function createFontWarning(family, message) {
  return {
    code: 'font-download-fallback',
    sourceNodeId: null,
    message: `${family}: ${message}`,
  }
}

function normalizeFontFamily(value) {
  return String(value).trim().replace(/^["']|["']$/g, '').toLowerCase()
}

function slugify(value) {
  return String(value || 'font')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'font'
}
