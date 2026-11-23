'use strict'
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const RESOURCE_LOCATION = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/
const BLOCK_POS_LIMIT = { x: 33554431, y: 2047, z: 33554431 }
function requireInt (v, low, high, name) {
  if (!Number.isInteger(v) || v < low || v > high) throw new RangeError(`Invalid ${name}`)
  return v
}
function writeBlockPos (value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid BlockPos')
  const x = requireInt(value.x, -33554432, 33554431, 'BlockPos.x')
  const y = requireInt(value.y, -2048, 2047, 'BlockPos.y')
  const z = requireInt(value.z, -33554432, 33554431, 'BlockPos.z')
  const n = (BigInt.asUintN(26, BigInt(x)) << 38n) | (BigInt.asUintN(26, BigInt(z)) << 12n) | BigInt.asUintN(12, BigInt(y))
  const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b
}
function readBlockPos (buffer, offset) {
  if (offset + 8 > buffer.length) throw new Error('Truncated BlockPos')
  const n = buffer.readBigUInt64BE(offset)
  return { x: Number(BigInt.asIntN(26, n >> 38n)), y: Number(BigInt.asIntN(12, n)), z: Number(BigInt.asIntN(26, n >> 12n)) }
}
function parseLong (v) {
  if (typeof v !== 'bigint' && !(typeof v === 'string' && /^-?[0-9]+$/.test(v))) throw new Error('Expected signed 64-bit bigint or decimal string')
  const n = BigInt(v)
  if (n < -(1n << 63n) || n >= 1n << 63n) throw new RangeError('Long out of range')
  return n
}
function writeUtf (value) {
  if (typeof value !== 'string') throw new Error('Expected UTF string')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > 32767 || [...value].length > 32767) throw new Error('String too long')
  return Buffer.concat([writeVarInt(bytes.length), bytes])
}
function readUtf (buf, offset) {
  let n; [n,offset] = readVarInt(buf,offset)
  if (n < 0 || n > 32767) throw new Error('Invalid UTF length')
  if (offset + n > buf.length) throw new Error('Truncated payload')
  const value = buf.toString('utf8',offset,offset+n)
  if ([...value].length > 32767) throw new Error('String too long')
  return [value, offset + n]
}
function writeVarInt (v) {
  if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) throw new RangeError('Invalid VarInt')
  let n = v >>> 0; const bytes = []
  while ((n & ~0x7f) !== 0) { bytes.push((n & 0x7f) | 0x80); n >>>= 7 }
  bytes.push(n); return Buffer.from(bytes)
}
function readVarInt (buf, position) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (position + i >= buf.length) throw new Error('Truncated VarInt')
    const byte = buf[position + i]
    if (i === 4 && (byte & 0xf0)) throw new Error('Invalid VarInt')
    value |= (byte & 0x7f) << (7 * i)
    if (!(byte & 0x80)) return [value | 0, position + i + 1]
  }
  throw new Error('Overlong VarInt')
}
function makeCodec (schema) {
  if (!Array.isArray(schema) || schema.length > 64) throw new Error('Invalid codec schema')
  for (const item of schema) if (!['uuid','utf','boolean','varint','int','byte','short','long','blockpos','resource_location'].includes(item.type) || typeof item.field !== 'string') throw new Error('Unsupported field schema')
  return {
    encode (value) {
      const result = []
      for (const field of schema) {
        const v = value[field.field]
        switch (field.type) {
          case 'uuid': { if (!UUID_PATTERN.test(v)) throw new Error('Invalid UUID'); result.push(Buffer.from(v.replace(/-/g, ''), 'hex')); break }
          case 'utf': result.push(writeUtf(v)); break
          case 'resource_location': { if (typeof v !== 'string' || !RESOURCE_LOCATION.test(v)) throw new Error('Invalid ResourceLocation'); result.push(writeUtf(v)); break }
          case 'boolean': { if (typeof v !== 'boolean') throw new Error('Invalid boolean'); result.push(Buffer.from([v ? 1 : 0])); break }
          case 'varint': result.push(writeVarInt(v)); break
          case 'int': { const b = Buffer.alloc(4); b.writeInt32BE(requireInt(v,-2147483648,2147483647,'int')); result.push(b); break }
          case 'short': { const b = Buffer.alloc(2); b.writeInt16BE(requireInt(v,-32768,32767,'short')); result.push(b); break }
          case 'long': { const b = Buffer.alloc(8); b.writeBigInt64BE(parseLong(v)); result.push(b); break }
          case 'blockpos': result.push(writeBlockPos(v)); break
          case 'byte': { const b = Buffer.alloc(1); b.writeInt8(requireInt(v,-128,127,'byte')); result.push(b); break }
        }
      }
      return Buffer.concat(result)
    },
    decode (buf) {
      let p = 0; const value = {}
      const need = n => { if (p + n > buf.length) throw new Error('Truncated payload') }
      for (const field of schema) {
        switch (field.type) {
          case 'uuid': { need(16); const h = buf.subarray(p,p+16).toString('hex'); value[field.field] = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; p += 16; break }
          case 'utf': { [value[field.field],p] = readUtf(buf,p); break }
          case 'resource_location': { [value[field.field],p] = readUtf(buf,p); if (!RESOURCE_LOCATION.test(value[field.field])) throw new Error('Invalid ResourceLocation'); break }
          case 'boolean': { need(1); value[field.field] = buf[p++] !== 0; break }
          case 'varint': { [value[field.field],p] = readVarInt(buf,p); break }
          case 'int': { need(4); value[field.field] = buf.readInt32BE(p); p += 4; break }
          case 'short': { need(2); value[field.field] = buf.readInt16BE(p); p += 2; break }
          case 'long': { need(8); value[field.field] = buf.readBigInt64BE(p); p += 8; break }
          case 'blockpos': { value[field.field] = readBlockPos(buf,p); p += 8; break }
          case 'byte': { need(1); value[field.field] = buf.readInt8(p++); break }
        }
      }
      if (p !== buf.length) throw new Error('Unexpected trailing bytes')
      return value
    }
  }
}
module.exports = { makeCodec }
