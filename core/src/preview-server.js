import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

export async function serveOutputDirectory(outputDir, options = {}) {
  const rootDir = resolve(outputDir)
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`预览目录不存在：${rootDir}`)
  }
  const indexPath = join(rootDir, 'index.html')
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new Error(`预览目录缺少 index.html：${rootDir}`)
  }

  const host = options.host || '127.0.0.1'
  const preferredPort = Number(options.port || 5178)
  const strictPort = Boolean(options.strictPort)
  const server = http.createServer((req, res) => {
    try {
      serveRequest(req, res, rootDir)
    } catch (error) {
      sendText(res, 500, error instanceof Error ? error.message : String(error))
    }
  })

  const port = await listenWithPortFallback(server, host, preferredPort, strictPort)
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/`,
    outputDir: rootDir,
  }
}

function serveRequest(req, res, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed')
    return
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = decodeURIComponent(url.pathname)
  const relativePath = pathname === '/' ? 'index.html' : normalize(pathname.slice(1))
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes('/../')) {
    sendText(res, 403, 'Forbidden')
    return
  }

  const filePath = resolve(rootDir, relativePath)
  if (!filePath.startsWith(`${rootDir}/`) && filePath !== rootDir) {
    sendText(res, 403, 'Forbidden')
    return
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, 'Not Found')
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

function listenWithPortFallback(server, host, preferredPort, strictPort) {
  return new Promise((resolvePromise, reject) => {
    const tryPort = (port) => {
      const onError = (error) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE' && !strictPort && port < preferredPort + 50) {
          tryPort(port + 1)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolvePromise(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    tryPort(preferredPort)
  })
}

function contentType(filePath) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  })[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}
