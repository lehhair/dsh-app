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
import { join } from 'node:path'
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
  mkdirSync(join(out, dest), { recursive: true })
  cpSync(src, join(out, dest), { recursive: true })
  console.log(`[bundle:resources] ${src} -> resources/${dest}`)
}

copy(join(root, 'embedded-overlay.yml'), 'embedded-overlay.yml')
copy(join(root, '.dsh-runtime'), '.dsh-runtime')
copy(join(root, 'node_modules', 'npm'), 'node_modules/npm')

// node.exe: prefer resources/node.exe (already provisioned), else DSH_NODE.
const nodeExe = join(root, 'resources', 'node.exe')
if (!existsSync(nodeExe)) {
  console.warn('[bundle:resources] resources/node.exe missing — copy a Windows Node binary there for packaging')
}
