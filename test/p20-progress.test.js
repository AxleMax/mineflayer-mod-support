'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ModSupportRuntime } = require('../src/core/runtime')
const { WireWriter } = require('../src/protocol/forge/wire')
const { wrapFml3Reply, unwrapFml3Reply, decodeC2SModListReply } = require('../src/protocol/forge/fml3-client-wire')
const { encodeForgeRegistrySnapshot } = require('../src/protocol/forge/registry-snapshot')
const { ServerRegistryMappings } = require('../src/runtime/registry-mappings')
const { ServerConfigStore } = require('../src/runtime/server-config-store')
const { inspectFml3LoginWrapper } = require('../src/protocol/forge/login-wrapper')

class FakeClient extends EventEmitter {
  constructor () { super(); this.version = '1.20.1'; this.state = 'login'; this.autoVersionHooks = []; this.writes = [] }
  write (name, data) { this.writes.push({ name, data }); return true }
  writeRaw () { }
}
const modData = () => wrapFml3Reply(new WireWriter().byte(5).count(1).modId('forge').string('Forge').string('47.4.13').finish())
const modList = () => wrapFml3Reply(new WireWriter().byte(1).count(1).modId('forge').count(1).identifier('waystones:network').string('1.0').count(1).identifier('minecraft:item').count(0).finish())
const registry = (buffer, flag = 1) => wrapFml3Reply(new WireWriter().byte(3).identifier('minecraft:item').byte(flag).bytes(buffer).finish())
function request (client, id, data) {
  const packet = { messageId: id, channel: 'fml:loginwrapper', data }
  client.emit('login_plugin_request', packet)
  client.write('login_plugin_response', { messageId: id, successful: false, data: null })
  client.emit('packet', packet, { name: 'login_plugin_request', state: 'login' })
}


function configData (fileName, data) {
  return wrapFml3Reply(new WireWriter().byte(4).string(fileName, 512).varInt(data.length).bytes(data).finish())
}

test('S2CConfigData is decoded and stored as bounded opaque bytes before ACK', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const bytes = Buffer.from('server-config=true\n', 'utf8')
  const parsed = inspectFml3LoginWrapper(configData('forge-server.toml', bytes))
  assert.equal(parsed.parsed, true)
  assert.equal(parsed.type, 'S2CConfigData')
  assert.equal(parsed.details.fileName, 'forge-server.toml')
  assert.equal(parsed.details.dataBytes, bytes.length)
  assert.equal(parsed.details.data.equals(bytes), true)

  request(client, 21, configData('forge-server.toml', bytes))
  assert.equal(client.writes.length, 1)
  assert.equal(unwrapFml3Reply(client.writes[0].data.data)[0], 99)
  assert.deepEqual(runtime.serverConfigs.get('forge-server.toml'), bytes)
  const report = runtime.snapshot()
  assert.equal(report.serverConfigs.fileCount, 1)
  assert.equal(report.serverConfigs.files[0].fileName, 'forge-server.toml')
  assert.equal(report.serverConfigs.files[0].dataBytes, bytes.length)
  assert.equal(report.serverConfigs.appliedToModRuntime, false)
  assert.equal(report.serverConfigs.persistedToDisk, false)
  assert.equal(report.fml3Controller.handled.at(-1).kind, 'S2CConfigData')
  assert.equal(report.fml3Controller.handled.at(-1).action, 'acknowledge')
  runtime.destroy()
})

test('malformed or unsafe S2CConfigData is not ACKed', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const malformed = wrapFml3Reply(new WireWriter().byte(4).string('forge-server.toml').varInt(8).bytes(Buffer.from([1, 2])).finish())
  const malformedResult = inspectFml3LoginWrapper(malformed)
  assert.equal(malformedResult.parsed, false)
  assert.equal(malformedResult.error, 'truncated_bytes')
  request(client, 22, configData('../outside.toml', Buffer.from('no')))
  assert.equal(client.writes.length, 0)
  assert.equal(runtime.serverConfigs.getReport().fileCount, 0)
  assert.ok(runtime.snapshot().fml3Controller.warnings.some(x => x.includes('ack_blocked:S2CConfigData')))
  runtime.destroy()
})

test('default controlled mode does not ACK S2CConfigData', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  request(client, 23, configData('forge-server.toml', Buffer.from('opaque')))
  assert.equal(client.writes.length, 0)
  assert.equal(runtime.serverConfigs.getReport().fileCount, 0)
  assert.equal(runtime.snapshot().fml3Controller.handled.at(-1).action, 'suppress')
  runtime.destroy()
})

test('server config store copies bytes and enforces bounded storage', () => {
  const store = new ServerConfigStore()
  const source = Buffer.from([1, 2, 3])
  store.install({ fileName: 'waystones-server.toml', data: source, dataBytes: 3 }, 9)
  source[0] = 255
  const returned = store.get('waystones-server.toml')
  assert.deepEqual([...returned], [1, 2, 3])
  returned[1] = 255
  assert.deepEqual([...store.get('waystones-server.toml')], [1, 2, 3])
  assert.throws(() => store.install({ fileName: '../escape.toml', data: Buffer.alloc(0) }), /invalid_server_config_name/)
  assert.equal(store.getReport().fileCount, 1)
})

