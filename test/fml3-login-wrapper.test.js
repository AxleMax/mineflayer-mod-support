'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectFml3LoginWrapper } = require('../src/protocol/forge/login-wrapper')
const V = n => { const b = []; do { let c = n & 127; n >>>= 7; if (n) c |= 128; b.push(c) } while (n); return Buffer.from(b) }
const S = s => Buffer.concat([V(Buffer.byteLength(s)), Buffer.from(s)])
const wrap = (inner, channel = 'fml:handshake') => Buffer.concat([S(channel), V(inner.length), inner])

test('decode valid ModData with mod IDs, display names and versions', () => {
  const p = wrap(Buffer.concat([Buffer.from([5]), V(2), S('minecraft'), S('Minecraft'), S('1.20.1'), S('forge'), S('Forge'), S('47.4.0')]))
  const obj = inspectFml3LoginWrapper(p)
  assert.equal(obj.type, 'S2CModData')
  assert.equal(obj.parsed, true)
  assert.equal(obj.trailingBytes, 0)
  assert.deepEqual(obj.details.mods.map(m => m.id), ['minecraft', 'forge'])
})

test('decode valid FML3 ModList with channels, registries, datapacks', () => {
  const inner = Buffer.concat([Buffer.from([1]), V(2), S('minecraft'), S('forge'), V(1), S('fml:handshake'), S('FML3'), V(1), S('minecraft:item'), V(1), S('example:other')])
  const obj = inspectFml3LoginWrapper(wrap(inner))
  assert.equal(obj.parsed, true)
  assert.equal(obj.type, 'S2CModList')
  assert.deepEqual(obj.details.modIds, ['minecraft', 'forge'])
  assert.deepEqual(obj.details.channels, [{ id: 'fml:handshake', version: 'FML3' }])
  assert.deepEqual(obj.details.registries, ['minecraft:item'])
  assert.deepEqual(obj.details.dataPackRegistries, ['example:other'])
})

test('minimal ModList supports missing optional datapack field', () => {
  const obj = inspectFml3LoginWrapper(wrap(Buffer.from([1, 0, 0, 0])))
  assert.equal(obj.parsed, true)
  assert.deepEqual(obj.details.dataPackRegistries, [])
})

test('unknown messages and valid registry snapshots never expose raw bytes', () => {
  const unknown = inspectFml3LoginWrapper(wrap(Buffer.from([200, 0xfa, 0xfb])))
  const registry = inspectFml3LoginWrapper(wrap(Buffer.concat([Buffer.from([3]), S('minecraft:item'), Buffer.from([1, 0xfa, 0xfb])])))
  assert.equal(unknown.parsed, true)
  assert.equal(registry.parsed, true)
  for (const result of [unknown, registry]) assert.equal(JSON.stringify(result).includes('fafb'), false)
  assert.equal(registry.details.registryName, 'minecraft:item')
  assert.equal(registry.details.snapshotBytes, 2)
})

test('reject incorrect inner length, short varint and oversized strings', () => {
  assert.equal(inspectFml3LoginWrapper(Buffer.concat([S('fml:handshake'), V(7), Buffer.from([1])])).error, 'wrapper_length_mismatch')
  assert.equal(inspectFml3LoginWrapper(Buffer.from([0x80])).parsed, false)
  assert.equal(inspectFml3LoginWrapper(wrap(Buffer.concat([Buffer.from([5]), V(1), V(2000)]))).error, 'string_too_long')
})

test('reject malformed channel and overflow counts', () => {
  assert.equal(inspectFml3LoginWrapper(wrap(Buffer.from([5, 0]), 'fml:LOGIN')).parsed, false)
  assert.equal(inspectFml3LoginWrapper(wrap(Buffer.concat([Buffer.from([5]), V(5000)]))).error, 'count_too_large')
})

test('reject input larger than 1 MiB', () => {
  const obj = inspectFml3LoginWrapper(Buffer.alloc(1048577))
  assert.equal(obj.error, 'payload_too_large')
})
