import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_JOB_ROOT } from './constants.js'
import { buildAgentConstraintPack, buildConstraintManifest } from './constraint-service.js'
import { prepareInput, readInputMetadata } from './input.js'
import { renderHtmlPrototype } from './html-prototype.js'
import {
  buildAgentGenerationPlaybook,
  buildRoleGuidanceManifest,
} from './role-guidance.js'
import {
  copyDirectory,
  publishDirectory,
  readHtmlFiles,
  smokeTestDirectory,
  validateHtmlFirstPass,
  writeHtmlFiles,
} from './html-validation.js'
import { packageDirectory, packageOutputDirectory } from './output-zip.js'
import { runRawLayoutConversion } from './raw-layout-conversion.js'
import { runResponsiveRuntimeValidation } from './responsive-runtime-validation.js'
import { captureAndCompare } from './visual-report.js'

export const AGENT_V2_PROTOCOL_VERSION = 'mastergo2html.codex-agent.v2'
export const LAYOUT_SKETCH_VERSION = 'mastergo2html.layout-sketch.v1'
const REQUIRED_DRAFT_FILES = ['index.html', 'styles.css', 'script.js']

export async function prepareAgentJobV2(inputPath, options = {}) {
  const prepareStartedMs = Date.now()
  const createdAt = new Date(prepareStartedMs).toISOString()
  const jobId = options.jobId || randomUUID()
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const jobDir = join(jobRoot, jobId)
  mkdirSync(jobDir, { recursive: true })
  writeJsonAtomic(join(jobDir, 'job.json'), {
    version: AGENT_V2_PROTOCOL_VERSION,
    jobId,
    mode: 'codex-agent',
    status: 'preparing',
    agentStage: 'preparing',
    createdAt,
    updatedAt: createdAt,
    timings: emptyTimings(),
  })
  options.onJobStart?.({ jobId, jobDir, jobRoot, mode: 'codex-agent', version: AGENT_V2_PROTOCOL_VERSION })
  options.onProgress?.({ phase: 'agent-prepare', percent: 5, message: 'Preparing deterministic HTML prototype' })

  try {
    const inputDir = prepareInput(inputPath, jobDir)
    const metadata = readInputMetadata(inputDir)
    const inputHash = hashDirectory(inputDir)
    const conversion = await runRawLayoutConversion(jobId, jobDir, {
      allowFontDownloads: false,
      fetchFn: async () => { throw new Error('Agent v2 must not access the network') },
      env: { ...process.env, FONT_DOWNLOAD_ENABLED: 'false' },
    })
    const normalizedRaw = readJson(join(jobDir, '01-normalized', 'raw.normalized.json'))
    if ((normalizedRaw.nodes || []).length !== 1) throw new Error('Agent v2 currently supports exactly one Frame')
    const pageLayout = readJson(join(jobDir, '02-layout', 'page-layout.json'))
    const assetIndex = readJson(join(jobDir, '01-normalized', 'asset-index.json'))
    const nodeStyleFacts = readJson(join(jobDir, '01-normalized', 'node-style-facts.json'))
    const sourceTexts = readJson(join(jobDir, '01-normalized', 'source-texts.json'))
    const fontAssets = readJson(join(jobDir, '01-normalized', 'font-assets.json'))
    const layoutSketch = buildLayoutSketch(pageLayout, normalizedRaw)
    const layoutSketchPath = join(jobDir, '02-layout', 'layout-sketch.json')
    writeJsonAtomic(layoutSketchPath, layoutSketch)

    const rendered = renderHtmlPrototype({
      normalizedRaw,
      layoutSketch,
      assetIndex,
      nodeStyleFacts,
      sourceTexts,
      fontAssets,
      inputHash,
    })
    const agentDir = join(jobDir, 'agent')
    const prototypeSourceDir = join(agentDir, 'prototype-source')
    const draftDir = join(agentDir, 'draft')
    writeHtmlFiles(prototypeSourceDir, rendered.files)
    writeHtmlFiles(draftDir, rendered.files)
    copyIndexedAssets(inputDir, draftDir, assetIndex, fontAssets)

    const prototypeValidation = validateHtmlFirstPass(rendered.files, {
      sourceTexts,
      assetIndex,
      fontAssets,
      nodeStyleFacts,
      draftDir,
    })
    const prototypeValidationPath = join(agentDir, 'prototype-validation.json')
    writeJsonAtomic(prototypeValidationPath, prototypeValidation)
    if (!prototypeValidation.ok) {
      throw new Error(`Deterministic HTML prototype failed baseline validation: ${prototypeValidation.errors.join('; ')}`)
    }

    const target = resolveTarget(inputDir)
    const constraintPack = buildAgentConstraintPack({ target })
    const constraintManifest = buildConstraintManifest({ target })
    const constraintPackPath = join(agentDir, 'constraint-pack.md')
    const constraintManifestPath = join(agentDir, 'constraint-manifest.json')
    writeFileSync(constraintPackPath, constraintPack, 'utf8')
    writeJsonAtomic(constraintManifestPath, constraintManifest)
    const playbook = buildAgentGenerationPlaybook({ target })
    const playbookManifest = buildRoleGuidanceManifest({ target })
    const playbookPath = join(agentDir, 'agent-generation-playbook.md')
    writeFileSync(playbookPath, playbook, 'utf8')
    const prototypeManifestPath = join(agentDir, 'prototype-manifest.json')
    writeJsonAtomic(prototypeManifestPath, {
      ...rendered.prototypeManifest,
      generatedAt: new Date().toISOString(),
      sourceFiles: REQUIRED_DRAFT_FILES.map((file) => `agent/prototype-source/${file}`),
    })
    const generationBriefPath = join(agentDir, 'generation-brief.md')
    writeFileSync(generationBriefPath, buildGenerationBrief(jobId, layoutSketch, rendered.prototypeManifest), 'utf8')
    const contextIndex = buildV2ContextIndex(jobDir)
    const contextIndexPath = join(agentDir, 'context-index.json')
    writeJsonAtomic(contextIndexPath, contextIndex)

    const root = normalizedRaw.nodes[0]
    const rootBounds = root.relativeBounds || root.bounds || {}
    const captureFn = options.captureFn || captureAndCompare
    const prototypeVisual = await captureFn({
      outputDir: draftDir,
      referencePath: join(inputDir, 'frame-screenshot.png'),
      reportDir: join(agentDir, 'prototype-review'),
      width: rootBounds.width,
      height: rootBounds.height,
      label: 'prototype',
    })
    const awaitingAtMs = Date.now()
    const timings = computeTimings({ createdAtMs: prepareStartedMs, prepareMs: awaitingAtMs - prepareStartedMs })
    const manifest = {
      version: AGENT_V2_PROTOCOL_VERSION,
      jobId,
      stage: 'generation',
      status: 'awaiting-agent',
      inputHash,
      constraintPackVersion: constraintManifest.version,
      constraintPackHash: constraintManifest.constraintPackHash,
      playbookVersion: playbookManifest.version,
      playbookHash: playbookManifest.sha256,
      playbookPath: 'agent/agent-generation-playbook.md',
      createdAt,
      updatedAt: new Date(awaitingAtMs).toISOString(),
      awaitingAgentAt: new Date(awaitingAtMs).toISOString(),
      allowedReads: contextIndex.files.map((file) => file.path),
      allowedWrites: REQUIRED_DRAFT_FILES.map((file) => `agent/draft/${file}`),
      requiredArtifacts: REQUIRED_DRAFT_FILES.map((file) => `agent/draft/${file}`),
      nextCommand: `npm run --silent cli -- agent-begin ${jobId} --json`,
      timings,
    }
    const manifestPath = join(agentDir, 'manifest.json')
    writeJsonAtomic(manifestPath, manifest)
    const job = {
      version: AGENT_V2_PROTOCOL_VERSION,
      jobId,
      mode: 'codex-agent',
      status: 'awaiting-agent',
      agentStage: 'generation',
      source: metadata.source,
      inputPath: inputDir,
      inputHash,
      createdAt,
      awaitingAgentAt: manifest.awaitingAgentAt,
      updatedAt: manifest.updatedAt,
      progress: { phase: 'agent-generation', percent: 55, message: 'HTML prototype is ready for the current Agent' },
      timings,
      manifestPath,
      contextIndexPath,
      constraintPackPath,
      constraintManifestPath,
      playbookVersion: playbookManifest.version,
      playbookHash: playbookManifest.sha256,
      playbookPath,
      generationBriefPath,
      prototypeManifestPath,
      prototypeValidationPath,
      prototypeSourceDir,
      draftDir,
      layoutSketchPath,
      prototypeVisualReportPath: prototypeVisual.reportPath,
      phaseDetails: [
        phase('collect-input', 'done', 'Input copied and validated', [inputDir]),
        phase('normalize-raw', 'done', `Normalized ${conversion.summary.nodeCount} nodes and ${conversion.summary.assetCount} assets`, [conversion.normalizedDir, layoutSketchPath]),
        phase('render-prototype', 'done', `Rendered ${rendered.prototypeManifest.renderedNodeCount} nodes and passed baseline validation`, [prototypeSourceDir, prototypeManifestPath, prototypeValidationPath]),
        phase('agent-generation', 'awaiting-agent', 'Waiting for the current Agent to review the playbook and edit the draft', [draftDir, generationBriefPath, playbookPath]),
      ],
    }
    writeJsonAtomic(join(jobDir, 'job.json'), job)
    options.onProgress?.(job.progress)
    return { ...job, jobDir }
  } catch (error) {
    const failedAt = Date.now()
    const failed = {
      ...readJson(join(jobDir, 'job.json')),
      status: 'error',
      agentStage: 'preparing',
      error: error.message,
      updatedAt: new Date(failedAt).toISOString(),
      timings: computeTimings({ createdAtMs: prepareStartedMs, prepareMs: failedAt - prepareStartedMs }),
    }
    writeJsonAtomic(join(jobDir, 'job.json'), failed)
    throw error
  }
}

