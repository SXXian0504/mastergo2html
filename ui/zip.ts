import { ExportFile } from '@messages/sender'

type ZipEntry = {
  name: Uint8Array
  data: Uint8Array
  crc: number
  offset: number
}

export function createZip(files: ExportFile[]) {
  const entries: ZipEntry[] = []
  const localParts: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const name = encodeUtf8(file.path)
    const data = file.encoding === 'base64' ? decodeBase64(file.content) : encodeUtf8(file.content)
    const entry = { name, data, crc: crc32(data), offset }
    const localHeader = createLocalHeader(entry)
    entries.push(entry)
    localParts.push(localHeader, data)
    offset += localHeader.length + data.length
  }

  const centralParts = entries.map((entry) => createCentralHeader(entry))
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = createEndRecord(entries.length, centralSize, offset)

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
}

function createLocalHeader(entry: ZipEntry) {
  const output = new Uint8Array(30 + entry.name.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x0800, true)
  view.setUint16(8, 0, true)
  view.setUint32(10, 0, true)
  view.setUint32(14, entry.crc, true)
  view.setUint32(18, entry.data.length, true)
  view.setUint32(22, entry.data.length, true)
  view.setUint16(26, entry.name.length, true)
  view.setUint16(28, 0, true)
  output.set(entry.name, 30)
  return output
}

function createCentralHeader(entry: ZipEntry) {
  const output = new Uint8Array(46 + entry.name.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, 0x0800, true)
  view.setUint16(10, 0, true)
  view.setUint32(12, 0, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, entry.data.length, true)
  view.setUint32(24, entry.data.length, true)
  view.setUint16(28, entry.name.length, true)
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, entry.offset, true)
  output.set(entry.name, 46)
  return output
}

function createEndRecord(entryCount: number, centralSize: number, centralOffset: number) {
  const output = new Uint8Array(22)
  const view = new DataView(output.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, entryCount, true)
  view.setUint16(10, entryCount, true)
  view.setUint32(12, centralSize, true)
  view.setUint32(16, centralOffset, true)
  view.setUint16(20, 0, true)
  return output
}

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index)
  }
  return output
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
