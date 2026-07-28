#!/usr/bin/env node
import { dirname } from 'node:path'
import {
  cancelRunningJob,
  doctor,
  getJobStatus,
  getJobs,
  getLatestJobStatus,
  markRunningJobCanceled,
  retryJobFromFailedPhase,
  runGenerateFromInput,
  serveJobOutput,
  validateInput,
} from '../../core/src/runner.js'

const args = process.argv.slice(2)
let progressPrinter

async function main() {
  const command = args[0]
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'doctor') {
    const result = doctor()
    if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2))
    else printDoctor(result)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'generate') {
    const input = readOption('--input') || readOption('-i')
    if (!input) throw new Error('缺少输入：mastergo2html generate --input <00-input.zip|00-input目录>')
    const jobRoot = readOption('--job-root')
    const json = hasFlag('--json')
    const result = await runGenerateFromInput(input, {
      jobRoot,
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printGenerateResult(result, json)
    return
  }

  if (command === 'list') {
    const jobs = getJobs({ jobRoot: readOption('--job-root') })
    if (hasFlag('--json')) console.log(JSON.stringify({ ok: true, jobs: jobs.map(compactJob) }, null, 2))
    else printJobList(jobs)
    return
  }

  if (command === 'status') {
    const jobId = readJobIdArgument()
    const job = jobId === '--latest' || hasFlag('--latest')
      ? getLatestJobStatus({ jobRoot: readOption('--job-root') })
      : getJobStatus(jobId, { jobRoot: readOption('--job-root') })
    if (hasFlag('--json')) console.log(JSON.stringify({ ok: true, job }, null, 2))
    else printJobStatus(job)
    return
  }

  if (command === 'cancel') {
    const jobId = readJobIdArgument()
    const result = cancelRunningJob(jobId === '--latest' || hasFlag('--latest') ? '--latest' : jobId, {
      jobRoot: readOption('--job-root'),
    })
    if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2))
    else printCancelResult(result)
    return
  }

  if (command === 'retry') {
    const jobId = readJobIdArgument()
    const result = await retryJobFromFailedPhase(jobId === '--latest' || hasFlag('--latest') ? '--latest' : jobId, {
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printGenerateResult(result, hasFlag('--json'))
    return
  }

  if (command === 'serve' || command === 'preview') {
    const jobId = readJobIdArgument()
    const result = await serveJobOutput(jobId === '--latest' || hasFlag('--latest') ? '--latest' : jobId, {
      jobRoot: readOption('--job-root'),
      host: readOption('--host') || '127.0.0.1',
      port: readOption('--port') || 5178,
      strictPort: hasFlag('--strict-port'),
    })
    if (hasFlag('--json')) {
      console.log(JSON.stringify({
        ok: true,
        jobId: result.jobId,
        url: result.url,
        host: result.host,
        port: result.port,
        outputDir: result.outputDir,
      }, null, 2))
    } else {
      printServeResult(result)
    }
    return await waitForStop()
  }

  if (command === 'validate-input') {
    const input = readOption('--input') || readOption('-i')
    if (!input) throw new Error('缺少输入：mastergo2html validate-input --input <00-input.zip|00-input目录>')
    const result = validateInput(input, { jobRoot: readOption('--job-root') })
    if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2))
    else printValidateInputResult(result)
    return
  }

  throw new Error(`未知命令：${command}`)
}

function readOption(name) {
  const index = args.indexOf(name)
  if (index < 0) return ''
  return args[index + 1] || ''
}

function hasFlag(name) {
  return args.includes(name)
}

function readJobIdArgument() {
  const optionsWithValue = new Set(['--input', '-i', '--job-root'])
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]
    if (optionsWithValue.has(value) || value === '--host' || value === '--port') {
      index += 1
      continue
    }
    if (value.startsWith('-')) continue
    return value
  }
  return '--latest'
}

