import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'sync-codex-skills.mjs')
const skillNames = ['mastergo2html', 'mastergo2code', 'html2react']

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skill-sync-'))
  const repo = join(root, 'repo')
  const codexHome = join(root, 'codex')

  for (const name of skillNames) {
    const canonical = join(repo, 'skills', name)
    mkdirSync(canonical, { recursive: true })
    writeFileSync(join(canonical, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n`)

    const installed = join(codexHome, 'skills', name)
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'SKILL.md'), `stale ${name}\n`)
  }

  const discovery = join(repo, '.agents/skills/mastergo2html')
  mkdirSync(discovery, { recursive: true })
  writeFileSync(join(discovery, 'SKILL.md'), 'stale discovery\n')

  const legacyMasterGo2React = join(codexHome, 'skills/mastergo-pages-to-react')
  mkdirSync(legacyMasterGo2React, { recursive: true })
  writeFileSync(join(legacyMasterGo2React, 'SKILL.md'), 'legacy skill name\n')

  const legacyHtml2ReactNames = [
    join(codexHome, 'skills/merge-html-to-next-app'),
    join(codexHome, 'skills/merge-html-to-react'),
  ]
  for (const legacyPath of legacyHtml2ReactNames) {
    mkdirSync(legacyPath, { recursive: true })
    writeFileSync(join(legacyPath, 'SKILL.md'), 'legacy HTML2React skill name\n')
  }
  return { root, repo, codexHome, legacyMasterGo2React, legacyHtml2ReactNames }
}

test('link mode replaces copies with canonical links and check mode stays green', () => {
  const fixture = makeFixture()
  execFileSync(process.execPath, [script, '--link', '--repo-root', fixture.repo, '--codex-home', fixture.codexHome])
  execFileSync(process.execPath, [script, '--check', '--repo-root', fixture.repo, '--codex-home', fixture.codexHome])

  const discovery = join(fixture.repo, '.agents/skills/mastergo2html')
  assert.equal(readlinkSync(discovery), relative(dirname(discovery), join(fixture.repo, 'skills/mastergo2html')))
  assert.equal(realpathSync(discovery), realpathSync(join(fixture.repo, 'skills/mastergo2html')))
  assert.equal(existsSync(fixture.legacyMasterGo2React), false)
  for (const legacyPath of fixture.legacyHtml2ReactNames) assert.equal(existsSync(legacyPath), false)

  for (const name of skillNames) {
    assert.equal(
      realpathSync(join(fixture.codexHome, 'skills', name)),
      realpathSync(join(fixture.repo, 'skills', name)),
    )
  }
})

test('check mode rejects copied Skill directories', () => {
  const fixture = makeFixture()
  const result = spawnSync(process.execPath, [
    script,
    '--check',
    '--repo-root', fixture.repo,
    '--codex-home', fixture.codexHome,
  ], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /copy-drift/)
})
