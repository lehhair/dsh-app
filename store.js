// Shell behavior store: small JSON under userData for non-instance settings
// (e.g. restore-last-node on launch). Separate from the registry, which owns
// remote instances and their encrypted keys.
//
// @module store

const fs = require('node:fs')
const path = require('node:path')

/** Create a key-value store backed by one JSON file. */
function createStore(userDataPath) {
  const file = path.join(userDataPath, 'shell.json')

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  function write(patch) {
    const doc = { ...read(), ...patch }
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  }

  return {
    /** Read one key (undefined when absent). */
    get(key) {
      return read()[key]
    },
    /** Set one key and persist. */
    set(key, value) {
      write({ [key]: value })
    },
  }
}

module.exports = { createStore }
