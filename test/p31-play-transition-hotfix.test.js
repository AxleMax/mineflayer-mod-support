'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ModSupportRuntime } = require('../src/core/runtime')
const { wrapFml3Reply } = require('../src/protocol/forge/fml3-client-wire')
const { WireWriter } = require('../src/protocol/forge/wire')

class Client extends EventEmitter {
  constructor () {
    super()
    this.state = 'login'
    this.version = '1.20.1'
    this.protocolVersion = 763
    this.autoVersionHooks = []
    this.writes = []
  }
  write (name, data) { this.writes.push({ name, data }); return true }
  writeRaw () {}
}

function serverList () {
  return wrapFml3Reply(new WireWriter().byte(1).count(1).modId('forge')
    .count(2).identifier('minecraft:register').string('FML3').identifier('alpha:network').string('1.0')
    .count(0).count(0).finish())
}
function sendList (client) {
  client.emit('login_plugin_request', { channel: 'fml:loginwrapper', messageId: 1, data: serverList() })
  client.write('login_plugin_response', { messageId: 1, successful: false, data: null })
}
const adapter = () => ({ id: 'alpha', version: '1.0', advertise: true,
  channels: [{ id: 'alpha:network', version: '1.0', messages: [
    { discriminator: 7, direction: 'clientbound', decode: b => b.toString(), onMessage: () => {} },
    { discriminator: 3, direction: 'serverbound', encode: () => Buffer.from([42]) }
  ] }] })
const nextTick = () => new Promise(resolve => setImmediate(resolve))

test('P3.1 hotfix: client-side PLAY transition never emits a premature 0x0D custom payload', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new Client()
  runtime.attachClient(client)
  runtime.registerModAdapter(adapter())
  sendList(client)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  await nextTick()
  assert.equal(client.writes.filter(x => x.name === 'custom_payload').length, 0)
  assert.equal(runtime.nativeChannels.getReport().playChannelRegistration.serverPlayPacketObserved, false)
  assert.throws(() => runtime.sendModMessage('alpha:network', 3, {}), /native_channel_not_registered_in_play/)
  runtime.destroy()
})

test('P3.1 hotfix: first actual inbound PLAY packet enables only registered Node adapter channels', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true, nativeTierChannel: true } })
  const client = new Client()
  runtime.attachClient(client)
  runtime.registerModAdapter(adapter())
  sendList(client)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  client.emit('packet', { entityId: 5 }, { name: 'login', state: 'play' })
  assert.equal(client.writes.filter(x => x.name === 'custom_payload').length, 0, 'never send during packet listener')
  await nextTick()
  const registration = client.writes.filter(x => x.name === 'custom_payload')
  assert.equal(registration.length, 1)
  assert.equal(registration[0].data.channel, 'minecraft:register')
  assert.equal(registration[0].data.data.toString(), 'alpha:network')
  assert.deepEqual(runtime.nativeChannels.getReport().playChannelRegistration.channels, ['alpha:network'])
  runtime.destroy()
})

test('P3.1 hotfix: tier-sorting diagnostics without Node adapters send no PLAY registration packets', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true, nativeTierChannel: true } })
  const client = new Client()
  runtime.attachClient(client)
  sendList(client)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  client.emit('packet', { entityId: 1 }, { name: 'login', state: 'play' })
  await nextTick()
  assert.equal(client.writes.filter(x => x.name === 'custom_payload').length, 0)
  assert.equal(runtime.nativeChannels.getReport().playChannelRegistration.serverPlayPacketObserved, true)
  runtime.destroy()
})

test('P3.1 hotfix: a disconnected client never sends queued PLAY custom payloads', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new Client()
  runtime.attachClient(client)
  runtime.registerModAdapter(adapter())
  sendList(client)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  client.emit('packet', { entityId: 2 }, { name: 'login', state: 'play' })
  runtime.destroy()
  await nextTick()
  assert.equal(client.writes.filter(x => x.name === 'custom_payload').length, 0)
})

test('P3.1 hotfix: an ended connection cancels queued PLAY registration before sending', async () => {
  const runtime = new ModSupportRuntime({ experimental: { fml3Runtime: true } })
  const client = new Client()
  runtime.attachClient(client)
  runtime.registerModAdapter(adapter())
  sendList(client)
  client.state = 'play'
  runtime.captureProtocolState('play', 'login')
  client.emit('packet', { entityId: 2 }, { name: 'login', state: 'play' })
  runtime.captureEnd('server_disconnected')
  await nextTick()
  assert.equal(client.writes.filter(x => x.name === 'custom_payload').length, 0)
  assert.equal(runtime.nativeChannels.getReport().playChannelRegistration.transportEnded, true)
  runtime.destroy()
})
test('NMP playerJoin and bundle delimiters cannot bypass the Join Game barrier',async()=>{
  const runtime=new ModSupportRuntime({experimental:{fml3Runtime:true}}),client=new Client()
  runtime.attachClient(client);runtime.registerModAdapter(adapter());sendList(client)
  client.state='play';runtime.captureProtocolState('play','login');client.emit('playerJoin')
  client.emit('packet',{}, {name:'bundle_delimiter',state:'play'})
  await nextTick();assert.equal(client.writes.filter(w=>w.name==='custom_payload').length,0)
  assert.equal(runtime.nativeChannels.getReport().playChannelRegistration.serverPlayPacketObserved,false)
  client.emit('packet',{entityId:7},{name:'login',state:'play'});await nextTick()
  assert.equal(client.writes.filter(w=>w.name==='custom_payload').length,1)
  runtime.destroy()
})
