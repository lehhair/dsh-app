// Verify every id referenced by getElementById in shell.html exists in the markup.
const fs = require('node:fs')
const html = fs.readFileSync('shell.html', 'utf8')
const script = html.slice(html.lastIndexOf('<script>'))
const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
const missing = ids.filter((id) => !html.includes(`id="${id}"`))
console.log(`referenced ids: ${ids.length}`)
console.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'all ids present')
process.exitCode = missing.length ? 1 : 0