export function beginAgentJobV2(jobId, options = {}) {
  const { jobDir, job } = readV2Job(jobId, options)
  assertV2(job)
  if (!['awaiting-agent', 'validating', 'done', 'first-pass-invalid'].includes(job.status)) throw new Error(`Agent cannot begin from state ${job.status}`)
  if (job.agentStartedAt) return { ok: true, idempotent: true, agentStartedAt: job.agentStartedAt, job }
  const nowMs = Date.now()
  const agentStartedAt = new Date(nowMs).toISOString()
  const timings = computeTimings({
    ...timingInputs(job),
    agentStartedAtMs: nowMs,
    handoffWaitMs: Math.max(0, nowMs - Date.parse(job.awaitingAgentAt || job.updatedAt)),
  })
  const updated = updateV2Job(jobDir, job, { agentStartedAt, timings })
  const manifest = readJson(join(jobDir, 'agent', 'manifest.json'))
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), {
    ...manifest,
    agentStartedAt,
    updatedAt: agentStartedAt,
    nextCommand: `npm run --silent cli -- agent-finalize ${jobId} --json`,
    timings,
  })
  return { ok: true, idempotent: false, agentStartedAt, job: updated }
}

export async function finalizeAgentJobV2(jobId, options = {}) {
  const finalizeStartedMs = Date.now()
  let { jobDir, job } = readV2Job(jobId, options)
  assertV2(job)
  if (['done', 'first-pass-invalid'].includes(job.status)) return readCompletedResult(jobDir, job)
  if (job.status !== 'awaiting-agent') throw new Error(`Agent v2 cannot finalize from state ${job.status}`)
  assertInputUnchanged(jobDir, job.inputHash)
  if (!job.agentStartedAt) job = beginAgentJobV2(jobId, options).job
  const agentFinishedAt = new Date(finalizeStartedMs).toISOString()
  job = updateV2Job(jobDir, job, {
    status: 'validating',
    agentStage: 'validating',
    agentFinishedAt,
    progress: { phase: 'agent-validation', percent: 80, message: 'Validating the first Agent result' },
  })

  const draftDir = join(jobDir, 'agent', 'draft')
  const firstPassDir = join(jobDir, '05-first-pass')
  if (existsSync(draftDir)) copyDirectory(draftDir, firstPassDir)
  else {
    rmSync(firstPassDir, { recursive: true, force: true })
    mkdirSync(firstPassDir, { recursive: true })
  }
  let files
  let validation
  try {
    files = readHtmlFiles(firstPassDir)
    validation = validateHtmlFirstPass(files, {
      sourceTexts: readJson(join(jobDir, '01-normalized', 'source-texts.json')),
      assetIndex: readJson(join(jobDir, '01-normalized', 'asset-index.json')),
      fontAssets: readJson(join(jobDir, '01-normalized', 'font-assets.json')),
      nodeStyleFacts: readJson(join(jobDir, '01-normalized', 'node-style-facts.json')),
      draftDir: firstPassDir,
      agentQuality: buildAgentQualityRequirements(
        readJson(join(jobDir, '02-layout', 'layout-sketch.json')),
        readJson(join(jobDir, 'agent', 'prototype-manifest.json')),
      ),
    })
  } catch (error) {
    validation = {
      version: 'mastergo2html.first-pass-validation.v1',
      ok: false,
      errors: [error.message],
      warnings: [],
      checkedAt: new Date().toISOString(),
      transport: { mode: 'direct-files', jsonEnvelopeParsed: false },
    }
  }

  const smokeTestFn = options.smokeTestFn || smokeTestDirectory
  try {
    await smokeTestFn(firstPassDir)
    validation.smoke = { status: 'passed', ok: true }
  } catch (error) {
    validation.errors.push(`Runtime smoke test failed: ${error.message}`)
    validation.ok = false
    validation.smoke = { status: 'failed', ok: false, error: error.message }
  }
  const layoutSketch = readJson(join(jobDir, '02-layout', 'layout-sketch.json'))
  const runtimeFn = options.responsiveRuntimeTestFn || runResponsiveRuntimeValidation
  try {
    validation.responsiveRuntime = await runtimeFn({ outputDir: firstPassDir, contract: layoutSketch.responsiveContract })
  } catch (error) {
    validation.responsiveRuntime = { status: 'skipped', ok: true, blocking: false, warnings: [`Runtime inspection failed: ${error.message}`] }
  }
  const root = readJson(join(jobDir, '01-normalized', 'raw.normalized.json')).nodes?.[0]
  const rootBounds = root?.relativeBounds || root?.bounds || {}
  const captureFn = options.captureFn || captureAndCompare
  const visual = await captureFn({
    outputDir: firstPassDir,
    referencePath: join(jobDir, '00-input', 'frame-screenshot.png'),
    reportDir: join(firstPassDir, 'review'),
    width: rootBounds.width,
    height: rootBounds.height,
    label: 'first-pass',
  })
  validation.visual = visual
  validation.warnings = [...new Set([...(validation.warnings || []), ...(validation.responsiveRuntime?.warnings || []), ...(visual.warnings || [])])]
  writeJsonAtomic(join(firstPassDir, 'static-validation.json'), validation)
  writeJsonAtomic(join(jobDir, 'agent', 'validation.json'), validation)

  const firstPassZipPath = join(jobDir, 'final', 'first-pass.zip')
  const firstPassPackage = packageDirectory(firstPassDir, firstPassZipPath)
  const agentMs = Math.max(0, finalizeStartedMs - Date.parse(job.agentStartedAt))
  let status = 'first-pass-invalid'
  let outputDir = null
  let outputZipPath = null
  let outputPackage = null
  if (validation.ok) {
    outputDir = join(jobDir, '05-output')
    publishDirectory(firstPassDir, outputDir)
    outputZipPath = join(jobDir, 'final', 'output.zip')
    outputPackage = packageOutputDirectory(outputDir, outputZipPath)
    status = 'done'
  }
  const completedMs = Date.now()
  const finalizeMs = Math.max(0, completedMs - finalizeStartedMs)
  const timings = computeTimings({ ...timingInputs(job), agentMs, finalizeMs, completedAtMs: completedMs })
  const completedAt = new Date(completedMs).toISOString()
  const resultSummary = {
    firstPassDir,
    firstPassZipPath,
    firstPassZipSizeBytes: firstPassPackage.sizeBytes,
    outputDir,
    outputZipPath,
    outputZipSizeBytes: outputPackage?.sizeBytes || null,
    validationPath: join(firstPassDir, 'static-validation.json'),
    visualReportPath: visual.reportPath,
  }
  const finalJob = updateV2Job(jobDir, job, {
    status,
    agentStage: status,
    completedAt,
    outputDir,
    outputPath: outputDir,
    firstPassDir,
    timings,
    validationPath: resultSummary.validationPath,
    resultSummary,
    progress: { phase: 'agent-validation', percent: 100, message: validation.ok ? 'First Agent result passed validation' : 'First Agent result was preserved but did not pass validation' },
    phaseDetails: [
      ...(job.phaseDetails || []).filter((item) => item.phase !== 'agent-generation' && item.phase !== 'agent-validation'),
      phase('agent-generation', 'done', 'The current Agent edited the prototype once', REQUIRED_DRAFT_FILES.map((file) => join(draftDir, file))),
      phase('agent-validation', status, validation.ok ? 'First pass validated and published' : 'First pass preserved without repair', [firstPassDir, firstPassZipPath]),
    ],
  })
  const manifest = readJson(join(jobDir, 'agent', 'manifest.json'))
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), {
    ...manifest,
    stage: status,
    status,
    updatedAt: completedAt,
    completedAt,
    nextCommand: null,
    timings,
  })
  return { ok: validation.ok, status, job: finalJob, validation, firstPassDir, firstPassZipPath, outputDir, zipPath: outputZipPath }
}

