'use strict'

// P2.5: Generic, bounded projections derived from JAR Codec IR. These are
// *observations*, not execution of Java client handlers or authoritative
// Minecraft world state. No mod names or discriminator numbers are hardcoded.
const { safeClone } = require('./mod-state')
const { isDeepStrictEqual } = require('node:util')
const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/
const MAX_PROJECTIONS = 64
const MAX_ITEMS = 256
const MAX_BYTES = 512 * 1024
const MAX_ENTRY_BYTES = 64 * 1024

function resolved (node, definitions) {
  let depth = 0
  while (node?.type === 'ref') {
    if (++depth > 12) return null
    node = definitions[node.name]
  }
  return node || null
}
function identifierField (node, definitions) {
  const n = resolved(node, definitions)
  if (n?.type !== 'struct') return null
  const field = n.fields?.[0]
  const kind = resolved(field?.codec, definitions)?.type
  return kind === 'uuid' || kind === 'resource_location' ? field.name : null
}
function collectionChanges (prior, ids, values) {
  if (!ids || (prior && !prior.itemIds)) return null
  const previous = new Map(prior?.itemIds.map((id, index) => [id, prior.value[index]]))
  const current = new Set(ids)
  return {
    added: ids.filter(id => !previous.has(id)),
    updated: ids.filter((id, index) => previous.has(id) && !isDeepStrictEqual(values[index], previous.get(id))),
    removed: [...previous.keys()].filter(id => !current.has(id))
  }
}

function buildProjectionSpec (message) {
  if (!message || message.direction !== 'clientbound' || !message.codecPlan ||
      !['structural-candidate', 'candidate-codec'].includes(message.codecStatus) ||
      typeof message.predictedChannel !== 'string' || !ID.test(message.predictedChannel) ||
      !Number.isSafeInteger(message.predictedDiscriminator) || message.predictedDiscriminator < 0 || message.predictedDiscriminator > 255) return null
  const plan = message.codecPlan
  const definitions = plan.definitions || {}
  const root = resolved(plan.root, definitions)
  if (root?.type !== 'struct' || !Array.isArray(root.fields)) return null
  const first = root.fields[0]
  const prefixKind = resolved(first?.codec, definitions)?.type
  for (const field of root.fields) {
    const value = resolved(field.codec, definitions)
    if (value?.type === 'list') {
      // Only a clearly observed, bounded list is a collection projection.
      const element = resolved(value.element, definitions)
      return { kind: 'collection', channel: message.predictedChannel, discriminator: message.predictedDiscriminator,
        messageId: message.id, valueField: field.name,
        resourceField: ['resource_location', 'uuid'].includes(prefixKind) ? first.name : null,
        itemKeyField: identifierField(element, definitions), maxItems: Math.min(MAX_ITEMS, value.maxItems ?? MAX_ITEMS) }
    }
  }
  if (root.fields.length === 1) {
    const nested = resolved(first.codec, definitions)
    if (nested?.type === 'struct') {
      const key = identifierField(nested, definitions)
      if (key) return { kind: 'object', channel: message.predictedChannel, discriminator: message.predictedDiscriminator,
        messageId: message.id, valueField: first.name, itemKeyField: key }
    }
  }
  return null
}

function toReportValue (value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toReportValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, toReportValue(val)]))
  return value
}

