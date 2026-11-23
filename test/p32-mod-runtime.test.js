'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: nextTick } = require('node:timers/promises')
const { readFileSync } = require('node:fs')
const { dirname } = require('node:path')
const { createHash } = require('node:crypto')
const { ModSupportRuntime } = require('../src/core/runtime')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')
const { packSimpleChannel } = require('../src/protocol/forge/simple-channel')
const { installWaystonesScenario } = require('../examples/p32-waystones-scenario')

function receive (runtime, channel, data) {
  runtime.emit('payload', { channel, data, phase: 'play', direction: 'inbound' })
}

test('P3.2 applies captured config and messages, then indexes nonempty JAR-shaped snapshots by UUID', {
  skip: !process.env.MMR_WAYSTONES_JAR || !process.env.MMR_PLAY_REPORT
}, t => {
  const runtime = new ModSupportRuntime({ modsDir: dirname(process.env.MMR_WAYSTONES_JAR) })
  const other = new ModSupportRuntime({ modsDir: dirname(process.env.MMR_WAYSTONES_JAR) })
  t.after(() => { runtime.destroy(); other.destroy() })
  const evidence = installWaystonesScenario(runtime)
  const samples = JSON.parse(readFileSync(process.env.MMR_PLAY_REPORT)).runtime.playWire.samples
  for (const sample of samples) {
    const data = Buffer.from(sample.hex, 'hex')
    assert.equal(createHash('sha256').update(data).digest('hex'), sample.sha256)
    receive(runtime, sample.channel, data)
    receive(other, sample.channel, data)
  }
  assert.equal(runtime.modState.getReport().counts.handled, 3)
  assert.equal(other.modState.getReport().counts.handled, 0)
  assert.equal(evidence.configReads, 3)
  const copy = runtime.configMirror.get('waystones:common')
  copy.propertyCount = 0
  assert.equal(runtime.configMirror.get('waystones:common').propertyCount, 27)
  assert.deepEqual(runtime.nativeChannels.getAdvertisedMods(), [])
  assert.deepEqual(runtime.nativeChannels.getAdvertisedChannels(), [])

  const message = runtime.compatibility.getMessage('waystones:known_waystones')
  const channel = message.predictedChannel
  const discriminator = message.predictedDiscriminator
  const codec = compileCodecPlan(message.codecPlan)
  const type = 'waystones:waystone'
  const first = 'b4bca12b-3218-42a5-9138-a91207cb746b'
  const second = '9c881b85-d56b-42aa-ae68-cbd20fc0ff45'
  const item = (uuid, name) => ({
    slot_0: uuid, slot_1: type, slot_2: name, slot_3: false, slot_4: 'minecraft:overworld',
    slot_5: { x: 1, y: 72, z: -6 }, slot_6: 'PLAYER'
  })
  const publish = (items) => receive(runtime, channel, packSimpleChannel(discriminator, codec.encode({ slot_0: type, slot_1: items })))
  publish([item(first, 'one')])
  const view = () => runtime.modData.getCollection(channel, discriminator, type)
  assert.deepEqual(view().changes, { added: [first], updated: [], removed: [] })
  assert.equal(runtime.modState.getApplied(channel, discriminator, type).data.slot_1[0].slot_5.z, -6)
  publish([item(second, 'two'), item(first, 'renamed')])
  const updated = view()
  assert.deepEqual(updated.changes, { added: [second], updated: [first], removed: [] })
  updated.changes.added.pop()
  assert.deepEqual(view().changes.added, [second])
  assert.equal(runtime.modData.getCollectionItem(channel, discriminator, type, first).slot_2, 'renamed')
  publish([item(second, 'two')])
  assert.deepEqual(view().changes, { added: [], updated: [], removed: [first] })
  assert.equal(runtime.modData.getCollectionItem(channel, discriminator, type, first), null)
  publish([item(second, 'two'), item(second, 'duplicate')])
  assert.equal(view().itemIds, null)
  assert.equal(view().changes, null)
  publish([])
  assert.equal(view().changes, null)
})

