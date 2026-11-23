'use strict'

// Generic, data-only codec intermediate representation. No eval(), Java
// execution, generated JS source or network capability advertisement.
// Plans are untrusted inputs: validate structure and resource budgets first.
const { TextDecoder } = require('node:util')
const DECODER = new TextDecoder('utf-8', { fatal: true })
const IDENTIFIER = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SAFE_KEY = /^[A-Za-z_][A-Za-z_0-9]{0,63}$/
const SCALARS = new Set(['uuid', 'utf', 'boolean', 'varint', 'int', 'byte', 'short', 'long', 'float', 'double', 'blockpos', 'resource_location'])
const MAX_BYTES = 1024 * 1024
const MAX_NODES = 256
const MAX_DEPTH = 12

function safeKey (key) {
  return typeof key === 'string' && SAFE_KEY.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)
}
function boundedInt (v, min, max, label) {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError('invalid_' + label)
  return v
}
function compileCodecPlan (plan, options = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.schema !== 'mineflayer-mod-support/codec-ir/v1') {
    throw new Error('invalid_codec_plan')
  }
  const defs = plan.definitions || {}
  if (!defs || typeof defs !== 'object' || Array.isArray(defs) || Object.keys(defs).length > 64) throw new Error('invalid_codec_definitions')
  let nodes = 0
  const compiledDefs = new Map()
  function parse (node, ancestors = [], depth = 0) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !node || typeof node !== 'object' || Array.isArray(node)) throw new Error('invalid_codec_node')
    if (SCALARS.has(node.type)) return { type: node.type }
    if (['slot','nbt'].includes(node.type)) {
      if (!options.protocol) throw Error('protocol_codec_context_required:'+node.type)
      return {type:node.type,protocolType:node.type==='nbt'?'optionalNbt':'slot'}
    }
    if (node.type==='switch') {
      if(!safeKey(node.field)||!node.cases||Array.isArray(node.cases)||Object.keys(node.cases).length>64)throw Error('invalid_codec_switch')
      const cases=Object.create(null)
      for(const [key,value] of Object.entries(node.cases)){if(['__proto__','constructor','prototype'].includes(key))throw Error('invalid_codec_switch_case');cases[key]=parse(value,ancestors,depth+1)}
      return {type:'switch',field:node.field,cases}
    }
    if (node.type === 'ref') {
      const ref = node.name
      if (!safeKey(ref) || !Object.hasOwn(defs, ref) || ancestors.includes(ref)) throw new Error('invalid_codec_reference')
      if (!compiledDefs.has(ref)) compiledDefs.set(ref, parse(defs[ref], [...ancestors, ref], depth + 1))
      return { type: 'ref', name: ref, target: compiledDefs.get(ref) }
    }
    if (node.type === 'struct') {
      if (!Array.isArray(node.fields) || node.fields.length > 64) throw new Error('invalid_struct_fields')
      const keys = new Set()
      return { type: 'struct', fields: node.fields.map(field => {
        if (!field || !safeKey(field.name) || keys.has(field.name)) throw new Error('invalid_struct_field_name')
        if(field.codec?.type==='switch'&&!keys.has(field.codec.field))throw Error('codec_switch_requires_preceding_field')
        keys.add(field.name)
        return { name: field.name, codec: parse(field.codec, ancestors, depth + 1) }
      }) }
    }
    if (node.type === 'list') {
      if (!['varint', 'short', 'byte'].includes(node.lengthType)) throw new Error('invalid_list_length_type')
      const limit = boundedInt(node.maxItems ?? 256, 0, Math.min(4096, node.lengthType === 'byte' ? 127 : node.lengthType === 'short' ? 32767 : 4096), 'list_limit')
      return { type: 'list', lengthType: node.lengthType, maxItems: limit, element: parse(node.element, ancestors, depth + 1) }
    }
    if (node.type === 'optional') return { type: 'optional', value: parse(node.value, ancestors, depth + 1) }
    if (node.type === 'enum') {
      if (!Array.isArray(node.values) || !node.values.length || node.values.length > 256 ||
          !['varint', 'byte'].includes(node.ordinalType)) throw new Error('invalid_enum')
      const seen = new Set()
      for (const label of node.values) {
        if (typeof label !== 'string' || !safeKey(label) || seen.has(label)) throw new Error('invalid_enum_values')
        seen.add(label)
      }
      return { type: 'enum', values: [...node.values], ordinalType: node.ordinalType }
    }
    throw new Error('unsupported_codec_node:' + String(node.type))
  }
  for (const name of Object.keys(defs)) if (!safeKey(name)) throw new Error('invalid_definition_name')
  const root = parse(plan.root)
  function encode (value) {
    const chunks = []; let total = 0; let operations = 0
    const add = bytes => {
      total += bytes.length
      if (total > MAX_BYTES) throw new Error('codec_output_limit')
      chunks.push(bytes)
    }
    function writeInt (n, size, signed) {
      const min = signed ? -(2 ** (size * 8 - 1)) : 0
      const max = signed ? 2 ** (size * 8 - 1) - 1 : 2 ** (size * 8) - 1
      const b = Buffer.alloc(size); boundedInt(n, min, max, 'integer')
      if (size === 1) signed ? b.writeInt8(n) : b.writeUInt8(n)
      if (size === 2) signed ? b.writeInt16BE(n) : b.writeUInt16BE(n)
      if (size === 4) signed ? b.writeInt32BE(n) : b.writeUInt32BE(n)
      add(b)
    }
    function writeVarInt (n) {
      boundedInt(n, -2147483648, 2147483647, 'varint')
      const buf = []; let bits = n >>> 0
      while ((bits & ~0x7f) !== 0) { buf.push((bits & 0x7f) | 0x80); bits >>>= 7 }
      buf.push(bits); add(Buffer.from(buf))
    }
    function write (node, v, depth, context) {
      if (++operations > 100000 || depth > MAX_DEPTH + 1) throw new Error('codec_operation_limit')
      if (node.type === 'ref') return write(node.target, v, depth + 1,context)
      if(node.type==='switch') {const key=String(context?.[node.field]);if(!Object.hasOwn(node.cases,key))throw Error('unknown_codec_switch_case:'+key);return write(node.cases[key],v,depth+1,context)}
      if(node.protocolType){const size=options.protocol.sizeOf(v,node.protocolType,{});if(!Number.isSafeInteger(size)||size<0||size>MAX_BYTES)throw Error('codec_output_limit');const bytes=Buffer.alloc(size);const end=options.protocol.write(v,bytes,0,node.protocolType,{});if(end!==size)throw Error('protocol_codec_size_mismatch');add(bytes);return}
      if (node.type === 'struct') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid_struct_value')
        for (const field of node.fields) write(field.codec, v[field.name], depth + 1,v)
      } else if (node.type === 'list') {
        if (!Array.isArray(v) || v.length > node.maxItems) throw new Error('invalid_list_value')
        write({ type: node.lengthType }, v.length, depth + 1)
        for (const entry of v) write(node.element, entry, depth + 1)
      } else if (node.type === 'optional') {
        const present = v !== undefined && v !== null
        write({ type: 'boolean' }, present, depth + 1)
        if (present) write(node.value, v, depth + 1)
      } else if (node.type === 'enum') {
        const ordinal = node.values.indexOf(v)
        if (ordinal === -1) throw new Error('invalid_enum_value')
        write({ type: node.ordinalType }, ordinal, depth + 1)
      } else if (node.type === 'varint') writeVarInt(v)
      else if (node.type === 'byte') writeInt(v, 1, true)
      else if (node.type === 'short') writeInt(v, 2, true)
      else if (node.type === 'int') writeInt(v, 4, true)
      else if (node.type === 'float' || node.type === 'double') {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid_floating_point')
        const b = Buffer.alloc(node.type === 'float' ? 4 : 8)
        if (node.type === 'float') { b.writeFloatBE(v); if (!Number.isFinite(b.readFloatBE())) throw new Error('float_overflow') } else b.writeDoubleBE(v)
        add(b)
      }
      else if (node.type === 'boolean') { if (typeof v !== 'boolean') throw new Error('invalid_boolean'); add(Buffer.from([v ? 1 : 0])) }
      else if (node.type === 'utf' || node.type === 'resource_location') {
        if (typeof v !== 'string' || (node.type === 'resource_location' && !IDENTIFIER.test(v))) throw new Error('invalid_string')
        const b = Buffer.from(v, 'utf8')
        if (b.length > 32767 || [...v].length > 32767) throw new Error('invalid_utf_length')
        writeVarInt(b.length); add(b)
      } else if (node.type === 'uuid') {
        if (typeof v !== 'string' || !UUID.test(v)) throw new Error('invalid_uuid')
        add(Buffer.from(v.replace(/-/g, ''), 'hex'))
      } else if (node.type === 'long') {
        if (typeof v !== 'bigint' && !(typeof v === 'string' && /^-?\d+$/.test(v))) throw new Error('invalid_long')
        const n = BigInt(v)
        if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error('invalid_long')
        const b = Buffer.alloc(8); b.writeBigInt64BE(n); add(b)
      } else if (node.type === 'blockpos') {
        if (!v || typeof v !== 'object') throw new Error('invalid_blockpos')
        const x = boundedInt(v.x, -33554432, 33554431, 'blockpos')
        const y = boundedInt(v.y, -2048, 2047, 'blockpos')
        const z = boundedInt(v.z, -33554432, 33554431, 'blockpos')
        const bits = BigInt.asUintN(26, BigInt(x)) << 38n | BigInt.asUintN(26, BigInt(z)) << 12n | BigInt.asUintN(12, BigInt(y))
        const b = Buffer.alloc(8); b.writeBigUInt64BE(bits); add(b)
      }
    }
    write(root, value, 0)
    return Buffer.concat(chunks, total)
  }
  function decode (buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) throw new Error('invalid_codec_payload')
    let offset = 0; let operations = 0
    function need (count) {
      if (offset + count > buffer.length) throw new Error('truncated_codec_payload')
      const slice = buffer.subarray(offset, offset + count); offset += count; return slice
    }
    function readVarInt () {
      let n = 0
      for (let i = 0; i < 5; i++) {
        const b = need(1)[0]
        if (i === 4 && (b & 0xf0)) throw new Error('invalid_codec_varint')
        n |= (b & 0x7f) << (7 * i)
        if (!(b & 0x80)) return n | 0
      }
      throw new Error('overlong_codec_varint')
    }
    function read (node, depth, context) {
      if (++operations > 100000 || depth > MAX_DEPTH + 1) throw new Error('codec_operation_limit')
      if (node.type === 'ref') return read(node.target, depth + 1,context)
      if(node.type==='switch'){const key=String(context?.[node.field]);if(!Object.hasOwn(node.cases,key))throw Error('unknown_codec_switch_case:'+key);return read(node.cases[key],depth+1,context)}
      if(node.protocolType){const result=options.protocol.read(buffer,offset,node.protocolType,{});if(!Number.isInteger(result.size)||result.size<0||offset+result.size>buffer.length)throw Error('invalid_protocol_codec_size');offset+=result.size;return result.value}
      if (node.type === 'struct') {
        const out = Object.create(null)
        for (const field of node.fields) out[field.name] = read(field.codec, depth + 1,out)
        return out
      }
      if (node.type === 'list') {
        const length = read({ type: node.lengthType }, depth + 1)
        if (!Number.isInteger(length) || length < 0 || length > node.maxItems) throw new Error('invalid_list_length')
        const out = []
        for (let i = 0; i < length; ++i) out.push(read(node.element, depth + 1))
        return out
      }
      if (node.type === 'optional') return read({ type: 'boolean' }, depth + 1) ? read(node.value, depth + 1) : null
      if (node.type === 'enum') {
        const n = read({ type: node.ordinalType }, depth + 1)
        if (n < 0 || n >= node.values.length) throw new Error('invalid_enum_ordinal')
        return node.values[n]
      }
      if (node.type === 'varint') return readVarInt()
      if (node.type === 'byte') return need(1).readInt8(0)
      if (node.type === 'short') return need(2).readInt16BE(0)
      if (node.type === 'int') return need(4).readInt32BE(0)
      if (node.type === 'float' || node.type === 'double') {
        const value = node.type === 'float' ? need(4).readFloatBE(0) : need(8).readDoubleBE(0)
        if (!Number.isFinite(value)) throw new Error('invalid_floating_point')
        return value
      }
      if (node.type === 'boolean') { const b = need(1)[0]; if (b !== 0 && b !== 1) throw new Error('invalid_boolean'); return b === 1 }
      if (node.type === 'utf' || node.type === 'resource_location') {
        const length = readVarInt()
        if (length < 0 || length > 32767) throw new Error('invalid_utf_length')
        const value = DECODER.decode(need(length))
        if ([...value].length > 32767 || (node.type === 'resource_location' && !IDENTIFIER.test(value))) throw new Error('invalid_string')
        return value
      }
      if (node.type === 'uuid') {
        const h = need(16).toString('hex')
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
      }
      if (node.type === 'long') return need(8).readBigInt64BE(0)
      if (node.type === 'blockpos') {
        const n = need(8).readBigUInt64BE(0)
        return { x: Number(BigInt.asIntN(26, n >> 38n)), y: Number(BigInt.asIntN(12, n)), z: Number(BigInt.asIntN(26, n >> 12n)) }
      }
      throw new Error('invalid_codec_type')
    }
    const out = read(root, 0)
    if (offset !== buffer.length) throw new Error('codec_trailing_bytes')
    return out
  }
  return Object.freeze({ encode, decode, description: { schema: plan.schema, definitionCount: Object.keys(defs).length, nodeCount: nodes } })
}

function flatSchemaToPlan (fields) {
  if (!Array.isArray(fields)) throw new Error('invalid_flat_schema')
  return { schema: 'mineflayer-mod-support/codec-ir/v1', definitions: {}, root: {
    type: 'struct', fields: fields.map(v => ({ name: v.field, codec: { type: v.type } }))
  } }
}
module.exports = { compileCodecPlan, flatSchemaToPlan }
