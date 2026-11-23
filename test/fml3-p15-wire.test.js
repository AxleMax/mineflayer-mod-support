'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { WireWriter, WireReader } = require('../src/protocol/forge/wire')
const { encodeC2SModListReply, decodeC2SModListReply, wrapFml3Reply, unwrapFml3Reply, encodeFml3Acknowledge } = require('../src/protocol/forge/fml3-client-wire')
const { encodeForgeRegistrySnapshot, decodeForgeRegistrySnapshot } = require('../src/protocol/forge/registry-snapshot')
const { inspectFml3LoginWrapper } = require('../src/protocol/forge/login-wrapper')
const { ModSupportRuntime } = require('../src/core/runtime')

const modList = () => new WireWriter().byte(1).count(1).modId('forge').count(1).identifier('fml:handshake').string('FML3').count(1).identifier('minecraft:item').count(0).finish()
const registry = snapshot => new WireWriter().byte(3).identifier('minecraft:item').byte(1).bytes(snapshot).finish()
const makeRequest = (messageId = 1, payload = wrapFml3Reply(modList())) => ({ channel: 'fml:loginwrapper', messageId, data: payload })
class FakeClient extends EventEmitter {
  constructor () { super(); this.state = 'login'; this.version = '1.20.1'; this.protocolVersion = 763; this.autoVersionHooks = []; this.writes = [] }
  write (name, data) { this.writes.push({ name, data }) }
  writeRaw () {}
}

