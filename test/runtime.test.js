'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ModSupportRuntime } = require('../src/core/runtime')

class FakeClient extends EventEmitter {
  constructor () {
    super()
    this.state = 'handshaking'
    this.version = '1.20.1'
    this.protocolVersion = 763
    this.autoVersionHooks = []
    this.writes = []
    this.rawWrites = []
  }

  write (name, params) {
    this.writes.push([name, params])
    return true
  }

  writeRaw (buffer) {
    this.rawWrites.push(buffer)
    return true
  }
}

test('captures initial state and inbound/outbound packets', async () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)

  const inbound = []
  const outbound = []
  runtime.on('packet', packet => inbound.push(packet))
  runtime.on('outgoingPacket', packet => outbound.push(packet))

  client.emit('packet', { hello: true }, { name: 'login_plugin_request', state: 'login' }, Buffer.from([1]), Buffer.from([1]))
  client.write('login_plugin_response', { messageId: 2 })

  assert.equal(runtime.protocol.state, 'handshaking')
  assert.equal(inbound.length, 1)
  assert.equal(inbound[0].name, 'login_plugin_request')
  assert.equal(outbound.length, 1)
  assert.equal(outbound[0].name, 'login_plugin_response')
  assert.equal(runtime.protocol.packetsIn, 1)
  assert.equal(runtime.protocol.packetsOut, 1)

  runtime.destroy()
})

test('captures state transitions and resolves ready at PLAY', async () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)

  client.emit('state', 'login', 'handshaking')
  client.emit('state', 'configuration', 'login')
  client.emit('state', 'play', 'configuration')

  const resolved = await runtime.ready
  assert.equal(resolved, runtime)
  assert.equal(runtime.state, 'ready')
  assert.equal(runtime.protocol.state, 'play')
  runtime.destroy()
})

test('observes custom payload channels without assuming their codec', () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)

  const seen = []
  runtime.network.onRaw(payload => seen.push(payload))
  client.emit('packet', {
    channel: 'examplemod:sync',
    data: Buffer.from([0xde, 0xad])
  }, { name: 'custom_payload', state: 'play' }, Buffer.from([0]))

  assert.equal(seen.length, 1)
  assert.equal(seen[0].channel, 'examplemod:sync')
  assert.deepEqual(seen[0].data, Buffer.from([0xde, 0xad]))
  assert.equal(runtime.network.channels()[0].id, 'examplemod:sync')
  runtime.destroy()
})

test('installs an auto-version hook before auto-version runs', () => {
  const runtime = new ModSupportRuntime()
  const client = new FakeClient()
  runtime.attachClient(client)

  let detected
  runtime.once('autoVersion', event => { detected = event })
  client.autoVersionHooks[0]({ version: { name: '1.20.1', protocol: 763 } }, client, { protocolVersion: 763 })

  assert.ok(detected)
  assert.equal(runtime.protocol.minecraftVersion, '1.20.1')
  runtime.destroy()
})

test('records swallowed partial-read failures per bot and restores parser on destroy', () => {
  const runtime = new ModSupportRuntime()
  const other = new ModSupportRuntime()
  const client = new FakeClient()
  const error = Object.assign(new Error('truncated mod payload'), { partialReadError: true })
  const parse = () => { throw error }
  client.deserializer = { parsePacketBuffer: parse }
  runtime.attachClient(client)
  const failures = []
  runtime.on('packetDecodeFailure', failure => failures.push(failure))
  for (let i = 0; i < 40; i++) assert.throws(() => client.deserializer.parsePacketBuffer(Buffer.from([16])), value => value === error)
  assert.equal(runtime.snapshot().packetDecoding.failureCount, 40)
  assert.equal(runtime.snapshot().packetDecoding.failures.length, 32)
  assert.equal(failures[0].partialRead, true)
  assert.equal(other.snapshot().packetDecoding.failureCount, 0)
  runtime.destroy()
  other.destroy()
  assert.equal(client.deserializer.parsePacketBuffer, parse)
})
