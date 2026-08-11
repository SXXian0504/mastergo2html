import { createHash, randomUUID } from 'node:crypto'
import {
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
import { packageOutputDirectory } from '../../mcp-server/src/output-zip.js'
import {
  applySafeStaticFixes,
  buildHtmlGenerationContext,
  copyAssets,
  publishOutput,
  smokeTestOutput,
  validateGeneratedFiles,
  writeGeneratedFiles,
} from '../../mcp-server/src/workflow/html-generation.js'
import { runRawLayoutConversion } from '../../mcp-server/src/workflow/raw-layout-conversion.js'
import { runResponsiveRuntimeValidation } from '../../mcp-server/src/workflow/responsive-runtime-validation.js'
import { DEFAULT_JOB_ROOT } from './constants.js'
import {
  buildAgentConstraintPack,
  buildConstraintCoverage,
  buildConstraintManifest,
  CONSTRAINT_PACK_VERSION,
} from './constraint-service.js'
import { prepareInput, readInputMetadata } from './input.js'
import { buildMergePrepareCommand, preparePageBundle } from './page-bundle.js'

const AGENT_PROTOCOL_VERSION = 'mastergo2html.codex-agent.v1'
const PLAN_VERSION = 'mastergo2html.implementation-plan.v1'
const REQUIRED_DRAFT_FILES = ['index.html', 'styles.css', 'script.js']
const AGENT_BATCH_VERSION = 'mastergo2html.codex-agent-batch.v1'

export async function prepareAgentPageBundle(inputPath, options = {}) {
  const batchId = options.batchId || randomUUID()
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const batchDir = join(batchRoot, batchId)
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  mkdirSync(batchDir, { recursive: true })

  const prepared = preparePageBundle(inputPath, batchDir)
  const now = new Date().toISOString()
  const batch = {
    version: AGENT_BATCH_VERSION,
    batchId,
    mode: 'codex-agent',
    status: 'preparing',
    inputPath: prepared.inputPath,
    source: prepared.manifest.source,
    batchDir,
    jobRoot,
    createdAt: now,
    updatedAt: now,
    contextPolicy: 'Process one page at a time. Read each job context index once; do not combine full page contexts.',
    pages: prepared.pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      sourceNodeId: page.sourceNodeId,
      index: page.index,
      inputPath: page.inputPath,
      status: 'pending',
    })),
  }
  writeAgentBatch(batch)

  const prepareJobFn = options.prepareJobFn || prepareAgentJob
  for (const page of batch.pages) {
    try {
      const job = await prepareJobFn(page.inputPath, {
        jobRoot,
        onJobStart: options.onJobStart,
        onProgress: (progress) => options.onProgress?.({ ...progress, pageId: page.id, route: page.route }),
      })
      Object.assign(page, {
        jobId: job.jobId,
        jobDir: job.jobDir,
        status: job.status,
        agentStage: job.agentStage,
        manifestPath: job.manifestPath,
        contextIndexPath: job.contextIndexPath,
      })
    } catch (error) {
      page.status = 'error'
      page.error = error.message
    }
    batch.updatedAt = new Date().toISOString()
    writeAgentBatch(batch)
  }

  return refreshAgentBatch(batch)
}

export function getAgentBatchStatus(batchId, options = {}) {
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const batchDir = join(batchRoot, batchId)
  const batch = readJsonRequired(join(batchDir, 'batch.json'), `找不到 Agent 批次：${batchId}`)
  batch.batchDir = batch.batchDir || batchDir
  return refreshAgentBatch(batch)
}

