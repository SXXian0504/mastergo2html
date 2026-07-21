import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { assertLlmConfig, getLlmConfig } from './config.js'
import { generateText } from './llm/openai-compatible.js'
import { runRawLayoutConversion } from './workflow/raw-layout-conversion.js'

const PORT = Number(process.env.MCP_PORT || 8787)
const ROOT = resolve(new URL('..', import.meta.url).pathname)
const DATA_DIR = join(ROOT, 'data')
const JOB_DIR = join(DATA_DIR, 'jobs')
const JOB_INDEX_FILE = join(DATA_DIR, 'jobs-index.json')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(JOB_DIR, { recursive: true })

const jobs = loadJobs()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const llmConfig = getLlmConfig()
    sendJson(res, 200, {
      ok: true,
      service: 'mastergo2json-mcp-server',
      jobs: jobs.size,
      llmConfigured: Boolean(llmConfig.apiKey && llmConfig.baseUrl && llmConfig.model),
      llm: {
        provider: llmConfig.provider,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        wireApi: llmConfig.wireApi,
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/panel') {
    sendHtml(res, 200, getPanelHtml())
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs') {
    sendJson(res, 200, { jobs: [...jobs.values()].sort(byUpdatedAtDesc) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = await readJson(req)
    const validationError = validateJobInput(body)
    if (validationError) {
      sendJson(res, 400, { error: 'invalid_job_input', message: validationError })
      return
    }
    const jobId = randomUUID()
    const now = new Date().toISOString()
    const inputPath = getJobInputDir(jobId)
    const job = {
      jobId,
      status: 'queued',
      progress: {
        phase: 'collect-input',
        percent: 0,
        message: '任务已创建，等待处理',
      },
      source: body.source || {
        pageId: 'unknown',
        pageName: 'unknown',
        selectionIds: [],
        selectionCount: 0,
      },
      createdAt: now,
      updatedAt: now,
      inputPath,
    }
    jobs.set(jobId, job)
    persistJobs()
    persistJob(jobId, { ...job, input: body })
    writeJobInput(jobId, body)
    processJob(jobId, body).catch((error) => {
      updateJob(jobId, {
        status: 'error',
        progress: { phase: 'package-files', percent: 100, message: '任务失败' },
        error: error instanceof Error ? error.message : String(error),
      })
    })
    sendJson(res, 200, {
      jobId,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      inputPath,
    })
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/') && url.pathname.endsWith('/download')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    const zipPath = job?.resultSummary?.zipPath
    if (!zipPath || !existsSync(zipPath)) {
      sendJson(res, 404, { error: 'download_not_ready', jobId })
      return
    }
    streamFile(res, zipPath, 'application/zip')
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    if (!job) {
      sendJson(res, 404, { error: 'job_not_found', jobId })
      return
    }
    if (url.pathname.endsWith('/logs')) {
      const payload = readJobFile(jobId)
      sendJson(res, 200, { jobId, logs: payload?.logs || [] })
      return
    }

    sendJson(res, 200, job)
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs-index') {
    sendJson(res, 200, { jobs: [...jobs.values()] })
    return
  }

  sendJson(res, 404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mastergo2json bridge listening on http://127.0.0.1:${PORT}`)
  console.log(`panel: http://127.0.0.1:${PORT}/panel`)
})

async function processJob(jobId, input) {
  updateJob(jobId, {
    status: 'running',
    progress: { phase: 'normalize-raw', percent: 10, message: '标准化输入数据' },
  })
  const layoutConversion = runRawLayoutConversion(jobId, getJobDir(jobId))
  updateJob(jobId, {
    progress: {
      phase: 'normalize-raw',
      percent: 25,
      message: `已生成标准化输入：${layoutConversion.summary.nodeCount} 个节点，${layoutConversion.summary.assetCount} 个资源`,
    },
    rawLayoutConversionSummary: layoutConversion.summary,
    normalizedPath: layoutConversion.normalizedDir,
  })

  updateJob(jobId, {
    progress: {
      phase: 'layout-analysis',
      percent: 40,
      message: `已生成页面布局：${layoutConversion.summary.moduleCount} 个模块，${layoutConversion.summary.warningCount} 个 warning`,
    },
    layoutPath: layoutConversion.layoutDir,
  })
  await sleep(150)

  updateJob(jobId, {
    progress: { phase: 'module-slicing', percent: 50, message: '切分模块' },
  })
  await sleep(150)

  updateJob(jobId, {
    progress: { phase: 'ai-planning', percent: 70, message: '生成 AI 计划' },
  })
  const llmConfig = getLlmConfig()
  assertLlmConfig(llmConfig)
  const prompt = '请用一句话回应：你已经收到这次 MasterGo 导出任务。'
  const aiReply = await generateText({
    config: llmConfig,
    system: '你是一个简洁的中文助手，只输出一句简短回复，不要解释。',
    prompt,
  })
  updateJob(jobId, {
    progress: { phase: 'ai-planning', percent: 78, message: 'AI 回复已返回' },
    aiReply,
  })
  await sleep(150)

  updateJob(jobId, {
    progress: { phase: 'html-generation', percent: 85, message: '生成 HTML 产物' },
  })
  await sleep(150)

  updateJob(jobId, {
    progress: { phase: 'package-files', percent: 100, message: '打包结果' },
  })

  const jobDir = getJobDir(jobId)
  const outputDir = join(jobDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const htmlPath = join(outputDir, 'index.html')
  const zipPath = join(outputDir, 'result.zip')
  writeFileSync(htmlPath, buildHtmlPlaceholder(jobId, input), 'utf8')
  writeFileSync(zipPath, buildZipPlaceholder(jobId, input), 'utf8')
  const record = jobs.get(jobId)
  const nextRecord = {
    ...record,
    status: 'done',
    updatedAt: new Date().toISOString(),
    outputPath: outputDir,
    outputDir,
    downloadUrl: `/jobs/${jobId}/download`,
    aiReply,
    resultSummary: {
      htmlPath,
      zipPath,
      note: '当前为阶段 1.5 骨架实现，后续接入正式 workflow。',
    },
    progress: { phase: 'package-files', percent: 100, message: '任务完成' },
  }
  persistJob(jobId, { ...nextRecord, input, logs: collectLogs(jobId) })
  jobs.set(jobId, nextRecord)
  persistJobs()
}

function loadJobs() {
  if (!existsSync(JOB_INDEX_FILE)) return new Map()
  try {
    const payload = JSON.parse(readFileSync(JOB_INDEX_FILE, 'utf8'))
    return new Map((payload.jobs || []).map((job) => [job.jobId, job]))
  } catch {
    return new Map()
  }
}

function persistJobs() {
  writeFileSync(JOB_INDEX_FILE, JSON.stringify({ jobs: [...jobs.values()] }, null, 2))
}

function persistJob(jobId, payload) {
  const jobDir = getJobDir(jobId)
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify(payload, null, 2))
}

function writeJobInput(jobId, payload) {
  const inputDir = getJobInputDir(jobId)
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify(payload.raw, null, 2))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify(payload.assetManifest, null, 2))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: payload.exportOptions,
    source: payload.source,
    createdAt: new Date().toISOString(),
  }, null, 2))

  for (const attachment of payload.attachments || []) {
    writeInputAttachment(inputDir, attachment)
  }
}

