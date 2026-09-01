// Publish a launcher release. dsh-app carries no local version tags — the
// release job in .github/workflows/build.yml rolls the v<version> GitHub
// release on every master push (overwrite_files), so "a release" is exactly:
// sync the version across the four places that carry it, commit
// `release: vX.Y.Z`, and push.
//
//   npm run release              bump patch (0.3.7 -> 0.3.8), commit, push
//   npm run release -- --minor   bump minor (0.3.8 -> 0.4.0)
//   npm run release -- 0.3.8     pin an exact version — handy for finishing
//                                a half-done manual bump mid-way
//   npm run release -- --no-push commit only, leave the push to you
//
// Safety: refuses to run when the tree carries unrelated changes (they would
// ride the release commit); --allow-dirty overrides for a deliberately mixed
// tree. The four version files themselves may be half-synced — the script
// re-syncs all of them from the target.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- which files carry the app version ----
// tauri.conf.json is the single source of truth (the CI release job reads
// the tag from it); the other three must be kept in step.
const VERSION_FILES = [
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock', // the dsh-app [[package]] block
  'package.json',
]

const SEMVER = /^\d+\.\d+\.\d+$/

// ---- tiny helpers ----

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'))
}

function writeJson(rel, value) {
  const text = JSON.stringify(value, null, 2)
  // keep the trailing newline the original had (json files almost always do)
  const was = readFileSync(join(root, rel), 'utf8')
  writeFileSync(join(root, rel), text + (was.endsWith('\n') ? '\n' : ''))
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function bump(version, mode) {
  const [maj, min, pat] = version.split('.').map(Number)
  if (mode === 'major') return `${maj + 1}.0.0`
  if (mode === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

function setCargoTomlVersion(text, version) {
  // tolerate CRLF line endings (\r immediately before \n breaks a bare $).
  // Test-then-replace: when the target equals the current version the replace
  // output is identical, which a `next === text` check would mistake for a
  // missing line — that is exactly the "already bumped mid-way" case.
  const re = /^version = "\d+\.\d+\.\d+"\r?$/m
  if (!re.test(text)) throw new Error('Cargo.toml: package version line not found')
  return text.replace(re, `version = "${version}"`)
}

function setCargoLockVersion(text, version) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].replace(/\r$/, '') === 'name = "dsh-app"' && /^version = "\d+\.\d+\.\d+"\r?$/.test(lines[i + 1])) {
      lines[i + 1] = `version = "${version}"`
      return lines.join('\n')
    }
  }
  throw new Error('Cargo.lock: dsh-app package block not found')
}

function syncVersionFiles(target) {
  // JSON manifests (tauri.conf.json, package.json)
  for (const rel of ['src-tauri/tauri.conf.json', 'package.json']) {
    const json = readJson(rel)
    json.version = target
    writeJson(rel, json)
  }
  // Cargo.toml + Cargo.lock
  for (const rel of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const text = readFileSync(join(root, rel), 'utf8')
    const next = rel.endsWith('.lock')
      ? setCargoLockVersion(text, target)
      : setCargoTomlVersion(text, target)
    writeFileSync(join(root, rel), next)
  }
}

// ---- arg parsing ----

const args = process.argv.slice(2)
const explicit = args.find((a) => !a.startsWith('--'))
const mode = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch'
const allowDirty = args.includes('--allow-dirty')
const noPush = args.includes('--no-push')

// ---- current version ----

const current = readJson('src-tauri/tauri.conf.json').version
if (!SEMVER.test(current)) {
  console.error(`release: current version "${current}" is not semver — fix tauri.conf.json first`)
  process.exit(1)
}
const target = explicit ?? bump(current, mode)
if (!SEMVER.test(target)) {
  console.error(`release: target version "${target}" is not semver (use X.Y.Z)`)
  process.exit(1)
}
if (explicit && semverLt(target, current)) {
  console.error(`release: target ${target} is older than current ${current}`)
  process.exit(1)
}

function semverLt(a, b) {
  const [am, ai, ap] = a.split('.').map(Number)
  const [bm, bi, bp] = b.split('.').map(Number)
  return am < bm || (am === bm && (ai < bi || (ai === bi && ap < bp)))
}

// ---- dirty-tree check (unrelated changes must not ride the release) ----

const porcelain = git(['status', '--porcelain'])
const dirty = porcelain
  .split('\n')
  .filter(Boolean)
  // porcelain is `XY PATH` where X/Y are the two status chars (an unchanged
  // column is a space) — so the path always starts after those two chars plus
  // the separating spaces. slice(2).trim() is shape-agnostic across staged
  // ("M  path"), unstaged (" M path") and untracked ("?? path") rows alike;
  // a fixed slice(3) would shave the leading character off staged rows.
  .map((line) => line.slice(2).trim())
  .filter((path) => !VERSION_FILES.includes(path))
if (dirty.length > 0 && !allowDirty) {
  console.error('release: unrelated working-tree changes would ride the release commit:')
  for (const path of dirty) console.error(`  ${path}`)
  console.error('commit or stash them first, or re-run with --allow-dirty')
  process.exit(1)
}

// ---- sync + verify + commit + push ----

syncVersionFiles(target)
console.log(`release: ${current} -> ${target} (${mode})`)

if (!args.includes('--no-check')) {
  console.log('release: cargo check …')
  try {
    execFileSync('cargo', ['check'], { cwd: join(root, 'src-tauri'), stdio: 'inherit' })
  } catch (_e) {
    console.error('release: cargo check failed — version left updated, fix before pushing')
    process.exit(1)
  }
}

git(['add', ...VERSION_FILES])
git(['commit', '-m', `release: v${target}`])
console.log(`release: committed release: v${target}`)

if (!noPush) {
  git(['push', 'origin', 'HEAD'])
  console.log('release: pushed — CI rolling release v' + target + ' is building')
}