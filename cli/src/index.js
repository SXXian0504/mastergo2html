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
import { createInputFromMasterGoMcp, listMasterGoMcpTools } from '../../core/src/mastergo-mcp-input.js'
import { requestMasterGoPluginExport } from '../../core/src/mastergo-plugin-export.js'
import { createInputFromCodexMasterGo } from '../../core/src/codex-mastergo-input.js'
import { createInputFromMagicDsl } from '../../core/src/magic-dsl-input.js'
import { hydrateInputAssets } from '../../core/src/asset-hydrator.js'
import { buildMergePrepareCommand, resumeGeneratePageBundle, runGeneratePageBundle } from '../../core/src/page-bundle.js'
import {
  acceptAgentPlan,
  finalizeAgentJob,
  getAgentJobStatus,
  getAgentBatchStatus,
  inspectAgentJob,
  prepareAgentJob,
  prepareAgentPageBundle,
} from '../../core/src/agent-workflow.js'

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

  if (command === 'agent-prepare') {
    const input = await resolveAgentInput()
    const result = await prepareAgentJob(input, {
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printAgentResult({ ok: true, ...result }, hasFlag('--json'))
    return
  }

  if (command === 'agent-prepare-pages') {
    const input = await resolveAgentPageBundleInput()
    const result = await prepareAgentPageBundle(input, {
      batchRoot: readOption('--batch-root'),
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printAgentBatchResult(result, hasFlag('--json'))
    return
  }

  if (command === 'agent-batch-status') {
    const batchId = readRequiredJobId(command)
    const result = getAgentBatchStatus(batchId, { batchRoot: readOption('--batch-root') })
    printAgentBatchResult(result, hasFlag('--json'))
    return
  }

  if (command === 'agent-accept-plan') {
    const jobId = readRequiredJobId(command)
    const result = acceptAgentPlan(jobId, { jobRoot: readOption('--job-root') })
    printAgentResult(result, hasFlag('--json'))
    return
  }

  if (command === 'agent-finalize') {
    const jobId = readRequiredJobId(command)
    const result = await finalizeAgentJob(jobId, { jobRoot: readOption('--job-root') })
    printAgentResult(result, hasFlag('--json'))
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'agent-status') {
    const jobId = readRequiredJobId(command)
    const result = getAgentJobStatus(jobId, { jobRoot: readOption('--job-root') })
    printAgentResult(result, hasFlag('--json'))
    return
  }

  if (command === 'agent-inspect') {
    const jobId = readRequiredJobId(command)
    const result = inspectAgentJob(jobId, {
      moduleId: readOption('--module'),
      nodeId: readOption('--node'),
      assetId: readOption('--asset'),
      issues: hasFlag('--issues'),
    }, { jobRoot: readOption('--job-root') })
    printAgentResult({ ok: true, ...result }, hasFlag('--json'))
    return
  }

  if (command === 'generate') {
    let input = readOption('--input') || readOption('-i')
    const source = readOption('--source')
    if (!input && source === 'mastergo-mcp') {
      const mcpInput = await createInputFromMasterGoMcp({
        ...readMasterGoMcpOptions(),
        output: readOption('--output') || readOption('-o') || makeDefaultMcpInputOutput(),
      })
      progressPrinter.info(`MasterGo MCP 00-input ready: ${mcpInput.inputDir}`)
      input = mcpInput.inputDir
    } else if (!input && source === 'codex-mastergo') {
      const codexInput = createInputFromCodexMasterGo({
        ...readCodexMasterGoOptions(),
        output: readOption('--output') || readOption('-o') || makeDefaultCodexMasterGoInputOutput(),
      })
      progressPrinter.info(`Codex MasterGo 00-input ready: ${codexInput.inputDir}`)
      input = codexInput.inputDir
    } else if (!input && source === 'magic-dsl') {
      const magicInput = createInputFromMagicDsl({
        ...readMagicDslOptions(),
        output: readOption('--output') || readOption('-o') || makeDefaultMagicDslInputOutput(),
      })
      progressPrinter.info(`Magic DSL 00-input ready: ${magicInput.inputDir}`)
      if (hasFlag('--hydrate-assets')) {
        const hydration = hydrateInputAssets(readAssetHydrationOptions(magicInput.inputDir))
        progressPrinter.info(`Asset hydration ready: matched=${hydration.matched}, cropped=${hydration.cropped}, missing=${hydration.missing}`)
      }
      input = magicInput.inputDir
    }
    if (!input) throw new Error('缺少输入：mastergo2html generate --input <00-input.zip|00-input目录>，或使用 --source mastergo-mcp/codex-mastergo/magic-dsl')
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

  if (command === 'generate-pages') {
    const input = readOption('--input') || readOption('-i')
    if (!input) throw new Error('缺少页面包：mastergo2html generate-pages --input <pages.zip|pages-directory>')
    const json = hasFlag('--json')
    const result = await runGeneratePageBundle(input, readPageBatchRunOptions(command))
    progressPrinter.finishLine()
    const payload = buildPageBatchPayload(result)
    if (json) console.log(JSON.stringify(payload, null, 2))
    else printGeneratePagesResult(payload)
    if (!isSuccessfulBatchCheckpoint(result.status)) process.exitCode = 1
    return
  }

  if (command === 'resume-pages') {
    const batchId = args[1]
    if (!batchId || batchId.startsWith('-')) throw new Error('缺少 batchId：mastergo2html resume-pages <batchId>')
    const result = await resumeGeneratePageBundle(batchId, {
      ...readPageBatchRunOptions(command),
      approveQuality: hasFlag('--approve-quality'),
      retryQuality: hasFlag('--retry-quality') || hasFlag('--force-quality-retry'),
      forceQualityRetry: hasFlag('--force-quality-retry'),
    })
    progressPrinter.finishLine()
    const payload = buildPageBatchPayload(result)
    if (hasFlag('--json')) console.log(JSON.stringify(payload, null, 2))
    else printGeneratePagesResult(payload)
    if (!isSuccessfulBatchCheckpoint(result.status)) process.exitCode = 1
    return
  }

  if (command === 'generate-from-mastergo-mcp') {
    const mcpInput = await createInputFromMasterGoMcp({
      ...readMasterGoMcpOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultMcpInputOutput(),
    })
    progressPrinter.info(`MasterGo MCP 00-input ready: ${mcpInput.inputDir}`)
    const json = hasFlag('--json')
    const result = await runGenerateFromInput(mcpInput.inputDir, {
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printGenerateResult(result, json)
    return
  }

  if (command === 'generate-from-codex-mastergo') {
    const codexInput = createInputFromCodexMasterGo({
      ...readCodexMasterGoOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultCodexMasterGoInputOutput(),
    })
    progressPrinter.info(`Codex MasterGo 00-input ready: ${codexInput.inputDir}`)
    const json = hasFlag('--json')
    const result = await runGenerateFromInput(codexInput.inputDir, {
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printGenerateResult(result, json)
    return
  }

  if (command === 'export-from-magic-dsl') {
    const result = createInputFromMagicDsl({
      ...readMagicDslOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultMagicDslInputOutput(),
    })
    const hydration = hasFlag('--hydrate-assets')
      ? hydrateInputAssets(readAssetHydrationOptions(result.inputDir))
      : null
    if (hasFlag('--json')) console.log(JSON.stringify({
      ...result,
      inputPath: result.inputDir,
      hydration,
      generateCommand: `npm run --silent cli -- generate --input ${result.inputDir} --json`,
    }, null, 2))
    else {
      console.log('Magic DSL 00-input 导出完成')
      console.log(`inputPath: ${result.inputDir}`)
      console.log(`nodes: ${result.nodeCount}`)
      console.log(`assets: ${result.assetCount}`)
      if (hydration) console.log(`hydration: matched=${hydration.matched}, cropped=${hydration.cropped}, missing=${hydration.missing}`)
      console.log(`next: npm run --silent cli -- generate --input ${result.inputDir} --json`)
    }
    return
  }

  if (command === 'hydrate-assets') {
    const inputDir = readOption('--input') || readOption('-i')
    if (!inputDir) throw new Error('缺少输入：mastergo2html hydrate-assets --input <00-input目录>')
    const result = hydrateInputAssets(readAssetHydrationOptions(inputDir))
    if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2))
    else {
      console.log('Asset Hydrator 执行完成')
      console.log(`inputPath: ${result.inputDir}`)
      console.log(`matched: ${result.matched}`)
      console.log(`cropped: ${result.cropped}`)
      console.log(`ambiguous: ${result.ambiguous}`)
      console.log(`missing: ${result.missing}`)
      console.log(`report: ${result.reportPath}`)
    }
    return
  }

  if (command === 'mcp:list-tools') {
    const result = await listMasterGoMcpTools(readMasterGoMcpOptions())
    if (hasFlag('--json')) console.log(JSON.stringify({ ok: true, tools: result }, null, 2))
    else printMcpTools(result)
    return
  }

  if (command === 'mcp:fetch-selection') {
    const result = await createInputFromMasterGoMcp(readMasterGoMcpOptions())
    if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2))
    else {
      console.log('MasterGo MCP 选中节点已写入 00-input')
      console.log(`inputDir: ${result.inputDir}`)
      console.log(`codeTool: ${result.usedTools.code}`)
      console.log(`imageTool: ${result.usedTools.image || 'none'}`)
    }
    return
  }

  if (command === 'generate-pages-from-mastergo') {
    const exportRequest = await requestMasterGoPluginExport({
      ...readMasterGoPluginExportOptions(),
      mode: 'page-bundle',
      frameName: undefined,
      nodeId: undefined,
      onStatus: (message) => progressPrinter.info(message),
    })
    progressPrinter.info(`MasterGo multi-Frame page bundle ready: ${exportRequest.inputPath}`)
    const result = await runGeneratePageBundle(exportRequest.inputPath, readPageBatchRunOptions(command))
    progressPrinter.finishLine()
    const payload = {
      ...buildPageBatchPayload(result),
      exportRequestId: exportRequest.requestId,
      pageBundlePath: exportRequest.inputPath,
    }
    if (hasFlag('--json')) console.log(JSON.stringify(payload, null, 2))
    else printGeneratePagesResult(payload)
    if (!isSuccessfulBatchCheckpoint(result.status)) process.exitCode = 1
    return
  }

  if (command === 'generate-from-mastergo') {
    const exportRequest = await requestMasterGoPluginExport({
      ...readMasterGoPluginExportOptions(),
      mode: 'auto',
      onStatus: (message) => progressPrinter.info(message),
    })
    const json = hasFlag('--json')
    if (exportRequest.inputKind === 'page-bundle') {
      progressPrinter.info(`MasterGo multi-Frame page bundle ready: ${exportRequest.inputPath}`)
      const result = await runGeneratePageBundle(exportRequest.inputPath, readPageBatchRunOptions(command))
      progressPrinter.finishLine()
      const payload = {
        ...buildPageBatchPayload(result),
        generationKind: 'page-bundle',
        exportRequestId: exportRequest.requestId,
        pageBundlePath: exportRequest.inputPath,
      }
      if (json) console.log(JSON.stringify(payload, null, 2))
      else printGeneratePagesResult(payload)
      if (!isSuccessfulBatchCheckpoint(result.status)) process.exitCode = 1
      return
    }

    progressPrinter.info(`MasterGo single-Frame 00-input ready: ${exportRequest.inputPath}`)
    const result = await runGenerateFromInput(exportRequest.inputPath, {
      jobRoot: readOption('--job-root'),
      onJobStart: (job) => progressPrinter.jobStart(job),
      onProgress: (progress) => progressPrinter.progress(progress),
    })
    progressPrinter.finishLine()
    printGenerateResult(result, json, {
      generationKind: 'single-page',
      exportRequestId: exportRequest.requestId,
    })
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
  if (index < 0) return undefined
  return args[index + 1] || undefined
}

function readRequiredJobId(command) {
  const jobId = args[1]
  if (!jobId || jobId.startsWith('-')) throw new Error(`缺少 jobId：mastergo2html ${command} <jobId>`)
  return jobId
}

async function resolveAgentInput() {
  let input = readOption('--input') || readOption('-i')
  const source = readOption('--source')
  if (!input && source === 'mastergo-mcp') {
    const result = await createInputFromMasterGoMcp({
      ...readMasterGoMcpOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultMcpInputOutput(),
    })
    input = result.inputDir
  } else if (!input && source === 'codex-mastergo') {
    const result = createInputFromCodexMasterGo({
      ...readCodexMasterGoOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultCodexMasterGoInputOutput(),
    })
    input = result.inputDir
  } else if (!input && source === 'magic-dsl') {
    const result = createInputFromMagicDsl({
      ...readMagicDslOptions(),
      output: readOption('--output') || readOption('-o') || makeDefaultMagicDslInputOutput(),
    })
    if (hasFlag('--hydrate-assets')) hydrateInputAssets(readAssetHydrationOptions(result.inputDir))
    input = result.inputDir
  } else if (!input && source === 'mastergo-plugin') {
    const result = await requestMasterGoPluginExport({
      ...readMasterGoPluginExportOptions(),
      mode: 'single-page',
      onStatus: (message) => progressPrinter.info(message),
    })
    if (result.inputKind === 'page-bundle') throw new Error('agent-prepare 当前只接受单个 Frame；多 Frame Agent 批处理将在独立批次命令中处理')
    input = result.inputPath
  }
  if (!input) {
    throw new Error('缺少输入：agent-prepare --input <00-input>，或使用 --source mastergo-plugin/mastergo-mcp/codex-mastergo/magic-dsl')
  }
  progressPrinter.info(`Codex Agent 00-input ready: ${input}`)
  return input
}

async function resolveAgentPageBundleInput() {
  let input = readOption('--input') || readOption('-i')
  const source = readOption('--source')
  if (!input && source === 'mastergo-plugin') {
    const result = await requestMasterGoPluginExport({
      ...readMasterGoPluginExportOptions(),
      mode: 'page-bundle',
      frameName: undefined,
      nodeId: undefined,
      onStatus: (message) => progressPrinter.info(message),
    })
    if (result.inputKind !== 'page-bundle') throw new Error(`插件返回的输入类型不是 page-bundle：${result.inputKind || 'unknown'}`)
    input = result.inputPath
  }
  if (!input) throw new Error('缺少页面包：agent-prepare-pages --input <page-bundle>，或使用 --source mastergo-plugin')
  progressPrinter.info(`Codex Agent page bundle ready: ${input}`)
  return input
}

function readRepeatedOption(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1])
  }
  return values
}

function readMasterGoMcpOptions() {
  const command = readOption('--mcp-command')
  const mcpArgs = readRepeatedOption('--mcp-arg')
  return {
    command: command || undefined,
    args: mcpArgs.length > 0 ? mcpArgs : undefined,
    url: readOption('--mcp-url') || undefined,
    env: readOption('--mcp-access-key') ? { MASTERGO_MCP_ACCESS_KEY: readOption('--mcp-access-key') } : undefined,
    output: readOption('--output') || readOption('-o') || undefined,
    pageName: readOption('--page') || undefined,
    frameName: readOption('--frame') || undefined,
    nodeId: readOption('--node-id') || undefined,
    codeTool: readOption('--code-tool') || undefined,
    imageTool: readOption('--image-tool') || undefined,
    originalImageTool: readOption('--original-image-tool') || undefined,
    nodeSliceTool: readOption('--node-slice-tool') || undefined,
    includeOriginalImages: !hasFlag('--no-original-images'),
    includeRenderedSlices: !hasFlag('--no-rendered-slices'),
  }
}

function makeDefaultMcpInputOutput() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `.mastergo2html/mastergo-mcp/${stamp}/00-input`
}

function makeDefaultCodexMasterGoInputOutput() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `.mastergo2html/codex-mastergo/${stamp}/00-input`
}

