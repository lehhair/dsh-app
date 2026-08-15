// Registry unit smoke: CRUD + key encryption round-trip with a fake
// safeStorage (base64 stand-in for DPAPI).
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { createRegistry } = require('./registry')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reg-'))
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
}

const reg = createRegistry(dir, fakeSafeStorage)

// empty
if (reg.view().length !== 0) throw new Error('expected empty')
// save two
const a = reg.save({ name: '书房网关', url: 'http://192.168.1.233:8443', key: 'k1-secret' })
const b = reg.save({ name: '机房', url: 'https://gw.example.com:443', key: 'k2' })
if (!a.keyConfigured || !b.keyConfigured) throw new Error('keyConfigured wrong')
if (reg.getSecret(a.id) !== 'k1-secret') throw new Error('key round-trip failed')
// update without key keeps secret
const a2 = reg.save({ id: a.id, name: '书房', url: a.url })
if (reg.getSecret(a2.id) !== 'k1-secret') throw new Error('update dropped key')
// update with new key replaces
reg.save({ id: a.id, name: '书房', url: a.url, key: 'k1-new' })
if (reg.getSecret(a.id) !== 'k1-new') throw new Error('key replace failed')
// view redacts
const view = reg.view().find((i) => i.id === a.id)
if ('key' in view) throw new Error('view leaked key')
// remove
reg.remove(a.id)
if (reg.find(a.id) !== undefined) throw new Error('remove failed')
if (reg.getSecret(a.id) !== undefined) throw new Error('key not removed')
console.log('registry smoke OK — add/save/switch/delete, key encrypted, views redacted')