function buildAgentQualityRequirements(layoutSketch, prototypeManifest) {
  return {
    semanticNavigationRequired: (prototypeManifest?.degradations || []).some((item) => item?.reason === 'semantic-navigation-reconstruction-required'),
    responsiveRequired: Boolean(layoutSketch?.responsiveContract),
  }
}

export function getAgentJobStatusV2(jobId, options = {}) {
  const { jobDir, job } = readV2Job(jobId, options)
  return { ok: true, jobDir, job, manifest: readJson(join(jobDir, 'agent', 'manifest.json')) }
}

export function inspectAgentJobV2(jobId, query = {}, options = {}) {
  const { jobDir } = readV2Job(jobId, options)
  if (query.issues) return { kind: 'issues', path: join(jobDir, 'agent', 'validation.json'), value: readJson(join(jobDir, 'agent', 'validation.json')) }
  if (query.moduleId) {
    const value = (readJson(join(jobDir, '02-layout', 'layout-sketch.json')).modules || []).find((item) => String(item?.moduleId) === String(query.moduleId))
    if (!value) throw new Error(`Cannot find moduleId: ${query.moduleId}`)
    return { kind: 'module', value }
  }
  if (query.assetId) return findIndexed(jobDir, '01-normalized/asset-index.json', 'assets', query.assetId, 'assetId', 'asset')
  if (query.nodeId) {
    const normalized = readJson(join(jobDir, '01-normalized', 'raw.normalized.json'))
    const value = flatten(normalized.nodes || []).find((node) => String(node.sourceNodeId || node.id) === String(query.nodeId))
    if (!value) throw new Error(`Cannot find sourceNodeId: ${query.nodeId}`)
    return { kind: 'node', value }
  }
  return getAgentJobStatusV2(jobId, options)
}