export async function prepareAgentJob(inputPath, options = {}) {
  const jobId = options.jobId || randomUUID()
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const jobDir = join(jobRoot, jobId)
  const createdAt = new Date().toISOString()
  mkdirSync(jobDir, { recursive: true })

  const inputDir = prepareInput(inputPath, jobDir)
  const metadata = readInputMetadata(inputDir)
  const layoutConversion = await runRawLayoutConversion(jobId, jobDir)
  const inputHash = hashDirectory(inputDir)
  const moduleIndex = buildModuleIndex(jobDir)
  const agentDir = join(jobDir, 'agent')
  const draftDir = join(agentDir, 'draft')
  mkdirSync(draftDir, { recursive: true })

  const target = resolveAgentTarget(jobDir)
  const constraintPack = buildAgentConstraintPack({ target })
  const constraintManifest = buildConstraintManifest({ target })
  const constraintPackPath = join(agentDir, 'constraint-pack.md')
  const constraintManifestPath = join(agentDir, 'constraint-manifest.json')
  writeFileSync(constraintPackPath, constraintPack, 'utf8')
  writeJsonAtomic(constraintManifestPath, constraintManifest)
  const contextIndex = buildContextIndex(jobDir)

  const contextIndexPath = join(agentDir, 'context-index.json')
  const moduleIndexPath = join(agentDir, 'module-index.json')
  const planTemplatePath = join(agentDir, 'implementation-plan.template.json')
  const planPath = join(agentDir, 'implementation-plan.json')
  writeJsonAtomic(contextIndexPath, contextIndex)
  writeJsonAtomic(moduleIndexPath, moduleIndex)
  writeJsonAtomic(planTemplatePath, buildPlanTemplate(metadata, moduleIndex, jobDir, constraintManifest))

  const manifest = {
    version: AGENT_PROTOCOL_VERSION,
    jobId,
    stage: 'planning',
    status: 'awaiting-codex',
    inputHash,
    constraintPackVersion: constraintManifest.version,
    constraintPackHash: constraintManifest.constraintPackHash,
    createdAt,
    updatedAt: createdAt,
    allowedReads: contextIndex.files.map((file) => file.path),
    allowedWrites: [
      relativePath(jobDir, planPath),
      ...REQUIRED_DRAFT_FILES.map((file) => relativePath(jobDir, join(draftDir, file))),
    ],
    requiredArtifacts: [relativePath(jobDir, planPath)],
    nextCommand: `npm run --silent cli -- agent-accept-plan ${jobId} --json`,
  }
  writeJsonAtomic(join(agentDir, 'manifest.json'), manifest)

  const phaseDetails = [
    completedPhase('collect-input', '输入已复制并校验', [inputDir]),
    completedPhase('normalize-raw', `已生成标准化输入：${layoutConversion.summary.nodeCount} 个节点，${layoutConversion.summary.assetCount} 个资源`, [layoutConversion.normalizedDir, layoutConversion.aiLayoutContextPath]),
    awaitingPhase('agent-planning', '等待当前 Codex 生成唯一实施计划'),
  ]
  const job = {
    jobId,
    mode: 'codex-agent',
    status: 'awaiting-codex',
    agentStage: 'planning',
    source: metadata.source,
    inputPath: inputDir,
    inputHash,
    createdAt,
    updatedAt: createdAt,
    progress: { phase: 'agent-planning', percent: 40, message: '等待当前 Codex 生成唯一实施计划' },
    phaseDetails,
    manifestPath: join(agentDir, 'manifest.json'),
    contextIndexPath,
    moduleIndexPath,
    constraintPackPath,
    constraintManifestPath,
    planTemplatePath,
    planPath,
    draftDir,
  }
  writeJsonAtomic(join(jobDir, 'job.json'), job)
  options.onJobStart?.({ jobId, jobDir, jobRoot, mode: 'codex-agent' })
  options.onProgress?.(job.progress)
  return { ...job, jobDir }
}

export function acceptAgentPlan(jobId, options = {}) {
  const { jobDir, job } = readAgentJob(jobId, options)
  assertAgentJob(job)
  assertInputUnchanged(jobDir, job.inputHash)
  assertConstraintPackUnchanged(jobDir)
  const planPath = join(jobDir, 'agent', 'implementation-plan.json')
  const plan = readJsonRequired(planPath, '缺少 implementation-plan.json；请从 implementation-plan.template.json 开始填写')
  const validation = validateImplementationPlan(plan, jobDir)
  const validationPath = join(jobDir, 'agent', 'plan-validation.json')
  writeJsonAtomic(validationPath, validation)
  if (!validation.ok) {
    updateAgentJob(jobDir, job, {
      status: 'needs-repair',
      agentStage: 'planning',
      progress: { phase: 'agent-planning', percent: 45, message: `实施计划校验失败：${validation.errors.length} 个问题` },
      planValidationPath: validationPath,
    })
    throw Object.assign(new Error(`实施计划校验失败：${validation.errors.join('；')}`), { validation })
  }

  writeCompatibilityPlans(jobDir, plan)
  const manifest = readManifest(jobDir)
  const nextManifest = {
    ...manifest,
    stage: 'generation',
    status: 'awaiting-codex',
    updatedAt: new Date().toISOString(),
    requiredArtifacts: REQUIRED_DRAFT_FILES.map((file) => `agent/draft/${file}`),
    nextCommand: `npm run --silent cli -- agent-finalize ${jobId} --json`,
  }
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), nextManifest)
  const updated = updateAgentJob(jobDir, job, {
    status: 'awaiting-codex',
    agentStage: 'generation',
    progress: { phase: 'agent-generation', percent: 65, message: '实施计划已验收，等待当前 Codex 直接写入 HTML/CSS/JS' },
    planValidationPath: validationPath,
    phaseDetails: [
      ...(job.phaseDetails || []).filter((phase) => phase.phase !== 'agent-planning' && phase.phase !== 'agent-generation'),
      completedPhase('agent-planning', '唯一实施计划已通过校验', [planPath, validationPath]),
      awaitingPhase('agent-generation', '等待当前 Codex 直接写入 HTML/CSS/JS'),
    ],
  })
  return { ok: true, job: updated, manifest: nextManifest, validation }
}

