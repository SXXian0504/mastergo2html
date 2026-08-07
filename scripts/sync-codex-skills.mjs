#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(scriptDir, '..')

function parseArgs(argv) {
  const options = {
    mode: 'check',
    repoRoot: defaultRepoRoot,
    codexHome: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex'),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.mode = 'check'
    else if (arg === '--link') options.mode = 'link'
    else if (arg === '--repo-root') options.repoRoot = resolve(argv[++index] ?? '')
    else if (arg === '--codex-home') options.codexHome = resolve(argv[++index] ?? '')
    else if (arg === '--help' || arg === '-h') options.mode = 'help'
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function printHelp() {
  console.log(`Usage: node scripts/sync-codex-skills.mjs [--check|--link]

The repository skills/<name> directories are the only canonical Skill sources.

Options:
  --check                 Verify discovery/install paths are symlinks to the canonical sources (default)
  --link                  Back up non-link copies and replace them with canonical symlinks
  --repo-root <path>      Override the repository root (used by tests)
  --codex-home <path>     Override CODEX_HOME (default: $CODEX_HOME or ~/.codex)
  -h, --help              Show this help
`)
}

async function pathInfo(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function resolveLink(path) {
  const target = await readlink(path)
  return resolve(dirname(path), target)
}

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute))
    else if (entry.isFile()) files.push(relative(root, absolute))
  }
  return files.sort()
}

async function treeHash(root) {
  const files = await collectFiles(root)
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(await readFile(join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function destinationDefinitions(repoRoot, codexHome) {
  const installedRoot = join(codexHome, 'skills')
  return [
    {
      name: 'mastergo2html',
      canonical: join(repoRoot, 'skills/mastergo2html'),
      destinations: [
        { label: 'project discovery', path: join(repoRoot, '.agents/skills/mastergo2html'), relativeLink: true },
        { label: 'Codex install', path: join(installedRoot, 'mastergo2html'), relativeLink: false },
      ],
    },
    {
      name: 'mastergo2code',
      canonical: join(repoRoot, 'skills/mastergo2code'),
      legacyDestinations: [
        { label: 'legacy Codex install', path: join(installedRoot, 'mastergo-pages-to-react') },
      ],
      destinations: [
        { label: 'Codex install', path: join(installedRoot, 'mastergo2code'), relativeLink: false },
      ],
    },
    {
      name: 'html2react',
      canonical: join(repoRoot, 'skills/html2react'),
      legacyDestinations: [
        { label: 'legacy Codex install', path: join(installedRoot, 'merge-html-to-next-app') },
        { label: 'legacy Codex install', path: join(installedRoot, 'merge-html-to-react') },
      ],
      destinations: [
        { label: 'Codex install', path: join(installedRoot, 'html2react'), relativeLink: false },
      ],
    },
  ]
}

async function inspectDestination(canonical, destination) {
  const info = await pathInfo(destination.path)
  if (!info) return { status: 'missing' }

  if (info.isSymbolicLink()) {
    const actual = await canonicalPath(await resolveLink(destination.path))
    const expected = await canonicalPath(canonical)
    return { status: actual === expected ? 'linked' : 'wrong-link', actual }
  }

  if (info.isDirectory()) {
    const [sourceHash, destinationHash] = await Promise.all([treeHash(canonical), treeHash(destination.path)])
    return { status: sourceHash === destinationHash ? 'copy-matching' : 'copy-drift' }
  }

  return { status: 'unexpected-file' }
}

async function copyTree(source, destination) {
  const info = await lstat(source)
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source)) {
      await copyTree(join(source, entry), join(destination, entry))
    }
    return
  }
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination)
    return
  }
  await copyFile(source, destination)
}

async function moveToBackup(source, backup) {
  await mkdir(dirname(backup), { recursive: true })
  try {
    await rename(source, backup)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await copyTree(source, backup)
    await rm(source, { recursive: true, force: true })
  }
}

async function installLink({ canonical, destination, backupRoot, skillName }) {
  const inspection = await inspectDestination(canonical, destination)
  if (inspection.status === 'linked') {
    console.log(`OK   ${skillName}: ${destination.label} already links to canonical source`)
    return
  }

  const existing = await pathInfo(destination.path)
  if (existing) {
    const backupName = `${skillName}-${destination.label.replace(/ /g, '-')}-${basename(destination.path)}`
    const backup = join(backupRoot, backupName)
    await moveToBackup(destination.path, backup)
    console.log(`BACK ${skillName}: moved ${destination.path} -> ${backup}`)
  }

  await mkdir(dirname(destination.path), { recursive: true })
  const target = destination.relativeLink ? relative(dirname(destination.path), canonical) : canonical
  await symlink(target, destination.path, 'dir')
  console.log(`LINK ${skillName}: ${destination.path} -> ${target}`)
}

async function migrateLegacyDestinations(definition, backupRoot) {
  for (const destination of definition.legacyDestinations ?? []) {
    if (!(await pathInfo(destination.path))) continue
    const backup = join(backupRoot, `${definition.name}-${destination.label.replace(/ /g, '-')}-${basename(destination.path)}`)
    await moveToBackup(destination.path, backup)
    console.log(`BACK ${definition.name}: moved ${destination.path} -> ${backup}`)
  }
}

async function verify(definitions) {
  let failures = 0
  for (const definition of definitions) {
    const canonicalInfo = await pathInfo(definition.canonical)
    if (!canonicalInfo?.isDirectory() || !(await pathInfo(join(definition.canonical, 'SKILL.md')))?.isFile()) {
      console.error(`FAIL ${definition.name}: invalid canonical Skill directory ${definition.canonical}`)
      failures += 1
      continue
    }

    for (const destination of definition.legacyDestinations ?? []) {
      if (await pathInfo(destination.path)) {
        console.error(`FAIL ${definition.name}: ${destination.label} still exists (${destination.path})`)
        failures += 1
      }
    }

    for (const destination of definition.destinations) {
      const inspection = await inspectDestination(definition.canonical, destination)
      if (inspection.status === 'linked') {
        console.log(`OK   ${definition.name}: ${destination.label} uses canonical source`)
      } else {
        console.error(`FAIL ${definition.name}: ${destination.label} is ${inspection.status} (${destination.path})`)
        failures += 1
      }
    }
  }
  return failures
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.mode === 'help') {
    printHelp()
    return 0
  }

  const definitions = destinationDefinitions(options.repoRoot, options.codexHome)
  if (options.mode === 'link') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupRoot = join(options.codexHome, 'skill-backups', timestamp)
    for (const definition of definitions) {
      await migrateLegacyDestinations(definition, backupRoot)
      for (const destination of definition.destinations) {
        await installLink({
          canonical: definition.canonical,
          destination,
          backupRoot,
          skillName: definition.name,
        })
      }
    }
  }

  const failures = await verify(definitions)
  if (failures > 0) {
    console.error(`Skill source check failed: ${failures} path(s) are not linked to repository canonical sources.`)
    return 1
  }

  console.log('Skill source check passed: all managed paths resolve to repository skills/.')
  return 0
}

main().then(
  code => { process.exitCode = code },
  error => {
    console.error(error?.stack || error)
    process.exitCode = 1
  },
)