function buildLayoutSketch(pageLayout, normalizedRaw) {
  const root = normalizedRaw.nodes?.[0]
  const bounds = root?.relativeBounds || root?.bounds || null
  return {
    version: LAYOUT_SKETCH_VERSION,
    sourcePageLayoutVersion: pageLayout?.version || null,
    page: pageLayout?.page || { name: root?.name || '', bounds },
    rootFrame: { sourceNodeId: root?.sourceNodeId || root?.id || null, name: root?.name || '', bounds },
    strategy: 'source-coordinate-absolute-draft',
    modules: pageLayout?.modules || [],
    stackingFacts: pageLayout?.stackingFacts || [],
    responsiveContract: pageLayout?.responsiveContract || null,
    warnings: [...new Set([...(normalizedRaw?.warnings || []).map((item) => item?.message || String(item)), ...(pageLayout?.warnings || []).map((item) => item?.message || String(item))])],
  }
}

function buildGenerationBrief(jobId, layoutSketch, prototypeManifest) {
  return `# Agent v2 generation brief

Job: ${jobId}

Edit the existing prototype. Do not rebuild the page from empty files.

## Required workflow

1. Run \`agent-begin ${jobId} --json\` before editing so Agent time is measured separately from handoff wait time.
2. Read \`agent/agent-generation-playbook.md\`, \`agent/constraint-pack.md\`, \`02-layout/layout-sketch.json\`, \`agent/prototype-manifest.json\`, \`agent/prototype-validation.json\`, \`00-input/frame-screenshot.png\`, and \`01-normalized/source-texts.json\`.
3. Treat the draft as the implementation starting point, the playbook as the review/planning method, the constraint pack as the only normative page constraint source, and indexed facts as on-demand decision evidence.
4. Inspect layout warnings and low-confidence/degraded regions, then internally perform component, asset, interaction, and assembly review before editing.
5. Apply the resulting semantic, layout, typography, asset, interaction, and conservative responsive decisions directly to the draft. Do not output intermediate plans or reasoning.
6. Preserve every \`data-source-node-id\`, \`data-text-source-node-id\`, \`data-style-source-node-id\`, and \`data-asset-id\` binding that represents source content.
7. Do not modify fact files, \`prototype-source/\`, or \`draft/assets/\`.
8. Only edit \`agent/draft/index.html\`, \`styles.css\`, and \`script.js\`.
9. Run \`agent-finalize ${jobId} --json\` once. Do not enter a repair loop.

## Prototype facts

- Root: ${layoutSketch.rootFrame?.name || 'unknown'} (${layoutSketch.rootFrame?.bounds?.width || '?'} x ${layoutSketch.rootFrame?.bounds?.height || '?'})
- Rendered nodes: ${prototypeManifest.renderedNodeCount}/${prototypeManifest.nodeCount}
- Composite replacements: ${prototypeManifest.compositeReplacementCount}
- Warnings: ${(prototypeManifest.warnings || []).length + (layoutSketch.warnings || []).length}
`
}