function readJobFile(jobId) {
  const file = join(getJobDir(jobId), 'job.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function getJobDir(jobId) {
  return join(JOB_DIR, jobId)
}

function getJobInputDir(jobId) {
  return join(getJobDir(jobId), '00-input')
}

function validateJobInput(payload) {
  if (!payload || typeof payload !== 'object') return '任务输入不能为空。'
  if (!payload.raw) return '任务输入缺少 raw。'
  if (!payload.assetManifest) return '任务输入缺少 assetManifest。'
  if (!payload.exportOptions) return '任务输入缺少 exportOptions。'
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
  const hasFrameScreenshot = attachments.some((file) => file?.path === 'frame-screenshot.png')
  if (!hasFrameScreenshot) return '任务输入缺少必需的 frame-screenshot.png。'
  return ''
}

function writeInputAttachment(inputDir, attachment) {
  if (!attachment || typeof attachment.path !== 'string') return
  const safePath = normalize(attachment.path)
  if (isAbsolute(safePath) || safePath.startsWith('..')) {
    throw new Error(`拒绝写入非法附件路径：${attachment.path}`)
  }
  if (attachment.encoding !== 'utf8' && attachment.encoding !== 'base64') {
    throw new Error(`不支持的附件编码：${attachment.encoding}`)
  }

  const targetPath = join(inputDir, safePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  if (attachment.encoding === 'base64') {
    writeFileSync(targetPath, Buffer.from(String(attachment.content || ''), 'base64'))
  } else {
    writeFileSync(targetPath, String(attachment.content || ''), 'utf8')
  }
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId)
  if (!current) return
  const next = {
    ...current,
    ...patch,
    progress: patch.progress || current.progress,
    updatedAt: new Date().toISOString(),
  }
  jobs.set(jobId, next)
  persistJobs()
  persistJob(jobId, { ...next, logs: collectLogs(jobId) })
}

function collectLogs(jobId) {
  const job = jobs.get(jobId)
  if (!job) return []
  return [
    `${job.createdAt} job created`,
    `${job.updatedAt} ${job.progress.phase} ${job.progress.message}`,
  ]
}

function buildZipPlaceholder(jobId, input) {
  return JSON.stringify({
    note: 'placeholder zip payload for stage 1.5',
    jobId,
    source: input?.source,
    exportOptions: input?.exportOptions,
    generatedAt: new Date().toISOString(),
  }, null, 2)
}

function buildHtmlPlaceholder(jobId, input) {
  const title = input?.source?.pageName || 'MasterGo2JSON Preview'
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; color: #18212f; }
      main { max-width: 760px; margin: 64px auto; padding: 24px; background: #fff; border: 1px solid #dce1e8; border-radius: 8px; }
      code { display: block; padding: 12px; background: #f7f9fc; border: 1px solid #e4e8ee; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>阶段 1.5 已完成任务提交、状态持久化和输出目录生成。正式 HTML workflow 后续接入。</p>
      <code>${escapeHtml(jobId)}</code>
    </main>
  </body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function getPanelHtml() {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>MasterGo2JSON Jobs</title>
      <style>
        body { font-family: Inter, system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #18212f; }
        header { padding: 16px 20px; border-bottom: 1px solid #dce1e8; background: #fff; }
        main { padding: 16px 20px; display: grid; gap: 12px; }
        .job { border: 1px solid #dce1e8; border-radius: 8px; background: #fff; padding: 12px 14px; }
        .row { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .meta { color: #6a7380; font-size: 12px; }
        .bar { height: 8px; background: #e7edf6; border-radius: 999px; overflow: hidden; margin: 8px 0; }
        .bar > span { display: block; height: 100%; background: #176bff; }
        code { display: block; white-space: pre-wrap; background: #f7f9fc; padding: 8px; border-radius: 6px; border: 1px solid #e4e8ee; margin-top: 8px; }
      </style>
    </head>
    <body>
      <header>
        <h1>MasterGo2JSON Jobs</h1>
        <p class="meta">Local bridge status: ${PORT}</p>
      </header>
      <main id="jobs"></main>
      <script>
        async function loadJobs() {
          const response = await fetch('/jobs');
          const payload = await response.json();
          renderJobs(payload.jobs || []);
        }
        function renderJobs(jobs) {
          document.getElementById('jobs').innerHTML = jobs.length ? jobs.map(function(job) {
          const percent = job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : 0;
          return '<section class="job">' +
            '<div class="row"><strong>' + escapeHtml(job.jobId) + '</strong><span class="meta">' + escapeHtml(job.status) + '</span></div>' +
            '<div class="bar"><span style="width:' + percent + '%"></span></div>' +
            '<div class="row meta"><span>' + escapeHtml(job.progress?.phase || '') + '</span><span>' + percent + '%</span></div>' +
            '<div class="meta">' + escapeHtml(job.progress?.message || '') + '</div>' +
            '<div class="meta">' + escapeHtml(job.inputPath || '') + '</div>' +
            '<div class="meta">' + escapeHtml(job.resultSummary?.zipPath || job.outputPath || '') + '</div>' +
          '</section>'
          }).join('') : '<section class="job meta">No jobs yet.</section>';
        }
        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, function(char) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
          });
        }
        loadJobs();
        setInterval(loadJobs, 1000);
      </script>
    </body>
  </html>`
}

function byUpdatedAtDesc(a, b) {
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function streamFile(res, filePath, contentType) {
  const body = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
