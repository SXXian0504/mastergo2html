import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const targets = ['ui', 'main']
const children = targets.map((target) => spawn(process.execPath, [viteBin, 'build', '--mode', 'development', '--watch'], {
  cwd: root,
  env: {
    ...process.env,
    TARGET: target,
    NODE_ENV: 'development',
  },
  stdio: 'inherit',
}))

let stopping = false

function stopChildren(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopChildren(signal)
  })
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`Failed to start Vite watcher: ${error.message}`)
    process.exitCode = 1
    stopChildren()
  })
  child.on('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`Vite watcher exited unexpectedly (${signal || `code ${code}`}).`)
      process.exitCode = code || 1
      stopChildren()
    }
  })
}
