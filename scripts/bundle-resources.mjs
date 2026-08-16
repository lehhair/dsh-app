// Provision `resources/` for packaging — the build flavor is decided by what
// lives here:
//
//   npm run bundle:resources        (bundled flavor) copies the official Node,
//                                   the embedded dsh runtime (.dsh-runtime),
//                                   and the npm CLI into resources/ so the
//                                   installed app is self-contained.
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

function copy(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[bundle:resources] missing source, skipped: ${src}`)
    return
  }
  const destPath = join(out, dest)
  mkdirSync(dirname(destPath), { recursive: true })
  cpSync(src, destPath, { recursive: true })
  console.log(`[bundle:resources] ${src} -> resources/${dest}`)
}

copy(join(root, 'embedded-overlay.yml'), 'embedded-overlay.yml')
copy(join(root, '.dsh-runtime'), '.dsh-runtime')
copy(join(root, 'node_modules', 'npm'), 'node_modules/npm')

// The official Node binary for THIS platform (the node running this script
// — i.e. the one npm used), named node.exe on Windows / node elsewhere.
// Override with DSH_NODE for a specific binary. Build each platform on its
// own OS so the bundled node and .dsh-runtime native modules match.
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeSrc = process.env.DSH_NODE || process.execPath
cpSync(nodeSrc, join(out, nodeName))
console.log(`[bundle:resources] node ${nodeName} <- ${nodeSrc}`)
