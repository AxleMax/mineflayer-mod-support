'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { WireWriter } = require('../src/protocol/forge/wire')
const { packSimpleChannel, unpackSimpleChannel, encodeTierSync, decodeTierSync } = require('../src/protocol/forge/simple-channel')
const { ModSupportRuntime } = require('../src/core/runtime')
const { makeCodec } = require('../src/analyzer/codec-runtime')
const { decodeC2SModListReply, unwrapFml3Reply, wrapFml3Reply } = require('../src/protocol/forge/fml3-client-wire')
const { validateManifest } = require('../src/runtime/compatibility')

class FakeClient extends EventEmitter {
  constructor () { super(); this.version = '1.20.1'; this.state = 'login'; this.autoVersionHooks = []; this.writes = [] }
  write (name, data) { this.writes.push({ name, data }); return true }
  writeRaw () {}
}
const modList = () => wrapFml3Reply(new WireWriter().byte(1).count(1).modId('forge').count(2)
  .identifier('forge:tier_sorting').string('1.0').identifier('waystones:network').string('1.0').count(0).count(0).finish())
const req = (messageId, body) => ({ messageId, channel: 'fml:loginwrapper', data: body })
const sampleManifest = () => ({
  schema: 'mineflayer-mod-support/compatibility-manifest/v1', execution: 'node-only',
  generatedFrom: [{ file: 'waystones.jar', sha256: 'a'.repeat(64) }],
  dependencies: [{ id: 'waystones', version: '14.1.21', source: 'waystones.jar' }],
  messages: [
    { id: 'waystones:teleport_effect', direction: 'clientbound', predictedChannel: 'waystones:network',
      predictedDiscriminator: 8, runtimeReady: true, codec: { status: 'candidate-codec', verifiedAgainstServer: true, candidateSchema: [{ field: 'pos', type: 'blockpos' }] } },
    { id: 'waystones:edit_waystone', direction: 'serverbound', predictedChannel: 'waystones:network',
      predictedDiscriminator: 1, codec: { status: 'candidate-codec', candidateSchema: [{ field: 'waystoneUid', type: 'uuid' }] } },
    { id: 'waystones:known_waystones', direction: 'clientbound', predictedChannel: 'waystones:network',
      predictedDiscriminator: 7, codec: { status: 'unresolved', candidateSchema: null } }
  ], runtime: { canAdvertiseMods: true, canSendModPayloads: true }
})

test('Forge IndexedMessageCodec uses one unsigned-byte discriminator, not VarInt', () => {
  const body = Buffer.from([1, 2, 3])
  assert.deepEqual(packSimpleChannel(255, body), Buffer.from([255, 1, 2, 3]))
  assert.deepEqual(unpackSimpleChannel(Buffer.from([255, 1, 2, 3])), { discriminator: 255, payload: body })
  assert.throws(() => packSimpleChannel(256, body), /invalid_simple_channel/)
  assert.throws(() => unpackSimpleChannel(Buffer.alloc(0)), /invalid_simple_channel/)
})

test('TierSortingRegistry SyncPacket uses unsigned-byte 0 + count + resource locations', () => {
  const value = encodeTierSync(['minecraft:wood', 'minecraft:stone', 'minecraft:iron'])
  assert.equal(value[0], 0)
  assert.deepEqual(decodeTierSync(unpackSimpleChannel(value).payload), { tiers: ['minecraft:wood', 'minecraft:stone', 'minecraft:iron'] })
  assert.equal(value[1], 3)
  assert.throws(() => decodeTierSync(Buffer.from([2, 0x01])), /invalid_wire_length|truncated|invalid_wire/)
  assert.throws(() => decodeTierSync(new WireWriter().count(2).identifier('minecraft:wood').identifier('minecraft:wood').finish()), /duplicate_tier/)
})

test('tier state handles native play payload with no Java runtime', () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)
  client.state = 'play'
  const handled = []
  runtime.on('nativeChannelMessage', msg => handled.push(msg))
  client.emit('packet', { channel: 'forge:tier_sorting', data: encodeTierSync(['minecraft:wood','minecraft:iron']) }, { name: 'custom_payload', state: 'play' })
  assert.deepEqual(runtime.nativeChannels.tier.order, ['minecraft:wood','minecraft:iron'])
  assert.equal(handled.length, 1)
  assert.equal(runtime.snapshot().nativeChannels.tierSorting.synced, true)
  assert.deepEqual(runtime.nativeChannels.getAdvertisedChannels(), [])
  runtime.destroy()
})

