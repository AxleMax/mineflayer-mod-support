'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { WireWriter } = require('../src/protocol/forge/wire')
const { wrapFml3Reply, unwrapFml3Reply, decodeC2SModListReply } = require('../src/protocol/forge/fml3-client-wire')
const { inspectFml3LoginWrapper } = require('../src/protocol/forge/login-wrapper')
const { ModSupportRuntime } = require('../src/core/runtime')

const modData = () => wrapFml3Reply(new WireWriter().byte(5).count(1).modId('forge').string('Forge').string('47.4.13').finish())
const modList = () => wrapFml3Reply(new WireWriter().byte(1).count(1).modId('forge').count(1).identifier('forge:tier_sorting').string('1.0').count(0).count(0).finish())
const mismatch = () => wrapFml3Reply(new WireWriter().byte(6).count(2).identifier('forge:tier_sorting').string('1.0').identifier('waystones:network').string('1.0').finish())
const registry = () => wrapFml3Reply(new WireWriter().byte(3).identifier('minecraft:item').byte(0).finish())
const request = (messageId, data) => ({ messageId, channel: 'fml:loginwrapper', data })

class FakeClient extends EventEmitter {
  constructor () {
    super(); this.version = '1.20.1'; this.state = 'login'; this.autoVersionHooks = []; this.writes = []
  }
  write (name, data) { this.writes.push({ name, data }); return true }
  writeRaw () {}
}

test('S2CChannelMismatchData decodes versioned channel IDs (Forge legacy wire form)', () => {
  const result = inspectFml3LoginWrapper(mismatch())
  assert.equal(result.type, 'S2CChannelMismatchData')
  assert.equal(result.trailingBytes, 0)
  assert.deepEqual(result.details.mismatchedChannels, [
    { id: 'forge:tier_sorting', version: '1.0' },
    { id: 'waystones:network', version: '1.0' }
  ])
})

test('malformed mismatch remains diagnostic-only and never creates fake entries', () => {
  const broken = wrapFml3Reply(new WireWriter().byte(6).count(1).identifier('forge:tier_sorting').finish())
  const parsed = inspectFml3LoginWrapper(broken)
  assert.equal(parsed.type, 'S2CChannelMismatchData')
  assert.equal(parsed.details.mismatchedChannels, undefined)
  assert.ok(parsed.details.decodeError)
})

test('P1.6 controlled probe suppresses informational empty auto reply and replaces ModList', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const d = request(0, modData())
  client.emit('login_plugin_request', d)
  client.write('login_plugin_response', { messageId: 0, data: null })
  client.emit('packet', d, { name: 'login_plugin_request', state: 'login' })
  assert.equal(client.writes.length, 0)
  assert.equal(runtime.snapshot().fml3Controller.prepared, 1) // generic did not re-enqueue
  const l = request(1, modList())
  client.emit('login_plugin_request', l)
  client.write('login_plugin_response', { messageId: 1, data: null })
  client.emit('packet', l, { name: 'login_plugin_request', state: 'login' })
  assert.equal(client.writes.length, 1)
  assert.deepEqual(decodeC2SModListReply(unwrapFml3Reply(client.writes[0].data.data)), { mods: [], channels: [], registries: [] })
  assert.equal(client.writes[0].data.successful, true)
  const snap = runtime.snapshot()
  assert.equal(snap.fml3Controller.prepared, 2)
  assert.equal(snap.fml3Controller.replaced, 1)
  assert.equal(snap.fml3Controller.suppressed, 1)
  assert.equal(snap.fml3.diagnostics.modListReply, 'wire_reply_sent_unverified')
  assert.equal(snap.fml3.diagnostics.emptyResponses.length, 0)
  assert.equal(snap.compatibility.capabilities.canJoinModded, false)
  runtime.destroy()
})

test('server can reuse same request ID for mismatch notification without false duplicate warning', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const l = request(1, modList())
  client.emit('login_plugin_request', l)
  client.emit('packet', l, { name: 'login_plugin_request', state: 'login' })
  client.write('login_plugin_response', { messageId: 1, data: null })
  const m = request(1, mismatch())
  client.emit('login_plugin_request', m)
  client.write('login_plugin_response', { messageId: 1, data: null })
  client.emit('packet', m, { name: 'login_plugin_request', state: 'login' })
  const snap = runtime.snapshot()
  assert.equal(snap.fml3Controller.prepared, 2)
  assert.equal(snap.fml3Controller.replaced, 1)
  assert.equal(snap.fml3Controller.suppressed, 1)
  assert.equal(client.writes.length, 1)
  assert.equal(snap.fml3.state, 'channel_mismatch_rejected')
  assert.deepEqual(snap.fml3.channelMismatch.mismatchedChannels.map(x => x.id), ['forge:tier_sorting', 'waystones:network'])
  assert.equal(snap.fml3.diagnostics.warnings.includes('duplicate_request_id:1'), false)
  runtime.destroy()
})

test('cannot send ACK for registry until it has been applied, and remains unjoinable', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const r = request(2, registry())
  client.emit('login_plugin_request', r)
  client.emit('packet', r, { name: 'login_plugin_request', state: 'login' })
  client.write('login_plugin_response', { messageId: 2, data: null })
  const snap = runtime.snapshot()
  assert.equal(client.writes.length, 0)
  assert.equal(snap.fml3Controller.suppressed, 1)
  assert.equal(snap.fml3.registryObservation.ackSent, false)
  assert.equal(snap.fml3.registryObservation.applied, false)
  assert.equal(snap.fml3Controller.warnings[0], 'no_registry_or_config_ack_sent:2')
  runtime.destroy()
})

test('default passive mode and unrelated plugin responses remain unchanged', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  client.emit('login_plugin_request', request(20, modData()))
  client.write('login_plugin_response', { messageId: 21, data: null })
  assert.equal(client.writes.length, 1)
  runtime.destroy()
  const passive = new ModSupportRuntime()
  const other = new FakeClient(); passive.attachClient(other)
  other.emit('login_plugin_request', request(0, modData()))
  other.write('login_plugin_response', { messageId: 0, data: null })
  assert.equal(other.writes.length, 1)
  assert.equal(other.writes[0].data.data, null)
  passive.destroy()
})

test('rejects unsafe simultaneous probe modes', () => {
  assert.throws(() => new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3ProbeEmptyReply: true } }), /Choose either/)
})

test('manifest-provided candidates cannot silently become advertised FML3 capabilities', () => {
  const manifest = {
    schema: 'mineflayer-mod-support/compatibility-manifest/v1', execution: 'node-only',
    generatedFrom: [{ file: 'waystones.jar', sha256: 'a'.repeat(64) }],
    dependencies: [{ id: 'waystones', version: '14.1.21', source: 'waystones.jar' }],
    messages: [{ id: 'waystones:edit_waystone', direction: 'serverbound',
      predictedChannel: 'waystones:network', predictedDiscriminator: 1,
      codec: { status: 'candidate-codec', candidateSchema: [] } }]
  }
  const runtime = new ModSupportRuntime({ compatibilityManifest: manifest, experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  client.emit('login_plugin_request', request(1, modList()))
  client.write('login_plugin_response', { messageId: 1, data: null })
  const decoded = decodeC2SModListReply(unwrapFml3Reply(client.writes[0].data.data))
  assert.deepEqual(decoded, { mods: [], channels: [], registries: [] })
  assert.deepEqual(runtime.snapshot().compatibility.local.inferredChannels, ['waystones:network'])
  assert.equal(runtime.snapshot().compatibility.capabilities.canAdvertiseMods, false)
  runtime.destroy()
})
