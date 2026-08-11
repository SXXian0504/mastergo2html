import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/index.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'
import { buildLegacyConstraintCoverage } from '../../../core/src/constraint-service.js'
import { appendGenerationTargetPrompt, appTargetContext, isAppGenerationTarget } from './generation-target.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import {
  applySafeStaticFixes,
  buildHtmlGenerationSystemPrompt,
  copyAssets,
  isLikelyTruncatedJsonError,
  publishOutput,
  smokeTestOutput,
  summarizeStaticValidationWarnings,
  validateGeneratedFiles,
  writeGeneratedFiles,
} from './html-generation.js'
import { readOrCreateImmutableSourceTexts } from './immutable-source-texts.js'
import { readOrCreateNodeStyleFacts } from './node-style-facts.js'
import { runResponsiveRuntimeValidation } from './responsive-runtime-validation.js'
import { createStreamProgressReporter } from './stream-progress.js'

export const IMPLEMENTATION_MANIFEST_VERSION = 'mastergo2html.implementation-manifest.v1'
const TOP_LEVEL_KEYS = ['implementationManifest', 'index.html', 'styles.css', 'script.js']
const MANIFEST_KEYS = ['version', 'hoverRequired', 'hoverTargets', 'motionRequired', 'preserveSourceBounds', 'conflictDecisions', 'unresolvedRisks']
const MAX_MANIFEST_BYTES = 12 * 1024

export const PLAN_AND_GENERATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: TOP_LEVEL_KEYS,
  properties: {
    implementationManifest: {
      type: 'object',
      additionalProperties: false,
      required: MANIFEST_KEYS,
      properties: {
        version: { type: 'string', enum: [IMPLEMENTATION_MANIFEST_VERSION] },
        hoverRequired: { type: 'boolean' },
        hoverTargets: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
        motionRequired: { type: 'boolean' },
        preserveSourceBounds: { type: 'boolean' },
        conflictDecisions: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'refs', 'decision'],
            properties: {
              kind: { type: 'string', enum: ['layout', 'asset', 'interaction', 'ownership'] },
              refs: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 128 } },
              decision: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
        },
        unresolvedRisks: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['refs', 'risk'],
            properties: {
              refs: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 128 } },
              risk: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
        },
      },
    },
    'index.html': { type: 'string', minLength: 1 },
    'styles.css': { type: 'string', minLength: 1 },
    'script.js': { type: 'string', minLength: 1 },
  },
}