test('opt-in tier profile is the only native channel advertised; no JAR identities', () => {
  const runtime = new ModSupportRuntime({ compatibilityManifest: sampleManifest(),
    experimental: { fml3ProbeControlled: true, nativeTierChannel: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  client.emit('login_plugin_request', req(1, modList()))
  client.write('login_plugin_response', { messageId: 1, data: null })
  const wire = unwrapFml3Reply(client.writes[0].data.data)
  const reply = decodeC2SModListReply(wire)
  assert.deepEqual(reply, { mods: [], channels: [{ id: 'forge:tier_sorting', version: '1.0' }], registries: [] })
  assert.equal(runtime.snapshot().nativeChannels.modChannelsAdvertisable, false)
  assert.equal(runtime.snapshot().fml3Controller.mode, 'controlled-native-tier-diagnostic')
  assert.equal(runtime.snapshot().compatibility.capabilities.canJoinModded, false)
  runtime.destroy()
})

test('compiled candidate Waystones codecs remain observation-only and never promote to advertised capability', () => {
  const runtime = new ModSupportRuntime({ compatibilityManifest: sampleManifest() })
  const client = new FakeClient(); runtime.attachClient(client)
  client.state = 'play'
  const candidateEvents = []
  runtime.on('nativeChannelCandidate', msg => candidateEvents.push(msg))
  const payload = packSimpleChannel(8, makeCodec([{ field: 'pos', type: 'blockpos' }]).encode({ pos: { x: 8, y: 72, z: -9 } }))
  client.emit('packet', { channel: 'waystones:network', data: payload }, { name: 'custom_payload', state: 'play' })
  assert.deepEqual(candidateEvents[0].data.pos, { x: 8, y: 72, z: -9 })
  assert.equal(runtime.snapshot().nativeChannels.receive.candidate, 1)
  assert.equal(runtime.nativeChannels.getAdvertisedChannels().length, 0)
  const failures = []
  runtime.on('nativeChannelDecodeError', msg => failures.push(msg))
  // Wrong/unsupported candidate type is never silently accepted.
  client.emit('packet', { channel: 'waystones:network', data: Buffer.from([7, 1, 2, 3]) }, { name: 'custom_payload', state: 'play' })
  assert.equal(runtime.snapshot().nativeChannels.receive.rejected, 1)
  assert.equal(runtime.snapshot().nativeChannels.modChannelsAdvertisable, false)
  runtime.destroy()
})

test('untrusted manifest cannot slip unsupported, duplicate or nonstring field schemas into a codec', () => {
  const bad = sampleManifest(); bad.messages[0].codec.candidateSchema = [{ field: 'pos', type: 'blockpos' }, { field: 'pos', type: 'long' }]
  assert.throws(() => validateManifest(bad), /invalid_candidate_field/)
  bad.messages[0].codec.candidateSchema = [{ field: '__proto__', type: 'blockpos' }]
  // Prototype-polluting property names are not acceptable even as candidates.
  assert.throws(() => validateManifest(bad), /invalid_candidate_field/)
})

test('native runtime does not process payload from login phase, outgoing direction or unrequested channel', () => {
  const runtime = new ModSupportRuntime()
  const before = runtime.snapshot().nativeChannels.receive.handled
  const packet = encodeTierSync(['minecraft:wood'])
  assert.equal(runtime.nativeChannels.observe({ direction: 'inbound', phase: 'login', channel: 'forge:tier_sorting', data: packet }).status, 'ignored')
  assert.equal(runtime.nativeChannels.observe({ direction: 'outbound', phase: 'play', channel: 'forge:tier_sorting', data: packet }).status, 'ignored')
  assert.equal(runtime.nativeChannels.observe({ direction: 'inbound', phase: 'play', channel: 'some:unknown', data: packet }).status, 'ignored')
  assert.equal(runtime.snapshot().nativeChannels.receive.handled, before)
  runtime.destroy()
})

test('real Balm/Waystones JARs compile two read-only native candidates, never full Waystones support',
  { skip: !(process.env.MMR_BALM_JAR && process.env.MMR_WAYSTONES_JAR) }, () => {
    const { analyzeJars } = require('../src/analyzer/mod-jar')
    const { createCompatibilityManifest } = require('../src/analyzer/compatibility-manifest')
    const analysis = analyzeJars([process.env.MMR_BALM_JAR, process.env.MMR_WAYSTONES_JAR])
    const runtime = new ModSupportRuntime({ compatibilityManifest: createCompatibilityManifest(analysis) })
    const candidate = runtime.snapshot().nativeChannels.candidateDecoders
    assert.deepEqual(candidate.map(x => x.id), ['waystones:teleport_effect', 'waystones:waystone_cooldown'])
    assert.ok(candidate.every(x => x.serverVerified === false))
    assert.deepEqual(runtime.nativeChannels.getAdvertisedChannels(), [])
    runtime.destroy()
  })
