import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createInputFromMagicDsl } from '../src/magic-dsl-input.js'

test('magic dsl input copies only referenced assets and clears stale output files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-magic-input-'))
  const sourceDir = join(dir, 'source')
  const outputDir = join(dir, '00-input')
  mkdirSync(join(sourceDir, 'assets', 'img'), { recursive: true })
  mkdirSync(join(outputDir, 'assets', 'img'), { recursive: true })

  writeFileSync(join(sourceDir, 'assets', 'img', 'used.png'), 'png')
  writeFileSync(join(sourceDir, 'assets', 'img', 'other-frame.png'), 'png')
  writeFileSync(join(outputDir, 'assets', 'img', 'stale.png'), 'png')
  writeFileSync(join(sourceDir, 'overview.json'), JSON.stringify({
    rootMetadata: { id: 'root', name: 'Magic Frame', width: 100, height: 100 },
    sections: [{ id: 'section-1', x: 0, y: 0, width: 100, height: 100 }],
  }))
  mkdirSync(join(sourceDir, 'sections'), { recursive: true })
  writeFileSync(join(sourceDir, 'sections', 'section-0.json'), JSON.stringify({
    dsl: {
      id: 'section-1',
      type: 'FRAME',
      layoutStyle: { width: 100, height: 100 },
      children: [{
        id: 'image-node',
        name: 'image',
        type: 'RECTANGLE',
        layoutStyle: { width: 20, height: 20 },
        imageRef: 'used.png',
      }],
    },
  }))

  const result = createInputFromMagicDsl({ input: sourceDir, output: outputDir })

  assert.equal(result.assetCount, 1)
  assert.equal(existsSync(join(outputDir, 'assets', 'img', 'img_0001.png')), true)
  assert.equal(existsSync(join(outputDir, 'assets', 'img', 'other-frame.png')), false)
  assert.equal(existsSync(join(outputDir, 'assets', 'img', 'stale.png')), false)

  const raw = JSON.parse(readFileSync(join(outputDir, 'raw.json'), 'utf8'))
  const section = raw.selection[0].children[0]
  const image = section.children[0]
  assert.deepEqual(section.absoluteBoundingBox, { x: 0, y: 0, width: 100, height: 100 })
  assert.deepEqual(section.relativeBounds, { x: 0, y: 0, width: 100, height: 100 })
  assert.deepEqual(image.absoluteBoundingBox, { x: 0, y: 0, width: 20, height: 20 })
  assert.deepEqual(image.bounds, { x: 0, y: 0, width: 20, height: 20 })
})
