import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export function extractStoredZip(zipPath, targetDir) {
  const buffer = readFileSync(zipPath)
  let offset = 0
  const entries = []

  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const fileNameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + fileNameLength + extraLength
    const dataEnd = dataStart + compressedSize
    const entryName = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8')

    if (flags & 0x0008) {
      throw new Error('暂不支持使用 data descriptor 的 ZIP 文件，请使用插件导出的 00-input.zip。')
    }
    if (method !== 0) {
      throw new Error(`暂不支持压缩方法 ${method}，请使用插件导出的 00-input.zip。`)
    }
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP 条目数据不完整：${entryName}`)
    }

    entries.push({ name: entryName, data: buffer.subarray(dataStart, dataEnd) })
    offset = dataEnd
  }

  if (entries.length === 0) throw new Error('ZIP 中没有可读取的 00-input 文件。')

  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue
    const safePath = normalize(entry.name)
    if (isAbsolute(safePath) || safePath.startsWith('..')) {
      throw new Error(`拒绝解压非法路径：${entry.name}`)
    }
    const targetPath = join(targetDir, safePath)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, entry.data)
  }

  return entries.map((entry) => entry.name)
}