export async function finalizeAgentJob(jobId, options = {}) {
  const { jobDir, job } = readAgentJob(jobId, options)
  assertAgentJob(job)
  if (!['generation', 'repair'].includes(job.agentStage)) {
    throw new Error(`当前 Agent 阶段不能验收代码：${job.agentStage || 'unknown'}`)
  }
  assertInputUnchanged(jobDir, job.inputHash)
  assertConstraintPackUnchanged(jobDir)
  const draftDir = join(jobDir, 'agent', 'draft')
  let files
  try {
    files = readDraftFiles(draftDir)
  } catch (error) {
    const validation = {
      ok: false,
      errors: [error.message],
      warnings: [],
      checkedAt: new Date().toISOString(),
      transport: { mode: 'direct-files', jsonEnvelopeParsed: false },
    }
    attachConstraintCoverage(validation, jobDir)
    return recordAgentRepair(jobDir, job, draftDir, validation)
  }
  const context = buildHtmlGenerationContext(jobDir)
  const safeFixResult = applySafeStaticFixes(files, context)
  const validation = validateGeneratedFiles(safeFixResult.files, context)
  validation.autoFixes = safeFixResult.fixes
  validation.transport = {
    mode: 'direct-files',
    jsonEnvelopeParsed: false,
    files: REQUIRED_DRAFT_FILES.map((file) => ({ file, sizeBytes: statSync(join(draftDir, file)).size })),
  }

  const tempDir = join(jobDir, '.agent-output-tmp')
  const outputDir = join(jobDir, '05-output')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })
  writeGeneratedFiles(tempDir, safeFixResult.files)
  copyAssets(context.assetsDir, join(tempDir, 'assets'))

  const smokeTestFn = options.smokeTestFn || smokeTestOutput
  const responsiveRuntimeTestFn = options.responsiveRuntimeTestFn || runResponsiveRuntimeValidation
  try {
    await smokeTestFn(tempDir)
    validation.responsiveRuntime = await responsiveRuntimeTestFn({
      outputDir: tempDir,
      contract: context.pageLayout?.responsiveContract,
    })
  } catch (error) {
    validation.errors.push(`运行时验收失败：${error.message}`)
    validation.ok = false
  }
  validation.warnings = [...new Set([
    ...(validation.warnings || []),
    ...(validation.responsiveRuntime?.warnings || []).map((warning) => `响应式运行时检测：${warning}`),
  ])]
  attachConstraintCoverage(validation, jobDir)
  const agentValidationPath = join(jobDir, 'agent', 'validation.json')
  writeJsonAtomic(agentValidationPath, validation)

  if (!validation.ok) {
    rmSync(tempDir, { recursive: true, force: true })
    return recordAgentRepair(jobDir, job, draftDir, validation)
  }

  writeFileSync(join(tempDir, 'static-validation.json'), `${JSON.stringify(validation, null, 2)}\n`, 'utf8')
  publishOutput(tempDir, outputDir)
  const zipPath = join(jobDir, 'final', 'output.zip')
  const packageResult = packageOutputDirectory(outputDir, zipPath)
  const completedAt = new Date().toISOString()
  const finalJob = updateAgentJob(jobDir, job, {
    status: 'done',
    agentStage: 'done',
    outputDir,
    outputPath: outputDir,
    completedAt,
    progress: { phase: 'agent-generation', percent: 100, message: '当前 Codex 生成的文件已通过校验并完成打包' },
    validationPath: join(outputDir, 'static-validation.json'),
    resultSummary: {
      htmlPath: join(outputDir, 'index.html'),
      zipPath,
      zipSizeBytes: packageResult.sizeBytes,
      packagedFileCount: packageResult.fileCount,
      note: 'HTML/CSS/JS 由当前 Codex 直接写入文件，未使用大型 JSON 代码信封。',
    },
    phaseDetails: replaceAgentGenerationPhase(job.phaseDetails, 'done', '直接文件已通过校验并打包', [outputDir, join(outputDir, 'static-validation.json')]),
  })
  const manifest = readManifest(jobDir)
  manifest.stage = 'done'
  manifest.status = 'done'
  manifest.updatedAt = completedAt
  manifest.nextCommand = null
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), manifest)
  return { ok: true, status: 'done', job: finalJob, validation, outputDir, zipPath }
}