export async function runPlanAndGenerate({
  config,
  jobId,
  jobDir,
  timeoutMs = Number(process.env.PLAN_AND_GENERATE_TIMEOUT_MS || process.env.HTML_GENERATION_TIMEOUT_MS || DEFAULT_LONG_LLM_TIMEOUT_MS),
  connectTimeoutMs = Number(process.env.LLM_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  firstEventTimeoutMs = Number(process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.LLM_IDLE_TIMEOUT_MS || DEFAULT_IDLE_TIMEOUT_MS),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateTextFn,
  generateStream = generateTextFn || generateTextStreamDetailed,
  generateNonStream = generateTextFn || generateTextDetailed,
  smokeTestFn = smokeTestOutput,
  responsiveRuntimeTestFn = runResponsiveRuntimeValidation,
}) {
  const outputDir = join(jobDir, '05-output')
  const tempDir = join(jobDir, '.05-output-tmp')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  const context = buildPlanAndGenerateContext(jobDir)
  const target = context.targetPlatform === 'app' ? 'app' : 'web'
  const system = appendGenerationTargetPrompt(buildPlanAndGenerateSystemPrompt(target), 'plan-and-generate', context)
  const prompt = buildPlanAndGeneratePrompt(jobId, context)
  const promptName = 'plan-and-generate.prompt.md'
  const responseName = 'plan-and-generate.response.md'
  writeFileSync(join(tempDir, promptName), renderPromptLog(system, prompt), 'utf8')

  const startedAt = Date.now()
  const reportProgress = createStreamProgressReporter(onProgress)
  let result
  try {
    result = await generateWorkflowText({
      streamingEnabled,
      generateStream,
      generateNonStream,
      request: {
        config: {
          ...config,
          model: process.env.PLAN_AND_GENERATE_MODEL || process.env.HTML_GENERATION_MODEL || config.model,
        },
        system,
        prompt,
        temperature: Number(process.env.PLAN_AND_GENERATE_TEMPERATURE || process.env.HTML_GENERATION_TEMPERATURE || 0.15),
        maxTokens: Number(process.env.PLAN_AND_GENERATE_MAX_TOKENS || process.env.HTML_GENERATION_MAX_TOKENS || 32000),
        outputSchema: PLAN_AND_GENERATE_OUTPUT_SCHEMA,
      },
      timeoutMs,
      connectTimeoutMs,
      firstEventTimeoutMs,
      idleTimeoutMs,
      reportProgress,
      workflowAttempt: 1,
    })
  } catch (error) {
    if (error?.partialText) writeFileSync(join(tempDir, 'plan-and-generate.partial.attempt-1.md'), error.partialText, 'utf8')
    throw error
  }

  writeFileSync(join(tempDir, 'plan-and-generate.response.attempt-1.md'), result.text, 'utf8')
  writeFileSync(join(tempDir, responseName), result.text, 'utf8')

  let payload
  try {
    payload = parsePlanAndGenerateResponse(result.text)
  } catch (error) {
    const prefix = isLikelyTruncatedJsonError(error, result.text) ? '模型输出疑似被截断：' : ''
    throw new Error(`plan-and-generate 输出解析失败：${prefix}${error.message}。已保留第一轮原始响应，未重新请求模型。`)
  }

  context.implementationManifest = payload.implementationManifest
  const safeFixResult = applySafeStaticFixes(payload.files, context)
  const finalValidation = validateGeneratedFiles(safeFixResult.files, context)
  finalValidation.autoFixes = safeFixResult.fixes
  finalValidation.constraintCoverage = buildLegacyConstraintCoverage({
    workflow: 'plan-and-generate',
    target,
    validationOk: finalValidation.ok,
  })

  writeGeneratedFiles(tempDir, safeFixResult.files)
  writeFileSync(join(tempDir, 'implementation-manifest.json'), `${JSON.stringify(payload.implementationManifest, null, 2)}\n`, 'utf8')
  copyAssets(context.assetsDir, join(tempDir, 'assets'))
  await smokeTestFn(tempDir)
  const responsiveRuntime = await responsiveRuntimeTestFn({
    outputDir: tempDir,
    contract: context.pageLayout?.responsiveContract,
  })
  finalValidation.responsiveRuntime = responsiveRuntime
  finalValidation.warnings = [...new Set([
    ...(finalValidation.warnings || []),
    ...(responsiveRuntime?.warnings || []).map((warning) => `响应式运行时检测：${warning}`),
  ])]
  writeFileSync(join(tempDir, 'static-validation.json'), JSON.stringify(finalValidation, null, 2), 'utf8')

  publishOutput(tempDir, outputDir)
  const validationWarnings = summarizeStaticValidationWarnings(finalValidation)
  if (!finalValidation.ok) validationWarnings.unshift('第一轮 HTML 已生成，但本地静态校验未通过；已保留第一轮结果，不再重新请求模型。')
  return {
    outputPath: outputDir,
    promptPath: join(outputDir, promptName),
    responsePath: join(outputDir, responseName),
    manifestPath: join(outputDir, 'implementation-manifest.json'),
    validationPath: join(outputDir, 'static-validation.json'),
    implementationManifest: payload.implementationManifest,
    staticValidation: finalValidation,
    responsiveRuntime,
    validationWarnings,
    streamMode: result.streamMode || (streamingEnabled ? 'stream' : 'non-stream-fallback'),
    durationMs: Date.now() - startedAt,
    tokenUsage: result.usage || emptyUsage(),
    artifacts: [
      outputDir,
      join(outputDir, promptName),
      join(outputDir, responseName),
      join(outputDir, 'implementation-manifest.json'),
      join(outputDir, 'static-validation.json'),
    ],
  }
}

export function buildPlanAndGenerateContext(jobDir) {
  const normalizedDir = join(jobDir, '01-normalized')
  const layoutDir = join(jobDir, '02-layout')
  const plansDir = join(jobDir, '03-page-plans')
  const assetIndex = readJsonRequired(join(normalizedDir, 'asset-index.json'))
  const normalizedPath = join(normalizedDir, 'raw.normalized.json')
  const normalized = readJsonRequired(normalizedPath)
  const exportOptions = readJson(join(jobDir, '00-input', 'export-options.json'), {})
  const interactionStates = normalized.interactionStates?.stateCount > 1 ? normalized.interactionStates : null
  const context = {
    ...appTargetContext(exportOptions),
    ...(interactionStates ? { interactionStates } : {}),
    pageLayout: readJsonRequired(join(layoutDir, 'page-layout.json')),
    componentStructurePlan: readTextRequired(join(plansDir, 'component-structure.plan.md')),
    staticAssetsPlan: readTextRequired(join(plansDir, 'static-assets.plan.md')),
    interactionPlan: readTextRequired(join(plansDir, 'interaction.plan.md')),
    assetIndex,
    fontAssets: readJson(join(normalizedDir, 'font-assets.json'), { version: 'mastergo2html.font-assets.v1', fonts: [], files: [] }),
    designTokens: readJsonRequired(join(normalizedDir, 'design-tokens.json')),
    sourceTexts: readOrCreateImmutableSourceTexts(join(normalizedDir, 'source-texts.json'), normalizedPath),
    nodeStyleFacts: readOrCreateNodeStyleFacts(join(normalizedDir, 'node-style-facts.json'), normalizedPath, assetIndex),
    assetsDir: join(jobDir, '00-input', 'assets'),
  }
  if (!existsSync(context.assetsDir)) throw new Error('plan-and-generate 缺少资源目录：00-input/assets')
  return context
}

export function parsePlanAndGenerateResponse(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  assertExactKeys(parsed, TOP_LEVEL_KEYS, '模型输出')
  const manifest = validateImplementationManifest(parsed.implementationManifest)
  for (const file of ['index.html', 'styles.css', 'script.js']) {
    if (typeof parsed[file] !== 'string' || !parsed[file].trim()) throw new Error(`缺少有效文件：${file}`)
  }
  return {
    implementationManifest: manifest,
    files: {
      indexHtml: parsed['index.html'],
      stylesCss: parsed['styles.css'],
      scriptJs: parsed['script.js'],
    },
  }
}

export function validateImplementationManifest(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, 'implementationManifest')
  if (manifest.version !== IMPLEMENTATION_MANIFEST_VERSION) throw new Error(`implementationManifest.version 无效：${manifest.version || 'missing'}`)
  for (const field of ['hoverRequired', 'motionRequired', 'preserveSourceBounds']) {
    if (typeof manifest[field] !== 'boolean') throw new Error(`implementationManifest.${field} 必须是 boolean`)
  }
  validateStringArray(manifest.hoverTargets, 'implementationManifest.hoverTargets', 32, 128)
  validateDecisionList(manifest.conflictDecisions)
  validateRiskList(manifest.unresolvedRisks)
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_BYTES) throw new Error('implementationManifest 超过 12 KB 上限')
  return manifest
}

