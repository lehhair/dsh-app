// Remote-node registry: instance list (name/url/default) plus gateway keys
// encrypted with Electron safeStorage (DPAPI on Windows) and kept out of
// every renderer. Keys never leave the main process except through
// connectRemote's proxy injection.
//
// Storage layout (under userData):
//   instances.json  — public fields only, never a key
//   keys.json       — { [instanceId]: <safeStorage-encrypted base64> }
//
// @module registry

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Create the registry bound to one userData directory. */
function createRegistry(userDataPath, safeStorage) {
  const instancesFile = path.join(userDataPath, 'instances.json')
  const keysFile = path.join(userDataPath, 'keys.json')

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2))
  }

  /** All instances (public fields; never includes a key). */
  function list() {
    const doc = readJson(instancesFile, { instances: [] })
    return doc.instances ?? []
  }

  function find(id) {
    return list().find((instance) => instance.id === id)
  }

  /** Whether a key is stored for the instance (no value exposure). */
  function hasKey(id) {
    const keys = readJson(keysFile, {})
    return typeof keys[id] === 'string'
  }

  /** Decrypt the stored key for one instance. */
  function getSecret(id) {
    const keys = readJson(keysFile, {})
    const encrypted = keys[id]
    if (typeof encrypted !== 'string') return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return undefined
    }
  }

  /**
   * Create or update an instance.
   * @param input - { id?, name, url, key? } — key is stored only when non-empty.
   * @returns the saved instance (public fields).
   */
  function save(input) {
    const name = String(input.name ?? '').trim()
    const url = String(input.url ?? '').trim()
    if (name.length === 0) throw new Error('名称不能为空')
    if (!/^https?:\/\/[^/]+$/.test(url)) throw new Error('地址无效，形如 http://192.168.1.233:8443')

    const doc = readJson(instancesFile, { instances: [] })
    const instances = doc.instances ?? []
    const existing = input.id ? find(input.id) : undefined
    if (existing === undefined && input.id) throw new Error('实例不存在')

    const instance = existing
      ? { ...existing, name, url }
      : { id: crypto.randomUUID(), name, url }
    if (existing === undefined) instances.push(instance)
    else Object.assign(existing, { name, url })

    writeJson(instancesFile, { instances })

    if (input.key !== undefined && input.key !== '') {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用')
      const keys = readJson(keysFile, {})
      keys[instance.id] = safeStorage.encryptString(String(input.key)).toString('base64')
      writeJson(keysFile, keys)
    }
    return { ...instance, keyConfigured: hasKey(instance.id) }
  }

  /** Remove an instance and its stored key. */
  function remove(id) {
    const doc = readJson(instancesFile, { instances: [] })
    const instances = (doc.instances ?? []).filter((instance) => instance.id !== id)
    writeJson(instancesFile, { instances })
    const keys = readJson(keysFile, {})
    delete keys[id]
    writeJson(keysFile, keys)
  }

  /** Public view of all instances (with keyConfigured flag). */
  function view() {
    return list().map((instance) => ({
      ...instance,
      keyConfigured: hasKey(instance.id),
    }))
  }

  return { list, find, hasKey, getSecret, save, remove, view }
}

module.exports = { createRegistry }
