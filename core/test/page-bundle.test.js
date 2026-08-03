import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { preparePageBundle, buildMergePrepareCommand } from '../src/page-bundle.js'

function writePage(root, id, route) {
  const inputDir = join(root, 'pages', id, '00-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({ page: { id, name: id }, selection: [{}] }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  return { id, name: id, route, sourceNodeId: `node-${id}`, inputDir: `pages/${id}/00-input` }
}

test('preparePageBundle validates and resolves page inputs', (t) => {
  const root = join('/tmp', `mastergo-page-bundle-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  const pages = [writePage(root, 'home', '/'), writePage(root, 'about', '/about')]
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    generatedAt: new Date().toISOString(),
    source: { pageId: 'page-1', pageName: 'Website' },
    pages,
  }))

  const prepared = preparePageBundle(root, join(root, '.workspace'))
  assert.equal(prepared.pages.length, 2)
  assert.equal(prepared.pages[0].route, '/')
  assert.equal(readFileSync(join(prepared.pages[1].inputPath, 'raw.json'), 'utf8').includes('about'), true)
})

test('preparePageBundle rejects duplicate routes', () => {
  const root = join('/tmp', `mastergo-page-bundle-invalid-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  const pages = [writePage(root, 'one', '/same'), writePage(root, 'two', '/same')]
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    pages,
  }))
  assert.throws(() => preparePageBundle(root, join(root, '.workspace')), /route 重复/)
})

test('buildMergePrepareCommand includes successful routes only', () => {
  const command = buildMergePrepareCommand({
    batchDir: '/tmp/batch',
    pages: [
      { route: '/', status: 'done', outputDir: '/tmp/jobs/home/output', inputPath: '/tmp/pages/home/00-input' },
      { route: '/broken', status: 'error' },
    ],
  })
  assert.match(command, /--require-frame-screenshot/)
  assert.match(command, /--page '\/=\/tmp\/jobs\/home\/output'/)
  assert.match(command, /--frame-screenshot '\/=\/tmp\/pages\/home\/00-input\/frame-screenshot\.png'/)
  assert.doesNotMatch(command, /broken/)
})
