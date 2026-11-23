'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ModSupportRuntime } = require('../src/core/runtime')
const { WireWriter } = require('../src/protocol/forge/wire')
const { wrapFml3Reply, unwrapFml3Reply, decodeC2SModListReply } = require('../src/protocol/forge/fml3-client-wire')
const { encodeForgeRegistrySnapshot } = require('../src/protocol/forge/registry-snapshot')
const { packSimpleChannel, unpackSimpleChannel } = require('../src/protocol/forge/simple-channel')

class FakeClient extends EventEmitter {
  constructor () {
    super()
    this.version = '1.20.1'
    this.protocolVersion = 763
    this.state = 'login'
    this.autoVersionHooks = []
    this.writes = []
  }
  write (name, data) { this.writes.push({ name, data }); return true }
  writeRaw () {}
}

const wrap = writer => wrapFml3Reply(writer.finish())
const modData = () => wrap(new WireWriter().byte(5).count(1).modId('forge').string('Forge').string('47.4.13'))
const modList = () => wrap(new WireWriter().byte(1).count(1).modId('forge')
  .count(2).identifier('minecraft:register').string('FML3').identifier('waystones:network').string('1.0')
  .count(0).count(0))
const registryNoSnapshot = () => wrap(new WireWriter().byte(3).identifier('minecraft:item').byte(0))
const configData = () => {
  const bytes = Buffer.from('enabled=true\n')
  return wrap(new WireWriter().byte(4).string('forge-server.toml').varInt(bytes.length).bytes(bytes))
}

function sendRequest (client, messageId, data) {
  client.emit('login_plugin_request', { messageId, channel: 'fml:loginwrapper', data })
  client.write('login_plugin_response', { messageId, successful: false, data: null })
}

function adapter (received) {
  return {
    id: 'waystones',
    version: '14.1.21',
    advertise: true,
    channels: [{
      id: 'waystones:network',
      version: '1.0',
      messages: [
        {
          discriminator: 7,
          direction: 'clientbound',
          decode: payload => ({ text: payload.toString('utf8') }),
          onMessage: value => received.push(value)
        },
        {
          discriminator: 1,
          direction: 'serverbound',
          encode: value => Buffer.from(value.text, 'utf8')
        }
      ]
    }]
  }
}


test('P3.0 Mod adapters cannot be registered unless the explicit FML3 runtime is enabled', () => {
  const runtime = new ModSupportRuntime()
  const received = []
  assert.throws(() => runtime.registerModAdapter(adapter(received)), /native_mod_adapter_requires_fml3_runtime/)
  runtime.destroy()
})

test('P3.0 fml3Runtime option enables controlled FML3 and registry progression together', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const report = runtime.fml3Controller.getReport()
  assert.equal(report.enabled, true)
  assert.equal(report.experimentalRegistryFlow, true)
  assert.throws(() => runtime.registerModAdapter({ id: 'testmod', version: '1', advertise: true, channels: [] }), /invalid_native_mod_adapter/)
  runtime.destroy()
})

test('P3.0 FML3 ledger only marks completion after Play and every indexed reply is valid', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient()
  runtime.attachClient(client)

  sendRequest(client, 0, modData())
  sendRequest(client, 1, modList())
  sendRequest(client, 2, registryNoSnapshot())
  sendRequest(client, 3, configData())

  let report = runtime.fml3.getReport()
  assert.equal(report.handshakeComplete, false)
  assert.equal(report.completionEvidence.successfulReplies, 3)
  assert.equal(report.completionEvidence.playReached, false)

  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  report = runtime.fml3.getReport()
  assert.equal(report.handshakeComplete, true)
  assert.equal(report.state, 'handshake_complete')
  assert.equal(runtime.fml3.state, 'handshake_complete')
  assert.equal(report.completionEvidence.basis, 'play_state_after_all_indexed_fml3_replies')
  assert.deepEqual(report.pendingRequests, [])
  runtime.destroy()
})

