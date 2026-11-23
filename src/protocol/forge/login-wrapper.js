'use strict'

// Read-only, bounded Forge 1.20.1 FML3 Login Wrapper inspector.
// This module NEVER writes a handshake response and never executes packet data.

const { createHash } = require('node:crypto')
const { summarizeOpaqueSnapshot } = require('./registry-observer')
const { decodeForgeRegistrySnapshot } = require('./registry-snapshot')
const MAX_BYTES = 1024 * 1024
const MAX_COUNT = 4096
const MAX_STRING = 1024
const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const MOD_RE = /^[a-z0-9_.-]+$/

class PacketReader {
  constructor (input) {
    if (!Buffer.isBuffer(input)) throw new Error('payload_not_buffer')
    if (input.length > MAX_BYTES) throw new Error('payload_too_large')
    this.buffer = input
    this.offset = 0
  }
  get remaining () { return this.buffer.length - this.offset }
  varInt () {
    let value = 0
    for (let i = 0; i < 5; i++) {
      if (this.remaining < 1) throw new Error('truncated_varint')
      const byte = this.buffer[this.offset++]
      if (i === 4 && (byte & 0xf0) !== 0) throw new Error('varint_overflow')
      value |= (byte & 0x7f) << (7 * i)
      if ((byte & 0x80) === 0) return value >>> 0
    }
    throw new Error('varint_too_long')
  }
  u8 () {
    if (!this.remaining) throw new Error('truncated_byte')
    return this.buffer[this.offset++]
  }
  bytes (length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) throw new Error('invalid_length')
    if (this.remaining < length) throw new Error('truncated_bytes')
    const result = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return result
  }
  string (max = MAX_STRING) {
    const length = this.varInt()
    if (length > max) throw new Error('string_too_long')
    const bytes = this.bytes(length)
    const value = bytes.toString('utf8')
    if (value.includes('\ufffd') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_string')
    return value
  }
  identifier () {
    const value = this.string(256)
    if (!ID_RE.test(value)) throw new Error('invalid_identifier')
    return value
  }
  count () {
    const n = this.varInt()
    if (n > MAX_COUNT) throw new Error('count_too_large')
    return n
  }
}

function readModData (reader) {
  const n = reader.count()
  const mods = []
  for (let i = 0; i < n; i++) {
    const id = reader.string(128)
    if (!MOD_RE.test(id)) throw new Error('invalid_mod_id')
    const name = reader.string(256)
    const version = reader.string(128)
    mods.push({ id, name, version })
  }
  return { mods }
}

function readModList (reader) {
  const mods = []
  for (let n = reader.count(), i = 0; i < n; i++) {
    const id = reader.string(128)
    if (!MOD_RE.test(id)) throw new Error('invalid_mod_id')
    mods.push(id)
  }
  const channels = []
  for (let n = reader.count(), i = 0; i < n; i++) {
    channels.push({ id: reader.identifier(), version: reader.string(256) })
  }
  const registries = []
  for (let n = reader.count(), i = 0; i < n; i++) registries.push(reader.identifier())
  // FML network protocol version 3 optionally includes non-Vanilla
  // datapack registry identifiers at the end of S2CModList. The count
  // and strings are decoded only if this field is present.
  const dataPackRegistries = []
  if (reader.remaining > 0) {
    for (let n = reader.count(), i = 0; i < n; i++) dataPackRegistries.push(reader.identifier())
  }
  return { modIds: mods, channels, registries, dataPackRegistries }
}

/**
 * @param {Buffer} payload data of login_plugin_request on fml:loginwrapper
 * @returns {object} bounded JSON-safe structural metadata, never raw bytes
 */