test('P3.2 requires exact wire evidence and preserves observations when a handler declines or throws', t => {
  const runtime = new ModSupportRuntime()
  t.after(() => runtime.destroy())
  const channel = 'sample:network'
  const id = 'sample:message'
  const discriminator = 2
  const profile = { channel, discriminator, id }
  runtime.nativeChannels.dispatcher.registerCandidate({
    id, predictedChannel: channel, predictedDiscriminator: discriminator,
    direction: 'clientbound', codecStatus: 'candidate-codec', codecSchema: [{ field: 'value', type: 'byte' }]
  })
  const send = bytes => receive(runtime, channel, Buffer.from(bytes))
  assert.throws(() => runtime.registerModCodecHandler({ ...profile, id: 'sample:other', onMessage () {} }), /invalid_codec_handler/)
  const off = runtime.registerModCodecHandler({ ...profile, onMessage: () => false })
  send([2, 4])
  assert.equal(runtime.modState.getApplied(channel, discriminator), null)
  assert.equal(runtime.modState.getLatest(channel, discriminator).status, 'candidate-only')
  off()
  let calls = 0
  const offReplacement = runtime.registerModCodecHandler({
    ...profile,
    onMessage (data) { calls++; data.value = 100; if (calls === 1) throw new Error('callback failed') }
  })
  off()
  send([2, 4, 0])
  assert.equal(calls, 0)
  send([2, 4])
  assert.equal(runtime.nativeChannels.getReport().genericNetwork.codecHandlerErrors, 1)
  assert.equal(runtime.modState.getApplied(channel, discriminator), null)
  send([2, 5])
  assert.equal(runtime.modState.getApplied(channel, discriminator).data.value, 5)
  offReplacement()
})

test('P3.2 correlates a version-gated explicit request and cancels timeout or transport-end waits', async t => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  t.after(() => runtime.destroy())
  const channel = 'sample:lookup'
  const writes = []
  runtime.registerModAdapter({
    id: 'sample', version: '1', advertise: true,
    channels: [{ id: channel, version: '1', messages: [
      { discriminator: 1, direction: 'serverbound', encode: id => Buffer.from([id]) },
      { discriminator: 2, direction: 'clientbound', decode: bytes => bytes[0], onMessage () {} }
    ] }]
  })
  const request = (key, timeoutMs = 1000) => runtime.requestModMessage(channel, 1, key, {
    responseDiscriminator: 2, timeoutMs, match: echoed => echoed === key
  })
  await assert.rejects(request(4), /native_channel_send_requires_play/)
  const mapping = { id: channel, version: '0' }
  runtime.fml3.modList = {
    modIds: [], registries: [], dataPackRegistries: [],
    channels: [{ id: 'minecraft:register', version: 'FML3' }, mapping]
  }
  runtime.client = { state: 'play', write: (name, packet) => writes.push({ name, packet }) }
  runtime.protocol.state = 'play'
  runtime.emit('packet', { direction: 'inbound', phase: 'play', name: 'login' })
  await nextTick()
  await assert.rejects(request(4), /server_channel_version_mismatch/)
  assert.equal(writes.length, 1) // REGISTER only
  mapping.version = '1'
  const pending = request(4)
  await assert.rejects(request(5), /native_request_already_pending/)
  receive(runtime, channel, Buffer.from([2, 5]))
  await nextTick()
  assert.equal(runtime.nativeChannels.pendingRequests.size, 1)
  receive(runtime, channel, Buffer.from([2, 4]))
  const result = await pending
  assert.deepEqual(writes[1].packet.data, Buffer.from([1, 4]))
  assert.equal(result.request.status, 'sent')
  assert.equal(result.response.data, 4)
  assert.equal(result.serverEffectConfirmed, false)
  await assert.rejects(request(4, 10), /native_request_timeout/)
  const interrupted = request(4)
  runtime.emit('end')
  await assert.rejects(interrupted, /native_request_transport_ended/)
  assert.equal(runtime.nativeChannels.pendingRequests.size, 0)
})
