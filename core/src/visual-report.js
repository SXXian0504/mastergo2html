import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PNG } from 'pngjs'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

export async function captureAndCompare({
  outputDir,
  referencePath,
  reportDir,
  width,
  height,
  label = 'first-pass',
  chromePath = process.env.CHROME_PATH,
  timeoutMs = 45_000,
} = {}) {
  mkdirSync(reportDir, { recursive: true })
  const screenshotPath = join(reportDir, `${label}.png`)
  const diffPath = join(reportDir, `${label}-diff.png`)
  const reportPath = join(reportDir, `${label}-visual-report.json`)
  const executable = resolveChrome(chromePath)
  let result
  if (!executable) {
    result = skipped('Chrome/Chromium is unavailable; screenshot and pixel comparison were skipped.', screenshotPath, diffPath)
  } else {
    try {
      await captureWithChrome({ executable, outputDir, screenshotPath, width, height, timeoutMs })
      const comparison = existsSync(referencePath)
        ? comparePng(referencePath, screenshotPath, diffPath)
        : { status: 'skipped', warning: 'Reference screenshot is missing.' }
      result = {
        version: 'mastergo2html.visual-report.v1',
        status: 'captured',
        blocking: false,
        screenshotPath,
        screenshotSizeBytes: statSync(screenshotPath).size,
        referencePath: existsSync(referencePath) ? referencePath : null,
        diffPath: comparison.status === 'compared' ? diffPath : null,
        comparison,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      result = skipped(`Screenshot capture failed: ${error.message}`, screenshotPath, diffPath)
    }
  }
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return { ...result, reportPath }
}

function captureWithChrome({ executable, outputDir, screenshotPath, width, height, timeoutMs }) {
  const pagePath = join(resolve(outputDir), 'index.html')
  if (!existsSync(pagePath)) throw new Error('index.html is missing')
  mkdirSync(dirname(screenshotPath), { recursive: true })
  const viewportWidth = Math.max(320, Math.ceil(Number(width) || 1440))
  const viewportHeight = Math.max(320, Math.ceil(Number(height) || 900))
  const profilePath = join(tmpdir(), `mastergo2html-shot-${process.pid}-${Date.now()}`)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profilePath}`,
    `--window-size=${viewportWidth},${viewportHeight}`,
    `--screenshot=${resolve(screenshotPath)}`,
    `file://${pagePath}`,
  ]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Chrome timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 && existsSync(screenshotPath)) resolvePromise()
      else reject(new Error(stderr.trim() || `Chrome exited with code ${code}`))
    })
  })
}

function comparePng(referencePath, actualPath, diffPath) {
  try {
    const expected = PNG.sync.read(readFileSync(referencePath))
    const actual = PNG.sync.read(readFileSync(actualPath))
    const width = Math.max(expected.width, actual.width)
    const height = Math.max(expected.height, actual.height)
    const diff = new PNG({ width, height })
    let changedPixels = 0
    let totalDelta = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const expectedPixel = pixel(expected, x, y)
        const actualPixel = pixel(actual, x, y)
        const delta = Math.max(...expectedPixel.map((value, index) => Math.abs(value - actualPixel[index])))
        const offset = (width * y + x) << 2
        if (delta > 16) changedPixels += 1
        totalDelta += delta
        diff.data[offset] = delta > 16 ? 255 : actualPixel[0]
        diff.data[offset + 1] = delta > 16 ? 0 : actualPixel[1]
        diff.data[offset + 2] = delta > 16 ? 64 : actualPixel[2]
        diff.data[offset + 3] = 255
      }
    }
    writeFileSync(diffPath, PNG.sync.write(diff))
    const totalPixels = width * height
    return {
      status: 'compared',
      reviewOnly: true,
      expected: { width: expected.width, height: expected.height },
      actual: { width: actual.width, height: actual.height },
      changedPixels,
      changedPixelRatio: changedPixels / Math.max(1, totalPixels),
      meanMaxChannelDelta: totalDelta / Math.max(1, totalPixels),
      thresholdApplied: false,
    }
  } catch (error) {
    return { status: 'skipped', warning: `PNG comparison failed: ${error.message}` }
  }
}

function pixel(png, x, y) {
  if (x >= png.width || y >= png.height) return [0, 0, 0, 0]
  const offset = (png.width * y + x) << 2
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]]
}

function resolveChrome(explicitPath) {
  if (explicitPath && existsSync(explicitPath)) return explicitPath
  return CHROME_CANDIDATES.find(existsSync) || null
}

function skipped(warning, screenshotPath, diffPath) {
  return {
    version: 'mastergo2html.visual-report.v1',
    status: 'skipped',
    blocking: false,
    screenshotPath: null,
    diffPath: null,
    expectedScreenshotPath: screenshotPath,
    expectedDiffPath: diffPath,
    warnings: [warning],
    checkedAt: new Date().toISOString(),
  }
}
