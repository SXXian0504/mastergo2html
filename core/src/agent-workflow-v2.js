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
import { prepareResponsivePage } from './responsive-page.js'

export const AGENT_V2_PROTOCOL_VERSION = 'mastergo2html.codex-agent.v2'
export const LAYOUT_SKETCH_VERSION = 'mastergo2html.layout-sketch.v2'
const REQUIRED_DRAFT_FILES = ['index.html', 'styles.css', 'script.js']

export async function prepareResponsiveAgentJobV2(inputPath, options = {}) {
  const jobId = options.jobId || randomUUID()
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const workspace = join(jobRoot, `.responsive-prepare-${jobId}`)
  let prepared
  try {
    prepared = prepareResponsivePage(inputPath, workspace)
    const job = await prepareAgentJobV2(prepared.variants.desktop.inputPath, { ...options, jobId })
    const jobDir = job.jobDir
    const desktopVariantDir = join(jobDir, 'variants', 'desktop')
    const mobileVariantDir = join(jobDir, 'variants', 'mobile')
    copyDirectory(join(jobDir, '00-input'), join(desktopVariantDir, '00-input'))
    copyDirectory(join(jobDir, '01-normalized'), join(desktopVariantDir, '01-normalized'))
    copyDirectory(join(jobDir, '02-layout'), join(desktopVariantDir, '02-layout'))
    copyDirectory(prepared.variants.mobile.inputPath, join(mobileVariantDir, '00-input'))
    writeJsonAtomic(join(jobDir, 'responsive-manifest.json'), prepared.manifest)

    const conversion = await runRawLayoutConversion(jobId, mobileVariantDir, {
      allowFontDownloads: false,
      fetchFn: async () => { throw new Error('Responsive Agent preparation must not access the network') },
      env: { ...process.env, FONT_DOWNLOAD_ENABLED: 'false' },
    })
    const mobileFacts = readVariantFacts(mobileVariantDir)
    if ((mobileFacts.normalizedRaw.nodes || []).length !== 1) throw new Error('Responsive Agent mobile variant must contain exactly one Frame')
    const mobileLayoutSketch = buildLayoutSketch(mobileFacts.pageLayout, mobileFacts.normalizedRaw)
    writeJsonAtomic(join(mobileVariantDir, '02-layout', 'layout-sketch.json'), mobileLayoutSketch)
    const mobileRendered = renderHtmlPrototype({
      ...mobileFacts,
      layoutSketch: mobileLayoutSketch,
      inputHash: hashDirectory(join(mobileVariantDir, '00-input')),
    })
    const mobilePrototypeDir = join(jobDir, 'agent', 'reference-prototypes', 'mobile')
    writeHtmlFiles(mobilePrototypeDir, mobileRendered.files)
    copyIndexedAssets(join(mobileVariantDir, '00-input'), mobilePrototypeDir, mobileFacts.assetIndex, mobileFacts.fontAssets)
    const mobilePrototypeValidation = validateHtmlFirstPass(mobileRendered.files, {
      sourceTexts: mobileFacts.sourceTexts,
      assetIndex: mobileFacts.assetIndex,
      fontAssets: mobileFacts.fontAssets,
      nodeStyleFacts: mobileFacts.nodeStyleFacts,
      draftDir: mobilePrototypeDir,
      agentQuality: buildGlobalDecorationQualityRequirements(mobileLayoutSketch),
    })
    const mobilePrototypeValidationPath = join(jobDir, 'agent', 'mobile-prototype-validation.json')
    writeJsonAtomic(mobilePrototypeValidationPath, mobilePrototypeValidation)
    if (!mobilePrototypeValidation.ok) {
      throw new Error(`Mobile deterministic prototype failed baseline validation: ${mobilePrototypeValidation.errors.join('; ')}`)
    }

    const desktopFacts = readVariantFacts(desktopVariantDir)
    const responsiveContext = buildResponsiveContext(prepared.manifest, desktopFacts, mobileFacts)
    const responsiveContextPath = join(jobDir, 'agent', 'responsive-context.json')
    writeJsonAtomic(responsiveContextPath, responsiveContext)
    const canonicalSourceTexts = buildCanonicalSourceTexts(desktopFacts.sourceTexts, mobileFacts.sourceTexts, responsiveContext)
    const canonicalSourceTextsPath = join(jobDir, 'agent', 'canonical-source-texts.json')
    writeJsonAtomic(canonicalSourceTextsPath, canonicalSourceTexts)
    const finalNodeStyleFacts = buildResponsiveNodeStyleFacts(desktopFacts.nodeStyleFacts, mobileFacts.nodeStyleFacts, responsiveContext)
    const finalNodeStyleFactsPath = join(jobDir, 'agent', 'final-node-style-facts.json')
    writeJsonAtomic(finalNodeStyleFactsPath, finalNodeStyleFacts)
    const finalAssetIndex = copyResponsiveMobileAssets({
      mobileInputDir: join(mobileVariantDir, '00-input'),
      draftDir: job.draftDir,
      desktopAssetIndex: desktopFacts.assetIndex,
      mobileAssetIndex: mobileFacts.assetIndex,
      responsiveContext,
    })
    const finalAssetIndexPath = join(jobDir, 'agent', 'final-asset-index.json')
    writeJsonAtomic(finalAssetIndexPath, finalAssetIndex)
    const finalFontAssets = copyResponsiveMobileFonts({
      mobileInputDir: join(mobileVariantDir, '00-input'),
      draftDir: job.draftDir,
      desktopFontAssets: desktopFacts.fontAssets,
      mobileFontAssets: mobileFacts.fontAssets,
    })
    const finalFontAssetsPath = join(jobDir, 'agent', 'final-font-assets.json')
    writeJsonAtomic(finalFontAssetsPath, finalFontAssets)

    const captureFn = options.captureFn || captureAndCompare
    const mobileBounds = mobileFacts.normalizedRaw.nodes[0]?.relativeBounds || mobileFacts.normalizedRaw.nodes[0]?.bounds || {}
    const mobileVisual = await captureFn({
      outputDir: mobilePrototypeDir,
      referencePath: join(mobileVariantDir, '00-input', 'frame-screenshot.png'),
      reportDir: join(jobDir, 'agent', 'prototype-review', 'mobile'),
      width: mobileBounds.width,
      height: mobileBounds.height,
      label: 'mobile-prototype',
    })

    const generationBriefPath = join(jobDir, 'agent', 'generation-brief.md')
    const desktopSketch = readJson(join(jobDir, '02-layout', 'layout-sketch.json'))
    const prototypeManifest = readJson(join(jobDir, 'agent', 'prototype-manifest.json'))
    writeFileSync(generationBriefPath, buildGenerationBrief(jobId, desktopSketch, prototypeManifest, responsiveContext), 'utf8')
    const contextIndex = buildV2ContextIndex(jobDir, { responsive: true })
    const contextIndexPath = join(jobDir, 'agent', 'context-index.json')
    writeJsonAtomic(contextIndexPath, contextIndex)
    const currentJob = readJson(join(jobDir, 'job.json'))
    const manifest = readJson(join(jobDir, 'agent', 'manifest.json'))
    writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), {
      ...manifest,
      inputKind: 'responsive-page',
      allowedReads: contextIndex.files.map((file) => file.path),
    })
    const updatedJob = {
      ...currentJob,
      inputKind: 'responsive-page',
      source: {
        ...(prepared.manifest.source || {}),
        selectionIds: [prepared.manifest.variants.desktop.sourceNodeId, prepared.manifest.variants.mobile.sourceNodeId],
        selectionCount: 2,
      },
      responsiveManifestPath: join(jobDir, 'responsive-manifest.json'),
      responsiveContextPath,
      canonicalSourceTextsPath,
      finalNodeStyleFactsPath,
      finalAssetIndexPath,
      finalFontAssetsPath,
      mobilePrototypeValidationPath,
      mobilePrototypeVisualReportPath: mobileVisual.reportPath,
      responsiveInputHash: hashDirectory(join(jobDir, 'variants')),
      phaseDetails: [
        ...(currentJob.phaseDetails || []).filter((item) => item.phase !== 'normalize-responsive' && item.phase !== 'render-responsive-prototype'),
        phase('normalize-responsive', 'done', `Normalized desktop and mobile variants (${conversion.summary.nodeCount} mobile nodes)`, [desktopVariantDir, mobileVariantDir, responsiveContextPath]),
        phase('render-responsive-prototype', 'done', 'Rendered and validated the read-only mobile reference prototype', [mobilePrototypeDir, mobilePrototypeValidationPath]),
      ],
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(join(jobDir, 'job.json'), updatedJob)
    return { ...updatedJob, jobDir }
  } catch (error) {
    const jobDir = join(jobRoot, jobId)
    if (existsSync(join(jobDir, 'job.json'))) {
      writeJsonAtomic(join(jobDir, 'job.json'), {
        ...readJson(join(jobDir, 'job.json')),
        status: 'error',
        agentStage: 'preparing-responsive',
        error: error.message,
        updatedAt: new Date().toISOString(),
      })
    }
    throw error
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

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
      agentQuality: buildGlobalDecorationQualityRequirements(layoutSketch),
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
  assertClaimId(job, options.claimId)
  if (!['awaiting-agent', 'agent-running', 'validating', 'done', 'first-pass-invalid'].includes(job.status)) throw new Error(`Agent cannot begin from state ${job.status}`)
  if (job.agentStartedAt) return { ok: true, idempotent: true, agentStartedAt: job.agentStartedAt, job }
  if (job.status !== 'awaiting-agent') throw new Error(`Agent cannot begin from state ${job.status}`)
  const nowMs = Date.now()
  const agentStartedAt = new Date(nowMs).toISOString()
  const timings = computeTimings({
    ...timingInputs(job),
    agentStartedAtMs: nowMs,
    handoffWaitMs: Math.max(0, nowMs - Date.parse(job.awaitingAgentAt || job.updatedAt)),
  })
  const updated = updateV2Job(jobDir, job, {
    status: 'agent-running',
    agentStage: 'generation',
    agentStartedAt,
    timings,
    progress: { phase: 'agent-generation', percent: 65, message: 'The Agent is editing the deterministic prototype' },
  })
  const manifest = readJson(join(jobDir, 'agent', 'manifest.json'))
  const claimArg = claimedId(job) ? ` --claim-id ${claimedId(job)}` : ''
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), {
    ...manifest,
    stage: 'generation',
    status: 'agent-running',
    agentStartedAt,
    updatedAt: agentStartedAt,
    nextCommand: `npm run --silent cli -- agent-finalize ${jobId}${claimArg} --json`,
    timings,
  })
  return { ok: true, idempotent: false, agentStartedAt, job: updated }
}