class GenericModDataRuntime {
  constructor ({ manifest = null, registryMappings = null, maxProjections = MAX_PROJECTIONS, maxBytes = MAX_BYTES } = {}) {
    if (!Number.isSafeInteger(maxProjections) || maxProjections < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new Error('invalid_mod_data_limits')
    this.maxProjections = Math.min(maxProjections, MAX_PROJECTIONS)
    this.maxBytes = Math.min(maxBytes, MAX_BYTES)
    this.registryMappings = registryMappings
    this._specs = new Map()
    this._blockedSpecs = new Set()
    this._values = new Map()
    this._bytes = 0
    this._revision = 0
    this.counts = { observedCollections: 0, observedObjects: 0, skipped: 0, rejected: 0, evicted: 0 }
    this.errors = []
    for (const message of manifest?.messages || []) {
      const spec = buildProjectionSpec(message)
      if (!spec) continue
      const key = spec.channel + '\0' + spec.discriminator
      if (this._blockedSpecs.has(key)) continue
      if (this._specs.has(key)) { this._specs.delete(key); this._blockedSpecs.add(key) } // conflict: permanently fail closed
      else this._specs.set(key, spec)
    }
  }
  observe (entry) {
    try {
      if (!entry || !['structural-only', 'candidate-only', 'handled'].includes(entry.status) || entry.decoded !== true ||
          typeof entry.channel !== 'string' || !Number.isSafeInteger(entry.discriminator) ||
          typeof entry.data !== 'object' || entry.data === null) {
        this.counts.skipped++; return null
      }
      const spec = this._specs.get(entry.channel + '\0' + entry.discriminator)
      if (!spec || entry.id !== spec.messageId) { this.counts.skipped++; return null }
      const data = safeClone(entry.data)
      const value = data[spec.valueField]
      let entityKey
      let itemIds = null
      if (spec.kind === 'collection') {
        if (!Array.isArray(value) || value.length > spec.maxItems) throw new Error('mod_data_collection_limit')
        entityKey = spec.resourceField ? data[spec.resourceField] : null
        if (entityKey !== null && (typeof entityKey !== 'string' || entityKey.length > 256)) throw new Error('mod_data_invalid_resource_key')
        if (entry.entityKey !== null && entry.entityKey !== undefined && entry.entityKey !== entityKey) throw new Error('mod_data_key_mismatch')
        if (spec.itemKeyField && value.every(x => x && typeof x === 'object' && typeof x[spec.itemKeyField] === 'string')) {
          const candidates = value.map(x => x[spec.itemKeyField])
          if (candidates.every(v => v.length <= 256) && new Set(candidates).size === candidates.length) itemIds = candidates
        }
      } else {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value[spec.itemKeyField] !== 'string') throw new Error('mod_data_invalid_object')
        entityKey = value[spec.itemKeyField]
        if (entityKey.length > 256) throw new Error('mod_data_invalid_resource_key')
      }
      const key = JSON.stringify([spec.channel, spec.discriminator, entityKey])
      const prior = this._values.get(key)
      const changes = spec.kind === 'collection' ? collectionChanges(prior, itemIds, value) : null
      const output = { channel: spec.channel, discriminator: spec.discriminator, id: spec.messageId,
        kind: spec.kind, entityKey, status: 'observed-' + spec.kind,
        observationStatus: entry.status, evidence: entry.evidence || 'live-decoder',
        appliedToModRuntime: entry.appliedToModRuntime === true && entry.status === 'handled',
        revision: this._revision + 1, value,
        itemIds, changes, itemCount: spec.kind === 'collection' ? value.length : 1 }
      // Do not allow huge entities or a single payload to exhaust all state.
      const bytes = Buffer.byteLength(JSON.stringify(toReportValue(output)), 'utf8') + 128
      if (bytes > MAX_ENTRY_BYTES || bytes > this.maxBytes) throw new Error('mod_data_value_limit')
      if (prior) { this._bytes -= prior._bytes; this._values.delete(key) }
      while (this._values.size >= this.maxProjections || this._bytes + bytes > this.maxBytes) {
        const oldest = this._values.keys().next().value
        if (oldest === undefined) throw new Error('mod_data_capacity')
        this._bytes -= this._values.get(oldest)._bytes
        this._values.delete(oldest); this.counts.evicted++
      }
      this._values.set(key, { ...output, _bytes: bytes }); this._bytes += bytes
      this._revision = output.revision
      this.counts[spec.kind === 'collection' ? 'observedCollections' : 'observedObjects']++
      return this._export(this._values.get(key))
    } catch (error) {
      this.counts.rejected++
      this.errors.push(String(error.message || error))
      if (this.errors.length > 16) this.errors.shift()
      return null
    }
  }
  _export (data) {
    if (!data) return null
    const { _bytes, ...rest } = data
    return { ...rest, value: safeClone(rest.value), itemIds: rest.itemIds ? [...rest.itemIds] : null, changes: structuredClone(rest.changes) }
  }
  _find (kind, channel, discriminator, entityKey) {
    if (entityKey !== undefined) {
      const item = this._values.get(JSON.stringify([channel, discriminator, entityKey]))
      return item?.kind === kind ? item : null
    }
    for (const item of [...this._values.values()].reverse()) if (item.kind === kind && item.channel === channel && item.discriminator === discriminator) return item
    return null
  }
  getCollection (channel, discriminator, entityKey) { return this._export(this._find('collection', channel, discriminator, entityKey)) }
  getObject (channel, discriminator, entityKey) { return this._export(this._find('object', channel, discriminator, entityKey)) }
  getCollectionItem (channel, discriminator, entityKey, itemIdOrIndex) {
    const v = this._find('collection', channel, discriminator, entityKey)
    if (!v) return null
    const index = Number.isSafeInteger(itemIdOrIndex) ? itemIdOrIndex : (v.itemIds ? v.itemIds.indexOf(itemIdOrIndex) : -1)
    return index >= 0 && index < v.value.length ? safeClone(v.value[index]) : null
  }
  listProjections () { return [...this._values.values()].map(item => ({ channel: item.channel, discriminator: item.discriminator, kind: item.kind, entityKey: item.entityKey, itemCount: item.itemCount, revision: item.revision, appliedToModRuntime: item.appliedToModRuntime })) }
  getRegistryId (registry, resource) { return this.registryMappings?.getId(registry, resource) ?? null }
  getRegistryName (registry, id) { return this.registryMappings?.getName(registry, id) ?? null }
  resolveRegistry (registry, resourceOrId) {
    if (!ID.test(registry || '')) return null
    const id = typeof resourceOrId === 'string' ? this.getRegistryId(registry, resourceOrId) : resourceOrId
    if (!Number.isSafeInteger(id) || id < 0) return null
    const name = this.getRegistryName(registry, id)
    return name ? { registry, name, id, source: this.registryMappings.getSource?.(registry) || 'server-registry', appliedToMineflayer: false } : null
  }
  getReport ({ includeValues = false } = {}) {
    return { schema: 'mineflayer-mod-support/mod-data/v1', revision: this._revision,
      projectionCount: this._values.size, knownCodecStructures: this._specs.size,
      storedBytesEstimate: this._bytes, counts: { ...this.counts },
      projections: [...this._values.values()].map(item => {
        const { _bytes, value, ...rest } = item
        const metadata = { ...rest, itemIds: rest.itemIds ? [...rest.itemIds] : null, changes: structuredClone(rest.changes) }
        return includeValues ? { ...metadata, value: toReportValue(value) } : metadata
      }), errors: [...this.errors],
      registryView: { mappingInstalledCount: this.registryMappings?.getReport().mappingInstalledCount ?? 0, appliedToMineflayer: false },
      modClientSemanticsImplemented: false, canAdvertiseModChannels: false }
  }
}
module.exports = { GenericModDataRuntime, buildProjectionSpec }