export function buildPlanAndGenerateSystemPrompt(target) {
  return [
    buildHtmlGenerationSystemPrompt(target, { workflow: 'plan-and-generate', includeImplementationManifest: true }),
    '',
    '当前阶段同时负责页面级裁决和最终实现。先在内部统一组件、资源、交互、布局、层级、响应式和文件组织，再直接生成最终代码；不得输出独立规划文档或推理过程。',
    '三份计划冲突时，事实优先级为：node-style-facts.json > asset-index 与节点切片事实 > 三角色计划 > page-layout.json > design-token 语义推断。证据不足时采用保守实现，并只在 unresolvedRisks 中记录简短风险。',
    'implementationManifest 只记录实际发生的冲突和机器校验所需布尔值。没有冲突或风险时返回空数组，不得用摘要、逐模块计划或资源清单填充。',
  ].join('\n')
}

export function buildPlanAndGeneratePrompt(jobId, context) {
  return [
    `jobId: ${jobId}`,
    ...(isAppGenerationTarget(context) ? ['generationTarget: app（移动 App 页面 HTML 预览）'] : []),
    ...(context.interactionStates ? [`interactionStates: ${JSON.stringify(context.interactionStates)}`] : []),
    '请在单次响应内完成页面级冲突裁决和最终单页面代码。不要复述输入，不要生成 Assembly Markdown。',
    `输出 JSON Schema：${JSON.stringify(PLAN_AND_GENERATE_OUTPUT_SCHEMA)}`,
    `## node-style-facts.json\n${JSON.stringify(context.nodeStyleFacts)}`,
    `## page-layout.json\n${JSON.stringify(context.pageLayout)}`,
    `## component-structure.plan.md\n${context.componentStructurePlan}`,
    `## static-assets.plan.md\n${context.staticAssetsPlan}`,
    `## interaction.plan.md\n${context.interactionPlan}`,
    `## source-texts.json\n${JSON.stringify(context.sourceTexts)}`,
    `## asset-index.json\n${JSON.stringify(context.assetIndex)}`,
    `## font-assets.json\n${JSON.stringify(context.fontAssets)}`,
    `## design-tokens.json\n${JSON.stringify(context.designTokens)}`,
  ].join('\n\n')
}