test('FML3 progression observes ModData without a reply, declares explicit channels and acknowledges installed registries', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, nativeTierChannel: true, fml3RegistryProgression: true, trialChannels: [{ id: 'waystones:network', version: '1.0' }] } })
  const client = new FakeClient(); runtime.attachClient(client)
  request(client, 0, modData())
  assert.equal(client.writes.length, 0)
  assert.equal(runtime.fml3.getReport().requests[0].requiresReply, false)
  request(client, 1, modList())
  assert.deepEqual(decodeC2SModListReply(unwrapFml3Reply(client.writes[0].data.data)), {
    mods: [], channels: [{ id: 'forge:tier_sorting', version: '1.0' }, { id: 'waystones:network', version: '1.0' }], registries: []
  })
  const snapshot = encodeForgeRegistrySnapshot({
    ids: [{ name: 'minecraft:stone', id: 1 }, { name: 'example:gear', id: 901 }],
    aliases: [{ from: 'example:old_gear', to: 'example:gear' }], overrides: [], blocked: [999]
  })
  request(client, 2, registry(snapshot))
  assert.equal(client.writes.length, 2)
  assert.equal(unwrapFml3Reply(client.writes[1].data.data)[0], 99)
  assert.equal(runtime.registryMappings.getId('minecraft:item', 'example:gear'), 901)
  assert.equal(runtime.registryMappings.getId('minecraft:item', 'example:old_gear'), 901)
  assert.equal(runtime.registryMappings.getName('minecraft:item', 901), 'example:gear')
  const report = runtime.snapshot()
  assert.equal(report.registryMappings.mappingInstalledCount, 1)
  assert.equal(report.registryMappings.appliedToMineflayer, false)
  assert.equal(report.fml3Controller.replaced, 2)
  assert.equal(report.fml3Controller.experimentalRegistryFlow, true)
  assert.deepEqual(report.fml3Controller.experimentalTrialChannels, [{ id: 'waystones:network', version: '1.0' }])
  runtime.destroy()
})

test('malformed registry does not get an ACK or corrupt previously installed maps', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, fml3RegistryProgression: true } })
  const client = new FakeClient(); runtime.attachClient(client)
  const snapshot = encodeForgeRegistrySnapshot({ ids: [{ name: 'minecraft:stone', id: 1 }], aliases: [], overrides: [], blocked: [] })
  request(client, 1, registry(snapshot))
  assert.equal(runtime.registryMappings.getId('minecraft:item', 'minecraft:stone'), 1)
  request(client, 2, registry(Buffer.from([0xff])))
  assert.equal(client.writes.length, 1)
  assert.equal(runtime.registryMappings.getId('minecraft:item', 'minecraft:stone'), 1)
  assert.ok(runtime.snapshot().fml3Controller.warnings.some(x => x.includes('ack_blocked:S2CRegistry')))
  runtime.destroy()
})

test('default controlled probe never declares trial channels or acknowledges registry', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, trialChannels: [{ id: 'foo:network', version: '1.0' }] } })
  const client = new FakeClient(); runtime.attachClient(client)
  request(client, 3, modList())
  assert.deepEqual(decodeC2SModListReply(unwrapFml3Reply(client.writes[0].data.data)).channels, [])
  request(client, 4, registry(Buffer.alloc(0), 0))
  assert.equal(client.writes.length, 1)
  assert.equal(runtime.snapshot().registryMappings.mappingInstalledCount, 0)
  runtime.destroy()
})

test('registry mappings reject alias cycles and duplicate numeric IDs atomically', () => {
  const view = new ServerRegistryMappings()
  const valid = { registryName: 'minecraft:item', hasSnapshot: true, entriesDecoded: true,
    snapshot: { ids: [{ name: 'foo:one', id: 1 }], aliases: [], overrides: [], blocked: [] } }
  view.install(valid)
  assert.throws(() => view.install({ ...valid, snapshot: { ids: [{ name: 'foo:one', id: 1 }, { name: 'foo:two', id: 1 }], aliases: [], overrides: [], blocked: [] } }), /invalid_registry_id_entry/)
  assert.throws(() => view.install({ ...valid, snapshot: { ids: [], aliases: [{ from: 'foo:a', to: 'foo:b' }, { from: 'foo:b', to: 'foo:a' }], overrides: [], blocked: [] } }), /registry_alias_cycle/)
  assert.equal(view.getId('minecraft:item', 'foo:one'), 1)
  assert.equal(view.getReport().version, 1)
})

test('experimental channel declarations must be explicit and validated', () => {
  assert.throws(() => new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, trialChannels: [{ id: 'bad channel', version: '1.0' }] } }), /invalid_experimental_channel/)
  assert.throws(() => new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, trialChannels: [{ id: 'foo:a', version: '1.0' }, { id: 'foo:a', version: '1.0' }] } }), /invalid_experimental_channel/)
})

test('a duplicate trial/native channel blocks the experimental reply rather than crashing', () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3ProbeControlled: true, nativeTierChannel: true, fml3RegistryProgression: true, trialChannels: [{ id: 'forge:tier_sorting', version: '1.0' }] } })
  const client = new FakeClient(); runtime.attachClient(client)
  request(client, 1, modList())
  assert.equal(client.writes.length, 0)
  assert.ok(runtime.snapshot().fml3Controller.warnings.includes('duplicate_experimental_channel_in_reply'))
  runtime.destroy()
})
