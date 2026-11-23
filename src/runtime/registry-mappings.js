'use strict'

// Data-only server registry mappings. This does NOT execute Java Mod code, mutate
// prismarine-registry, or establish arbitrary mod-client compatibility.
const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const MAX_REGISTRIES = 256
const MAX_ENTRIES = 65536

class ServerRegistryMappings {
  constructor () {
    this._data = new Map()
    this._version = 0
    this.events = []
  }

  installEntries (registryName, entries, source) {
    return this.install({ registryName, source, hasSnapshot: true, entriesDecoded: true,
      snapshot: { ids: entries, aliases: [], overrides: [], blocked: [] } })
  }

  install (details, messageId = null) {
    if (!details || !ID_RE.test(details.registryName || '')) throw new Error('invalid_registry_name')
    const name = details.registryName
    if (this._data.size >= MAX_REGISTRIES && !this._data.has(name)) throw new Error('registry_count_limit')
    if (details.hasSnapshot === false) {
      // The server explicitly sent no snapshot. Preserve any previous mapping.
      this.events.push({ type: 'no-snapshot', registry: name, messageId })
      return { registry: name, status: 'no-snapshot', applied: true, entryCount: 0 }
    }
    if (details.hasSnapshot !== true || details.entriesDecoded !== true || !details.snapshot) {
      throw new Error('registry_snapshot_not_decoded')
    }
    const { ids, aliases, overrides, blocked } = details.snapshot
    if (![ids, aliases, overrides, blocked].every(Array.isArray)) throw new Error('invalid_registry_snapshot_shape')
    const existingCount = [...this._data.values()].reduce((n, x) => n + x.size, 0)
    const replacingCount = this._data.get(name)?.size || 0
    if (ids.length > MAX_ENTRIES || existingCount - replacingCount + ids.length > MAX_ENTRIES) throw new Error('registry_entry_limit')
    const byName = new Map(); const byId = new Map(); const aliasMap = new Map()
    for (const item of ids) {
      if (!item || !ID_RE.test(item.name || '') || !Number.isSafeInteger(item.id) || item.id < 0 || item.id > 2147483647 || byName.has(item.name) || byId.has(item.id)) throw new Error('invalid_registry_id_entry')
      byName.set(item.name, item.id); byId.set(item.id, item.name)
    }
    for (const item of aliases) {
      if (!item || !ID_RE.test(item.from || '') || !ID_RE.test(item.to || '') || aliasMap.has(item.from) || byName.has(item.from)) throw new Error('invalid_registry_alias')
      aliasMap.set(item.from, item.to)
    }
    for (const from of aliasMap.keys()) {
      const visited = new Set([from]); let current = aliasMap.get(from)
      while (aliasMap.has(current)) {
        if (visited.has(current)) throw new Error('registry_alias_cycle')
        visited.add(current); current = aliasMap.get(current)
      }
    }
    for (const entry of overrides) if (!entry || !ID_RE.test(entry.name || '') || typeof entry.owner !== 'string') throw new Error('invalid_registry_override')
    for (const n of blocked) if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647) throw new Error('invalid_registry_blocked')
    // Atomic commit: no partial mutation on validation failure.
    this._data.set(name, { byName, byId, aliases: aliasMap, blocked: new Set(blocked), size: byName.size, messageId, overrides: overrides.length, source: details.source || 'server-registry' })
    this._version++
    this.events.push({ type: 'installed', registry: name, messageId, size: byName.size })
    if (this.events.length > 256) this.events.shift()
    return { registry: name, status: 'installed-mapping-only', applied: true, entryCount: byName.size }
  }

  getId (registry, identifier) {
    const item = this._data.get(registry)
    if (!item) return null
    const visited = new Set()
    while (item.aliases.has(identifier)) {
      if (visited.has(identifier)) return null
      visited.add(identifier); identifier = item.aliases.get(identifier)
    }
    return item.byName.get(identifier) ?? null
  }

  // Detached snapshot for per-bot native registry bridges. Never leak Map internals.
  getEntries (registry) {
    const r = this._data.get(registry)
    return r ? [...r.byId.entries()].map(([id, name]) => ({ id, name })) : null
  }

  getName (registry, id) { return this._data.get(registry)?.byId.get(id) ?? null }
  getSource (registry) { return this._data.get(registry)?.source ?? null }
  getReport () {
    return {
      mappingInstalledCount: this._data.size,
      totalEntries: [...this._data.values()].reduce((n, x) => n + x.size, 0),
      version: this._version,
      registries: [...this._data].map(([name, value]) => ({ name, entries: value.size, aliases: value.aliases.size, blocked: value.blocked.size })),
      appliedToMineflayer: false,
      events: this.events.slice(-40)
    }
  }
}

module.exports = { ServerRegistryMappings }
