#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_FILES = ['index.html', 'styles.css', 'script.js']
const args = process.argv.slice(2)

function readOption(name, fallback = undefined) {
  const index = args.indexOf(name)
  if (index === -1 || index === args.length - 1) return fallback
  return args[index + 1]
}

function hasFlag(name) {
  return args.includes(name)
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function findRepositoryRoot(...starts) {
  for (const start of starts.filter(Boolean)) {
    let current = resolve(start)
    while (true) {
      if (existsSync(join(current, 'cli', 'src', 'index.js')) && existsSync(join(current, 'mcp-server', 'src', 'workflow', 'html-generation.js'))) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  throw new Error('没有找到 mastergo2html 仓库。请从仓库根目录运行，或传入 --repo-root <目录>。')
}

function resolvePaths() {
  const explicitJobDir = readOption('--job-dir')
  const explicitOutputDir = readOption('--output-dir')
  const repoRoot = findRepositoryRoot(readOption('--repo-root'), process.cwd(), explicitJobDir, explicitOutputDir)
  let jobDir
  if (explicitJobDir) {
    jobDir = resolve(explicitJobDir)
  } else if (explicitOutputDir) {
    jobDir = dirname(resolve(explicitOutputDir))
  } else {
    const jobId = readOption('--job-id')
    if (!jobId) throw new Error('缺少任务定位参数：请传入 --job-id <id> 或 --job-dir <目录>。')
    const jobRoot = resolve(readOption('--job-root', join(repoRoot, '.mastergo2html', 'jobs')))
    jobDir = join(jobRoot, jobId)
  }
  const outputDir = resolve(explicitOutputDir || join(jobDir, '05-output'))
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(outputDir, file))) throw new Error(`输出目录缺少 ${file}：${outputDir}`)
  }
  if (!existsSync(join(jobDir, '01-normalized')) || !existsSync(join(jobDir, '02-layout'))) {
    throw new Error(`任务目录缺少静态校验上下文：${jobDir}`)
  }
  return { repoRoot, jobDir, outputDir }
}

async function loadValidators(repoRoot) {
  const htmlModule = await import(pathToFileURL(join(repoRoot, 'mcp-server', 'src', 'workflow', 'html-generation.js')).href)
  const responsiveModule = await import(pathToFileURL(join(repoRoot, 'mcp-server', 'src', 'workflow', 'responsive-runtime-validation.js')).href)
  return {
    buildContext: htmlModule.buildHtmlGenerationContext,
    validateFiles: htmlModule.validateGeneratedFiles,
    validateResponsive: responsiveModule.runResponsiveRuntimeValidation,
  }
}

function readOutputFiles(outputDir) {
  return {
    indexHtml: readFileSync(join(outputDir, 'index.html'), 'utf8'),
    stylesCss: readFileSync(join(outputDir, 'styles.css'), 'utf8'),
    scriptJs: readFileSync(join(outputDir, 'script.js'), 'utf8'),
  }
}

function summarize(report) {
  return {
    ok: report.ok === true && (report.warnings || []).length === 0,
    staticOk: report.ok === true,
    errorCount: (report.errors || []).length,
    warningCount: (report.warnings || []).length,
    checkedAt: report.checkedAt,
    responsiveStatus: report.responsiveRuntime?.status || 'not-run',
    responsiveOk: report.responsiveRuntime?.ok ?? null,
  }
}

