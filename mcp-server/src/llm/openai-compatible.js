import http from 'node:http'
import https from 'node:https'

export async function generateText({ config, system, prompt }) {
  if (config.provider === 'anthropic') {
    return generateAnthropicText({ config, system, prompt })
  }

  if (config.wireApi === 'responses') {
    return generateOpenAiResponsesText({ config, system, prompt })
  }

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  }

  const response = await postJson(`${config.baseUrl}/chat/completions`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  })

  const content = response?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return content.trim()
}

async function generateOpenAiResponsesText({ config, system, prompt }) {
  const response = await postJson(`${config.baseUrl}/responses`, {
    model: config.model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  }, {
    Authorization: `Bearer ${config.apiKey}`,
  })

  const content = extractResponsesText(response)
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return content
}

async function generateAnthropicText({ config, system, prompt }) {
  const payload = {
    model: config.model,
    max_tokens: 256,
    system,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
  }

  const authHeaders = config.authTokenType === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'x-api-key': config.apiKey }

  const response = await postJson(`${config.baseUrl}/v1/messages`, payload, {
    ...authHeaders,
    'anthropic-version': '2023-06-01',
  })

  const textParts = Array.isArray(response?.content)
    ? response.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    : []
  const content = textParts.join('\n').trim()
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return content
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'http:' ? http : https
    const requestBody = JSON.stringify(body)

    const req = client.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            reject(new Error(`模型接口返回了非 JSON 内容：HTTP ${res.statusCode}`))
            return
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const message = parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`
            reject(new Error(`模型调用失败：${message}`))
            return
          }

          resolve(parsed)
        })
      },
    )

    req.setTimeout(60000, () => {
      req.destroy(new Error('模型调用超时。'))
    })
    req.on('error', reject)
    req.write(requestBody)
    req.end()
  })
}

function extractResponsesText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim()
  }

  const chunks = []
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        chunks.push(content.text)
      }
    }
  }
  return chunks.join('\n').trim()
}
