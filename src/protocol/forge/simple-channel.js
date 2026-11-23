'use strict'

const { WireReader, WireWriter } = require('./wire')

// MinecraftForge 1.20.1 IndexedMessageCodec: the discriminator is one
// unsigned byte (NOT a VarInt), followed by the message's own bytes.
function unpackSimpleChannel (buffer, maxBytes = 1024 * 1024) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > maxBytes) {
    throw new Error('invalid_simple_channel_packet')
  }
  return { discriminator: buffer.readUInt8(0), payload: buffer.subarray(1) }
}
function packSimpleChannel (discriminator, payload) {
  if (!Number.isInteger(discriminator) || discriminator < 0 || discriminator > 255 ||
      !Buffer.isBuffer(payload) || payload.length > 1024 * 1024 - 1) {
    throw new Error('invalid_simple_channel_packet')
  }
  return Buffer.concat([Buffer.from([discriminator]), payload])
}

// Forge 1.20.1 TierSortingRegistry.SyncPacket discriminator 0.
// readVarInt(count), repeat readResourceLocation().
const VANILLA_TIERS = Object.freeze([
  'minecraft:wood', 'minecraft:gold', 'minecraft:stone',
  'minecraft:iron', 'minecraft:diamond', 'minecraft:netherite'
])
function decodeTierSync (body) {
  const r = new WireReader(body)
  const count = r.count()
  if (count > 1024) throw new Error('tier_count_limit')
  const tiers = []
  const seen = new Set()
  for (let i = 0; i < count; ++i) {
    const tier = r.identifier()
    if (seen.has(tier)) throw new Error('duplicate_tier:' + tier)
    seen.add(tier)
    tiers.push(tier)
  }
  r.end()
  return { tiers }
}
function encodeTierSync (tiers) {
  if (!Array.isArray(tiers) || tiers.length > 1024 || new Set(tiers).size !== tiers.length) {
    throw new Error('invalid_tier_order')
  }
  const w = new WireWriter().count(tiers.length)
  for (const name of tiers) w.identifier(name)
  return packSimpleChannel(0, w.finish())
}
class TierSortingState {
  constructor () {
    this.order = [...VANILLA_TIERS]
    this.synced = false
    this.messagesReceived = 0
  }
  receive (discriminator, payload) {
    if (discriminator !== 0) throw new Error('unknown_tier_sorting_discriminator:' + discriminator)
    const { tiers } = decodeTierSync(payload)
    // Node's tier ordering data model accepts names not present in the built-in
    // list, but does not claim to reproduce modded Java Tier behavior.
    this.order = [...tiers]
    this.synced = true
    this.messagesReceived++
    return { kind: 'tier_order', tiers: [...tiers] }
  }
  getReport () {
    return { version: '1.0', synced: this.synced, order: [...this.order], messagesReceived: this.messagesReceived,
      limitation: 'Tier ordering is stored as identifiers; Java Tier instances and mining semantics are not emulated' }
  }
}

module.exports = { unpackSimpleChannel, packSimpleChannel, decodeTierSync, encodeTierSync, TierSortingState, VANILLA_TIERS }