async function validateCurrentOutput({ validators, jobDir, outputDir, write = true, runResponsive = true, repairMeta = null }) {
  const context = validators.buildContext(jobDir)
  const report = validators.validateFiles(readOutputFiles(outputDir), context)
  let responsiveRuntime = { status: 'skipped', ok: true, blocking: false, warnings: [] }
  if (runResponsive) {
    try {
      responsiveRuntime = await validators.validateResponsive({
        outputDir,
        contract: context.pageLayout?.responsiveContract,
      })
    } catch (error) {
      responsiveRuntime = {
        version: 'mastergo2html.responsive-runtime-validation.v1',
        status: 'warning',
        ok: false,
        blocking: false,
        autoFixed: false,
        warnings: [`响应式运行时检测未完成：${error.message}`],
        checkedAt: new Date().toISOString(),
      }
    }
  }
  report.responsiveRuntime = responsiveRuntime
  report.warnings = [...new Set([
    ...(report.warnings || []),
    ...(responsiveRuntime?.warnings || []).map((warning) => `响应式运行时检测：${warning}`),
  ])]
  if (repairMeta) report.localAgentRepair = repairMeta
  if (write) writeFileSync(join(outputDir, 'static-validation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function snapshotFiles(outputDir, destination) {
  mkdirSync(destination, { recursive: true })
  for (const file of [...REQUIRED_FILES, 'static-validation.json']) {
    const source = join(outputDir, file)
    if (existsSync(source)) copyFileSync(source, join(destination, file))
  }
}

function restoreFiles(outputDir, sourceDir) {
  for (const file of [...REQUIRED_FILES, 'static-validation.json']) {
    const source = join(sourceDir, file)
    if (existsSync(source)) copyFileSync(source, join(outputDir, file))
  }
}

function isRegression(before, after) {
  const a = summarize(before)
  const b = summarize(after)
  if (b.errorCount !== a.errorCount) return b.errorCount > a.errorCount
  return b.warningCount > a.warningCount
}

function hasProgress(before, after) {
  const a = summarize(before)
  const b = summarize(after)
  return b.errorCount < a.errorCount || (b.errorCount === a.errorCount && b.warningCount < a.warningCount)
}

function buildPrompt({ repoRoot, jobDir, outputDir, report, validationCommand, round, maxRounds }) {
  const firstErrors = (report.errors || []).slice(0, 30)
  const firstWarnings = (report.warnings || []).slice(0, 20)
  const implementationManifest = join(outputDir, 'implementation-manifest.json')
  const decisionSource = existsSync(implementationManifest)
    ? `实施清单：${implementationManifest}`
    : `历史装配计划：${join(jobDir, '04-assembly', 'assembly.plan.md')}`
  return `# MasterGo2HTML 本地 Agent 静态校验修复\n\n你正在修复已生成的 MasterGo HTML。当前是第 ${round}/${maxRounds} 轮。\n\n## 写入边界\n\n只允许修改：\n- ${join(outputDir, 'index.html')}\n- ${join(outputDir, 'styles.css')}\n- ${join(outputDir, 'script.js')}\n\n禁止修改 assets、static-validation.json、implementation-manifest.json、00-input、01-normalized、02-layout、03-page-plans、04-assembly、仓库源码和其他任务。不得删除或替换已有静态资源。\n\n## 必读事实源\n\n- 完整校验报告：${join(outputDir, 'static-validation.json')}\n- Frame 截图：${join(jobDir, '00-input', 'frame-screenshot.png')}\n- 页面布局：${join(jobDir, '02-layout', 'page-layout.json')}\n- 布局说明：${join(jobDir, '02-layout', 'page-layout.md')}\n- 节点样式事实：${join(jobDir, '01-normalized', 'node-style-facts.json')}\n- 不可变文本：${join(jobDir, '01-normalized', 'source-texts.json')}\n- 资源索引：${join(jobDir, '01-normalized', 'asset-index.json')}\n- ${decisionSource}\n\n## 当前结果\n\n- errors: ${(report.errors || []).length}\n- warnings: ${(report.warnings || []).length}\n- responsive: ${report.responsiveRuntime?.status || 'not-run'}\n\n优先修复以下错误，但必须读取完整 JSON，不能只处理摘要：\n${firstErrors.length ? firstErrors.map((item, index) => `${index + 1}. ${item}`).join('\n') : '- 无'}\n\n当前警告摘要：\n${firstWarnings.length ? firstWarnings.map((item, index) => `${index + 1}. ${item}`).join('\n') : '- 无'}\n\n## 修复规则\n\n1. 以 source node bounds、node-style-facts、page-layout 和 asset-index 为事实源，不凭视觉常识猜坐标、颜色、字体或资源。\n2. 保留 data-source-node-id、data-style-source-node-id、data-text-source-node-id、data-asset-id 与 data-action 绑定。\n3. 不使用网络资源、不手绘 inline SVG、不编造图片路径，不将背景装饰转换为内容流间距。\n4. 优先做可验证的小改动；先处理重复出现的根因，再处理单点问题。\n5. 桌面基准优先精确还原；响应式修复不得破坏桌面源坐标。页面不得产生横向滚动。\n6. 不要通过删除内容、隐藏节点、删除 source 绑定、修改校验报告或放宽校验规则来“消除”错误。\n7. 修复后运行：\n\n\`\`\`bash\n${validationCommand}\n\`\`\`\n\n根据新报告继续修复，直到 errors 和 warnings 均为 0，或确认剩余问题需要缺失资源/设计输入。结束时简要说明改动文件、错误数量变化和仍未解决的问题。\n\n仓库根目录仅用于读取校验器：${repoRoot}\n`
}

function runProcess(command, commandArgs, { cwd, stdinText = null, outputPath = null }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: [stdinText == null ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      env: process.env,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (outputPath && !existsSync(outputPath)) writeFileSync(outputPath, `agent exited: code=${code}, signal=${signal || ''}\n`, 'utf8')
      resolvePromise({ code: code ?? 1, signal })
    })
    if (stdinText != null) child.stdin.end(stdinText)
  })
}