function makeDefaultMagicDslInputOutput() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `.mastergo2html/magic-dsl/${stamp}/00-input`
}

function readCodexMasterGoOptions() {
  return {
    designRoot: readOption('--design-root') || undefined,
    snapshotHtml: readOption('--snapshot-html') || undefined,
    screenshot: readOption('--screenshot') || undefined,
    documentId: readOption('--document-id') || undefined,
    pageName: readOption('--page') || undefined,
    frameName: readOption('--frame') || undefined,
    nodeId: readOption('--node-id') || undefined,
  }
}

function readMagicDslOptions() {
  return {
    input: readOption('--dsl-root') || readOption('--magic-dsl') || readOption('--input') || readOption('-i') || undefined,
    output: readOption('--output') || readOption('-o') || undefined,
    screenshot: readOption('--screenshot') || undefined,
    fileId: readOption('--file-id') || undefined,
    layerId: readOption('--layer-id') || readOption('--node-id') || undefined,
    shortLink: readOption('--short-link') || undefined,
    pageName: readOption('--page') || undefined,
  }
}

function readAssetHydrationOptions(inputDir) {
  return {
    inputDir,
    snapshotHtml: readOption('--snapshot-html') || undefined,
    designRoot: readOption('--design-root') || undefined,
    screenshot: readOption('--screenshot') || undefined,
    nodeId: readOption('--node-id') || undefined,
    frameName: readOption('--frame') || undefined,
    cropComplex: hasFlag('--crop-complex'),
    cropNodeIds: readRepeatedOption('--crop-node'),
    strict: hasFlag('--strict-hydration'),
  }
}

