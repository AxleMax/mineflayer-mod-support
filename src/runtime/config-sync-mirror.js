'use strict'

// Balm's generic config-sync transport, decoded using JVM classfile *metadata*,
// never Java execution. Config data comes from any registered mod's ConfigData
// class. Unknown property codecs fail closed (rather than guessed offsets).
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { ZipArchive } = require('../analyzer/zip')
const { readClass } = require('../analyzer/classfile')
const { analyzeJars } = require('../analyzer/mod-jar')
const { WireReader, WireWriter } = require('../protocol/forge/wire')
const { unpackSimpleChannel } = require('../protocol/forge/simple-channel')

const MAX_CONFIG_BYTES = 32767
const MAX_CLASSES = 256
const MAX_FIELDS = 256
const MAX_CONFIGS = 16
const MAX_CATEGORIES = 64
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const ID_NAMESPACE = /^([a-z0-9_.-]+):[a-z0-9_./-]+$/

function propertyType (descriptor, archive) {
  const scalar = { Z: 'boolean', B: 'byte', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double', 'Ljava/lang/String;': 'string', 'Lnet/minecraft/resources/ResourceLocation;': 'resource_location' }
  if (Object.hasOwn(scalar, descriptor)) return scalar[descriptor]
  if (typeof descriptor !== 'string' || !descriptor.startsWith('L') || !descriptor.endsWith(';')) return 'unsupported'
  const classPath = descriptor.slice(1, -1)
  if (!archive.has(`${classPath}.class`)) return 'unsupported'
  const cls = readClass(archive.read(`${classPath}.class`))
  if ((cls.access & 0x4000) !== 0) return 'enum_ordinal_int'
  return 'unsupported'
}
function extractProperties (cls, archive) {
  const properties = new Map()
  for (const field of cls.fields) {
    if ((field.flags & 0x0008) !== 0 || !SAFE_NAME.test(field.name) || properties.has(field.name)) continue
    properties.set(field.name, propertyType(field.descriptor, archive))
  }
  return properties
}
function extractConfigClass (archive, configClass) {
  const source = archive.read(`${configClass}.class`)
  if (!source) throw new Error('config_schema_class_missing')
  const cls = readClass(source)
  const roots = new Map()
  const groups = new Map()
  let fieldCount = 0
  for (const field of cls.fields) {
    if ((field.flags & 0x0008) !== 0 || !SAFE_NAME.test(field.name)) continue
    const nested = field.descriptor.startsWith('L') ? field.descriptor.slice(1, -1) : ''
    if (nested.startsWith(configClass + '$') && archive.has(`${nested}.class`)) {
      const group = readClass(archive.read(`${nested}.class`))
      const props = extractProperties(group, archive)
      if (!props.size || props.size > MAX_FIELDS || groups.has(field.name)) throw new Error('invalid_config_schema_group')
      groups.set(field.name, props)
      fieldCount += props.size
    } else {
      roots.set(field.name, propertyType(field.descriptor, archive))
      fieldCount++
    }
  }
  if (fieldCount > MAX_FIELDS || !fieldCount || groups.size > MAX_CATEGORIES) throw new Error('invalid_config_schema_size')
  return { roots, groups, fieldCount, configClass }
}
function jarPathsFromDir (dir) {
  const stats = fs.statSync(dir)
  if (!stats.isDirectory()) throw new Error('config_schema_mods_dir_not_directory')
  const files = fs.readdirSync(dir).filter(name => name.toLowerCase().endsWith('.jar')).sort()
  if (files.length > MAX_CLASSES) throw new Error('config_schema_jar_count_limit')
  return files.map(name => path.join(dir, name))
}
function extractConfigSchemas (modsDir) {
  const files = jarPathsFromDir(modsDir)
  if (!files.length) return new Map()
  const analysis = analyzeJars([modsDir])
  const paths = new Map(files.map(file => [path.basename(file), file]))
  const schemas = new Map()
  for (const artifact of analysis.artifacts) {
    const file = paths.get(path.basename(artifact.source))
    if (!file) continue
    const registrations = (artifact.network?.registrations || []).filter(reg => reg.kind === 'sync-config' && reg.configClass && typeof reg.id === 'string')
    if (!registrations.length) continue
    const archive = new ZipArchive(file)
    for (const registration of registrations) {
      const namespace = registration.id.split(':')[0]
      // One unambiguous schema per namespace. A future multi-schema mod must
      // provide an explicit ResourceLocation -> schema mapping, never a guess.
      if (schemas.has(namespace)) { schemas.set(namespace, null); continue }
      try { schemas.set(namespace, extractConfigClass(archive, registration.configClass)) } catch { schemas.set(namespace, null) }
    }
  }
  return schemas
}
function requireBytes (reader, n) { return reader.bytes(n) }
function decodeTyped (r, type) {
  if (type === 'boolean') { const b = r.byte(); if (b > 1) throw new Error('invalid_boolean_value'); return b === 1 }
  if (type === 'byte') return requireBytes(r, 1).readInt8(0)
  if (type === 'short') return requireBytes(r, 2).readInt16BE(0)
  if (type === 'int' || type === 'enum_ordinal_int') {
    const v = requireBytes(r, 4).readInt32BE(0)
    if (type === 'enum_ordinal_int' && (v < 0 || v > 255)) throw new Error('invalid_enum_ordinal')
    return v
  }
  if (type === 'long') return requireBytes(r, 8).readBigInt64BE(0).toString()
  if (type === 'float') { const x = requireBytes(r, 4).readFloatBE(0); if (!Number.isFinite(x)) throw new Error('invalid_float'); return x }
  if (type === 'double') { const x = requireBytes(r, 8).readDoubleBE(0); if (!Number.isFinite(x)) throw new Error('invalid_double'); return x }
  if (type === 'string') return r.string(32767)
  if (type === 'resource_location') return r.identifier()
  throw new Error('unresolved_config_property_codec')
}
function encodeTyped (w, type, value) {
  if (type === 'boolean') { if (typeof value !== 'boolean') throw new Error('invalid_boolean'); return w.byte(value ? 1 : 0) }
  if (type === 'string') return w.string(value, 32767)
  if (type === 'resource_location') return w.identifier(value)
  const sizes = { byte: 1, short: 2, int: 4, enum_ordinal_int: 4, long: 8, float: 4, double: 8 }
  const size = sizes[type]
  if (!size) throw new Error('unresolved_config_property_codec')
  const buf = Buffer.alloc(size)
  if (type === 'long') buf.writeBigInt64BE(BigInt(value))
  else if (type === 'float') buf.writeFloatBE(value)
  else if (type === 'double') buf.writeDoubleBE(value)
  else {
    if (!Number.isSafeInteger(value) || value < -(2 ** (size * 8 - 1)) || value >= (2 ** (size * 8 - 1))) throw new Error('invalid_config_int')
    if (size === 1) buf.writeInt8(value)
    else if (size === 2) buf.writeInt16BE(value)
    else buf.writeInt32BE(value)
  }
  return w.bytes(buf)
}
function decodeConfigPayload (payload, schema) {
  if (!Buffer.isBuffer(payload) || payload.length > MAX_CONFIG_BYTES || !schema) throw new Error('invalid_config_body')
  const r = new WireReader(payload)
  const id = r.identifier()
  const groups = []
  const values = Object.create(null)
  let total = 0
  const rootCount = r.count()
  if (rootCount > MAX_FIELDS) throw new Error('config_property_limit')
  const roots = Object.create(null)
  const rootList = []
  for (let i = 0; i < rootCount; i++) {
    const name = r.string(128)
    if (!SAFE_NAME.test(name) || !schema.roots.has(name) || Object.hasOwn(roots, name)) throw new Error('config_property_not_in_schema')
    roots[name] = decodeTyped(r, schema.roots.get(name))
    rootList.push(name); total++
  }
  const categoryCount = r.count()
  if (categoryCount > MAX_CATEGORIES) throw new Error('config_category_limit')
  for (let i = 0; i < categoryCount; i++) {
    const name = r.string(128)
    const defs = schema.groups.get(name)
    if (!SAFE_NAME.test(name) || !defs || Object.hasOwn(values, name)) throw new Error('config_category_not_in_schema')
    const count = r.count()
    if (count > MAX_FIELDS || count + total > MAX_FIELDS) throw new Error('config_property_limit')
    const data = Object.create(null)
    const order = []
    for (let j = 0; j < count; j++) {
      const key = r.string(128)
      if (!SAFE_NAME.test(key) || !defs.has(key) || Object.hasOwn(data, key)) throw new Error('config_property_not_in_schema')
      data[key] = decodeTyped(r, defs.get(key))
      order.push(key)
      total++
    }
    values[name] = data
    groups.push({ name, order })
  }
  r.end()
  const w = new WireWriter().identifier(id).count(rootList.length)
  for (const name of rootList) { w.string(name, 128); encodeTyped(w, schema.roots.get(name), roots[name]) }
  w.count(groups.length)
  for (const group of groups) {
    w.string(group.name, 128).count(group.order.length)
    for (const key of group.order) { w.string(key, 128); encodeTyped(w, schema.groups.get(group.name).get(key), values[group.name][key]) }
  }
  if (!w.finish().equals(payload)) throw new Error('config_byte_roundtrip_mismatch')
  return { id, roots, categories: values, categoryCount, propertyCount: total, roundTripExact: true }
}

class ConfigSyncMirror {
  constructor ({ runtime, modsDir, manifest } = {}) {
    this.runtime = runtime
    this.schemas = modsDir ? extractConfigSchemas(modsDir) : new Map()
    // The transport is discovered from JAR metadata; do not infer config
    // semantics from a random unknown 0x00 packet.
    this.transports = new Map()
    for (const msg of manifest?.messages || []) {
      if (msg.codecStatus !== 'unresolved' || !msg.id.endsWith(':config') || msg.direction !== 'clientbound' ||
          !Number.isInteger(msg.predictedDiscriminator) || !msg.predictedChannel) continue
      const key = msg.predictedChannel + '\0' + msg.predictedDiscriminator
      if (this.transports.has(key)) this.transports.set(key, null)
      else this.transports.set(key, msg.id)
    }
    this.configs = new Map()
    this.stats = { decoded: 0, rejected: 0, unmatched: 0, opaque: 0 }
    this.errors = []
  }
  observe (event) {
    if (!event || event.direction !== 'inbound' || event.phase !== 'play' || !Buffer.isBuffer(event.data)) return { status: 'ignored' }
    const discriminator = event.data[0]
    const key = event.channel + '\0' + discriminator
    if (!this.transports.has(key) || !this.transports.get(key)) return { status: 'ignored' }
    try {
      const frame = unpackSimpleChannel(event.data, MAX_CONFIG_BYTES)
      const r = new WireReader(frame.payload)
      const id = r.identifier()
      const namespace = ID_NAMESPACE.exec(id)?.[1]
      if (!namespace) throw new Error('invalid_config_namespace')
      const schema = this.schemas.get(namespace)
      if (!schema) { this.stats.opaque++; return { status: 'envelope-only', channel: event.channel, discriminator, id, reason: 'config_schema_unavailable' } }
      const decoded = decodeConfigPayload(frame.payload, schema)
      const digest = createHash('sha256').update(event.data).digest('hex')
      if (!this.configs.has(id) && this.configs.size >= MAX_CONFIGS) throw new Error('mod_config_count_limit')
      const entry = { ...decoded, sha256: digest, channel: event.channel, discriminator, source: 'jar-derived-classfile-schema', appliedToJava: false }
      this.configs.set(id, entry)
      this.stats.decoded++
      this.runtime?.emit('modConfigObserved', { id, channel: event.channel, discriminator, propertyCount: decoded.propertyCount, roundTripExact: true, appliedToJava: false })
      return { status: 'config-decoded', channel: event.channel, discriminator, id, propertyCount: decoded.propertyCount, roundTripExact: true, serverVerified: false }
    } catch (error) {
      this.stats.rejected++
      const reason = String(error?.message || error).slice(0, 100)
      this.errors.push({ channel: event.channel, discriminator, reason })
      if (this.errors.length > 16) this.errors.shift()
      this.runtime?.emit('modConfigDecodeError', { channel: event.channel, discriminator, reason })
      return { status: 'rejected', channel: event.channel, discriminator, reason }
    }
  }
  get (identifier) {
    const entry = this.configs.get(identifier)
    return entry ? structuredClone(entry) : null
  }
  getReport () {
    return {
      schema: 'mineflayer-mod-support/config-sync-mirror/v1',
      schemaNamespaces: [...this.schemas.keys()].sort(),
      transports: [...this.transports.keys()].map(x => ({ channel: x.split('\0')[0], discriminator: Number(x.split('\0')[1]) })),
      counts: { ...this.stats, stored: this.configs.size },
      configs: [...this.configs.values()].map(v => ({ id: v.id, channel: v.channel, discriminator: v.discriminator, sha256: v.sha256, categoryCount: v.categoryCount, propertyCount: v.propertyCount, roundTripExact: v.roundTripExact, appliedToJava: false })),
      errors: [...this.errors]
    }
  }
}
module.exports = { extractConfigSchemas, extractConfigClass, decodeConfigPayload, ConfigSyncMirror }