function buildV2ContextIndex(jobDir) {
  const candidates = [
    ['agent/generation-brief.md', 'workflow', 'always'],
    ['agent/agent-generation-playbook.md', 'generation-method', 'always'],
    ['agent/constraint-pack.md', 'constraints', 'always'],
    ['agent/prototype-manifest.json', 'prototype-quality', 'always'],
    ['agent/prototype-validation.json', 'prototype-baseline-validation', 'always'],
    ['02-layout/layout-sketch.json', 'layout', 'always'],
    ['00-input/frame-screenshot.png', 'visual-reference', 'always'],
    ['01-normalized/source-texts.json', 'immutable-text', 'always'],
    ['01-normalized/node-style-facts.json', 'style-facts', 'on-demand'],
    ['01-normalized/asset-index.json', 'asset-facts', 'on-demand'],
    ['01-normalized/font-assets.json', 'font-facts', 'on-demand'],
    ['01-normalized/raw.normalized.json', 'node-facts', 'on-demand'],
  ]
  return {
    version: AGENT_V2_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    policy: 'Start from the existing draft and use facts on demand. Do not rewrite fact or prototype-source files.',
    files: candidates.filter(([path]) => existsSync(join(jobDir, path))).map(([path, purpose, priority]) => ({
      path,
      purpose,
      priority,
      sizeBytes: statSync(join(jobDir, path)).size,
      sha256: hashFile(join(jobDir, path)),
    })),
  }
}

