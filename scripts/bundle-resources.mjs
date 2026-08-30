// Provision `resources/` for packaging — the build flavor is decided by what
// lives here:
//
//   npm run bundle:resources        (bundled flavor) copies the official Node
//                                   and the npm CLI into resources/; the dsh
//                                   runtime is NOT bundled — the shell installs
//                                   it on demand into the user-data dir.
//   node scripts/bundle-resources.mjs --external   (external flavor) REMOVES
//                                   those big artifacts, leaving only the tiny
//                                   overlay — the installed app then uses the
//                                   PC's own node and globally installed dsh.
//
// `tauri build` bundles resources/** next to the exe; Paths::resolve falls
// back to the project root in dev, so this script only matters for packages.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = join(root, 'resources')

const external = process.argv.includes('--external')

if (external) {
  // External flavor: drop the runtime payload, keep only the overlay.
  for (const rel of ['.dsh-runtime', 'node.exe', 'node_modules', 'dsh-runtime-seed']) {
    rmSync(join(out, rel), { recursive: true, force: true })
  }
  console.log('[bundle:resources] external flavor: removed .dsh-runtime / node.exe / node_modules / dsh-runtime-seed')
  process.exit(0)
}

// The bundled flavor MUST ship node + npm — a silently skipped copy would
// still "build" successfully and ship an installer whose on-demand 安装 dsh
// then dies with npm exit code 1 (the npm CLI path only exists on the build
// machine). Fail the build instead of shipping a broken package.
function copyRequired(src, dest, what) {
  if (!existsSync(src)) {
    throw new Error(`[bundle:resources] FATAL: ${what} missing at ${src} — the bundled installer would ship without node/npm. Run \`npm ci\` first (npm is a package.json dependency).`)
  }
  const destPath = join(out, dest)
  mkdirSync(dirname(destPath), { recursive: true })
  cpSync(src, destPath, { recursive: true })
  console.log(`[bundle:resources] ${src} -> resources/${dest}`)
}

// The embedded-run overlay is compiled INTO the exe (paths.rs include_str!)
// and materialized into user-data at runtime, so it is NOT copied here — a
// resources copy would go stale across launcher self-updates (which replace
// only the exe). The repo-root embedded-overlay.yml is the single source.
copyRequired(join(root, 'node_modules', 'npm'), 'node_modules/npm', 'the npm CLI')

// The official Node binary for THIS platform (the node running this script
// — i.e. the one npm used), named node.exe on Windows / node elsewhere.
// Override with DSH_NODE for a specific binary. Build each platform on its
// own OS so the bundled node and .dsh-runtime native modules match.
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeSrc = process.env.DSH_NODE || process.execPath

// The bundled node must satisfy the bundled npm CLI's engines — npm only
// WARNS on a mismatch today (the check-update parser already has to skip
// that warning), but any npm internal API bump turns the pair into an
// installer whose 安装 dsh fails on the user's machine. Fail the build.
function satisfiesEngines(version, range) {
  const v = version.trim().replace(/^v/, '').split('.').map(Number)
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  return range.split('||').some((clause) => {
    const m = clause.trim().match(/^(\^|>=)?\s*(\d+)\.(\d+)\.(\d+)$/)
    if (!m) return false
    const base = [+m[2], +m[3], +m[4]]
    if (m[1] === '^') return v[0] === base[0] && cmp(v, base) >= 0
    if (m[1] === '>=') return cmp(v, base) >= 0
    return cmp(v, base) === 0
  })
}
const npmEngines = JSON.parse(
  readFileSync(join(root, 'node_modules', 'npm', 'package.json'), 'utf8'),
).engines?.node
if (npmEngines) {
  const nodeVersion = execFileSync(nodeSrc, ['--version'], { encoding: 'utf8' }).trim()
  if (!satisfiesEngines(nodeVersion, npmEngines)) {
    throw new Error(
      `[bundle:resources] FATAL: bundled node ${nodeVersion} does not satisfy the bundled npm's engines (${npmEngines})` +
      ' — 安装 dsh would fail on user machines. Build with a newer node or set DSH_NODE.',
    )
  }
  console.log(`[bundle:resources] node ${nodeVersion} satisfies npm engines (${npmEngines})`)
}

cpSync(nodeSrc, join(out, nodeName))
console.log(`[bundle:resources] node ${nodeName} <- ${nodeSrc}`)

// Lockfile seed for the on-demand 安装 dsh: resolving dsh's ~250 same-version
// cross-linked packages from scratch pegs one core for 10+ minutes (semver
// backtracking, 4 GB heap — CPU-bound, mirrors do not help). With a lockfile
// the SAME install is `npm ci` — 528 packages resolved in under a second.
// Generate the lock once here, on the build machine (supported node/npm pair,
// fast network); npm's default replace-registry-host rewrites the locked
// npmjs.org URLs to whatever registry the USER configured (~/.npmrc mirror).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
{
  const seedTmp = mkdtempSync(join(tmpdir(), 'dsh-seed-'))
  writeFileSync(
    join(seedTmp, 'package.json'),
    JSON.stringify({ name: 'dsh-runtime', private: true, dependencies: { '@deepseek-ai/dsh': 'latest' } }),
  )
  const npmCli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try {
    execFileSync(nodeSrc, [npmCli, 'install', '--package-lock-only', '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: seedTmp,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 15 * 60 * 1000,
    })
    const lock = JSON.parse(readFileSync(join(seedTmp, 'package-lock.json'), 'utf8'))
    const pinned = lock.packages?.['node_modules/@deepseek-ai/dsh']?.version
    if (!pinned) throw new Error('seed lock has no @deepseek-ai/dsh entry')
    const seedOut = join(out, 'dsh-runtime-seed')
    mkdirSync(seedOut, { recursive: true })
    cpSync(join(seedTmp, 'package.json'), join(seedOut, 'package.json'))
    cpSync(join(seedTmp, 'package-lock.json'), join(seedOut, 'package-lock.json'))
    console.log(`[bundle:resources] runtime seed: @deepseek-ai/dsh@${pinned} lockfile -> resources/dsh-runtime-seed`)
  } catch (e) {
    // Not fatal: without the seed the shell falls back to a plain (slow but
    // correct) npm install at runtime.
    console.warn(`[bundle:resources] WARN: seed generation failed (${e.message}) — 安装 dsh will use the slow resolver path`)
  }
  rmSync(seedTmp, { recursive: true, force: true })
}
