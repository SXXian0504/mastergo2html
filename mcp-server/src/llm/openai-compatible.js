import http from 'node:http'
import https from 'node:https'

export async function generateText({ config, system, prompt, temperature = 0.2, maxTokens, timeoutMs, retries = 1 }) {
  const result = await generateTextDetailed({ config, system, prompt, temperature, maxTokens, timeoutMs, retries })
  return result.text
}

export async function generateTextDetailed({ config, system, prompt, temperature = 0.2, maxTokens, timeoutMs, retries = 1 }) {
  if (config.provider === 'anthropic') {
    return withRetry(() => generateAnthropicText({ config, system, prompt, temperature, maxTokens, timeoutMs }), retries)
  }

  if (config.wireApi === 'responses') {
    return withRetry(() => generateOpenAiResponsesText({ config, system, prompt, temperature, maxTokens, timeoutMs }), retries)
  }

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
  }
  if (maxTokens) payload.max_tokens = maxTokens

  const response = await withRetry(() => postJson(`${config.baseUrl}/chat/completions`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  }, timeoutMs), retries)

  const content = response?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content.trim(),
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

async function generateOpenAiResponsesText({ config, system, prompt, temperature, maxTokens, timeoutMs }) {
  const payload = {
    model: config.model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
  }
  if (maxTokens) payload.max_output_tokens = maxTokens

  const response = await postJson(`${config.baseUrl}/responses`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  }, timeoutMs)

  const content = extractResponsesText(response)
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content,
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

async function generateAnthropicText({ config, system, prompt, temperature, maxTokens, timeoutMs }) {
  const payload = {
    model: config.model,
    max_tokens: maxTokens || 4096,
    system,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature,
  }

  const authHeaders = config.authTokenType === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'x-api-key': config.apiKey }

  const response = await postJson(`${config.baseUrl}/v1/messages`, payload, {
    ...authHeaders,
    'anthropic-version': '2023-06-01',
  }, timeoutMs)

  const textParts = Array.isArray(response?.content)
    ? response.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    : []
  const content = textParts.join('\n').trim()
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content,
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

function normalizeUsage(usage, system, prompt, output) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.inputTokens ?? estimateTokens(`${system}\n${prompt}`)
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? usage?.outputTokens ?? estimateTokens(output)
  const totalTokens = usage?.total_tokens ?? usage?.totalTokens ?? inputTokens + outputTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: !usage,
  }
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 3))
}

function postJson(url, body, headers = {}, timeoutMs = 120000) {
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

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('模型调用超时。'))
    })
    req.on('error', reject)
    req.write(requestBody)
    req.end()
  })
}

async function withRetry(fn, retries) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableError(error)) break
      await sleep(800 * (attempt + 1))
    }
  }
  throw lastError
}

function isRetryableError(error) {
  const code = error?.code || ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || message.includes('模型调用超时')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
