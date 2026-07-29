let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.slice(0, headerEnd)
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (!match) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + length
    if (buffer.length < bodyEnd) return
    const body = buffer.slice(bodyStart, bodyEnd)
    buffer = buffer.slice(bodyEnd)
    handle(JSON.parse(body))
  }
})

function handle(message) {
  if (message.id == null) return
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mastergo-mcp', version: '0.0.0' },
    })
    return
  }
  if (message.method === 'tools/list') {
    send(message.id, {
      tools: [
        { name: 'get_selection_code', description: 'Fake selected node code.' },
        { name: 'get_selection_image', description: 'Fake selected node image.' },
      ],
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'get_selection_code') {
    send(message.id, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          page: { id: 'page-1', name: 'Demo Page' },
          node: {
            id: 'node-1',
            name: 'Demo Frame',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 240 },
            children: [],
          },
        }),
      }],
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'get_selection_image') {
    send(message.id, {
      content: [{
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwQnGAAAAABJRU5ErkJggg==',
      }],
    })
    return
  }
  send(message.id, null, { code: -32601, message: `Unknown method: ${message.method}` })
}

function send(id, result, error) {
  const body = JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
