import http from 'node:http'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:12322'
const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_BRIDGE_START_TIMEOUT_MS = 12000
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRIDGE_SERVER_ROOT = resolve(PROJECT_ROOT, 'mcp-server')
const BRIDGE_SERVER_ENTRY = resolve(BRIDGE_SERVER_ROOT, 'src', 'server.js')

export function normalizeMasterGoPluginExportMode(mode) {
  if (mode === 'page-bundle' || mode === 'auto') return mode
  return 'single-page'
}

export function buildMasterGoPluginExportRequest(options = {}) {
  return {
    mode: normalizeMasterGoPluginExportMode(options.mode),
    pageName: options.pageName,
    frameName: options.frameName,
    nodeId: options.nodeId,
    responsivePairing: options.responsivePairing === true,
    options: {
      includeOriginalImages: false,
      includeRenderedSlices: true,
      rawProfile: 'html',
    },
  }
}

export function assertPageBundleBridgeSupport(health) {
  if (!Array.isArray(health?.features) || !health.features.includes('mastergo-page-bundle-v1')) {
    throw new Error('当前运行的 MasterGo bridge 版本不支持多页面导出。请重启 npm run mcp:dev 后重试。')
  }
}

export function assertPageBundleV2BridgeSupport(health) {
  assertPageBundleBridgeSupport(health)
  if (!health.features.includes('mastergo-page-bundle-v2')) {
    throw new Error('当前运行的 MasterGo bridge 版本不支持逻辑页面与响应式页面混合批次。请重启 npm run mcp:dev 后重试。')
  }
}

export function assertAutoFrameBridgeSupport(health) {
  assertPageBundleBridgeSupport(health)
  if (!health.features.includes('mastergo-auto-frame-bundle-v1')) {
    throw new Error('当前运行的 MasterGo bridge 版本不支持自动识别单个/多个 Frame。请重启 npm run mcp:dev 后重试。')
  }
}

export function assertResponsivePageBridgeSupport(health) {
  assertAutoFrameBridgeSupport(health)
  if (!health.features.includes('mastergo-responsive-page-v1')) {
    throw new Error('当前运行的 MasterGo bridge 版本不支持响应式 Frame 配对。请重启 npm run mcp:dev 后重试。')
  }
}

export function isBridgePermissionError(error) {
  const code = error?.code || error?.cause?.code
  return code === 'EACCES' || code === 'EPERM'
}

export async function requestMasterGoPluginExport(options = {}) {
  const bridgeUrl = options.bridgeUrl || DEFAULT_BRIDGE_URL
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  const exportRequest = buildMasterGoPluginExportRequest(options)
  await ensureBridgeReady({
    bridgeUrl,
    autoStart: options.autoStart !== false,
    startTimeoutMs: Number(options.startTimeoutMs || DEFAULT_BRIDGE_START_TIMEOUT_MS),
    onStatus: options.onStatus,
  })
  if (exportRequest.mode === 'page-bundle') {
    const health = await getJson(`${bridgeUrl}/health`)
    if (exportRequest.responsivePairing) assertPageBundleV2BridgeSupport(health)
    else assertPageBundleBridgeSupport(health)
  } else if (exportRequest.mode === 'auto') {
    const health = await getJson(`${bridgeUrl}/health`)
    // Keep single-Frame Agent requests compatible with an older auto-capable bridge. An old
    // bridge ignores responsivePairing and returns page-bundle only when multiple Frames exist.
    assertAutoFrameBridgeSupport(health)
  }
  const request = await postJson(`${bridgeUrl}/mastergo-exports`, exportRequest)

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const current = await getJson(`${bridgeUrl}/mastergo-exports/${request.requestId}`)
    if (current.status === 'done') return current
    if (current.status === 'error') throw new Error(current.error || 'MasterGo 插件导出失败。')
    await delay(1000)
  }

  throw new Error(`等待 MasterGo 插件导出超时：${request.requestId}`)
}

export async function ensureBridgeReady(options = {}) {
  const bridgeUrl = options.bridgeUrl || DEFAULT_BRIDGE_URL
  const initialProbe = await probeBridgeHealth(bridgeUrl)
  if (initialProbe.healthy) return { started: false, bridgeUrl }
  assertBridgePermission(initialProbe.error, bridgeUrl)
  if (options.autoStart === false) {
    throw new Error(`无法连接本地 MasterGo bridge：${bridgeUrl}。请先运行 npm run mcp:dev，并打开 MasterGo 插件窗口。`)
  }

  if (typeof options.onStatus === 'function') options.onStatus('local bridge is not running; starting the bundled Node server')
  const bridgePort = new URL(bridgeUrl).port
  const child = spawn(process.execPath, [BRIDGE_SERVER_ENTRY], {
    cwd: BRIDGE_SERVER_ROOT,
    detached: true,
    stdio: 'ignore',
    env: bridgePort ? { ...process.env, MCP_PORT: bridgePort } : process.env,
  })
  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < Number(options.startTimeoutMs || DEFAULT_BRIDGE_START_TIMEOUT_MS)) {
    const probe = await probeBridgeHealth(bridgeUrl)
    if (probe.healthy) {
      if (typeof options.onStatus === 'function') options.onStatus(`local bridge is ready: ${bridgeUrl}`)
      return { started: true, bridgeUrl }
    }
    assertBridgePermission(probe.error, bridgeUrl)
    await delay(500)
  }

  throw new Error(`已尝试自动启动本地 MasterGo bridge，但 ${bridgeUrl} 仍不可用。请手动运行 npm run mcp:dev 查看错误。`)
}

async function probeBridgeHealth(bridgeUrl) {
  try {
    const health = await getJson(`${bridgeUrl}/health`, { quiet: true })
    return { healthy: health?.ok === true, error: null }
  } catch (error) {
    return { healthy: false, error }
  }
}

function assertBridgePermission(error, bridgeUrl) {
  if (!isBridgePermissionError(error)) return
  throw new Error(
    `当前运行环境拒绝访问本地 MasterGo bridge：${bridgeUrl} (${error.code || error.cause?.code})。` +
    '在 Codex 中请以提升权限运行 npm run --silent codex:generate-from-mastergo -- ...。',
    { cause: error },
  )
}

function getJson(url, options) {
  return requestJson('GET', url, undefined, options)
}

function postJson(url, body) {
  return requestJson('POST', url, body)
}

function requestJson(method, url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const request = http.request(url, {
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        data += chunk
      })
      response.on('end', () => {
        let json = null
        try {
          json = data ? JSON.parse(data) : null
        } catch {
          reject(new Error(`Bridge 返回了非 JSON 响应：HTTP ${response.statusCode}`))
          return
        }
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(json?.message || json?.error || `HTTP ${response.statusCode}`))
          return
        }
        resolve(json)
      })
    })
    request.on('error', (error) => {
      const wrapped = new Error(
        options.quiet ? error.message : `无法连接本地 MasterGo bridge：${error.message}。请确认 MasterGo 插件窗口已打开。`,
        { cause: error },
      )
      wrapped.code = error.code
      reject(wrapped)
    })
    if (payload) request.write(payload)
    request.end()
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