test('P3.0 a suppressed or wrong-type reply cannot satisfy an FML3 indexed request', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient()
  runtime.attachClient(client)

  // An unknown FML handshake message is deliberately suppressed by the
  // fail-closed controller. Its transaction remains pending in the ledger.
  const unknown = wrap(new WireWriter().byte(77).byte(1))
  client.emit('login_plugin_request', { messageId: 9, channel: 'fml:loginwrapper', data: unknown })
  client.write('login_plugin_response', { messageId: 9, successful: false, data: null })
  assert.equal(runtime.fml3.getReport().pendingRequests.length, 1)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  assert.equal(runtime.fml3.getReport().handshakeComplete, false)
  assert.equal(runtime.fml3.getReport().completionEvidence.pendingReplies, 1)
  runtime.destroy()

  const { Fml3Session } = require('../src/protocol/forge/fml3-session')
  const session = new Fml3Session()
  session.inspectRequest({ messageId: 1, channel: 'fml:loginwrapper', payload: registryNoSnapshot() })
  const wrong = wrapFml3Reply(new WireWriter().byte(2).count(0).count(0).count(0).finish())
  session.inspectResponse({ messageId: 1, payload: wrong, successful: true })
  session.markPlayReached()
  assert.equal(session.getReport().handshakeComplete, false)
  assert.equal(session.getReport().completionEvidence.failedReplies, 1)
})

test('P3.0 registered Node adapter advertises only its explicit Mod and channel, then handles both directions', async () => {
  const received = []
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient()
  runtime.attachClient(client)
  const disposeAdapter = runtime.registerModAdapter(adapter(received))

  sendRequest(client, 0, modData())
  sendRequest(client, 1, modList())
  const modListReply = client.writes.find(item => item.name === 'login_plugin_response' && item.data.messageId === 1)
  const decoded = decodeC2SModListReply(unwrapFml3Reply(modListReply.data.data))
  assert.deepEqual(decoded.mods, ['waystones'])
  assert.deepEqual(decoded.channels, [{ id: 'waystones:network', version: '1.0' }])
  assert.deepEqual(decoded.registries, [])
  assert.deepEqual(runtime.fml3.getReport().clientProfile.mods, ['waystones'])
  assert.equal(runtime.compatibility.getReport().capabilities.canAdvertiseMods, true)

  sendRequest(client, 2, registryNoSnapshot())
  sendRequest(client, 3, configData())
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')

  // A local LOGIN -> PLAY transition is not enough to send PLAY packets.
  assert.equal(client.writes.some(item => item.name === 'custom_payload'), false)
  client.emit('packet', { entityId: 1 }, { name: 'login', state: 'play' })
  await new Promise(resolve => setImmediate(resolve))
  const registerPacket = client.writes.find(item => item.name === 'custom_payload' && item.data.channel === 'minecraft:register')
  assert.ok(registerPacket)
  assert.equal(registerPacket.data.data.toString('utf8'), 'waystones:network')

  client.emit('packet', {
    channel: 'waystones:network',
    data: packSimpleChannel(7, Buffer.from('server-to-client'))
  }, { name: 'custom_payload', state: 'play' })
  assert.deepEqual(received, [{ text: 'server-to-client' }])

  const sent = runtime.sendModMessage('waystones:network', 1, { text: 'client-to-server' })
  assert.deepEqual(sent, { status: 'sent', channel: 'waystones:network', discriminator: 1, bytes: Buffer.byteLength('client-to-server') + 1, serverConfirmed: false })
  const outgoing = client.writes.at(-1)
  assert.equal(outgoing.name, 'custom_payload')
  assert.equal(outgoing.data.channel, 'waystones:network')
  assert.deepEqual(unpackSimpleChannel(outgoing.data.data), { discriminator: 1, payload: Buffer.from('client-to-server') })
  assert.equal(runtime.nativeChannels.getReport().modChannelsAdvertisable, true)
  assert.equal(runtime.nativeChannels.getReport().canJoinModded, false)
  assert.equal(runtime.compatibility.getReport().capabilities.canSendModPayloads, true)
  assert.equal(runtime.compatibility.getReport().capabilities.canJoinModded, false)
  disposeAdapter()
  const unregisterPacket = client.writes.at(-1)
  assert.equal(unregisterPacket.name, 'custom_payload')
  assert.equal(unregisterPacket.data.channel, 'minecraft:unregister')
  assert.equal(unregisterPacket.data.data.toString('utf8'), 'waystones:network')
  runtime.destroy()
})