function printHelp() {
  console.log(`mastergo2html

用法 / Usage:
  mastergo2html doctor [--json]
    检查 CLI、Node 和模型配置。
    Check CLI, Node, and model configuration.

  mastergo2html validate-input --input <00-input.zip|00-input-directory> [--job-root <dir>] [--json]
    校验 MasterGo 插件导出的 00-input.zip 或 00-input 目录。
    Validate a MasterGo plugin 00-input.zip export or extracted 00-input directory.

  mastergo2html generate --input <00-input.zip|00-input-directory> [--job-root <dir>] [--json]
    生成 HTML/CSS/JS，默认输出到 .mastergo2html/jobs/<jobId>/。
    Generate HTML/CSS/JS into .mastergo2html/jobs/<jobId>/ by default.

  mastergo2html list [--job-root <dir>] [--json]
    查看最近任务列表。
    List recent jobs.

  mastergo2html status <jobId> [--job-root <dir>] [--json]
  mastergo2html status --latest [--job-root <dir>] [--json]
    查看任务状态和实时进度。
    Show job status and live progress from job.json.

  mastergo2html cancel <jobId> [--job-root <dir>] [--json]
  mastergo2html cancel --latest [--job-root <dir>] [--json]
    取消正在运行的任务。
    Cancel a running job.

  mastergo2html retry <jobId> [--job-root <dir>] [--json]
  mastergo2html retry --latest [--job-root <dir>] [--json]
    从失败阶段继续运行失败任务。
    Continue a failed job from its failed phase.

  mastergo2html serve <jobId> [--job-root <dir>] [--host 127.0.0.1] [--port 5178] [--strict-port] [--json]
  mastergo2html serve --latest [--job-root <dir>] [--port 5178]
    启动前台 localhost 静态预览服务，按 Ctrl+C 停止。
    Start a foreground localhost static preview server. Press Ctrl+C to stop.

示例 / Examples:
  mastergo2html validate-input --input ./首页-pc-00-input.zip
  mastergo2html generate --input ./首页-pc-00-input.zip
  mastergo2html list
  mastergo2html status --latest
  mastergo2html cancel <jobId>
  mastergo2html retry <jobId>
  mastergo2html serve --latest
  mastergo2html generate --input ./00-input --json
`)
}

function printDoctor(result) {
  console.log(`mastergo2html doctor`)
  console.log(`node: ${result.node}`)
  console.log(`job root: ${result.jobRoot}`)
  console.log(`llm configured: ${result.llmConfigured ? 'yes' : 'no'}`)
  console.log(`model: ${result.llm.model}`)
  console.log(`base url: ${result.llm.baseUrl}`)
}

function printGenerateResult(result, json) {
  const jobPath = dirname(result.inputPath)
  const payload = {
    ok: true,
    jobId: result.jobId,
    jobPath,
    inputPath: result.inputPath,
    outputDir: result.outputDir,
    htmlPath: result.resultSummary?.htmlPath,
    zipPath: result.resultSummary?.zipPath,
    previewCommand: `npm run cli -- serve ${result.jobId}`,
  }
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log('')
  console.log('HTML 生成完成')
  console.log(`jobId: ${payload.jobId}`)
  console.log(`outputDir: ${payload.outputDir}`)
  console.log(`htmlPath: ${payload.htmlPath}`)
  console.log(`zipPath: ${payload.zipPath}`)
  console.log(`preview: ${payload.previewCommand}`)
}

function printValidateInputResult(result) {
  console.log('00-input 校验通过')
  console.log(`input: ${result.inputPath}`)
  console.log(`prepared: ${result.preparedInputDir}`)
  console.log(`page: ${result.page?.name || result.source?.pageName || 'unknown'}`)
  console.log(`selection: ${result.selectionCount}`)
  console.log(`assets: ${result.assetCount}`)
}

function printJobList(jobs) {
  if (jobs.length === 0) {
    console.log('暂无任务 / No jobs yet.')
    return
  }
  console.log('最近任务 / Recent jobs')
  for (const job of jobs) {
    const progress = job.progress || {}
    const phase = currentPhaseDetail(job)
    const retry = job.retryCount ? `  retry:${job.retryCount}` : ''
    console.log(`${job.jobId}  ${job.status}  ${progress.percent ?? '-'}%  ${progress.phase || '-'}  ${phase?.status || '-'}${retry}  ${progress.message || ''}`)
  }
}

function printJobStatus(job) {
  const progress = job.progress || {}
  console.log(`任务 / Job: ${job.jobId}`)
  console.log(`状态 / Status: ${job.status}`)
  if (job.pid) console.log(`进程 / PID: ${job.pid}`)
  console.log(`阶段 / Phase: ${progress.phase || '-'}`)
  console.log(`进度 / Progress: ${progress.percent ?? '-'}%`)
  console.log(`消息 / Message: ${progress.message || '-'}`)
  if (job.retryCount) console.log(`重试次数 / Retries: ${job.retryCount}`)
  if (job.lastRetryAt) console.log(`最近重试 / Last retry: ${job.lastRetryAt}`)
  const phase = currentPhaseDetail(job)
  if (phase) {
    console.log(`阶段状态 / Phase status: ${phase.status}`)
    if (phase.durationMs) console.log(`阶段耗时 / Phase duration: ${formatDuration(phase.durationMs)}`)
    if (phase.streamMetrics) {
      console.log(`流式字符 / Stream chars: ${formatCount(phase.streamMetrics.receivedChars)}`)
      console.log(`流式事件 / Stream events: ${formatCount(phase.streamMetrics.eventCount)}`)
      console.log(`流式状态 / Stream state: ${phase.streamMetrics.state || '-'}`)
    }
  }
  if (job.inputPath) console.log(`输入 / Input: ${job.inputPath}`)
  if (job.outputDir) console.log(`输出 / Output: ${job.outputDir}`)
  if (job.resultSummary?.zipPath) console.log(`压缩包 / ZIP: ${job.resultSummary.zipPath}`)
  if (job.error) console.log(`错误 / Error: ${job.error}`)
}

