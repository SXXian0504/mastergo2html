#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const demoRoot = resolve(root, 'task-workspaces/html-to-react-demo-20260805')
const demoApp = resolve(demoRoot, 'app')
const manifest = resolve(demoRoot, 'source-manifest.json')
const validator = resolve(root, 'skills/html2react/scripts/validate_project.py')
const healthUrl = process.env.MASTERGO_HEALTH_URL || 'http://127.0.0.1:12322/health'
const demoPort = Number(process.env.MASTERGO_DEMO_PORT || 4188)

const checks = []
const failures = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) failures.push({ name, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

function run(command, args, cwd, name) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  record(name, result.status === 0, output.split('\n').slice(-4).join(' | '))
  return result.status === 0
}

async function fetchHealth() {
  try {
    const response = await fetch(healthUrl)
    const body = await response.json()
    record('MasterGo bridge reachable', response.ok && body.ok === true, `${healthUrl}`)
    record('MasterGo LLM configured', body.llmConfigured === true, body.configErrors?.join('; ') || 'configured')
    record('MasterGo2Code default backend', body.llm?.provider === 'codex-sdk', `provider=${body.llm?.provider || 'unknown'}`)
  } catch (error) {
    record('MasterGo bridge reachable', false, `${healthUrl}: ${error.message}`)
    record('MasterGo LLM configured', false, 'health endpoint unavailable')
    record('MasterGo2Code default backend', false, 'health endpoint unavailable')
  }
}

function startServer() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', ['run', 'start', '--', '-p', String(demoPort)], {
      cwd: demoApp,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(demoPort) },
    })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolvePromise(child)
    }
    const onData = (chunk) => {
      if (/ready|started server|localhost/i.test(String(chunk))) finish()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', finish)
    child.once('exit', (code) => finish(new Error(`demo server exited before readiness (code ${code})`)))
    setTimeout(() => finish(new Error('demo server readiness timeout')), 15000).unref()
  })
}

async function smokeRoutes(child) {
  const routes = ['/', '/home', '/position', '/position/algorithm-engineer', '/campus-news', '/project/intern/qa', '/project/graduate/qa', '/feedback', '/legal']
  try {
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${demoPort}${route}`, { redirect: 'manual' })
      const ok = route === '/' ? response.status === 307 || response.status === 308 : response.status === 200
      record(`React route ${route}`, ok, `HTTP ${response.status}`)
    }
  } catch (error) {
    record('React route smoke test', false, error.message)
  } finally {
    child.kill('SIGTERM')
  }
}

async function main() {
  record('Frozen React demo exists', existsSync(demoApp), demoApp)
  record('React source manifest exists', existsSync(manifest), manifest)
  if (!existsSync(demoApp) || !existsSync(manifest)) process.exitCode = 1

  await fetchHealth()

  if (existsSync(demoApp) && existsSync(manifest)) {
    run('python3', [validator, '--profile', 'engineering', '--project', demoApp, '--manifest', manifest], root, 'React engineering validator')
    run('npm', ['run', 'audit:conversion'], demoApp, 'React conversion audit')
    run('npm', ['run', 'lint'], demoApp, 'React lint')
    run('npm', ['run', 'build'], demoApp, 'React production build')
    try {
      const child = await startServer()
      await smokeRoutes(child)
    } catch (error) {
      record('React server startup', false, error.message)
    }
  }

  console.log('')
  console.log(failures.length === 0
    ? 'READY: frozen React demo is ready; live generation backend is also aligned.'
    : `NOT READY: ${failures.length} check(s) failed. Do not use live generation in the user test until these are resolved.`)
  if (failures.some(({ name }) => name === 'MasterGo2Code default backend')) {
    console.log('ACTION: set LLM_BACKEND=codex-sdk for the bridge, restart it, and rerun this command; or present the frozen React demo only.')
  }
  console.log(`CHECKS: ${checks.filter((check) => check.ok).length}/${checks.length} passed`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

await main()
