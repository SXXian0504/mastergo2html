import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

export class McpStdioClient {
  constructor({ command, args = [], env = {}, cwd = process.cwd(), stderr = process.stderr } = {}) {
    if (!command) throw new Error('MCP command is required.')
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
    this.stderr = stderr
    this.nextId = 1
    this.pending = new Map()
    this.events = new EventEmitter()
    this.buffer = ''
    this.process = null
  }

  async connect() {
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk))
    this.process.stderr.on('data', (chunk) => {
      if (this.stderr) this.stderr.write(chunk)
    })
    this.process.on('exit', (code, signal) => {
      const error = new Error(`MCP server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
    })

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mastergo2html-cli',
        version: '0.0.0',
      },
    })
    this.notify('notifications/initialized', {})
  }

  async listTools() {
    const result = await this.request('tools/list', {})
    return Array.isArray(result?.tools) ? result.tools : []
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args })
  }

  async close() {
    if (!this.process) return
    const child = this.process
    this.process = null
    if (child.exitCode != null || child.signalCode != null) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Process may have exited between timeout and kill.
        }
        resolve()
      }, 1000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.end()
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, 60000)
      this.pending.set(id, { resolve, reject, timeout, method })
      this.writeMessage(payload)
    })
  }

  notify(method, params = {}) {
    this.writeMessage({ jsonrpc: '2.0', method, params })
  }

  writeMessage(payload) {
    const body = JSON.stringify(payload)
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }

  handleStdout(chunk) {
    this.buffer += chunk
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.slice(0, headerEnd)
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return
      const body = this.buffer.slice(bodyStart, bodyEnd)
      this.buffer = this.buffer.slice(bodyEnd)
      this.handleMessage(JSON.parse(body))
    }
  }

  handleMessage(message) {
    if (message.id == null) {
      this.events.emit('notification', message)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message || `MCP error for ${pending.method}`))
    } else {
      pending.resolve(message.result)
    }
  }
}
