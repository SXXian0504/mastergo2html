import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'

const prepareScript = resolve('skills/merge-html-to-next-app/scripts/prepare_inputs.py')
const compareScript = resolve('skills/merge-html-to-next-app/scripts/compare_screenshots.mjs')

function writePng(path, firstRed = 0, width = 4, height = 3) {
  const image = new PNG({ width, height })
  image.data.fill(255)
  image.data[0] = firstRed
  writeFileSync(path, PNG.sync.write(image))
}

test('prepare_inputs carries the Frame screenshot into the React merge manifest', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'react-merge-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const jobRoot = join(root, 'job')
  const outputDir = join(jobRoot, '05-output')
  const inputDir = join(jobRoot, '00-input')
  const workspace = join(root, 'workspace')
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(outputDir, 'index.html'), '<!doctype html><html><body><h1>岗位</h1></body></html>')
  writePng(join(inputDir, 'frame-screenshot.png'))

  const result = spawnSync('python3', [
    prepareScript,
    '--workspace', workspace,
    '--require-frame-screenshot',
    '--page', `/✅应届生-岗位列表=${outputDir}`,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(readFileSync(join(workspace, 'source-manifest.json'), 'utf8'))
  assert.equal(manifest.schema_version, 2)
  assert.equal(manifest.pages[0].page_id, '应届生-岗位列表')
  assert.equal(manifest.pages[0].design_reference.width, 4)
  assert.equal(manifest.pages[0].design_reference.height, 3)
  assert.match(manifest.pages[0].design_reference.sha256, /^[a-f0-9]{64}$/)
})

test('compare_screenshots passes identical images and fails changed pixels', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'react-visual-compare-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reference = join(root, 'reference.png')
  const identical = join(root, 'identical.png')
  const changed = join(root, 'changed.png')
  writePng(reference, 0)
  writePng(identical, 0)
  writePng(changed, 255)

  const common = [
    compareScript,
    '--reference', reference,
    '--route', '/position',
    '--mode', 'frame-vs-react-final',
    '--channel-threshold', '0',
    '--max-changed-ratio', '0',
  ]
  const passing = spawnSync('node', [
    ...common,
    '--actual', identical,
    '--report', join(root, 'pass.json'),
    '--diff', join(root, 'pass.diff.png'),
  ], { encoding: 'utf8' })
  assert.equal(passing.status, 0, passing.stderr)
  assert.equal(JSON.parse(readFileSync(join(root, 'pass.json'), 'utf8')).status, 'pass')

  const failing = spawnSync('node', [
    ...common,
    '--actual', changed,
    '--report', join(root, 'fail.json'),
    '--diff', join(root, 'fail.diff.png'),
  ], { encoding: 'utf8' })
  assert.equal(failing.status, 1, failing.stderr)
  const report = JSON.parse(readFileSync(join(root, 'fail.json'), 'utf8'))
  assert.equal(report.status, 'fail')
  assert.equal(report.comparison.changed_pixels, 1)
})
