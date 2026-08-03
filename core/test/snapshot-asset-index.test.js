import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSnapshotAssetIndex, snapshotAssetIndexInternals } from '../src/snapshot-asset-index.js'

test('snapshot asset index exposes referenced resources by node id and normalized keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-snapshot-index-test-'))
  const snapshotDir = join(dir, '.mastergo', 'design', 'doc', 'page')
  mkdirSync(join(snapshotDir, 'asset', 'images'), { recursive: true })
  writeFileSync(join(snapshotDir, 'asset', 'images', 'hero.hash.png'), 'snapshot-png')
  const htmlPath = join(snapshotDir, 'Frame-1-2.html')
  writeFileSync(htmlPath, [
    '<div data-node-id="1:2" data-name="Frame" style="left:0;top:0;width:100px;height:100px">',
    '<img data-node-id="1:3" data-name="Hero" src="./asset/images/hero.hash.png" style="left:10px;top:20px;width:30px;height:40px">',
    '</div>',
  ].join(''))

  const index = createSnapshotAssetIndex({ snapshotHtml: htmlPath })
  try {
    assert.equal(index.root.id, '1:2')
    assert.equal(index.byNodeId.get('1:3').length, 1)
    assert.equal(index.byKey.get('hero.hash.png').length, 1)
    assert.equal(existsSync(index.byNodeId.get('1:3')[0].sourcePath), true)
  } finally {
    index.dispose()
  }
})

test('snapshot resource keys normalize query strings, paths, extensions, and case', () => {
  assert.deepEqual(snapshotAssetIndexInternals.resourceKeys('./Assets/IMG/Hero.PNG?x=1'), [
    'assets/img/hero.png',
    'hero.png',
    'hero',
  ])
})
