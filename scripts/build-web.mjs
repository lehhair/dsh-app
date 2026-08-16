// Build the bundled frontend into web/dist: esbuild-bundle the two page
// entry points (launcher/settings) and copy the static assets. Tauri serves
// web/dist as frontendDist in both dev and build.

import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = join(root, 'web', 'dist')

mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    launcher: join(root, 'web', 'src', 'launcher.js'),
    settings: join(root, 'web', 'src', 'settings.js'),
  },
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'safari15'],
  outdir: out,
  outbase: join(root, 'web', 'src'),
  logLevel: 'info',
})

for (const file of ['index.html', 'settings.html', 'fish.svg']) {
  cpSync(join(root, 'web', file), join(out, file))
  console.log(`[build:web] copied ${file}`)
}
