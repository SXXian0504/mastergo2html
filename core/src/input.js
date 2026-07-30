import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { extractStoredZip } from './zip.js'

export function validateInputPath(inputPath, options = {}) {
  const jobRoot = resolve(options.jobRoot || '.mastergo2html/jobs')
  const validationJobDir = join(jobRoot, '.input-validation')
  rmSync(validationJobDir, { recursive: true, force: true })
  const inputDir = prepareInput(inputPath, validationJobDir)
  const metadata = readInputMetadata(inputDir)
  const raw = JSON.parse(readFileSync(join(inputDir, 'raw.json'), 'utf8'))
  const assetManifest = JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8'))
  return {
    ok: true,
    inputPath: resolve(inputPath),
    preparedInputDir: inputDir,
    source: metadata.source,
    page: raw.page || null,
    selectionCount: Array.isArray(raw.selection) ? raw.selection.length : 0,
    assetCount: Array.isArray(assetManifest.assets) ? assetManifest.assets.length : 0,
    hasFrameScreenshot: existsSync(join(inputDir, 'frame-screenshot.png')),
  }
}

export function prepareInput(inputPath, jobDir) {
  const resolvedInput = resolve(inputPath)
  if (!existsSync(resolvedInput)) throw new Error(`输入不存在：${resolvedInput}`)

  mkdirSync(jobDir, { recursive: true })
  const inputDir = join(jobDir, '00-input')
  rmSync(inputDir, { recursive: true, force: true })

  const stat = statSync(resolvedInput)
  if (stat.isDirectory()) {
    copyInputDirectory(resolvedInput, inputDir)
  } else if (extname(resolvedInput).toLowerCase() === '.zip') {
    const names = extractStoredZip(resolvedInput, jobDir)
    if (!names.some((name) => name === '00-input/raw.json' || name === 'raw.json')) {
      throw new Error('ZIP 中缺少 raw.json。')
    }
    if (!existsSync(inputDir) && existsSync(join(jobDir, 'raw.json'))) {
      mkdirSync(inputDir, { recursive: true })
      for (const name of readdirSync(jobDir)) {
        if (name === '00-input') continue
        movePath(join(jobDir, name), join(inputDir, name))
      }
    }
  } else {
    throw new Error('输入必须是插件导出的 00-input.zip，或解压后的 00-input 目录。')
  }

  validateInputDir(inputDir)
  return inputDir
}

export function readInputMetadata(inputDir) {
  const exportOptionsPath = join(inputDir, 'export-options.json')
  if (!existsSync(exportOptionsPath)) {
    return {
      exportOptions: {},
      source: {
        pageId: 'unknown',
        pageName: 'unknown',
        selectionIds: [],
        selectionCount: 0,
      },
    }
  }

  const payload = JSON.parse(readFileSync(exportOptionsPath, 'utf8'))
  return {
    exportOptions: payload.exportOptions || {},
    source: payload.source || {
      pageId: 'unknown',
      pageName: 'unknown',
      selectionIds: [],
      selectionCount: 0,
    },
  }
}

function copyInputDirectory(sourceDir, inputDir) {
  const actualSource = basename(sourceDir) === '00-input' || existsSync(join(sourceDir, 'raw.json'))
    ? sourceDir
    : join(sourceDir, '00-input')
  if (!existsSync(actualSource) || !statSync(actualSource).isDirectory()) {
    throw new Error('目录输入必须是 00-input，或包含 00-input 子目录。')
  }
  copyDirectory(actualSource, inputDir)
}

function copyDirectory(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath)
    } else if (entry.isFile()) {
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, readFileSync(sourcePath))
    }
  }
}

function movePath(sourcePath, targetPath) {
  const stat = statSync(sourcePath)
  if (stat.isDirectory()) {
    copyDirectory(sourcePath, targetPath)
    rmSync(sourcePath, { recursive: true, force: true })
    return
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, readFileSync(sourcePath))
  rmSync(sourcePath, { force: true })
}

function validateInputDir(inputDir) {
  const requiredFiles = ['raw.json', 'asset-manifest.json', 'frame-screenshot.png']
  for (const file of requiredFiles) {
    if (!existsSync(join(inputDir, file))) throw new Error(`00-input 缺少必需文件：${file}`)
  }

  for (const file of ['raw.json', 'asset-manifest.json', 'export-options.json']) {
    const filePath = join(inputDir, file)
    if (existsSync(filePath)) JSON.parse(readFileSync(filePath, 'utf8'))
  }
}

export function assertSafeRelativePath(path) {
  const safePath = normalize(path)
  if (isAbsolute(safePath) || safePath.startsWith('..')) {
    throw new Error(`非法相对路径：${path}`)
  }
  return safePath
}
