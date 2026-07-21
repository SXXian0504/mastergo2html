import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { assertLlmConfig, getLlmConfig } from './config.js'
import { runAssemblyPlanning } from './workflow/assembly-planning.js'
import { runAiLayoutAnalysis } from './workflow/ai-layout-analysis.js'
import { runComponentStructureAnalysis } from './workflow/component-structure-analysis.js'
import { runInteractionAnalysis } from './workflow/interaction-analysis.js'
import { runRawLayoutConversion } from './workflow/raw-layout-conversion.js'
import { runStaticAssetAnalysis } from './workflow/static-asset-analysis.js'

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
      service: 'mastergo2html-mcp-server',
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
      const current = jobs.get(jobId)
      const phaseDetails = (current?.phaseDetails || []).map((phase) => {
        if (phase.status !== 'running') return phase
        const endedAt = new Date().toISOString()
        return {
          ...phase,
          status: 'error',
          endedAt,
          durationMs: phase.startedAt
            ? new Date(endedAt).getTime() - new Date(phase.startedAt).getTime()
            : phase.durationMs,
          message: error instanceof Error ? error.message : String(error),
        }
      })
      updateJob(jobId, {
        status: 'error',
        progress: {
          phase: current?.progress?.phase || 'package-files',
          percent: current?.progress?.percent || 100,
          message: '任务失败',
        },
        phaseDetails,
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
  console.log(`mastergo2html bridge listening on http://127.0.0.1:${PORT}`)
  console.log(`panel: http://127.0.0.1:${PORT}/panel`)
})