export function getAgentJobStatus(jobId, options = {}) {
  const { jobDir, job } = readAgentJob(jobId, options)
  return { ok: true, jobDir, job, manifest: readManifest(jobDir) }
}

export function inspectAgentJob(jobId, query = {}, options = {}) {
  const { jobDir } = readAgentJob(jobId, options)
  if (query.issues) {
    const path = join(jobDir, 'agent', 'validation.json')
    return { kind: 'issues', path, value: readJsonRequired(path, '当前任务还没有 Agent 校验报告') }
  }
  if (query.moduleId) {
    const index = readJsonRequired(join(jobDir, 'agent', 'module-index.json'))
    const value = index.modules.find((module) => module.moduleId === query.moduleId)
    if (!value) throw new Error(`找不到 moduleId：${query.moduleId}`)
    return { kind: 'module', value }
  }
  if (query.assetId) {
    const assets = readJsonRequired(join(jobDir, '01-normalized', 'asset-index.json')).assets || []
    const value = assets.find((asset) => asset.assetId === query.assetId)
    if (!value) throw new Error(`找不到 assetId：${query.assetId}`)
    return { kind: 'asset', value }
  }
  if (query.nodeId) {
    const normalized = readJsonRequired(join(jobDir, '01-normalized', 'raw.normalized.json'))
    const value = flattenNodes(normalized.nodes || []).find((node) => (node.sourceNodeId || node.id) === query.nodeId)
    if (!value) throw new Error(`找不到 sourceNodeId：${query.nodeId}`)
    return { kind: 'node', value }
  }
  return getAgentJobStatus(jobId, options)
}

