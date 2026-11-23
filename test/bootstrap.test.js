'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const modSupport = require('../index')

class FakeClient extends EventEmitter {
  constructor (isServer, version) {
    super()
    this.isServer = isServer
    this.version = version
    this.protocolVersion = 763
    this.state = 'handshaking'
    this.autoVersionHooks = []
  }

  write () {}
  writeRaw () {}
}

test('createBot wraps the NMP Client constructor and returns a normal bot', () => {
  let createdClient
  const fakeMineflayer = {
    createBot (options) {
      createdClient = new options.Client(false, options.version)
      // Simulate NMP's earliest connection/version events immediately after
      // construction. The subclass must already have installed its listeners.
      createdClient.emit('connect')
      createdClient.autoVersionHooks.forEach(hook => hook(
        { version: { name: '1.20.1', protocol: 763 } },
        createdClient,
        { protocolVersion: 763 }
      ))
      createdClient.emit('connect_allowed')
      return { _client: createdClient, username: options.username }
    }
  }

  const bot = modSupport.createBot(fakeMineflayer, {
    host: '127.0.0.1',
    username: 'P0Bot',
    version: '1.20.1',
    Client: FakeClient,
    modSupport: { trace: { packets: true } }
  })

  assert.equal(bot.username, 'P0Bot')
  assert.ok(bot.modSupport)
  assert.equal(bot.modSupport.client, createdClient)
  assert.ok(createdClient.listenerCount('packet') > 0)
  assert.ok(createdClient.autoVersionHooks.length > 0)
  assert.equal(bot.modSupport.state, 'connected')
  assert.equal(bot.modSupport.protocol.minecraftVersion, '1.20.1')

  bot.modSupport.destroy()
})

test('standard plugin can attach to an existing Mineflayer bot', () => {
  const client = new FakeClient(false, '1.20.1')
  const bot = { _client: client }
  modSupport.plugin(bot, { modSupport: {} })

  assert.ok(bot.modSupport)
  assert.equal(bot.modSupport.client, client)
  bot.modSupport.destroy()
})