function copyIndexedAssets(inputDir, draftDir, assetIndex, fontAssets) {
  const paths = new Set(fontAssets?.files || [])
  for (const asset of assetIndex?.assets || []) {
    if (['review-only', 'forbidden-final'].includes(asset?.renderPolicy)) continue
    for (const path of [asset?.preferred?.copiedPath, asset?.copiedPath, ...(asset?.rendered || []).map((item) => item?.path)].filter(Boolean)) paths.add(path)
  }
  for (const path of [...paths].sort()) {
    if (!String(path).startsWith('assets/')) continue
    const source = join(inputDir, path)
    const target = join(draftDir, path)
    if (!existsSync(source) || !statSync(source).isFile()) continue
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
  }
}

function resolveTarget(inputDir) {
  const path = join(inputDir, 'export-options.json')
  const value = existsSync(path) ? readJson(path) : {}
  return value?.exportOptions?.targetPlatform === 'app' || value?.targetPlatform === 'app' ? 'app' : 'web'
}

function readV2Job(jobId, options = {}) {
  const jobDir = join(resolve(options.jobRoot || DEFAULT_JOB_ROOT), jobId)
  return { jobDir, job: readJson(join(jobDir, 'job.json')) }
}

function assertV2(job) {
  if (job?.version !== AGENT_V2_PROTOCOL_VERSION) throw new Error(`Job is not Agent v2: ${job?.version || 'v1/legacy'}`)
}

