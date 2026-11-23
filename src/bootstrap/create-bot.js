'use strict'

const { ModSupportRuntime } = require('../core/runtime')

/**
 * Create a regular Mineflayer bot while instrumenting its NMP Client in the
 * Client constructor. This is the supported P0 path for early packet hooks.
 *
 * @param {object} mineflayer Mineflayer module exposing createBot(options).
 * @param {object} options Mineflayer createBot options plus `modSupport`.
 * @returns {object} Mineflayer Bot with `bot.modSupport` attached.
 */
function createBot (mineflayer, options = {}) {
  if (!mineflayer || typeof mineflayer.createBot !== 'function') {
    throw new TypeError('createBot(mineflayer, options): mineflayer.createBot must be a function')
  }

  const botOptions = { ...options }
  const runtimeOptions = botOptions.modSupport || {}
  delete botOptions.modSupport

  let BaseClient = botOptions.Client
  if (!BaseClient) {
    try {
      BaseClient = require('minecraft-protocol').Client
    } catch (err) {
      throw new Error('minecraft-protocol is required to use the bootstrap API. Install Mineflayer and its minecraft-protocol peer dependency.', { cause: err })
    }
  }

  if (typeof BaseClient !== 'function') {
    throw new TypeError('The minecraft-protocol Client constructor must be a class or constructor function')
  }

  const runtime = new ModSupportRuntime(runtimeOptions)

  class InstrumentedClient extends BaseClient {
    constructor (...args) {
      super(...args)
      // This runs synchronously during NMP Client construction, before
      // createClient() starts auto-version probing or opens the game socket.
      runtime.attachClient(this)
    }
  }

  Object.defineProperty(InstrumentedClient, 'name', {
    value: 'MineflayerModSupportClient',
    configurable: true
  })

  botOptions.Client = InstrumentedClient

  let bot
  try {
    bot = mineflayer.createBot(botOptions)
    runtime.attachBot(bot)
    // Defensive fallback for custom Mineflayer implementations that replace
    // the supplied Client or construct it outside the normal NMP path.
    if (bot._client && bot._client !== runtime.client) {
      runtime.attachClient(bot._client)
    }
    return bot
  } catch (err) {
    runtime.destroy()
    throw err
  }
}

module.exports = { createBot }