async function runAgent({ agent, prompt, promptPath, outputDir, model, lastMessagePath }) {
  if (agent === 'codex') {
    const command = readOption('--agent-bin', 'codex')
    const commandArgs = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '--cd', outputDir,
      '--output-last-message', lastMessagePath,
      ...(model ? ['--model', model] : []),
      '-',
    ]
    return runProcess(command, commandArgs, { cwd: outputDir, stdinText: prompt, outputPath: lastMessagePath })
  }
  if (agent === 'opencode') {
    const command = readOption('--agent-bin', 'opencode')
    const instruction = `Read ${promptPath} and execute it completely. Edit only the files allowed by that prompt.`
    const commandArgs = ['run', ...(model ? ['--model', model] : []), instruction]
    return runProcess(command, commandArgs, { cwd: outputDir, outputPath: lastMessagePath })
  }
  throw new Error(`不支持的本地 Agent：${agent}。可选值：codex、opencode。`)
}

function printResult(payload, json) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(`jobDir: ${payload.jobDir}`)
  console.log(`outputDir: ${payload.outputDir}`)
  console.log(`reportPath: ${payload.reportPath}`)
  console.log(`status: ${payload.status}`)
  console.log(`errors: ${payload.summary.errorCount}`)
  console.log(`warnings: ${payload.summary.warningCount}`)
  if (payload.runDir) console.log(`repairRunDir: ${payload.runDir}`)
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`用法：\n  node skills/mastergo2html/scripts/repair-html-with-agent.mjs --job-id <id> [--agent codex|opencode] [--max-rounds 3] [--json]\n  node skills/mastergo2html/scripts/repair-html-with-agent.mjs --job-dir <dir> --validate-only [--json]\n\n参数：\n  --job-root <dir>       jobId 所在任务根目录，支持 page-batch jobs\n  --output-dir <dir>     默认 <jobDir>/05-output\n  --repo-root <dir>      mastergo2html 仓库根目录\n  --agent <name>         默认 codex，可选 codex/opencode\n  --agent-bin <path>     覆盖本地 Agent 可执行文件\n  --model <name>         可选 Agent 模型\n  --max-rounds <n>       默认 3\n  --validate-only        只重新生成 static-validation.json\n  --dry-run              生成首轮 prompt 和备份，但不启动 Agent\n  --no-responsive        跳过 Chrome 多视口运行时校验\n  --no-restore           校验问题变多时不自动恢复上一轮文件\n  --json                 JSON 输出`)
    return
  }

  const paths = resolvePaths()
  const validators = await loadValidators(paths.repoRoot)
  const runResponsive = !hasFlag('--no-responsive')
  const initial = await validateCurrentOutput({
    validators,
    jobDir: paths.jobDir,
    outputDir: paths.outputDir,
    runResponsive,
  })

  if (hasFlag('--validate-only')) {
    const payload = {
      status: summarize(initial).ok ? 'clean' : 'issues',
      ...paths,
      reportPath: join(paths.outputDir, 'static-validation.json'),
      summary: summarize(initial),
    }
    printResult(payload, hasFlag('--json'))
    return
  }

  const agent = readOption('--agent', 'codex').toLowerCase()
  const model = readOption('--model')
  const maxRounds = positiveInteger(readOption('--max-rounds'), 3)
  const runDir = join(paths.jobDir, 'agent-repair', timestamp())
  const backupsDir = join(runDir, 'backups')
  mkdirSync(backupsDir, { recursive: true })
  const validationCommand = `node ${shellQuote(join(paths.repoRoot, 'skills', 'mastergo2html', 'scripts', 'repair-html-with-agent.mjs'))} --job-dir ${shellQuote(paths.jobDir)} --validate-only${runResponsive ? '' : ' --no-responsive'} --json`

  let current = initial
  let status = summarize(current).ok ? 'clean' : 'not-started'
  const history = [{ round: 0, summary: summarize(current) }]

  if (!summarize(current).ok) {
    for (let round = 1; round <= maxRounds; round += 1) {
      const backupDir = join(backupsDir, `round-${round}`)
      snapshotFiles(paths.outputDir, backupDir)
      const promptPath = join(runDir, `round-${round}.prompt.md`)
      const lastMessagePath = join(runDir, `round-${round}.agent-last-message.md`)
      const prompt = buildPrompt({
        ...paths,
        report: current,
        validationCommand,
        round,
        maxRounds,
      })
      writeFileSync(promptPath, prompt, 'utf8')

      if (hasFlag('--dry-run')) {
        status = 'dry-run'
        break
      }

      const agentResult = await runAgent({ agent, prompt, promptPath, outputDir: paths.outputDir, model, lastMessagePath })
      const next = await validateCurrentOutput({
        validators,
        jobDir: paths.jobDir,
        outputDir: paths.outputDir,
        runResponsive,
        repairMeta: { agent, round, agentExitCode: agentResult.code, promptPath, lastMessagePath },
      })
      history.push({ round, agentExitCode: agentResult.code, summary: summarize(next) })

      if (isRegression(current, next) && !hasFlag('--no-restore')) {
        restoreFiles(paths.outputDir, backupDir)
        current = await validateCurrentOutput({ validators, jobDir: paths.jobDir, outputDir: paths.outputDir, runResponsive })
        status = 'regression-restored'
        break
      }

      const progressed = hasProgress(current, next)
      current = next
      if (summarize(current).ok) {
        status = 'clean'
        break
      }
      if (agentResult.code !== 0) {
        status = 'agent-error'
        break
      }
      if (!progressed) {
        status = 'no-progress'
        break
      }
      status = round === maxRounds ? 'max-rounds' : 'improved'
    }
  }

  const payload = {
    status,
    agent,
    ...paths,
    reportPath: join(paths.outputDir, 'static-validation.json'),
    runDir,
    summary: summarize(current),
    history,
  }
  writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  printResult(payload, hasFlag('--json'))
}

main().catch((error) => {
  console.error(`[mastergo2html-agent-repair] ${error.message}`)
  process.exitCode = 1
})