async function processJob(jobId, input) {
  const llmConfig = getLlmConfig()
  assertLlmConfig(llmConfig)
  const phaseDetails = []
  const beginPhase = (phase, message) => {
    upsertPhaseDetail(phaseDetails, phase, {
      status: 'running',
      startedAt: new Date().toISOString(),
      message,
      tokenUsage: emptyTokenUsage(),
    })
  }
  const completePhase = (phase, message, patch = {}) => {
    const current = findPhaseDetail(phaseDetails, phase)
    const endedAt = new Date().toISOString()
    const durationMs = patch.durationMs ?? (current?.startedAt ? new Date(endedAt).getTime() - new Date(current.startedAt).getTime() : 0)
    upsertPhaseDetail(phaseDetails, phase, {
      status: 'done',
      endedAt,
      durationMs,
      message,
      tokenUsage: patch.tokenUsage || current?.tokenUsage || emptyTokenUsage(),
      artifacts: patch.artifacts || current?.artifacts || [],
    })
  }

  beginPhase('normalize-raw', '标准化输入数据')
  updateJob(jobId, {
    status: 'running',
    progress: { phase: 'normalize-raw', percent: 10, message: '标准化输入数据' },
    phaseDetails,
  })
  const normalizeStartedAt = Date.now()
  const layoutConversion = runRawLayoutConversion(jobId, getJobDir(jobId))
  completePhase('normalize-raw', `已生成标准化输入：${layoutConversion.summary.nodeCount} 个节点，${layoutConversion.summary.assetCount} 个资源`, {
    durationMs: Date.now() - normalizeStartedAt,
    artifacts: [
      layoutConversion.normalizedDir,
      layoutConversion.aiLayoutContextPath,
    ],
  })
  updateJob(jobId, {
    progress: {
      phase: 'normalize-raw',
      percent: 25,
      message: `已生成标准化输入：${layoutConversion.summary.nodeCount} 个节点，${layoutConversion.summary.assetCount} 个资源`,
    },
    rawLayoutConversionSummary: layoutConversion.summary,
    normalizedPath: layoutConversion.normalizedDir,
    phaseDetails,
  })

  beginPhase('layout-analysis', '调用 AI 布局分析生成页面整体布局说明')
  updateJob(jobId, {
    progress: {
      phase: 'layout-analysis',
      percent: 32,
      message: '调用 AI 布局分析生成页面整体布局说明',
    },
    layoutPath: layoutConversion.layoutDir,
    phaseDetails,
  })
  const aiLayoutAnalysisResult = await runAiLayoutAnalysis({
    config: llmConfig,
    jobId,
    jobDir: getJobDir(jobId),
    contextPath: layoutConversion.aiLayoutContextPath,
  })
  completePhase('layout-analysis', `AI 布局分析已生成 page-layout.md：${layoutConversion.summary.warningCount} 个 warning 待后续修复`, {
    durationMs: aiLayoutAnalysisResult.durationMs,
    tokenUsage: aiLayoutAnalysisResult.tokenUsage,
    artifacts: [
      aiLayoutAnalysisResult.outputPath,
      aiLayoutAnalysisResult.promptPath,
      aiLayoutAnalysisResult.responsePath,
    ],
  })
  updateJob(jobId, {
    progress: {
      phase: 'layout-analysis',
      percent: 40,
      message: `AI 布局分析已生成 page-layout.md：${layoutConversion.summary.warningCount} 个 warning 待后续修复`,
    },
    aiLayoutAnalysisResult,
    phaseDetails,
  })

  beginPhase('component-structure-analysis', 'AI 分析整页组件结构与布局实现')
  updateJob(jobId, {
    progress: { phase: 'component-structure-analysis', percent: 50, message: 'AI 分析整页组件结构与布局实现' },
    phaseDetails,
  })
  const componentStructureResult = await runComponentStructureAnalysis({
    config: llmConfig,
    jobId,
    jobDir: getJobDir(jobId),
  })
  completePhase('component-structure-analysis', '整页组件结构开发计划已生成', {
    durationMs: componentStructureResult.durationMs,
    tokenUsage: componentStructureResult.tokenUsage,
    artifacts: [
      componentStructureResult.outputPath,
      componentStructureResult.promptPath,
    ],
  })
  updateJob(jobId, {
    progress: { phase: 'component-structure-analysis', percent: 58, message: '整页组件结构开发计划已生成' },
    componentStructureResult,
    phaseDetails,
  })

  beginPhase('static-asset-analysis', 'AI 分析整页静态资源使用方案')
  updateJob(jobId, {
    progress: { phase: 'static-asset-analysis', percent: 60, message: 'AI 分析整页静态资源使用方案' },
    phaseDetails,
  })
  const staticAssetResult = await runStaticAssetAnalysis({
    config: llmConfig,
    jobId,
    jobDir: getJobDir(jobId),
  })
  completePhase('static-asset-analysis', '整页静态资源开发计划已生成', {
    durationMs: staticAssetResult.durationMs,
    tokenUsage: staticAssetResult.tokenUsage,
    artifacts: [
      staticAssetResult.outputPath,
      staticAssetResult.promptPath,
    ],
  })
  updateJob(jobId, {
    progress: { phase: 'static-asset-analysis', percent: 68, message: '整页静态资源开发计划已生成' },
    staticAssetResult,
    phaseDetails,
  })

  beginPhase('interaction-analysis', 'AI 分析整页动态交互与状态')
  updateJob(jobId, {
    progress: { phase: 'interaction-analysis', percent: 70, message: 'AI 分析整页动态交互与状态' },
    phaseDetails,
  })
  const interactionResult = await runInteractionAnalysis({
    config: llmConfig,
    jobId,
    jobDir: getJobDir(jobId),
  })
  completePhase('interaction-analysis', '整页动态交互开发计划已生成', {
    durationMs: interactionResult.durationMs,
    tokenUsage: interactionResult.tokenUsage,
    artifacts: [
      interactionResult.outputPath,
      interactionResult.promptPath,
    ],
  })
  updateJob(jobId, {
    progress: { phase: 'interaction-analysis', percent: 78, message: '整页动态交互开发计划已生成' },
    interactionResult,
    phaseDetails,
  })

  beginPhase('assembly-planning', 'AI 汇总三份页面计划并裁决组装方案')
  updateJob(jobId, {
    progress: { phase: 'assembly-planning', percent: 82, message: 'AI 汇总三份页面计划并裁决组装方案' },
    phaseDetails,
  })
  const assemblyResult = await runAssemblyPlanning({
    config: llmConfig,
    jobId,
    jobDir: getJobDir(jobId),
  })
  completePhase('assembly-planning', '单页面组装计划已生成', {
    durationMs: assemblyResult.durationMs,
    tokenUsage: assemblyResult.tokenUsage,
    artifacts: [assemblyResult.outputPath, assemblyResult.promptPath],
  })
  updateJob(jobId, {
    progress: { phase: 'assembly-planning', percent: 88, message: '单页面组装计划已生成' },
    assemblyResult,
    phaseDetails,
  })

  beginPhase('html-generation', '生成 HTML 产物')
  updateJob(jobId, {
    progress: { phase: 'html-generation', percent: 90, message: '生成 HTML 产物' },
    phaseDetails,
  })
  const htmlGenerationStartedAt = Date.now()
  await sleep(150)
  completePhase('html-generation', 'HTML 生成阶段当前为占位产物', { durationMs: Date.now() - htmlGenerationStartedAt })

  beginPhase('package-files', '打包结果')
  updateJob(jobId, {
    progress: { phase: 'package-files', percent: 100, message: '打包结果' },
    phaseDetails,
  })
  const packageStartedAt = Date.now()

  const jobDir = getJobDir(jobId)
  const outputDir = join(jobDir, 'output')
  mkdirSync(outputDir, { recursive: true })
  const htmlPath = join(outputDir, 'index.html')
  const zipPath = join(outputDir, 'result.zip')
  writeFileSync(htmlPath, buildHtmlPlaceholder(jobId, input), 'utf8')
  writeFileSync(zipPath, buildZipPlaceholder(jobId, input), 'utf8')
  completePhase('package-files', '任务完成', {
    durationMs: Date.now() - packageStartedAt,
    artifacts: [htmlPath, zipPath],
  })
  const record = jobs.get(jobId)
  const nextRecord = {
    ...record,
    status: 'done',
    updatedAt: new Date().toISOString(),
    outputPath: outputDir,
    outputDir,
    downloadUrl: `/jobs/${jobId}/download`,
    resultSummary: {
      htmlPath,
      zipPath,
      note: '当前为阶段 1.5 骨架实现，后续接入正式 workflow。',
    },
    phaseDetails,
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

function findPhaseDetail(phaseDetails, phase) {
  return phaseDetails.find((item) => item.phase === phase)
}

function upsertPhaseDetail(phaseDetails, phase, patch) {
  const current = findPhaseDetail(phaseDetails, phase)
  if (current) {
    Object.assign(current, patch)
    return current
  }
  const next = {
    phase,
    status: 'pending',
    message: '',
    durationMs: 0,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    ...patch,
  }
  phaseDetails.push(next)
  return next
}

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimated: false,
  }
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
  const title = input?.source?.pageName || 'MasterGo2HTML Preview'
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
      <title>MasterGo2HTML Jobs</title>
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
        details { border: 1px solid #e4e8ee; border-radius: 6px; margin-top: 8px; background: #fbfcff; }
        summary { cursor: pointer; padding: 8px 10px; font-weight: 700; }
        details[open] summary { border-bottom: 1px solid #e4e8ee; }
        .phase-body { padding: 8px 10px; display: grid; gap: 6px; }
        .phase-facts { display: flex; gap: 8px; flex-wrap: wrap; }
        .phase-facts span { background: #eef3fa; border-radius: 6px; padding: 3px 6px; }
      </style>
    </head>
    <body>
      <header>
        <h1>MasterGo2HTML Jobs</h1>
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
          const phases = (job.phaseDetails || []).map(function(phase) {
            const usage = phase.tokenUsage || {};
            const open = phase.status === 'running' ? ' open' : '';
            return '<details' + open + '>' +
              '<summary>' + escapeHtml(phaseLabel(phase.phase)) + ' · ' + escapeHtml(phase.status || '') + '</summary>' +
              '<div class="phase-body">' +
                '<div class="meta">' + escapeHtml(phase.message || '') + '</div>' +
                '<div class="phase-facts meta">' +
                  '<span>耗时 ' + escapeHtml(formatDuration(phase.durationMs || 0)) + '</span>' +
                  '<span>输入 ' + escapeHtml(formatTokens(usage.inputTokens)) + '</span>' +
                  '<span>输出 ' + escapeHtml(formatTokens(usage.outputTokens)) + '</span>' +
                  '<span>总计 ' + escapeHtml(formatTokens(usage.totalTokens)) + (usage.estimated ? ' 估算' : '') + '</span>' +
                '</div>' +
              '</div>' +
            '</details>';
          }).join('');
          return '<section class="job">' +
            '<div class="row"><strong>' + escapeHtml(job.jobId) + '</strong><span class="meta">' + escapeHtml(job.status) + '</span></div>' +
            '<div class="bar"><span style="width:' + percent + '%"></span></div>' +
            '<div class="row meta"><span>' + escapeHtml(job.progress?.phase || '') + '</span><span>' + percent + '%</span></div>' +
            '<div class="meta">' + escapeHtml(job.progress?.message || '') + '</div>' +
            phases +
            '<div class="meta">' + escapeHtml(job.inputPath || '') + '</div>' +
            '<div class="meta">' + escapeHtml(job.resultSummary?.zipPath || job.outputPath || '') + '</div>' +
          '</section>'
          }).join('') : '<section class="job meta">No jobs yet.</section>';
        }
        function phaseLabel(phase) {
          return ({
            'collect-input': '收集输入',
            'normalize-raw': '标准化',
            'layout-analysis': '布局分析',
            'component-structure-analysis': '组件结构分析',
            'static-asset-analysis': '静态资源分析',
            'interaction-analysis': '动态交互分析',
            'assembly-planning': '页面组装计划',
            'html-generation': 'HTML 生成',
            'visual-qa': '视觉 QA',
            'package-files': '打包文件'
          })[phase] || phase || '';
        }
        function formatDuration(ms) {
          return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
        }
        function formatTokens(value) {
          const count = Number(value || 0);
          return count >= 1000 ? (count / 1000).toFixed(1) + 'k' : String(count);
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
