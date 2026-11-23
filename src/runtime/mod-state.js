'use strict'

// Generic, bounded, in-memory projection of *decoded observations*.
// This is NOT a Java Mod implementation: observations never imply an
// acknowledged client handler, registered Mod, or supported Forge channel.
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_ENTRIES = 128
const MAX_TOTAL_BYTES = 512 * 1024
const MAX_VALUE_BYTES = 64 * 1024
const VALID_STATUSES = new Set(['candidate-only', 'structural-only', 'envelope-only', 'handled'])

function safeClone (value, depth = 0, budget = { bytes: 0, nodes: 0 }) {
  if (++budget.nodes > 4096 || depth > 12) throw new Error('mod_state_value_depth_limit')
  if (value === null || typeof value === 'boolean') { budget.bytes += 8; return value }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('mod_state_invalid_number')
    budget.bytes += 16; return value
  }
  if (typeof value === 'bigint') { budget.bytes += 32; return value }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > 8192) throw new Error('mod_state_string_limit')
    budget.bytes += bytes + 8
    if (budget.bytes > MAX_VALUE_BYTES) throw new Error('mod_state_value_limit')
    return value
  }
  if (Buffer.isBuffer(value)) throw new Error('mod_state_no_raw_bytes')
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error('mod_state_array_limit')
    budget.bytes += value.length * 8
    return value.map(v => safeClone(v, depth + 1, budget))
  }
  if (value && typeof value === 'object') {
    const props = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(props)
    if (keys.length > 128) throw new Error('mod_state_object_limit')
    const output = Object.create(null)
    for (const key of keys) {
      if (RESERVED.has(key) || key.length > 128 || !Object.hasOwn(props[key], 'value')) throw new Error('mod_state_invalid_field')
      budget.bytes += Buffer.byteLength(key, 'utf8') + 8
      output[key] = safeClone(props[key].value, depth + 1, budget)
    }
    if (budget.bytes > MAX_VALUE_BYTES) throw new Error('mod_state_value_limit')
    return output
  }
  throw new Error('mod_state_unsupported_value')
}

function publicClone (value) { return safeClone(value) }
function jsonSafe (value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
  return value
}

class ModStateStore {
  constructor (options = {}) {
    if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)) throw new Error('invalid_state_entry_limit')
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 128)) throw new Error('invalid_state_byte_limit')
    this.maxEntries = Math.min(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES)
    this.maxBytes = Math.min(options.maxBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES)
    this._entries = new Map()
    this._version = 0
    this._bytes = 0
    this._counters = { observed: 0, handled: 0, rejected: 0, evicted: 0 }
    this.errors = []
  }
  record ({ channel, discriminator, id = null, status, data, entityKey = null, evidence = 'live-decoder' } = {}) {
    try {
      if (!ID.test(channel || '') || channel.length > 256 ||
          !Number.isInteger(discriminator) || discriminator < 0 || discriminator > 255 ||
          !VALID_STATUSES.has(status) || (id !== null && (typeof id !== 'string' || !ID.test(id))) ||
          (entityKey !== null && (typeof entityKey !== 'string' || entityKey.length > 256)) ||
          !['live-decoder', 'offline-wire-replay', 'imported-replay-report'].includes(evidence)) throw new Error('mod_state_invalid_record')
      if (status === 'envelope-only' && (data?.decodedBody !== false || typeof data?.resourceLocation !== 'string')) throw new Error('mod_state_invalid_envelope')
      const budget = { bytes: 0, nodes: 0 }
      const cloned = safeClone(data, 0, budget)
      const bytes = budget.bytes + 128
      if (bytes > MAX_VALUE_BYTES || bytes > this.maxBytes) throw new Error('mod_state_value_limit')
      const key = JSON.stringify([channel, discriminator, entityKey])
      const previous = this._entries.get(key)
      if (previous) { this._bytes -= previous._bytes; this._entries.delete(key) }
      const entry = { channel, discriminator, id, status, data: cloned, entityKey, evidence,
        decoded: status !== 'envelope-only', appliedToModRuntime: status === 'handled',
        revision: ++this._version, _bytes: bytes }
      while (this._entries.size >= this.maxEntries || this._bytes + bytes > this.maxBytes) {
        const first = this._entries.keys().next().value
        if (first === undefined) throw new Error('mod_state_capacity')
        const evicted = this._entries.get(first)
        this._bytes -= evicted._bytes
        this._entries.delete(first)
        this._counters.evicted++
      }
      this._entries.set(key, entry)
      this._bytes += bytes
      this._counters[status === 'handled' ? 'handled' : 'observed']++
      return this._exportEntry(entry)
    } catch (err) {
      this._counters.rejected++
      this.errors.push(err.message)
      if (this.errors.length > 16) this.errors.shift()
      return null // Must never break the underlying network state machine
    }
  }
  _exportEntry (entry, forJson = false) {
    if (!entry) return null
    const { _bytes, ...metadata } = entry
    return { ...metadata, data: forJson ? jsonSafe(entry.data) : publicClone(entry.data) }
  }
  getLatest (channel, discriminator, entityKey) {
    // With an entityKey: exact indexed lookup. Without: latest observation
    // regardless of its resource key; no accidental mixing across channels.
    if (entityKey !== undefined) return this._exportEntry(this._entries.get(JSON.stringify([channel, discriminator, entityKey])))
    for (const item of [...this._entries.values()].reverse()) if (item.channel === channel && item.discriminator === discriminator) return this._exportEntry(item)
    return null
  }
  getApplied (channel, discriminator, entityKey) {
    const entry = this.getLatest(channel, discriminator, entityKey)
    return entry?.appliedToModRuntime === true ? entry : null
  }
  getByMessageId (id) {
    return [...this._entries.values()].filter(item => item.id === id).map(item => this._exportEntry(item))
  }
  getKeys (channel, discriminator) {
    return [...this._entries.values()].filter(item => item.channel === channel && item.discriminator === discriminator).map(item => item.entityKey)
  }
  getReport ({ includeValues = false } = {}) {
    return { schema: 'mineflayer-mod-support/mod-state/v1', version: this._version,
      entryCount: this._entries.size, storedBytesEstimate: this._bytes, counts: { ...this._counters },
      entries: [...this._entries.values()].map(item => {
        const { data, _bytes, ...rest } = item
        return includeValues ? { ...rest, data: jsonSafe(data) } : rest
      }), errors: [...this.errors], modClientSemanticsImplemented: false, modChannelsAdvertisable: false }
  }
}
module.exports = { ModStateStore, safeClone }
