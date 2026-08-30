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

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = join(root, 'resources')

const external = process.argv.includes('--external')

if (external) {
  // External flavor: drop the runtime payload, keep only the overlay.
  for (const rel of ['.dsh-runtime', 'node.exe', 'node_modules']) {
    rmSync(join(out, rel), { recursive: true, force: true })
  }
  console.log('[bundle:resources] external flavor: removed .dsh-runtime / node.exe / node_modules')
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
cpSync(nodeSrc, join(out, nodeName))
console.log(`[bundle:resources] node ${nodeName} <- ${nodeSrc}`)