test('C2SModListReply byte codec matches FML3 known field order and discriminator', () => {
  const value = { mods: ['minecraft', 'forge'], channels: [{ id: 'fml:handshake', version: 'FML3' }, { id: 'balm:network', version: '1.0' }], registries: [{ id: 'minecraft:item', marker: '' }, { id: 'forge:fluid_type', marker: '1' }] }
  const encoded = encodeC2SModListReply(value)
  assert.equal(encoded[0], 2)
  assert.deepEqual(decodeC2SModListReply(encoded), value)
  assert.deepEqual(unwrapFml3Reply(wrapFml3Reply(encoded)), encoded)
})
test('C2SModListReply wire fixture is byte-for-byte deterministic for empty capabilities', () => {
  const encoded = encodeC2SModListReply({ mods: [], channels: [], registries: [] })
  assert.equal(encoded.toString('hex'), '02000000')
  const wire = wrapFml3Reply(encoded)
  const r = new WireReader(wire)
  assert.equal(r.identifier(), 'fml:handshake')
  assert.deepEqual(r.bytes(r.varInt()), encoded)
  r.end()
  assert.equal(encodeFml3Acknowledge().subarray(-1)[0], 99)
})
test('C2SModListReply input is strictly validated and duplicates rejected', () => {
  assert.throws(() => encodeC2SModListReply({ mods: ['forge', 'forge'], channels: [], registries: [] }), /duplicate/)
  assert.throws(() => encodeC2SModListReply({ mods: ['Invalid!!'], channels: [], registries: [] }), /mod_id/)
  assert.throws(() => encodeC2SModListReply({ mods: [], channels: [{ id: 'wrong', version: '1' }], registries: [] }), /identifier/)
  assert.throws(() => decodeC2SModListReply(Buffer.from([2, 0, 0, 0, 1])), /wire_trailing_bytes/)
  assert.throws(() => decodeC2SModListReply(Buffer.from([1, 0, 0, 0])), /not_c2s/)
  assert.throws(() => unwrapFml3Reply(Buffer.from([1, 2, 3])), /wire/)
})
test('ForgeRegistry.Snapshot round trip restores ids, aliases, overrides, blocked', () => {
  const value = { ids: [{ name: 'minecraft:stone', id: 1 }, { name: 'waystones:waystone', id: 4096 }], aliases: [{ from: 'legacy:stone', to: 'minecraft:stone' }], overrides: [{ name: 'minecraft:stone', owner: 'minecraft' }], blocked: [0, 2048] }
  const bytes = encodeForgeRegistrySnapshot(value)
  assert.deepEqual(decodeForgeRegistrySnapshot(bytes), { ...value, entriesDecoded: true })
  const inspected = inspectFml3LoginWrapper(wrapFml3Reply(registry(bytes)))
  assert.equal(inspected.parsed, true)
  assert.equal(inspected.details.entriesDecoded, true)
  assert.deepEqual(inspected.details.snapshot, { ...value, entriesDecoded: true })
  assert.equal(inspected.details.entryCounts.ids, 2)
  assert.equal(inspected.trailingBytes, 0)
})
test('registry parser fails closed on malformed/truncated/duplicate IDs', () => {
  assert.throws(() => decodeForgeRegistrySnapshot(Buffer.from([1])), /truncated|wire/)
  const double = new WireWriter().count(2).identifier('minecraft:stone').varInt(1).identifier('minecraft:dirt').varInt(1).count(0).count(0).count(0).finish()
  assert.throws(() => decodeForgeRegistrySnapshot(double), /duplicate_registry_numeric_id/)
  const bad = inspectFml3LoginWrapper(wrapFml3Reply(registry(Buffer.from([0xFF, 0xFF]))))
  assert.equal(bad.parsed, true) // envelope valid, snapshot explicitly unverified
  assert.equal(bad.details.entriesDecoded, false)
  assert.equal(typeof bad.details.snapshotDecodeError, 'string')
})
test('read-only registry observer exposes decoded names and IDs but never applies', () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)
  const data = encodeForgeRegistrySnapshot({ ids: [{ name: 'waystones:warp_stone', id: 1024 }], aliases: [], overrides: [], blocked: [] })
  client.emit('packet', makeRequest(3, wrapFml3Reply(registry(data))), { name: 'login_plugin_request', state: 'login' })
  assert.equal(runtime.fml3.registryObserver.getId('minecraft:item', 'waystones:warp_stone'), 1024)
  assert.equal(runtime.fml3.registryObserver.getName('minecraft:item', 1024), 'waystones:warp_stone')
  const copy = runtime.fml3.registryObserver.getRegistry('minecraft:item')
  copy.ids[0].name = 'tampered'
  assert.equal(runtime.fml3.registryObserver.getName('minecraft:item', 1024), 'waystones:warp_stone')
  assert.equal(runtime.snapshot().fml3.registryObservation.applied, false)
  assert.equal(client.writes.length, 0)
  runtime.destroy()
})
test('passive mode does not change upstream responses', () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient(); runtime.attachClient(client)
  client.emit('login_plugin_request', makeRequest())
  client.write('login_plugin_response', { messageId: 1, data: null })
  assert.equal(client.writes.length, 1)
  assert.equal(client.writes[0].data.data, null)
  assert.equal(runtime.snapshot().fml3Probe.replaced, 0)
  runtime.destroy()
})
test('explicit wire probe replaces existing NMP auto response with truthful EMPTY client list', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeEmptyReply: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const request = makeRequest()
  client.emit('login_plugin_request', request)
  client.emit('packet', request, { name: 'login_plugin_request', state: 'login' })
  client.write('login_plugin_response', { messageId: 1, data: null })
  assert.equal(client.writes.length, 1)
  assert.deepEqual(decodeC2SModListReply(unwrapFml3Reply(client.writes[0].data.data)), { mods: [], channels: [], registries: [] })
  assert.equal(runtime.snapshot().fml3Probe.replaced, 1)
  assert.equal(runtime.snapshot().compatibility.capabilities.canJoinModded, false)
  client.write('login_plugin_response', { messageId: 2, data: null })
  assert.equal(client.writes[1].data.data, null)
  runtime.destroy()
})
test('wire probe refuses wrong version, non-ModList or malformed responses', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeEmptyReply: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  client.emit('login_plugin_request', makeRequest(2, wrapFml3Reply(Buffer.from([5, 0]))))
  client.write('login_plugin_response', { messageId: 2, data: null })
  assert.equal(client.writes[0].data.data, null)
  client.emit('login_plugin_request', makeRequest(3))
  client.version = '1.19.4'
  client.write('login_plugin_response', { messageId: 3, data: null })
  assert.equal(client.writes[1].data.data, null)
  runtime.destroy()
})
test('WireReader refuses overlong varint and oversized count', () => {
  assert.throws(() => new WireReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10])).varInt(), /overflow/)
  const value = new WireWriter().count(4096).finish()
  assert.equal(new WireReader(value).count(), 4096)
  assert.throws(() => new WireReader(new WireWriter().varInt(4097).finish()).count(), /too_large/)
})