export function validateImplementationPlan(plan, jobDir) {
  const errors = []
  if (plan?.version !== PLAN_VERSION) errors.push(`version 必须是 ${PLAN_VERSION}`)
  if (!plan?.page || typeof plan.page !== 'object') errors.push('缺少 page 对象')
  if (!Array.isArray(plan?.modules)) errors.push('modules 必须是数组')
  if (!Array.isArray(plan?.responsiveDecisions) || !plan.responsiveDecisions.some((decision) => String(decision).trim())) errors.push('responsiveDecisions 必须包含非空决策')
  if (!Array.isArray(plan?.implementationOrder)) errors.push('implementationOrder 必须是数组')
  if (!plan?.interactionPolicy || typeof plan.interactionPolicy.hoverRequired !== 'boolean' || typeof plan.interactionPolicy.motionRequired !== 'boolean') {
    errors.push('interactionPolicy 必须包含布尔值 hoverRequired 和 motionRequired')
  }

  const pageLayout = readJsonRequired(join(jobDir, '02-layout', 'page-layout.json'))
  const normalized = readJsonRequired(join(jobDir, '01-normalized', 'raw.normalized.json'))
  const assetIndex = readJsonRequired(join(jobDir, '01-normalized', 'asset-index.json'))
  const constraintManifest = readJsonRequired(join(jobDir, 'agent', 'constraint-manifest.json'))
  const validModules = new Set((pageLayout.modules || []).map((module) => module.moduleId))
  const validNodes = new Set(flattenNodes(normalized.nodes || []).map((node) => node.sourceNodeId || node.id).filter(Boolean))
  const validAssets = new Set((assetIndex.assets || []).map((asset) => asset.assetId))
  if (plan?.constraintPackVersion !== constraintManifest.version) errors.push(`constraintPackVersion 必须是 ${constraintManifest.version}`)
  if (plan?.constraintPackHash !== constraintManifest.constraintPackHash) errors.push('constraintPackHash 与当前任务不一致')
  if (!Array.isArray(plan?.constraintDecisions)) errors.push('constraintDecisions 必须是数组')
  const constraintDecisions = Array.isArray(plan?.constraintDecisions) ? plan.constraintDecisions : []
  const decisionIds = constraintDecisions.map((item) => item?.constraintId).filter(Boolean)
  if (new Set(decisionIds).size !== decisionIds.length) errors.push('constraintDecisions 不能包含重复 constraintId')
  for (const [index, decision] of constraintDecisions.entries()) {
    if (!constraintManifest.applicableConstraintIds.includes(decision?.constraintId)) errors.push(`constraintDecisions[${index}] 引用未知约束：${decision?.constraintId || 'missing'}`)
    if (!String(decision?.decision || '').trim()) errors.push(`constraintDecisions[${index}].decision 不能为空`)
    if (!Array.isArray(decision?.evidenceNodeIds)) errors.push(`constraintDecisions[${index}].evidenceNodeIds 必须是数组`)
    else for (const nodeId of decision.evidenceNodeIds) if (!validNodes.has(nodeId)) errors.push(`约束决策引用未知 sourceNodeId：${nodeId}`)
  }
  for (const constraintId of constraintManifest.decisionRequiredIds) {
    if (!decisionIds.includes(constraintId)) errors.push(`约束决策遗漏：${constraintId}`)
  }
  const moduleIds = (plan.modules || []).map((module) => module?.moduleId).filter(Boolean)
  if (new Set(moduleIds).size !== moduleIds.length) errors.push('modules 不能包含重复 moduleId')

  for (const [index, module] of (plan.modules || []).entries()) {
    if (!module?.moduleId || !validModules.has(module.moduleId)) errors.push(`modules[${index}].moduleId 无效：${module?.moduleId || 'missing'}`)
    if (!String(module?.implementationNotes || '').trim()) errors.push(`modules[${index}].implementationNotes 不能为空`)
    if (!Array.isArray(module?.sourceNodeIds)) errors.push(`modules[${index}].sourceNodeIds 必须是数组`)
    else for (const nodeId of module.sourceNodeIds) if (!validNodes.has(nodeId)) errors.push(`未知 sourceNodeId：${nodeId}`)
    if (!Array.isArray(module?.assetBindings)) errors.push(`modules[${index}].assetBindings 必须是数组`)
    else for (const binding of module.assetBindings) if (!validAssets.has(binding?.assetId)) errors.push(`未知 assetId：${binding?.assetId || 'missing'}`)
  }
  const plannedModules = new Set((plan.modules || []).map((module) => module.moduleId))
  for (const moduleId of validModules) if (!plannedModules.has(moduleId)) errors.push(`实施计划遗漏模块：${moduleId}`)
  const implementationOrder = Array.isArray(plan?.implementationOrder) ? plan.implementationOrder : []
  for (const moduleId of implementationOrder) if (!plannedModules.has(moduleId)) errors.push(`implementationOrder 引用未知模块：${moduleId}`)
  if (new Set(implementationOrder).size !== implementationOrder.length) errors.push('implementationOrder 不能包含重复模块')
  for (const moduleId of validModules) if (!implementationOrder.includes(moduleId)) errors.push(`implementationOrder 遗漏模块：${moduleId}`)
  return { ok: errors.length === 0, errors, checkedAt: new Date().toISOString() }
}

function buildContextIndex(jobDir) {
  const candidates = [
    ['agent/constraint-pack.md', 'constraints', 'always'],
    ['agent/constraint-manifest.json', 'constraint-integrity', 'always'],
    ['00-input/frame-screenshot.png', 'visual', 'always'],
    ['02-layout/page-layout.json', 'layout', 'always'],
    ['01-normalized/source-texts.json', 'text', 'always'],
    ['01-normalized/node-style-facts.json', 'style', 'always'],
    ['01-normalized/asset-index.json', 'assets', 'on-demand'],
    ['01-normalized/design-tokens.json', 'tokens', 'on-demand'],
    ['01-normalized/font-assets.json', 'fonts', 'on-demand'],
    ['01-normalized/raw.normalized.json', 'nodes', 'on-demand'],
    ['02-layout/ai-layout-context.json', 'layout-evidence', 'on-demand'],
  ]
  return {
    version: AGENT_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    policy: 'Read always files once. Use agent-inspect for module, node, asset, and issue details instead of reopening the full normalized tree.',
    files: candidates.filter(([path]) => existsSync(join(jobDir, path))).map(([path, purpose, priority]) => ({
      path,
      purpose,
      priority,
      sizeBytes: statSync(join(jobDir, path)).size,
      sha256: hashFile(join(jobDir, path)),
    })),
  }
}

