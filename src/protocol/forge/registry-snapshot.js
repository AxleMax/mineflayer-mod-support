'use strict'

// Mirrors ForgeRegistry.Snapshot.getPacketData()/read(FriendlyByteBuf)
// in MinecraftForge 1.20.x: ids, aliases, overrides, blocked.
// This is a data-only decoding layer, not execution or installation of Java Mods.
const { WireReader, WireWriter } = require('./wire')
const MAX_TOTAL = 16384

function readUnique (reader, parseKey, parseValue, group) {
  const count = reader.count()
  const items = []
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const name = parseKey(reader)
    if (seen.has(name)) throw new Error('duplicate_registry_' + group)
    seen.add(name)
    items.push({ name, value: parseValue(reader) })
  }
  return items
}
function decodeForgeRegistrySnapshot (buffer) {
  const r = new WireReader(buffer)
  const ids = readUnique(r, v => v.identifier(), v => v.varInt(), 'id')
  const aliases = readUnique(r, v => v.identifier(), v => v.identifier(), 'alias')
  const overrides = readUnique(r, v => v.identifier(), v => v.string(256), 'override')
  const blocked = []
  for (let n = r.count(); n > 0; n--) blocked.push(r.varInt())
  if (ids.length + aliases.length + overrides.length + blocked.length > MAX_TOTAL) throw new Error('registry_snapshot_limit')
  const idNumbers = new Set()
  for (const { value } of ids) {
    if (idNumbers.has(value)) throw new Error('duplicate_registry_numeric_id')
    idNumbers.add(value)
  }
  if (new Set(blocked).size !== blocked.length) throw new Error('duplicate_registry_blocked_id')
  r.end()
  return {
    ids: ids.map(v => ({ name: v.name, id: v.value })),
    aliases: aliases.map(v => ({ from: v.name, to: v.value })),
    overrides: overrides.map(v => ({ name: v.name, owner: v.value })),
    blocked,
    entriesDecoded: true
  }
}
// Test fixture generator. Not exposed as an automatic client registry advertisement.
function encodeForgeRegistrySnapshot (snapshot) {
  if (!snapshot || !Array.isArray(snapshot.ids) || !Array.isArray(snapshot.aliases) || !Array.isArray(snapshot.overrides) || !Array.isArray(snapshot.blocked)) throw new Error('invalid_registry_snapshot')
  const w = new WireWriter().count(snapshot.ids.length)
  for (const x of snapshot.ids) w.identifier(x.name).varInt(x.id)
  w.count(snapshot.aliases.length)
  for (const x of snapshot.aliases) w.identifier(x.from).identifier(x.to)
  w.count(snapshot.overrides.length)
  for (const x of snapshot.overrides) w.identifier(x.name).string(x.owner, 256)
  w.count(snapshot.blocked.length)
  for (const n of snapshot.blocked) w.varInt(n)
  const result = w.finish()
  decodeForgeRegistrySnapshot(result) // Reject inconsistent fixtures.
  return result
}
module.exports = { decodeForgeRegistrySnapshot, encodeForgeRegistrySnapshot }