function inspectFml3LoginWrapper (payload) {
  const result = { parsed: false, outerChannel: null, innerBytes: null, packetId: null, type: null, details: null, trailingBytes: null, error: null }
  try {
    const wrapper = new PacketReader(payload)
    result.outerChannel = wrapper.identifier()
    const innerBytes = wrapper.varInt()
    result.innerBytes = innerBytes
    if (innerBytes > MAX_BYTES) throw new Error('inner_payload_too_large')
    if (wrapper.remaining !== innerBytes) throw new Error('wrapper_length_mismatch')
    const inner = new PacketReader(wrapper.bytes(innerBytes))
    // Modern Forge 1.20.1 uses a one-byte message discriminator for
    // the FML handshake message classes.
    result.packetId = inner.u8()
    if (result.outerChannel !== 'fml:handshake') {
      result.type = 'other_channel'
      result.trailingBytes = inner.remaining
      result.parsed = true
      return result
    }
    if (result.packetId === 5) {
      result.type = 'S2CModData'
      result.details = readModData(inner)
    } else if (result.packetId === 1) {
      result.type = 'S2CModList'
      result.details = readModList(inner)
    } else if (result.packetId === 3) {
      result.type = 'S2CRegistry'
      // Forge 1.20.1: ResourceLocation + hasSnapshot flag + opaque
      // ForgeRegistry.Snapshot payload. Do not mistake bytes for parsed entries.
      const registryName = inner.identifier()
      const flag = inner.u8()
      if (flag !== 0 && flag !== 1) throw new Error('invalid_registry_snapshot_flag')
      const opaque = inner.bytes(inner.remaining)
      if (flag === 0 && opaque.length) throw new Error('unexpected_registry_snapshot_bytes')
      const snapshotInfo = { registryName, hasSnapshot: flag === 1, ...summarizeOpaqueSnapshot(opaque), entriesDecoded: false }
      if (flag === 1) {
        try {
          const snapshot = decodeForgeRegistrySnapshot(opaque)
          snapshotInfo.entriesDecoded = true
          snapshotInfo.snapshot = snapshot
          snapshotInfo.entryCounts = { ids: snapshot.ids.length, aliases: snapshot.aliases.length, overrides: snapshot.overrides.length, blocked: snapshot.blocked.length }
        } catch (err) {
          snapshotInfo.snapshotDecodeError = String(err?.message || err).slice(0, 80)
        }
      }
      result.details = snapshotInfo
      result.trailingBytes = 0 // Consumed as opaque, not semantically decoded
      result.parsed = true
      return result
    } else if (result.packetId === 4) {
      result.type = 'S2CConfigData'
      const fileName = inner.string(512)
      const dataLength = inner.varInt()
      if (dataLength > MAX_BYTES) throw new Error('config_data_too_large')
      const data = inner.bytes(dataLength)
      if (inner.remaining !== 0) throw new Error('config_data_trailing_bytes')
      result.details = {
        fileName,
        data,
        dataBytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex')
      }
      result.trailingBytes = 0
      result.parsed = true
      return result
    } else if (result.packetId === 6) {
      result.type = 'S2CChannelMismatchData'
      // Legacy Forge FML3: Map<ResourceLocation, String> of incompatible
      // channel identifiers and server-side protocol versions.
      // Decode conservatively: if the payload differs, keep a bounded
      // diagnostic error instead of inventing names or a fabricated map.
      try {
        const count = inner.count()
        const mismatchedChannels = []
        const seen = new Set()
        for (let i = 0; i < count; i++) {
          const id = inner.identifier()
          const version = inner.string(256)
          if (seen.has(id)) throw new Error('duplicate_mismatched_channel')
          seen.add(id)
          mismatchedChannels.push({ id, version })
        }
        if (inner.remaining !== 0) throw new Error('mismatch_trailing_bytes')
        result.details = { mismatchedChannels, count }
        result.trailingBytes = 0
      } catch (err) {
        result.details = { bodyBytes: inner.buffer.length - 1, decodeError: String(err?.message || err).slice(0, 80) }
        result.trailingBytes = inner.remaining
      }
      result.parsed = true
      return result
    } else {
      result.type = 'unknown'
      result.details = { bodyBytes: inner.remaining }
      result.trailingBytes = inner.remaining
      result.parsed = true
      return result
    }
    result.trailingBytes = inner.remaining
    result.parsed = true
  } catch (err) {
    result.error = String(err?.message || 'parse_error').slice(0, 64)
  }
  return result
}

module.exports = { inspectFml3LoginWrapper }
