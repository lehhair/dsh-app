// Provision `resources/` for packaging: the bundled official Node, the
// embedded dsh runtime (.dsh-runtime), the npm CLI (node_modules/npm), and
// the embedded overlay. Run before `tauri build` (npm run bundle:resources).
//
// `tauri build` bundles resources/** next to the exe; Paths::resolve falls
// back to the project root in dev, so this script only matters for packages.

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = join(root, 'resources')

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