function buildModuleIndex(jobDir) {
  const layout = readJsonRequired(join(jobDir, '02-layout', 'page-layout.json'))
  const assets = readJsonRequired(join(jobDir, '01-normalized', 'asset-index.json')).assets || []
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]))
  return {
    version: AGENT_PROTOCOL_VERSION,
    page: layout.page,
    layoutStrategy: layout.layoutStrategy,
    responsive: layout.responsive,
    stackingFacts: layout.stackingFacts || [],
    modules: (layout.modules || []).map((module) => ({
      moduleId: module.moduleId,
      name: module.name,
      type: module.type,
      order: module.order,
      bounds: module.bounds,
      sourceNodeIds: module.sourceNodeIds || [],
      layoutStrategy: module.layoutStrategy,
      positionStrategy: module.positionStrategy,
      contentFlow: module.contentFlow,
      backgroundLayers: module.backgroundLayers,
      assetBindings: (module.assetIds || []).map((assetId) => ({
        assetId,
        copiedPath: assetById.get(assetId)?.preferred?.copiedPath || null,
        renderPolicy: assetById.get(assetId)?.renderPolicy || null,
      })),
      warnings: module.warnings || [],
    })),
  }
}

function buildPlanTemplate(metadata, moduleIndex, jobDir, constraintManifest) {
  const exportOptions = existsSync(join(jobDir, '00-input', 'export-options.json'))
    ? readJsonRequired(join(jobDir, '00-input', 'export-options.json'))
    : {}
  return {
    version: PLAN_VERSION,
    constraintPackVersion: constraintManifest.version,
    constraintPackHash: constraintManifest.constraintPackHash,
    constraintDecisions: constraintManifest.decisionRequiredIds.map((constraintId) => ({
      constraintId,
      decision: '',
      evidenceNodeIds: [],
    })),
    page: {
      name: metadata.source?.pageName || moduleIndex.page?.name || 'unknown',
      generationTarget: exportOptions.exportOptions?.targetPlatform || exportOptions.targetPlatform || 'web',
    },
    modules: moduleIndex.modules.map((module) => ({
      moduleId: module.moduleId,
      sourceNodeIds: module.sourceNodeIds,
      layoutStrategy: module.layoutStrategy,
      assetBindings: module.assetBindings,
      textBindings: [],
      interactions: [],
      responsiveDecisions: [],
      implementationNotes: '',
    })),
    stackingDecisions: moduleIndex.stackingFacts,
    responsiveDecisions: [],
    interactionPolicy: { hoverRequired: false, hoverTargets: [], motionRequired: false },
    implementationOrder: moduleIndex.modules.map((module) => module.moduleId),
    reviewRisks: [],
  }
}