function readMasterGoPluginExportOptions() {
  return {
    bridgeUrl: readOption('--bridge-url') || undefined,
    pageName: readOption('--page') || undefined,
    frameName: readOption('--frame') || undefined,
    nodeId: readOption('--node-id') || undefined,
    timeoutMs: readOption('--export-timeout-ms') || undefined,
    startTimeoutMs: readOption('--bridge-start-timeout-ms') || undefined,
    autoStart: !hasFlag('--no-auto-bridge'),
  }
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

  mastergo2html agent-prepare --input <00-input.zip|00-input-directory> [--job-root <dir>] [--json]
  mastergo2html agent-prepare --source mastergo-plugin|mastergo-mcp|codex-mastergo|magic-dsl [source options] [--json]
    只执行输入采集、标准化和上下文索引，等待当前 Codex 生成实施计划；不需要模型 API Key。

  mastergo2html agent-prepare-pages --input <pages.zip|pages-directory> [--batch-root <dir>] [--job-root <dir>] [--json]
  mastergo2html agent-prepare-pages --source mastergo-plugin [--batch-root <dir>] [--job-root <dir>] [--json]
  mastergo2html agent-batch-status <batchId> [--batch-root <dir>] [--json]
    为多个 Frame 创建相互隔离的 Agent 任务；当前 Codex 按 nextPage 逐页处理，避免合并完整上下文。

  mastergo2html agent-accept-plan <jobId> [--job-root <dir>] [--json]
    验收 agent/implementation-plan.json，并准备直接文件生成阶段。

  mastergo2html agent-finalize <jobId> [--job-root <dir>] [--json]
    验收 agent/draft/index.html、styles.css、script.js，执行运行时校验并打包。

  mastergo2html agent-status <jobId> [--job-root <dir>] [--json]
  mastergo2html agent-inspect <jobId> [--module <id>|--node <id>|--asset <id>|--issues] [--json]
    查看 Agent 状态或按需读取局部事实，避免重复载入完整上下文。

  mastergo2html validate-input --input <00-input.zip|00-input-directory> [--job-root <dir>] [--json]
    校验 MasterGo 插件导出的 00-input.zip 或 00-input 目录。
    Validate a MasterGo plugin 00-input.zip export or extracted 00-input directory.

  mastergo2html generate --input <00-input.zip|00-input-directory> [--job-root <dir>] [--json]
    生成 HTML/CSS/JS，默认输出到 .mastergo2html/jobs/<jobId>/。
    Generate HTML/CSS/JS into .mastergo2html/jobs/<jobId>/ by default.

  mastergo2html generate-pages --input <pages.zip|pages-directory> [--force-regenerate] [--page-concurrency 2] [--model-concurrency 5] [--quality-gate-pages 2] [--auto-quality-gate|--no-quality-gate] [--page-retries 2] [--batch-root <dir>] [--fail-fast] [--json]
  mastergo2html resume-pages <batchId> [--approve-quality|--retry-quality|--force-quality-retry] [--batch-root <dir>] [--json]
    读取网页端多 Frame 导出的 mastergo-pages.json 页面包，逐个页面生成 HTML，并输出 React 合并命令。
    Generate one HTML output per Frame from a page bundle and print the React merge preparation command.

  mastergo2html generate --source mastergo-mcp [--mcp-url http://localhost:50678] [--node-id <id>] [--job-root <dir>] [--json]
    先通过 MasterGo 官方 MCP 生成 00-input 和静态资源，再复用 CLI D2C 流程。
    Build 00-input and static assets through MasterGo MCP first, then run the CLI D2C workflow.

  mastergo2html generate --source codex-mastergo [--snapshot-html <file>] [--screenshot <png>] [--node-id <id>] [--job-root <dir>] [--json]
    读取 Codex App 托管 MasterGo MCP 已落盘的 .mastergo/design 快照，生成 00-input 后继续 D2C。
    Build 00-input from Codex App hosted MasterGo MCP snapshot files, then run D2C.

  mastergo2html generate --source magic-dsl --dsl-root <sections-dir|fallback-getDsl.json> [--output <00-input-dir>] [--hydrate-assets] [--job-root <dir>] [--json]
    从 MasterGo Magic MCP getDesignSections 落盘包生成标准 00-input，然后继续 D2C；Asset Hydrator 默认关闭。
    Build 00-input from saved getDesignSections data, then run D2C; Asset Hydrator is disabled by default.

  mastergo2html mcp:list-tools [--mcp-url http://localhost:50678] [--mcp-command <cmd>] [--mcp-arg <arg>] [--json]
    连接 MasterGo MCP 并列出可用工具。
    Connect to MasterGo MCP and list available tools.

  mastergo2html mcp:fetch-selection [--mcp-url http://localhost:50678] [--output <00-input-dir>] [--frame <name>] [--node-id <id>] [--json]
    通过 MasterGo MCP 抓取当前选中节点并写出 00-input。
    Fetch selected MasterGo node through MCP and write a 00-input directory.

  MasterGo MCP 可选参数 / optional flags:
    --mcp-access-key <key>
    --code-tool <tool> --image-tool <tool> --original-image-tool <tool> --node-slice-tool <tool>
    --no-original-images --no-rendered-slices

  mastergo2html generate-pages-from-mastergo [--page <name>] [--bridge-url <url>] [--no-auto-bridge] [--force-regenerate] [--page-concurrency 2] [--model-concurrency 5] [--quality-gate-pages 2] [--auto-quality-gate|--no-quality-gate] [--page-retries 2] [--batch-root <dir>] [--fail-fast] [--json]
    请求已打开的 MasterGo 插件导出当前选中的多个网页 Frame，并逐页生成 HTML。
    Request a multi-Frame page bundle from the open MasterGo plugin and generate one HTML output per Frame.

  mastergo2html generate-from-mastergo [--frame <name>] [--node-id <id>] [--bridge-url <url>] [--no-auto-bridge] [--page-concurrency 2] [--model-concurrency 5] [--quality-gate-pages 2] [--auto-quality-gate|--no-quality-gate] [--page-retries 2] [--batch-root <dir>] [--fail-fast] [--job-root <dir>] [--json]
    请求 MasterGo 插件用原始采集逻辑导出 00-input，然后复用 CLI D2C 流程生成 HTML。
    Request a full-quality plugin 00-input export, then run the CLI D2C workflow.

  mastergo2html generate-from-mastergo-mcp [--mcp-url http://localhost:50678] [--node-id <id>] [--job-root <dir>] [--json]
    使用 MasterGo 官方 MCP 生成 00-input 和静态资源，然后生成 HTML。
    Generate 00-input and static assets via the official MasterGo MCP, then generate HTML.

  mastergo2html generate-from-codex-mastergo [--snapshot-html <file>] [--screenshot <png>] [--node-id <id>] [--job-root <dir>] [--json]
    使用 Codex App 托管 MasterGo MCP 的本地快照生成 00-input，然后生成 HTML。
    Generate 00-input from Codex App hosted MasterGo MCP local snapshot, then generate HTML.

  mastergo2html export-from-magic-dsl --dsl-root <sections-dir|fallback-getDsl.json> [--output <00-input-dir>] [--screenshot <png>] [--hydrate-assets] [--json]
    只从 MasterGo Magic MCP getDesignSections 落盘包导出标准 00-input；可显式启用 Asset Hydrator。
    Export a standard 00-input from saved getDesignSections data; Asset Hydrator is opt-in.

  mastergo2html hydrate-assets --input <00-input-dir> [--snapshot-html <file>|--design-root <dir>] [--screenshot <png>] [--crop-complex] [--crop-node <id>] [--strict-hydration] [--json]
    融合 Codex MasterGo 快照资源，并可从完整 Frame 截图按 BoundingBox 裁切复杂视觉；默认失败开放。
    Fuse snapshot assets and optionally crop complex visuals from a full Frame screenshot by BoundingBox; fail-open by default.

  Asset Hydrator 可选参数 / optional flags:
    --hydrate-assets                    仅在 Magic DSL 导出/生成链路中显式启用
    --snapshot-html <file>              指定 Codex MasterGo 快照 HTML
    --design-root <dir>                 从快照目录自动选择 HTML
    --crop-complex                      自动裁切仍缺失的复杂视觉节点
    --crop-node <id>                    指定裁切节点，可重复传入
    --strict-hydration                  补水或裁切失败时退出，而不是继续生成

  Magic DSL 落盘包 / saved package, preferred:
    overview.json                         getDesignSections 无 sectionIndex 的原始返回
    sections/section-0.json ...           getDesignSections(sectionIndex=N) 的原始返回
    svg-assets.json                       可选，svgShortKey 到真实 SVG 字符串的映射
    assets/img|icon/**                    可选，可被 DSL resourcePath/imageRef 引用的本地资源
    frame-screenshot.png                  可选，缺失时写入 1x1 空 PNG
    magic-dsl.json                        fallback，仅用于保存 getDsl 的完整返回

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
  mastergo2html generate-pages --input ./website-pages.zip --json
  mastergo2html resume-pages <batchId> --approve-quality --json
  mastergo2html resume-pages <batchId> --retry-quality --json
  mastergo2html generate --source mastergo-mcp --mcp-url http://localhost:50678 --json
  mastergo2html generate --source codex-mastergo --json
  mastergo2html export-from-magic-dsl --dsl-root ./.mastergo2html/magic-dsl/source --output ./.mastergo2html/magic-dsl/00-input --hydrate-assets --snapshot-html ./.mastergo/design/frame.html --crop-complex --json
  mastergo2html hydrate-assets --input ./.mastergo2html/magic-dsl/00-input --snapshot-html ./.mastergo/design/frame.html --crop-complex --json
  mastergo2html generate --source magic-dsl --dsl-root ./.mastergo2html/magic-dsl/source --json
  mastergo2html mcp:list-tools --json
  mastergo2html mcp:fetch-selection --output ./.mastergo2html/mastergo-mcp/00-input --json
  mastergo2html generate-pages-from-mastergo --json
  mastergo2html generate-from-mastergo --json
  mastergo2html generate-from-mastergo-mcp --mcp-url http://localhost:50678 --json
  mastergo2html generate-from-codex-mastergo --json
`)
}

function printDoctor(result) {
  console.log(`mastergo2html doctor`)
  console.log(`node: ${result.node}`)
  console.log(`job root: ${result.jobRoot}`)
  console.log(`llm configured: ${result.llmConfigured ? 'yes' : 'no'}`)
  console.log(`provider: ${result.llm.provider}`)
  console.log(`auth: ${result.llm.auth}`)
  console.log(`model: ${result.llm.model || '(Codex default)'}`)
  if (result.llm.baseUrl) console.log(`base url: ${result.llm.baseUrl}`)
  for (const error of result.configErrors || []) console.log(`config error: ${error}`)
}

function printGenerateResult(result, json, metadata = {}) {
  const jobPath = dirname(result.inputPath)
  const warnings = collectJobWarnings(result)
  const payload = {
    ok: true,
    ...metadata,
    jobId: result.jobId,
    jobPath,
    inputPath: result.inputPath,
    outputDir: result.outputDir,
    htmlPath: result.resultSummary?.htmlPath,
    zipPath: result.resultSummary?.zipPath,
    previewCommand: `npm run cli -- serve ${result.jobId}`,
    warnings,
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
  if (warnings.length > 0) {
    console.log('')
    console.log(`校验预警 / Validation warnings (${warnings.length})`)
    for (const warning of warnings) console.log(`- ${warning}`)
  }
}

function printAgentResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const job = result.job || result
  console.log(`Codex Agent status: ${result.status || job.status || (result.ok ? 'ok' : 'error')}`)
  if (job.jobId) console.log(`jobId: ${job.jobId}`)
  if (job.jobDir) console.log(`jobDir: ${job.jobDir}`)
  if (job.manifestPath) console.log(`manifest: ${job.manifestPath}`)
  if (job.planTemplatePath) console.log(`plan template: ${job.planTemplatePath}`)
  if (job.draftDir) console.log(`draft: ${job.draftDir}`)
  if (result.validationPath) console.log(`validation: ${result.validationPath}`)
  if (result.outputDir) console.log(`output: ${result.outputDir}`)
  if (result.zipPath) console.log(`zip: ${result.zipPath}`)
  if (result.manifest?.nextCommand) console.log(`next: ${result.manifest.nextCommand}`)
}

function printAgentBatchResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Codex Agent batch: ${result.status}`)
  console.log(`batchId: ${result.batchId}`)
  console.log(`batch: ${result.batchDir}/batch.json`)
  console.log(`pages: ${result.summary.done}/${result.summary.total} done`)
  if (result.nextPage) console.log(`next page: ${result.nextPage.route} (${result.nextPage.jobId || result.nextPage.status})`)
  if (result.nextPage?.statusCommand) console.log(`next: ${result.nextPage.statusCommand}`)
}

function readPageBatchRunOptions(entryPoint) {
  const pageConcurrency = readPositiveIntegerOption('--page-concurrency')
  const modelConcurrency = readPositiveIntegerOption('--model-concurrency')
  const pageRetryLimit = readNonNegativeIntegerOption('--page-retries')
  const pageRetryBaseDelayMs = readNonNegativeIntegerOption('--retry-delay-ms')
  const globalErrorThreshold = readPositiveIntegerOption('--global-error-threshold')
  const qualityGatePageCount = readPositiveIntegerOption('--quality-gate-pages')
  const continueOnError = hasFlag('--fail-fast') ? false : undefined
  const qualityGateEnabled = hasFlag('--no-quality-gate') ? false : undefined
  const qualityGateMode = hasFlag('--auto-quality-gate') ? 'auto' : undefined
  const schedulerOptionSources = {}
  for (const [key, value, detail] of [
    ['pageConcurrency', pageConcurrency, '--page-concurrency'],
    ['modelConcurrency', modelConcurrency, '--model-concurrency'],
    ['pageRetryLimit', pageRetryLimit, '--page-retries'],
    ['pageRetryBaseDelayMs', pageRetryBaseDelayMs, '--retry-delay-ms'],
    ['globalErrorThreshold', globalErrorThreshold, '--global-error-threshold'],
    ['qualityGatePageCount', qualityGatePageCount, '--quality-gate-pages'],
    ['continueOnError', continueOnError, '--fail-fast'],
    ['qualityGateEnabled', qualityGateEnabled, '--no-quality-gate'],
    ['qualityGateMode', qualityGateMode, '--auto-quality-gate'],
  ]) {
    if (value !== undefined) schedulerOptionSources[key] = { kind: 'cli', detail }
  }

  return {
    entryPoint,
    batchRoot: readOption('--batch-root') || undefined,
    forceRegenerate: hasFlag('--force-regenerate'),
    forceQualityRetry: hasFlag('--force-quality-retry'),
    continueOnError,
    pageConcurrency,
    modelConcurrency,
    pageRetryLimit,
    pageRetryBaseDelayMs,
    globalErrorThreshold,
    qualityGateEnabled,
    qualityGateMode,
    qualityGatePageCount,
    schedulerOptionSources,
    onSchedulerResolved: printSchedulerDiagnostics,
    onPageStart: (page) => progressPrinter.info(`Page ${page.index + 1}/${page.total}: ${page.name} (${page.route})${page.representative ? ' [quality-gate]' : ''}`),
    onProgress: ({ page, progress }) => progressPrinter.progress({
      ...progress,
      message: `[${page.name}] ${progress.message}`,
    }),
    onPageRetry: (page) => progressPrinter.info(`Page retry ${page.retryCount}: ${page.route}, wait ${page.delayMs}ms -> ${page.error}`),
    onPageComplete: (page) => progressPrinter.info(`Page ready: ${page.route} -> ${page.htmlPath}`),
    onPageError: (page) => progressPrinter.info(`Page failed: ${page.route} -> ${page.error}`),
  }
}

function printSchedulerDiagnostics(diagnostics) {
  const pageSource = formatSchedulerSource(diagnostics.sources?.pageConcurrency)
  const modelSource = formatSchedulerSource(diagnostics.sources?.modelConcurrency)
  progressPrinter.info(`Scheduler resolved: pages=${diagnostics.effectiveConcurrency.pageConcurrency} (${pageSource}), models=${diagnostics.effectiveConcurrency.modelConcurrency} (${modelSource}), entry=${diagnostics.entryPoint}`)
  for (const warning of diagnostics.warnings || []) progressPrinter.info(`WARNING [${warning.code}]: ${warning.message}`)
}

function formatSchedulerSource(source) {
  if (!source) return 'unknown'
  if (source.kind === 'batch') {
    const inherited = source.inheritedSource ? ` <- ${formatSchedulerSource(source.inheritedSource)}` : ''
    return `${source.detail}${inherited}`
  }
  return source.detail || source.kind
}

function buildPageBatchPayload(result) {
  return {
    ok: isSuccessfulBatchCheckpoint(result.status),
    ...result,
    batchRecordPath: `${result.batchDir}/batch.json`,
    resumeCommand: result.status === 'quality-gate'
      ? `npm run --silent cli -- resume-pages ${result.batchId} --approve-quality --json`
      : result.status === 'paused' || result.status === 'partial' || result.status === 'quality-failed'
        ? `npm run --silent cli -- resume-pages ${result.batchId} --json`
        : null,
    retryQualityCommand: result.status === 'quality-gate' || result.status === 'quality-failed'
      ? `npm run --silent cli -- resume-pages ${result.batchId} --retry-quality --json`
      : null,
    mergePrepareCommand: buildMergePrepareCommand(result),
  }
}

function isSuccessfulBatchCheckpoint(status) {
  return status === 'done' || status === 'quality-gate'
}

function readPositiveIntegerOption(name) {
  const value = readOption(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数。`)
  return parsed
}

function readNonNegativeIntegerOption(name) {
  const value = readOption(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数。`)
  return parsed
}

function printGeneratePagesResult(result) {
  console.log('')
  console.log(`多页面 HTML 批次状态: ${result.status}`)
  console.log(`batchId: ${result.batchId}`)
  console.log(`batchDir: ${result.batchDir}`)
  console.log(`page concurrency: ${result.scheduler?.pageConcurrency || 2} (${formatSchedulerSource(result.schedulerDiagnostics?.sources?.pageConcurrency)})`)
  console.log(`model concurrency: ${result.scheduler?.modelConcurrency || 5} (${formatSchedulerSource(result.schedulerDiagnostics?.sources?.modelConcurrency)})`)
  if (result.schedulerRuntime?.actual) {
    const modelActual = result.schedulerRuntime.actual.modelConcurrencyObserved
      ? result.schedulerRuntime.actual.modelConcurrency
      : 'not-observed'
    console.log(`actual peak concurrency: pages=${result.schedulerRuntime.actual.pageConcurrency}, models=${modelActual}`)
  }
  for (const warning of result.schedulerDiagnostics?.warnings || []) console.log(`scheduler warning [${warning.code}]: ${warning.message}`)
  for (const page of result.pages) {
    const icon = page.status === 'done' ? '✓' : page.status === 'error' ? '✗' : page.status === 'running' || page.status === 'retrying' ? '…' : '○'
    const representative = page.representative ? ' [quality-gate]' : ''
    console.log(`${icon} ${page.route}${representative}  ${page.htmlPath || page.error || page.status}`)
  }
  if (result.qualityGate?.status === 'awaiting-approval') {
    console.log('')
    console.log('代表页面已生成，请对照 frame screenshot 完成视觉质量检查。')
    console.log(`通过: ${result.resumeCommand}`)
    console.log(`不通过并重跑代表页: ${result.retryQualityCommand}`)
  }
  if (result.pause) {
    console.log('')
    console.log(`批次已自动暂停: ${result.pause.category} - ${result.pause.message}`)
    console.log(result.resumeCommand)
  }
  if (result.mergePrepareCommand && result.status === 'done') {
    console.log('')
    console.log('React merge preparation:')
    console.log(result.mergePrepareCommand)
  }
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

function printMcpTools(tools) {
  if (!tools.length) {
    console.log('MasterGo MCP 没有返回可用工具。')
    return
  }
  console.log('MasterGo MCP tools')
  for (const tool of tools) {
    console.log(`${tool.name}${tool.description ? ` - ${tool.description}` : ''}`)
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
  const warnings = collectJobWarnings(job)
  if (warnings.length > 0) {
    console.log(`校验预警 / Validation warnings: ${warnings.length}`)
    for (const warning of warnings) console.log(`- ${warning}`)
  }
  if (job.inputPath) console.log(`输入 / Input: ${job.inputPath}`)
  if (job.outputDir) console.log(`输出 / Output: ${job.outputDir}`)
  if (job.resultSummary?.zipPath) console.log(`压缩包 / ZIP: ${job.resultSummary.zipPath}`)
  if (job.error) console.log(`错误 / Error: ${job.error}`)
}

function collectJobWarnings(job) {
  return [...new Set((job.phaseDetails || [])
    .flatMap((phase) => Array.isArray(phase.warnings) ? phase.warnings : [])
    .filter(Boolean))]
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

  info(message) {
    const line = `[mastergo] ${message}\n`
    if (this.json) process.stderr.write(line)
    else process.stdout.write(line)
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
