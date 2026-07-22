import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectDeliveryFiles, packageOutputDirectory } from '../src/output-zip.js'

test('output package includes page files and assets but excludes generation metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-output-zip-'))
  const outputDir = join(root, '05-output')
  mkdirSync(join(outputDir, 'assets', 'rendered'), { recursive: true })
  writeFileSync(join(outputDir, 'index.html'), '<!doctype html>')
  writeFileSync(join(outputDir, 'styles.css'), 'body {}')
  writeFileSync(join(outputDir, 'script.js'), '')
  writeFileSync(join(outputDir, 'assets', 'rendered', 'hero.png'), Buffer.from([1, 2, 3]))
  writeFileSync(join(outputDir, 'html-generation.prompt.md'), 'private generation context')
  writeFileSync(join(outputDir, 'static-validation.json'), '{}')

  const files = collectDeliveryFiles(outputDir)
  assert.deepEqual(files.map((file) => file.name), [
    'assets/rendered/hero.png',
    'index.html',
    'script.js',
    'styles.css',
  ])

  const zipPath = join(root, 'final', 'output.zip')
  const result = packageOutputDirectory(outputDir, zipPath)
  const zip = readFileSync(zipPath)
  assert.equal(result.fileCount, 4)
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.match(zip.toString('utf8'), /assets\/rendered\/hero\.png/)
  assert.doesNotMatch(zip.toString('utf8'), /html-generation\.prompt\.md/)
})
