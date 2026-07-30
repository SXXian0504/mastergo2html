import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createInputFromCodexMasterGo } from '../src/codex-mastergo-input.js'

test('codex mastergo input copies only assets referenced by the selected snapshot html', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-codex-input-'))
  const snapshotDir = join(dir, '.mastergo', 'design', 'doc-1', 'page-1')
  const outputDir = join(dir, '00-input')
  mkdirSync(join(snapshotDir, 'asset', 'icons'), { recursive: true })
  mkdirSync(join(snapshotDir, 'asset', 'images'), { recursive: true })

  writeFileSync(join(snapshotDir, 'asset', 'icons', 'used.svg'), '<svg></svg>', 'utf8')
  writeFileSync(join(snapshotDir, 'asset', 'icons', 'other-frame.svg'), '<svg></svg>', 'utf8')
  writeFileSync(join(snapshotDir, 'asset', 'images', 'used.png'), 'png')
  writeFileSync(join(snapshotDir, 'asset', 'images', 'other-frame.png'), 'png')
  const htmlPath = join(snapshotDir, 'Selected Frame-1-2.html')
  writeFileSync(htmlPath, [
    '<div data-node-id="1:2" data-name="Selected Frame" style="position:absolute;left:0;top:0;width:100px;height:100px">',
    '<img data-node-id="1:3" data-name="icon" src="./asset/icons/used.svg" style="position:absolute;left:0;top:0;width:12px;height:12px">',
    '<img data-node-id="1:4" data-name="image" src="./asset/images/used.png" style="position:absolute;left:0;top:20px;width:20px;height:20px">',
    '</div>',
  ].join(''), 'utf8')

  const result = createInputFromCodexMasterGo({ snapshotHtml: htmlPath, output: outputDir })
  const manifest = JSON.parse(readFileSync(join(outputDir, 'asset-manifest.json'), 'utf8'))

  assert.equal(result.assetCount, 2)
  assert.deepEqual([...new Set(manifest.files.map((file) => file.path))].sort(), [
    'assets/icon/used.svg',
    'assets/img/used.png',
  ])
  assert.equal(existsSync(join(outputDir, 'assets', 'icon', 'used.svg')), true)
  assert.equal(existsSync(join(outputDir, 'assets', 'img', 'used.png')), true)
  assert.equal(existsSync(join(outputDir, 'assets', 'icon', 'other-frame.svg')), false)
  assert.equal(existsSync(join(outputDir, 'assets', 'img', 'other-frame.png')), false)
})

test('codex mastergo input clears stale files when reusing an output directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-codex-input-'))
  const snapshotDir = join(dir, '.mastergo', 'design', 'doc-1', 'page-1')
  const outputDir = join(dir, '00-input')
  mkdirSync(join(snapshotDir, 'asset', 'icons'), { recursive: true })
  mkdirSync(join(outputDir, 'assets', 'icon'), { recursive: true })

  writeFileSync(join(snapshotDir, 'asset', 'icons', 'used.svg'), '<svg></svg>', 'utf8')
  writeFileSync(join(outputDir, 'assets', 'icon', 'stale.svg'), '<svg></svg>', 'utf8')
  const htmlPath = join(snapshotDir, 'Selected Frame-1-2.html')
  writeFileSync(htmlPath, [
    '<div data-node-id="1:2" data-name="Selected Frame" style="position:absolute;left:0;top:0;width:100px;height:100px">',
    '<img data-node-id="1:3" data-name="icon" src="./asset/icons/used.svg" style="position:absolute;left:0;top:0;width:12px;height:12px">',
    '</div>',
  ].join(''), 'utf8')

  createInputFromCodexMasterGo({ snapshotHtml: htmlPath, output: outputDir })

  assert.equal(existsSync(join(outputDir, 'assets', 'icon', 'used.svg')), true)
  assert.equal(existsSync(join(outputDir, 'assets', 'icon', 'stale.svg')), false)
})