function writeCompatibilityPlans(jobDir, plan) {
  const plansDir = join(jobDir, '03-page-plans')
  const assemblyDir = join(jobDir, '04-assembly')
  mkdirSync(plansDir, { recursive: true })
  mkdirSync(assemblyDir, { recursive: true })
  const moduleLines = plan.modules.map((module) => `- ${module.moduleId}: ${module.implementationNotes}`).join('\n') || '- none'
  writeFileSync(join(jobDir, '02-layout', 'page-layout.md'), `# 页面概览\n\n${plan.page.name}\n\n# 模块清单\n\n${moduleLines}\n\n# 响应式判断\n\n${plan.responsiveDecisions.join('\n')}\n`, 'utf8')
  writeFileSync(join(plansDir, 'component-structure.plan.md'), `# 角色结论\n\n由当前 Codex 的唯一实施计划生成。\n\n# 页面 DOM 结构\n\n${moduleLines}\n\n# 给代码生成步骤的指令\n\n遵循 implementation-plan.json。\n`, 'utf8')
  writeFileSync(join(plansDir, 'static-assets.plan.md'), `# 角色结论\n\n资源绑定来自 implementation-plan.json。\n\n# 资源清单与映射\n\n${plan.modules.flatMap((module) => module.assetBindings || []).map((asset) => `- ${asset.assetId}: ${asset.copiedPath || 'inspect asset-index'}`).join('\n') || '- none'}\n\n# 给代码生成步骤的指令\n\n只使用 asset-index 中存在的路径。\n`, 'utf8')
  writeFileSync(join(plansDir, 'interaction.plan.md'), `# 角色结论\n\n交互策略来自 implementation-plan.json。\n\n# 交互状态矩阵\n\nhoverRequired: ${plan.interactionPolicy.hoverRequired}\nhoverTargets: ${(plan.interactionPolicy.hoverTargets || []).join(', ') || 'none'}\nmotionRequired: ${plan.interactionPolicy.motionRequired}\n\n# 给代码生成步骤的指令\n\n实现计划中列出的交互。\n`, 'utf8')
  writeFileSync(join(assemblyDir, 'assembly.plan.md'), `# 组装结论\n\n使用唯一实施计划，不重复拼接角色上下文。\n\n# 页面渲染顺序与区域衔接\n\n${plan.implementationOrder.map((moduleId, index) => `${index + 1}. ${moduleId}`).join('\n')}\n\n# 交互与共享数据\n\nhoverRequired: ${plan.interactionPolicy.hoverRequired}\nhoverTargets: ${(plan.interactionPolicy.hoverTargets || []).join(', ') || 'none'}\nmotionRequired: ${plan.interactionPolicy.motionRequired}\n\n# 给代码生成步骤的指令\n\n直接写入 index.html、styles.css、script.js，不输出 JSON 代码信封。\n`, 'utf8')
}

function readDraftFiles(draftDir) {
  for (const file of REQUIRED_DRAFT_FILES) {
    const path = join(draftDir, file)
    if (!existsSync(path) || statSync(path).size === 0) throw new Error(`Agent draft 缺少有效文件：${file}`)
  }
  return {
    indexHtml: readFileSync(join(draftDir, 'index.html'), 'utf8'),
    stylesCss: readFileSync(join(draftDir, 'styles.css'), 'utf8'),
    scriptJs: readFileSync(join(draftDir, 'script.js'), 'utf8'),
  }
}

function readAgentJob(jobId, options = {}) {
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const jobDir = join(jobRoot, jobId)
  return { jobDir, job: readJsonRequired(join(jobDir, 'job.json'), `找不到任务：${jobId}`) }
}

function assertAgentJob(job) {
  if (job.mode !== 'codex-agent') throw new Error(`任务不是 codex-agent 模式：${job.mode || 'legacy'}`)
}

function assertInputUnchanged(jobDir, expectedHash) {
  const actualHash = hashDirectory(join(jobDir, '00-input'))
  if (actualHash !== expectedHash) throw new Error('00-input 在 Agent 任务创建后发生变化；拒绝继续以避免事实漂移')
}

function assertConstraintPackUnchanged(jobDir) {
  const manifest = readJsonRequired(join(jobDir, 'agent', 'constraint-manifest.json'))
  if (manifest.version !== CONSTRAINT_PACK_VERSION) throw new Error(`约束包版本不兼容：${manifest.version}`)
  const actualHash = hashFile(join(jobDir, 'agent', 'constraint-pack.md'))
  if (actualHash !== manifest.constraintPackHash) throw new Error('Agent 约束包在任务创建后发生变化；拒绝继续以避免约束漂移')
}

function attachConstraintCoverage(validation, jobDir) {
  const manifest = readJsonRequired(join(jobDir, 'agent', 'constraint-manifest.json'))
  const plan = existsSync(join(jobDir, 'agent', 'implementation-plan.json'))
    ? readJsonRequired(join(jobDir, 'agent', 'implementation-plan.json'))
    : null
  validation.constraintCoverage = buildConstraintCoverage({ manifest, plan, validationOk: validation.ok })
}

function resolveAgentTarget(jobDir) {
  const path = join(jobDir, '00-input', 'export-options.json')
  if (!existsSync(path)) return 'web'
  const value = readJsonRequired(path)
  return value?.exportOptions?.targetPlatform === 'app' || value?.targetPlatform === 'app' ? 'app' : 'web'
}

function readManifest(jobDir) {
  return readJsonRequired(join(jobDir, 'agent', 'manifest.json'), '缺少 agent/manifest.json')
}

function updateAgentJob(jobDir, job, patch) {
  const updated = { ...job, ...patch, updatedAt: new Date().toISOString() }
  writeJsonAtomic(join(jobDir, 'job.json'), updated)
  return updated
}