function validateDecisionList(items) {
  if (!Array.isArray(items) || items.length > 20) throw new Error('implementationManifest.conflictDecisions 必须是最多 20 项的数组')
  for (const [index, item] of items.entries()) {
    assertExactKeys(item, ['kind', 'refs', 'decision'], `implementationManifest.conflictDecisions[${index}]`)
    if (!['layout', 'asset', 'interaction', 'ownership'].includes(item.kind)) throw new Error(`implementationManifest.conflictDecisions[${index}].kind 无效`)
    validateStringArray(item.refs, `implementationManifest.conflictDecisions[${index}].refs`, 6, 128)
    validateString(item.decision, `implementationManifest.conflictDecisions[${index}].decision`, 240)
  }
}

function validateRiskList(items) {
  if (!Array.isArray(items) || items.length > 20) throw new Error('implementationManifest.unresolvedRisks 必须是最多 20 项的数组')
  for (const [index, item] of items.entries()) {
    assertExactKeys(item, ['refs', 'risk'], `implementationManifest.unresolvedRisks[${index}]`)
    validateStringArray(item.refs, `implementationManifest.unresolvedRisks[${index}].refs`, 6, 128)
    validateString(item.risk, `implementationManifest.unresolvedRisks[${index}].risk`, 240)
  }
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`)
  const expected = new Set(keys)
  const missing = keys.filter((key) => !(key in value))
  const extra = Object.keys(value).filter((key) => !expected.has(key))
  if (missing.length > 0) throw new Error(`${label} 缺少字段：${missing.join('、')}`)
  if (extra.length > 0) throw new Error(`${label} 包含不允许的字段：${extra.join('、')}`)
}

function validateStringArray(value, label, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 必须是最多 ${maxItems} 项的数组`)
  value.forEach((item, index) => validateString(item, `${label}[${index}]`, maxLength))
}

function validateString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label} 必须是 1-${maxLength} 字符的字符串`)
}

function renderPromptLog(system, prompt) {
  return `# plan-and-generate Prompt\n\n## System\n\n${system}\n\n## User\n\n${prompt}\n`
}

function readTextRequired(path) {
  if (!existsSync(path)) throw new Error(`plan-and-generate 缺少必要输入：${path}`)
  return readFileSync(path, 'utf8')
}

function readJsonRequired(path) {
  return JSON.parse(readTextRequired(path))
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }
}
