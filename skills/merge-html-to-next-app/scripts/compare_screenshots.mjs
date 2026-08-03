#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PNG } from 'pngjs'

function readArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options[key.slice(2)] = value
    index += 1
  }
  return options
}

function requireOption(options, key) {
  if (!options[key]) throw new Error(`Missing required option: --${key}`)
  return options[key]
}

function readPng(path) {
  const buffer = readFileSync(path)
  return {
    buffer,
    image: PNG.sync.read(buffer),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

function pixelOffset(width, x, y) {
  return (width * y + x) << 2
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function main() {
  const options = readArgs(process.argv.slice(2))
  const referencePath = resolve(requireOption(options, 'reference'))
  const actualPath = resolve(requireOption(options, 'actual'))
  const reportPath = resolve(requireOption(options, 'report'))
  const diffPath = resolve(requireOption(options, 'diff'))
  const route = requireOption(options, 'route')
  const mode = options.mode || 'frame-vs-react-final'
  const channelThreshold = Number(options['channel-threshold'] ?? 16)
  const maxChangedRatio = options['max-changed-ratio'] == null
    ? null
    : Number(options['max-changed-ratio'])

  if (!Number.isFinite(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) {
    throw new Error('--channel-threshold must be between 0 and 255')
  }
  if (maxChangedRatio != null && (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1)) {
    throw new Error('--max-changed-ratio must be between 0 and 1')
  }

  const reference = readPng(referencePath)
  const actual = readPng(actualPath)
  const width = Math.max(reference.image.width, actual.image.width)
  const height = Math.max(reference.image.height, actual.image.height)
  const totalPixels = width * height
  const diff = new PNG({ width, height })
  let changedPixels = 0
  let absoluteError = 0
  let comparedChannels = 0
  let maxChannelDelta = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetOffset = pixelOffset(width, x, y)
      const hasReference = x < reference.image.width && y < reference.image.height
      const hasActual = x < actual.image.width && y < actual.image.height

      if (!hasReference || !hasActual) {
        changedPixels += 1
        absoluteError += 255 * 4
        comparedChannels += 4
        diff.data[targetOffset] = hasReference ? 255 : 0
        diff.data[targetOffset + 1] = 0
        diff.data[targetOffset + 2] = hasActual ? 255 : 0
        diff.data[targetOffset + 3] = 255
        continue
      }

      const referenceOffset = pixelOffset(reference.image.width, x, y)
      const actualOffset = pixelOffset(actual.image.width, x, y)
      let pixelDelta = 0
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs(reference.image.data[referenceOffset + channel] - actual.image.data[actualOffset + channel])
        pixelDelta = Math.max(pixelDelta, delta)
        maxChannelDelta = Math.max(maxChannelDelta, delta)
        absoluteError += delta
        comparedChannels += 1
      }

      if (pixelDelta > channelThreshold) {
        changedPixels += 1
        diff.data[targetOffset] = 255
        diff.data[targetOffset + 1] = Math.max(0, 180 - pixelDelta)
        diff.data[targetOffset + 2] = 0
      } else {
        const gray = Math.round(
          (reference.image.data[referenceOffset]
            + reference.image.data[referenceOffset + 1]
            + reference.image.data[referenceOffset + 2]) / 12,
        )
        diff.data[targetOffset] = gray
        diff.data[targetOffset + 1] = gray
        diff.data[targetOffset + 2] = gray
      }
      diff.data[targetOffset + 3] = 255
    }
  }

  mkdirSync(dirname(diffPath), { recursive: true })
  writeFileSync(diffPath, PNG.sync.write(diff))

  const dimensionsMatch = reference.image.width === actual.image.width && reference.image.height === actual.image.height
  const changedRatio = totalPixels === 0 ? 0 : changedPixels / totalPixels
  const status = maxChangedRatio == null
    ? 'review-required'
    : dimensionsMatch && changedRatio <= maxChangedRatio ? 'pass' : 'fail'
  const report = {
    schema_version: 1,
    mode,
    route,
    status,
    reference: {
      path: referencePath,
      sha256: reference.sha256,
      width: reference.image.width,
      height: reference.image.height,
    },
    actual: {
      path: actualPath,
      sha256: actual.sha256,
      width: actual.image.width,
      height: actual.image.height,
    },
    comparison: {
      dimensions_match: dimensionsMatch,
      channel_threshold: channelThreshold,
      max_changed_ratio: maxChangedRatio,
      changed_pixels: changedPixels,
      total_pixels: totalPixels,
      changed_ratio: changedRatio,
      mean_absolute_channel_error: comparedChannels === 0 ? 0 : absoluteError / comparedChannels,
      max_channel_delta: maxChannelDelta,
    },
    artifacts: {
      diff: diffPath,
    },
  }
  writeJson(reportPath, report)
  console.log(`${route}: ${status}; changed_ratio=${changedRatio.toFixed(6)}; dimensions_match=${dimensionsMatch}`)
  console.log(`Report: ${reportPath}`)
  console.log(`Diff: ${diffPath}`)
  if (status === 'fail') process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
