import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_ENTRY = resolve(PROJECT_ROOT, 'cli', 'src', 'index.js')

export const CODEX_MASTERGO_ENV = Object.freeze({
  LLM_BACKEND: 'codex-sdk',
  LLM_CONNECT_TIMEOUT_MS: '900000',
  LLM_IDLE_TIMEOUT_MS: '900000',
  LAYOUT_ANALYSIS_TIMEOUT_MS: '2400000',
  PAGE_PLAN_TIMEOUT_MS: '2400000',
  PLAN_AND_GENERATE_TIMEOUT_MS: '2400000',
})

export function buildGenerateFromMasterGoArgs(args = []) {
  const forwarded = [...args]
  if (!forwarded.includes('--export-timeout-ms')) {
    forwarded.push('--export-timeout-ms', '600000')
  }
  if (!forwarded.includes('--json')) forwarded.push('--json')
  return [CLI_ENTRY, 'generate-from-mastergo', ...forwarded]
}

export function buildCodexMasterGoEnv(baseEnv = process.env) {
  return { ...baseEnv, ...CODEX_MASTERGO_ENV }
}

function main() {
  const child = spawn(process.execPath, buildGenerateFromMasterGoArgs(process.argv.slice(2)), {
    cwd: PROJECT_ROOT,
    env: buildCodexMasterGoEnv(),
    stdio: 'inherit',
  })

  child.once('error', (error) => {
    console.error(`Failed to start MasterGo generation: ${error.message}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`MasterGo generation stopped by signal ${signal}`)
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 1
  })
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main()