function assertInputUnchanged(jobDir, expectedHash) {
  if (hashDirectory(join(jobDir, '00-input')) !== expectedHash) throw new Error('00-input changed after Agent preparation')
}

function updateV2Job(jobDir, job, patch) {
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() }
  writeJsonAtomic(join(jobDir, 'job.json'), updated)
  return updated
}

function readCompletedResult(jobDir, job) {
  const validation = readJson(join(jobDir, 'agent', 'validation.json'))
  return {
    ok: validation.ok,
    status: job.status,
    idempotent: true,
    job,
    validation,
    firstPassDir: job.firstPassDir,
    firstPassZipPath: job.resultSummary?.firstPassZipPath,
    outputDir: job.outputDir,
    zipPath: job.resultSummary?.outputZipPath,
  }
}

function timingInputs(job) {
  return {
    createdAtMs: Date.parse(job.createdAt),
    prepareMs: Number(job.timings?.prepareMs || 0),
    handoffWaitMs: Number(job.timings?.handoffWaitMs || 0),
    agentMs: Number(job.timings?.agentMs || 0),
    finalizeMs: Number(job.timings?.finalizeMs || 0),
    agentStartedAtMs: job.agentStartedAt ? Date.parse(job.agentStartedAt) : null,
  }
}

function computeTimings({ createdAtMs, prepareMs = 0, handoffWaitMs = 0, agentMs = 0, finalizeMs = 0, completedAtMs = Date.now() }) {
  return {
    prepareMs: Math.max(0, Math.round(prepareMs)),
    handoffWaitMs: Math.max(0, Math.round(handoffWaitMs)),
    agentMs: Math.max(0, Math.round(agentMs)),
    finalizeMs: Math.max(0, Math.round(finalizeMs)),
    activeTotalMs: Math.max(0, Math.round(prepareMs + agentMs + finalizeMs)),
    jobWallMs: Math.max(0, Math.round(completedAtMs - createdAtMs)),
  }
}

function emptyTimings() {
  return { prepareMs: 0, handoffWaitMs: 0, agentMs: 0, finalizeMs: 0, activeTotalMs: 0, jobWallMs: 0 }
}

function phase(name, status, message, artifacts) {
  return { phase: name, status, message, artifacts, tokenUsage: { source: 'deterministic-or-current-agent', available: false } }
}

function findIndexed(jobDir, path, collection, id, key, kind) {
  const value = (readJson(join(jobDir, path))?.[collection] || []).find((item) => String(item?.[key]) === String(id))
  if (!value) throw new Error(`Cannot find ${key}: ${id}`)
  return { kind, value }
}

function flatten(nodes) {
  const result = []
  const visit = (node) => { if (node) { result.push(node); for (const child of node.children || []) visit(child) } }
  for (const node of nodes) visit(node)
  return result
}

function hashDirectory(directory) {
  const hash = createHash('sha256')
  for (const file of collectFiles(directory)) {
    hash.update(file); hash.update('\0'); hash.update(readFileSync(join(directory, file))); hash.update('\0')
  }
  return hash.digest('hex')
}

function collectFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
  }
  return files.sort()
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`Missing JSON file: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}
