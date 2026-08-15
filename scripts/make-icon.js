// One-shot icon generator: renders icon.svg at several sizes with Electron's
// offscreen rendering and packs them into icon.ico (PNG-compressed entries,
// which Windows Vista+ supports) plus a 256px icon.png.
//
// Usage: node scripts/make-icon.js   (run under Electron, not plain node —
//   needs a GUI runtime for offscreen rendering; invoked via electron.cmd)

const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SVG = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Render the svg at `size` px and return raw PNG bytes. */
async function renderPng(win, size) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
    svg { display: block; width: 100%; height: 100%; }
  </style></head><body>${SVG}</body></html>`
  const htmlFile = path.join(ROOT, '.icon-render.html')
  fs.writeFileSync(htmlFile, html)
  win.setSize(size, size)
  win.webContents.setBackgroundThrottling(false)
  await win.loadFile(htmlFile)
  // Give the offscreen painter a frame to actually rasterize.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  // capturePage returns device pixels (DPI-scaled) — resample to the exact
  // declared size so the ICO entries and the 256px PNG are honest.
  const png = image.resize({ width: size, height: size }).toPNG()
  if (!png || png.length === 0) throw new Error(`empty capture at ${size}px`)
  return png
}

/** Pack PNG blobs into an ICO container (Vista+ PNG entries). */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirEntrySize = 16
  const parts = [header]
  let offset = 6 + dirEntrySize * entries.length
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(dirEntrySize)
    dir.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, 1)
    dir.writeUInt8(0, 2) // palette
    dir.writeUInt8(0, 3) // reserved
    dir.writeUInt16LE(1, 4) // planes
    dir.writeUInt16LE(32, 6) // bpp
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    parts.push(dir)
    offset += png.length
  }
  for (const { png } of entries) parts.push(png)
  return Buffer.concat(parts)
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 16,
      height: 16,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true, sandbox: false, webSecurity: false },
    })
    const entries = []
    for (const size of SIZES) {
      const png = await renderPng(win, size)
      entries.push({ size, png })
      console.log(`rendered ${size}px (${png.length} bytes)`)
    }
    win.destroy()
    fs.writeFileSync(path.join(ROOT, 'icon.ico'), buildIco(entries))
    fs.writeFileSync(path.join(ROOT, 'icon.png'), entries.find((e) => e.size === 256).png)
    console.log('wrote icon.ico and icon.png')
  } catch (error) {
    console.error('icon generation failed:', error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
