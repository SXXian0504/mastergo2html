import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const DELIVERY_FILES = new Set(['index.html', 'styles.css', 'script.js'])

export function packageOutputDirectory(outputDir, zipPath) {
  const files = collectDeliveryFiles(outputDir)
  if (!files.some((file) => file.name === 'index.html')) {
    throw new Error('输出目录缺少 index.html，无法打包')
  }

  const archive = createStoredZip(files)
  mkdirSync(dirname(zipPath), { recursive: true })
  writeFileSync(zipPath, archive)
  return { zipPath, fileCount: files.length, sizeBytes: archive.length }
}

export function packageDirectory(directory, zipPath) {
  const files = []
  if (isDirectory(directory)) collectDirectoryFiles(directory, directory, files)
  const archive = createStoredZip(files)
  mkdirSync(dirname(zipPath), { recursive: true })
  writeFileSync(zipPath, archive)
  return { zipPath, fileCount: files.length, sizeBytes: archive.length }
}

export function collectDeliveryFiles(outputDir) {
  const files = []
  for (const name of DELIVERY_FILES) {
    const filePath = join(outputDir, name)
    if (isFile(filePath)) files.push({ name, data: readFileSync(filePath) })
  }

  const assetsDir = join(outputDir, 'assets')
  if (isDirectory(assetsDir)) collectDirectoryFiles(outputDir, assetsDir, files)
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

function collectDirectoryFiles(rootDir, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) collectDirectoryFiles(rootDir, entryPath, files)
    if (entry.isFile()) {
      files.push({ name: relative(rootDir, entryPath).split(sep).join('/'), data: readFileSync(entryPath) })
    }
  }
}

function createStoredZip(files) {
  const entries = []
  const localParts = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const entry = { name, data: file.data, crc: crc32(file.data), offset }
    const header = createLocalHeader(entry)
    entries.push(entry)
    localParts.push(header, entry.data)
    offset += header.length + entry.data.length
  }

  const centralParts = entries.map(createCentralHeader)
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  return Buffer.concat([...localParts, ...centralParts, createEndRecord(entries.length, centralSize, offset)])
}

function createLocalHeader(entry) {
  const output = Buffer.alloc(30 + entry.name.length)
  output.writeUInt32LE(0x04034b50, 0)
  output.writeUInt16LE(20, 4)
  output.writeUInt16LE(0x0800, 6)
  output.writeUInt32LE(entry.crc, 14)
  output.writeUInt32LE(entry.data.length, 18)
  output.writeUInt32LE(entry.data.length, 22)
  output.writeUInt16LE(entry.name.length, 26)
  entry.name.copy(output, 30)
  return output
}

function createCentralHeader(entry) {
  const output = Buffer.alloc(46 + entry.name.length)
  output.writeUInt32LE(0x02014b50, 0)
  output.writeUInt16LE(20, 4)
  output.writeUInt16LE(20, 6)
  output.writeUInt16LE(0x0800, 8)
  output.writeUInt32LE(entry.crc, 16)
  output.writeUInt32LE(entry.data.length, 20)
  output.writeUInt32LE(entry.data.length, 24)
  output.writeUInt16LE(entry.name.length, 28)
  output.writeUInt32LE(entry.offset, 42)
  entry.name.copy(output, 46)
  return output
}

function createEndRecord(entryCount, centralSize, centralOffset) {
  const output = Buffer.alloc(22)
  output.writeUInt32LE(0x06054b50, 0)
  output.writeUInt16LE(entryCount, 8)
  output.writeUInt16LE(entryCount, 10)
  output.writeUInt32LE(centralSize, 12)
  output.writeUInt32LE(centralOffset, 16)
  return output
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}
