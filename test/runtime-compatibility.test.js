'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { evaluateCompatibility, validateManifest, CompatibilityRuntime } = require('../src/runtime/compatibility')
const { ModSupportRuntime } = require('../src/core/runtime')
const { inspectFml3LoginWrapper } = require('../src/protocol/forge/login-wrapper')
const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')

function vi (value) { const result = []; let v = value >>> 0; while (v > 0x7f) { result.push((v & 0x7f) | 0x80); v >>>= 7 }; result.push(v); return Buffer.from(result) }
const txt = s => Buffer.concat([vi(Buffer.byteLength(s)), Buffer.from(s)])
function wrap (inner) { return Buffer.concat([txt('fml:handshake'), vi(inner.length), inner]) }
function modData () { return wrap(Buffer.concat([Buffer.from([5]), vi(2), txt('balm'), txt('Balm'), txt('7.3.44'), txt('forge'), txt('Forge'), txt('47.4.13')])) }
function modList () { return wrap(Buffer.concat([Buffer.from([1]), vi(2), txt('forge'), txt('balm'), vi(1), txt('balm:network'), txt('1.0'), vi(1), txt('minecraft:item'), vi(0)])) }
function registry (name = 'minecraft:item', has = 1, bytes = Buffer.from([0x0a, 0x01])) { return wrap(Buffer.concat([Buffer.from([3]), txt(name), Buffer.from([has]), bytes])) }
function fixture () {
  return createCompatibilityManifest({ schema: 'mineflayer-mod-support/jar-analysis/v1', artifacts: [{ source: 'balm.jar', sha256: 'a'.repeat(64), network: { registrations: [{ id: 'balm:message', direction: 'clientbound', className: 'K', predictedDiscriminator: 0, predictedChannel: 'balm:network', codec: { status: 'candidate-codec', schema: [] } }] } }], discoveredMods: [{ id: 'balm', version: '7.3.44', source: 'balm.jar' }] })
}
class FakeClient extends EventEmitter {
  constructor () { super(); this.state = 'handshaking'; this.version = '1.20.1'; this.protocolVersion = 763; this.autoVersionHooks = []; this.writes = [] }
  write (name, data) { this.writes.push([name,data]) }
  writeRaw () {}
}

test('manifest validates and rejects unsupported shapes', () => {
  assert.throws(() => validateManifest({}), /unsupported_compatibility_manifest/)
  const wrong = fixture(); wrong.messages[0].predictedDiscriminator = -1
  assert.throws(() => validateManifest(wrong), /invalid_predicted_discriminator/)
})
test('manifests cannot self-certify runtime or server verification', () => {
  const malicious = fixture()
  malicious.runtime = { canAdvertiseMods: true, canJoinForgeAsModded: true, canSendModPayloads: true }
  malicious.messages[0].numericDiscriminator = 0
  malicious.messages[0].runtimeReady = true
  malicious.messages[0].codec.verifiedAgainstServer = true
  const runtime = new CompatibilityRuntime({ compatibilityManifest: malicious })
  const message = runtime.getMessage('balm:message')
  assert.equal(message.safeToSend, false)
  assert.equal(runtime.getReport().capabilities.canAdvertiseMods, false)
  assert.equal(runtime.getReport().capabilities.canJoinModded, false)
})
test('capabilities compare server handshake against local evidence but remain blocked', () => {
  const report = evaluateCompatibility(validateManifest(fixture()), { modIds: ['minecraft', 'forge', 'balm', 'waystones'], channels: [{id:'balm:network', version:'1.0'},{id:'waystones:network',version:'1.0'}], mods:[{id:'balm', version:'7.3.44'}], registries:['minecraft:item'] })
  assert.deepEqual(report.comparison.matchingModIds, ['balm'])
  assert.deepEqual(report.comparison.absentFromLocalJars, ['waystones'])
  assert.deepEqual(report.comparison.channelNameMatches, ['balm:network'])
  assert.equal(report.status, 'inspected-not-compatible')
  assert.equal(report.capabilities.canSendModPayloads, false)
  assert.equal(report.server.declaredRegistryNames[0], 'minecraft:item')
})
test('FML3 registry inspection records a bounded opaque snapshot', () => {
  const result = inspectFml3LoginWrapper(registry())
  assert.equal(result.parsed, true)
  assert.equal(result.type, 'S2CRegistry')
  assert.equal(result.details.registryName, 'minecraft:item')
  assert.equal(result.details.hasSnapshot, true)
  assert.equal(result.details.entriesDecoded, false)
  assert.equal(result.details.snapshotBytes, 2)
  assert.match(result.details.snapshotDigest, /^[0-9a-f]{64}$/)
  assert.equal(result.trailingBytes, 0)
})
test('FML3 registry inspector rejects malformed registry flag and missing data', () => {
  assert.equal(inspectFml3LoginWrapper(registry('minecraft:item', 2)).parsed, false)
  assert.equal(inspectFml3LoginWrapper(registry('minecraft:item', 0, Buffer.from([1]))).parsed, false)
  assert.equal(inspectFml3LoginWrapper(registry('minecraft:item', 0, Buffer.alloc(0))).parsed, true)
})
test('runtime automatically evaluates real incoming FML3 mod data and list without replying', () => {
  const runtime = new ModSupportRuntime({ compatibilityManifest: fixture() })
  const client = new FakeClient()
  runtime.attachClient(client)
  client.state = 'login'
  const events = []
  runtime.on('compatibilityEvaluated', report => events.push(report))
  client.emit('packet', { channel:'fml:loginwrapper', messageId:0, data:modData() }, { name:'login_plugin_request', state:'login' })
  client.emit('packet', { channel:'fml:loginwrapper', messageId:1, data:modList() }, { name:'login_plugin_request', state:'login' })
  assert.equal(events.length, 1)
  assert.equal(runtime.loader.version, '47.4.13')
  assert.deepEqual(events[0].comparison.matchingModIds, ['balm'])
  assert.equal(events[0].capabilities.canJoinModded, false)
  assert.equal(client.writes.length, 0)
  runtime.destroy()
})
test('runtime records S2CRegistry in diagnostic observer without applying or ACK', () => {
  const runtime = new ModSupportRuntime({ compatibilityManifest: fixture() })
  const client = new FakeClient()
  runtime.attachClient(client)
  client.state = 'login'
  client.emit('packet', { channel:'fml:loginwrapper', messageId:2, data:registry() }, { name:'login_plugin_request', state:'login' })
  const snapshot = runtime.snapshot()
  assert.equal(snapshot.fml3.registryObservation.receivedCount, 1)
  assert.equal(snapshot.fml3.registryObservation.snapshots[0].name, 'minecraft:item')
  assert.equal(snapshot.fml3.registryObservation.snapshots[0].status, 'received-opaque-not-applied')
  assert.equal(snapshot.fml3.registryObservation.applied, false)
  assert.equal(client.writes.length, 0)
  runtime.destroy()
})
test('runtime refuses to load both JAR directory and a manifest', () => {
  assert.throws(() => new CompatibilityRuntime({ compatibilityManifest: fixture(), modsDir: '/tmp' }), /Choose compatibilityManifest or modsDir/)
})

test('compatibility comparison is safe to mutate by callers', () => {
  const instance = new CompatibilityRuntime({ compatibilityManifest: fixture() })
  const first = instance.getReport()
  first.local.mods.length = 0
  assert.equal(instance.getReport().local.mods.length, 1)
})
