'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { addFml3ToHandshake } = require('../src/bootstrap/fml3-marker')
const { ModSupportRuntime } = require('../src/core/runtime')

const base = { protocolVersion: 763, serverHost: 'localhost', serverPort: 25565, nextState: 2 }

test('FML3 marker is appended only to Minecraft 1.20.1 login handshake', () => {
  const r = addFml3ToHandshake('set_protocol', base, '1.20.1')
  assert.equal(r.applied, true)
  assert.equal(r.data.serverHost, 'localhost\0FML3\0')
  assert.equal(base.serverHost, 'localhost')
})

test('does not modify status ping or non-1.20.1 handshake', () => {
  assert.equal(addFml3ToHandshake('set_protocol', { ...base, nextState: 1 }, '1.20.1').applied, false)
  assert.equal(addFml3ToHandshake('set_protocol', base, '1.21.1').applied, false)
  assert.equal(addFml3ToHandshake('set_protocol', { ...base, protocolVersion: 764 }, '1.20.1').applied, false)
})

test('does not append a duplicate or stack an unknown marker', () => {
  assert.equal(addFml3ToHandshake('set_protocol', { ...base, serverHost: 'localhost\0FML3\0' }, '1.20.1').reason, 'already_present')
  assert.equal(addFml3ToHandshake('set_protocol', { ...base, serverHost: 'localhost\0other' }, '1.20.1').reason, 'existing_marker')
})

test('rejects an overlong handshake hostname', () => {
  assert.equal(addFml3ToHandshake('set_protocol', { ...base, serverHost: 'a'.repeat(252) }, '1.20.1').reason, 'host_too_long')
})

class Client extends EventEmitter {
  constructor () {
    super()
    this.version = '1.20.1'
    this.state = 'handshaking'
    this.autoVersionHooks = []
    this.sent = []
  }
  write (name, data) { this.sent.push({ name, data }) }
}

test('P0.3 integration: opt-in interception occurs before serialization', () => {
  const runtime = new ModSupportRuntime({ experimental: { forgeFml3Marker: true } })
  const client = new Client()
  runtime.attachClient(client)
  let advertised
  runtime.once('forgeFml3Marker', e => { advertised = e })
  client.write('set_protocol', base)
  assert.equal(advertised.applied, true)
  assert.equal(client.sent[0].data.serverHost, 'localhost\0FML3\0')
  assert.equal(base.serverHost, 'localhost')
  runtime.destroy()
})

test('standard runtime leaves handshake unchanged', () => {
  const runtime = new ModSupportRuntime()
  const client = new Client()
  runtime.attachClient(client)
  client.write('set_protocol', base)
  assert.equal(client.sent[0].data.serverHost, 'localhost')
  runtime.destroy()
})