test('P3.0 raw channel framing supports a custom payload without SimpleChannel discriminator', async () => {
  const received = []
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new FakeClient()
  runtime.attachClient(client)
  runtime.registerModAdapter({
    id: 'rawmod', version: '1.0.0', advertise: true,
    channels: [{
      id: 'rawmod:network', version: '1.0', framing: 'raw',
      messages: [{
        direction: 'bidirectional',
        decode: payload => payload.toString('utf8'),
        onMessage: value => received.push(value),
        encode: value => Buffer.from(value, 'utf8')
      }]
    }]
  })
  sendRequest(client, 0, modData())
  sendRequest(client, 1, wrap(new WireWriter().byte(1).count(1).modId('forge').count(2)
    .identifier('minecraft:register').string('FML3').identifier('rawmod:network').string('1.0').count(0).count(0)))
  sendRequest(client, 2, registryNoSnapshot())
  sendRequest(client, 3, configData())
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')

  client.emit('packet', { entityId: 5 }, { name: 'login', state: 'play' })
  client.emit('packet', { channel: 'rawmod:network', data: Buffer.from('raw-from-server') }, { name: 'custom_payload', state: 'play' })
  assert.deepEqual(received, ['raw-from-server'])
  await new Promise(resolve => setImmediate(resolve))
  client.emit('packet', { channel: 'rawmod:network', data: Buffer.alloc(1024 * 1024 + 1) }, { name: 'custom_payload', state: 'play' })
  assert.deepEqual(received, ['raw-from-server'])
  assert.equal(runtime.nativeChannels.getReport().receive.rejected, 1)
  const sent = runtime.sendModMessage('rawmod:network', null, 'raw-from-client')
  assert.deepEqual(sent, { status: 'sent', channel: 'rawmod:network', discriminator: null, bytes: Buffer.byteLength('raw-from-client'), serverConfirmed: false })
  const outgoing = client.writes.at(-1)
  assert.equal(outgoing.data.channel, 'rawmod:network')
  assert.equal(outgoing.data.data.toString('utf8'), 'raw-from-client')
  runtime.destroy()
})

test('P3.0 adapter registration fails closed on late registration and version mismatch', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient()
  runtime.attachClient(client)
  sendRequest(client, 0, modData())
  sendRequest(client, 1, modList())
  assert.throws(() => runtime.registerModAdapter(adapter([])), /registered_after_fml3_modlist/)
  runtime.destroy()

  const second = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const secondClient = new FakeClient()
  second.attachClient(secondClient)
  const received = []
  const a = adapter(received)
  a.channels[0].version = '2.0'
  second.registerModAdapter(a)
  sendRequest(secondClient, 0, modData())
  sendRequest(secondClient, 1, modList())
  sendRequest(secondClient, 2, registryNoSnapshot())
  sendRequest(secondClient, 3, configData())
  secondClient.state = 'play'
  second.captureProtocolState('play', 'login')
  secondClient.emit('packet', { entityId: 1 }, { name: 'login', state: 'play' })
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => second.sendModMessage('waystones:network', 1, { text: 'no' }), /server_channel_version_mismatch/)
  second.destroy()
})

test('P3.0 serverbound payloads respect the 32767-byte vanilla custom-payload ceiling', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new FakeClient()
  runtime.attachClient(client)
  runtime.registerModAdapter({
    id: 'examplemod', version: '1.0.0', advertise: true,
    channels: [{ id: 'examplemod:network', version: '1.0', messages: [{
      discriminator: 1, direction: 'serverbound', encode: () => Buffer.alloc(32767)
    }] }]
  })
  sendRequest(client, 0, modData())
  sendRequest(client, 1, wrap(new WireWriter().byte(1).count(1).modId('forge').count(2)
    .identifier('minecraft:register').string('FML3').identifier('examplemod:network').string('1.0').count(0).count(0)))
  sendRequest(client, 2, registryNoSnapshot())
  sendRequest(client, 3, configData())
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  client.emit('packet', { entityId: 1 }, { name: 'login', state: 'play' })
  await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => runtime.sendModMessage('examplemod:network', 1, {}), /native_channel_encoder_must_return_bounded_buffer/)
  runtime.destroy()
})

test('P3.0 registry facade exposes name/id lookups without confusing block IDs with block-state IDs', () => {
  const runtime = new ModSupportRuntime()
  const snapshot = encodeForgeRegistrySnapshot({
    ids: [{ name: 'waystones:black_sharestone', id: 1027 }],
    aliases: [], overrides: [], blocked: []
  })
  const details = { registryName: 'minecraft:block', hasSnapshot: true, entriesDecoded: true,
    snapshot: require('../src/protocol/forge/registry-snapshot').decodeForgeRegistrySnapshot(snapshot) }
  runtime.fml3Controller.applyRegistry(details, 5)
  assert.equal(runtime.nativeRegistry.getRegistryId('minecraft:block', 'waystones:black_sharestone'), 1027)
  assert.equal(runtime.nativeRegistry.getRegistryName('minecraft:block', 1027), 'waystones:black_sharestone')
  const view = runtime.nativeRegistry.getReport().registryViews.block
  assert.equal(view.lookupAvailable, true)
  assert.equal(view.appliedToMineflayer, false)
  assert.equal(runtime.nativeRegistry.getReport().blockStateIdsInstalled, false)
  runtime.destroy()
})