function replaceAgentGenerationPhase(phases = [], status, message, artifacts) {
  const next = phases.filter((phase) => phase.phase !== 'agent-generation' && phase.phase !== 'agent-repair')
  next.push({
    phase: status === 'done' ? 'agent-generation' : 'agent-repair',
    status,
    message,
    endedAt: new Date().toISOString(),
    artifacts,
    tokenUsage: { source: 'current-codex', available: false },
  })
  return next
}

function recordAgentRepair(jobDir, job, draftDir, validation) {
  const validationPath = join(jobDir, 'agent', 'validation.json')
  writeJsonAtomic(validationPath, validation)
  const manifest = readManifest(jobDir)
  manifest.stage = 'repair'
  manifest.status = 'needs-repair'
  manifest.updatedAt = new Date().toISOString()
  manifest.nextCommand = `npm run --silent cli -- agent-inspect ${job.jobId} --issues --json`
  writeJsonAtomic(join(jobDir, 'agent', 'manifest.json'), manifest)
  const updated = updateAgentJob(jobDir, job, {
    status: 'needs-repair',
    agentStage: 'repair',
    progress: { phase: 'agent-repair', percent: 85, message: `直接文件校验失败：${validation.errors.length} 个错误` },
    validationPath,
    phaseDetails: replaceAgentGenerationPhase(job.phaseDetails, 'error', '直接文件校验失败', REQUIRED_DRAFT_FILES.map((file) => join(draftDir, file))),
  })
  return { ok: false, status: 'needs-repair', job: updated, validation, validationPath }
}

function completedPhase(phase, message, artifacts) {
  const now = new Date().toISOString()
  return { phase, status: 'done', startedAt: now, endedAt: now, durationMs: 0, message, artifacts, tokenUsage: { source: 'deterministic', available: false } }
}

function awaitingPhase(phase, message) {
  return { phase, status: 'awaiting-codex', message, artifacts: [], tokenUsage: { source: 'current-codex', available: false } }
}

function flattenNodes(nodes) {
  const result = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    result.push(node)
    for (const child of node.children || []) visit(child)
  }
  for (const node of nodes) visit(node)
  return result
}

function hashDirectory(directory) {
  const hash = createHash('sha256')
  for (const file of collectFiles(directory)) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(directory, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function collectFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(root, path))
    else if (entry.isFile()) files.push(relativePath(root, path))
  }
  return files.sort()
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

function readJsonRequired(path, message = `缺少或无法读取 JSON：${path}`) {
  if (!existsSync(path)) throw new Error(message)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${message}（${error.message}）`)
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

function refreshAgentBatch(batch) {
  for (const page of batch.pages || []) {
    if (!page.jobId) continue
    const jobPath = join(batch.jobRoot, page.jobId, 'job.json')
    if (!existsSync(jobPath)) {
      page.status = 'error'
      page.error = `找不到页面任务：${page.jobId}`
      continue
    }
    const job = readJsonRequired(jobPath)
    page.status = job.status
    page.agentStage = job.agentStage
    page.outputDir = job.outputDir
    page.error = job.error
  }

  const doneCount = batch.pages.filter((page) => page.status === 'done').length
  const repairCount = batch.pages.filter((page) => ['needs-repair', 'error'].includes(page.status)).length
  const nextPage = batch.pages.find((page) => page.status !== 'done') || null
  batch.status = doneCount === batch.pages.length
    ? 'done'
    : repairCount > 0
      ? 'needs-repair'
      : 'awaiting-codex'
  batch.summary = {
    total: batch.pages.length,
    done: doneCount,
    awaitingCodex: batch.pages.filter((page) => page.status === 'awaiting-codex').length,
    needsRepair: repairCount,
  }
  batch.nextPage = nextPage
    ? {
        id: nextPage.id,
        route: nextPage.route,
        jobId: nextPage.jobId || null,
        status: nextPage.status,
        agentStage: nextPage.agentStage || null,
        statusCommand: nextPage.jobId
          ? `npm run --silent cli -- agent-status ${nextPage.jobId} --job-root ${batch.jobRoot} --json`
          : null,
      }
    : null
  batch.mergePrepareCommand = batch.status === 'done' ? buildMergePrepareCommand(batch) : null
  batch.updatedAt = new Date().toISOString()
  writeAgentBatch(batch)
  return batch
}

function writeAgentBatch(batch) {
  writeJsonAtomic(join(batch.batchDir, 'batch.json'), batch)
}
