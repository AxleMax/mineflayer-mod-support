'use strict'

// Registry snapshots remain opaque. This is a bounded, metadata-only receiver;
// it does not install Forge IDs into prismarine-registry or acknowledge sync.
const { createHash } = require('node:crypto')
const MAX_REGISTRIES = 256
const MAX_DECODED_ENTRIES = 65536

class ForgeRegistryObserver {
  constructor () { this.reset() }
  reset () { this._received = new Map(); this._decoded = new Map(); this._warnings = [] }
  observe (details, messageId) {
    if (!details || typeof details.registryName !== 'string' || typeof details.snapshotBytes !== 'number') return null
    const { registryName, hasSnapshot, snapshotBytes, snapshotDigest } = details
    if (this._received.size >= MAX_REGISTRIES && !this._received.has(registryName)) {
      this._warnings.push('registry_limit_exceeded')
      return null
    }
    if (this._received.has(registryName)) this._warnings.push('duplicate_registry:' + registryName)
    const record = {
      name: registryName,
      hasSnapshot: hasSnapshot === true,
      opaqueSnapshotBytes: snapshotBytes,
      sha256: snapshotDigest || null,
      messageId,
      status: 'received-opaque-not-applied'
    }
    if (details.entriesDecoded === true && details.snapshot) {
      const snapshot = details.snapshot
      const count = snapshot.ids.length + snapshot.aliases.length + snapshot.overrides.length + snapshot.blocked.length
      const previouslyStored = this._decoded.get(registryName)
      const previousCount = previouslyStored ? previouslyStored.ids.length + previouslyStored.aliases.length + previouslyStored.overrides.length + previouslyStored.blocked.length : 0
      const currentTotal = [...this._decoded.values()].reduce((sum, item) => sum + item.ids.length + item.aliases.length + item.overrides.length + item.blocked.length, 0)
      if (count <= 16384 && currentTotal - previousCount + count <= MAX_DECODED_ENTRIES) {
        record.status = 'decoded-read-only-not-applied'
        record.entryCounts = { ...details.entryCounts }
        this._decoded.set(registryName, structuredClone(snapshot))
      } else {
        record.decodeError = 'registry_entry_budget_exceeded'
      }
    } else if (details.snapshotDecodeError) {
      record.decodeError = details.snapshotDecodeError
    }
    this._received.set(registryName, record)
    return { ...record }
  }
  getRegistry (name) {
    const snapshot = this._decoded.get(name)
    return snapshot ? structuredClone(snapshot) : null
  }
  getId (registryName, entryName) {
    const snapshot = this._decoded.get(registryName)
    return snapshot?.ids.find(x => x.name === entryName)?.id ?? null
  }
  getName (registryName, numericId) {
    const snapshot = this._decoded.get(registryName)
    return snapshot?.ids.find(x => x.id === numericId)?.name ?? null
  }
  getReport () {
    return {
      receivedCount: this._received.size,
      decodedCount: this._decoded.size,
      snapshots: [...this._received.values()].map(v => ({ ...v })),
      applied: false,
      ackSent: false,
      warnings: [...this._warnings]
    }
  }
}

function summarizeOpaqueSnapshot (bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Expected registry snapshot bytes')
  return { snapshotBytes: bytes.length, snapshotDigest: createHash('sha256').update(bytes).digest('hex') }
}

module.exports = { ForgeRegistryObserver, summarizeOpaqueSnapshot }