export async function finalizeAgentJobV2(jobId, options = {}) {
  const finalizeStartedMs = Date.now()
  let { jobDir, job } = readV2Job(jobId, options)
  assertV2(job)
  assertClaimId(job, options.claimId)
  if (['done', 'first-pass-invalid'].includes(job.status)) return readCompletedResult(jobDir, job)
  if (job.status === 'awaiting-agent' && !claimedId(job)) job = beginAgentJobV2(jobId, options).job
  if (!['agent-running', 'validating'].includes(job.status)) throw new Error(`Agent v2 cannot finalize from state ${job.status}`)
  assertInputUnchanged(jobDir, job.inputHash)
  if (job.inputKind === 'responsive-page' && job.responsiveInputHash && hashDirectory(join(jobDir, 'variants')) !== job.responsiveInputHash) {
    throw new Error('Responsive variant inputs changed after Agent preparation')
  }
  if (job.status === 'agent-running') {
    const agentFinishedAt = new Date(finalizeStartedMs).toISOString()
    job = updateV2Job(jobDir, job, {
      status: 'validating',
      agentStage: 'validating',
      agentFinishedAt,
      progress: { phase: 'agent-validation', percent: 80, message: 'Validating the first Agent result' },
    })
  }

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
    const responsivePage = job.inputKind === 'responsive-page'
    validation = validateHtmlFirstPass(files, {
      sourceTexts: readJson(responsivePage ? job.canonicalSourceTextsPath : join(jobDir, '01-normalized', 'source-texts.json')),
      assetIndex: readJson(responsivePage ? job.finalAssetIndexPath : join(jobDir, '01-normalized', 'asset-index.json')),
      fontAssets: readJson(responsivePage ? job.finalFontAssetsPath : join(jobDir, '01-normalized', 'font-assets.json')),
      nodeStyleFacts: readJson(responsivePage ? job.finalNodeStyleFactsPath : join(jobDir, '01-normalized', 'node-style-facts.json')),
      draftDir: firstPassDir,
      agentQuality: buildAgentQualityRequirements(
        readJson(join(jobDir, '02-layout', 'layout-sketch.json')),
        readJson(join(jobDir, 'agent', 'prototype-manifest.json')),
        responsivePage ? readJson(job.responsiveContextPath) : null,
        responsivePage ? readJson(job.finalAssetIndexPath) : null,
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
    const runtimeContract = job.inputKind === 'responsive-page'
      ? buildResponsiveRuntimeContract(layoutSketch.responsiveContract, readJson(job.responsiveManifestPath))
      : layoutSketch.responsiveContract
    validation.responsiveRuntime = await runtimeFn({ outputDir: firstPassDir, contract: runtimeContract })
    if (job.inputKind === 'responsive-page'
      && validation.responsiveRuntime?.status !== 'skipped'
      && validation.responsiveRuntime?.ok === false) {
      validation.errors.push(...(validation.responsiveRuntime.warnings || []).map((warning) => `Responsive runtime: ${warning}`))
      validation.ok = false
    }
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
  let variantVisuals = { desktop: visual }
  if (job.inputKind === 'responsive-page') {
    const mobileRoot = readJson(join(jobDir, 'variants', 'mobile', '01-normalized', 'raw.normalized.json')).nodes?.[0]
    const mobileBounds = mobileRoot?.relativeBounds || mobileRoot?.bounds || {}
    const mobileVisual = await captureFn({
      outputDir: firstPassDir,
      referencePath: join(jobDir, 'variants', 'mobile', '00-input', 'frame-screenshot.png'),
      reportDir: join(firstPassDir, 'review', 'mobile'),
      width: mobileBounds.width,
      height: mobileBounds.height,
      label: 'mobile-first-pass',
    })
    variantVisuals = { desktop: visual, mobile: mobileVisual }
    validation.variantVisuals = variantVisuals
  }
  validation.warnings = [...new Set([
    ...(validation.warnings || []),
    ...(validation.responsiveRuntime?.warnings || []),
    ...Object.values(variantVisuals).flatMap((report) => report?.warnings || []),
  ])]
  writeJsonAtomic(join(firstPassDir, 'static-validation.json'), validation)
  writeJsonAtomic(join(jobDir, 'agent', 'validation.json'), validation)

  const firstPassZipPath = join(jobDir, 'final', 'first-pass.zip')
  const firstPassPackage = packageDirectory(firstPassDir, firstPassZipPath)
  const agentFinishedMs = Date.parse(job.agentFinishedAt || new Date(finalizeStartedMs).toISOString())
  const agentMs = Math.max(0, agentFinishedMs - Date.parse(job.agentStartedAt))
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
    variantVisualReportPaths: Object.fromEntries(Object.entries(variantVisuals).map(([kind, report]) => [kind, report?.reportPath || null])),
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

export function resetAgentAttemptV2(jobId, options = {}) {
  const { jobDir, job } = readV2Job(jobId, options)
  assertV2(job)
  assertClaimId(job, options.claimId)
  if (!['agent-running', 'validating'].includes(job.status)) {
    throw new Error(`Agent attempt cannot reset from state ${job.status}`)
  }

  const prototypeSourceDir = join(jobDir, 'agent', 'prototype-source')
  const draftDir = join(jobDir, 'agent', 'draft')
  for (const file of REQUIRED_DRAFT_FILES) {
    const source = join(prototypeSourceDir, file)
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Prototype source is missing ${file}`)
  }
  mkdirSync(draftDir, { recursive: true })
  for (const file of REQUIRED_DRAFT_FILES) cpSync(join(prototypeSourceDir, file), join(draftDir, file))

  const resetAtMs = Date.now()
  const resetAt = new Date(resetAtMs).toISOString()
  const timings = computeTimings({
    ...timingInputs(job),
    agentMs: 0,
    finalizeMs: 0,
    completedAtMs: resetAtMs,
  })
  const updated = { ...job }
  for (const key of [
    'claim', 'claimId', 'agentStartedAt', 'agentFinishedAt', 'completedAt', 'error',
    'outputDir', 'outputPath', 'firstPassDir', 'validationPath', 'resultSummary',
  ]) delete updated[key]
  Object.assign(updated, {
    status: 'awaiting-agent',
    agentStage: 'generation',
    awaitingAgentAt: resetAt,
    updatedAt: resetAt,
    timings,
    lastAttemptFailure: {
      claimId: claimedId(job),
      reason: String(options.reason || 'Agent worker exited before finalize completed'),
      resetAt,
    },
    progress: { phase: 'agent-generation', percent: 55, message: 'Agent attempt reset; waiting for another worker' },
    phaseDetails: [
      ...(job.phaseDetails || []).filter((item) => item.phase !== 'agent-generation' && item.phase !== 'agent-validation'),
      phase('agent-generation', 'awaiting-agent', 'Previous Agent attempt was reset to the deterministic prototype', REQUIRED_DRAFT_FILES.map((file) => join(draftDir, file))),
    ],
  })
  writeJsonAtomic(join(jobDir, 'job.json'), updated)

  const manifestPath = join(jobDir, 'agent', 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath)
    const resetManifest = { ...manifest }
    for (const key of ['claim', 'claimId', 'agentStartedAt', 'agentFinishedAt', 'completedAt']) delete resetManifest[key]
    Object.assign(resetManifest, {
      stage: 'generation',
      status: 'awaiting-agent',
      updatedAt: resetAt,
      awaitingAgentAt: resetAt,
      nextCommand: `npm run --silent cli -- agent-begin ${jobId} --json`,
      timings,
    })
    writeJsonAtomic(manifestPath, resetManifest)
  }
  return { ok: true, status: updated.status, resetAt, restoredFiles: [...REQUIRED_DRAFT_FILES], job: updated }
}

function buildAgentQualityRequirements(layoutSketch, prototypeManifest, responsiveContext = null, finalAssetIndex = null) {
  return {
    semanticNavigationRequired: (prototypeManifest?.degradations || []).some((item) => item?.reason === 'semantic-navigation-reconstruction-required'),
    heroForegroundPromotions: prototypeManifest?.heroForegroundPromotions || [],
    globalDecorationIds: (layoutSketch?.globalDecorations || []).map((item) => String(item?.sourceNodeId || '')).filter(Boolean),
    moduleIds: (layoutSketch?.modules || []).map((item) => String(item?.moduleId || '')).filter(Boolean),
    responsiveRequired: Boolean(layoutSketch?.responsiveContract),
    responsivePage: responsiveContext ? {
      mobileMax: responsiveContext.breakpoints?.mobileMax || 767,
      mobileOnlyTextIds: (responsiveContext.mobileOnly || []).filter((item) => item.role === 'text' && item.text).map((item) => item.sourceNodeId),
      requiredMobileAssets: (finalAssetIndex?.assets || [])
        .filter((asset) => asset.responsiveVariant === 'mobile-only' && asset.renderPolicy === 'required-final')
        .map((asset) => ({ assetId: asset.assetId, paths: assetPaths(asset) })),
    } : null,
  }
}

function buildGlobalDecorationQualityRequirements(layoutSketch) {
  return {
    globalDecorationIds: (layoutSketch?.globalDecorations || []).map((item) => String(item?.sourceNodeId || '')).filter(Boolean),
    moduleIds: (layoutSketch?.modules || []).map((item) => String(item?.moduleId || '')).filter(Boolean),
  }
}

function buildResponsiveRuntimeContract(contract, manifest) {
  const desktop = manifest.variants.desktop.viewport
  const mobile = manifest.variants.mobile.viewport
  const candidates = [
    { name: 'mobile-design', width: Number(mobile.width), height: Number(mobile.height) },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'laptop', width: 1280, height: 900 },
    { name: 'desktop-design', width: Number(desktop.width), height: Number(desktop.height) },
    { name: 'wide-desktop', width: 2560, height: 1440 },
  ]
  const widths = new Set()
  const viewports = candidates.filter((viewport) => {
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || widths.has(viewport.width)) return false
    widths.add(viewport.width)
    return true
  })
  return { ...(contract || {}), enabled: true, viewports }
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
    strategy: 'confidence-gated-hybrid-flow-draft',
    flowSkeleton: {
      policy: 'Core puts high-confidence page modules, repeated collections, and explicit Auto Layout containers in flow; uncertain or overlapping visual regions remain local absolute fallbacks.',
      agentOwnership: 'Preserve the flow skeleton while adding semantics, interactions, responsive reflow, and visual refinements. Replace a Core decision only when source facts require it; never regress the complete page to a fixed canvas or root scaling.',
    },
    modules: pageLayout?.modules || [],
    globalDecorations: pageLayout?.globalDecorations || [],
    stackingFacts: pageLayout?.stackingFacts || [],
    responsiveContract: pageLayout?.responsiveContract || null,
    warnings: [...new Set([...(normalizedRaw?.warnings || []).map((item) => item?.message || String(item)), ...(pageLayout?.warnings || []).map((item) => item?.message || String(item))])],
  }
}

function buildGenerationBrief(jobId, layoutSketch, prototypeManifest, responsiveContext = null) {
  const responsiveReads = responsiveContext
    ? '\n2a. This is one responsive page with two source Frames. Also read `agent/responsive-context.json`, `agent/canonical-source-texts.json`, both files under `variants/*/02-layout/`, both Frame screenshots, and the read-only mobile prototype under `agent/reference-prototypes/mobile/`.\n'
    : ''
  const responsiveRules = responsiveContext
    ? `\n## Responsive page requirements\n\n- Produce one semantic DOM and one page; do not duplicate the complete desktop and mobile pages.\n- Desktop is the editable prototype baseline. Implement the mobile Frame facts at max-width ${responsiveContext.breakpoints.mobileMax}px with CSS media queries.\n- Use JavaScript only for interaction state, never to select a device-specific page.\n- Preserve canonical desktop bindings and every mobile-only binding listed in responsive-context.json. Mobile aliases document correspondence and do not require duplicate DOM nodes.\n- Mobile-only assets are available under assets/mobile/.\n`
    : ''
  return `# Agent v2 generation brief

Job: ${jobId}

Edit the existing prototype. Do not rebuild the page from empty files.

## Required workflow

1. Run \`agent-begin ${jobId} --json\` before editing so Agent time is measured separately from handoff wait time.
2. Read \`agent/agent-generation-playbook.md\`, \`agent/constraint-pack.md\`, \`02-layout/layout-sketch.json\`, \`agent/prototype-manifest.json\`, \`agent/prototype-validation.json\`, \`00-input/frame-screenshot.png\`, and \`01-normalized/source-texts.json\`.
${responsiveReads}
3. Treat the draft as the implementation starting point, the playbook as the review/planning method, the constraint pack as the only normative page constraint source, and indexed facts as on-demand decision evidence.
4. Core has already created a confidence-gated flow skeleton. Preserve \`data-layout-mode="flow"\`, \`data-layout-skeleton="repeated-list"\`, and explicit Auto Layout structure unless source facts require a different grouping. Keep local absolute positioning only for overlapping or decorative regions.
5. Inspect layout warnings and low-confidence/degraded regions, then internally perform component, asset, interaction, and assembly review before editing.
6. Add semantic elements, whole-component interactions, responsive reflow, typography, assets, and visual refinements directly to the draft. Do not regress the complete page to a fixed canvas or root \`transform: scale(...)\`. Do not output intermediate plans or reasoning.
7. Preserve every \`data-source-node-id\`, \`data-text-source-node-id\`, \`data-style-source-node-id\`, and \`data-asset-id\` binding that represents source content.
8. Do not modify fact files, \`prototype-source/\`, or \`draft/assets/\`.
9. Only edit \`agent/draft/index.html\`, \`styles.css\`, and \`script.js\`.
10. Run \`agent-finalize ${jobId} --json\` once. Do not enter a repair loop.

## Prototype facts

- Root: ${layoutSketch.rootFrame?.name || 'unknown'} (${layoutSketch.rootFrame?.bounds?.width || '?'} x ${layoutSketch.rootFrame?.bounds?.height || '?'})
- Rendered nodes: ${prototypeManifest.renderedNodeCount}/${prototypeManifest.nodeCount}
- Composite replacements: ${prototypeManifest.compositeReplacementCount}
- Flow modules: ${(prototypeManifest.flowSkeleton?.flowModuleIds || []).length}
- Absolute fallback modules: ${(prototypeManifest.flowSkeleton?.absoluteFallbackModuleIds || []).length}
- Repeated flow collections: ${(prototypeManifest.flowSkeleton?.repeatedCollections || []).length}
- Warnings: ${(prototypeManifest.warnings || []).length + (layoutSketch.warnings || []).length}
${responsiveRules}
`
}

function buildV2ContextIndex(jobDir, options = {}) {
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
    ...(options.responsive ? [
      ['agent/responsive-context.json', 'responsive-contract', 'always'],
      ['agent/canonical-source-texts.json', 'canonical-immutable-text', 'always'],
      ['agent/final-asset-index.json', 'responsive-asset-facts', 'on-demand'],
      ['agent/final-font-assets.json', 'responsive-font-facts', 'on-demand'],
      ['agent/final-node-style-facts.json', 'responsive-style-facts', 'on-demand'],
      ['agent/mobile-prototype-validation.json', 'mobile-prototype-baseline-validation', 'always'],
      ['agent/reference-prototypes/mobile/index.html', 'mobile-reference-prototype', 'always'],
      ['agent/reference-prototypes/mobile/styles.css', 'mobile-reference-prototype', 'always'],
      ['variants/desktop/00-input/frame-screenshot.png', 'desktop-visual-reference', 'always'],
      ['variants/mobile/00-input/frame-screenshot.png', 'mobile-visual-reference', 'always'],
      ['variants/desktop/02-layout/layout-sketch.json', 'desktop-layout', 'always'],
      ['variants/mobile/02-layout/layout-sketch.json', 'mobile-layout', 'always'],
      ['variants/mobile/01-normalized/source-texts.json', 'mobile-source-text', 'on-demand'],
      ['variants/mobile/01-normalized/node-style-facts.json', 'mobile-style-facts', 'on-demand'],
      ['variants/mobile/01-normalized/asset-index.json', 'mobile-asset-facts', 'on-demand'],
      ['variants/mobile/01-normalized/raw.normalized.json', 'mobile-node-facts', 'on-demand'],
    ] : []),
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

function readVariantFacts(variantDir) {
  return {
    normalizedRaw: readJson(join(variantDir, '01-normalized', 'raw.normalized.json')),
    pageLayout: readJson(join(variantDir, '02-layout', 'page-layout.json')),
    assetIndex: readJson(join(variantDir, '01-normalized', 'asset-index.json')),
    nodeStyleFacts: readJson(join(variantDir, '01-normalized', 'node-style-facts.json')),
    sourceTexts: readJson(join(variantDir, '01-normalized', 'source-texts.json')),
    fontAssets: readJson(join(variantDir, '01-normalized', 'font-assets.json')),
  }
}

function buildResponsiveContext(manifest, desktopFacts, mobileFacts) {
  const desktopNodes = flatten(desktopFacts.normalizedRaw.nodes || []).filter((node) => node?.sourceNodeId || node?.id)
  const mobileNodes = flatten(mobileFacts.normalizedRaw.nodes || []).filter((node) => node?.sourceNodeId || node?.id)
  const desktopAvailable = new Set(desktopNodes)
  const matched = []
  const mobileOnly = []
  for (const mobile of mobileNodes) {
    if (sourceNodeId(mobile) === String(manifest.variants.mobile.sourceNodeId)) {
      const desktopRoot = desktopNodes.find((node) => sourceNodeId(node) === String(manifest.variants.desktop.sourceNodeId))
      if (desktopRoot) {
        desktopAvailable.delete(desktopRoot)
        matched.push({
          canonicalSourceNodeId: sourceNodeId(desktopRoot),
          mobileAliasSourceNodeId: sourceNodeId(mobile),
          confidence: 'high',
          basis: ['responsive-manifest-root-pair'],
          desktop: summarizeResponsiveNode(desktopRoot),
          mobile: summarizeResponsiveNode(mobile),
          changes: summarizeLayoutChanges(desktopRoot, mobile),
        })
        continue
      }
    }
    const candidates = [...desktopAvailable].map((desktop) => ({ desktop, score: responsiveNodeScore(desktop, mobile) }))
      .filter((item) => item.score >= 60)
      .sort((a, b) => b.score - a.score)
    if (candidates.length === 0 || (candidates[1] && candidates[1].score === candidates[0].score && candidates[0].score < 100)) {
      mobileOnly.push(summarizeResponsiveNode(mobile))
      continue
    }
    const winner = candidates[0]
    desktopAvailable.delete(winner.desktop)
    matched.push({
      canonicalSourceNodeId: sourceNodeId(winner.desktop),
      mobileAliasSourceNodeId: sourceNodeId(mobile),
      confidence: winner.score >= 100 ? 'high' : 'medium',
      basis: responsiveMatchBasis(winner.desktop, mobile),
      desktop: summarizeResponsiveNode(winner.desktop),
      mobile: summarizeResponsiveNode(mobile),
      changes: summarizeLayoutChanges(winner.desktop, mobile),
    })
  }
  return {
    version: 'mastergo2html.responsive-context.v1',
    page: manifest.page,
    breakpoints: { mobileMax: Number(manifest.breakpoints?.mobileMax || 767) },
    variants: manifest.variants,
    matchedNodes: matched,
    desktopOnly: [...desktopAvailable].map(summarizeResponsiveNode),
    mobileOnly,
    canonicalBindings: matched.map((item) => ({ canonicalSourceNodeId: item.canonicalSourceNodeId, mobileAliasSourceNodeId: item.mobileAliasSourceNodeId })),
  }
}

function responsiveNodeScore(desktop, mobile) {
  if (String(desktop?.type || '') !== String(mobile?.type || '')) return 0
  const desktopText = String(desktop?.text || '').trim()
  const mobileText = String(mobile?.text || '').trim()
  const desktopName = String(desktop?.name || '').trim()
  const mobileName = String(mobile?.name || '').trim()
  if (desktopText && desktopText === mobileText && desktopName && desktopName === mobileName) return 120
  if (desktopText && desktopText === mobileText) return 110
  if (desktopName && desktopName === mobileName) return 80
  return 0
}

function responsiveMatchBasis(desktop, mobile) {
  const basis = ['node-type']
  if (String(desktop?.text || '').trim() && String(desktop.text).trim() === String(mobile?.text || '').trim()) basis.push('exact-text')
  if (String(desktop?.name || '').trim() && String(desktop.name).trim() === String(mobile?.name || '').trim()) basis.push('exact-name')
  return basis
}

function summarizeResponsiveNode(node) {
  return {
    sourceNodeId: sourceNodeId(node),
    name: node?.name || '',
    type: node?.type || '',
    role: node?.role || '',
    text: node?.role === 'text' ? node?.text || '' : undefined,
    bounds: node?.relativeBounds || node?.bounds || null,
    visible: node?.visible !== false,
  }
}

function summarizeLayoutChanges(desktop, mobile) {
  const desktopBounds = desktop?.relativeBounds || desktop?.bounds || {}
  const mobileBounds = mobile?.relativeBounds || mobile?.bounds || {}
  return {
    positionChanged: Number(desktopBounds.x) !== Number(mobileBounds.x) || Number(desktopBounds.y) !== Number(mobileBounds.y),
    sizeChanged: Number(desktopBounds.width) !== Number(mobileBounds.width) || Number(desktopBounds.height) !== Number(mobileBounds.height),
    visibilityChanged: (desktop?.visible !== false) !== (mobile?.visible !== false),
    layoutModeChanged: String(desktop?.layout?.mode || '') !== String(mobile?.layout?.mode || ''),
  }
}

function buildCanonicalSourceTexts(desktopTexts, mobileTexts, responsiveContext) {
  const aliasIds = new Set(responsiveContext.canonicalBindings.map((item) => String(item.mobileAliasSourceNodeId)))
  const mobileOnly = (mobileTexts || []).filter((item) => !aliasIds.has(String(item.sourceNodeId || item.nodeId || '')))
    .map((item) => ({ ...item, responsiveVariant: 'mobile-only' }))
  return [...desktopTexts, ...mobileOnly]
}

function buildResponsiveNodeStyleFacts(desktopFacts, mobileFacts, responsiveContext) {
  const mobileOnlyIds = new Set((responsiveContext.mobileOnly || []).map((item) => String(item.sourceNodeId)))
  return {
    ...(desktopFacts || {}),
    version: 'mastergo2html.responsive-node-style-facts.v1',
    facts: [
      ...(desktopFacts?.facts || []),
      ...(mobileFacts?.facts || []).filter((fact) => mobileOnlyIds.has(String(fact?.sourceNodeId || '')))
        .map((fact) => ({ ...fact, responsiveVariant: 'mobile-only' })),
    ],
  }
}

function copyResponsiveMobileAssets({ mobileInputDir, draftDir, desktopAssetIndex, mobileAssetIndex, responsiveContext }) {
  const desktopHashes = new Map()
  for (const asset of desktopAssetIndex?.assets || []) {
    for (const path of assetPaths(asset)) {
      const absolute = join(mobileInputDir, '..', '..', 'desktop', '00-input', path)
      if (existsSync(absolute)) desktopHashes.set(hashFile(absolute), path)
    }
  }
  const mobileAssets = []
  for (const asset of mobileAssetIndex?.assets || []) {
    const pathMap = new Map()
    for (const path of assetPaths(asset)) {
      const source = join(mobileInputDir, path)
      if (!existsSync(source) || !statSync(source).isFile()) continue
      const reused = desktopHashes.get(hashFile(source))
      const mobileRelativePath = String(path).replace(/^assets\//, '')
      const targetPath = reused || `assets/mobile/${mobileRelativePath}`
      pathMap.set(path, targetPath)
      if (!reused) {
        mkdirSync(dirname(join(draftDir, targetPath)), { recursive: true })
        cpSync(source, join(draftDir, targetPath))
      }
    }
    if (pathMap.size > 0) mobileAssets.push(remapAssetPaths(asset, pathMap))
  }
  return {
    version: 'mastergo2html.responsive-asset-index.v1',
    assets: [
      ...(desktopAssetIndex?.assets || []),
      ...mobileAssets.map((asset) => ({ ...asset, assetId: `mobile:${asset.assetId}`, responsiveVariant: 'mobile-only' })),
    ],
    responsiveContextVersion: responsiveContext.version,
  }
}

function assetPaths(asset) {
  return [...new Set([asset?.preferred?.copiedPath, asset?.copiedPath, ...(asset?.rendered || []).map((item) => item?.path)].filter(Boolean))]
}

function remapAssetPaths(asset, pathMap) {
  const remap = (path) => pathMap.get(path) || path
  return {
    ...asset,
    copiedPath: asset?.copiedPath ? remap(asset.copiedPath) : asset?.copiedPath,
    preferred: asset?.preferred ? { ...asset.preferred, copiedPath: remap(asset.preferred.copiedPath) } : asset?.preferred,
    rendered: (asset?.rendered || []).map((item) => ({ ...item, path: remap(item.path) })),
  }
}

function copyResponsiveMobileFonts({ mobileInputDir, draftDir, desktopFontAssets, mobileFontAssets }) {
  const files = [...(desktopFontAssets?.files || [])]
  const mobileFiles = []
  for (const path of mobileFontAssets?.files || []) {
    const source = join(mobileInputDir, path)
    if (!existsSync(source) || !statSync(source).isFile()) continue
    const targetPath = `assets/mobile/${String(path).replace(/^assets\//, '')}`
    mkdirSync(dirname(join(draftDir, targetPath)), { recursive: true })
    cpSync(source, join(draftDir, targetPath))
    mobileFiles.push(targetPath)
  }
  return {
    ...(desktopFontAssets || {}),
    version: 'mastergo2html.responsive-font-assets.v1',
    files: [...new Set([...files, ...mobileFiles])],
    mobileFiles,
  }
}

function sourceNodeId(node) {
  return String(node?.sourceNodeId || node?.id || '')
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

function claimedId(job) {
  return job?.claim?.claimId || job?.claimId || null
}

function assertClaimId(job, claimId) {
  const expected = claimedId(job)
  if (!expected) {
    if (job?.batch?.batchId) throw new Error(`Agent batch job ${job.jobId} must be claimed before begin or finalize`)
    return
  }
  if (!claimId) throw new Error(`Claim ID is required for claimed Agent job ${job.jobId}`)
  if (String(claimId) !== String(expected)) throw new Error(`Claim ID does not match claimed Agent job ${job.jobId}`)
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
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}
