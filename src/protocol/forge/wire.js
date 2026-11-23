'use strict'

// Bounded Minecraft 1.20.1 FriendlyByteBuf primitives used by Forge FML3.
// Only non-negative VarInts and network identifiers/strings are accepted here.
const MAX_BYTES = 1024 * 1024
const MAX_COUNT = 4096
const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_.\/-]+$/
const MOD_RE = /^[a-z0-9_.-]+$/

class WireReader {
  constructor (buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) throw new Error('invalid_wire_buffer')
    this.buffer = buffer
    this.offset = 0
  }
  get remaining () { return this.buffer.length - this.offset }
  varInt () {
    let n = 0
    for (let i = 0; i < 5; i++) {
      if (!this.remaining) throw new Error('truncated_varint')
      const b = this.buffer[this.offset++]
      if (i === 4 && (b & 0xf0) !== 0) throw new Error('varint_overflow')
      n |= (b & 0x7f) << (7 * i)
      if ((b & 0x80) === 0) return n >>> 0
    }
    throw new Error('varint_too_long')
  }
  byte () {
    if (!this.remaining) throw new Error('truncated_byte')
    return this.buffer[this.offset++]
  }
  bytes (length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES || this.remaining < length) throw new Error('invalid_wire_length')
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
  string (max = 256) {
    const count = this.varInt()
    if (count > max * 4 || count > MAX_BYTES) throw new Error('wire_string_too_long')
    const value = this.bytes(count).toString('utf8')
    if (value.length > max || value.includes('\ufffd') || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_wire_string')
    return value
  }
  identifier () {
    const value = this.string(256)
    if (!ID_RE.test(value)) throw new Error('invalid_wire_identifier')
    return value
  }
  modId () {
    const value = this.string(128)
    if (!MOD_RE.test(value)) throw new Error('invalid_wire_mod_id')
    return value
  }
  count () {
    const value = this.varInt()
    if (value > MAX_COUNT) throw new Error('wire_count_too_large')
    return value
  }
  end () { if (this.remaining !== 0) throw new Error('wire_trailing_bytes') }
}

class WireWriter {
  constructor () { this.parts = []; this.length = 0 }
  bytes (value) {
    if (!Buffer.isBuffer(value) || value.length + this.length > MAX_BYTES) throw new Error('wire_output_too_large')
    this.parts.push(value)
    this.length += value.length
    return this
  }
  byte (value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('invalid_wire_byte')
    return this.bytes(Buffer.from([value]))
  }
  varInt (value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new Error('invalid_wire_varint')
    const result = []
    do {
      let byte = value & 0x7f
      value = Math.floor(value / 128)
      if (value) byte |= 0x80
      result.push(byte)
    } while (value)
    return this.bytes(Buffer.from(result))
  }
  string (value, max = 256) {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid_wire_string')
    const encoded = Buffer.from(value, 'utf8')
    if (encoded.length > max * 4) throw new Error('wire_string_too_long')
    return this.varInt(encoded.length).bytes(encoded)
  }
  identifier (value) { if (!ID_RE.test(value)) throw new Error('invalid_wire_identifier'); return this.string(value, 256) }
  modId (value) { if (!MOD_RE.test(value)) throw new Error('invalid_wire_mod_id'); return this.string(value, 128) }
  count (value) { if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new Error('invalid_wire_count'); return this.varInt(value) }
  finish () { return Buffer.concat(this.parts, this.length) }
}

module.exports = { WireReader, WireWriter, MAX_COUNT, MAX_BYTES }