function currentPhaseDetail(job) {
  const phaseName = job.progress?.phase
  const phaseDetails = job.phaseDetails || []
  return [...phaseDetails].reverse().find((phase) => phase.phase === phaseName)
    || [...phaseDetails].reverse().find((phase) => phase.status === 'running' || phase.status === 'error' || phase.status === 'canceled')
    || phaseDetails[phaseDetails.length - 1]
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatCount(value) {
  const count = Number(value || 0)
  return count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count)
}

function printCancelResult(result) {
  if (!result.canceled) {
    console.log(`无需取消 / No cancel needed: ${result.reason}`)
    return
  }
  console.log(`已取消任务 / Canceled job: ${result.job.jobId}`)
  console.log(`已发送终止信号 / Signal sent: ${result.signalSent ? 'yes' : 'no'}`)
  if (result.processMissing) console.log('进程不存在 / Process missing: yes')
}

function printServeResult(result) {
  console.log('本地预览 / Local preview')
  console.log(`url: ${result.url}`)
  console.log(`jobId: ${result.jobId}`)
  console.log(`outputDir: ${result.outputDir}`)
  console.log('')
  console.log('按 Ctrl+C 停止 / Press Ctrl+C to stop.')
}

function compactJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    pid: job.pid,
    progress: job.progress,
    source: job.source,
    inputPath: job.inputPath,
    outputDir: job.outputDir,
    zipPath: job.resultSummary?.zipPath,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

class ProgressPrinter {
  constructor({ json }) {
    this.json = json
    this.streamLineOpen = false
    this.streamPhase = ''
  }

  jobStart(job) {
    this.jobId = job.jobId
    this.jobRoot = job.jobRoot
    this.jobDir = job.jobDir
    if (this.json) {
      process.stderr.write(`[job] ${job.jobId}\n[jobPath] ${job.jobDir}\n`)
      return
    }
    process.stdout.write(`jobId: ${job.jobId}\n`)
    process.stdout.write(`jobPath: ${job.jobDir}\n\n`)
    if (job.retry) process.stdout.write(`retryPhase: ${job.retryPhase}\n\n`)
  }

  progress(progress) {
    const line = formatProgressLine(progress)
    if (this.json) {
      process.stderr.write(`${line}\n`)
      return
    }

    if (progress.streamMetrics) {
      this.writeStreamLine(line, progress.phase)
      return
    }

    this.finishLine()
    process.stdout.write(`${line}\n`)
  }

  writeStreamLine(line, phase) {
    if (this.streamLineOpen && this.streamPhase !== phase) this.finishLine()
    this.streamLineOpen = true
    this.streamPhase = phase
    process.stdout.write(`\r${fitTerminalLine(line)}`)
  }

  finishLine() {
    if (!this.streamLineOpen) return
    process.stdout.write('\n')
    this.streamLineOpen = false
    this.streamPhase = ''
  }
}

function formatProgressLine(progress) {
  return `[${String(progress.percent).padStart(3, ' ')}%] ${progress.phase}: ${progress.message}`
}

function fitTerminalLine(line) {
  const columns = process.stdout.columns || 120
  const clear = '\x1b[2K'
  if (line.length <= columns - 1) return `${clear}${line}`
  return `${clear}${line.slice(0, Math.max(0, columns - 2))}…`
}

progressPrinter = new ProgressPrinter({ json: args.includes('--json') })

process.on('SIGINT', () => {
  handleStopSignal('SIGINT', 130)
})

process.on('SIGTERM', () => {
  handleStopSignal('SIGTERM', 143)
})

function handleStopSignal(signal, exitCode) {
  progressPrinter.finishLine()
  if (progressPrinter.jobId) {
    try {
      markRunningJobCanceled(progressPrinter.jobId, { jobRoot: progressPrinter.jobRoot })
      process.stderr.write(`\n任务已取消 / Job canceled: ${progressPrinter.jobId} (${signal})\n`)
    } catch (error) {
      process.stderr.write(`\n任务取消记录写入失败 / Failed to mark canceled: ${error.message}\n`)
    }
  }
  process.exit(exitCode)
}

function waitForStop() {
  return new Promise(() => {})
}

main().catch((error) => {
  const json = args.includes('--json')
  progressPrinter.finishLine()
  const payload = {
    ok: false,
    error: error.message,
    job: error.job,
  }
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.error(`mastergo2html failed: ${error.message}`)
    if (error.job?.jobId && error.job.jobId !== progressPrinter.jobId) console.error(`jobId: ${error.job.jobId}`)
  }
  process.exitCode = 1
})
