import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const validator = resolve('skills/html2react/scripts/validate_project.py')
const viewports = [390, 768, 1280, 1920, 2560]

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function createProject(root) {
  const project = join(root, 'app')
  for (const path of [
    'src/app',
    'src/app/news',
    'src/components/layouts',
    'src/components/in-page/home',
    'src/components/in-page/news',
    'src/styles',
    'public/design/index',
    'public/design/news',
  ]) mkdirSync(join(project, path), { recursive: true })

  writeJson(join(project, 'package.json'), {
    scripts: { dev: 'next dev', build: 'next build', lint: 'eslint .', typecheck: 'tsc --noEmit' },
    dependencies: { next: '1', react: '1', 'react-dom': '1' },
    devDependencies: { typescript: '1' },
  })
  writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}')
  writeFileSync(join(project, 'src/app/layout.tsx'), 'export default function Layout({children}) { return children }')
  writeFileSync(join(project, 'src/styles/globals.css'), '')
  writeFileSync(join(project, 'src/app/page.tsx'), 'export default function Page() { return null }')
  writeFileSync(join(project, 'src/app/news/page.tsx'), 'export default function Page() { return null }')
  writeFileSync(join(project, 'src/components/layouts/SiteHeader.tsx'), 'export function SiteHeader() { return <header /> }')
  writeFileSync(join(project, 'src/components/in-page/home/HomePage.tsx'), 'import { SiteHeader } from "../../layouts/SiteHeader"; export function HomePage() { return <SiteHeader /> }')
  writeFileSync(join(project, 'src/components/in-page/news/NewsPage.tsx'), 'import { SiteHeader } from "../../layouts/SiteHeader"; export function NewsPage() { return <SiteHeader /> }')

  const manifest = join(root, 'source-manifest.json')
  writeJson(manifest, {
    pages: [
      { page_id: 'index', route: '/' },
      { page_id: 'news', route: '/news' },
    ],
  })
  return { manifest, project }
}

function passingReport(route) {
  return {
    schema_version: 1,
    mode: 'react-before-vs-react-after-shared-shell',
    route,
    status: 'pass',
    comparison: { dimensions_match: true, changed_ratio: 0 },
  }
}

test('multi-route validation requires a complete passing shared-shell audit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shared-shell-validator-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { manifest, project } = createProject(root)

  const missing = spawnSync('python3', [validator, '--profile', 'default', '--project', project, '--manifest', manifest], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /Shared-shell audit exists/)

  const reports = []
  for (const route of ['/', '/news']) {
    for (const viewport of viewports) {
      const routeKey = route === '/' ? 'home' : 'news'
      const path = join(root, `${routeKey}-${viewport}.json`)
      writeJson(path, passingReport(route))
      reports.push({ route, viewport, path })
    }
  }
  const sharedHeader = {
    id: 'site-header',
    classification: 'parameterized',
    component: 'src/components/layouts/SiteHeader.tsx',
    symbol: 'SiteHeader',
    consumers: [
      { route: '/', file: 'src/components/in-page/home/HomePage.tsx' },
      { route: '/news', file: 'src/components/in-page/news/NewsPage.tsx' },
    ],
    reports,
  }
  const exceptions = [
    { route: '/', status: 'absent', reason: 'This fixture intentionally has no standalone region.' },
    { route: '/news', status: 'absent', reason: 'This fixture intentionally has no standalone region.' },
  ]
  writeJson(join(root, 'shared-shell-audit.json'), {
    schema_version: 1,
    required_viewports: viewports,
    max_changed_ratio: 0.005,
    regions: {
      header: { families: [sharedHeader], exceptions: [] },
      nav: { families: [], exceptions },
      footer: { families: [], exceptions },
    },
  })

  const visuallyChangedPath = reports[0].path
  writeJson(visuallyChangedPath, {
    ...passingReport('/'),
    status: 'fail',
    comparison: { dimensions_match: true, changed_ratio: 0.02 },
  })
  const visuallyChanged = spawnSync('python3', [validator, '--profile', 'default', '--project', project, '--manifest', manifest], { encoding: 'utf8' })
  assert.equal(visuallyChanged.status, 1)
  assert.match(visuallyChanged.stdout, /changed ratio is at most 0.005/)

  writeJson(visuallyChangedPath, passingReport('/'))
  const passing = spawnSync('python3', [validator, '--profile', 'default', '--project', project, '--manifest', manifest], { encoding: 'utf8' })
  assert.equal(passing.status, 0, `${passing.stdout}\n${passing.stderr}`)
  assert.match(passing.stdout, /OK with 0 warning/)
})
